// Ported from Bunraku:src/studio/dramaturg-tools.ts@702d8120 (search_lorebook and
// read_lorebook_entry, lines ~122–201).
// Copyright (C) 2026 Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// search_lore and read_lore (ARCHITECTURE.md §9.2, D-59; .notes/m5a-decisions.md D-150, D-156). Port sources: Bunraku
// src/studio/dramaturg-tools.ts lines ~122–201 (Levi; short handles) and, for reference, RoleCall
// ai/dm-stream/tools/executors.ts search_lorebook (weights not taken: lexScore ranks instead).
// CONTRACT FILE (M3): signatures are fixed; the builtins agent implements the bodies.
//
// Port notes. Kept from Bunraku: short handles instead of ids, rows `<handle> <title> (<book>):
// <excerpt>`, '(untitled)', "N more match; add a word to narrow it.", "run it before saying the lore
// does not cover something", an unknown handle answered by name. Changed: ranked by lexScore (word
// stems, phrases, title and keys count) instead of Bunraku's AND substring over title + content in
// book order; handles are the turn's HandleTable instead of positions over the books (D-59 as
// amended: L<n> for book entries by first appearance, the same in every round of the turn; C<n> for
// notes is the note's /memory handle, stable across turns, resolvable before any search);
// disabled entries and retired Compendium entries never appear (Bunraku listed off entries, flagged);
// notes are searched once, as Compendium records, never through their lore book; read_lore takes
// several handles and caps the whole result at 8 000 characters. M5a (D-156): every live Compendium
// entry is searched (notes, typed session and library entries, overlays, arcs) under its C<n>
// (D-150); a typed entry's snippet is its brief, read_lore gives its full render. RoleCall's
// search_lorebook (title ×3, keys ×2, text ×1 over substrings; git credits it to Chi through the
// import commit 660a7d67a, so its original author is unknown) and its sentence-based
// extractSmartSnippet are reference only.

import { NOTES_BOOK_KEY } from '../../agents/compendium/notes.ts';
import { renderBrief, renderEntry } from '../../agents/compendium/render.ts';
import type { CEntry } from '../../agents/compendium/types.ts';
import type { LoreEntry } from '../../formats/native.ts';
import { CARD_BOOK_KEY, DEFAULT_LORE_ORDER, PERSONA_BOOK_KEY, type LoreSource } from '../../lore/engine.ts';
import { lexScore, type LexDoc } from '../../text/lexscore.ts';
import { locateQuery, parseQuery, wordsOf } from '../../text/normalize.ts';
import { handleShaped, type HandleTarget } from '../handles.ts';
import { DEFAULT_TOOL_OUTPUT, type Tool, type ToolCtx, type ToolOutput } from '../types.ts';
import { excerptAround, headOf, outputRoom } from './history.ts';

export const LORE_HITS_MAX = 10;
/** §9.2: read_lore returns at most this many characters in all. */
export const READ_LORE_MAX = 8000;
/** Snippet length of a search_lore hit. */
export const LORE_SNIPPET = 200;
/** read_lore takes at most this many handles per call. */
export const READ_LORE_IDS_MAX = 20;

/** Between handles a model wrote as one string: commas, semicolons, whitespace. */
const ID_SEPARATORS = /[\s,;、，；]+/u;
/** A piece of an id string worth reading: it holds a letter or a digit (a lone '«' or '"' does not). */
const WORDLIKE = /[\p{L}\p{N}]/u;

/**
 * The handles one ids string names: split at commas, semicolons and whitespace ('L1, L2', '[L1 L2]');
 * pieces with no letter or digit (the quotes and brackets of '« L1 »') go. When some piece is written
 * like a handle, only those count ('L1 (Замок)' is L1; an unknown 'L9' beside it is still told); a
 * string with none ('Замок') stays one id, so the model learns that a title is not a handle.
 */
function splitIds(x: string): string[] {
  const pieces = x.split(ID_SEPARATORS).filter((p) => WORDLIKE.test(p));
  const handles = pieces.filter(handleShaped);
  if (handles.length > 0) return handles;
  return x.trim() === '' ? [] : [x];
}

/** What a note's and an arc's rows say in place of a book name (D-156). */
const NOTE_LABEL = 'note';
const ARC_LABEL = 'arc';
/** A key written '/pattern/flags' (lore/keys.ts): never a title. */
const REGEX_KEY_RE = /^\/[\s\S]+\/[gimsuy]*$/;
/** Between the lines of a typed entry's brief on its one search row. */
const BRIEF_JOIN = ' | ';

/** One searchable record: a book entry or a live Compendium entry. */
interface LoreDoc {
  target: HandleTarget;
  title: string;
  /** The book's name; 'note', 'arc', the entry type, or '<type>, <book name>' for a Compendium entry. */
  label: string;
  /** The text read_lore returns. */
  content: string;
  lex: LexDoc;
  /** A Compendium entry: its snippet comes from the entry (a typed entry shows its brief). */
  entry?: CEntry;
}

/** Whitespace runs to one space, trimmed: a title or a name stays on its row. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A source's name as rows show it: the book's own name, else what the source is. */
function bookLabel(src: LoreSource): string {
  const name = oneLine(src.book.name ?? '');
  if (name !== '') return name;
  if (src.key === CARD_BOOK_KEY) return 'card';
  if (src.key === PERSONA_BOOK_KEY) return 'persona';
  return src.key;
}

/** An entry's title as rows show it: its title, else its first plain key, else '(untitled)'. */
function entryTitle(e: LoreEntry): string {
  const title = oneLine(e.title ?? '');
  if (title !== '') return title;
  const key = e.keys.map(oneLine).find((k) => k !== '' && !REGEX_KEY_RE.test(k));
  return key ?? '(untitled)';
}

/**
 * The turn's handle table, bound to the turn's Compendium (D-150: an entry's C<n> is its /memory
 * handle). Binding the same view again is free; a test's empty ctx may carry no entries map.
 */
function handlesOf(ctx: ToolCtx): ToolCtx['handles'] {
  if (ctx.compendium?.entries !== undefined) ctx.handles.bindNotes(ctx.compendium);
  return ctx.handles;
}

/** The live (not retired) entries of the turn's Compendium in handle order (a test's empty ctx may carry no entries map). */
function liveEntries(ctx: ToolCtx): CEntry[] {
  const out: CEntry[] = [];
  const entries = ctx.compendium?.entries;
  if (entries === undefined) return out;
  for (const e of entries.values()) if (e.retired === undefined) out.push(e);
  return out;
}

/** renderEntry of a Compendium entry, cached per entry object (the view's entries are never changed). */
const FULL = new WeakMap<CEntry, string>();
function fullText(e: CEntry): string {
  let text = FULL.get(e);
  if (text === undefined) {
    text = renderEntry(e);
    FULL.set(e, text);
  }
  return text;
}

/** The book name a library entry's row shows: the turn's source of that library id, else the id. */
function libraryLabel(book: string, ctx: ToolCtx): string {
  const src = ctx.lore.find((s) => s.key === book);
  return src === undefined ? book : bookLabel(src);
}

/** D-156: one live Compendium entry as a searchable record under its C<n>. */
function compendiumDoc(e: CEntry, ctx: ToolCtx): LoreDoc {
  const target: HandleTarget = { kind: 'compendium', key: e.key };
  const title = oneLine(e.name) || '(untitled)';
  const content = fullText(e);
  if (e.type === null) {
    // A note or an arc: its own text is what is searched (the render only frames it).
    const text = e.content ?? '';
    const keys = e.arc === undefined ? e.keys : [];
    return { target, title, label: e.arc === undefined ? NOTE_LABEL : ARC_LABEL, content, entry: e, lex: { title: e.name, keys, text, rank: e.prov.lastSeq } };
  }
  const library = e.origin.kind === 'library' ? e.origin : undefined;
  const label = library === undefined ? e.type : `${e.type}, ${libraryLabel(library.book, ctx)}`;
  // Every field is searched (the full render); aliases and a library entry's lore keys count as keys.
  const rank = library === undefined ? e.prov.lastSeq : (e.order ?? DEFAULT_LORE_ORDER);
  return { target, title, label, content, entry: e, lex: { title: e.name, keys: [...e.aliases, ...e.keys], text: content, rank } };
}

/**
 * Everything search_lore ranks: the enabled entries of the turn's books (the notes book skipped: its
 * notes come as Compendium records; an entry the Compendium holds as 'lib:<book>:<id>' skipped too, as
 * the engine's routing does), then every live Compendium entry in handle order (lexScore's last
 * tie-break is this order).
 */
function loreDocs(ctx: ToolCtx): LoreDoc[] {
  const docs: LoreDoc[] = [];
  const held = ctx.compendium?.entries;
  for (const src of ctx.lore) {
    if (src.key === NOTES_BOOK_KEY) continue;
    const label = bookLabel(src);
    for (const e of src.book.entries) {
      if (e.enabled === false || held?.has(`lib:${src.key}:${e.id}`) === true) continue;
      docs.push({
        target: { kind: 'lore', book: src.key, id: e.id },
        title: entryTitle(e),
        label,
        content: e.content,
        lex: { title: e.title ?? '', keys: e.keys, text: e.content, rank: e.order ?? DEFAULT_LORE_ORDER },
      });
    }
  }
  for (const e of liveEntries(ctx)) docs.push(compendiumDoc(e, ctx));
  return docs;
}

/** The record a handle names, as the turn's sources hold it now; undefined when it is gone, off or retired. */
function docOf(target: HandleTarget, ctx: ToolCtx): LoreDoc | undefined {
  if (target.kind === 'compendium') {
    const e = ctx.compendium?.entries?.get(target.key);
    return e !== undefined && e.retired === undefined ? compendiumDoc(e, ctx) : undefined;
  }
  const src = ctx.lore.find((s) => s.key === target.book);
  if (src === undefined || src.key === NOTES_BOOK_KEY) return undefined;
  const e = src.book.entries.find((x) => x.id === target.id);
  if (e === undefined || e.enabled === false) return undefined;
  return { target, title: entryTitle(e), label: bookLabel(src), content: e.content, lex: { text: e.content } };
}

/**
 * A typed entry's snippet: its brief (D-151) without the `# <name>` line (the row names it), the
 * lines joined by ' | ', whole lines while they fit LORE_SNIPPET ('…' after the last one that fits).
 * An entry whose brief is only its name shows the head of its full render instead.
 */
function briefSnippet(e: CEntry): string {
  const lines = renderBrief(e, Number.MAX_SAFE_INTEGER).split('\n').slice(1).map(oneLine).filter((l) => l !== '');
  if (lines.length === 0) return excerptAround(fullText(e).split('\n').slice(1).join('\n'), null, LORE_SNIPPET);
  let out = '';
  for (const line of lines) {
    const next = out === '' ? line : `${out}${BRIEF_JOIN}${line}`;
    if (next.length > LORE_SNIPPET) return out === '' ? excerptAround(line, null, LORE_SNIPPET) : `${out}${BRIEF_JOIN}…`;
    out = next;
  }
  return out;
}

/** A hit's snippet: a typed entry's brief; otherwise the text around the first match (the head when only the title or a key matched). */
function snippetOf(d: LoreDoc, q: ReturnType<typeof parseQuery>): string {
  if (d.entry !== undefined && d.entry.type !== null) return briefSnippet(d.entry);
  const text = d.entry !== undefined ? (d.entry.content ?? '') : d.content;
  const at = locateQuery(q, wordsOf(text)).reduce<[number, number] | null>((best, x) => (x !== null && (best === null || x[0] < best[0]) ? x : best), null);
  return excerptAround(text, at, LORE_SNIPPET);
}

const SEARCH_DESCRIPTION = [
  'Search the lore of this chat by words: the world and character entries, and the Compendium entries (characters, places, items, events, plots and the other records of the story so far, the memory notes and arcs).',
  'Your context holds only the entries that came up this turn, so search before you say the lore does not cover something.',
  'Entries that match more of your words come first. Nouns, names and adjectives match their other forms, so search by word roots and short forms; put an exact phrase in quotes.',
  'Each hit has a handle like L3 (a lore entry) or C2 (a Compendium entry) and a short snippet: read the whole text with read_lore.',
].join(' ');

/**
 * search_lore {query}: ranked (lexScore) over the enabled entries of ctx.lore (book entries: title,
 * keys, content; rank = order) and every live entry of ctx.compendium (D-156; title = name; keys =
 * a note's keys, a typed entry's aliases and library lore keys; text = a note's or an arc's own text,
 * a typed entry's full render; rank = prov.lastSeq in the session, order for a library entry). The
 * notes book key (@notes) in ctx.lore is skipped (notes are listed once, as Compendium records), and
 * so is any book entry the Compendium holds (routed by the engine; checked again here). Retired
 * Compendium entries and disabled book entries never appear. Top LORE_HITS_MAX, each
 * `<handle> <title> (<label>): <snippet>`: L<n> and the book name for book entries; C<n> (D-150) and
 * 'note', 'arc', the type, or '<type>, <book name>' (a library entry) for Compendium entries, whose
 * typed snippets are their brief (snippetOf).
 */
export const searchLoreTool: Tool = {
  name: 'search_lore',
  description: SEARCH_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The words to look for in titles, keys and text. Roots and short forms work best; quotes mark an exact phrase.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  effect: 'read',
  maxOutput: (ctx) => outputRoom(ctx, DEFAULT_TOOL_OUTPUT),
  async run(args, ctx: ToolCtx): Promise<ToolOutput> {
    const query = typeof args['query'] === 'string' ? args['query'] : '';
    const q = parseQuery(query);
    if (q.terms.length + q.phrases.length + q.substrings.length === 0) {
      return { text: 'The query holds no words to search for. Give one or more words to find.', summary: 'no words', error: true };
    }
    const handles = handlesOf(ctx);
    const docs = loreDocs(ctx);
    if (docs.length === 0) return { text: 'This chat has no lore or Compendium entries to search.', summary: 'no lore' };
    const ranked = lexScore(q, docs.map((d) => d.lex));
    if (ranked.length === 0) {
      return { text: 'No lore or Compendium entry matches. Try a shorter root, another word or a name before you decide the lore is silent.', summary: 'no hits' };
    }
    // Rows that fit the room (the closing line kept free); a handle is issued only for a row shown.
    const room = outputRoom(ctx, DEFAULT_TOOL_OUTPUT) - 60;
    const lines: string[] = [];
    let used = 0;
    for (const r of ranked.slice(0, LORE_HITS_MAX)) {
      const d = docs[r.index] as LoreDoc;
      const body = `${d.title} (${d.label}): ${snippetOf(d, q) || '(empty)'}`;
      if (lines.length > 0 && used + body.length + 8 > room) break;
      const line = `${handles.handleFor(d.target)} ${body}`;
      lines.push(line);
      used += line.length + 1;
    }
    const shown = lines.length;
    const more = ranked.length - shown;
    if (more > 0) lines.push(`${more} more match; add a word to narrow it.`);
    return { text: lines.join('\n'), summary: `${shown} ${shown === 1 ? 'hit' : 'hits'}` };
  },
};

/** A handle as the model wrote it, quoted and clipped for an answer line. */
function shownHandle(raw: string): string {
  const one = raw.replace(/\s+/g, ' ').trim();
  return JSON.stringify(one.length > 40 ? `${one.slice(0, 39)}…` : one);
}

/** The cut note of an entry that passes what is left of the result (`limit`: the result's size). */
const cutNote = (handle: string, rest: number, limit: number): string => `\n[${handle} continues for ${rest} more characters past the ${limit}-character limit]`;

/**
 * read_lore {ids: string[]}: the full text of each handle, in the order asked, as
 * `<handle> <title> (<label>):\n<content>` (a Compendium entry's content is its renderEntry: the full
 * render, a note's noteText, an arc's overview; no freshness filter, D-156); an unknown or retired
 * handle gets one line saying so; at most
 * READ_LORE_MAX characters in all, fewer in a small room (outputRoom); an entry that passes the
 * limit is cut with a note saying how much is left, and the handles after it are named as not shown.
 */
export const readLoreTool: Tool = {
  name: 'read_lore',
  description: `Read lore entries and Compendium entries whole, by the handles search_lore gave (like L3 or C2) or a C handle named in your context, in the order you list them. At most ${READ_LORE_MAX} characters in all: read fewer at a time when entries are long.`,
  schema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: READ_LORE_IDS_MAX,
        description: 'Handles from search_lore, like ["L3", "C2"].',
      },
    },
    required: ['ids'],
    additionalProperties: false,
  },
  effect: 'read',
  maxOutput: (ctx) => outputRoom(ctx, READ_LORE_MAX),
  async run(args, ctx: ToolCtx): Promise<ToolOutput> {
    const raw = args['ids'];
    // A list sent as one string ('L1, L2', 'L1 L2'; the argument chain wraps it into one item) is split.
    const ids = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
      .filter((x): x is string => typeof x === 'string')
      .flatMap(splitIds)
      .slice(0, READ_LORE_IDS_MAX);
    if (ids.length === 0) return { text: 'ids needs at least one handle from search_lore, like ["L3"].', summary: 'no handles', error: true };

    // The result's size (READ_LORE_MAX, or less in a small room); the closing line that names the
    // handles left for another call is kept free.
    const limit = outputRoom(ctx, READ_LORE_MAX);
    const body = limit - 300;
    const pieces: string[] = [];
    const unread: string[] = [];
    const seen = new Set<string>();
    let used = 0;
    let found = 0;
    let unknown = 0;
    const add = (piece: string): void => {
      used += (pieces.length > 0 ? 2 : 0) + piece.length;
      pieces.push(piece);
    };
    const handles = handlesOf(ctx);
    for (const id of ids) {
      const target = handles.resolve(id);
      const doc = target === undefined ? undefined : docOf(target, ctx);
      if (doc === undefined) {
        unknown++;
        // One short line, so the model learns which handle was wrong (dropped only past a full result).
        const line = `${shownHandle(id)}: no such handle. Use the handles search_lore gave, like L3 or C2.`;
        if (unread.length === 0 && used + 2 + line.length <= body) add(line);
        continue;
      }
      const handle = handles.handleFor(doc.target);
      if (seen.has(handle)) continue; // asked twice: shown once
      seen.add(handle);
      if (unread.length > 0) {
        unread.push(handle);
        continue;
      }
      const piece = `${handle} ${doc.title} (${doc.label}):\n${doc.content}`;
      const room = body - used - (pieces.length > 0 ? 2 : 0);
      if (piece.length <= room) {
        add(piece);
        found++;
      } else if (pieces.length === 0 || room >= 500) {
        // Too long for what is left: its head, and how much is missing (always for the first one).
        const head = headOf(piece, room - cutNote(handle, piece.length, limit).length);
        add(head + cutNote(handle, piece.length - head.length, limit));
        found++;
      } else unread.push(handle);
    }
    if (unread.length > 0) add(`Not shown, the result is full: ${unread.join(', ')}. Call read_lore with them again.`);
    const summary = [found > 0 ? `${found} read` : '', unknown > 0 ? `${unknown} unknown` : '', unread.length > 0 ? `${unread.length} not shown` : ''].filter(Boolean).join(', ');
    return { text: pieces.join('\n\n'), summary, ...(found === 0 && unread.length === 0 ? { error: true } : {}) };
  },
};
