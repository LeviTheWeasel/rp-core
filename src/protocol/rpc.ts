// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

import { Refusal, type EngineHandle, type SessionHandle, type TurnHandle } from '../engine/api.ts';
import { loadFromLibrary } from '../formats/library.ts';
import { validateCharacter, validatePersona } from '../formats/native.ts';
import { currentConfig } from '../session/fold.ts';
import { readSessionFile } from '../session/log.ts';
import { lines } from './jsonl.ts';
import { createCoalescer } from './coalesce.ts';
import type { Event } from './events.ts';
import {
  InvalidParams, booleanParam, numberParam, objectParam, paramsOf, stringParam,
  type RpcId, type RpcRequest,
} from './commands.ts';

type Writer = (line: string) => void;
type Frame = Record<string, unknown>;

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

function snapshot(home: string, session: SessionHandle, active: ReadonlyMap<string, { sessionId: string; kind: string; handle: TurnHandle }>): Record<string, unknown> {
  const { header, entries } = readSessionFile(home, session.id);
  const view = session.view();
  return {
    sessionId: session.id, header, config: currentConfig(header, entries), version: session.version(),
    head: view.head, path: view.path, tails: view.tails,
    openTurns: [...active.values()].filter((turn) => turn.sessionId === session.id && session.busy()).map((turn) => ({ turnId: turn.handle.turnId, kind: turn.kind, state: 'running' })),
    background: session.memoryStatus().backlog,
  };
}

/** A concurrent JSON-RPC host: turn events stream while later stdin lines can stop that turn. */
export async function runRpc(input: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>, write: Writer, engine: EngineHandle, home: string, filterEvent: (event: Event) => Event = (event) => event): Promise<void> {
  const sessions = new Map<string, SessionHandle>();
  const turns = new Map<string, { sessionId: string; kind: string; handle: TurnHandle }>();
  const pumps = new Set<Promise<void>>();
  const send = (frame: Frame): void => write(`${JSON.stringify(frame)}\n`);
  const coalescer = createCoalescer((event) => send({ jsonrpc: '2.0', method: 'event', params: filterEvent(event) }));
  let initialized = false;
  let shutdown = false;
  let openedEvents: Event[] = [];
  const stream = (async (): Promise<void> => {
    for await (const event of engine.events()) coalescer.push(event);
  })();
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
      for await (const _ of turn.events) { /* drained */ }
      await turn.result;
      turns.delete(turn.turnId);
    })();
    pumps.add(pump);
    void pump.finally(() => pumps.delete(pump));
  };
  const dispatch = async (method: string, p: Record<string, unknown>): Promise<unknown> => {
    if (method === 'initialize') {
      if (initialized) throw new InvalidParams('initialize may be called only once');
      if (numberParam(p, 'protocol') !== 1) throw new InvalidParams('protocol 1 is required');
      const client = objectParam(p, 'client')!;
      stringParam(client, 'name'); stringParam(client, 'version');
      initialized = true;
      return { protocol: 1, core: { version: '0.1.0' }, features: ['swipes', 'events', 'models', 'memory'] };
    }
    if (!initialized) throw new InvalidParams('initialize must be called first');
    switch (method) {
      case 'session/list': return engine.listSessions();
      case 'session/new': {
        const raw = p.character;
        if (raw === undefined) throw new InvalidParams('character is required');
        const character = typeof raw === 'string' ? loadFromLibrary(home, 'characters', raw) : raw;
        const valid = validateCharacter(character);
        if (!valid.ok) throw new InvalidParams(`invalid character: ${valid.errors[0]?.message ?? 'unknown error'}`);
        let persona;
        if (p.persona !== undefined) {
          const rawPersona = typeof p.persona === 'string' ? loadFromLibrary(home, 'personas', p.persona) : p.persona;
          const checked = validatePersona(rawPersona);
          if (!checked.ok) throw new InvalidParams(`invalid persona: ${checked.errors[0]?.message ?? 'unknown error'}`);
          persona = checked.value;
        }
        const config = objectParam(p, 'config', true);
        const title = stringParam(p, 'title', true);
        const s = engine.createSession({ character: valid.value, ...(persona ? { persona } : {}), ...(config ? { config } : {}), ...(title ? { title } : {}) });
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
      case 'turn/run': {
        const s = sessionOf(p);
        const kind = stringParam(p, 'kind');
        if (kind !== 'reply' && kind !== 'swipe' && kind !== 'continue') throw new InvalidParams('kind must be reply, swipe or continue');
        const onError = stringParam(p, 'onError', true);
        if (onError !== undefined && onError !== 'drop' && onError !== 'keep') throw new InvalidParams('onError must be drop or keep');
        const turn = s.runTurn({ kind, expectedVersion: numberParam(p, 'expectedVersion'), ...(stringParam(p, 'guidance', true) !== undefined ? { guidance: p.guidance as string } : {}), ...(onError ? { onError } : {}) });
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
      case 'shutdown': shutdown = true; return { shuttingDown: true };
      default: throw new Error(`method not found: ${method}`);
    }
  };
  try {
    for await (const line of lines(input)) {
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { send(error(null, -32700, 'Parse error')); continue; }
      const request = requestOf(value);
      if (!request) { send(error(isRecord(value) && (typeof value.id === 'string' || typeof value.id === 'number') ? value.id : null, -32600, 'Invalid Request')); continue; }
      try {
        const result = await dispatch(request.method, paramsOf(request.params));
        if (Object.hasOwn(request, 'id')) send({ jsonrpc: '2.0', id: request.id, result });
        for (const event of openedEvents.splice(0)) coalescer.push(event);
      } catch (e) {
        if (!Object.hasOwn(request, 'id')) continue;
        if (e instanceof Refusal) send(error(request.id ?? null, -32000, e.message, { code: e.code }));
        else if (e instanceof InvalidParams) send(error(request.id ?? null, -32602, e.message));
        else if (e instanceof Error && e.message.startsWith('method not found:')) send(error(request.id ?? null, -32601, e.message));
        else send(error(request.id ?? null, -32603, 'Internal error'));
      }
      if (shutdown) break;
    }
  } finally {
    await engine.close();
    await Promise.allSettled([...pumps]);
    await stream;
    coalescer.close();
  }
}
