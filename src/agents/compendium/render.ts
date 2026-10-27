// Ported from Bunraku:src/core/compendium/render.ts@702d8120 (renderContent, label and lines).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The text a Compendium entry reads as (ARCHITECTURE.md §5.8 "Рендер", .notes/m5a-decisions.md D-151).
// The structured data is the authority; the text is always derived from it, never stored or compared.
// renderContent is Bunraku's: `# <name|title|topic, else the type's label>`, then tagline, description
// and summary as bare paragraphs, then `## <Label>` sections in the type's field order, then unknown
// fields by name; objects list their keys sorted, so the text never depends on the stored key order.
// Changes from Bunraku (each a listed deviation, D-151):
// 1. RENDER_HIDDEN fields are never shown, at the top level or inside list items and objects; a section
//    or a list item left with nothing to show is not printed.
// 2. tagline, description and summary are not repeated as sections when the type does not know them.
// 3. `aliases` is never a section, whatever the type.
// 4. A name, title or topic that is the heading is not repeated as a section.
// 5. Lists and objects nested deeper than RENDER_MAX_DEPTH render as '…' (Bunraku passed a depth it
//    never checked).
// New: renderEntry (notes and arcs too) and renderBrief (the short form, D-151 table). Pure.

import { deriveTagline, identityField, knownFields } from './entry-types.ts';
import { noteText } from './notes.ts';
import type { CEntry, EntryType, Rec } from './types.ts';

const TITLE_FIELDS = ['name', 'title', 'topic'];
const HEAD_FIELDS = ['tagline', 'description', 'summary'];
/** The original text Standardize kept when it typed a classic entry: data, never prose. */
export const PRESERVED_PROSE = 'preserved_prose';

/** Fields that are bookkeeping, not story: never rendered (§5.8; RoleCall's memory stamps, a summary's span). */
export const RENDER_HIDDEN: ReadonlySet<string> = new Set([
  'writer_source',
  'source_turn',
  'source_job_id',
  'turn_range',
  'messages_covered',
  PRESERVED_PROSE,
]);

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A field name as a label: underscores to spaces, the first letter upper case ('current_state' → 'Current state'). */
export const label = (field: string): string => field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Lists and objects nested deeper than this render as '…' (data of any depth renders without a stack overflow). */
export const RENDER_MAX_DEPTH = 32;

/** A value as lines; `depth` is how many lists and objects it sits in (a field's own value: 0). */
function lines(value: unknown, depth = 0): string[] {
  const nested = Array.isArray(value) || isRecord(value);
  if (nested && depth > RENDER_MAX_DEPTH) return ['…'];
  if (Array.isArray(value)) {
    return value.flatMap((v) => {
      if (!isRecord(v) && !Array.isArray(v)) return [`- ${String(v)}`];
      const inner = lines(v, depth + 1);
      return inner.length > 0 ? [`- ${inner.join('; ')}`] : [];
    });
  }
  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .filter((k) => !RENDER_HIDDEN.has(k) && value[k] !== null && value[k] !== undefined && value[k] !== '')
      .map((k) => {
        const inner = lines(value[k], depth + 1);
        return isRecord(value[k]) || Array.isArray(value[k]) ? `${label(k)}: ${inner.join(' ')}` : `${label(k)}: ${inner[0]}`;
      });
  }
  return [String(value)];
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The markdown a typed entry reads as. */
export function renderContent(type: EntryType, data: Rec): string {
  const titleField = TITLE_FIELDS.find((f) => isText(data[f]));
  const title = titleField === undefined ? undefined : (data[titleField] as string);
  const out: string[] = [`# ${title ?? label(type)}`];
  const known = knownFields(type);
  const shown = (f: string): boolean => !RENDER_HIDDEN.has(f) && f !== 'aliases';
  const isHeading = (f: string): boolean =>
    title !== undefined && TITLE_FIELDS.includes(f) && (f === titleField || (isText(data[f]) && (data[f] as string).trim() === title.trim()));
  const rest = [
    ...known.filter((f) => !TITLE_FIELDS.includes(f) && !HEAD_FIELDS.includes(f) && shown(f)),
    ...Object.keys(data)
      .filter((f) => !known.includes(f) && !HEAD_FIELDS.includes(f) && shown(f) && !isHeading(f))
      .sort(),
  ];
  for (const field of [...HEAD_FIELDS, ...rest]) {
    const value = data[field];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    if (HEAD_FIELDS.includes(field) && typeof value === 'string') out.push(value);
    else {
      const body = lines(value);
      if (body.length > 0) out.push([`## ${label(field)}`, ...body].join('\n'));
    }
  }
  return out.join('\n\n');
}

const arcPlot = (e: CEntry): string => e.arc ?? e.name;

/**
 * Any entry's full text: a note as its noteText, an arc as '# [Arc] <plot>' and its overview, a typed
 * entry as renderContent (headed by the entry's name when its data names nothing).
 */
export function renderEntry(e: CEntry): string {
  if (e.arc !== undefined) return [`# [Arc] ${arcPlot(e)}`, e.content ?? ''].filter(isText).join('\n\n');
  if (e.type === null) return noteText(e.name, e.content ?? '');
  const named = TITLE_FIELDS.some((f) => isText(e.data[f]));
  return renderContent(e.type, named || !isText(e.name) ? e.data : { ...e.data, [identityField(e.type)]: e.name });
}

// ---- the brief ------------------------------------------------------------------------------------

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** One scalar as brief text: a string flattened, a number or boolean as written; anything else none. */
function scalar(v: unknown): string | undefined {
  if (typeof v === 'string') return flat(v) || undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** One list item as brief text: a scalar, or a record's name (title, topic, with, what_happened), else its rendered keys. */
function itemText(v: unknown): string | undefined {
  const s = scalar(v);
  if (s !== undefined || !isRecord(v)) return s;
  for (const k of ['name', 'title', 'topic', 'with', 'what_happened', 'description']) {
    const named = scalar(v[k]);
    if (named !== undefined) return named;
  }
  return flat(lines(v, 1).join('; ')) || undefined;
}

/** A field's whole value as brief text (lists uncapped). */
function valueText(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.map(itemText).filter((x) => x !== undefined).join('; ') || undefined;
  if (isRecord(v)) return flat(lines(v).join('; ')) || undefined;
  return scalar(v);
}

/** Brief fields per type (D-151): `field` or `field:N` (a list, at most N items). Character is special. */
const BRIEF: Record<Exclude<EntryType, 'character'>, string> = {
  location: 'type parent_location controlling_faction dangers:3',
  item: 'type current_owner condition abilities:3',
  power: 'category mastery users:3 cost limitations:2',
  organization: 'type leader goals:3 enemies:3',
  event: 'type when where outcome significance',
  plot: 'status goal current_progress next_steps',
  threat: 'severity status scope what_happens_if_unaddressed',
  worldbuilding: 'category key_facts:3 rules:3',
  summary: 'significance summary consequences:2',
  creature: 'classification disposition habitat weaknesses:3',
};

interface Brief {
  lines: string[];
  /** Fields the lines show whole. */
  whole: Set<string>;
}

function genericBrief(spec: string, data: Rec, out: Brief): void {
  for (const pair of spec.split(' ')) {
    const [field, cap] = pair.split(':') as [string, string | undefined];
    const v = data[field];
    if (cap !== undefined && Array.isArray(v)) {
      const items = v.map(itemText).filter((x) => x !== undefined);
      if (items.length === 0) continue;
      out.lines.push(`${label(field)}: ${items.slice(0, Number(cap)).join('; ')}`);
      if (items.length <= Number(cap) && v.every((x) => scalar(x) !== undefined)) out.whole.add(field);
      continue;
    }
    const text = valueText(v);
    if (text === undefined) continue;
    out.lines.push(`${label(field)}: ${text}`);
    // A scalar, or a list of scalars (no cap: every item is printed), is shown whole.
    if (Array.isArray(v) ? v.every((x) => scalar(x) !== undefined) : !isRecord(v)) out.whole.add(field);
  }
}

const keysWithin = (r: Rec, allowed: readonly string[]): boolean => Object.keys(r).every((k) => allowed.includes(k) || r[k] === undefined || r[k] === null || r[k] === '');

const TENSE = (r: Rec): boolean => r.status === 'strained' || r.nature === 'rival' || r.nature === 'enemy';

function characterBrief(data: Rec, out: Brief): void {
  const role = scalar(data.role);
  if (role !== undefined) {
    out.lines.push(`Role: ${role}`);
    out.whole.add('role');
  }
  const cs = data.current_state;
  if (isRecord(cs)) {
    const status = scalar(cs.status);
    const location = scalar(cs.location);
    const parts = [status !== 'alive' ? status : undefined, scalar(cs.condition), location !== undefined ? `at ${location}` : undefined];
    const state = parts.filter((p) => p !== undefined).join(', ');
    if (state !== '') out.lines.push(`State: ${state}`);
    if (keysWithin(cs, ['status', 'condition', 'location'])) out.whole.add('current_state');
  }
  if (Array.isArray(data.relationships)) {
    const rels = data.relationships.filter((r) => isRecord(r) || scalar(r) !== undefined);
    // Strained, rival and enemy first; otherwise as stored.
    const ordered = [...rels.filter((r) => isRecord(r) && TENSE(r)), ...rels.filter((r) => !(isRecord(r) && TENSE(r)))];
    const shown = ordered
      .map((r) => {
        if (!isRecord(r)) return scalar(r);
        const who = scalar(r.with);
        if (who === undefined) return undefined;
        const status = scalar(r.status);
        const how = [scalar(r.nature), status !== 'active' ? status : undefined].filter((p) => p !== undefined);
        return how.length > 0 ? `${who} (${how.join(', ')})` : who;
      })
      .filter((x) => x !== undefined);
    if (shown.length > 0) out.lines.push(`Relationships: ${shown.slice(0, 3).join('; ')}`);
    if (rels.length <= 3 && rels.every((r) => !isRecord(r) || (scalar(r.with) !== undefined && keysWithin(r, ['with', 'nature', 'status'])))) {
      out.whole.add('relationships');
    }
  }
  if (Array.isArray(data.memories)) {
    const mems = data.memories
      .map((m) => {
        if (!isRecord(m)) return scalar(m);
        const what = scalar(m.what_happened) ?? scalar(m.event);
        const changed = scalar(m.changed_belief) ?? scalar(m.changed_behavior);
        return what === undefined ? changed : changed === undefined ? what : `${what} — ${changed}`;
      })
      .filter((x) => x !== undefined);
    if (mems.length > 0) out.lines.push(`Memories: ${mems.slice(-2).join('; ')}`);
    if (data.memories.length <= 2 && data.memories.every((m) => !isRecord(m))) out.whole.add('memories');
  }
}

/** Whether the data holds something the brief lines do not show whole. */
function leftOut(data: Rec, brief: Brief, taglineIsDescription: boolean): boolean {
  for (const [field, v] of Object.entries(data)) {
    if (TITLE_FIELDS.includes(field) || field === 'aliases' || field === 'tagline' || RENDER_HIDDEN.has(field)) continue;
    if (brief.whole.has(field)) continue;
    if (field === 'description' && taglineIsDescription) continue;
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (isRecord(v) && lines(v).length === 0) continue;
    return true;
  }
  return false;
}

const SENTENCE_END = /[.!?…](?=\s)/gu;

/**
 * The longest head of `text` that fits `room` UTF-16 units, cut at the last line break or sentence end
 * inside it; else at the last space, with '…'; else at a code point, with '…'.
 */
function cutText(text: string, room: number): string {
  if (text.length <= room) return text;
  if (room <= 0) return '';
  let at = text.lastIndexOf('\n', room);
  for (const m of text.slice(0, room + 1).matchAll(SENTENCE_END)) if (m.index + 1 <= room) at = Math.max(at, m.index + 1);
  if (at > 0) return text.slice(0, at).trimEnd();
  let head = text.slice(0, room - 1);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  const space = head.lastIndexOf(' ');
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}

/**
 * The short form of an entry (D-151): `# <name>`, the tagline, then the type's brief fields as
 * `Label: value` lines (lists joined '; ', capped). A note is its noteText, an arc '# [Arc] <plot>' and
 * its overview. The text is cut at a line or sentence boundary so that it fits `maxChars` with the tail;
 * `tail` (e.g. '(more: read_lore C12)') follows on its own line only when something was left out —
 * by the cut, by a cap, or because the entry holds fields the brief does not show.
 */
export function renderBrief(e: CEntry, maxChars: number, tail = ''): string {
  const parts = renderBriefParts(e, maxChars, tail);
  return parts.tail === '' ? parts.text : `${parts.text}\n${parts.tail}`;
}

/**
 * renderBrief in two parts: `text`, and `tail` ('' when nothing was left out or no tail fits), so
 * that `text` alone (no tools offered) and `text` + '\n' + `tail` (read_lore offered) both fit
 * `maxChars` (D-155 BlockCandidate.brief and briefTail).
 */
export function renderBriefParts(e: CEntry, maxChars: number, tail = ''): { text: string; tail: string } {
  let text: string;
  let more = false;
  if (e.arc !== undefined) text = [`# [Arc] ${arcPlot(e)}`, e.content ?? ''].filter(isText).join('\n');
  else if (e.type === null) text = noteText(e.name, e.content ?? '');
  else {
    const type = e.type;
    const brief: Brief = { lines: [`# ${isText(e.name) ? flat(e.name) : label(type)}`], whole: new Set() };
    const tagline = flat(type === 'summary' ? (isText(e.data.tagline) ? e.data.tagline : '') : e.tagline || deriveTagline(type, e.data));
    if (tagline !== '') brief.lines.push(tagline);
    if (type === 'character') characterBrief(e.data, brief);
    else genericBrief(BRIEF[type], e.data, brief);
    const description = typeof e.data.description === 'string' ? flat(e.data.description) : '';
    text = brief.lines.join('\n');
    more = leftOut(e.data, brief, tagline !== '' && tagline === description);
  }
  const end = tail.trim();
  if (!more && text.length <= maxChars) return { text, tail: '' };
  const room = end === '' ? maxChars : maxChars - end.length - 1;
  if (room < 1) return { text: cutText(text, maxChars), tail: '' };
  return { text: cutText(text, room), tail: end };
}
