// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

import { Refusal, type EngineHandle, type SessionHandle, type TurnHandle } from '../engine/api.ts';
import { loadFromLibrary } from '../formats/library.ts';
import { validateCharacter, validatePersona } from '../formats/native.ts';
import { currentConfig, mergePatch } from '../session/fold.ts';
import type { DeepPartial, SessionConfig } from '../session/entries.ts';
import { readSessionFile } from '../session/log.ts';
import { openTurns } from '../engine/recover.ts';
import { ProviderError } from '../providers/types.ts';
import { lines } from './jsonl.ts';
import { createCoalescer } from './coalesce.ts';
import type { Event } from './events.ts';
import type { EntryType } from '../agents/compendium/types.ts';
import { directorAt } from '../agents/director/state.ts';
import { effectiveRecall } from '../engine/recall.ts';
import { buildTree } from '../session/tree.ts';
import {
  InvalidParams, booleanParam, numberParam, objectParam, paramsOf, stringParam, stringArrayParam,
  type RpcId, type RpcRequest,
} from './commands.ts';

type Writer = (line: string) => void;
type Frame = Record<string, unknown>;
export interface RpcCatalog {
  modelsList(conn: string): Promise<unknown>;
  capsGet(conn: string, model: string): unknown;
  capsProbe(conn: string, model: string, active: boolean): Promise<unknown>;
}
export interface RpcControl { stopTurns(): void }
export interface RpcRunOptions { signal?: AbortSignal; onReady?: (control: RpcControl) => void; sessionDefaults?: DeepPartial<SessionConfig> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requestOf(value: unknown): RpcRequest | null {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') return null;
  if (Object.hasOwn(value, 'id') && value.id !== null && typeof value.id !== 'string' && typeof value.id !== 'number') return null;
  if (typeof value.id === 'number' && !Number.isFinite(value.id)) return null;
  return { jsonrpc: '2.0', ...(Object.hasOwn(value, 'id') ? { id: value.id as RpcId } : {}), method: value.method, params: value.params };
}

function error(id: RpcId, code: number, message: string, data?: Record<string, unknown>): Frame {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

function memoryTask(p: Record<string, unknown>): 'file' | 'hist' {
  const task = stringParam(p, 'task')!;
  if (task !== 'file' && task !== 'hist') throw new InvalidParams('task must be file or hist');
  return task;
}

function libraryValue(home: string, kind: 'characters' | 'personas', id: string): unknown {
  let value: unknown;
  try { value = loadFromLibrary(home, kind, id); }
  catch { throw new InvalidParams(`invalid ${kind} library id or file: ${id}`); }
  if (value === null) throw new InvalidParams(`${kind} library entry ${id} was not found`);
  return value;
}

function snapshot(home: string, session: SessionHandle, active: ReadonlyMap<string, { sessionId: string; kind: string; handle: TurnHandle }>): Record<string, unknown> {
  const { header, entries } = readSessionFile(home, session.id);
  const view = session.view();
  const director = directorAt(buildTree(entries), view.head).state;
  const compendium = session.compendium();
  const held = openTurns(entries).filter((turn) => turn.held).map(({ turn }) => {
    const body = [...entries].reverse().find((entry) => entry.t === 'held' && entry.turn === turn.turn);
    const draft = body?.t === 'held' ? body.body.blocks.filter((block) => block.k === 'text').map((block) => block.text).join('') : '';
    return { turnId: turn.turn, kind: turn.kind, state: 'held', draft };
  });
  return {
    sessionId: session.id, header, config: currentConfig(header, entries), version: session.version(),
    head: view.head, path: view.path, tails: view.tails,
    openTurns: [...active.values()].filter((turn) => turn.sessionId === session.id && session.busy()).map((turn) => ({ turnId: turn.handle.turnId, kind: turn.kind, state: 'running' })).concat(held),
    background: session.memoryStatus().backlog,
    director: { turn: director.turn, arcs: director.arcs.length, seeds: director.seeds.length },
    compendium: { entries: compendium.entries.size, pending: session.memoryStatus().queued.length },
  };
}

/** A concurrent JSON-RPC host: turn events stream while later stdin lines can stop that turn. */
export async function runRpc(input: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>, write: Writer, engine: EngineHandle, home: string, filterEvent: (event: Event) => Event = (event) => event, catalog?: RpcCatalog, options: RpcRunOptions = {}): Promise<void> {
  const sessions = new Map<string, SessionHandle>();
  const turns = new Map<string, { sessionId: string; kind: string; handle: TurnHandle }>();
  const pumps = new Set<Promise<void>>();
  const pendingRequests = new Set<Promise<void>>();
  const send = (frame: Frame): void => write(`${JSON.stringify(frame)}\n`);
  const coalescer = createCoalescer((event) => send({ jsonrpc: '2.0', method: 'event', params: filterEvent(event) }));
  let initialized = false;
  let shutdown = false;
  let openedEvents: Event[] = [];
  const stream = (async (): Promise<void> => {
    for await (const event of engine.events()) coalescer.push(event);
  })();
  options.onReady?.({ stopTurns: () => { for (const turn of turns.values()) turn.handle.stop(); } });
  const sessionOf = (p: Record<string, unknown>): SessionHandle => {
    const id = stringParam(p, 'sessionId')!;
    const session = sessions.get(id);
    if (!session) throw new Refusal('session_not_found', `session ${id} is not open in this connection`);
    return session;
  };
  const watch = (sessionId: string, kind: string, turn: TurnHandle): void => {
    turns.set(turn.turnId, { sessionId, kind, handle: turn });
    // Drain the per-turn queue; engine.events() is the one source sent to the client.
    const pump = (async (): Promise<void> => {
      try {
        for await (const _ of turn.events) { /* drained */ }
        await turn.result;
      } finally {
        turns.delete(turn.turnId);
      }
    })();
    pumps.add(pump);
    void pump.then(() => pumps.delete(pump), () => pumps.delete(pump));
  };
  const dispatch = async (method: string, p: Record<string, unknown>): Promise<unknown> => {
    if (method === 'initialize') {
      if (initialized) throw new InvalidParams('initialize may be called only once');
      if (numberParam(p, 'protocol') !== 1) throw new InvalidParams('protocol 1 is required');
      const client = objectParam(p, 'client')!;
      stringParam(client, 'name'); stringParam(client, 'version');
      initialized = true;
      return { protocol: 1, core: { version: '0.1.0' }, features: ['swipes', 'events', 'models', 'memory', 'conflicts'] };
    }
    if (!initialized) throw new InvalidParams('initialize must be called first');
    switch (method) {
      case 'session/list': return engine.listSessions();
      case 'session/new': {
        const raw = p.character;
        if (raw === undefined) throw new InvalidParams('character is required');
        const character = typeof raw === 'string' ? libraryValue(home, 'characters', raw) : raw;
        const valid = validateCharacter(character);
        if (!valid.ok) throw new InvalidParams(`invalid character: ${valid.errors[0]?.message ?? 'unknown error'}`);
        let persona;
        if (p.persona !== undefined) {
          const rawPersona = typeof p.persona === 'string' ? libraryValue(home, 'personas', p.persona) : p.persona;
          const checked = validatePersona(rawPersona);
          if (!checked.ok) throw new InvalidParams(`invalid persona: ${checked.errors[0]?.message ?? 'unknown error'}`);
          persona = checked.value;
        }
        const config = objectParam(p, 'config', true);
        const title = stringParam(p, 'title', true);
        const initialConfig = mergePatch<DeepPartial<SessionConfig>>(options.sessionDefaults ?? {}, config);
        const s = engine.createSession({ character: valid.value, ...(persona ? { persona } : {}), config: initialConfig, ...(title ? { title } : {}) });
        sessions.set(s.id, s);
        return { sessionId: s.id, snapshot: snapshot(home, s, turns) };
      }
      case 'session/open': {
        const id = stringParam(p, 'sessionId')!;
        const existing = sessions.get(id);
        const s = existing ?? engine.session(id);
        sessions.set(id, s);
        const result = snapshot(home, s, turns);
        // Recovery events predate the subscription to an open session, so replay these notices once.
        if (!existing) openedEvents = s.openEvents();
        return result;
      }
      case 'session/close': {
        const s = sessionOf(p);
        await s.close(); sessions.delete(s.id);
        return { closed: s.id };
      }
      case 'session/configure': {
        const s = sessionOf(p);
        const patch = objectParam(p, 'patch')!;
        s.configure(patch);
        return { version: s.version() };
      }
      case 'session/fork': {
        const s = sessionOf(p);
        return { sessionId: s.fork({ at: stringParam(p, 'at')! }) };
      }
      case 'session/preview': {
        const s = sessionOf(p);
        return s.preview({ ...(stringParam(p, 'draft', true) !== undefined ? { draft: p.draft as string } : {}), ...(stringParam(p, 'turnId', true) !== undefined ? { turn: p.turnId as string } : {}) });
      }
      case 'message/send': {
        const s = sessionOf(p);
        const greetingIndex = p.greetingIndex === undefined ? undefined : numberParam(p, 'greetingIndex');
        return s.send({ text: stringParam(p, 'text')!, expectedVersion: numberParam(p, 'expectedVersion'), ...(greetingIndex !== undefined ? { greetingIndex } : {}) });
      }
      case 'message/edit': return sessionOf(p).edit({ messageId: stringParam(p, 'messageId')!, text: stringParam(p, 'text')!, expectedVersion: numberParam(p, 'expectedVersion') });
      case 'message/hide': return sessionOf(p).hide({ messageId: stringParam(p, 'messageId')!, hidden: booleanParam(p, 'hidden')!, expectedVersion: numberParam(p, 'expectedVersion') });
      case 'history/select': return sessionOf(p).select({ messageId: stringParam(p, 'messageId')!, expectedVersion: numberParam(p, 'expectedVersion'), ...(p.exact === undefined ? {} : { exact: booleanParam(p, 'exact')! }) });
      case 'history/tails': return sessionOf(p).view().tails;
      case 'history/search': return sessionOf(p).search({ query: stringParam(p, 'query')!, ...(p.before === undefined ? {} : { before: numberParam(p, 'before') }), ...(p.limit === undefined ? {} : { limit: numberParam(p, 'limit') }) });
      case 'memory/list': {
        const s = sessionOf(p);
        const type = stringParam(p, 'type', true);
        return s.memoryList({ ...(p.at === undefined ? {} : { at: stringParam(p, 'at') }), ...(type !== undefined ? { type: type as EntryType } : {}), ...(p.includeRetired === undefined ? {} : { includeRetired: booleanParam(p, 'includeRetired') }) });
      }
      case 'memory/get': {
        const s = sessionOf(p);
        return s.memoryGet({ ref: stringParam(p, 'ref')!, ...(p.at === undefined ? {} : { at: stringParam(p, 'at') }) });
      }
      case 'memory/tree': {
        const s = sessionOf(p);
        return s.memoryTree({ ...(p.at === undefined ? {} : { at: stringParam(p, 'at') }), ...(p.book === undefined ? {} : { book: stringParam(p, 'book') }) });
      }
      case 'memory/status': return sessionOf(p).memoryStatus();
      case 'memory/wait': return sessionOf(p).memoryWait({ ...(p.timeoutMs === undefined ? {} : { timeoutMs: numberParam(p, 'timeoutMs') }) });
      case 'memory/recall': {
        const s = sessionOf(p);
        const { entries } = readSessionFile(home, s.id);
        const tree = buildTree(entries);
        const answer = p.turnId === undefined
          ? s.view().path.findLast((message) => message.role === 'assistant' && message.gen?.kind !== 'greeting')?.id
          : [...tree.msgs.values()].find((message) => message.turn === stringParam(p, 'turnId'))?.id;
        if (!answer || !s.view().pathSet.has(answer)) throw new Refusal('not_found', 'no answer for recall on the active path');
        const message = tree.msgs.get(answer)!;
        let trace = message.trace;
        for (const edit of tree.edits.get(answer) ?? []) if (edit.reason === 'continue' && edit.trace) trace = edit.trace;
        return { messageId: answer, record: effectiveRecall(tree, answer), compendium: trace?.compendium ?? null };
      }
      case 'memory/file': return sessionOf(p).memoryFile({ type: stringParam(p, 'type')! as EntryType, data: objectParam(p, 'data')! });
      case 'memory/add': return sessionOf(p).memoryAdd({ title: stringParam(p, 'title')!, content: stringParam(p, 'content')!, ...(p.keys === undefined ? {} : { keys: stringArrayParam(p, 'keys') }) });
      case 'memory/edit': return sessionOf(p).memoryEdit({ ref: stringParam(p, 'ref')!, ...(p.title === undefined ? {} : { title: stringParam(p, 'title') }), ...(p.content === undefined ? {} : { content: stringParam(p, 'content', true) }), ...(p.keys === undefined ? {} : { keys: stringArrayParam(p, 'keys') }), ...(p.set === undefined ? {} : { set: objectParam(p, 'set') }), ...(p.unset === undefined ? {} : { unset: stringArrayParam(p, 'unset') }), ...(p.featured === undefined ? {} : { featured: booleanParam(p, 'featured') }) });
      case 'memory/retire': return sessionOf(p).memoryRetire({ ref: stringParam(p, 'ref')!, ...(p.reason === undefined ? {} : { reason: stringParam(p, 'reason', true) }) });
      case 'memory/restore': return sessionOf(p).memoryRestore({ ref: stringParam(p, 'ref')! });
      case 'memory/undo': return sessionOf(p).memoryUndo({ messageId: stringParam(p, 'messageId')!, ...(p.task === undefined ? {} : { task: memoryTask(p) }) });
      case 'memory/refile': return sessionOf(p).memoryRefile({ messageId: stringParam(p, 'messageId')!, ...(p.task === undefined ? {} : { task: memoryTask(p) }) });
      case 'memory/retry': return sessionOf(p).memoryRetry({ ...(p.messageId === undefined ? {} : { messageId: stringParam(p, 'messageId') }) });
      case 'memory/export': {
        const s = sessionOf(p);
        const format = stringParam(p, 'format')!;
        if (format !== 'core' && format !== 'compendium') throw new InvalidParams('format must be core or compendium');
        return s.memoryExport({ name: stringParam(p, 'name')!, format, ...(p.force === undefined ? {} : { force: booleanParam(p, 'force') }) });
      }
      case 'lore/test': {
        const s = sessionOf(p);
        const result = s.preview({ draft: stringParam(p, 'text')!, explain: true });
        if (!result.ok) return result;
        return { ok: true, verdicts: result.verdicts ?? [], lore: result.trace.lore, loreUse: result.loreUse, notices: result.notices.filter((notice) => notice.code.startsWith('lore')) };
      }
      case 'director/show': {
        const s = sessionOf(p);
        const { entries } = readSessionFile(home, s.id);
        const tree = buildTree(entries);
        const at = stringParam(p, 'at', true) ?? s.view().head;
        if (at !== null && !tree.msgs.has(at)) throw new Refusal('not_found', `message ${at} is not in this session`);
        return { enabled: currentConfig(s.header(), entries).director.enabled, ...directorAt(tree, at) };
      }
      case 'models/list': {
        if (!catalog) throw new Refusal('no_connection', 'model catalog is unavailable');
        return catalog.modelsList(stringParam(p, 'conn')!);
      }
      case 'caps/get': {
        if (!catalog) throw new Refusal('no_connection', 'model capabilities are unavailable');
        return catalog.capsGet(stringParam(p, 'conn')!, stringParam(p, 'model')!);
      }
      case 'caps/probe': {
        if (!catalog) throw new Refusal('no_connection', 'capability probe is unavailable');
        return catalog.capsProbe(stringParam(p, 'conn')!, stringParam(p, 'model')!, booleanParam(p, 'active', true) ?? false);
      }
      case 'turn/run': {
        const s = sessionOf(p);
        if (p.inspect !== undefined) throw new Refusal('gate_unsupported', 'turn inspection is not available through protocol 1');
        const kind = stringParam(p, 'kind');
        if (kind !== 'reply' && kind !== 'swipe' && kind !== 'continue') throw new InvalidParams('kind must be reply, swipe or continue');
        const onError = stringParam(p, 'onError', true);
        if (onError !== undefined && onError !== 'drop' && onError !== 'keep') throw new InvalidParams('onError must be drop or keep');
        const emptyReply = stringParam(p, 'emptyReply', true);
        if (emptyReply !== undefined && emptyReply !== 'fail' && emptyReply !== 'keep') throw new InvalidParams('emptyReply must be fail or keep');
        const fallback = stringParam(p, 'fallback', true);
        const turn = s.runTurn({ kind, expectedVersion: numberParam(p, 'expectedVersion'), ...(stringParam(p, 'guidance', true) !== undefined ? { guidance: p.guidance as string } : {}), ...(onError ? { onError } : {}), ...(emptyReply ? { emptyReply } : {}), ...(fallback ? { fallback } : {}) });
        watch(s.id, kind, turn);
        return { turnId: turn.turnId, messageId: turn.messageId };
      }
      case 'turn/submit': {
        const s = sessionOf(p);
        const turn = s.submit({ text: stringParam(p, 'text')!, expectedVersion: numberParam(p, 'expectedVersion'), onError: 'drop' });
        watch(s.id, 'reply', turn);
        return { turnId: turn.turnId, messageId: turn.messageId };
      }
      case 'turn/stop': {
        const s = sessionOf(p);
        const id = stringParam(p, 'turnId')!;
        const turn = turns.get(id);
        if (!turn || turn.sessionId !== s.id) throw new Refusal('not_found', `turn ${id} is not running in this session`);
        s.stop(id);
        return { stopped: id };
      }
      case 'turn/commitAnyway': return sessionOf(p).commitAnyway(stringParam(p, 'turnId')!);
      case 'turn/discard': return sessionOf(p).discard(stringParam(p, 'turnId')!);
      case 'shutdown': shutdown = true; return { shuttingDown: true };
      default: throw new Error(`method not found: ${method}`);
    }
  };
  const iterator = lines(input)[Symbol.asyncIterator]();
  const aborted = new Promise<null>((resolve) => {
    if (options.signal?.aborted) resolve(null);
    else options.signal?.addEventListener('abort', () => resolve(null), { once: true });
  });
  try {
    for (;;) {
      const next = options.signal ? await Promise.race([iterator.next(), aborted]) : await iterator.next();
      if (next === null || next.done) break;
      const line = next.value;
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { send(error(null, -32700, 'Parse error')); continue; }
      const request = requestOf(value);
      if (!request) { send(error(isRecord(value) && (typeof value.id === 'string' || typeof value.id === 'number') ? value.id : null, -32600, 'Invalid Request')); continue; }
      const task = (async (): Promise<void> => {
        try {
          // dispatch starts synchronously. Capture this open's recovery notices before another
          // request can open a different session while a slow method awaits the network.
          const resultPromise = dispatch(request.method, paramsOf(request.params));
          const recovery = openedEvents.splice(0);
          const result = await resultPromise;
          if (Object.hasOwn(request, 'id')) send({ jsonrpc: '2.0', id: request.id, result });
          for (const event of recovery) coalescer.push(event);
        } catch (e) {
          if (options.signal?.aborted) return;
          if (!Object.hasOwn(request, 'id')) return;
          if (e instanceof Refusal) send(error(request.id ?? null, -32000, e.message, { code: e.code }));
          else if (e instanceof ProviderError) send(error(request.id ?? null, -32000, e.message, { code: e.code }));
          else if (e instanceof InvalidParams) send(error(request.id ?? null, -32602, e.message));
          else if (e instanceof Error && e.message.startsWith('method not found:')) send(error(request.id ?? null, -32601, e.message));
          else send(error(request.id ?? null, -32603, 'Internal error'));
        }
      })();
      pendingRequests.add(task);
      void task.then(() => pendingRequests.delete(task));
      if (shutdown) break;
    }
  } finally {
    // An aborted input may still be waiting in a host-owned iterator; do not wait for its return.
    if (!options.signal?.aborted) await iterator.return?.(undefined);
    else {
      const closing = iterator.return?.(undefined);
      if (closing) void closing.catch(() => {});
    }
    await engine.close();
    await Promise.allSettled([...pendingRequests]);
    await Promise.allSettled([...pumps]);
    await stream;
    coalescer.close();
  }
}
