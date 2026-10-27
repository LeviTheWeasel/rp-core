// normalizeName ported from Bunraku:src/core/compendium/relationships.ts@702d8120 (line 39).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Compendium fold over `mem` rows (ARCHITECTURE.md §5.8 "Свёртка"). M3: notes only — note,
// edit, retire and restore over human notes; file, arc and revert are recorded as issues
// ('not_until_m5') so a row written by a later version never breaks an M3 reader. Pure.
// normalizeName: port of Bunraku src/core/compendium/relationships.ts:39 (Chi) with the D-46 word
// class (\p{M} kept) plus NFKC and ё→е, so 'Ёж' and 'ёж' and 'Еж' name the same note (D-95).
// CONTRACT FILE (M3): signatures are fixed; the memory agent implements the bodies.

import { createHash } from 'node:crypto';
import type { MemEntry, MemOp } from '../../session/entries.ts';
import type { CEntry, CompendiumView, FoldIssue, Rec } from './types.ts';

const NOT_NAME_CHAR = /[^\p{L}\p{N}\p{M}\s]/gu;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * A name as the fold compares it: NFKC, lower case (locale-free), ё→е, every character that is not
 * a letter, digit, combining mark or whitespace becomes a space, runs of whitespace collapse to one
 * space, trimmed. '' for a name with no letters or digits.
 */
export function normalizeName(name: string): string {
  const out = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(NOT_NAME_CHAR, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Bunraku's class has no \p{M}; with it a lone combining mark would survive as a "name".
  return HAS_LETTER_OR_DIGIT.test(out) ? out : '';
}

export interface FoldOptions {
  /** Messages on the path the view is folded for: a row with `on` set applies only when `on` is in it. */
  pathSet: ReadonlySet<string>;
}

/** The prefix of a note's key (§5.8 "Ключи записей"). */
export const NOTE_KEY_PREFIX = 'note:';

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A note's fields that live outside `data` (set renames or rewrites them; they cannot be unset). */
const NOTE_FIELDS: ReadonlySet<string> = new Set(['title', 'content']);

/** The fold's working state. Entries are built fresh per fold, so applying ops mutates them in place. */
interface FoldState {
  entries: Map<string, CEntry>;
  /** Per base key, the last '#n' suffix handed out (keys are never removed, so the next is free). */
  suffix: Map<string, number>;
  issues: FoldIssue[];
}

/** The key for a new entry: `base`, else `base#2`, `base#3`… (taken by any entry, retired included). */
function allocKey(st: FoldState, base: string): string {
  let n = st.suffix.get(base) ?? 0;
  let key: string;
  do {
    n++;
    key = n === 1 ? base : `${base}#${n}`;
  } while (st.entries.has(key));
  st.suffix.set(base, n);
  return key;
}

/** A note entry (§5.8 CEntry for a human note): no type, no aliases, its text in `content`. */
function newNote(key: string, title: string, keys: string[], content: string, row: MemEntry): CEntry {
  return {
    key,
    type: null,
    name: title,
    aliases: [],
    tagline: '',
    data: {},
    keys: [...keys],
    content,
    origin: { kind: 'session' },
    prov: { created: row.on, lastSeq: row.seq, appended: {}, createdSeq: row.seq },
  };
}

/**
 * Apply one op (§5.8 applyMemOp, M3 part). Returns the issue reason when the op was skipped, else
 * null. Every op is checked whole before it changes anything, so a skipped op leaves no trace.
 */
function applyOp(st: FoldState, row: MemEntry, raw: MemOp): string | null {
  // Rows are read leniently (entries.ts checks only `op`), so every field is checked here.
  const op = raw as unknown as Rec;
  switch (op.op) {
    case 'note': {
      const keys = op.keys === undefined ? [] : op.keys;
      if (!isStr(op.title) || !isStr(op.content) || !isStrArray(keys)) return 'invalid';
      const base = normalizeName(op.title);
      if (base === '') return 'invalid';
      const key = allocKey(st, NOTE_KEY_PREFIX + base);
      st.entries.set(key, newNote(key, op.title, keys, op.content, row));
      return null;
    }
    case 'edit': {
      if (!isStr(op.ref)) return 'invalid';
      const e = st.entries.get(op.ref);
      if (!e) return 'not_found';
      if (e.type !== null || e.origin.kind !== 'session') return 'not_until_m5'; // typed and library entries: M5a
      const set = op.set === undefined ? {} : op.set;
      const unset = op.unset === undefined ? [] : op.unset;
      const { keys, featured } = op;
      if (!isRec(set) || !isStrArray(unset) || unset.some((k) => NOTE_FIELDS.has(k))) return 'invalid';
      if (keys !== undefined && !isStrArray(keys)) return 'invalid';
      if (featured !== undefined && typeof featured !== 'boolean') return 'invalid';
      if (set.title !== undefined && !(isStr(set.title) && normalizeName(set.title) !== '')) return 'invalid';
      if (set.content !== undefined && !isStr(set.content)) return 'invalid';
      // A rename keeps the key (§5.8); the text is replaced whole; other fields are data's.
      for (const [k, v] of Object.entries(set)) {
        if (v === undefined) continue;
        if (k === 'title') e.name = v as string;
        else if (k === 'content') e.content = v as string;
        else e.data = { ...e.data, [k]: v };
      }
      if (unset.length > 0) {
        const data = { ...e.data };
        for (const k of unset) delete data[k];
        e.data = data;
      }
      if (keys !== undefined) e.keys = [...keys];
      if (featured === true) e.featured = true;
      else if (featured === false) delete e.featured;
      e.prov.lastSeq = row.seq;
      return null;
    }
    case 'retire':
    case 'restore': {
      if (!isStr(op.ref)) return 'invalid';
      const e = st.entries.get(op.ref);
      if (!e) return 'not_found';
      if (op.op === 'retire') e.retired = { reason: isStr(op.reason) ? op.reason : '' };
      else delete e.retired;
      e.prov.lastSeq = row.seq;
      return null;
    }
    case 'file':
    case 'arc':
    case 'revert':
      return 'not_until_m5';
    default:
      return 'unknown_op';
  }
}

/** The rows in seq order (the log already keeps them so; anything else is sorted, never mutated). */
function inSeqOrder(rows: readonly MemEntry[]): readonly MemEntry[] {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.seq <= rows[i - 1]!.seq) return [...rows].sort((a, b) => a.seq - b.seq);
  }
  return rows;
}

/**
 * Which rows the fold reads (§5.8 pipeline): bound to the path (`on` null or on it). M5a adds the
 * staleness filter (D-68.4) and "newest action per non-null key" (D-74) here; human rows (key null)
 * all apply, so in M3 the path is the only filter.
 */
function rowApplies(row: MemEntry, pathSet: ReadonlySet<string>): boolean {
  return row.on === null || pathSet.has(row.on);
}

/**
 * Fold the rows that apply to a path, in seq order (§5.8):
 * 1. rows with `on === null` or `pathSet.has(on)`;
 * 2. (M5) not stale; newest action per non-null key — human rows (key null) all apply;
 * 3. each op through applyMemOp.
 * M3 ops: note → a new entry (key 'note:' + normalizeName(title), '#2'… when the key is taken by any
 * entry, retired included; an empty normalized title → issue 'invalid'); edit → set.title renames,
 * set.content replaces the text, keys replaces the keys, unset/featured as §5.8 (an unknown or
 * missing ref → issue 'not_found'); retire / restore set and clear `retired`. file, arc, revert →
 * issue 'not_until_m5'. rev = a short hash of the applied rows' seqs and ops ('' when none).
 */
export function foldCompendium(rows: readonly MemEntry[], opts: FoldOptions): CompendiumView {
  const st: FoldState = { entries: new Map(), suffix: new Map(), issues: [] };
  // M5a: the readable books' typed entries seed `st.entries` here, before the rows.
  const hash = createHash('sha256');
  let lastSeq = 0;
  for (const row of inSeqOrder(rows)) {
    if (!rowApplies(row, opts.pathSet)) continue;
    const ops: readonly MemOp[] = Array.isArray(row.ops) ? row.ops : [];
    hash.update(`${row.seq}\u0000${JSON.stringify(ops)}\n`);
    lastSeq = row.seq;
    ops.forEach((op, i) => {
      const why = isRec(op) ? applyOp(st, row, op) : 'invalid';
      if (why !== null) st.issues.push({ seq: row.seq, op: i, why });
    });
  }
  return { entries: st.entries, rev: lastSeq === 0 ? '' : hash.digest('hex').slice(0, 16), lastSeq, issues: st.issues };
}
