// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// `rp-core bench ttft [conn:model]` (M5d, D-214): does a server keep the narrator's prompt cached
// while an agent call runs in between? Each round makes three real calls, sequentially:
//   1. the narrator prompt P;
//   2. an agent prompt A, as agent `filing`, that starts with part of P (--agent-shared, as an agent's
//      prompt shares the system prompt and card); the slot pinning rule sends it to the agents' slot;
//   3. P plus a new tail T.
// Call 3's ratio is the tokens the server processed over the tokens that are new (its prompt_tokens
// minus call 1's). ≤ 1.5 is ARCHITECTURE §15's acceptance. The calls go through narrate.ts
// streamCall, so the timeouts, the usage and the prompt counts (D-213) are read as in a turn.
//
// The prompts are made-up words from a seeded generator: no fixture or story text is ever sent, and
// the same flags send the same bytes. It never opens a session or writes anything.

import { realTimers } from '../engine/abort.ts';
import type { Connection } from '../engine/api.ts';
import { streamCall, timeoutsFor, type CallResult } from '../engine/narrate.ts';
import { createScheduler } from '../engine/sched.ts';
import { slotPinOf } from '../engine/server-notices.ts';
import { estimateTokens } from '../prompt/tokens.ts';
import { pinLine, readServerInfo, SLOT_PIN, type PinVerdict, type ServerInfo } from '../providers/server-info.ts';
import type { CallAgent, ModelCaps, PromptMsg } from '../providers/types.ts';
import { UsageError } from './args.ts';
import { serverInfoLine } from './catalog.ts';
import type { Io } from './io.ts';
import { EXIT } from './oneshot.ts';
import { connectionCaps, connectionProblem, debugLine, redactor, type Runtime } from './runtime.ts';

/** ARCHITECTURE §15: call 3 may process at most this many times the new tokens. */
export const RATIO_LIMIT = 1.5;
/** Output cap of every bench call: only the prompt side is measured. */
export const BENCH_MAX_TOKENS = 16;
export const CALLS_PER_ROUND = 3;
export const BENCH_DEFAULTS = { rounds: 3, promptTokens: 4000, tailTokens: 200, agentTokens: 1500, agentShared: 50 } as const;
/** Bounds of the flags; the generator holds whole prompts in memory. */
const LIMITS = { rounds: 100, promptTokens: 262_144, tailTokens: 65_536, agentTokens: 262_144, agentShared: 90 } as const;
/** Room for chat-template tokens and the fixed reply between P and T when checking the window. */
const TEMPLATE_SLACK = 64;
/** The assistant line between P and T in call 3, so the prompt alternates like a chat. */
export const BRIDGE_REPLY = 'Noted.';

export type PinMode = 'auto' | 'on' | 'off';

export interface BenchArgs {
  rt: Runtime;
  io: Io;
  json: boolean;
  /** `conn:model`; absent: the narrator of [roles]. */
  target?: string;
  rounds?: number;
  promptTokens?: number;
  tailTokens?: number;
  agentTokens?: number;
  /** Percent of A that is P's own start, as an agent's prompt shares the system prompt and card (0–90). */
  agentShared?: number;
  /**
   * Put before P on every call of this run, so a second run does not meet the first one's cache.
   * The CLI draws it at random; '' (tests) sends none.
   */
  salt?: string;
  pin?: string;
  fetch?: typeof fetch;
  /** Times every call (first token and total). */
  clock: () => Date;
  /** The server-info read (D-210); 'off' under RP_CORE_SERVER_INFO=off. Default 'auto'. */
  serverInfo?: 'auto' | 'off';
  serverInfoMs?: { requestMs: number; totalMs: number };
}

export type PromptLabel = 'P' | 'A' | 'P+T';

export interface BenchCall {
  call: 1 | 2 | 3;
  agent: CallAgent;
  prompt: PromptLabel;
  /** The generated text's size by the project's counter (o200k), not the server's tokenizer. */
  estimatedTokens: number;
  /** The id_slot this call asked for, when pinned. */
  idSlot?: number;
  /** Client time to the first text or reasoning delta. */
  firstTokenMs?: number;
  totalMs: number;
  /** The server's prompt_tokens (or processed + cached). */
  promptTokens?: number;
  processed?: number;
  cached?: number;
}

export type Verdict = 'pass' | 'fail' | 'unknown';

export interface BenchRound {
  round: number;
  calls: BenchCall[];
  /** Call 3's prompt_tokens minus call 1's. */
  newTokens?: number;
  ratio?: number;
  verdict: Verdict;
  /** Set when the verdict is unknown. */
  why?: string;
}

export interface BenchResult {
  connection: string;
  model: string;
  baseUrl?: string;
  /** Real calls planned: rounds × 3. */
  plannedCalls: number;
  sizes: { promptTokens: number; tailTokens: number; agentTokens: number; agentShared: number };
  serverInfo: ServerInfo;
  pin: PinVerdict & { mode: PinMode };
  rounds: BenchRound[];
  /** Medians over the rounds, per call (index 0..2); null when no round had the figure. */
  median: { firstTokenMs: (number | null)[]; totalMs: (number | null)[]; ratio: number | null };
  limit: number;
  verdict: Verdict;
  /** What the verdict rests on, in one sentence. */
  why: string;
  /** Set when a call failed; the rounds before it are kept. */
  error?: { round: number; call: number; code: string; message: string };
}

// ---- the prompts ------------------------------------------------------------------------------------

/** mulberry32: small, seedable, the same numbers everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ONSETS = ['b', 'd', 'f', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'z', 'br', 'dr', 'gl', 'kr', 'pl', 'st', 'th', 'sh', 'tr'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'o', 'ai', 'ea', 'ou', 'ie'];
const CODAS = ['', '', '', 'n', 'r', 's', 'l', 'm', 'th', 'nd', 'st'];

/**
 * Made-up sentences from `seed`, at least `tokens` long by the project's counter (summed per
 * sentence, then checked once on the whole). Pure: one seed, one text.
 */
export function syntheticText(seed: number, tokens: number): string {
  const next = rng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const word = (): string => {
    const syllables = 1 + Math.floor(next() * 3);
    let w = '';
    for (let i = 0; i < syllables; i++) w += pick(ONSETS) + pick(VOWELS) + pick(CODAS);
    return w;
  };
  const sentence = (): string => {
    const n = 6 + Math.floor(next() * 9);
    const words: string[] = [];
    for (let i = 0; i < n; i++) words.push(word());
    const s = `${words.join(' ')}.`;
    return s[0]!.toUpperCase() + s.slice(1);
  };
  const sentences: string[] = [];
  let total = 0;
  while (total < tokens) {
    const s = sentence();
    sentences.push(s);
    total += estimateTokens(s);
  }
  // Joined text counts a little lower than its parts: top it up, counting the whole only here.
  let text = sentences.join(' ');
  while (estimateTokens(text) < tokens) text += ` ${sentence()}`;
  return text;
}

/** The seed of one prompt of one round: every round starts cold, and P, A and T never share words by design. */
export function seedOf(part: 'P' | 'A' | 'T', round: number): number {
  const k = part === 'P' ? 1 : part === 'A' ? 2 : 3;
  return (0x5eed + round * 1009 + k * 7919) >>> 0;
}

const user = (text: string): PromptMsg => ({ role: 'user', blocks: [{ k: 'text', text }], src: 'bench' });
const assistant = (text: string): PromptMsg => ({ role: 'assistant', blocks: [{ k: 'text', text }], src: 'bench' });

/** About the first `tokens` of `text`, cut at a space (by its share of the characters). */
function startOf(text: string, tokens: number, total: number): string {
  if (tokens <= 0) return '';
  const cut = Math.floor((text.length * Math.min(tokens, total)) / Math.max(1, total));
  const space = text.lastIndexOf(' ', cut);
  return text.slice(0, space > 0 ? space : cut);
}

/**
 * One round's three requests. Call 3 starts with call 1's message, byte for byte. A starts with
 * `agentShared` percent of its size taken from P's start, as a Director's or filing prompt shares the
 * system prompt and the card: that shared start is what draws llama.cpp's slot choice to the
 * narrator's slot when nothing pins it. `salt` goes before P (and so before A's shared start).
 */
export function roundPrompts(round: number, sizes: BenchResult['sizes'], salt = ''): { label: PromptLabel; agent: CallAgent; messages: PromptMsg[]; estimatedTokens: number }[] {
  const p = `${salt}${syntheticText(seedOf('P', round), sizes.promptTokens)}`;
  const sharedTokens = Math.round((sizes.agentTokens * sizes.agentShared) / 100);
  const shared = startOf(p, sharedTokens, estimateTokens(p));
  const own = syntheticText(seedOf('A', round), Math.max(1, sizes.agentTokens - estimateTokens(shared)));
  const a = shared === '' ? own : `${shared} ${own}`;
  const t = syntheticText(seedOf('T', round), sizes.tailTokens);
  const tp = estimateTokens(p);
  return [
    { label: 'P', agent: 'narrator', messages: [user(p)], estimatedTokens: tp },
    { label: 'A', agent: 'filing', messages: [user(a)], estimatedTokens: estimateTokens(a) },
    { label: 'P+T', agent: 'narrator', messages: [user(p), assistant(BRIDGE_REPLY), user(t)], estimatedTokens: tp + estimateTokens(BRIDGE_REPLY) + estimateTokens(t) },
  ];
}

// ---- arguments --------------------------------------------------------------------------------------

function bounded(v: number | undefined, flag: string, max: number, fallback: number): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 1 || v > max) throw new UsageError(`--${flag} must be a whole number from 1 to ${max}, got ${v}`, 'bench');
  return v;
}

function sharedOf(v: number | undefined): number {
  if (v === undefined) return BENCH_DEFAULTS.agentShared;
  if (!Number.isInteger(v) || v < 0 || v > LIMITS.agentShared) throw new UsageError(`--agent-shared must be a whole percent from 0 to ${LIMITS.agentShared}, got ${v}`, 'bench');
  return v;
}

function pinModeOf(v: string | undefined): PinMode {
  if (v === undefined) return 'auto';
  if (v === 'auto' || v === 'on' || v === 'off') return v;
  throw new UsageError(`--pin must be auto, on or off, got ${JSON.stringify(v)}`, 'bench');
}

/** `conn:model` (split at the first ':'), else the narrator binding of [roles]. */
function targetOf(rt: Runtime, target: string | undefined): { conn: string; model: string } {
  if (target === undefined) {
    const n = rt.config.sessionDefaults.roles?.narrator;
    if (typeof n?.conn !== 'string' || typeof n.model !== 'string') {
      throw new UsageError('no narrator in [roles] of config.toml: name the model, rp-core bench ttft <connection>:<model>', 'bench');
    }
    return { conn: n.conn, model: n.model };
  }
  const at = target.indexOf(':');
  if (at <= 0 || at === target.length - 1) throw new UsageError(`expected <connection>:<model>, got ${JSON.stringify(target)}`, 'bench');
  return { conn: target.slice(0, at), model: target.slice(at + 1) };
}

/** The connection's key for the server-info read; a key that cannot be read leaves it out (the call reports its own failure). */
async function keyOf(c: Connection): Promise<string | null> {
  try {
    return c.resolveKey ? await c.resolveKey() : (c.key ?? null);
  } catch {
    return null;
  }
}

// ---- the run ----------------------------------------------------------------------------------------

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Call 3 against call 1: the ratio and its verdict, or why it is unknown. */
export function judgeRound(calls: readonly BenchCall[]): Pick<BenchRound, 'newTokens' | 'ratio' | 'verdict' | 'why'> {
  const first = calls[0];
  const third = calls[2];
  if (!first || !third) return { verdict: 'unknown', why: 'the round did not finish' };
  if (third.processed === undefined) {
    return { verdict: 'unknown', why: 'the server reported no prompt counts (no cached_tokens in its usage, no cache_n in its timings)' };
  }
  if (first.promptTokens === undefined || third.promptTokens === undefined) return { verdict: 'unknown', why: 'the server reported no prompt token totals' };
  const fresh = third.promptTokens - first.promptTokens;
  if (fresh <= 0) return { verdict: 'unknown', why: `call 3's prompt (${third.promptTokens} tokens) is not longer than call 1's (${first.promptTokens})` };
  const ratio = third.processed / fresh;
  return { newTokens: fresh, ratio, verdict: ratio <= RATIO_LIMIT ? 'pass' : 'fail' };
}

function callOf(res: CallResult, spec: { label: PromptLabel; agent: CallAgent; estimatedTokens: number }, n: 1 | 2 | 3, pin: PinVerdict['pin']): BenchCall {
  const c: BenchCall = { call: n, agent: spec.agent, prompt: spec.label, estimatedTokens: spec.estimatedTokens, totalMs: res.ms };
  if (pin) c.idSlot = spec.agent === 'narrator' ? pin.narrator : pin.agents;
  if (res.ttftMs !== undefined) c.firstTokenMs = res.ttftMs;
  const processed = res.prompt?.processed;
  const cached = res.prompt?.cached;
  const total = res.usage?.inputTotal ?? (processed !== undefined && cached !== undefined ? processed + cached : undefined);
  if (total !== undefined) c.promptTokens = total;
  if (processed !== undefined) c.processed = processed;
  if (cached !== undefined) c.cached = cached;
  return c;
}

function summarize(rounds: readonly BenchRound[]): Pick<BenchResult, 'median' | 'verdict' | 'why'> {
  const per = (f: (c: BenchCall) => number | undefined): (number | null)[] =>
    [0, 1, 2].map((i) => median(rounds.map((r) => (r.calls[i] ? f(r.calls[i]!) : undefined)).filter((v): v is number => v !== undefined)));
  const known = rounds.filter((r) => r.ratio !== undefined);
  const med = { firstTokenMs: per((c) => c.firstTokenMs), totalMs: per((c) => c.totalMs), ratio: median(known.map((r) => r.ratio!)) };
  if (known.length === 0) {
    const why = rounds.find((r) => r.why !== undefined)?.why ?? 'no round finished';
    return { median: med, verdict: 'unknown', why };
  }
  const failed = known.filter((r) => r.verdict === 'fail');
  if (failed.length > 0) {
    const list = failed.map((r) => `round ${r.round} ${fmtRatio(r.ratio!)}`).join(', ');
    return { median: med, verdict: 'fail', why: `call 3 reprocessed more than ${RATIO_LIMIT}× its new tokens (${list}): the narrator's cache did not survive the agent call` };
  }
  const skipped = rounds.length - known.length;
  return {
    median: med,
    verdict: 'pass',
    why: `call 3 processed at most ${RATIO_LIMIT}× its new tokens in ${skipped > 0 ? `every round that reported counts (${known.length} of ${rounds.length})` : 'every round'}`,
  };
}

/**
 * `rp-core bench ttft`: the call count first, then the server info and pinning verdict, then the
 * rounds. Exit 0 when every round passed or the ratio is unknown, 1 on a FAIL, 3 when a call failed.
 */
export async function cmdBench(a: BenchArgs): Promise<number> {
  const { rt, io } = a;
  const rounds = bounded(a.rounds, 'rounds', LIMITS.rounds, BENCH_DEFAULTS.rounds);
  const sizes = {
    promptTokens: bounded(a.promptTokens, 'prompt-tokens', LIMITS.promptTokens, BENCH_DEFAULTS.promptTokens),
    tailTokens: bounded(a.tailTokens, 'tail-tokens', LIMITS.tailTokens, BENCH_DEFAULTS.tailTokens),
    agentTokens: bounded(a.agentTokens, 'agent-tokens', LIMITS.agentTokens, BENCH_DEFAULTS.agentTokens),
    agentShared: sharedOf(a.agentShared),
  };
  const mode = pinModeOf(a.pin);
  const t = targetOf(rt, a.target);
  const problem = connectionProblem(rt, t.conn);
  if (problem) throw new UsageError(problem, 'bench');
  const conn = rt.connections[t.conn]!;
  const caps = connectionCaps(conn, t.model);
  if (caps === null) throw new UsageError(`the caps of ${t.conn}:${t.model} cannot be resolved`, 'bench');
  const window = caps.contextLength;
  const need = Math.max(sizes.promptTokens + sizes.tailTokens, sizes.agentTokens) + TEMPLATE_SLACK + BENCH_MAX_TOKENS;
  if (window !== undefined && window > 0 && need > window) {
    throw new UsageError(`the prompts (about ${need} tokens with the reply) do not fit ${t.conn}:${t.model}'s window of ${window} tokens; lower --prompt-tokens`, 'bench');
  }

  const planned = rounds * CALLS_PER_ROUND;
  const head = `bench ttft: ${planned} real calls to ${t.conn}:${t.model} (${rounds} round${rounds === 1 ? '' : 's'} of narrator P, filing A, narrator P+T; at most ${BENCH_MAX_TOKENS} output tokens each)`;
  // Before anything reaches the server: what the run will cost.
  if (a.json) io.err.write(`rp-core: ${head}\n`);
  else io.out.write(`${head}\n`);

  const doFetch = a.fetch ?? fetch;
  let serverInfo: ServerInfo;
  if (a.serverInfo === 'off') serverInfo = { kind: 'unknown', reason: 'not read (RP_CORE_SERVER_INFO=off)' };
  else if (conn.baseUrl === undefined) serverInfo = { kind: 'unknown', reason: 'no base URL' };
  else {
    const key = await keyOf(conn);
    serverInfo = await readServerInfo(conn.baseUrl, { fetch: doFetch, key, ...(conn.dialect ? { dialect: conn.dialect } : {}), ...(a.serverInfoMs ?? {}) });
  }
  // auto: the engine's own judgement (slot_pin, a hand-set id_slot in extra_body, then D-211's rule).
  const verdict: PinVerdict =
    mode === 'on'
      ? { pin: { ...SLOT_PIN }, why: '--pin on' }
      : mode === 'off'
        ? { pin: null, why: '--pin off' }
        : slotPinOf(caps, serverInfo, Math.max(1, Math.floor(caps.maxInFlight)));
  const pin = { ...verdict, mode };
  // null, not absent: the engine's own pinning rule must not add a slot the verdict left out.
  const callCaps: ModelCaps = { ...caps, slotPin: verdict.pin ? { ...verdict.pin } : null };

  if (!a.json) {
    io.out.write(`server info: ${serverInfoLine(serverInfo)}\n`);
    io.out.write(`${pinLine(verdict)}\n`);
    io.out.write(`prompts: P ${group(sizes.promptTokens)} tokens, A ${group(sizes.agentTokens)} (${sizes.agentShared} % of it P's start), T ${group(sizes.tailTokens)} (o200k estimate; synthetic words, seeded${a.salt ? ', salted per run' : ''})\n`);
  }

  const sched = createScheduler();
  const timeouts = timeoutsFor(conn);
  const redact = redactor(rt);
  const done: BenchRound[] = [];
  let error: BenchResult['error'];

  outer: for (let r = 1; r <= rounds; r++) {
    const specs = roundPrompts(r, sizes, a.salt ?? '');
    const calls: BenchCall[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const n = (i + 1) as 1 | 2 | 3;
      const callKey = `bench_r${r}_c${n}`;
      const res = await streamCall({
        conn,
        model: t.model,
        caps: callCaps,
        messages: spec.messages,
        maxTokens: BENCH_MAX_TOKENS,
        samplers: { temperature: 0 },
        callKey,
        agent: spec.agent,
        turnSignal: new AbortController().signal,
        sched,
        fetch: doFetch,
        timeouts,
        timers: realTimers,
        clock: a.clock,
        onText: () => {},
        onReasoning: () => {},
      });
      if (res.error || res.stopped) {
        const message = res.error ? redact(res.error.message) : 'the call was stopped';
        error = { round: r, call: n, code: res.error?.code ?? 'stopped', message };
        if (res.error) rt.debug?.(redact(debugLine({ callKey, model: `${t.conn}:${t.model}`, error: res.error })));
        if (calls.length > 0) {
          const partial: BenchRound = { round: r, calls, verdict: 'unknown', why: 'the round did not finish' };
          done.push(partial);
          if (!a.json) io.out.write(renderRound(partial));
        }
        break outer;
      }
      calls.push(callOf(res, spec, n, verdict.pin));
    }
    const round: BenchRound = { round: r, calls, ...judgeRound(calls) };
    done.push(round);
    if (!a.json) io.out.write(renderRound(round));
  }

  const finished = done.filter((r) => r.calls.length === CALLS_PER_ROUND);
  const summary = summarize(finished);
  const result: BenchResult = {
    connection: t.conn,
    model: t.model,
    ...(conn.baseUrl !== undefined ? { baseUrl: conn.baseUrl } : {}),
    plannedCalls: planned,
    sizes,
    serverInfo,
    pin,
    rounds: done,
    median: summary.median,
    limit: RATIO_LIMIT,
    verdict: summary.verdict,
    why: summary.why,
    ...(error ? { error } : {}),
  };

  if (a.json) io.out.write(`${JSON.stringify(result)}\n`);
  else io.out.write(renderSummary(result));
  if (error) {
    io.err.write(`rp-core: bench ttft stopped: round ${error.round}, call ${error.call} failed: ${error.code}: ${error.message}\n`);
    return EXIT.failed;
  }
  return result.verdict === 'fail' ? EXIT.error : EXIT.done;
}

// ---- text output ------------------------------------------------------------------------------------

/** 3412 → "3 412", as /trace groups thousands. */
export function group(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

const secs = (ms: number | undefined | null): string => (ms === undefined || ms === null ? '?' : `${(ms / 1000).toFixed(2)} s`);
const num = (n: number | undefined): string => (n === undefined ? '?' : group(n));
const fmtRatio = (r: number): string => r.toFixed(2);

const HEAD = ['#', 'agent', 'prompt', 'first token', 'total', 'prompt tok', 'processed', 'cached'] as const;
const RIGHT = new Set([3, 4, 5, 6, 7]);

function table(rows: string[][]): string[] {
  const widths = HEAD.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => `  ${r.map((cell, i) => (RIGHT.has(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join('  ').trimEnd()}`);
}

export function renderRound(r: BenchRound): string {
  const rows: string[][] = [[...HEAD]];
  for (const c of r.calls) {
    rows.push([String(c.call), c.agent, c.prompt, secs(c.firstTokenMs), secs(c.totalMs), num(c.promptTokens), num(c.processed), num(c.cached)]);
  }
  const out = [`round ${r.round}`, ...table(rows)];
  if (r.ratio !== undefined && r.newTokens !== undefined) {
    const processed = r.calls[2]?.processed ?? 0;
    out.push(`  ratio ${fmtRatio(r.ratio)} (${group(processed)} processed / ${group(r.newTokens)} new): ${r.verdict === 'pass' ? 'PASS' : 'FAIL'}`);
  } else {
    out.push(`  ratio unknown: ${r.why ?? 'no counts'}`);
  }
  return `${out.join('\n')}\n`;
}

export function renderSummary(b: BenchResult): string {
  const labels: PromptLabel[] = ['P', 'A', 'P+T'];
  const out: string[] = [''];
  if (b.rounds.some((r) => r.calls.length === CALLS_PER_ROUND)) {
    out.push(`median first token: ${labels.map((l, i) => `${l} ${secs(b.median.firstTokenMs[i])}`).join(' · ')}`);
    out.push(`median total:       ${labels.map((l, i) => `${l} ${secs(b.median.totalMs[i])}`).join(' · ')}`);
  }
  if (b.verdict === 'unknown') out.push(`ratio unknown: ${b.why}`);
  else {
    out.push(`median ratio ${fmtRatio(b.median.ratio ?? 0)} (limit ${RATIO_LIMIT})`);
    out.push(`${b.verdict === 'pass' ? 'PASS' : 'FAIL'}: ${b.why}`);
    if (b.verdict === 'fail') out.push(hintFor(b));
  }
  return `${out.join('\n')}\n`;
}

/** What to try after a FAIL, by what the server is. */
function hintFor(b: BenchResult): string {
  if (b.serverInfo.kind === 'llama.cpp') {
    return b.pin.pin
      ? 'try: llama-server -np 2 --no-kv-unified (with -np auto the KV is unified and the idle slot is moved out)'
      : 'try: llama-server -np 2 --no-kv-unified with slot pinning, or -np 1 with --cache-ram';
  }
  return 'see the user guide, "Local servers: speed and caching"';
}
