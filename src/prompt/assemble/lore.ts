// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Lore inside assemble (ARCHITECTURE.md §10.2, §10.3, §11): one lore run per request, then the
// values the preset's lore slots take and the texts assemble places around the author's note, at
// the top, at the bottom and before the chat. The engine itself is src/lore/*.
//
// SillyTavern behaviour mirrored here (SillyBunny public/scripts/world-info.js checkWorldInfo,
// openai.js formatWorldInfo, script.js, authors-note.js; facts only):
// - wi_format wraps only the before / after values (formatWorldInfo); a blank format is no format;
// - an outlet value is its entries joined with '\n', never wrapped (CUSTOM_WI_OUTLET);
// - example-message entries are example dialogue (parseMesExamples): each entry is its own chunk,
//   `<START>` implied, before-entries ahead of the card's examples and after-entries behind them;
//   ST unshifts the before-entries twice (checkWorldInfo, then script.js), so they run in DESCENDING
//   order (the lowest order nearest the card's examples), unlike every other place;
// - AN top / AN bottom wrap the author's note as `${top}\n${note}\n${bottom}` without the edge
//   newlines, at the note's depth and role, also when the note is empty: ST's default note place is
//   in-chat depth 4, role system (authors-note.js DEFAULT_DEPTH, getDefaultRole), interval 1;
// - the budget is a share of the prompt part of the window (checkWorldInfo, budget.ts loreBudget);
// - keys go through the macro engine before matching (normalizeWorldInfoKey with substituteParams),
//   so `{{char}}` / `{{user}}` keys work; here identity macros only, read-only (a key is data the
//   user typed, not a template that may set variables).

import type { Character, ChatRole, LoreBook, Persona, Preset } from '../../formats/native.ts';
import type { Notice } from '../../protocol/events.ts';
import {
  CARD_BOOK_KEY,
  DEFAULT_LORE_ORDER,
  entryKey,
  entryLabel,
  PERSONA_BOOK_KEY,
  runLore,
  type LoreHit,
  type LoreRunResult,
  type LoreSource,
} from '../../lore/engine.ts';
import { placeLore, type LorePlacement, type LoreSlotName } from '../../lore/place.ts';
import { scanMessages } from '../../lore/scan.ts';
import { chatLengthAt, pathFires, pathScans, type PastFire } from '../../lore/timers.ts';
import type { PathView } from '../../session/view.ts';
import { loreBookHash } from './hash.ts';
import { formatExamples, renderSlot, type SlotRef } from './slots.ts';

/** ST's author's note place when the session has none: in-chat, depth 4, system (authors-note.js). */
export const DEFAULT_NOTE_DEPTH = 4;
export const DEFAULT_NOTE_ROLE: ChatRole = 'system';

/** Regex failures named in one notice; the rest are counted. */
const MAX_REGEX_NAMED = 10;

/**
 * Which of the cast's own books another book stands in for. SillyTavern loads a world once by name:
 * the character's world is skipped when the same world is global, chat or persona lore, the
 * persona's when it is global or chat lore (world-info.js getCharacterLore / getPersonaLore). Here
 * a session book stands for ST's global and chat lore, and a book's `name` for the world's name, so
 * the card's embedded Eldoria is not read twice when the session also has the library's Eldoria.
 * Returns the key of the book that shadows each own book; a blank name shadows nothing.
 */
export function shadowedCastBooks(
  cast: { character: Character; persona?: Persona },
  lorebooks: readonly { key: string; book: LoreBook }[],
): { persona?: string; card?: string } {
  const name = (b: LoreBook): string => b.name.trim();
  const sessionWith = (n: string): string | undefined => (n === '' ? undefined : lorebooks.find((s) => name(s.book) === n)?.key);
  const out: { persona?: string; card?: string } = {};
  const persona = cast.persona?.book;
  const personaBy = persona ? sessionWith(name(persona)) : undefined;
  if (personaBy !== undefined) out.persona = personaBy;
  const card = cast.character.book;
  if (card) {
    const by = sessionWith(name(card)) ?? (persona && name(card) !== '' && name(persona) === name(card) ? PERSONA_BOOK_KEY : undefined);
    if (by !== undefined) out.card = by;
  }
  return out;
}

/**
 * Session books another session book of the same (trimmed, non-empty) name stands in for: the
 * later one in config order wins, as a world re-imported into SillyTavern under its name replaces
 * the old one (ST world names are unique). Returns shadowed key → the key read instead.
 */
export function shadowedSessionBooks(lorebooks: readonly { key: string; book: LoreBook }[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const s of lorebooks) {
    const n = s.book.name.trim();
    if (n !== '') last.set(n, s.key);
  }
  const out = new Map<string, string>();
  for (const s of lorebooks) {
    const by = last.get(s.book.name.trim());
    if (by !== undefined && by !== s.key) out.set(s.key, by);
  }
  return out;
}

/**
 * The books a request reads, in ST's "character first" order: persona, card, then the session's.
 * A world is read once by name: of session books with the same name only the last is read
 * (shadowedSessionBooks), and an own book that a session book (or, for the card's, the persona's)
 * of the same name stands in for is left out (shadowedCastBooks).
 */
export function loreSources(cast: { character: Character; persona?: Persona }, lorebooks: readonly LoreSource[]): LoreSource[] {
  const sessionShadowed = shadowedSessionBooks(lorebooks);
  const session = lorebooks.filter((s) => !sessionShadowed.has(s.key));
  const shadowed = shadowedCastBooks(cast, session);
  const out: LoreSource[] = [];
  if (cast.persona?.book && shadowed.persona === undefined) out.push({ key: PERSONA_BOOK_KEY, book: cast.persona.book });
  if (cast.character.book && shadowed.card === undefined) out.push({ key: CARD_BOOK_KEY, book: cast.character.book });
  out.push(...session);
  return out;
}

/** Trace.loreHashes: each source's book, hashed like the preset (canonical JSON, 16 hex). */
export function loreHashes(sources: readonly LoreSource[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sources) out[s.key] = loreBookHash(s.book);
  return out;
}

export interface LoreRequest {
  sources: readonly LoreSource[];
  view: PathView;
  upTo: string;
  names: { char: string; user: string };
  seed: number;
  budget: number;
  /** Token count of a text, already scaled by the model's correction. */
  count(text: string): number;
  /** With explain: the counter without the correction, for the verdicts' rawTokens (LoreRunInput.rawCount). */
  rawCount?(text: string): number;
  /** Macro expansion of an entry's content; `source` is 'lore:' + entryLabel. */
  expand(content: string, source: string): string;
  /** Identity macros in a key ({{char}}, {{user}}, <BOT>, ...); keys without any are left alone. */
  expandKey(key: string): string;
  explain: boolean;
  /**
   * The names of the card's and the persona's own books, also when a same-named session book stands
   * in for them: past fires recorded under '@card' / '@persona' by traces that carry no
   * Trace.loreNames are matched to the book read now by that name.
   */
  ownBooks?: { card?: string; persona?: string };
}

export interface AssembledLore {
  run: LoreRunResult;
  place: LorePlacement;
}


/** A key that may hold an identity macro: `{{…}}` or a legacy `<USER>` / `<BOT>` / `<CHAR>`. */
const MAY_HOLD_MACRO = /\{\{|<(?:user|bot|char)>/i;

/**
 * The sources with macros in their keys expanded (ST normalizeWorldInfoKey). Books and entries
 * without such keys are passed through as they are; the others are shallow copies, never edits.
 */
function withExpandedKeys(sources: readonly LoreSource[], expandKey: (key: string) => string): LoreSource[] {
  const expandAll = (keys: readonly string[] | undefined): string[] | undefined =>
    keys?.some((k) => MAY_HOLD_MACRO.test(k)) ? keys.map((k) => (MAY_HOLD_MACRO.test(k) ? expandKey(k) : k)) : undefined;
  return sources.map((s) => {
    let changed = false;
    const entries = s.book.entries.map((e) => {
      const keys = expandAll(e.keys);
      const secondary = expandAll(e.secondary);
      if (!keys && !secondary) return e;
      changed = true;
      return { ...e, ...(keys ? { keys } : {}), ...(secondary ? { secondary } : {}) };
    });
    return changed ? { key: s.key, book: { ...s.book, entries } } : s;
  });
}

/**
 * Past fires under the key the same world is read by now. ST keys timers by world name and entry
 * uid, and rp-core reads a world once by name (shadowedCastBooks, session books of the same name),
 * so a world can change keys mid-chat ('@card' ↔ a library id, harbor ↔ harbor-2): a fire whose key
 * is not read now follows its book's name (the trace's loreNames; '@card' / '@persona' fall back
 * to the cast's own book names) to the source read under that name.
 */
export function aliasFires(fires: readonly PastFire[], sources: readonly LoreSource[], ownBooks?: LoreRequest['ownBooks']): PastFire[] {
  const keys = new Set(sources.map((s) => s.key));
  const byName = new Map<string, string>();
  for (const s of sources) {
    const n = s.book.name.trim();
    if (n !== '' && !byName.has(n)) byName.set(n, s.key);
  }
  return fires.map((f) => {
    if (keys.has(f.book)) return f;
    const name = f.name ?? (f.book === CARD_BOOK_KEY ? ownBooks?.card : f.book === PERSONA_BOOK_KEY ? ownBooks?.persona : undefined);
    const to = name === undefined ? undefined : byName.get(name.trim());
    return to === undefined ? f : { ...f, book: to };
  });
}

/** Trace.loreNames: each source's book name, trimmed. */
export function loreNames(sources: readonly LoreSource[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sources) out[s.key] = s.book.name.trim();
  return out;
}

/** One lore run over the path up to `upTo`, and where its entries go. */
export function runAssembleLore(req: LoreRequest): AssembledLore {
  if (req.sources.length === 0) {
    const run: LoreRunResult = { fired: [], cut: [], used: 0, regexErrors: [], ...(req.explain ? { verdicts: [] } : {}) };
    return { run, place: placeLore([]) };
  }
  // expand() is called with entryKey(); the macro source names the entry the way the trace does.
  const labels = new Map<string, string>();
  for (const s of req.sources) for (const e of s.book.entries) labels.set(entryKey(s.key, e.id), entryLabel(s.key, e.id));
  const run = runLore({
    sources: withExpandedKeys(req.sources, req.expandKey),
    scan: scanMessages(req.view, req.upTo, req.names),
    chatLength: chatLengthAt(req.view, req.upTo),
    fires: aliasFires(pathFires(req.view, req.upTo), req.sources, req.ownBooks),
    scans: pathScans(req.view, req.upTo),
    seed: req.seed,
    budget: req.budget,
    count: req.count,
    ...(req.explain && req.rawCount ? { rawCount: req.rawCount } : {}),
    expand: (key, content) => req.expand(content, `lore:${labels.get(key) ?? key}`),
    explain: req.explain,
  });
  const place = placeLore(run.fired);
  place.slots.examples_before = examplesBefore(run.fired);
  return { run, place };
}

/** ST's example-before order: by order descending, ties in acceptance order (see the header). */
function examplesBefore(fired: readonly LoreHit[]): string[] {
  const orderOf = (h: LoreHit): number => h.entry.order ?? DEFAULT_LORE_ORDER;
  return fired
    .filter((h) => h.entry.position === 'examples_before' && h.text !== '')
    .map((h, i) => ({ h, i }))
    .sort((a, b) => orderOf(b.h) - orderOf(a.h) || a.i - b.i)
    .map(({ h }) => h.text);
}

// ---- slot values ------------------------------------------------------------------------------

const SLOT_NAMES: readonly string[] = ['before', 'after', 'examples_before', 'examples_after'] satisfies LoreSlotName[];

/**
 * Example-message entries as example dialogue: each entry split on `<START>` (one implied when it
 * has none) and every chunk headed by new_example_chat_prompt, or `<START>` without one; a blank
 * one heads nothing (formatExamples).
 */
function exampleChunks(texts: readonly string[], header: string | undefined): string {
  const head = header !== undefined ? header : '<START>';
  return texts
    .map((t) => formatExamples(t, head))
    .filter((t) => t.trim() !== '')
    .join('\n');
}

/**
 * The value of a lore or outlet slot in a preset block ('' when nothing fired for it, or for a lore
 * name that is no slot). Other slot kinds are not lore's; they render ''.
 */
export function loreSlotValue(ref: SlotRef, place: LorePlacement, formats: Preset['formats']): string {
  if (ref.kind === 'outlet') {
    // Own names only: an outlet may be called anything, 'toString' and '__proto__' included.
    const texts = Object.hasOwn(place.outlets, ref.name) ? place.outlets[ref.name] : undefined;
    return texts ? texts.join('\n') : '';
  }
  if (ref.kind !== 'lore') return '';
  const name = ref.name.toLowerCase();
  if (!SLOT_NAMES.includes(name)) return '';
  const texts = place.slots[name as LoreSlotName];
  if (texts.length === 0) return '';
  if (name === 'examples_before' || name === 'examples_after') return exampleChunks(texts, formats?.newExampleChat);
  return renderSlot(ref, texts.join('\n'), formats);
}

// ---- author's note -----------------------------------------------------------------------------

/**
 * The author's note with AN-top / AN-bottom lore around it, as ST builds it. Without such lore the
 * note is returned untouched (M1: sent as written).
 */
export function noteWithLore(note: string, place: LorePlacement): string {
  if (place.noteBefore.length === 0 && place.noteAfter.length === 0) return note;
  return `${place.noteBefore.join('\n')}\n${note}\n${place.noteAfter.join('\n')}`.replace(/^\n+|\n+$/g, '');
}

// ---- notices -----------------------------------------------------------------------------------

/**
 * One warning naming every '/re/' key that did not compile, by entry label and key. The book's
 * other text (content, the compiler's message quoting it) stays out of the notice.
 */
export function regexNotice(errors: LoreRunResult['regexErrors']): Notice | null {
  if (errors.length === 0) return null;
  const named = errors.slice(0, MAX_REGEX_NAMED).map((e) => `${entryLabel(e.book, e.id)} ${e.key}`);
  const more = errors.length > MAX_REGEX_NAMED ? `, and ${errors.length - MAX_REGEX_NAMED} more` : '';
  return {
    level: 'warn',
    code: 'lore_regex_invalid',
    message: `Lore keys that are not valid regular expressions (re2js) were matched as plain text: ${named.join(', ')}${more}.`,
  };
}
