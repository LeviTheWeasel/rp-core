// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// /memory new and /memory edit in the editor (ARCHITECTURE.md §7.4.8, decisions D-160): the JSON text
// the editor opens with, and what a saved text becomes (memoryFile's data, memoryEdit's set and
// unset). Pure: the REPL (repl.ts) runs the editor and the verbs, and re-opens the editor on an error.
//
// The text is one pretty JSON object. Its first key "//" is a one-line help (what to fill, the enums
// of the type's fields, the nested ones of a character's state, relationships and memories); it is
// stripped on save. Blank values ('' / whitespace, null, [] and {}, at any depth) are dropped, so the
// template's empty fields never reach the entry.

import { fieldKind, identityField, LITE_FIELDS, NESTED, SUMMARY_TEMPLATE, type Kind } from '../agents/compendium/entry-types.ts';
import type { CEntry, EntryType, Rec } from '../agents/compendium/types.ts';
import { deepEq } from '../formats/wire.ts';

/** The help key of the editor's JSON (stripped on save). */
export const HELP_KEY = '//';

/** The fields of the /memory new template: the type's LITE_FIELDS, SUMMARY_TEMPLATE for a summary. */
export const templateFields = (type: EntryType): readonly string[] => (type === 'summary' ? SUMMARY_TEMPLATE : LITE_FIELDS[type]);

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A field's empty value by its kind: [] a list (aliases too), {} an object, '' anything else. */
function emptyOf(type: EntryType, field: string): unknown {
  if (field === 'aliases') return [];
  const k = fieldKind(type, field);
  return k === 'a' ? [] : k === 'o' ? {} : '';
}

const enumText = (k: Kind | undefined): string | null => (k !== undefined && typeof k === 'object' ? k.oneOf.join('|') : null);

/**
 * The enums of `fields` of `type`: `role: protagonist|…`, and the nested ones the type's shapes name
 * (`current_state.status: …`, `relationships[].nature: …`, `memories[].emotional_weight: …`).
 */
export function enumsOf(type: EntryType, fields: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const kind = fieldKind(type, f);
    const own = enumText(kind);
    if (own !== null) out.push(`${f}: ${own}`);
    const shape = NESTED[`${type}.${f}`];
    if (!shape) continue;
    const path = kind === 'a' ? `${f}[]` : f;
    for (const [sub, k] of Object.entries(shape.fields)) {
      const e = enumText(k);
      if (e !== null) out.push(`${path}.${sub}: ${e}`);
    }
  }
  return out;
}

const helpLine = (lead: string, enums: readonly string[]): string => (enums.length > 0 ? `${lead}. ${enums.join('; ')}` : `${lead}.`);

/** The /memory new text: the help key, then the template fields empty by kind, the name filled when given. */
export function newEntryText(type: EntryType, name?: string): string {
  const fields = templateFields(type);
  const idf = identityField(type);
  const obj: Rec = { [HELP_KEY]: helpLine('fill what you know; blank fields are ignored', enumsOf(type, fields)) };
  for (const f of fields) obj[f] = f === idf && name !== undefined ? name : emptyOf(type, f);
  return JSON.stringify(obj, null, 2);
}

/**
 * What the /memory edit text of a typed entry or an arc shows (the help key aside), which is also what
 * the saved text is compared with. Typed: the identity field (the entry's name when its data has
 * none, as a library entry named by its lore title), the aliases (the entry's own list, shown when it
 * has some or the type's template has them), then the rest of the data as stored. An arc: its overview,
 * then its data.
 */
export function editBase(e: CEntry): Rec {
  if (e.type === null) {
    const rest: Rec = {};
    for (const [k, v] of Object.entries(e.data)) if (k !== 'overview' && k !== 'content' && k !== HELP_KEY) rest[k] = v;
    return { overview: e.content ?? '', ...rest };
  }
  const idf = identityField(e.type);
  const own = e.data[idf];
  const base: Rec = { [idf]: typeof own === 'string' && own.trim() !== '' ? own : e.name };
  if (e.aliases.length > 0 || templateFields(e.type).includes('aliases')) base.aliases = [...e.aliases];
  for (const [k, v] of Object.entries(e.data)) if (k !== idf && k !== 'aliases' && k !== HELP_KEY) base[k] = v;
  return base;
}

/** The /memory edit text of a typed entry or an arc: the help key, then editBase. */
export function editEntryText(e: CEntry): string {
  const base = editBase(e);
  const help =
    e.type === null
      ? helpLine("change the arc's overview; its plot name cannot change here", [])
      : helpLine(
          `change what you need: a new ${identityField(e.type)} renames it, a field you blank or remove is removed`,
          enumsOf(e.type, [...new Set([...templateFields(e.type), ...Object.keys(base)])]),
        );
  return JSON.stringify({ [HELP_KEY]: help, ...base }, null, 2);
}

/** `v` without its blank parts ('' / whitespace, null, [] and {} at any depth); undefined when all blank. */
export function prune(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v.trim() === '' ? undefined : v;
  if (Array.isArray(v)) {
    const items = v.map(prune).filter((x) => x !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (isRecord(v)) {
    const out: Rec = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return v;
}

/** A saved editor text → the object it holds without the help key and blank values, or why not. */
export function parseEntryText(text: string): { ok: true; data: Rec } | { ok: false; message: string } {
  let v: unknown;
  try {
    v = JSON.parse(text) as unknown;
  } catch (e) {
    return { ok: false, message: `the text is not valid JSON (${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ')})` };
  }
  if (!isRecord(v)) return { ok: false, message: 'the text must be one JSON object, { … }' };
  const rest: Rec = {};
  for (const [k, x] of Object.entries(v)) if (k !== HELP_KEY) rest[k] = x;
  return { ok: true, data: (prune(rest) as Rec | undefined) ?? {} };
}

/** The names a /memory new entry goes by: its identity value and its aliases (what the fold matches on). */
export function namesOf(type: EntryType, data: Rec): string[] {
  const out: string[] = [];
  const id = data[identityField(type)];
  if (typeof id === 'string') out.push(id);
  if (Array.isArray(data.aliases)) for (const a of data.aliases) if (typeof a === 'string') out.push(a);
  return out;
}

/**
 * A saved /memory edit object against its base (both compared without blanks): `set` = fields that
 * are new or changed, `unset` = fields that were there and are gone. An arc's overview goes as
 * `set.content` (memoryEdit's name for it). Both empty: nothing changed.
 */
export function diffEntry(e: CEntry, next: Rec): { set: Rec; unset: string[] } {
  const base = (prune(editBase(e)) as Rec | undefined) ?? {};
  const set: Rec = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(next)) if (!deepEq(v, base[k])) set[e.type === null && k === 'overview' ? 'content' : k] = v;
  for (const k of Object.keys(base)) if (!Object.hasOwn(next, k)) unset.push(k);
  return { set, unset };
}
