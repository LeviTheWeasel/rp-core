// Ported from Bunraku:src/stage/provider/tool-loop.ts@702d8120 (the per-call handling of sendWithTools:
// SAFE_NAME and 'invalid_tool', the echo rebuilt from the parsed arguments, the result cap and its
// mark) and Bunraku:src/kit/loop/scheduler.ts@702d8120 (a read-only batch overlaps, results in call
// order); messages after RoleCall:apps/rc/src/lib/ai/narrator-engine/tool-executor.ts@fb8dc623e (which
// predates VAUDEVILLE's import commit 660a7d67a, so git credits its early lines to Chi alone).
// Copyright (C) 2026 Coneja-Chibi, Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Running one round's calls (ARCHITECTURE.md §9.1). All v1 tools read, so a round runs in parallel
// and the outcomes come back in call order; one tool's failure never touches another.
// CONTRACT FILE (M3): signatures are fixed; the tools-run agent implements the body.
//
// Port notes. Kept from Bunraku: names outside SAFE_NAME echo as 'invalid_tool'; refused calls are
// not run and echo '{}'; a thrown tool becomes an error result and the round goes on; a long result
// is cut with `[cut: …]`. Changed: the calls run in parallel (Bunraku ran them one by one, the Kit
// scheduler overlapped reads); arguments go through the D-56 chain (tools/args.ts) instead of a
// strict JSON.parse; the unknown-tool message keeps the name the model wrote (Bunraku showed
// 'invalid_tool') and lists the tools sorted; a stray unsafe name never reaches a real tool named
// 'invalid_tool'; the mark sits inside the limit; the cut never splits a surrogate pair; the limit
// is also the result's share of the round's room, and the tool learns it before it runs (ctx.limit)
// so its paging lines fit; identical calls of a round run once (RoleCall btw dedupe); Stop yields
// 'cancelled' outcomes instead of throwing; ids are the loop's business.

import { SAFE_NAME } from '../providers/wire.ts';
import { canonicalJson, parseToolArgs } from './args.ts';
import { DEFAULT_TOOL_OUTPUT, type Tool, type ToolCall, type ToolCallOutcome, type ToolCtx, type ToolOutput } from './types.ts';

/** The mark a cut result ends with (Bunraku tool-loop.ts). */
export function cutMark(limit: number): string {
  return `\n[cut: the result was longer than ${limit} characters]`;
}

/**
 * The whole result when its cap cannot even hold cutMark (the round's own text used up the tool
 * room, C6): a cut result always says it was cut, never arrives empty. It goes over the cap by at
 * most its own length; the loop charges it to the room and takes what the room lacks from the next
 * round's max_tokens (narrate.ts roundMaxTokens), and that round is the final one.
 */
export const NO_ROOM_MARK = '[cut: no room was left for this result]';

export interface RunToolsInput {
  calls: readonly ToolCall[];
  /** The turn's dispatch table: exactly the tools the request offered. */
  tools: ReadonlyMap<string, Tool>;
  ctx: ToolCtx;
  /** Characters the whole round's results may take (the tool room left); each result is cut to its share. */
  roomChars: number;
}

/** §9.1: a failed tool's message to the model is at most this long. */
const FAILURE_MAX = 300;
/** The name of an unknown tool quoted back to the model is clipped to this. */
const UNKNOWN_NAME_MAX = 64;

/** One line, control characters gone, at most `max` characters. */
function oneLine(s: string, max: number): string {
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The first `n` UTF-16 units of s, one fewer when that would split a surrogate pair. */
function headOf(s: string, n: number): string {
  if (n <= 0) return '';
  if (n >= s.length) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/** The text cut to `limit` characters with the mark inside the limit (NO_ROOM_MARK alone when even the mark does not fit). */
function capText(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  const mark = cutMark(limit);
  if (mark.length > limit) return { text: NO_ROOM_MARK, cut: true };
  return { text: headOf(text, limit - mark.length) + mark, cut: true };
}

/** What a run settled with, before the cap. */
interface Settled {
  out: ToolOutput;
  refused?: 'cancelled';
  ms: number;
}

/** A call's plan: refused up front, or a run shared by every identical call of the round. */
type Plan =
  | { kind: 'refused'; echoName: string; echoArgs: string; text: string; summary: string; refused: 'unknown_tool' | 'bad_args'; parsed?: Record<string, unknown>; repaired?: string[] }
  | { kind: 'run'; echoName: string; echoArgs: string; run: number; parsed: Record<string, unknown>; repaired?: string[] };

/**
 * Run one round's calls:
 * - unknown name → error result `Unknown tool "<name>". The tools you can call: <sorted names>.`
 *   (refused 'unknown_tool'); a name that is not SAFE_NAME echoes as 'invalid_tool';
 * - arguments through parseToolArgs (D-56); failure → its error as the result, the tool not run
 *   (refused 'bad_args'), echoArgs '{}';
 * - the same tool with the same canonical arguments twice in one round runs once; the later calls
 *   get the same result;
 * - the rest run in parallel with ctx.signal; a tool that throws gets `Tool <name> failed: <message>`
 *   (≤ 300 chars, error: true); an abort gives 'cancelled' (refused 'cancelled', error: true);
 * - the room is shared BEFORE the tools run: refused calls' texts are reserved first (each at most
 *   DEFAULT_TOOL_OUTPUT, the room split evenly over them), then what is left goes one share per
 *   call (a run answering N identical calls takes N shares: its result goes on the wire N times),
 *   water-filled over the runs' own maxOutput (waterFill: a run capped below its share leaves the
 *   rest to the others); ctx.limit is the run's share, so a tool that writes paging lines can size
 *   itself to fit and keep them;
 * - after the runs, each result is cut (a backstop for a tool that ignores its limit) to
 *   min(its maxOutput, its limit + a per-call share of what the runs before it left unused), runs in
 *   call order after the refused texts, every copy charged: that cap is never below the run's limit,
 *   so a tool that keeps to its limit is never cut; the cut ends with cutMark(cap) (the mark is
 *   inside the cap);
 * - outcomes in call order; ms per call from the injected clock (ctx has none: use the `clock` arg).
 *
 * Details: an unknown tool's arguments are still read (no schema) so its echo shows them; a refused
 * call takes 0 ms; the signal already aborted means nothing runs; on abort the round does not wait
 * for a tool that ignores its signal. A cap below the mark's length gives NO_ROOM_MARK alone (over the
 * cap by at most its length: the round's own text used the room up, and the loop absorbs it).
 */
export async function runTools(input: RunToolsInput, clock: () => Date): Promise<ToolCallOutcome[]> {
  const { calls, tools, ctx } = input;
  const available = [...tools.keys()].sort();

  // Plan every call: refuse, or join a run (one per distinct tool + canonical arguments).
  const runs: { tool: Tool; args: Record<string, unknown> }[] = [];
  const runOf = new Map<string, number>();
  const plans: Plan[] = calls.map((call): Plan => {
    const safe = SAFE_NAME.test(call.name);
    const echoName = safe ? call.name : 'invalid_tool';
    const tool = safe ? tools.get(call.name) : undefined;
    if (tool === undefined) {
      const loose = parseToolArgs(call.args, { type: 'object' }, echoName);
      const shown = JSON.stringify(oneLine(call.name, UNKNOWN_NAME_MAX));
      return {
        kind: 'refused',
        echoName,
        echoArgs: loose.ok ? canonicalJson(loose.value) : '{}',
        text: `Unknown tool ${shown}. The tools you can call: ${available.length > 0 ? available.join(', ') : 'none'}.`,
        summary: 'unknown tool',
        refused: 'unknown_tool',
        ...(loose.ok ? { parsed: loose.value } : {}),
      };
    }
    const parsed = parseToolArgs(call.args, tool.schema, tool.name);
    const repaired = parsed.repaired.length > 0 ? { repaired: parsed.repaired } : {};
    if (!parsed.ok) {
      return { kind: 'refused', echoName, echoArgs: '{}', text: parsed.error, summary: 'bad arguments', refused: 'bad_args', ...repaired };
    }
    const echoArgs = canonicalJson(parsed.value);
    const key = `${tool.name}\u0000${echoArgs}`;
    let run = runOf.get(key);
    if (run === undefined) {
      run = runs.push({ tool, args: parsed.value }) - 1;
      runOf.set(key, run);
    }
    return { kind: 'run', echoName, echoArgs, run, parsed: parsed.value, ...repaired };
  });

  // Refused calls' texts first: they are short (an error line), and the model needs every one.
  let left = Math.max(0, Math.floor(input.roomChars));
  const refusedCount = plans.filter((p) => p.kind === 'refused').length;
  let refusedSeen = 0;
  const refusedText = new Map<number, { text: string; cut: boolean }>();
  plans.forEach((plan, i) => {
    if (plan.kind !== 'refused') return;
    const share = Math.floor(left / Math.max(1, refusedCount - refusedSeen));
    const r = capText(plan.text, Math.max(0, Math.min(DEFAULT_TOOL_OUTPUT, share)));
    left = Math.max(0, left - r.text.length);
    refusedSeen++;
    refusedText.set(i, r);
  });

  // Each distinct run's limit, known before it runs. Every call of a run gets the run's result, so a
  // run takes one share per call (`copies`); the shares are water-filled over the runs' own maxOutput:
  // a run capped below its share leaves the rest to the others.
  const own = runs.map((r) => Math.max(0, r.tool.maxOutput?.(ctx) ?? DEFAULT_TOOL_OUTPUT));
  const copies = runs.map(() => 0);
  for (const p of plans) if (p.kind === 'run') copies[p.run]!++;
  const limits = waterFill(left, own, copies);
  const settled = await Promise.all(runs.map((r, i) => runOne(r.tool, r.args, { ...ctx, limit: limits[i]! }, clock)));

  // The backstop, in call order (a run at its first call): its limit plus an even share (per call) of
  // what the runs before it left unused, capped by its maxOutput; it is never below the run's limit,
  // so a tool that keeps to its limit is never cut. Every copy of a result is charged.
  let reservedAfter = limits.reduce((n, l, i) => n + l * copies[i]!, 0);
  let callsAfter = copies.reduce((n, c) => n + c, 0);
  const capped = new Map<number, { text: string; cut: boolean }>();
  const cap = (text: string, run: number): { text: string; cut: boolean } => {
    const m = copies[run]!;
    reservedAfter -= limits[run]! * m;
    const spare = Math.max(0, left - reservedAfter - limits[run]! * m);
    const r = capText(text, Math.min(own[run]!, limits[run]! + Math.floor(spare / Math.max(1, callsAfter))));
    callsAfter -= m;
    left = Math.max(0, left - r.text.length * m);
    return r;
  };

  return plans.map((plan, i): ToolCallOutcome => {
    const call = calls[i]!;
    const base = {
      call,
      echoName: plan.echoName,
      echoArgs: plan.echoArgs,
      ...(plan.repaired !== undefined ? { repaired: plan.repaired } : {}),
      ...(plan.parsed !== undefined ? { parsed: plan.parsed } : {}),
    };
    if (plan.kind === 'refused') {
      const r = refusedText.get(i)!;
      return { ...base, ok: false, text: r.text, summary: plan.summary, refused: plan.refused, ...(r.cut ? { cut: true } : {}), ms: 0 };
    }
    const s = settled[plan.run]!;
    let r = capped.get(plan.run);
    if (r === undefined) {
      r = cap(s.out.text, plan.run);
      capped.set(plan.run, r);
    }
    return {
      ...base,
      ok: s.refused === undefined && s.out.error !== true,
      text: r.text,
      summary: s.out.summary,
      ...(s.refused !== undefined ? { refused: s.refused } : {}),
      ...(r.cut ? { cut: true } : {}),
      ms: s.ms,
    };
  });
}

/**
 * Pre-run limits: `room` shared over runs with `copies[i]` calls each (one share per call), each run
 * at most `caps[i]`; a run capped below the share gives the rest to the others (water-filling). The
 * sum of limit × copies never exceeds the room.
 */
export function waterFill(room: number, caps: readonly number[], copies: readonly number[]): number[] {
  const limits = caps.map(() => 0);
  let left = Math.max(0, Math.floor(room));
  let open = caps.map((_, i) => i).filter((i) => copies[i]! > 0);
  while (open.length > 0) {
    const share = Math.floor(left / open.reduce((n, i) => n + copies[i]!, 0));
    const low = open.filter((i) => caps[i]! <= share);
    if (low.length === 0) {
      for (const i of open) limits[i] = share;
      break;
    }
    for (const i of low) {
      limits[i] = caps[i]!;
      left -= caps[i]! * copies[i]!;
    }
    open = open.filter((i) => caps[i]! > share);
  }
  return limits;
}

const CANCELLED: ToolOutput = { text: 'cancelled', summary: 'cancelled', error: true };

/** One tool run: never rejects; Stop wins over whatever the tool does. */
async function runOne(tool: Tool, args: Record<string, unknown>, ctx: ToolCtx, clock: () => Date): Promise<Settled> {
  const { signal } = ctx;
  if (signal.aborted) return { out: CANCELLED, refused: 'cancelled', ms: 0 };
  const started = clock().getTime();
  const done = (out: ToolOutput, refused?: 'cancelled'): Settled => ({
    out,
    ...(refused !== undefined ? { refused } : {}),
    ms: Math.max(0, clock().getTime() - started),
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    onAbort = () => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([tool.run(args, ctx).then((out) => ({ out })), aborted]);
    if (result === 'aborted' || signal.aborted) return done(CANCELLED, 'cancelled');
    const out = result.out;
    if (out === null || typeof out !== 'object' || typeof out.text !== 'string') {
      return done(failed(tool.name, 'the tool returned no text'));
    }
    return done({ text: out.text, summary: typeof out.summary === 'string' ? out.summary : '', ...(out.error === true ? { error: true } : {}) });
  } catch (e) {
    if (signal.aborted) return done(CANCELLED, 'cancelled');
    return done(failed(tool.name, e instanceof Error && e.message ? e.message : String(e)));
  } finally {
    signal.removeEventListener('abort', onAbort!);
  }
}

/** §9.1: `Tool <name> failed: <message>`, one line, at most FAILURE_MAX characters. */
function failed(name: string, message: string): ToolOutput {
  return { text: oneLine(`Tool ${name} failed: ${message}`, FAILURE_MAX), summary: 'failed', error: true };
}
