// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The engine's side of what a local server says about itself (M5d, .notes/m5d-decisions.md D-210…D-212).
// - ServerInfoMemo: one read per origin per engine (providers/server-info.ts readServerInfo), started
//   when a session opens for the local openai-chat origins its roles use, never blocking the open. The
//   first call on such an origin waits for it; the 3 s deadline runs from the start, the key included,
//   so the wait is bounded. Later calls read the settled value. Ollama's /api/show answers are
//   memoised the same way, per name.
// - callCaps: D-211's pin on one call's caps (a copy), for streamCall and the preview's wire.
// - serverNotices: D-212's four notices, a pure function of the roles and what the servers said.
// Nothing here is module state: the memo lives on the EngineCtx.

import type { Connection } from './api.ts';
import { isLocalOrigin } from '../providers/http.ts';
import { monotonicMs } from './system.ts';
import {
  ollamaModel,
  pinVerdict,
  readServerInfo,
  SERVER_INFO_REQUEST_MS,
  SERVER_INFO_TOTAL_MS,
  type OllamaModel,
  type OllamaRunner,
  type PinVerdict,
  type ServerInfo,
} from '../providers/server-info.ts';
import type { ModelCaps } from '../providers/types.ts';
import type { Notice } from '../protocol/events.ts';

/** D-210: the reader runs only for a configured HTTP connection of the openai-chat dialect on a local origin. */
export function readsServerInfo(conn: Pick<Connection, 'baseUrl' | 'dialect' | 'local' | 'origin' | 'caps'>): boolean {
  // script:, replay: (and any in-process provider) have no baseUrl; record: is turned off by the CLI.
  if (conn.baseUrl === undefined) return false;
  if ((conn.dialect ?? conn.caps.dialect) !== 'openai-chat') return false;
  return conn.local && isLocalOrigin(conn.origin);
}

interface Memo<T> {
  promise: Promise<T>;
  /** Set once the promise settled (it never rejects); `at` is the memo's now() then. */
  settled?: { value: T; at: number };
}

/** A value once settled, else the pending promise; undefined when nothing was started. */
export type Peek<T> = T | Promise<T> | undefined;

function memo<T>(promise: Promise<T>, now: () => number): Memo<T> {
  const m: Memo<T> = { promise };
  void promise.then((value) => {
    m.settled = { value, at: now() };
  });
  return m;
}

const peekOf = <T>(m: Memo<T> | undefined): Peek<T> => (m === undefined ? undefined : m.settled ? m.settled.value : m.promise);

export interface ServerInfoMemoOptions {
  fetch: typeof fetch;
  /** Milliseconds for the deadlines and the retry gap (tests); system.ts monotonicMs otherwise. */
  now?: () => number;
  /** The reader's deadlines (tests); its defaults otherwise. */
  requestMs?: number;
  totalMs?: number;
  /** D-210 amended: how long a passing failure is kept before the next read (tests). */
  retryMs?: number;
}

/** D-210 amended: a failed read that may pass (a server still loading or not up yet) is tried again after this. */
export const SERVER_INFO_RETRY_MS = 30_000;

/**
 * D-210 amended: an answer that may change soon — nothing answered, a deadline, a 5xx, an auth
 * refusal (a key that missed its share of the deadline). A server that answered as something else
 * keeps its answer for the engine's life.
 */
export function passingFailure(info: ServerInfo): boolean {
  if (info.kind !== 'unknown') return false;
  const r = info.reason;
  return r.startsWith('nothing answered') || r.startsWith('no answer within') || /timed out|HTTP (5\d\d|401|403)\b/.test(r);
}

/** D-210: what each local server said, read once per origin per engine (a passing failure again after SERVER_INFO_RETRY_MS). */
export class ServerInfoMemo {
  private readonly infos = new Map<string, Memo<ServerInfo>>();
  private readonly shows = new Map<string, Memo<OllamaModel | null>>();
  /** Aborted when the engine closes: a read still running ends as 'unknown'. */
  private readonly stop = new AbortController();

  private readonly now: () => number;

  constructor(private readonly o: ServerInfoMemoOptions) {
    this.now = o.now ?? monotonicMs;
  }

  /**
   * Starts the read of `conn`'s origin unless it ran already or the connection does not qualify.
   * `key`: the call's resolved key; without it the connection's own (resolveKey memoises it).
   */
  start(conn: Connection, key?: string | null): void {
    if (!readsServerInfo(conn) || this.stop.signal.aborted) return;
    const had = this.infos.get(conn.origin);
    // D-210 amended: a passing failure is read again, at most once per retryMs; anything else stays.
    if (had && !(had.settled && passingFailure(had.settled.value) && this.now() - had.settled.at >= (this.o.retryMs ?? SERVER_INFO_RETRY_MS))) return;
    const baseUrl = conn.baseUrl!;
    const totalMs = this.o.totalMs ?? SERVER_INFO_TOTAL_MS;
    const begun = this.now();
    const read = async (): Promise<ServerInfo> => {
      // D-210's deadline covers the key too: a key that hangs must not hold the first call. It gets
      // what one request would leave, then the read goes on without it (most servers need none).
      let k: string | null = null;
      if (key !== undefined) k = key;
      else {
        const got = await within(keyOf(conn), Math.max(0, totalMs - (this.o.requestMs ?? SERVER_INFO_REQUEST_MS)), this.stop.signal);
        if (got !== LATE) k = got;
      }
      if (this.stop.signal.aborted) return { kind: 'unknown', reason: 'stopped' };
      const left = totalMs - (this.now() - begun);
      if (left <= 0) return { kind: 'unknown', reason: `no answer within ${totalMs} ms` };
      return readServerInfo(baseUrl, { ...this.reader(), totalMs: left, key: k, dialect: 'openai-chat' });
    };
    this.infos.set(conn.origin, memo(read(), this.now));
  }

  /** The origin's info: settled, pending, or undefined when it was never started. */
  peek(origin: string): Peek<ServerInfo> {
    return peekOf(this.infos.get(origin));
  }

  /** D-210 ollamaModel for one name on `conn`'s server, memoised (started on the first ask). */
  ollama(conn: Connection, model: string): Peek<OllamaModel | null> {
    if (!readsServerInfo(conn)) return undefined;
    const at = `${conn.origin}\u0000${model}`;
    let m = this.shows.get(at);
    if (m === undefined) {
      const baseUrl = conn.baseUrl!;
      m = memo((async () => ollamaModel(baseUrl, model, { ...this.reader(), key: await keyOf(conn) }))(), this.now);
      this.shows.set(at, m);
    }
    return peekOf(m);
  }

  /** The /api/show answer of one name on an origin, without starting a read. */
  ollamaPeek(origin: string, model: string): Peek<OllamaModel | null> {
    return peekOf(this.shows.get(`${origin}\u0000${model}`));
  }

  close(): void {
    this.stop.abort();
  }

  private reader(): { fetch: typeof fetch; signal: AbortSignal; requestMs?: number; totalMs?: number } {
    return {
      fetch: this.o.fetch,
      signal: this.stop.signal,
      ...(this.o.requestMs !== undefined ? { requestMs: this.o.requestMs } : {}),
      ...(this.o.totalMs !== undefined ? { totalMs: this.o.totalMs } : {}),
    };
  }
}

const LATE = Symbol('late');

/** `p`, or LATE once `ms` passed or `stop` aborted (p is left to settle). */
async function within<T>(p: Promise<T>, ms: number, stop: AbortSignal): Promise<T | typeof LATE> {
  if (stop.aborted) return LATE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onStop: (() => void) | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), ms);
    onStop = () => resolve(LATE);
    stop.addEventListener('abort', onStop, { once: true });
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
    if (onStop) stop.removeEventListener('abort', onStop);
  }
}

/** The connection's key for the reader (llama.cpp --api-key guards /props too); none when it cannot be had. */
async function keyOf(conn: Connection): Promise<string | null> {
  if (!conn.resolveKey) return conn.key ?? null;
  try {
    return (await conn.resolveKey()) ?? conn.key ?? null;
  } catch {
    return null;
  }
}

/** The user's slot_pin as pinVerdict's override: an object forces it on, null never pins, absent leaves it to the rule. */
const overrideOf = (caps: ModelCaps): boolean | undefined => (caps.slotPin === undefined ? undefined : caps.slotPin !== null);

/** An id_slot the user put in the model's extra_body: the adapter never replaces it, so rp-core does not pin. */
export function handSlotOf(caps: ModelCaps): unknown {
  return caps.extraBody !== undefined && Object.hasOwn(caps.extraBody, 'id_slot') ? caps.extraBody['id_slot'] : undefined;
}

/** D-211 for one model on one origin: the user's own id_slot or slot_pin first, else the rule over the server info. */
export function slotPinOf(caps: ModelCaps, info: ServerInfo | undefined, capacity: number): PinVerdict {
  const hand = handSlotOf(caps);
  if (hand !== undefined) return { pin: null, why: `id_slot ${JSON.stringify(hand)} is set in extra_body` };
  const override = overrideOf(caps);
  if (caps.slotPin) return { pin: { ...caps.slotPin }, why: 'slot_pin = true in config' };
  return pinVerdict(info ?? { kind: 'unknown', reason: 'no server info' }, { capacity, ...(override !== undefined ? { override } : {}) });
}

/**
 * D-211: the caps one call is sent with. The user's slot_pin (on or never) is already in the caps and the
 * adapter reads it; otherwise a llama.cpp server that passes the rule gets a pinned copy. Never mutates.
 */
export function callCaps(caps: ModelCaps, info: ServerInfo | undefined, capacity: number): ModelCaps {
  if (caps.slotPin !== undefined || info?.kind !== 'llama.cpp' || handSlotOf(caps) !== undefined) return caps;
  const v = pinVerdict(info, { capacity });
  return v.pin ? { ...caps, slotPin: v.pin } : caps;
}

// ---- D-212: the notices ---------------------------------------------------------------------------

/** One role that counts for D-212 (the narrator; the Director when on; the recorder and a calling recall while the Compendium is on). */
export interface ServerRole {
  role: 'narrator' | 'director' | 'recorder' | 'recall';
  conn: Connection;
  model: string;
  caps: ModelCaps;
}

export interface ServerFacts {
  /** Settled server info by origin; an origin missing here is not judged yet. */
  info(origin: string): ServerInfo | undefined;
  /** Settled /api/show by origin and name; undefined while not read. */
  ollama(origin: string, model: string): OllamaModel | null | undefined;
  /** The origin's effective capacity (the semaphore's). */
  capacity(origin: string): number;
}

/** A notice with the key it is told once under (code and subject). */
export interface ServerNotice {
  key: string;
  notice: Notice;
}

const ROLE_NAMES: Record<ServerRole['role'], string> = { narrator: 'the narrator', director: 'the Director', recorder: 'the recorder', recall: 'recall' };

/** "the narrator and the Director" */
function rolesText(roles: readonly ServerRole[]): string {
  const names = [...new Set(roles.map((r) => ROLE_NAMES[r.role]))];
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

function byOrigin(roles: readonly ServerRole[]): Map<string, ServerRole[]> {
  const out = new Map<string, ServerRole[]>();
  for (const r of roles) out.set(r.conn.origin, [...(out.get(r.conn.origin) ?? []), r]);
  return out;
}

/** The roles of one origin by model name, in role order. */
function byModel(roles: readonly ServerRole[]): Map<string, ServerRole[]> {
  const out = new Map<string, ServerRole[]>();
  for (const r of roles) out.set(r.model, [...(out.get(r.model) ?? []), r]);
  return out;
}

const RUNNER_KEYS: readonly (keyof OllamaRunner)[] = ['num_ctx', 'num_batch', 'num_gpu', 'main_gpu', 'use_mmap', 'num_thread'];

/** The runner options two names differ in, as "num_ctx 16384 vs 32768" (unset reads "default"). */
function runnerDiff(a: OllamaRunner, b: OllamaRunner): string[] {
  const show = (v: number | boolean | null): string => (v === null ? 'default' : String(v));
  return RUNNER_KEYS.filter((k) => a[k] !== b[k]).map((k) => `${k} ${show(a[k])} vs ${show(b[k])}`);
}

function slotNotices(origin: string, roles: readonly ServerRole[], info: Extract<ServerInfo, { kind: 'llama.cpp' }>, capacity: number): ServerNotice[] {
  const out: ServerNotice[] = [];
  const judged = roles.map((r) => ({ r, v: slotPinOf(r.caps, info, capacity) }));
  const pinned = judged.filter((j) => j.v.pin !== null);
  const unpinned = judged.filter((j) => j.v.pin === null);
  const slots = info.totalSlots === null ? 'an unknown number of slots' : `${info.totalSlots} slot${info.totalSlots === 1 ? '' : 's'}`;
  const build = info.build === null ? '' : `, build b${info.build}`;
  if (pinned.length > 0) {
    // The narrator's pin when it is pinned (a custom slot_pin may number the slots otherwise).
    const narrator = pinned.find((j) => j.r.role === 'narrator');
    const first = narrator ?? pinned[0]!;
    const pin = first.v.pin!;
    // The plain rule's reason is the slot count and build already said; any other reason is told.
    const why = first.v.why === `${slots}${build}` ? '' : ` (${first.v.why})`;
    // Only the roles that really are pinned are named: an unpinned narrator sends no id_slot.
    const agents = pinned.filter((j) => j.r.role !== 'narrator').map((j) => j.r);
    const what = narrator
      ? `the narrator keeps slot ${pin.narrator} and the agents use slot ${pin.agents}${why}. ` +
        "The narrator's cache stays in VRAM only with -np 2 --no-kv-unified"
      : `for ${rolesText(agents)}, which ${agents.length === 1 ? 'uses' : 'use'} slot ${pin.agents}${why}${roles.some((r) => r.role === 'narrator') ? '; the narrator is not pinned' : ''}. ` +
        "A slot's cache stays in VRAM only with -np 2 --no-kv-unified";
    out.push({
      key: `slots_pinned:${origin}`,
      notice: {
        level: 'info',
        code: 'slots_pinned',
        message:
          `The llama.cpp server at ${origin} (${slots}${build}) is pinned${narrator ? ':' : ''} ${what}: ` +
          'with the default -np auto the KV is unified and an idle slot is moved to host RAM whenever another task starts.',
      },
    });
  }
  if (unpinned.length > 0 && info.totalSlots !== null && info.totalSlots >= 2) {
    const first = unpinned[0]!;
    const label = `${first.r.conn.id}:${first.r.model}`;
    // pinVerdict's own reason already says how for an old build; the user's slot_pin = false does not,
    // and a hand-set id_slot is the user's own choice.
    const how = first.v.why.includes('slot_pin = true') || first.v.why.includes('extra_body') ? '' : `; to pin, set slot_pin = true under [caps."${label}"]`;
    out.push({
      key: `slots_detected:${origin}`,
      notice: {
        level: 'info',
        code: 'slots_detected',
        message: `The llama.cpp server at ${origin} has ${slots}${build}, but rp-core does not pin it for ${rolesText(unpinned.map((j) => j.r))}: ${first.v.why}${how}.`,
      },
    });
  }
  return out;
}

function ollamaNotices(origin: string, roles: readonly ServerRole[], facts: ServerFacts): ServerNotice[] {
  const out: ServerNotice[] = [];
  const models = [...byModel(roles)];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const [na, ra] = models[i]!;
      const [nb, rb] = models[j]!;
      const a = facts.ollama(origin, na);
      const b = facts.ollama(origin, nb);
      // Different blobs are not warned about: whether both stay loaded is not something the API shows.
      if (!a || !b || a.blob !== b.blob) continue;
      const diff = runnerDiff(a.runner, b.runner);
      if (diff.length === 0) continue;
      const pair = [na, nb].sort();
      out.push({
        key: `ollama_reload_risk:${origin}:${pair.join('|')}`,
        notice: {
          level: 'warn',
          code: 'ollama_reload_risk',
          message:
            `On the Ollama server at ${origin}, ${rolesText(ra)} on ${na} and ${rolesText(rb)} on ${nb} share one model file with different runner options (${diff.join(', ')}), ` +
            'so every switch between them reloads the model. Bind both roles to one name.',
        },
      });
    }
  }
  return out;
}

function lmStudioNotices(origin: string, roles: readonly ServerRole[], loaded: Readonly<Record<string, boolean>>): ServerNotice[] {
  const names = [...byModel(roles).keys()];
  if (names.length < 2) return [];
  const cold = names.filter((n) => loaded[n] !== true);
  if (cold.length === 0) return [];
  return [
    {
      key: `lmstudio_autoevict:${origin}:${[...names].sort().join('|')}`,
      notice: {
        level: 'warn',
        code: 'lmstudio_autoevict',
        message:
          `The roles on the LM Studio server at ${origin} name ${names.length} models (${names.join(', ')}) and ${cold.join(', ')} ${cold.length === 1 ? 'is' : 'are'} not loaded: ` +
          "a JIT load with Auto-Evict on (LM Studio's default) unloads the other model each time. Load both with `lms load`, or bind the agents to the narrator's model.",
      },
    },
  ];
}

/**
 * D-212: the notices the roles call for, given what their servers said. Pure; the session tells each
 * once by its key. An origin whose info has not settled gives nothing yet.
 */
export function serverNotices(roles: readonly ServerRole[], facts: ServerFacts): ServerNotice[] {
  const out: ServerNotice[] = [];
  for (const [origin, rs] of byOrigin(roles)) {
    const info = facts.info(origin);
    if (info === undefined) continue;
    if (info.kind === 'llama.cpp') out.push(...slotNotices(origin, rs, info, facts.capacity(origin)));
    else if (info.kind === 'ollama') out.push(...ollamaNotices(origin, rs, facts));
    else if (info.kind === 'lmstudio') out.push(...lmStudioNotices(origin, rs, info.loaded));
  }
  return out;
}

/** The Ollama names whose /api/show the notices need: two or more names on one Ollama origin. */
export function ollamaNeeds(roles: readonly ServerRole[], info: (origin: string) => ServerInfo | undefined): ServerRole[] {
  const out: ServerRole[] = [];
  for (const [origin, rs] of byOrigin(roles)) {
    if (info(origin)?.kind !== 'ollama') continue;
    const models = byModel(rs);
    if (models.size < 2) continue;
    for (const list of models.values()) out.push(list[0]!);
  }
  return out;
}
