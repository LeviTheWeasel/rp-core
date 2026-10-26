// Ported from Bunraku:src/core/lore/engine/timers.ts@702d8120 (derived timers: a pure function over
// the fire history instead of stored state).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lore timers: sticky, cooldown, delay (ARCHITECTURE.md §10.3, §5.10). Derived from the fires on
// the active path, never kept in process memory: a swipe, a rewind or a fork sees exactly the
// timers of its own path. `messagesAgo` counts path messages, as ST counts chat messages (not
// replies, as Bunraku does), and only the visible ones: ST runs its timed effects on the chat it
// scans, built from coreChat, which drops hidden (is_system) messages (script.js coreChat,
// world-info.js WorldInfoTimedEffects). A message hidden later shifts every later position, as a
// hidden message shortens ST's chat.
// Sources (port): Bunraku src/core/lore/engine/timers.ts; SillyTavern world-info.js TimedEffects
// (the sticky/cooldown/delay arithmetic, behaviour reference).
// CONTRACT FILE: signatures are fixed; the lore agent implements the bodies.
//
// The arithmetic is SillyTavern's (world-info.js WorldInfoTimedEffects, world-info-scan-core.js
// getTimedEffectWindow), with L = the chat length a fresh fire happened at and C = the chat length
// of the turn being built (C > L always: a fire on the path sits at or before the turn's message):
// - sticky S: the window [L, L+S) — the entry fires again while C < L + S;
// - cooldown D: without sticky it blocks while C < L + D. After a sticky window ST re-arms it when
//   it sees the window ended, at the first scan whose chat length is at or after L + S, as
//   [that scan, that scan + D): the scans on the path (pathScans) give that point, or C itself;
// - delay N: blocked while C < N, whatever the history;
// - a sticky reinjection (why 'sticky') starts no window: ST only sets an effect that is not set yet.
// A scan's chat length: the visible path messages before the answer (the chat it was written
// after), a continue's + 1 (ST's chat for a continue holds the continued message). A continue's fires
// are stamped so, which also reproduces ST's "chat not advanced" drop for a second continue of the
// same answer.
// Not ported: Bunraku's per-trigger frequency, activeLastTurn/everFired (side effects), its
// reply-based messagesAgo and its "messagesAgo <= sticky" window.

import type { PathView } from '../session/view.ts';

/** One fire from a past answer's trace. */
export interface PastFire {
  /** Lore source key (LoreSource.key) and entry id. */
  book: string;
  id: string;
  /** Trace['lore']['fired'][number]['why']: 'sticky' marks a reinjection, which starts no new window. */
  why: string;
  /**
   * Chat length when it fired: the visible (non-hidden) path messages before the message whose trace
   * holds it, + 1 for the fires of a continue edit.
   */
  at: number;
  /** The book's name then (Trace.loreNames), when the trace recorded it. */
  name?: string;
}

/** Path index of `upTo`; a message off the active path is a caller bug. */
function indexOf(view: PathView, upTo: string): number {
  const i = view.path.findIndex((m) => m.id === upTo);
  if (i < 0) throw new Error(`lore: message ${upTo} is not on the active path`);
  return i;
}

/**
 * For each path index up to `last`: how many visible (non-hidden) path messages come before it,
 * i.e. the chat length ST's scan sees when it writes that message. Hidden messages are not in ST's
 * chat (coreChat drops is_system), so they take no place.
 */
function visibleBefore(view: PathView, last: number): number[] {
  const out: number[] = [];
  let n = 0;
  for (let i = 0; i <= last; i++) {
    out.push(n);
    if (!(view.path[i] as PathView['path'][number]).hidden) n++;
  }
  return out;
}

/** The chat length after path message i: the visible messages before it, plus itself when visible. */
const visibleThrough = (view: PathView, before: readonly number[], i: number): number =>
  (before[i] as number) + ((view.path[i] as PathView['path'][number]).hidden ? 0 : 1);

/**
 * Every fire on the path up to and including `upTo`, oldest first (PathView.fires already holds a
 * message's own trace and its continue edits' traces, in seq order). A fire sits at the visible path
 * messages before its message; a continue's at the message's own place + 1 (the continued message
 * is in its chat): that is the chat length its scan ran at.
 */
export function pathFires(view: PathView, upTo: string): PastFire[] {
  const last = indexOf(view, upTo);
  const before = visibleBefore(view, last);
  const at = new Map<string, number>();
  for (let i = 0; i <= last; i++) at.set((view.path[i] as PathView['path'][number]).id, i);
  const out: PastFire[] = [];
  for (const f of view.fires) {
    const i = at.get(f.msgId);
    if (i === undefined) continue;
    const when = f.continued ? visibleThrough(view, before, i) : (before[i] as number);
    for (const x of f.fired) {
      const fire: PastFire = { book: x.book, id: x.id, why: x.why, at: when };
      const name = f.names && Object.hasOwn(f.names, x.book) ? f.names[x.book] : undefined;
      if (typeof name === 'string') fire.name = name;
      out.push(fire);
    }
  }
  // Already in path order; the stable sort only guards a hand-built view.
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The chat lengths of the lore scans on the path before the turn at `upTo`, ascending: every answer
 * (an assistant message that is not a greeting) at the visible messages before it, every continued
 * message at that + 1 (itself, when visible). ST re-arms the cooldown that follows a sticky window
 * at the first of them at or after the window's end (cooldownLeft).
 */
export function pathScans(view: PathView, upTo: string): number[] {
  const last = indexOf(view, upTo);
  const before = visibleBefore(view, last);
  const out = new Set<number>();
  for (let i = 0; i <= last; i++) {
    const m = view.path[i] as PathView['path'][number];
    if (m.role === 'assistant' && m.gen?.kind !== 'greeting') out.add(before[i] as number);
    if (view.continued?.has(m.id)) out.add(visibleThrough(view, before, i));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The chat length a turn at `upTo` sees: the visible (non-hidden) path messages up to and including
 * `upTo`, as ST's chat for the scan holds no hidden message.
 */
export function chatLengthAt(view: PathView, upTo: string): number {
  const last = indexOf(view, upTo);
  return visibleThrough(view, visibleBefore(view, last), last);
}

/** Timer state of every entry, derived once per lore run. Opaque to callers. */
export interface TimerState {
  readonly chatLength: number;
  /** Per entry key ('book\u0000id'): the newest fresh fire and whether a sticky reinjection followed. */
  readonly last: ReadonlyMap<string, { at: number; fresh: boolean }>;
  /**
   * pathScans() before this one, ascending. Undefined when the caller passed none: then every chat
   * length counts as a scan, and the cooldown after a sticky window starts exactly at its end.
   */
  readonly scans: readonly number[] | undefined;
}

/** The timer key of an entry; the same string as engine.ts entryKey(). */
function timerKey(book: string, id: string): string {
  return `${book}\u0000${id}`;
}

/**
 * `last[key].at` is the newest fresh fire; `fresh` stays true until a sticky reinjection follows it.
 * Fires at or after `chatLength` are ignored (the chat has not advanced past them: ST drops such
 * effects), as are reinjections with no fresh fire before them.
 */
export function timerState(fires: readonly PastFire[], chatLength: number, scans?: readonly number[]): TimerState {
  const last = new Map<string, { at: number; fresh: boolean }>();
  const ordered = [...fires].sort((a, b) => a.at - b.at);
  for (const f of ordered) {
    if (!(f.at < chatLength)) continue;
    const key = timerKey(f.book, f.id);
    if (f.why !== 'sticky') {
      last.set(key, { at: f.at, fresh: true });
    } else {
      const prev = last.get(key);
      if (prev) last.set(key, { at: prev.at, fresh: false });
    }
  }
  return { chatLength, last, scans: scans === undefined ? undefined : [...scans].sort((a, b) => a - b) };
}

const positive = (n: number | undefined): number => (n !== undefined && n > 0 ? n : 0);

/** Sticky window still open: the entry fires again without a key match (why 'sticky'). */
export function isSticky(t: TimerState, key: string, sticky: number | undefined): boolean {
  return stickyLeft(t, key, sticky) > 0;
}

/** Messages left in an open sticky window (0 = closed). Diagnostic for verdicts. */
export function stickyLeft(t: TimerState, key: string, sticky: number | undefined): number {
  const s = positive(sticky);
  const l = t.last.get(key);
  if (s === 0 || !l) return 0;
  return Math.max(0, l.at + s - t.chatLength);
}

/**
 * Messages of cooldown left (0 = not cooling down). Without sticky the cooldown runs from the fire;
 * after a sticky window it starts at the first scan at or after the window's end (ST's re-arm in
 * WorldInfoTimedEffects onEnded.sticky), the turn being built included.
 */
export function cooldownLeft(t: TimerState, key: string, sticky: number | undefined, cooldown: number | undefined): number {
  const d = positive(cooldown);
  const l = t.last.get(key);
  if (d === 0 || !l) return 0;
  const s = positive(sticky);
  let start = l.at;
  if (s > 0) {
    const ends = l.at + s;
    if (t.chatLength < ends) return 0; // still inside the sticky window
    start = t.scans === undefined ? ends : (t.scans.find((c) => c >= ends && c < t.chatLength) ?? t.chatLength);
  }
  const end = start + d;
  return t.chatLength >= start && t.chatLength < end ? end - t.chatLength : 0;
}

/** Delay: the entry may not fire before the chat has `delay` messages. Messages still to wait (0 = free). */
export function delayLeft(delay: number | undefined, chatLength: number): number {
  const d = positive(delay);
  return chatLength < d ? d - chatLength : 0;
}
