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

/** A failure whose raw server text --debug would show (not our own key_unavailable / timeout sentences). */
export function hasServerWords(ev: { category: string; code: string }): boolean {
  return PROVIDER_CATEGORIES.has(ev.category) && ev.code !== 'key_unavailable' && ev.code !== 'timeout';
}

/** A human line (for stderr) about a non-text event, or null when there is nothing to say. */
export function describeEvent(ev: Event): string | null {
  switch (ev.type) {
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
 * notices, recoveries, retries and the ending go to stderr. With `debug`, failures and retries are
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
        default: {
          const line = describeEvent(ev);
          if (line) say(line);
        }
      }
    },
    finish: endLine,
  };
}
