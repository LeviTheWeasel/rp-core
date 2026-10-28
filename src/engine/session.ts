// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// One open session (ARCHITECTURE.md §5.3, §6.1, §12.1): the locked journal, the cached tree and
// PathView, the verbs, and at most one running turn. Every write goes through append() here, which
// keeps version(session) current without re-reading the log. Admission (admit.ts) and the turn's
// first line happen synchronously in runTurn; the rest of the turn runs in turn.ts. preview (M2)
// runs the same admission and request.ts buildRequest, and writes nothing. M4 (D-106): a preview never
// calls the Director; it shows the directive the turn would carry when that is known (a swipe that
// reuses the plan, a past answer's stored one), else a stub.
//
// M5a (.notes/m5a-decisions.md D-141, D-159): the session loads its library books once per (book ids,
// the Compendium's on/off and books table, each book file's mtime and size) and folds every view with
// the Compendium's seed made from them, so /memory, the tools, the block and the Director's snapshot
// read one Compendium with one numbering. The memory verbs write one human row each, after folding
// the rows with it as a dry run: an issue on that row refuses it in words and nothing is written.
// After the review (the lead's rulings, D-168): a `file` row stores the key its dry run produced
// (op.target), so it keeps addressing that entry whatever books come later; a dry run that changes
// nothing writes nothing (changed:false); the verbs return the Compendium's untold notices instead of
// publishing them, and the export returns what its file could not keep. After the final check (ruling
// I): the no-op check is merge.ts's bounded comparison; aliases the entry already shows are no change;
// one name per live entry of a type holds for renames, new aliases and restores (summaries exempt);
// an export folds with the readable books' seed even while the Compendium is off.
//
// M5b (.notes/m5b-decisions.md D-171, D-172, D-180): each open session runs its background lane
// (lane.ts): created after recovery at open, told after every send, settled turn, edit, hide, head
// move, config change and lane verb, its origins touched for the scheduler's idle gate, closed first
// on close(). The lane writes through append() like everything else; its events go on the bus. The
// verbs memoryUndo (revert rows, after a dry run), memoryRefile and memoryRetry (job retry rows)
// follow D-159 (session_busy during a turn, changed:false); memoryWait and memoryStatus are allowed
// during a turn (memoryWait starts nothing while it runs, the lead's ruling I).

import { statSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { entryNames, findMatch, foldCompendium, normalizeName } from '../agents/compendium/apply.ts';
import {
  EMPTY_SEED,
  ENTRY_TYPES,
  type CEntry,
  type CompendiumView,
  type EntryType,
  type FoldIssue,
  type LibrarySeed,
  type MemEntry,
  type OpEffect,
  type Rec,
} from '../agents/compendium/types.ts';
import { identityField, isEntryType, REQUIRED_FIELDS } from '../agents/compendium/entry-types.ts';
import { sameData } from '../agents/compendium/merge.ts';
import { librarySeed } from '../agents/compendium/library.ts';
import { exportCompendiumRows, exportCoreBook, ExportLimitError, replaceFile, writeCompendiumFile } from '../agents/compendium/export.ts';
import { isNote, noteRefs } from '../agents/compendium/notes.ts';
import { COMPENDIUM_LIMITS, resolveCompendium } from '../agents/compendium/profile.ts';
import { RECAP_SRC } from '../agents/compendium/recap.ts';
import { entryRefs, refOf, resolveEntryRef } from '../agents/compendium/refs.ts';
import { renderBrief, renderEntry } from '../agents/compendium/render.ts';
import { deriveTree, type TreeNode } from '../agents/compendium/tree.ts';
import { directiveInsert, reusedRecord, stubInsert, swipeReuses } from '../agents/director/call.ts';
import { checkRecord } from '../agents/director/state.ts';
import { compendiumPatchProblem } from '../config/config.ts';
import { compendiumWarnings } from '../formats/compendium-v1.ts';
import { libraryDir, saveToLibrary } from '../formats/library.ts';
import { canonicalId, type ImportWarning } from '../formats/native.ts';
import { searchHistory, type HistorySearch } from '../tools/builtin/history.ts';
import { Refusal } from './api.ts';
import type {
  CreateSessionInput,
  MemoryLaneWrite,
  MemoryRow,
  MemoryStatus,
  MemoryWrite,
  PreviewOptions,
  PreviewResult,
  RunTurnOptions,
  SessionHandle,
  TurnHandle,
} from './api.ts';
import { admitTurn, checkOnError, resolvePreset, resolvePrimary } from './admit.ts';
import { effectiveText } from './commit.ts';
import { isoNow, type EngineCtx } from './context.ts';
import { Lane, taskOn, type LaneHost } from './lane.ts';
import { firstRoundLast, modelRequest, roundFields } from './narrate.ts';
import { recoverSession, type RecoverJournal } from './recover.ts';
import { buildRequest, compendiumConfigOf, compendiumNotices, loadLibrary, maxTokensFor, type SessionLibrary } from './request.ts';
import { TurnRun, type EventBody, type TurnHost } from './turn.ts';
import { traceForSent } from '../prompt/assemble.ts';
import { loreSources } from '../prompt/assemble/lore.ts';
import { readRecapTrace } from '../prompt/assemble/recap.ts';
import { isInsertSrc, type DepthInsert } from '../prompt/depth.ts';
import { CONTINUE_CUE_SRC, POST_PROCESSING_PLACEHOLDER_SRC } from '../prompt/shape.ts';
import { counterOf } from './ema.ts';
import { createMacroRun } from '../prompt/macros.ts';
import type { Event, Notice } from '../protocol/events.ts';
import {
  checkHeader,
  DEFAULT_SESSION_CONFIG,
  VERSIONED_KINDS,
  type DeepPartial,
  type Entry,
  type EntryInput,
  type EntryKind,
  type MemOp,
  type SessionConfig,
  type SessionHeader,
  type Trace,
  type TurnKind,
} from '../session/entries.ts';
import { currentConfig, foldView, foldViewAt, mergePatch } from '../session/fold.ts';
import { forkSession } from '../session/fork.ts';
import { newMessageId, newSeed, newSessionId, newTurnId } from '../session/ids.ts';
import {
  createSessionLogWith,
  openSessionLog,
  SessionLockedError,
  SessionNotFoundError,
  type SessionLog,
} from '../session/log.ts';
import { buildTree, effectiveMessage, newestDescendant, type TreeIndex } from '../session/tree.ts';
import type { MessageView, PathView } from '../session/view.ts';

/** How many fresh ids to draw before giving up on a collision (8 hex: practically never > 1). */
const ID_ATTEMPTS = 16;

/** PreviewOptions.draft becomes a user message with this id (message ids are 8 hex: never taken). */
export const DRAFT_ID = 'draft';

/** The view with an unsent user message appended as the head (PreviewOptions.draft). */
function withDraft(view: PathView, text: string): PathView {
  const draft: MessageView = {
    id: DRAFT_ID,
    parent: view.head,
    role: 'user',
    blocks: [{ k: 'text', text }],
    hidden: false,
    edited: false,
    swipe: { index: 0, count: 1 },
  };
  return { ...view, head: DRAFT_ID, path: [...view.path, draft], pathSet: new Set([...view.pathSet, DRAFT_ID]) };
}

/** M5a: whether the Compendium the request read (trace.compendium.rev; none when no block input) differs. */
const compendiumChanged = (past: Trace, now: Trace): boolean => (past.compendium?.rev ?? null) !== (now.compendium?.rev ?? null);

/**
 * What changed since a past answer's trace: its preset, the books by key, and (M5a) the Compendium:
 * its rev hashes the rows and the library seed, so a typed entry edited by a verb, a new row or a
 * block that came or went shows here. The books' hashes are of the books as loaded, before routing
 * (the lead's ruling I): turning the Compendium on or off names the Compendium, never a book; a typed
 * entry edited in its book file names both. Empty when nothing did.
 */
function inputsChanged(past: Trace, now: Trace): string[] {
  const out: string[] = [];
  if (past.presetHash !== now.presetHash) out.push('the preset');
  const was = past.loreHashes ?? {};
  const is = now.loreHashes ?? {};
  const keys = [...new Set([...Object.keys(was), ...Object.keys(is)])].sort();
  for (const k of keys) {
    if (was[k] === is[k]) continue;
    out.push(was[k] === undefined ? `lorebook ${k} (added)` : is[k] === undefined ? `lorebook ${k} (gone)` : `lorebook ${k}`);
  }
  if (compendiumChanged(past, now)) out.push('the Compendium');
  return out;
}

/** The Compendium block's row source ('compendium' or 'compendium:block'). */
const isCompendiumSrc = (src: string): boolean => src.split(':', 1)[0] === 'compendium';

/** Message sources only shaping adds (the post-processing placeholder, the continue cue). */
const SHAPING_SRCS: ReadonlySet<string> = new Set([POST_PROCESSING_PLACEHOLDER_SRC, CONTINUE_CUE_SRC]);

/** A chat message's source ('history' or 'history:…'), as assemble names it. */
const isHistorySrc = (src: string): boolean => src === 'history' || src.startsWith('history:');

/** The {{recap}} slot's message source (D-178). */
const isRecapSrc = (src: string): boolean => src === RECAP_SRC;

/** What the {{recap}} slot held (trace.recap's ids and arc revisions; none recorded reads as empty). */
function recapHeld(t: Trace): string {
  const r = readRecapTrace(t.recap);
  return JSON.stringify([r?.ids ?? [], r?.arcs ?? []]);
}

/** What the past answer's request was built from, beyond its trace: decided by the caller from the journal. */
interface PastInputs {
  /** The path messages it was built from (ids, hidden state, text) differ from today's. */
  history: boolean;
  /** The preset or a lorebook changed (inputsChanged named it): it explains other blocks' text. */
  presetOrBooks: boolean;
  /** M5a: the Compendium changed (inputsChanged named it): it explains the block's row. */
  compendium: boolean;
  presetChanged: boolean;
  /** 'conn:model' of the answer, when its gen recorded the connection; today's. */
  model: { past?: string; now: string };
}

/**
 * What else changed since a past answer was sent (§6.1 preview --turn), read off the request rebuilt
 * today against the one its trace recorded (one row per message sent: src, role, tokens) and off the
 * journal: the history (an edit or a hidden message, compared by message id and text, never by the
 * rows: shaping merges history rows with other blocks), the cut of old messages (trace.trimmed), the
 * author's note and other in-chat inserts, the text of the system blocks when neither the preset nor
 * a book explains it, the {{recap}} slot (its message, or what trace.recap says it held) when the
 * Compendium does not explain it (M5b, the lead's ruling H), the shaping (rows merged or re-roled with
 * the same parts in the same order: the model's connection or the preset's post-processing), the
 * window and the model. A row is split on '+' into the parts shape() joined. Token counts are compared
 * only when both were counted the same way (an M1 trace counted chars) and the rows line up one to
 * one. Empty when the rebuild matches.
 */
function sentChanged(past: Trace, now: Trace, inputs: PastInputs): string[] {
  const out: string[] = [];
  const sameCounter = counterOf(past) === counterOf(now);
  const pastRows = past.blocks ?? [];
  const nowRows = now.blocks ?? [];
  const parts = (src: string): string[] => src.split('+');
  const atoms = (rows: readonly { src: string }[], keep: (src: string) => boolean): string =>
    rows
      .flatMap((r) => parts(r.src))
      .filter(keep)
      .join('\u0001');
  // A Compendium block that changed with the Compendium is named by inputsChanged, not as an insert.
  const isInsert = (a: string): boolean => !isHistorySrc(a) && isInsertSrc(a) && !(inputs.compendium && isCompendiumSrc(a));
  const isBlock = (a: string): boolean => !isHistorySrc(a) && !isInsertSrc(a) && !SHAPING_SRCS.has(a) && !isRecapSrc(a);
  const shape = (rows: readonly { src: string; role: string }[]): string => rows.map((r) => `${r.src}\u0000${r.role}`).join('\u0001');
  const sameShape = shape(pastRows) === shape(nowRows);

  let inserts = atoms(pastRows, isInsert) !== atoms(nowRows, isInsert);
  let blocks = atoms(pastRows, isBlock) !== atoms(nowRows, isBlock);
  // The slot came, went or holds other summaries or arcs (also when a preset block holds {{recap}}).
  let recap = atoms(pastRows, isRecapSrc) !== atoms(nowRows, isRecapSrc) || recapHeld(past) !== recapHeld(now);
  if (sameShape && sameCounter) {
    // The rows line up: a row whose count moved changed its text (history rows: the journal decides).
    pastRows.forEach((r, i) => {
      if (r.tok === nowRows[i]!.tok) return;
      const p = parts(r.src);
      if (p.some(isInsert)) inserts = true;
      // A slot merged with a block: the slot when it is known to have changed, else the block.
      else if (p.some(isRecapSrc) && (recap || !p.some(isBlock))) recap = true;
      else if (p.some(isBlock)) blocks = true;
    });
  }
  // Same parts in the same order, grouped or roled otherwise (or a placeholder came or went): shaping.
  const noShaping = (a: string): boolean => !SHAPING_SRCS.has(a);
  const shaping =
    (!sameShape && atoms(pastRows, noShaping) === atoms(nowRows, noShaping)) || atoms(pastRows, (a) => SHAPING_SRCS.has(a)) !== atoms(nowRows, (a) => SHAPING_SRCS.has(a));
  const modelChanged = inputs.model.past !== undefined && inputs.model.past !== inputs.model.now;

  if (inputs.history) out.push('the history (an edit or a hidden message)');
  if (JSON.stringify(past.trimmed ?? null) !== JSON.stringify(now.trimmed ?? null)) out.push('which old messages the budget leaves out');
  if (inserts) out.push("the author's note or other in-chat inserts");
  if (blocks && !inputs.presetOrBooks) out.push('the text of the system blocks (the card, the persona or the lore that fired)');
  if (recap && !inputs.compendium) out.push('the {{recap}} slot');
  if (past.window !== now.window || past.reserve !== now.reserve) out.push(`the window (${past.window}/${past.reserve} then, ${now.window}/${now.reserve} now)`);
  if (modelChanged) out.push(`the model (${inputs.model.past} then)`);
  if (shaping) {
    const cause = modelChanged ? "the model's connection" : inputs.presetChanged ? "the preset's post-processing" : "the connection's capabilities";
    out.push(`how the messages are shaped (merged or re-roled: ${cause})`);
  }
  return out;
}

/**
 * The path messages a request up to `leaf` was built from, as of journal seq `seq` and as of now,
 * compared by message id, hidden state and content (an edit, a hide or an unhide since then).
 */
function historyChangedSince(entries: readonly Entry[], tree: TreeIndex, header: SessionHeader, leaf: string, seq: number, seed: LibrarySeed): boolean {
  const key = (v: PathView): string => v.path.map((m) => `${m.id}\u0000${m.hidden ? 1 : 0}\u0000${JSON.stringify(m.blocks)}`).join('\u0001');
  const then = buildTree(entries.filter((e) => e.seq <= seq));
  if (!then.msgs.has(leaf)) return true;
  return key(foldViewAt(header, then, leaf, { library: seed })) !== key(foldViewAt(header, tree, leaf, { library: seed }));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The path messages the head answer's request sent (§7.5 "(in context)"): every visible path
 * message before the head outside the budget's cut (its trace.trimmed {from, to}; a continue's own
 * trace when it has one). null when unknown: the head is not an answer with a trace, or the cut
 * names messages that are no longer on the path.
 */
export function sentByHeadRequest(view: PathView, tree: TreeIndex): ReadonlySet<string> | null {
  const head = view.path.at(-1);
  if (!head || head.role !== 'assistant') return null;
  let trace = tree.msgs.get(head.id)?.trace;
  for (const e of tree.edits.get(head.id) ?? []) if (e.reason === 'continue' && e.trace) trace = e.trace;
  if (!trace) return null;
  const before = view.path.slice(0, -1);
  const trimmed: unknown = trace.trimmed;
  let cut: [number, number] | null = null;
  if (trimmed !== null) {
    if (!isObject(trimmed)) return null;
    const from = before.findIndex((m) => m.id === trimmed.from);
    const to = before.findIndex((m) => m.id === trimmed.to);
    if (from < 0 || to < 0) return null;
    cut = [Math.min(from, to), Math.max(from, to)];
  }
  const sent = new Set<string>();
  before.forEach((m, i) => {
    if (m.hidden || (cut && i >= cut[0] && i <= cut[1])) return;
    sent.add(m.id);
  });
  return sent;
}

/** A note title as stored: trimmed; refused when it has no letter or digit (its key would be empty). */
function noteTitle(v: unknown): string {
  if (typeof v !== 'string') throw new Refusal('invalid_params', 'title must be a string');
  const title = v.trim();
  if (normalizeName(title) === '') throw new Refusal('invalid_params', 'a note title needs at least one letter or digit');
  return title;
}

/** A note's text as stored: trimmed, never empty. */
function noteContent(v: unknown): string {
  if (typeof v !== 'string') throw new Refusal('invalid_params', 'content must be a string');
  const content = v.trim();
  if (content === '') throw new Refusal('invalid_params', 'a note needs some text');
  return content;
}

/** Lore keys as stored: trimmed, blanks dropped, duplicates dropped (first kept). undefined when absent. */
function noteKeys(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((k) => typeof k === 'string')) throw new Refusal('invalid_params', 'keys must be an array of strings');
  const keys: string[] = [];
  for (const k of v as string[]) {
    const key = k.trim();
    if (key !== '' && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

// ---- M5a: the Compendium's helpers -----------------------------------------------------------------

/** A library id that names a file directly (formats/library.ts refuses the others). */
const safeId = (id: unknown): id is string => typeof id === 'string' && id !== '' && !id.startsWith('.') && !/[/\\\0]/.test(id);

/**
 * D-141: what the session's books depend on: their ids, the Compendium's on/off and books table, and
 * each book file's mtime and size. The same key → the same books and the same seed object.
 */
function libraryKey(home: string, config: SessionConfig): string {
  const dir = libraryDir(home, 'lorebooks');
  const ids = config.lorebooks ?? [];
  const cfg = resolveCompendium(config.compendium);
  const files = ids.map((id) => {
    if (!safeId(id)) return '!';
    try {
      const st = statSync(join(dir, `${id}.json`));
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '-';
    }
  });
  return JSON.stringify([ids, cfg.enabled, cfg.books, files]);
}

/** An entry's kind in /memory and the memory event: its type, 'note' or 'arc'. */
export const entryKind = (e: CEntry): EntryType | 'note' | 'arc' => e.type ?? (e.arc !== undefined ? 'arc' : 'note');

function memoryRow(ref: string, e: CEntry): MemoryRow {
  return {
    ref,
    key: e.key,
    type: entryKind(e),
    name: e.name,
    aliases: [...e.aliases],
    tagline: e.tagline,
    origin: e.origin.kind === 'library' ? { book: e.origin.book, id: e.origin.id } : 'session',
    ...(e.retired ? { retired: { reason: e.retired.reason } } : {}),
    // A note's or an arc's size is its text (the overview), whose data is {} (the lead's ruling on D-161).
    size: e.type === null && typeof e.content === 'string' ? e.content.length : JSON.stringify(e.data).length,
    ...(e.featured === true ? { featured: true as const } : {}),
    ...(e.origin.kind === 'library' && e.origin.overlay ? { overlay: true as const } : {}),
  };
}

const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** A copy of a verb's JSON input (no undefined, no shared objects with the caller). */
const jsonCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** D-159: why the fold refused the verb's row, in words. */
function refusalWords(issue: FoldIssue, op: MemOp, c: CompendiumView, seed: LibrarySeed): string {
  const label = (key: string | undefined): string => {
    if (key === undefined) return 'the entry';
    const e = c.entries.get(key);
    const ref = refOf(c, key);
    return e ? `${JSON.stringify(e.name)}${ref ? ` (${ref})` : ''}` : key;
  };
  switch (issue.why) {
    case 'unknown_type':
      return `unknown entry type; one of ${ENTRY_TYPES.join(', ')}`;
    case 'missing_required': {
      if (op.op !== 'file' || !isEntryType(op.type)) return 'a required field is missing';
      const missing = REQUIRED_FIELDS[op.type].filter((f) => isBlank(op.data[f]));
      return `a ${op.type} needs ${(missing.length > 0 ? missing : REQUIRED_FIELDS[op.type]).join(', ')}`;
    }
    case 'classic_conflict': {
      const book = issue.key?.split(':')[1];
      const name = book !== undefined ? (seed.books.get(book) ?? book) : 'a library book';
      return `that name is already a plain (untyped) entry of the book ${JSON.stringify(name)} (${issue.key}); file it under another name or change the book`;
    }
    case 'not_found':
      return op.op === 'file' ? 'no entry matches' : `no entry matches ${JSON.stringify('ref' in op ? op.ref : '')}`;
    case 'library_entry_missing':
      return `the library entry ${issue.key ?? ''} is not read any more (its book was removed or set off, or the entry is gone)`;
    case 'invalid':
      if (op.op === 'file' && isEntryType(op.type)) return `the ${identityField(op.type)} needs at least one letter or digit`;
      if (op.op === 'note') return 'a note title needs at least one letter or digit';
      return `this change cannot apply to ${label(issue.key)}`;
    default:
      return `the Compendium cannot apply this change (${issue.why})`;
  }
}

/**
 * What a verb can change in an entry besides its data, provenance bookkeeping (lastSeq, appended) and
 * the overlay flag aside.
 */
const entryState = (e: CEntry): unknown[] => [
  e.type,
  e.name,
  e.aliases,
  e.tagline,
  e.keys,
  e.content,
  e.retired,
  e.featured === true,
  e.arc,
  e.prov.formerNames ?? [],
];

/**
 * Equal before and after the dry run → the verb would change nothing (the lead's rulings H and I).
 * Compared with the merge's bounded comparison (merge.ts sameData: no recursion past its depth bound,
 * whatever the depth of the data); the data on its own, so the bound falls where the merge's does.
 */
export const sameEntry = (a: CEntry | undefined, b: CEntry | undefined): boolean =>
  a !== undefined && b !== undefined && sameData(a.data, b.data) && sameData(entryState(a), entryState(b));

/** An alias list as the fold keeps it beside `name` (apply.ts aliasList): trimmed; blanks, repeats and the name itself dropped. */
function aliasesBeside(list: readonly string[], name: string): string[] {
  const seen = new Set([normalizeName(name)]);
  const out: string[] = [];
  for (const a of list) {
    const n = normalizeName(a);
    if (n === '' || seen.has(n)) continue;
    seen.add(n);
    out.push(a.trim());
  }
  return out;
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** The spelling of `e`'s name, title, topic, alias or former name whose normalized form is `n` (entryNames' order). */
function spelling(e: CEntry, n: string): string {
  for (const v of [e.name, e.data.title, e.data.topic, ...e.aliases, ...(e.prov.formerNames ?? [])]) {
    if (typeof v === 'string' && normalizeName(v) === n) return v.trim();
  }
  return n;
}

/**
 * The lead's rulings (H, I): one name per live entry of a type. The first live entry of `e`'s type
 * other than `e` answering to one of `names` (normalized), with that name; null when none. Summaries
 * never merge by name, so their titles are free (null).
 */
function nameTaken(c: CompendiumView, e: CEntry, names: readonly string[]): { other: CEntry; name: string } | null {
  if (e.type === null || e.type === 'summary' || names.length === 0) return null;
  for (const other of c.entries.values()) {
    if (other.key === e.key || other.retired || other.type !== e.type) continue;
    const theirs = entryNames(other);
    const name = names.find((n) => theirs.includes(n));
    if (name !== undefined) return { other, name };
  }
  return null;
}

/** The names `after` answers to that `before` did not (normalized). */
const newNames = (before: CEntry, after: CEntry): string[] => {
  const had = entryNames(before);
  return entryNames(after).filter((n) => !had.includes(n));
};

/** The entry and change the row at `seq` made (its op 0; an arc that creates its plot: `created`, then `arc`). */
function rowEffect(c: CompendiumView, seq: number): { effect: OpEffect; entry: CEntry } | null {
  const effect = c.effects.filter((x) => x.seq === seq && x.op === 0).at(-1);
  const entry = effect ? c.entries.get(effect.key) : undefined;
  return effect && entry ? { effect, entry } : null;
}

/**
 * A new session's first entries: the card greetings (identity macros expanded; blank ones skipped,
 * there is nothing to show) as sibling roots, then a `head` back on greeting 0, since each msg moves
 * the head onto itself (§5.5).
 */
function greetingEntries(ctx: EngineCtx, header: SessionHeader, now: string): EntryInput[] {
  const { character, persona } = header.cast;
  const run = createMacroRun({
    char: character.name,
    user: persona?.name || 'User',
    card: {
      description: character.description ?? '',
      personality: character.personality ?? '',
      scenario: character.scenario ?? '',
      examples: character.examples ?? '',
      systemPrompt: character.systemPrompt ?? '',
      postHistory: character.postHistory ?? '',
      firstMessage: character.greetings[0] ?? '',
    },
    persona: persona?.description ?? '',
    vars: {},
    now,
    timeZone: ctx.timeZone,
    seed: 0,
    sessionId: header.id,
  });
  const out: EntryInput[] = [];
  const ids: string[] = [];
  for (const text of character.greetings) {
    if (typeof text !== 'string' || text.trim() === '') continue;
    let id = newMessageId(ctx.random);
    // A duplicate id would silently vanish from the tree; 8 hex practically never collide.
    for (let i = 1; ids.includes(id); i++) {
      if (i >= ID_ATTEMPTS) throw new Error('could not find a free message id');
      id = newMessageId(ctx.random);
    }
    ids.push(id);
    out.push({ t: 'msg', ts: now, id, parent: null, role: 'assistant', gen: { kind: 'greeting' }, blocks: [{ k: 'text', text: run.userText(text) }] });
  }
  if (ids.length >= 2) out.push({ t: 'head', ts: now, leaf: ids[0]! });
  return out;
}

export class SessionImpl implements SessionHandle, TurnHost, RecoverJournal, LaneHost {
  readonly id: string;
  private ver: number;
  /** seq of the newest mem row: mem rows change the Compendium but not the version (§5.8 "Стоимость"). */
  private memSeq: number;
  /** M5b: seq of the newest job row (TreeIndex.jobs; job rows move neither the version nor memSeq). */
  private jobSeq = 0;
  private treeCache: { version: number; memSeq: number; jobSeq: number; idx: TreeIndex } | null = null;
  private viewCache: { version: number; memSeq: number; seed: LibrarySeed; view: PathView } | null = null;
  /** D-141: the books as last loaded, with the key they were loaded under (libraryKey). */
  private libCache: { key: string; lib: SessionLibrary; categories?: ReadonlyMap<string, string> } | null = null;
  private config: SessionConfig;
  private running: TurnRun | null = null;
  /** Turns left open with a `held` answer (M6 decides them); new turns are refused meanwhile. */
  private readonly held = new Set<string>();
  private readonly turnIds = new Set<string>();
  private readonly noticed = new Set<string>();
  /**
   * The next turn's seed, drawn early by a preview of it and kept until a turn takes it, so what is
   * seeded ({{random}}, {{pick}}, lore chance and groups) comes out in the turn as the preview showed.
   */
  private nextSeed: number | null = null;
  private readonly opened: Event[] = [];
  private closing: Promise<void> | null = null;
  /** M5b (D-171): the session's background lane (filing, the historian). */
  private readonly lane: Lane;

  private constructor(
    private readonly ctx: EngineCtx,
    private readonly log: SessionLog,
    private readonly onClose: (s: SessionImpl) => void,
  ) {
    this.id = log.id;
    const entries = log.entries();
    const tree = buildTree(entries);
    this.ver = tree.version;
    this.memSeq = tree.lastMemSeq;
    this.config = currentConfig(log.header, entries);
    for (const e of entries) if (e.t === 'turn') this.turnIds.add(e.turn);
    this.lane = new Lane(ctx, this, ctx.lane);
  }

  // ---- construction -----------------------------------------------------------------------------

  /**
   * New session file: header, greetings as sibling roots, head on greeting 0 (§5.5). The whole
   * first state is one file made visible at once (createSessionLogWith), so a crash never leaves a
   * listed session without its greetings or with the head on the wrong one.
   */
  static create(ctx: EngineCtx, input: CreateSessionInput, onClose: (s: SessionImpl) => void): SessionImpl {
    if (!isObject(input) || !isObject(input.character)) throw new Refusal('invalid_params', 'createSession needs a character');
    const { character, persona } = input;
    const config = mergePatch<SessionConfig>(DEFAULT_SESSION_CONFIG, input.config);
    const created = isoNow(ctx);
    let log: SessionLog | null = null;
    for (let i = 0; i < ID_ATTEMPTS && !log; i++) {
      const header: SessionHeader = {
        t: 'session',
        v: 1,
        id: newSessionId(ctx.random),
        created,
        title: input.title ?? character.name,
        cast: persona ? { character, persona } : { character },
        config,
      };
      const checked = checkHeader(JSON.parse(JSON.stringify(header)) as unknown);
      if (!checked.ok) throw new Refusal('invalid_params', `invalid session: ${checked.why}`);
      try {
        log = createSessionLogWith(ctx.home, header, greetingEntries(ctx, header, created));
      } catch (e) {
        // Only an id collision is worth another draw; anything else is real trouble.
        if (!(e instanceof Error) || !e.message.startsWith('session already exists')) throw e;
      }
    }
    if (!log) throw new Error('could not find a free session id');
    const s = new SessionImpl(ctx, log, onClose);
    s.lane.open();
    return s;
  }

  /** Open an existing session: lock, read, recover (§6.7). */
  static open(ctx: EngineCtx, id: string, onClose: (s: SessionImpl) => void): SessionImpl {
    let opened: ReturnType<typeof openSessionLog>;
    try {
      opened = openSessionLog(ctx.home, id);
    } catch (e) {
      if (e instanceof SessionLockedError) throw new Refusal('session_locked', e.message);
      if (e instanceof SessionNotFoundError) throw new Refusal('session_not_found', e.message);
      throw e;
    }
    const s = new SessionImpl(ctx, opened.log, onClose);
    for (const n of opened.notices) {
      s.openEvent({ type: 'notice', level: 'warn', code: n.code, message: n.message });
    }
    try {
      const report = recoverSession(s);
      for (const h of report.held) s.held.add(h);
      for (const ev of report.events) {
        // A notice told while opening counts as told for this open session (once-per-session codes).
        if (ev.type === 'notice') s.noticed.add(ev.code);
        s.openEvent(ev);
      }
      // M5b (D-171, ruling I): the lane's first look after the turns' recovery (a begin left by a
      // crash runs again when its key is still owed: the derivation is the lane's recovery).
      s.lane.open();
    } catch (e) {
      opened.log.close();
      throw e;
    }
    return s;
  }

  // ---- journal access (TurnHost / RecoverJournal) -------------------------------------------------

  get sessionId(): string {
    return this.id;
  }

  entries(): readonly Entry[] {
    return this.log.entries();
  }

  append<T extends EntryInput>(input: T, opts?: { durable?: boolean }): T & { seq: number } {
    const e = this.log.append(input, opts);
    const t = (e as { t: EntryKind }).t;
    if (VERSIONED_KINDS.has(t)) this.ver = e.seq;
    else if (t === 'mem') this.memSeq = e.seq;
    else if (t === 'job') this.jobSeq = e.seq;
    return e;
  }

  /**
   * A verb's single write. The log refuses it before writing anything when the lock was lost (the
   * process was suspended past the TTL and another one took the session), so it surfaces as the
   * refusal it is (§6.1), not as an internal error.
   */
  private verbAppend<T extends EntryInput>(input: T): T & { seq: number } {
    try {
      return this.append(input);
    } catch (e) {
      if (e instanceof SessionLockedError) throw new Refusal('session_locked', `another process took this session over: ${e.message}`);
      throw e;
    }
  }

  now(): string {
    return isoNow(this.ctx);
  }

  datasync(): void {
    this.log.datasync();
  }

  tree(): TreeIndex {
    // Versioned entries change the tree, mem rows its `mems` and job rows its `jobs` (M5b): (version,
    // memSeq, jobSeq) is a complete key.
    const c = this.treeCache;
    if (c?.version === this.ver && c.memSeq === this.memSeq && c.jobSeq === this.jobSeq) return c.idx;
    const idx = buildTree(this.log.entries());
    this.treeCache = { version: this.ver, memSeq: this.memSeq, jobSeq: this.jobSeq, idx };
    return idx;
  }

  /**
   * D-141: config.lorebooks loaded, and the Compendium's seed made from them; loaded again only when
   * the ids, the Compendium's on/off or books table, or a book file (mtime, size) changed, so the seed
   * object stays the same while nothing did (the fold caches on it).
   */
  library(): SessionLibrary {
    const key = libraryKey(this.ctx.home, this.config);
    if (this.libCache?.key !== key) this.libCache = { key, lib: loadLibrary(this.ctx.home, this.config, this.log.header.cast) };
    return this.libCache.lib;
  }

  firstNotice(code: string): boolean {
    if (this.noticed.has(code)) return false;
    this.noticed.add(code);
    return true;
  }

  turnEnded(run: TurnRun): void {
    if (this.running === run) this.running = null;
    this.lane.touch();
  }

  /** M5b: after the turn's terminal event, the lane looks again (a committed answer may be accepted, D-171). */
  turnSettled(): void {
    this.lane.poke();
  }

  // ---- reading -----------------------------------------------------------------------------------

  header(): SessionHeader {
    return this.log.header;
  }

  version(): number {
    return this.ver;
  }

  view(): PathView {
    // Cached like the tree: a mem row (a note) changes view().compendium without a new version, and
    // so does a change of the library's books (a new seed, D-141).
    const seed = this.library().seed;
    const c = this.viewCache;
    if (c?.version === this.ver && c.memSeq === this.memSeq && c.seed === seed) return c.view;
    const view = foldView(this.log.header, this.log.entries(), this.tree(), { library: seed });
    this.viewCache = { version: this.ver, memSeq: this.memSeq, seed, view };
    return view;
  }

  busy(): boolean {
    return this.running !== null;
  }

  openEvents(): Event[] {
    return [...this.opened];
  }

  /** The session's current config (header + config entries). */
  currentConfig(): SessionConfig {
    return this.config;
  }

  // ---- verbs -------------------------------------------------------------------------------------

  send(input: { text: string; expectedVersion: number; greetingIndex?: number }): { messageId: string; version: number } {
    const sent = this.sendLine(input);
    // The answer before it may be accepted now (filing.wait ≥ 1, D-171).
    this.lane.poke();
    return sent;
  }

  /** send() without the lane's look (submit gives the lane its look once the turn is registered). */
  private sendLine(input: { text: string; expectedVersion: number; greetingIndex?: number }): { messageId: string; version: number } {
    this.guardWrite(input?.expectedVersion, { held: true });
    if (typeof input.text !== 'string') throw new Refusal('invalid_params', 'text must be a string');
    const idx = this.tree();
    let parent: string | null = idx.head;
    if (input.greetingIndex !== undefined) {
      const gi = input.greetingIndex;
      if (!Number.isInteger(gi) || gi < 0) throw new Refusal('invalid_params', 'greetingIndex must be a non-negative integer');
      const greetings = (idx.children.get(null) ?? []).filter((id) => idx.msgs.get(id)?.gen?.kind === 'greeting');
      const g = greetings[gi];
      if (g === undefined) throw new Refusal('not_found', `there is no greeting ${gi}`);
      parent = g;
    }
    const id = this.freshMessageId();
    // One line: the new message moves the head itself, so the send is atomic (§5.5).
    this.verbAppend({ t: 'msg', ts: this.now(), id, parent, role: 'user', blocks: [{ k: 'text', text: input.text }] });
    this.publish({ type: 'changed', version: this.ver, change: 'msg', id });
    return { messageId: id, version: this.ver };
  }

  runTurn(opts: RunTurnOptions): TurnHandle {
    this.assertOpen();
    const plan = admitTurn(
      this.ctx,
      { busy: this.running !== null, heldOpen: this.held.size > 0, version: this.ver, view: this.view(), config: this.config },
      opts,
    );
    // §6.2 step 2: the `turn` line (fsync), the controller, `start`.
    const now = this.now();
    const turnId = this.freshTurnId();
    const msgId = plan.kind === 'continue' ? plan.target! : this.freshMessageId();
    const entry = this.verbAppend({
      t: 'turn',
      ts: now,
      turn: turnId,
      kind: plan.kind,
      parent: plan.parent,
      ...(plan.target !== undefined ? { target: plan.target } : {}),
      msgId,
      // The seed a preview already drew for this turn, else a fresh one (§6.2 step 2).
      seed: this.nextSeed ?? newSeed(this.ctx.random),
      now,
      base: this.ver,
    });
    this.nextSeed = null;
    const run = new TurnRun(this, this.ctx, plan, entry);
    this.running = run;
    run.emit({ type: 'start', turnId, kind: plan.kind, messageId: msgId, parentId: plan.parent });
    // D-172: a swipe or a continue is activity on the session's origins (the idle gate).
    this.lane.touch();
    void run.run();
    return {
      turnId,
      messageId: msgId,
      events: run.events,
      result: run.result,
      stop: () => this.stop(turnId),
    };
  }

  submit(input: { text: string; expectedVersion: number; onError?: 'drop' | 'keep' }): TurnHandle {
    // Everything that does not depend on the new message is checked first, so a refusal writes
    // nothing at all (not even the user's line).
    this.guardWrite(input?.expectedVersion, { held: true });
    if (typeof input.text !== 'string') throw new Refusal('invalid_params', 'text must be a string');
    // runTurn's own params, validated as admitTurn will (§6.1: a refusal writes nothing).
    const onError = checkOnError(input.onError);
    resolvePrimary(this.ctx, this.config);
    resolvePreset(this.ctx, this.config.preset);
    const sent = this.sendLine({ text: input.text, expectedVersion: input.expectedVersion });
    // The lane looks once the turn is registered: it starts nothing before the turn settles.
    try {
      return this.runTurn({ kind: 'reply', expectedVersion: sent.version, onError });
    } finally {
      this.lane.poke();
    }
  }

  stop(turnId?: string): void {
    const run = this.running;
    if (!run) return;
    if (turnId !== undefined && turnId !== run.turnId) return;
    run.stop('user_stop');
  }

  edit(input: { messageId: string; text: string; expectedVersion: number }): { version: number } {
    this.guardWrite(input?.expectedVersion);
    if (typeof input.text !== 'string') throw new Refusal('invalid_params', 'text must be a string');
    const idx = this.tree();
    this.mustExist(idx, input.messageId);
    // Non-text blocks (reasoning, tool rounds) stay; the text becomes the one new block.
    const keep = effectiveMessage(idx, input.messageId).blocks.filter((b) => b.k !== 'text');
    this.verbAppend({ t: 'edit', ts: this.now(), target: input.messageId, reason: 'user', blocks: [...keep, { k: 'text', text: input.text }] });
    this.publish({ type: 'changed', version: this.ver, change: 'edit', id: input.messageId });
    this.laneActivity();
    return { version: this.ver };
  }

  hide(input: { messageId: string; hidden: boolean; expectedVersion: number }): { version: number } {
    this.guardWrite(input?.expectedVersion);
    if (typeof input.hidden !== 'boolean') throw new Refusal('invalid_params', 'hidden must be a boolean');
    this.mustExist(this.tree(), input.messageId);
    this.verbAppend({ t: 'hide', ts: this.now(), target: input.messageId, hidden: input.hidden });
    this.publish({ type: 'changed', version: this.ver, change: 'hide', id: input.messageId });
    this.laneActivity();
    return { version: this.ver };
  }

  select(input: { messageId: string; expectedVersion: number; exact?: boolean }): { version: number } {
    this.guardWrite(input?.expectedVersion);
    if (input.exact !== undefined && typeof input.exact !== 'boolean') throw new Refusal('invalid_params', 'exact must be a boolean');
    const idx = this.tree();
    this.mustExist(idx, input.messageId);
    // exact: a rewind puts the head on the message itself (§5.5); else the newest message below it.
    const leaf = input.exact === true ? input.messageId : newestDescendant(idx, input.messageId);
    if (leaf === idx.head) return { version: this.ver }; // already there: no line, no new version
    this.verbAppend({ t: 'head', ts: this.now(), leaf });
    this.publish({ type: 'changed', version: this.ver, change: 'head', id: leaf });
    this.laneActivity();
    return { version: this.ver };
  }

  fork(input: { at: string }): string {
    this.assertOpen();
    if (this.running) throw new Refusal('session_busy', 'a turn is running');
    if (!isObject(input) || typeof input.at !== 'string') throw new Refusal('invalid_params', 'fork needs {at}');
    this.mustExist(this.tree(), input.at);
    for (let i = 0; i < ID_ATTEMPTS; i++) {
      const newId = newSessionId(this.ctx.random);
      try {
        const log = forkSession(this.ctx.home, { header: this.log.header, entries: this.log.entries() }, input.at, { newId, now: this.now() });
        log.close(); // not opened: the caller opens it with engine.session(id)
        return newId;
      } catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith('session already exists')) throw e;
      }
    }
    throw new Error('could not find a free session id for the fork');
  }

  /**
   * M2 (§6.1, §12.4 /preview): the request a turn would send, built by the turn's own buildRequest.
   * Refusals come back as ok:false; nothing is written, the version and the head stay, the
   * session's once-per-session notices stay untold (a preview shows every notice). Works while a
   * turn runs: it reads the current view.
   */
  preview(opts?: PreviewOptions): PreviewResult {
    this.assertOpen();
    try {
      return this.buildPreview(opts ?? {});
    } catch (e) {
      if (e instanceof Refusal) return { ok: false, code: e.code, message: e.message };
      throw e;
    }
  }

  private buildPreview(opts: PreviewOptions): PreviewResult {
    if (!isObject(opts)) throw new Refusal('invalid_params', 'preview options must be an object');
    if (opts.draft !== undefined && typeof opts.draft !== 'string') throw new Refusal('invalid_params', 'draft must be a string');
    if (opts.turn !== undefined && typeof opts.turn !== 'string') throw new Refusal('invalid_params', 'turn must be a message id');
    if (opts.explain !== undefined && typeof opts.explain !== 'boolean') throw new Refusal('invalid_params', 'explain must be a boolean');
    if (opts.draft !== undefined && opts.turn !== undefined) throw new Refusal('invalid_params', 'draft and turn exclude each other');

    const header = this.log.header;
    const tree = this.tree();
    const library = this.library();
    const current = this.view();
    let view = current;
    // The kind admission checks, and the kind the request is built as (a past swipe is admitted as
    // the reply to its U: same prompt).
    let admitKind: TurnKind;
    let kind: TurnKind | undefined;
    // A past answer's own seed; else the next turn's, drawn once admission passed.
    let seed: number | undefined;
    let now: string;
    let past: Trace | undefined;
    let guided: { guidance: string; rejected?: string } | undefined;

    if (opts.turn !== undefined) {
      // A past answer: the path up to the user message it answers, that turn's seed and clock.
      const id = opts.turn;
      const entry = tree.msgs.get(id);
      if (!entry) throw new Refusal('not_found', `no message ${id}`);
      const m = current.path.find((x) => x.id === id);
      if (!m) throw new Refusal('invalid_params', `message ${id} is not on the active path`);
      if (m.role !== 'assistant' || m.parent === null || entry.gen?.kind !== 'model' || !entry.trace) {
        throw new Refusal('invalid_params', `message ${id} is not a model answer with a trace`);
      }
      past = entry.trace;
      seed = past.seed;
      now = past.now;
      view = foldViewAt(header, tree, m.parent, { library: library.seed });
      admitKind = 'reply';
      kind = m.swipe.index > 0 ? 'swipe' : 'reply';
      // A guided re-roll is rebuilt with its direction (gen.guidance) and, when today's config shows
      // it, the text of the answer it replaced (the turn's target) as that answer reads now.
      const guidance = entry.gen.guidance;
      if (guidance) {
        guided = { guidance };
        const turn = entry.turn === undefined ? undefined : this.log.entries().find((e) => e.t === 'turn' && e.turn === entry.turn);
        const target = turn?.t === 'turn' ? turn.target : undefined;
        if (this.config.swipe.showRejected && target !== undefined && tree.msgs.has(target)) guided.rejected = effectiveText(tree, target);
      }
    } else if (opts.draft !== undefined) {
      view = withDraft(current, opts.draft);
      admitKind = 'reply';
      now = this.now();
    } else {
      // What the next turn would be: a reply to a user head, else a swipe of the head answer (/r).
      admitKind = current.path.at(-1)?.role === 'user' ? 'reply' : 'swipe';
      now = this.now();
    }

    // The turn's admission (§6.2 step 1), minus what is about writing: a preview never waits for a
    // running turn or a held answer, and has no version to be stale against.
    const admitted = admitTurn(this.ctx, { busy: false, heldOpen: false, version: this.ver, view, config: this.config }, { kind: admitKind, expectedVersion: this.ver });
    const plan = kind === undefined ? admitted : { ...admitted, kind, ...guided };
    seed ??= this.seedOfNextTurn();
    const explain = opts.explain === true;
    const placements = this.previewDirective(tree, plan, opts.turn);

    const built = buildRequest({
      home: this.ctx.home,
      sessionId: this.id,
      header,
      tree,
      view,
      plan,
      seed,
      now,
      timeZone: this.ctx.timeZone,
      counter: this.ctx.counter,
      // M4 (D-106): the Director is never called by a preview.
      placements,
      library,
      ...(explain ? { explain: true } : {}),
      ...(this.ctx.toolSets ? { toolSets: this.ctx.toolSets } : {}),
    });
    if (!built.ok) {
      // A shape failure is the request failing to build, as assemble's own.
      return { ok: false, code: built.code === 'shape_failed' ? 'assemble_failed' : built.code, message: built.message };
    }

    // Every notice once (by its key), none of them marked as told: the next turn still tells them.
    const notices: Notice[] = [];
    const keys = new Set<string>();
    for (const n of built.notices) {
      if (keys.has(n.key)) continue;
      keys.add(n.key);
      notices.push(n.notice);
    }
    const native = built.tools?.transport === 'native' ? built.tools.specs : undefined;
    const sent = traceForSent(built.asm.trace, built.shaped.messages, built.shaped.prefill, native);
    if (past && opts.turn !== undefined) {
      const answer = tree.msgs.get(opts.turn)!;
      const was = answer.gen;
      const named = inputsChanged(past, built.asm.trace);
      const changed = [
        ...named,
        ...sentChanged(past, sent, {
          history: historyChangedSince(this.log.entries(), tree, header, answer.parent!, answer.seq, library.seed),
          presetOrBooks: named.length > 0,
          compendium: compendiumChanged(past, built.asm.trace),
          presetChanged: past.presetHash !== built.asm.trace.presetHash,
          model: {
            ...(was?.connection !== undefined ? { past: `${was.connection}:${was.model ?? '?'}` } : {}),
            now: `${plan.primary.conn.id}:${plan.primary.model}`,
          },
        }),
      ];
      if (changed.length > 0) {
        notices.push({
          level: 'info',
          code: 'preview_inputs_changed',
          message: `Since this answer was written, ${changed.join(', ')} changed: the preview is built with today's.`,
        });
      }
    }

    const { primary } = plan;
    const { asm, shaped } = built;
    const maxTokens = maxTokensFor(primary, built.reserve);
    const samplers = built.limits.samplers;
    const prefill = shaped.prefill !== undefined && shaped.prefill !== '' ? shaped.prefill : null;
    const out: Extract<PreviewResult, { ok: true }> = {
      ok: true,
      kind: plan.kind,
      upTo: plan.upTo,
      model: { connection: primary.conn.id, model: primary.model },
      messages: shaped.messages,
      prefill,
      tools: asm.tools,
      maxTokens,
      samplers,
      trace: sent,
      notices,
    };
    if (explain) {
      out.verdicts = asm.verdicts ?? [];
      if (asm.loreUse) out.loreUse = asm.loreUse;
    }
    // What the connection drops from the request (openai-chat samplerFields / stopField read the same caps).
    const spec = primary.caps.samplers;
    const notSent = Object.keys(samplers).filter((k) => (samplers as Record<string, unknown>)[k] !== undefined && (spec.fixed === true || !spec.accepted.includes(k)));
    if (notSent.length > 0) out.samplersNotSent = notSent;

    // The HTTP body the primary connection would send (no headers: they carry the key): round 0 of
    // the turn, its tools, tool_choice, stop list and reasoning setting included (M3).
    const provider = primary.conn.provider;
    if (provider.wire) {
      const reasoning = plan.binding.reasoning;
      const req = modelRequest(
        {
          conn: primary.conn,
          model: primary.model,
          caps: primary.caps,
          messages: shaped.messages,
          ...(shaped.prefill !== undefined && built.tools === null ? { prefill: shaped.prefill } : {}),
          maxTokens,
          samplers,
          ...(reasoning ? { reasoning } : {}),
          callKey: 'preview:narrator:0',
          ...roundFields(built.tools, primary.caps, samplers, firstRoundLast(built.tools, plan.maxRounds)),
        },
        new AbortController().signal,
      );
      try {
        out.wire = provider.wire(req);
      } catch (e) {
        notices.push({ level: 'warn', code: 'wire_unavailable', message: `The wire request cannot be built: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    return out;
  }

  /**
   * M4 (D-106): the depth-1 directive a preview shows. A past answer (`turn`): its stored directive,
   * re-rendered, so /trace and /preview --turn show what was sent (whatever the Director's setting is
   * today). The next turn, while the Director is on: the replaced answer's directive when the swipe
   * would reuse its plan, else the stub.
   */
  private previewDirective(tree: TreeIndex, plan: { kind: TurnKind; target?: string; guidance?: string; config: SessionConfig }, turn: string | undefined): DepthInsert[] {
    if (turn !== undefined) return directiveInsert(checkRecord(tree.msgs.get(turn)?.dir)?.directive);
    if (plan.config.director?.enabled !== true) return [];
    if (plan.kind === 'swipe' && plan.target !== undefined && swipeReuses(plan.config, plan.guidance)) {
      const reused = reusedRecord(tree, plan.target, this.log.header.cast.persona);
      if (reused !== null) return directiveInsert(reused.directive);
    }
    return stubInsert();
  }

  configure(patch: DeepPartial<SessionConfig>): void {
    this.assertOpen();
    if (this.running) throw new Refusal('session_busy', 'a turn is running');
    if (!isObject(patch)) throw new Refusal('invalid_params', 'configure needs an object');
    // The header reads `compendium` leniently (an old header must open), so what is written is checked here.
    const problem = Object.hasOwn(patch, 'compendium') ? compendiumPatchProblem(patch.compendium) : null;
    if (problem !== null) throw new Refusal('invalid_params', `invalid config: ${problem}`);
    const next = mergePatch<SessionConfig>(this.config, patch);
    // A patch that would make the config unreadable is refused before it reaches the journal.
    const checked = checkHeader(JSON.parse(JSON.stringify({ ...this.log.header, config: next })) as unknown);
    if (!checked.ok) throw new Refusal('invalid_params', `invalid config: ${checked.why}`);
    this.verbAppend({ t: 'config', ts: this.now(), patch });
    this.config = next;
    // D-171: the Compendium switched, filing or the historian changed: the lane's work is derived again.
    this.lane.poke();
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      // M5b (D-171): the lane first, so nothing it does lands after the log is closed.
      await this.lane.close();
      const run = this.running;
      if (run) {
        run.stop('shutdown');
        await run.result;
      }
      this.log.close();
      this.onClose(this);
    })();
    return this.closing;
  }

  // ---- helpers -----------------------------------------------------------------------------------

  /** The next turn's seed, drawn once and kept for it (only a turn's `turn` line consumes it). */
  private seedOfNextTurn(): number {
    this.nextSeed ??= newSeed(this.ctx.random);
    return this.nextSeed;
  }

  private assertOpen(): void {
    if (this.closing) throw new Error(`session ${this.id} is closed`);
  }

  /** busy → held → version, the shared preconditions of every write verb. */
  private guardWrite(expectedVersion: unknown, opts: { held?: boolean } = {}): void {
    this.assertOpen();
    if (this.running) throw new Refusal('session_busy', 'a turn is running');
    if (opts.held && this.held.size > 0) throw new Refusal('held_pending', 'an answer held by a conflict must be decided first');
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion)) {
      throw new Refusal('invalid_params', 'expectedVersion must be an integer');
    }
    if (expectedVersion !== this.ver) throw new Refusal('stale_version', `expected version ${expectedVersion}, the session is at ${this.ver}`);
  }

  private mustExist(idx: TreeIndex, id: unknown): void {
    if (typeof id !== 'string' || !idx.msgs.has(id)) throw new Refusal('not_found', `no message ${String(id)}`);
  }

  /** A message id not used in this session (a duplicate would silently vanish from the tree). */
  private freshMessageId(): string {
    const idx = this.tree();
    for (let i = 0; i < ID_ATTEMPTS; i++) {
      const id = newMessageId(this.ctx.random);
      if (!idx.msgs.has(id)) return id;
    }
    throw new Error('could not find a free message id');
  }

  private freshTurnId(): string {
    for (let i = 0; i < ID_ATTEMPTS; i++) {
      const id = newTurnId(this.ctx.random);
      if (!this.turnIds.has(id)) {
        this.turnIds.add(id);
        return id;
      }
    }
    throw new Error('could not find a free turn id');
  }

  private stamp(body: EventBody): Event {
    return { sessionId: this.id, ts: this.now(), ...body } as Event;
  }

  /** A session-level event (no turn): engine.events() only. The lane's events come here too (LaneHost). */
  publish(body: EventBody): void {
    this.ctx.bus.publish(this.stamp(body));
  }

  /** D-172: an edit, a hide or a head move is activity on the session's origins, and the lane's work may change (D-171). */
  private laneActivity(): void {
    this.lane.touch();
    this.lane.poke();
  }

  /** An event produced while opening: kept for openEvents() and published. */
  private openEvent(body: EventBody): void {
    const ev = this.stamp(body);
    this.opened.push(ev);
    this.ctx.bus.publish(ev);
  }

  // ---- M3: history search and notes (§7.5, §5.8) ----------------------------------------------------

  /**
   * §7.5 /search: the narrator's search_history over the current path (read-only, also while a turn
   * runs). A hit is "in context" when the head answer's request sent it; unknown counts as not.
   */
  search(input: { query: string; before?: number; limit?: number }): HistorySearch {
    this.assertOpen();
    if (!isObject(input) || typeof input.query !== 'string') throw new Refusal('invalid_params', 'search needs {query}');
    const { before, limit } = input;
    if (before !== undefined && !(Number.isSafeInteger(before) && before >= 1)) throw new Refusal('invalid_params', 'before must be a positive integer');
    if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1)) throw new Refusal('invalid_params', 'limit must be a positive integer');
    const view = this.view();
    const sent = sentByHeadRequest(view, this.tree());
    const { character, persona } = this.log.header.cast;
    return searchHistory(view, null, input.query, {
      ...(before !== undefined ? { before } : {}),
      ...(limit !== undefined ? { limit } : {}),
      names: { char: character.name, user: persona?.name || 'User' },
      inContext: (id) => sent?.has(id) === true,
    });
  }

  notes(): CEntry[] {
    this.assertOpen();
    return noteRefs(this.view().compendium).map((r) => r.entry);
  }

  memoryAdd(input: { title: string; keys?: string[]; content: string }): MemoryWrite {
    this.guardMemory();
    if (!isObject(input)) throw new Refusal('invalid_params', 'memoryAdd needs {title, content}');
    const title = noteTitle(input.title);
    const content = noteContent(input.content);
    const keys = noteKeys(input.keys) ?? [];
    const op: MemOp = { op: 'note', title, keys: keys.length > 0 ? keys : [title], content };
    this.dryRun(op);
    // The fold names the note (its key may carry '#2' when the title's key is taken).
    const { entry } = this.memWrite(op);
    this.publishMemory('note', entry);
    return { key: entry.key, changed: true, ...this.untold() };
  }

  memoryFile(input: { type: EntryType; data: Rec }): MemoryWrite & { ref: string; change: 'created' | 'merged' } {
    this.guardMemory();
    if (!isObject(input)) throw new Refusal('invalid_params', 'memoryFile needs {type, data}');
    if (!isEntryType(input.type)) throw new Refusal('invalid_params', `unknown entry type ${JSON.stringify(input.type)}; one of ${ENTRY_TYPES.join(', ')}`);
    if (!isObject(input.data)) throw new Refusal('invalid_params', 'data must be an object');
    const data = jsonCopy(input.data);
    // While the Compendium is off the books seed nothing, so a name a readable book already has would
    // make a second entry that shares it once the Compendium is on again (the lead's ruling I).
    if (compendiumConfigOf(this.config).enabled === false) {
      const names = [data[identityField(input.type)], ...(Array.isArray(data.aliases) ? data.aliases : [])].filter((n): n is string => typeof n === 'string');
      const hit = findMatch(this.readableSeed().entries, input.type, names);
      if (hit && hit.origin.kind === 'library') {
        throw new Refusal(
          'invalid_params',
          `${JSON.stringify(hit.name)} is an entry of the book ${hit.origin.book}, which the Compendium reads when it is on; turn it on (/memory on) and edit that entry instead`,
        );
      }
    }
    // D-168: the name decides once, here (matching, classic_conflict, required fields); the row then
    // names the key it produced, and the pinned row is what the dry run checks and the log keeps.
    const ts = this.now();
    const named = this.dryRun({ op: 'file', type: input.type, data }, ts);
    const target = named.effect.key;
    const op: MemOp = { op: 'file', type: input.type, data, target };
    const pinned = this.dryRun(op, ts);
    if (pinned.effect.key !== target) throw new Error(`the pinned file op went to ${pinned.effect.key}, not to ${target}`);
    const how = pinned.effect.change === 'merged' ? 'merged' : 'created';
    const before = this.view().compendium;
    const was = before.entries.get(target);
    if (how === 'merged' && sameEntry(was, pinned.entry)) {
      return { key: target, ref: refOf(before, target) ?? target, change: 'merged', changed: false, ...this.untold() };
    }
    // The lead's ruling (I): a merge that gives the entry a name (an alias) another live entry of the type answers to is refused.
    const taken = how === 'merged' && was ? nameTaken(before, was, newNames(was, pinned.entry)) : null;
    if (taken && was) {
      throw new Refusal(
        'invalid_params',
        `${this.label(before, taken.other)} already answers to the name ${JSON.stringify(spelling(pinned.entry, taken.name))}; filing it into ${this.label(before, was)} would give a ${input.type} a name another ${input.type} has`,
      );
    }
    const { entry, c } = this.memWrite(op);
    this.publishMemory(how, entry);
    return { key: entry.key, ref: refOf(c, entry.key) ?? entry.key, change: how, changed: true, ...this.untold() };
  }

  memoryEdit(input: { ref: string; title?: string; keys?: string[]; content?: string; set?: Rec; unset?: string[]; featured?: boolean }): MemoryWrite {
    this.guardMemory();
    if (!isObject(input)) throw new Refusal('invalid_params', 'memoryEdit needs {ref}');
    if (input.featured !== undefined && typeof input.featured !== 'boolean') throw new Refusal('invalid_params', 'featured must be true or false');
    const keys = noteKeys(input.keys);
    const featured = input.featured === undefined ? {} : { featured: input.featured };
    const e = this.findEntry(input.ref, 'live');
    const c = this.view().compendium;
    const ref = this.label(c, e);

    if (isNote(e)) {
      if (input.set !== undefined || input.unset !== undefined) throw new Refusal('invalid_params', `${ref} is a note: change its title, keys or content`);
      const title = input.title === undefined ? undefined : noteTitle(input.title);
      const content = input.content === undefined ? undefined : noteContent(input.content);
      if (title === undefined && content === undefined && keys === undefined && input.featured === undefined) {
        throw new Refusal('invalid_params', 'nothing to change: give a title, keys, content or featured');
      }
      const set: Record<string, unknown> = {};
      if (title !== undefined) set.title = title;
      if (content !== undefined) set.content = content;
      // A rename without keys moves the key a keyless add derived from the title (stored keys exactly
      // [old title]) to the new title, so the note fires on its new name; keys the user wrote stay.
      const autoKey = keys === undefined && title !== undefined && title !== e.name && e.keys.length === 1 && e.keys[0] === e.name;
      return this.editWith(e, {
        op: 'edit',
        ref: e.key,
        ...(Object.keys(set).length > 0 ? { set } : {}),
        // Keys emptied by the trim fall back to the title, as on add.
        ...(keys !== undefined ? { keys: keys.length > 0 ? keys : [title ?? e.name] } : autoKey ? { keys: [title] } : {}),
        ...featured,
      });
    }

    // A typed entry, a library entry (an overlay from now on) or an arc: set / unset / keys / featured.
    if (input.title !== undefined || input.content !== undefined) {
      throw new Refusal('invalid_params', `${ref} is a ${entryKind(e)}: change it with set and unset (title and content are a note's)`);
    }
    if (input.set !== undefined && !isObject(input.set)) throw new Refusal('invalid_params', 'set must be an object of fields');
    if (input.unset !== undefined && !(Array.isArray(input.unset) && input.unset.every((k) => typeof k === 'string'))) {
      throw new Refusal('invalid_params', 'unset must be an array of field names');
    }
    const set = input.set === undefined ? undefined : jsonCopy(input.set);
    const unset = input.unset === undefined ? undefined : [...new Set(input.unset)];
    if ((set === undefined || Object.keys(set).length === 0) && (unset === undefined || unset.length === 0) && keys === undefined && input.featured === undefined) {
      throw new Refusal('invalid_params', 'nothing to change: give set, unset, keys or featured');
    }
    if (e.type !== null) {
      const idf = identityField(e.type);
      if (unset?.includes(idf)) throw new Refusal('invalid_params', `the ${idf} of a ${e.type} cannot be removed; rename it with set.${idf}`);
      const rename = set?.[idf];
      if (rename !== undefined && !(typeof rename === 'string' && normalizeName(rename) !== '')) {
        throw new Refusal('invalid_params', `a new ${idf} needs at least one letter or digit`);
      }
      if (set?.aliases !== undefined && !(Array.isArray(set.aliases) && set.aliases.every((a) => typeof a === 'string'))) {
        throw new Refusal('invalid_params', 'aliases must be a list of strings');
      }
      // The lead's ruling (I): the aliases the entry already shows (beside its name after this edit) are no change.
      if (set !== undefined && Array.isArray(set.aliases)) {
        const name = typeof rename === 'string' ? rename.trim() : e.name;
        if (sameStrings(aliasesBeside(set.aliases as string[], name), aliasesBeside(e.aliases, name))) delete set.aliases;
      }
      // The lead's ruling: a rename never takes a name another live entry of the type answers to
      // (its name, an alias, a former name): filing by that name would then find one of the two.
      if (typeof rename === 'string' && normalizeName(rename) !== normalizeName(e.name)) {
        const taken = nameTaken(c, e, [normalizeName(rename)]);
        if (taken) {
          throw new Refusal('invalid_params', `${this.label(c, taken.other)} already answers to the name ${JSON.stringify(rename.trim())}; a ${e.type} cannot be renamed to a name another ${e.type} has`);
        }
      }
    } else {
      if (set?.title !== undefined || set?.name !== undefined) throw new Refusal('invalid_params', `${ref} is an arc: its plot name cannot change`);
      const text = set?.content !== undefined ? set.content : set?.overview;
      if (text !== undefined && isBlank(text)) throw new Refusal('invalid_params', "an arc's overview cannot be blank");
      if (unset?.some((k) => k === 'content' || k === 'overview')) throw new Refusal('invalid_params', "an arc's overview cannot be removed");
    }
    if ((set === undefined || Object.keys(set).length === 0) && (unset === undefined || unset.length === 0) && keys === undefined && input.featured === undefined) {
      return { key: e.key, changed: false, ...this.untold() };
    }
    const op: MemOp = {
      op: 'edit',
      ref: e.key,
      ...(set !== undefined && Object.keys(set).length > 0 ? { set } : {}),
      ...(unset !== undefined && unset.length > 0 ? { unset } : {}),
      ...(keys !== undefined ? { keys } : {}),
      ...featured,
    };
    // The lead's ruling (I): a name the edit gives the entry (an alias, a title or topic field) that
    // another live entry of the type answers to is refused as a rename onto it is.
    return this.editWith(e, op, (after) => {
      const taken = nameTaken(c, e, newNames(e, after));
      if (taken) throw new Refusal('invalid_params', `${this.label(c, taken.other)} already answers to the name ${JSON.stringify(spelling(after, taken.name))}; a ${e.type} cannot take a name another ${e.type} has`);
    });
  }

  memoryRetire(input: { ref: string; reason?: string }): MemoryWrite {
    this.guardMemory();
    if (!isObject(input)) throw new Refusal('invalid_params', 'memoryRetire needs {ref}');
    if (input.reason !== undefined && typeof input.reason !== 'string') throw new Refusal('invalid_params', 'reason must be a string');
    const e = this.findEntry(input.ref, 'live');
    if (e.retired) throw new Refusal('invalid_params', `${JSON.stringify(e.name)} is already retired`);
    const op: MemOp = { op: 'retire', ref: e.key, reason: (input.reason ?? '').trim() };
    this.dryRun(op);
    const { entry } = this.memWrite(op);
    this.publishMemory('retired', entry);
    return { key: e.key, changed: true, ...this.untold() };
  }

  memoryRestore(input: { ref: string }): MemoryWrite {
    this.guardMemory();
    if (!isObject(input)) throw new Refusal('invalid_params', 'memoryRestore needs {ref}');
    const e = this.findEntry(input.ref, 'retired');
    // The lead's ruling: a live entry is already what a restore makes; nothing is written.
    if (!e.retired) return { key: e.key, changed: false, ...this.untold() };
    // The lead's ruling (I): one name per live entry: not while another live entry of the type answers
    // to one of its names (name, alias, former name; a rename keeps the old name as a former one, so
    // only retiring the other one clears it).
    const c = this.view().compendium;
    const taken = nameTaken(c, e, entryNames(e));
    if (taken) {
      throw new Refusal(
        'invalid_params',
        `${this.label(c, taken.other)} already answers to the name ${JSON.stringify(spelling(e, taken.name))}; ${this.label(c, e)} cannot be restored while another ${e.type} answers to one of its names`,
      );
    }
    const op: MemOp = { op: 'restore', ref: e.key };
    this.dryRun(op);
    const { entry } = this.memWrite(op);
    this.publishMemory('restored', entry);
    return { key: e.key, changed: true, ...this.untold() };
  }

  memoryList(input?: { type?: EntryType | 'note' | 'arc'; includeRetired?: boolean }): MemoryRow[] {
    this.assertOpen();
    const opts = input ?? {};
    if (!isObject(opts)) throw new Refusal('invalid_params', 'memoryList takes {type?, includeRetired?}');
    const { type, includeRetired } = opts;
    if (type !== undefined && type !== 'note' && type !== 'arc' && !isEntryType(type)) {
      throw new Refusal('invalid_params', `type must be note, arc or an entry type (${ENTRY_TYPES.join(', ')})`);
    }
    if (includeRetired !== undefined && typeof includeRetired !== 'boolean') throw new Refusal('invalid_params', 'includeRetired must be true or false');
    const rows: MemoryRow[] = [];
    for (const { ref, entry } of entryRefs(this.view().compendium)) {
      if (entry.retired && includeRetired !== true) continue;
      if (type !== undefined && entryKind(entry) !== type) continue;
      rows.push(memoryRow(ref, entry));
    }
    return rows;
  }

  memoryGet(input: { ref: string }): { ref: string; entry: CEntry; render: string; brief: string } {
    this.assertOpen();
    if (!isObject(input)) throw new Refusal('invalid_params', 'memoryGet needs {ref}');
    const c = this.view().compendium;
    const entry = this.findEntry(input.ref, 'live');
    return { ref: refOf(c, entry.key) ?? entry.key, entry, render: renderEntry(entry), brief: renderBrief(entry, COMPENDIUM_LIMITS.full.briefChars) };
  }

  memoryTree(input?: { book?: string }): TreeNode[] {
    this.assertOpen();
    const opts = input ?? {};
    if (!isObject(opts) || (opts.book !== undefined && typeof opts.book !== 'string')) throw new Refusal('invalid_params', 'memoryTree takes {book?}');
    const lib = this.library();
    const all = [...this.view().compendium.entries.values()];
    const trees: TreeNode[] = [];
    if (opts.book === undefined) trees.push(deriveTree(all.filter((e) => e.origin.kind === 'session')));
    const categories = this.categories();
    const categoryOf = (e: CEntry): string | undefined => (e.origin.kind === 'library' ? categories.get(`${e.origin.book}\u0000${e.origin.id}`) : undefined);
    for (const [id, name] of lib.seed.books) {
      if (opts.book !== undefined && opts.book !== id) continue;
      trees.push(deriveTree(all.filter((e) => e.origin.kind === 'library' && e.origin.book === id), { rootLabel: name, categoryOf }));
    }
    if (opts.book !== undefined && trees.length === 0) throw new Refusal('not_found', `the Compendium reads no book ${JSON.stringify(opts.book)}`);
    return trees;
  }

  memoryExport(input: { name: string; format: 'core' | 'compendium'; force?: boolean }): { path: string; id: string; entries: number; warnings?: ImportWarning[] } {
    this.guardMemory();
    if (!isObject(input)) throw new Refusal('invalid_params', 'memoryExport needs {name, format}');
    if (typeof input.name !== 'string' || normalizeName(input.name) === '') throw new Refusal('invalid_params', 'the export needs a name with at least one letter or digit');
    const format = input.format ?? 'core';
    if (format !== 'core' && format !== 'compendium') throw new Refusal('invalid_params', 'format must be core or compendium');
    if (input.force !== undefined && typeof input.force !== 'boolean') throw new Refusal('invalid_params', 'force must be true or false');
    const name = input.name.trim();
    const id = canonicalId(name);
    const view = this.exportView();
    const taken = (path: string, what: string): void => {
      if (input.force !== true && existsSync(path)) throw new Refusal('invalid_params', `${what} already exists (${path}); export with force to overwrite it`);
    };
    if (format === 'core') {
      // The lead's ruling: force never writes over a book this session reads (it would become the session's part of it).
      if ((this.config.lorebooks ?? []).includes(id)) {
        throw new Refusal('invalid_params', `the library lorebook ${JSON.stringify(id)} is one of this session's books: exporting over it would replace it with this session's part of it; choose another name`);
      }
      const book = exportCoreBook(view, name);
      const path = join(libraryDir(this.ctx.home, 'lorebooks'), `${id}.json`);
      taken(path, `the library lorebook ${JSON.stringify(id)}`);
      if (existsSync(path)) replaceFile(path, `${JSON.stringify(book, null, 2)}\n`);
      else {
        const saved = saveToLibrary(this.ctx.home, 'lorebooks', name, book);
        return { path: saved.path, id: saved.id, entries: book.entries.length };
      }
      return { path, id, entries: book.entries.length };
    }
    const dir = join(this.ctx.home, 'exports');
    const path = join(dir, `${id}.compendium.json`);
    taken(path, `the export ${JSON.stringify(`${id}.compendium.json`)}`);
    const rows = exportCompendiumRows(view);
    // What the file cannot keep (a second featured entry of a type…), for the caller to show.
    const warnings = compendiumWarnings(rows);
    mkdirSync(dir, { recursive: true });
    try {
      writeCompendiumFile(path, { name, exportDate: this.now() }, rows);
    } catch (e) {
      // Past what RoleCall imports (RC_LIMITS): refused, nothing left on disk.
      if (e instanceof ExportLimitError) throw new Refusal('invalid_params', e.message);
      throw e;
    }
    return { path, id, entries: rows.length, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  compendium(): CompendiumView {
    this.assertOpen();
    return this.view().compendium;
  }

  // ---- M5b: the lane's verbs (D-180) ----------------------------------------------------------------

  memoryUndo(input: { messageId: string; task?: 'file' | 'hist' }): MemoryLaneWrite {
    this.guardMemory();
    const { messageId, task } = this.laneTarget(input, 'memoryUndo');
    const bound = this.lane.boundKeys(messageId, task);
    if (bound.length === 0) throw new Refusal('not_found', `no ${task === 'file' ? 'filing' : task === 'hist' ? 'historian' : 'filing or historian'} pass is bound to message ${messageId}`);
    // Only an applied pass is undone: an undone one is already, a stale one is being written again.
    const applied = bound.filter((b) => b.state.status === 'applied');
    if (applied.length === 0) return { keys: [], changed: false };
    // D-159 dry run: the revert rows folded after the current ones.
    const ts = this.now();
    const rowOf = (key: string): EntryInput & { t: 'mem' } => ({ t: 'mem', ts, key: null, on: taskOn(key), by: 'user', ops: [{ op: 'revert', key }] });
    const tree = this.tree();
    const view = this.view();
    const last = this.log.lastSeq();
    const trial = applied.map((b, i) => ({ ...rowOf(b.key), seq: last + 1 + i }) as MemEntry);
    const c = foldCompendium([...tree.mems, ...trial], { pathSet: view.pathSet, path: view.path.map((m) => m.id), touched: tree.touched, library: this.library().seed, msgs: tree.msgs, trial: true });
    const issue = c.issues.find((i) => i.seq > last && i.why !== 'large_entry');
    if (issue) throw new Refusal('invalid_params', `the pass cannot be undone: the Compendium cannot apply it (${issue.why})`);
    const before = view.compendium;
    this.lane.cancel(applied.map((b) => b.key));
    for (const b of applied) this.verbAppend(rowOf(b.key));
    // One `reverted` event per entry the undone rows had changed (and that the undo really changes).
    const after = this.view().compendium;
    const told = new Set<string>();
    for (const b of applied) {
      for (const x of before.effects) {
        if (x.seq !== b.state.seq || told.has(x.key)) continue;
        told.add(x.key);
        const was = before.entries.get(x.key);
        if (!was || sameEntry(was, after.entries.get(x.key))) continue;
        this.publish({ type: 'memory', change: 'reverted', ref: x.key, kind: entryKind(was), name: was.name, by: 'user' });
      }
    }
    this.lane.poke();
    return { keys: applied.map((b) => b.key), changed: true };
  }

  memoryRefile(input: { messageId: string; task?: 'file' | 'hist' }): MemoryLaneWrite {
    this.guardMemory();
    const { messageId, task } = this.laneTarget(input, 'memoryRefile');
    return this.lane.refile(messageId, task);
  }

  memoryRetry(input?: { messageId?: string }): MemoryLaneWrite {
    this.guardMemory();
    const opts = input ?? {};
    if (!isObject(opts)) throw new Refusal('invalid_params', 'memoryRetry takes {messageId?}');
    if (opts.messageId !== undefined) this.laneTarget({ messageId: opts.messageId }, 'memoryRetry');
    try {
      return this.lane.retry(opts.messageId);
    } catch (e) {
      if (e instanceof SessionLockedError) throw new Refusal('session_locked', `another process took this session over: ${e.message}`);
      throw e;
    }
  }

  memoryWait(input?: { timeoutMs?: number }): Promise<MemoryStatus & { idle: boolean }> {
    this.assertOpen();
    const opts = input ?? {};
    if (!isObject(opts)) throw new Refusal('invalid_params', 'memoryWait takes {timeoutMs?}');
    const t = opts.timeoutMs;
    if (t !== undefined && !(typeof t === 'number' && Number.isFinite(t) && t >= 0)) throw new Refusal('invalid_params', 'timeoutMs must be a number of milliseconds, 0 or more');
    return this.lane.wait(t);
  }

  memoryStatus(): MemoryStatus {
    this.assertOpen();
    return this.lane.status();
  }

  /** A lane verb's message (on the active path) and task kind; not_found / invalid_params. */
  private laneTarget(input: unknown, verb: string): { messageId: string; task?: 'file' | 'hist' } {
    if (!isObject(input)) throw new Refusal('invalid_params', `${verb} needs {messageId}`);
    const { messageId, task } = input;
    if (typeof messageId !== 'string') throw new Refusal('invalid_params', 'messageId must be a message id');
    if (task !== undefined && task !== 'file' && task !== 'hist') throw new Refusal('invalid_params', "task must be 'file' or 'hist'");
    this.mustExist(this.tree(), messageId);
    if (!this.view().pathSet.has(messageId)) throw new Refusal('invalid_params', `message ${messageId} is not on the active path`);
    return { messageId, ...(task !== undefined ? { task } : {}) };
  }

  /**
   * M5b (the lead's rulings G and I): one `memory` event per entry an agent row really changed. The keys
   * its own ops touched (the fold's effects of that seq, in application order), each compared before
   * and after the write: a merge that changed nothing tells nothing, and an entry a refile re-creates
   * is 'merged' when it was there before. Then the entries the task key's replaced row (a refile, a
   * re-write) had changed and this one did not touch: `reverted` for each that is gone or changed.
   */
  publishChanges(before: CompendiumView, after: CompendiumView, seq: number, by: 'filing' | 'historian', key: string): void {
    const first = new Map<string, OpEffect['change']>();
    for (const x of after.effects) if (x.seq === seq && !first.has(x.key)) first.set(x.key, x.change);
    for (const [ref, change] of first) {
      const was = before.entries.get(ref);
      const now = after.entries.get(ref);
      if (!now || sameEntry(was, now)) continue;
      const how = change === 'created' && was !== undefined ? 'merged' : change;
      this.publish({ type: 'memory', change: how, ref, kind: entryKind(now), name: now.name, by });
    }
    const replaced = before.tasks.get(key);
    if (replaced?.status !== 'applied') return;
    const told = new Set(first.keys());
    for (const x of before.effects) {
      if (x.seq !== replaced.seq || told.has(x.key)) continue;
      told.add(x.key);
      const was = before.entries.get(x.key);
      if (!was || sameEntry(was, after.entries.get(x.key))) continue;
      this.publish({ type: 'memory', change: 'reverted', ref: x.key, kind: entryKind(was), name: was.name, by });
    }
  }

  /**
   * The view an export reads (the lead's ruling I): folded with the readable books' seed even while
   * the Compendium is off, since exporting is a data operation, so the session's changes to library
   * entries (overlays) are never dropped. The head view itself while the Compendium is on.
   */
  private exportView(): PathView {
    const cfg = compendiumConfigOf(this.config);
    if (cfg.enabled !== false) return this.view();
    const seed = this.readableSeed();
    if (seed === EMPTY_SEED) return this.view();
    return foldView(this.log.header, this.log.entries(), this.tree(), { library: seed });
  }

  /** The readable books' seed as if the Compendium were on (the session's own seed while it is). */
  private readableSeed(): LibrarySeed {
    const cfg = compendiumConfigOf(this.config);
    if (cfg.enabled !== false) return this.library().seed;
    return librarySeed(loreSources(this.log.header.cast, this.library().sources), { ...cfg, enabled: true });
  }

  /** The memory verbs' preconditions: an open session and no running turn. */
  private guardMemory(): void {
    this.assertOpen();
    if (this.running) throw new Refusal('session_busy', 'a turn is running');
  }

  /** The entry a ref names on the current path (C<n>, key or a unique name, see resolveEntryRef), else not_found. */
  private findEntry(ref: unknown, prefer: 'live' | 'retired'): CEntry {
    if (typeof ref !== 'string' || ref.trim() === '') throw new Refusal('invalid_params', 'ref must be an entry handle (C<n>), key or name');
    const e = resolveEntryRef(this.view().compendium, ref.trim(), prefer);
    if (!e) throw new Refusal('not_found', `no single entry matches ${JSON.stringify(ref)} (use its C<n> handle or key)`);
    return e;
  }

  /** (library id, entry id) → the book entry's category (extras.category), for the books' trees (D-165). */
  private categories(): ReadonlyMap<string, string> {
    this.library();
    const cache = this.libCache!;
    if (cache.categories) return cache.categories;
    const out = new Map<string, string>();
    for (const src of cache.lib.sources) {
      for (const e of src.book.entries) {
        const cat = e.extras?.category;
        if (typeof cat === 'string' && cat.trim() !== '') out.set(`${src.key}\u0000${e.id}`, cat);
      }
    }
    cache.categories = out;
    return out;
  }

  /** An entry as the refusals name it: `"Мира" (C1)`. */
  private label(c: CompendiumView, e: CEntry): string {
    return `${JSON.stringify(e.name)} (${refOf(c, e.key) ?? e.key})`;
  }

  /**
   * D-159 dry run: the current rows plus one human row with `op` (the next seq) folded; an issue on it
   * (a large_entry flag aside) refuses it with the reason in words. Returns that fold, the entry the
   * row changed and its effect. Writes nothing.
   */
  private dryRun(op: MemOp, ts: string = this.now()): { c: CompendiumView; effect: OpEffect; entry: CEntry } {
    const tree = this.tree();
    const view = this.view();
    const seed = this.library().seed;
    const seq = this.log.lastSeq() + 1;
    const row: MemEntry = { t: 'mem', seq, ts, key: null, on: null, by: 'user', ops: [op] };
    const c = foldCompendium([...tree.mems, row], { pathSet: view.pathSet, path: view.path.map((m) => m.id), touched: tree.touched, library: seed, msgs: tree.msgs, trial: true });
    const issue = c.issues.find((i) => i.seq === seq && i.why !== 'large_entry');
    if (issue) throw new Refusal('invalid_params', refusalWords(issue, op, c, seed));
    const made = rowEffect(c, seq);
    if (!made) throw new Error(`the memory row tried at seq ${seq} did not fold`);
    return { c, ...made };
  }

  /**
   * One durable human mem row with one op (§5.8, decision F1), the one a dry run accepted. The version
   * does not move. Returns the entry the row changed and the fold after the write.
   */
  private memWrite(op: MemOp): { entry: CEntry; change: OpEffect['change']; c: CompendiumView } {
    const written = this.verbAppend({ t: 'mem', ts: this.now(), key: null, on: null, by: 'user', ops: [op] });
    const c = this.view().compendium;
    const made = rowEffect(c, written.seq);
    if (!made) throw new Error(`the memory row written at seq ${written.seq} did not fold`);
    return { entry: made.entry, change: made.effect.change, c };
  }

  /**
   * An edit op of `e`: dry run; nothing written when it would change nothing (changed:false); else
   * `check` sees the entry as the edit leaves it (it refuses by throwing), then the row and its event.
   */
  private editWith(e: CEntry, op: MemOp, check?: (after: CEntry) => void): MemoryWrite {
    const trial = this.dryRun(op);
    const after = trial.c.entries.get(e.key);
    if (sameEntry(e, after)) return { key: e.key, changed: false, ...this.untold() };
    if (check && after) check(after);
    const { entry } = this.memWrite(op);
    this.publishMemory('edited', entry);
    return { key: e.key, changed: true, ...this.untold() };
  }

  /**
   * The Compendium's notices (large entry, missing library entry; D-144.6, D-147) of the current fold
   * not yet told in this open session, marked told: the verb returns them and the caller shows them.
   * None while the Compendium is disabled (every overlay would read as missing).
   */
  private untold(): { notices?: Notice[] } {
    if (!resolveCompendium(this.config.compendium).enabled) return {};
    const out: Notice[] = [];
    for (const n of compendiumNotices(this.view().compendium)) if (this.firstNotice(n.key)) out.push(n.notice);
    return out.length > 0 ? { notices: out } : {};
  }

  private publishMemory(change: 'note' | 'created' | 'merged' | 'edited' | 'retired' | 'restored', e: CEntry): void {
    this.publish({ type: 'memory', change, ref: e.key, kind: entryKind(e), name: e.name, by: 'user' });
  }
}
