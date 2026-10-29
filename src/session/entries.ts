// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The on-disk format of a session (ARCHITECTURE.md §5.3–§5.7, §5.10). One append-only JSONL file:
// line 1 is the header, every other line is an Entry with a monotonic `seq`.
//
// CONTRACT FILE: the types are fixed by the architect. The storage agent implements the parse
// functions at the bottom; do not change exported type shapes.

import type { DirectorRecord } from '../agents/director/types.ts';
import type { Character, Persona, Samplers } from '../formats/native.ts';
import type { Usage, FinishReason } from '../providers/types.ts';

// ---- blocks and generations (§5.4) ------------------------------------------------------------

export type Block =
  | { k: 'text'; text: string }
  | { k: 'reasoning'; text: string; kind?: 'raw' | 'summary' | 'omitted' | 'redacted' }
  | { k: 'tool_call'; id: string; name: string; args: string }
  | { k: 'tool_result'; callId: string; name: string; text: string; error?: boolean };

export interface Generation {
  kind: 'model' | 'greeting';
  connection?: string;
  model?: string;
  served?: string;
  finish?: FinishReason;
  usage?: Usage;
  ms?: number;
  ttftMs?: number;
  reasoningMs?: number;
  transport?: 'native' | 'prompted' | 'none';
  rounds?: number;
  preset?: { name: string; hash: string };
  prefill?: string;
  guidance?: string;
  route?: { model: string; status: 'ok' | 'retry' | 'error'; code?: string }[];
}

export type VarsDiff = Record<string, string | number | null>;
export type TurnKind = 'reply' | 'swipe' | 'continue';

// ---- trace (§5.7) ---------------------------------------------------------------------------------

export interface Trace {
  seed: number;
  now: string;
  window: number;
  reserve: number;
  /**
   * counter: how `estimated` was counted (M2; absent = 'chars', M1). The EMA compares like with like.
   * estimated: the messages sent (the sum of `blocks`) plus the prefill the request carried, if any,
   * plus (M3) the native tool declarations of round 0's request, if any.
   */
  tokens: { estimated: number; reported?: number; counter?: 'chars' | 'o200k' };
  /** 1:1 with the messages sent. */
  blocks: { src: string; role: string; tok: number }[];
  /**
   * M2: book = LoreSource.key ('@card', '@persona' or a library id); why = LoreFireReason; cut =
   * entryLabel() of each entry the budget dropped; budget = the lore budget in tokens. Verdicts are
   * never stored: they are recomputed from seed and now [D-45].
   */
  lore: {
    fired: { book: string; id: string; why: string }[];
    cut: string[];
    budget: number;
    /**
     * M2 (fix): fired entries whose text nothing in the request took (entry label → the slot it
     * needed, e.g. '{{lore::before}}' of a disabled worldInfoBefore). Absent when every one was sent.
     */
    unsent?: Record<string, string>;
  };
  /**
   * M5b (D-178): the {{recap}} slot's summary ids, arc revisions and boundary; since ruling K also the
   * profile and the share (⌊10 % × window⌋) it was chosen under, absent on an empty slot and in older traces.
   */
  recap: { ids: string[]; arcs: { key: string; rev: number }[]; boundary: string | null; profile?: 'full' | 'lite'; share?: number };
  /** M5a (D-155): present when the request had Compendium input (enabled, ≥ 1 live typed entry). */
  compendium?: CompendiumTrace;
  prefill: 'sent' | 'tools_off' | 'skipped_for_tools' | 'unsupported' | null;
  macros: { unknown: string[] };
  /** Oldest and newest message ids cut by the budget, if any. */
  trimmed: { from: string; to: string } | null;
  calls: { callKey: string; agent: string; model: string; ms: number; usage?: Usage }[];
  agents: Record<string, { status: 'done' | 'reused' | 'skipped' | 'failed'; code?: string; transport?: string }>;
  /**
   * M3: one row per tool call the narrator made, in call order (§9.1: every repair is traced).
   * round: the loop round the call came from (0-based); ok: the tool ran and did not report an
   * error; refused: the call was not run — 'final_round' (the model called on the text-only final
   * round, §7.1), 'unknown_tool', 'bad_args' (the D-56 chain gave up), 'cancelled' (Stop); chars:
   * the result's length as sent; cut: the result was cut to fit (maxOutput or the tool room).
   */
  tools?: ToolTraceRow[];
  /**
   * M3: the narrator's tool loop. Absent when no tools were offered. n: model calls the loop made
   * (the final round included); ended: why it stopped calling tools (§7.1) — 'answer' (a round with
   * no calls), 'max_rounds', 'ceiling' (CALL_CEILING), 'guard' (3-of-8 loop guard), 'room' (the
   * tool room ran out), 'stopped', 'error'.
   */
  rounds?: {
    n: number;
    transport: 'native' | 'prompted';
    ended: 'answer' | 'max_rounds' | 'ceiling' | 'guard' | 'room' | 'stopped' | 'error';
    /** The tool room assemble reserved, in budget tokens, and what was left at the end. */
    room: number;
    roomLeft: number;
  };
  hooks?: { name: string; ok: boolean; note?: string }[];
  presetHash: string;
  loreHashes: Record<string, string>;
  /**
   * M2 (fix): each lore source's book name (trimmed), keyed like loreHashes. Timers follow a world by
   * name when it is read under another key later (the card's own book and a same-named session
   * book, §10.3). Absent in traces written before it; never required.
   */
  loreNames?: Record<string, string>;
  partial?: true;
}

// ---- agent records (reserved: Director M4, Compendium M5) ----------------------------------------

/**
 * §7.3 DirectorRecord: the type of agents/director/types.ts (M4, D-117). The journal guard checks only
 * that a `dir` is an object (anyObj), so a `dir` field holds what was written (a DirectorRecord) or,
 * read back, any object: every reader goes through agents/director/state.ts checkRecord.
 */
export type { DirectorRecord };
/** A `dir` as the journal holds it: written as a DirectorRecord, read back as any object. */
export type StoredDirectorRecord = DirectorRecord | Record<string, unknown>;
/**
 * §7.4.2 RecallRecord (M5c, D-200): what recall picked for an answer. Written in `prep` and the commit
 * only when recall ran or a prefetch was missed. `picks` hold entry KEYS in the model's order; no entry
 * text is stored (assembly reads the current fold). Read back through agents/compendium/recall.ts
 * checkRecallRecord: a malformed stored record reads as absent.
 */
export interface RecallRecord {
  v: 1;
  status: 'recalled' | 'empty' | 'skipped' | 'failed';
  source: 'sync' | 'prefetch' | 'lexical' | 'reused';
  profile: 'full' | 'lite';
  picks: { ref: string; reason?: string }[];
  unknown: number;
  repeated: number;
  trimmed: number;
  omitted: number;
  byName: number;
  salvaged: number;
  calls: number;
  ms?: number;
  model?: string;
  transport?: 'structured' | 'tagged';
  code?: 'timeout' | 'provider_error' | 'no_output' | 'undecodable' | 'transport_unsupported' | 'aborted' | 'no_connection' | 'prefetch_missed' | 'empty_index' | 'no_room';
  /** prefetch: the answer A(n) it was computed after. */
  basis?: string;
  /** swipe: the replaced answer; continue: its target. */
  reusedFrom?: string;
  /** Token usage of its calls, for /usage. */
  usage?: { input: number; output: number };
}
/** A `recall` as the journal holds it: written as a RecallRecord, read back as any object. */
export type StoredRecallRecord = RecallRecord | Record<string, unknown>;

export interface CommitBody {
  blocks: Block[];
  gen?: Generation;
  trace?: Trace;
  dir?: StoredDirectorRecord;
  recall?: StoredRecallRecord;
  vars?: VarsDiff;
}

// ---- session configuration (§5.1) --------------------------------------------------------------

export interface Binding {
  conn: string;
  model: string;
  fallback?: { conn: string; model: string };
  maxTokens?: number;
  samplers?: Partial<Samplers>;
  reasoning?: 'auto' | 'none' | 'low' | 'medium' | 'high';
}

export interface Roles {
  narrator: Binding;
  director?: Binding | 'narrator';
  recorder?: Binding | 'narrator';
  recall?: Binding | 'narrator' | 'recorder';
}

/**
 * §7.4.9 (M5a, D-158). Stored as written; agents/compendium/profile.ts resolveCompendium fills the
 * defaults. M5a reads enabled, profile, minShare and books; recall/filing/historian are parsed and
 * validated for M5b/M5c. Older headers hold only `enabled` (and maybe raw snake_case keys): extra
 * keys are kept, never read.
 */
export interface CompendiumConfig {
  enabled: boolean;
  /** 'auto': lite when the agent's window is below 24 576 tokens [D-79]. */
  profile?: 'auto' | 'full' | 'lite';
  /** ≤ 80 chars. */
  language?: string;
  /** ≤ 4 000 chars (filing and historian; narrows only). */
  guidance?: string;
  /** Share of the lore budget kept for the Compendium block when it has candidates (0.4) [D-77]. */
  minShare?: number;
  maxAttempts?: number;
  /** 0–60. */
  idleDelaySec?: number;
  /** Library id → access; absent = 'read' [D-76]. */
  books?: Record<string, 'read' | 'off'>;
  recall?: {
    mode?: 'auto' | 'sync' | 'prefetch' | 'lexical' | 'off';
    onMiss?: 'auto' | 'lexical' | 'sync';
    maxEntries?: number;
    minEntries?: number;
    contextMessages?: number;
    graceSec?: number;
    timeoutSec?: number;
    onSwipe?: 'reuse' | 'rerun';
    guidance?: string;
  };
  filing?: { enabled?: boolean; wait?: number; everyN?: number; allow?: string[]; timeoutSec?: number };
  historian?: { interval?: number; recapAfter?: number; overlap?: number };
  [k: string]: unknown;
}

/** D-155: what the Compendium block did in one request. No entry texts, ever. */
export interface CompendiumTrace {
  /** CompendiumView.rev the request read. */
  rev: string;
  /** M5a: 'lexical' (the model-free selector); M5c: the turn's RecallRecord source, or 'lexical' / 'off' without one (D-203). */
  source: 'sync' | 'prefetch' | 'lexical' | 'reused' | 'off';
  profile: 'full' | 'lite';
  picks: { ref: string; key: string; via: 'mention' | 'model' | 'window' | 'constant' }[];
  injected: { ref: string; tok: number; mode: 'full' | 'brief' }[];
  cut: { ref: string; tok: number }[];
  /** Keys skipped because they were already in the prompt. */
  repeated: string[];
  /** Entries hidden plus array elements dropped by freshness [D-80]. */
  hidden: number;
  /** Tokens: the lore share, what the lore engine used, what the block used. */
  budget: { share: number; lore: number; block: number };
}

export interface SessionConfig {
  roles: Roles;
  /** Library preset name or 'builtin'. Read every turn; its hash goes to the trace. */
  preset: string;
  lorebooks: string[];
  authorNote?: { text: string; depth: number; role: 'system' | 'user' };
  narrator: { maxRounds: number; prefillVsTools: 'prefill' | 'tools' };
  director: {
    enabled: boolean;
    profile: 'auto' | 'full' | 'lite';
    instructions: string;
    onSwipe: 'reuse' | 'replan';
    timeoutSec?: number;
    style: string;
    creativity: 'subtle' | 'moderate' | 'dramatic';
  };
  compendium: CompendiumConfig;
  reasoningShown: boolean;
  swipe: { showRejected: boolean };
  /** Window override; may only shrink the window. */
  window?: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  roles: { narrator: { conn: 'script', model: 'default' } },
  preset: 'builtin',
  lorebooks: [],
  narrator: { maxRounds: 4, prefillVsTools: 'prefill' },
  director: {
    enabled: false,
    profile: 'auto',
    instructions: '',
    onSwipe: 'reuse',
    style: 'the-balanced',
    creativity: 'moderate',
  },
  // D-158: new sessions read their books' Compendium entries; a stored header keeps what it holds.
  compendium: { enabled: true },
  reasoningShown: false,
  swipe: { showRejected: true },
};

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

// ---- entries (§5.3) ------------------------------------------------------------------------------

export interface SessionHeader {
  t: 'session';
  v: 1;
  id: string;
  created: string;
  title?: string;
  fork?: { from: string; at: string };
  /** D-192: a session imported from another app (RoleCall story export): where it came from. */
  imported?: { from: 'rolecall'; chat: string; exportedAt: string } | { from: 'sillytavern'; hash: string; file: string };
  cast: { character: Character; persona?: Persona };
  config: SessionConfig;
  vars0?: VarsDiff;
}

export interface MsgEntry extends Partial<CommitBody> {
  t: 'msg';
  seq: number;
  ts: string;
  /** 8 hex; issued when the turn begins so `start` can announce it. */
  id: string;
  /** null = a root (greetings are sibling roots). */
  parent: string | null;
  role: 'user' | 'assistant';
  speaker?: string; // reserved [D-10]
  turn?: string;
  /**
   * An answer committed as a tail (§6.6: the head moved during its turn): unlike every other msg
   * it does not move the head onto itself. One line, so the tail commit stays atomic (§5.3).
   */
  tail?: true;
}

export interface EditEntry extends Partial<CommitBody> {
  t: 'edit';
  seq: number;
  ts: string;
  target: string;
  reason: 'user' | 'continue';
  turn?: string;
}

export interface HideEntry {
  t: 'hide';
  seq: number;
  ts: string;
  target: string;
  hidden: boolean;
}
export interface HeadEntry {
  t: 'head';
  seq: number;
  ts: string;
  leaf: string;
}
export interface ConfigEntry {
  t: 'config';
  seq: number;
  ts: string;
  patch: DeepPartial<SessionConfig>;
}
/** A session-level persona change; the original header stays immutable on disk. */
export interface PersonaEntry {
  t: 'persona';
  seq: number;
  ts: string;
  persona: Persona;
}
export interface TurnEntry {
  t: 'turn';
  seq: number;
  ts: string;
  turn: string;
  kind: TurnKind;
  /** reply: the user message U answered; swipe: U (parent of the replaced answer); continue: the target's parent. */
  parent: string;
  /** swipe: the replaced answer; continue: the answer being continued. */
  target?: string;
  /** The id the committed msg will get (reply/swipe); for continue the target id. */
  msgId: string;
  seed: number;
  now: string;
  /** version(session) when the turn began: the commit guard. */
  base: number;
}
export interface PrepEntry {
  t: 'prep';
  seq: number;
  turn: string;
  dir?: StoredDirectorRecord;
  recall?: StoredRecallRecord;
  vars?: VarsDiff;
  trace: Trace;
  /** continue only: how the addition is joined and the target's text at turn start (recovery needs both). */
  cont?: { mode: 'prefill' | 'cue'; base: string };
  /** The preset prefill actually sent (it is not part of the committed text; gen.prefill records it). */
  prefill?: string;
  /**
   * The narrator binding the request went to (the primary; a fallback attempt does not rewrite it).
   * Recovery copies it into the recovered answer's gen.connection / gen.model.
   */
  model?: { connection: string; model: string };
}
export interface ChkEntry {
  t: 'chk';
  seq: number;
  turn: string;
  /** A text delta (only the new text since the previous chk). */
  text: string;
}
export interface HeldEntry {
  t: 'held';
  seq: number;
  turn: string;
  body: CommitBody;
}
export interface EndEntry {
  t: 'end';
  seq: number;
  ts: string;
  turn: string;
  code?: string;
  outcome: 'failed' | 'stopped-empty' | 'dropped' | 'discarded' | 'abandoned';
}
export interface JobEntry {
  t: 'job';
  seq: number;
  ts: string;
  job: string;
  key: string;
  task: 'file' | 'hist';
  on: string;
  /** 'retry' (M5b, D-171): /memory retry reset the key's failure count; the lane queues it again. */
  state: 'begin' | 'failed' | 'retry';
  attempt: number;
  code?: string;
}
/**
 * §5.8 Compendium row (M3: typed; only human note rows are written before M5). `key`: the task key
 * (filing/historian, M5) or null for a human row; `on`: the message the row is bound to, or null for
 * a global human edit (it applies on every path where its target exists). Extra fields are kept.
 */
export interface MemEntry {
  t: 'mem';
  seq: number;
  ts: string;
  key: string | null;
  on: string | null;
  by: 'filing' | 'historian' | 'user';
  /** First and last path message the task covered (M5). */
  range?: [string, string];
  /** [] = "nothing to record"; the key is still closed [D-68]. */
  ops: MemOp[];
  skipped?: { path: string; why: string }[];
  gen?: { model: string; profile: 'full' | 'lite'; transport: 'structured' | 'tagged'; calls: number; ms: number };
  [k: string]: unknown;
}

type MemRec = Record<string, unknown>;

/**
 * §5.8 MemOp. M3 applies note / edit / retire / restore over notes; the fold records file, arc and
 * revert as issues until M5a. `ref` is an entry key (CEntry.key, e.g. 'note:брат'), never a handle.
 * A note's edit: set.title renames it (its key stays), set.content replaces its text, keys replaces
 * its lore keys.
 */
export type MemOp =
  /**
   * target (M5a, D-168): a human row's file op names the key its dry run produced, so the row keeps
   * addressing that entry whatever books are attached later. Agent rows (M5b) are matched by name.
   */
  | { op: 'file'; type: string; data: MemRec; target?: string }
  | { op: 'arc'; plot: string; overview: string }
  | { op: 'note'; title: string; keys: string[]; content: string }
  | { op: 'edit'; ref: string; set?: MemRec; unset?: string[]; keys?: string[]; featured?: boolean }
  | { op: 'retire'; ref: string; reason: string }
  | { op: 'restore'; ref: string }
  | { op: 'revert'; key: string };

/** M3: Trace.tools row (see Trace.tools). */
export interface ToolTraceRow {
  round: number;
  callId: string;
  name: string;
  ok: boolean;
  repaired?: string[];
  refused?: 'final_round' | 'unknown_tool' | 'bad_args' | 'cancelled';
  ms?: number;
  chars?: number;
  cut?: true;
}

export type Entry =
  | ConfigEntry
  | PersonaEntry
  | MsgEntry
  | EditEntry
  | HideEntry
  | HeadEntry
  | TurnEntry
  | PrepEntry
  | ChkEntry
  | HeldEntry
  | EndEntry
  | JobEntry
  | MemEntry;

export type EntryKind = Entry['t'];

/**
 * Omit by key remapping. Unlike the built-in `Omit` (a Pick over `Exclude<keyof T, K>`), it keeps
 * the known keys of a type with a string index signature (MemEntry): `Omit` collapsed MemEntry to
 * `{ [k: string]: unknown }`, which let SessionLog.append accept any object at compile time.
 */
type OmitKey<T, K extends PropertyKey> = { [P in keyof T as P extends K ? never : P]: T[P] };

/** Entry without `seq`: what callers hand to SessionLog.append, which assigns the seq. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? OmitKey<T, K> : never;
export type EntryInput = DistributiveOmit<Entry, 'seq'>;

/** Entry kinds that change version(session) (§5.3). */
export const VERSIONED_KINDS: ReadonlySet<EntryKind> = new Set(['msg', 'edit', 'hide', 'head', 'persona']);

// ---- parsing (implemented by the storage agent) -------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; why: string };

// The guards check what the core relies on: the envelope of every kind, the shape of blocks and of
// everything the fold reads (vars, lore fires, generation). Opaque payloads (director/recall
// records, config patches, most of the trace, lorebooks inside the cast) are checked only for
// being objects, so a richer writer cannot make a reader drop a whole commit line. Extra fields are
// kept: the parsed object is returned as is, never rebuilt.

/** A check returns null when the value fits, else a short "path: problem" message. */
type Check = (v: unknown, path: string) => string | null;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str: Check = (v, p) => (typeof v === 'string' ? null : `${p}: expected a string`);
const nonEmpty: Check = (v, p) => (typeof v === 'string' && v.length > 0 ? null : `${p}: expected a non-empty string`);
const num: Check = (v, p) => (typeof v === 'number' && Number.isFinite(v) ? null : `${p}: expected a number`);
const bool: Check = (v, p) => (typeof v === 'boolean' ? null : `${p}: expected a boolean`);
const anyObj: Check = (v, p) => (isObj(v) ? null : `${p}: expected an object`);
const seqNum: Check = (v, p) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? null : `${p}: expected a positive integer`;

const oneOf =
  (...values: readonly (string | number | boolean | null)[]): Check =>
  (v, p) =>
    values.includes(v as string) ? null : `${p}: expected one of ${values.map((x) => JSON.stringify(x)).join(', ')}`;

const nullable =
  (c: Check): Check =>
  (v, p) =>
    v === null ? null : c(v, p);

const either =
  (a: Check, b: Check): Check =>
  (v, p) =>
    a(v, p) === null ? null : b(v, p);

const arr =
  (c: Check): Check =>
  (v, p) => {
    if (!Array.isArray(v)) return `${p}: expected an array`;
    for (let i = 0; i < v.length; i++) {
      const e = c(v[i], `${p}[${i}]`);
      if (e) return e;
    }
    return null;
  };

const record =
  (c: Check): Check =>
  (v, p) => {
    if (!isObj(v)) return `${p}: expected an object`;
    for (const k of Object.keys(v)) {
      const e = c(v[k], `${p}.${k}`);
      if (e) return e;
    }
    return null;
  };

/** Object with required and optional fields; `undefined` counts as absent, extra keys are fine. */
const obj =
  (req: Record<string, Check>, opt: Record<string, Check> = {}): Check =>
  (v, p) => {
    if (!isObj(v)) return `${p}: expected an object`;
    for (const k in req) {
      const x = v[k];
      if (x === undefined) return `${p}.${k}: missing`;
      const e = req[k]!(x, `${p}.${k}`);
      if (e) return e;
    }
    for (const k in opt) {
      const x = v[k];
      if (x === undefined) continue;
      const e = opt[k]!(x, `${p}.${k}`);
      if (e) return e;
    }
    return null;
  };

// ---- shared shapes ---------------------------------------------------------------------------------

const block: Check = (v, p) => {
  if (!isObj(v)) return `${p}: expected a block object`;
  switch (v.k) {
    case 'text':
      return obj({ text: str })(v, p);
    case 'reasoning':
      return obj({ text: str }, { kind: oneOf('raw', 'summary', 'omitted', 'redacted') })(v, p);
    case 'tool_call':
      return obj({ id: str, name: str, args: str })(v, p);
    case 'tool_result':
      return obj({ callId: str, name: str, text: str }, { error: bool })(v, p);
    default:
      return `${p}.k: unknown block kind ${JSON.stringify(v.k)}`;
  }
};

const FINISH = ['end', 'length', 'stopped', 'interrupted', 'content_filter', 'refusal', 'max_rounds'] as const;

const generation = obj(
  { kind: oneOf('model', 'greeting') },
  {
    connection: str,
    model: str,
    served: str,
    finish: oneOf(...FINISH),
    usage: anyObj,
    ms: num,
    ttftMs: num,
    reasoningMs: num,
    transport: oneOf('native', 'prompted', 'none'),
    rounds: num,
    preset: obj({ name: str, hash: str }),
    prefill: str,
    guidance: str,
    route: arr(obj({ model: str, status: oneOf('ok', 'retry', 'error') }, { code: str })),
  },
);

/** Only the parts of a trace that feed state (seed, clock, lore fires); the rest is diagnostics. */
const trace = obj({
  seed: num,
  now: str,
  lore: obj({ fired: arr(obj({ book: str, id: str, why: str })) }),
});

const varsDiff = record(either(nullable(str), num));

/** Partial<CommitBody> fields as they appear on msg and edit entries. */
const commitFields: Record<string, Check> = {
  blocks: arr(block),
  gen: generation,
  trace,
  dir: anyObj,
  recall: anyObj,
  vars: varsDiff,
};

const commitBody = obj({ blocks: arr(block) }, { gen: generation, trace, dir: anyObj, recall: anyObj, vars: varsDiff });

// ---- header -----------------------------------------------------------------------------------------

const binding = obj(
  { conn: str, model: str },
  {
    fallback: obj({ conn: str, model: str }),
    maxTokens: num,
    samplers: anyObj,
    reasoning: oneOf('auto', 'none', 'low', 'medium', 'high'),
  },
);

const sessionConfig = obj(
  {
    roles: obj(
      { narrator: binding },
      {
        director: either(oneOf('narrator'), binding),
        recorder: either(oneOf('narrator'), binding),
        recall: either(oneOf('narrator', 'recorder'), binding),
      },
    ),
    preset: str,
    lorebooks: arr(str),
    narrator: obj({ maxRounds: num, prefillVsTools: oneOf('prefill', 'tools') }),
    director: obj(
      {
        enabled: bool,
        profile: oneOf('auto', 'full', 'lite'),
        instructions: str,
        onSwipe: oneOf('reuse', 'replan'),
        style: str,
        creativity: oneOf('subtle', 'moderate', 'dramatic'),
      },
      { timeoutSec: num },
    ),
    // D-158 (the lead's ruling after the review): only `enabled` is checked. M4 stored the [compendium]
    // table as config.toml had it (snake_case, values it never read), and such a header must still open;
    // resolveCompendium defaults what it cannot read, and configure() checks what a session writes
    // (config.ts compendiumPatchProblem).
    compendium: obj({ enabled: bool }),
    reasoningShown: bool,
    swipe: obj({ showRejected: bool }),
  },
  {
    authorNote: obj({ text: str, depth: num, role: oneOf('system', 'user') }),
    window: num,
  },
);

const character = obj(
  { name: str, description: str, greetings: arr(str) },
  {
    personality: str,
    scenario: str,
    examples: str,
    systemPrompt: str,
    postHistory: str,
    depthPrompt: obj({ text: str, depth: num, role: oneOf('system', 'user', 'assistant') }),
    book: anyObj,
    creator: str,
    tags: arr(str),
    extras: anyObj,
  },
);

const persona = obj({ name: str, description: str }, { aliases: arr(str), book: anyObj });

const header = obj(
  {
    t: oneOf('session'),
    v: oneOf(1),
    id: nonEmpty,
    created: str,
    cast: obj({ character }, { persona }),
    config: sessionConfig,
  },
  { title: str, fork: obj({ from: str, at: str }), imported: either(obj({ from: oneOf('rolecall'), chat: str, exportedAt: str }), obj({ from: oneOf('sillytavern'), hash: str, file: str })), vars0: varsDiff },
);

// ---- entries ---------------------------------------------------------------------------------------

const ENTRY_CHECKS: Record<EntryKind, Check> = {
  config: obj({ seq: seqNum, ts: str, patch: anyObj }),
  persona: obj({ seq: seqNum, ts: str, persona }),
  msg: obj(
    { seq: seqNum, ts: str, id: nonEmpty, parent: nullable(nonEmpty), role: oneOf('user', 'assistant') },
    { speaker: str, turn: str, tail: oneOf(true), ...commitFields },
  ),
  edit: obj(
    { seq: seqNum, ts: str, target: nonEmpty, reason: oneOf('user', 'continue') },
    { turn: str, ...commitFields },
  ),
  hide: obj({ seq: seqNum, ts: str, target: nonEmpty, hidden: bool }),
  head: obj({ seq: seqNum, ts: str, leaf: nonEmpty }),
  turn: obj(
    {
      seq: seqNum,
      ts: str,
      turn: nonEmpty,
      kind: oneOf('reply', 'swipe', 'continue'),
      parent: nonEmpty,
      msgId: nonEmpty,
      seed: num,
      now: str,
      base: num,
    },
    { target: nonEmpty },
  ),
  prep: obj(
    { seq: seqNum, turn: nonEmpty, trace },
    {
      dir: anyObj,
      recall: anyObj,
      vars: varsDiff,
      cont: obj({ mode: oneOf('prefill', 'cue'), base: str }),
      prefill: str,
      model: obj({ connection: str, model: str }),
    },
  ),
  chk: obj({ seq: seqNum, turn: nonEmpty, text: str }),
  held: obj({ seq: seqNum, turn: nonEmpty, body: commitBody }),
  end: obj(
    {
      seq: seqNum,
      ts: str,
      turn: nonEmpty,
      outcome: oneOf('failed', 'stopped-empty', 'dropped', 'discarded', 'abandoned'),
    },
    { code: str },
  ),
  job: obj(
    {
      seq: seqNum,
      ts: str,
      job: str,
      key: str,
      task: oneOf('file', 'hist'),
      on: str,
      state: oneOf('begin', 'failed', 'retry'),
      attempt: num,
    },
    { code: str },
  ),
  // M3: by and ops are required; each op only needs an `op` string (the fold skips what it cannot
  // apply and records why, so a richer writer never makes a reader drop the row).
  mem: obj({ seq: seqNum, ts: str, key: nullable(str), on: nullable(str), by: oneOf('filing', 'historian', 'user'), ops: arr(obj({ op: str })) }),
};

/** JSON.parse that reports instead of throwing (also catches pathological nesting). */
function parseJson(line: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch (e) {
    return { ok: false, why: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Shape-check an already parsed value as an entry (used by append before it writes). */
export function checkEntry(value: unknown): ParseResult<Entry> {
  try {
    if (!isObj(value)) return { ok: false, why: 'entry: expected an object' };
    const t = value.t;
    if (typeof t !== 'string' || !Object.prototype.hasOwnProperty.call(ENTRY_CHECKS, t)) {
      return { ok: false, why: `entry: unknown kind ${JSON.stringify(t)}` };
    }
    const e = ENTRY_CHECKS[t as EntryKind](value, t);
    return e ? { ok: false, why: e } : { ok: true, value: value as unknown as Entry };
  } catch (e) {
    // The guards do not throw on JSON data; this is a belt for exotic in-memory values.
    return { ok: false, why: `entry: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Shape-check an already parsed value as a header. */
export function checkHeader(value: unknown): ParseResult<SessionHeader> {
  try {
    if (!isObj(value)) return { ok: false, why: 'header: expected an object' };
    if (value.t !== 'session') return { ok: false, why: `header: expected t "session", got ${JSON.stringify(value.t)}` };
    if (value.v !== 1) return { ok: false, why: `header: unsupported version ${JSON.stringify(value.v)}` };
    const e = header(value, 'header');
    return e ? { ok: false, why: e } : { ok: true, value: value as unknown as SessionHeader };
  } catch (e) {
    return { ok: false, why: `header: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Parse and shape-check the header line. Zero dependencies, hand-written guards. */
export function parseHeader(line: string): ParseResult<SessionHeader> {
  const j = parseJson(line);
  return j.ok ? checkHeader(j.value) : j;
}

/** Parse and shape-check one entry line. Never throws; unknown `t` is a failure. */
export function parseEntry(line: string): ParseResult<Entry> {
  const j = parseJson(line);
  return j.ok ? checkEntry(j.value) : j;
}
