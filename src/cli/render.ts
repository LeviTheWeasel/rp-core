// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Plain-text rendering for the CLI (ARCHITECTURE.md §19.2 cli/render.ts). M1a needs three things:
// the streamed answer of a one-shot `send` (text to stdout, everything else to stderr), the
// active path for `show`, and the `sessions` table. Pure string building plus a small stateful
// turn renderer; the REPL's italics, folded reasoning and status line arrive in M1b.

import type { Event } from '../protocol/events.ts';
import type { SessionHeader } from '../session/entries.ts';
import type { MessageView, PathView } from '../session/view.ts';
import type { Io } from './io.ts';

/** The text blocks of a message, joined (reasoning and tool blocks are not answer text). */
export function messageText(m: Pick<MessageView, 'blocks'>): string {
  let s = '';
  for (const b of m.blocks) if (b.k === 'text') s += b.text;
  return s;
}

/** Bracketed state markers for a message: finish reasons other than a clean end, hidden, edited. */
export function markers(m: MessageView): string[] {
  const out: string[] = [];
  const finish = m.gen?.finish;
  if (finish && finish !== 'end') out.push(`[${finish}]`);
  if (m.hidden) out.push('[hidden]');
  if (m.edited) out.push('[edited]');
  if (m.blocks.some((b) => b.k === 'reasoning')) out.push('[reasoning]');
  return out;
}

/** One message's heading: role, id, its place among siblings, markers. */
export function messageHeading(m: MessageView): string {
  const parts = [m.role, m.id];
  if (m.gen?.kind === 'greeting') parts.push(`greeting ${m.swipe.index + 1}/${m.swipe.count}`);
  // Model answers always show their swipe position (the thing `send --kind swipe` changes); a user
  // message only when it has siblings (a rewind sent something else there).
  else if (m.role === 'assistant' || m.swipe.count > 1) parts.push(`swipe ${m.swipe.index + 1}/${m.swipe.count}`);
  parts.push(...markers(m));
  return parts.join(' · ');
}

const indent = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n');

/** `show`: the active path, root to head. */
export function renderPath(view: PathView, header: Pick<SessionHeader, 'id' | 'title'>): string {
  const lines: string[] = [];
  lines.push(`${header.title ?? '(untitled)'} · ${header.id} · version ${view.version}`);
  if (view.path.length === 0) lines.push('(no messages)');
  for (const m of view.path) {
    lines.push('');
    lines.push(messageHeading(m));
    const text = messageText(m);
    lines.push(text.trim() === '' ? '  (no text)' : indent(text));
  }
  if (view.tails.length > 0) {
    lines.push('');
    const n = view.tails.length;
    lines.push(`(${n} other branch${n === 1 ? '' : 'es'} off this path)`);
  }
  return `${lines.join('\n')}\n`;
}

/** `sessions`: one row per session, newest first (the order listSessions gives). */
export function renderSessions(rows: readonly { id: string; title?: string; updated: string }[]): string {
  if (rows.length === 0) return '';
  return rows.map((r) => `${r.id}  ${r.updated}  ${r.title ?? ''}`.trimEnd()).join('\n') + '\n';
}

/**
 * An event with its free-text messages (failed, notice, recovered draft excluded) passed through
 * `redact` (scrub of the known secrets, §13): a last line of defence on top of messages that are
 * already fixed sentences at their source. Other events are returned as they are.
 */
export function redactEvent(ev: Event, redact: ((text: string) => string) | undefined): Event {
  if (!redact) return ev;
  if (ev.type === 'failed' || ev.type === 'notice') {
    const message = redact(ev.message);
    return message === ev.message ? ev : { ...ev, message };
  }
  return ev;
}

/** Failure categories that come from a provider (the server's own words exist; --debug shows them). */
const PROVIDER_CATEGORIES: ReadonlySet<string> = new Set(['auth', 'request', 'rate', 'server', 'network', 'content']);

/** Failures rp-core words itself: no server said anything (the scripted and replay providers' own too). */
const OWN_WORDS: ReadonlySet<string> = new Set(['key_unavailable', 'timeout', 'script_exhausted', 'replay_mismatch', 'replay_aborted']);

/** A failure whose raw server text --debug would show (not our own key_unavailable / timeout / replay sentences). */
export function hasServerWords(ev: { category: string; code: string }): boolean {
  return PROVIDER_CATEGORIES.has(ev.category) && !OWN_WORDS.has(ev.code);
}

/**
 * The way out of a model_not_found failure, in fixed words naming the session's own narrator binding
 * (never the server's words, §13): where the server's model list is and how to switch. A session
 * keeps its own copy of [roles], so editing config.toml does not help it. With `sessionId` (send),
 * /model is reached through `rp-core chat`. With `failed` (TurnOutcome.route) naming another model
 * than the narrator's, the failed call was the fallback's: the hint names that one instead.
 */
export function modelNotFoundHint(narrator: { conn: string; model: string }, sessionId?: string, failed?: string): string {
  const { conn, model } = narrator;
  // The call that failed was the fallback's (TurnOutcome.route): the narrator's own model is not the one missing.
  if (failed !== undefined && failed !== `${conn}:${model}` && failed.includes(':')) {
    const fconn = failed.slice(0, failed.indexOf(':'));
    return `the fallback ${failed} is the model the server does not know (the narrator ${conn}:${model} failed first): rp-core models ${fconn} lists what that server has; [roles] narrator_fallback in config.toml names the fallback of new sessions`;
  }
  const how = sessionId === undefined ? `/model narrator ${conn}:<model> switches this chat` : `/model narrator ${conn}:<model> in rp-core chat ${sessionId} switches the session`;
  return `the narrator is ${conn}:${model}: rp-core models ${conn} lists what the server has; ${how} (config.toml [roles] only sets new sessions)`;
}

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const scalarText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(scalarText).join(',');
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/**
 * A tool call's arguments in a few words (M3): a string as it is; an object's first member, when it
 * is a string, in quotes and the others as key=value (search_history {query, before} reads
 * `"caravan" before=40`, read_lore {ids} reads `ids=L1,L3`). At most `max` characters.
 */
export function toolArgsText(args: unknown, max = 60): string {
  if (args === undefined || args === null) return '';
  if (typeof args !== 'object' || Array.isArray(args)) return oneLine(scalarText(args), max);
  const parts = Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v], i) => (i === 0 && typeof v === 'string' ? JSON.stringify(v) : `${k}=${scalarText(v)}`));
  return oneLine(parts.join(' '), max);
}

/**
 * The line of a finished tool call (§12.4 "Тулы — по одной приглушённой строке"):
 * `⋯ search_history "caravan" → 2 hits`. null for the 'start' phase (the call is not done yet).
 */
export function toolLine(ev: Extract<Event, { type: 'tool' }>): string | null {
  if (ev.phase !== 'done') return null;
  const args = toolArgsText(ev.args);
  const result = ev.summary !== undefined && ev.summary !== '' ? oneLine(ev.summary, 80) : ev.ok === false ? 'failed' : 'ok';
  return `⋯ ${ev.name}${args ? ` ${args}` : ''} → ${result}`;
}

/** A human line (for stderr) about a non-text event, or null when there is nothing to say. */
export function describeEvent(ev: Event): string | null {
  switch (ev.type) {
    case 'tool':
      return toolLine(ev);
    case 'notice':
      return `${ev.level}: ${ev.message} (${ev.code})`;
    case 'recovered':
      if (ev.outcome === 'interrupted') return `recovered an interrupted turn (${ev.turnId}): its partial answer was saved, marked [interrupted]`;
      if (ev.draft !== undefined && ev.draft !== '') {
        const why = ev.outcome === 'dropped' ? 'the message it answered is hidden' : 'the reply it continued has changed';
        return `recovered an interrupted turn (${ev.turnId}): ${why}, so its partial answer was not saved:\n${ev.draft}`;
      }
      return `recovered an interrupted turn (${ev.turnId}): nothing worth keeping, it was closed`;
    case 'retry':
      return `retrying in ${ev.delayMs} ms (${ev.code}${ev.status !== undefined ? `, HTTP ${ev.status}` : ''})`;
    case 'stopped':
      return ev.message ? `[stopped] the partial answer was kept (${ev.message.id})` : '[stopped] nothing had arrived; nothing was kept';
    case 'failed':
      return `the answer failed (${ev.category}/${ev.code}): ${ev.message}`;
    case 'conflict':
      return 'the session changed during the turn; the answer was not committed';
    default:
      return null;
  }
}

export interface TurnRenderer {
  push(ev: Event): void;
  /** After the last event: end the answer line. */
  finish(): void;
}

/**
 * Text mode for `send`: deltas go to stdout as they arrive and the answer ends with a newline;
 * notices, recoveries, retries, tool calls (M3) and the ending go to stderr. With `debug`, failures and retries are
 * also printed raw (as JSON) to stderr (the server's own words come through the engine's debug tap,
 * runtime.ts). Every message passes through `redact` when one is given.
 */
export function createTextRenderer(io: Io, opts: { debug: boolean; prefix?: string; redact?: (text: string) => string }): TurnRenderer {
  const prefix = opts.prefix ?? 'rp-core: ';
  let printed = '';
  let kept = false;

  const say = (line: string): void => io.err.write(`${prefix}${line}\n`);
  const endLine = (): void => {
    if (printed !== '' && !printed.endsWith('\n')) {
      io.out.write('\n');
      printed += '\n';
    }
  };

  return {
    push(raw: Event): void {
      const ev = redactEvent(raw, opts.redact);
      switch (ev.type) {
        case 'text':
          if (ev.delta !== '') {
            io.out.write(ev.delta);
            printed += ev.delta;
          }
          return;
        case 'changed':
          // A commit during the turn: with onError 'keep' a failure still leaves the answer saved.
          if (ev.change === 'msg' || ev.change === 'edit') kept = true;
          return;
        case 'done': {
          // Nothing streamed (a hook replaced it, or the provider sent it in one piece): print the
          // authoritative text so stdout always carries the answer.
          if (printed === '') {
            const text = messageText(ev.message);
            io.out.write(text);
            printed = text;
          }
          endLine();
          return;
        }
        case 'failed':
          endLine();
          if (opts.debug) io.err.write(`${JSON.stringify(ev)}\n`);
          say(describeEvent(ev)!);
          if (kept) say('the partial answer was kept, marked [interrupted]');
          if (!opts.debug && hasServerWords(ev)) say("hint: --debug prints the server's own words");
          return;
        case 'retry':
          if (opts.debug) io.err.write(`${JSON.stringify(ev)}\n`);
          say(describeEvent(ev)!);
          return;
        case 'stopped':
        case 'conflict':
          endLine();
          say(describeEvent(ev)!);
          return;
        case 'tool': {
          // M3: one line per finished call. stdout stays the answer alone, so a call between two
          // rounds starts its stderr line on a fresh line when the answer's line is still open.
          const line = toolLine(ev);
          if (line) io.err.write(`${printed !== '' && !printed.endsWith('\n') ? '\n' : ''}${prefix}${line}\n`);
          return;
        }
        default: {
          const line = describeEvent(ev);
          if (line) say(line);
        }
      }
    },
    finish: endLine,
  };
}
