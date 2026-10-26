// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Structural slots inside preset blocks (ARCHITECTURE.md §10.2, D-70). The macro engine passes
// {{history}}, {{recap}}, {{lore::x}}, {{outlet::x}} and {{slot::x}} through untouched; assemble
// places them. Slots are found in the RAW block text, before expansion, so an escaped `\{{history}}`
// or a `{{history}}` typed inside a card field is never taken for the real one. Each found slot is
// swapped for a sentinel the macro engine treats as plain text, the block is expanded once, and the
// sentinels are filled (or split on, for {{history}}) afterwards.

import type { Preset } from '../../formats/native.ts';
import { isStructuralSlot } from '../macros.ts';
import { parse } from '../macros/lex.ts';
import { hashString } from '../rng.ts';

export type SlotRef =
  | { kind: 'history' }
  | { kind: 'recap' }
  | { kind: 'lore' | 'outlet' | 'slot'; name: string };

// Unicode noncharacters: reserved for process-internal use, so no card or preset text means them.
const OPEN = '\uFDD0';
const CLOSE = '\uFDD1';
/** OPEN [scope '.'] number CLOSE */
const SENTINEL = /\uFDD0(?:([0-9a-z]+)\.)?(\d+)\uFDD1/g;

const sentinel = (scope: string, i: number): string => `${OPEN}${scope ? `${scope}.` : ''}${i}${CLOSE}`;

/**
 * The sentinel scope of a preset block: a tag derived from the block's own id, so its sentinels
 * read the same whatever other blocks exist or are enabled ({{pick}} seeds on the block text as the
 * macro engine sees it, D-43), and a sentinel that leaves its block is recognised as foreign.
 */
export function slotScope(blockId: string): string {
  return hashString(blockId).toString(36);
}

function toRef(body: string): SlotRef {
  const parts = body.trim().split('::');
  const name = (parts[0] ?? '').trim().toLowerCase();
  if (name === 'history' || name === 'recap') return { kind: name };
  return { kind: name as 'lore' | 'outlet' | 'slot', name: (parts[1] ?? '').trim() };
}

/**
 * Top-level, unescaped structural slots of a raw template, in order. A slot nested inside another
 * macro's argument is not a slot here: the engine leaves it literal, and a preset never needs it.
 */
export function topSlots(raw: string): { start: number; end: number; ref: SlotRef }[] {
  const out: { start: number; end: number; ref: SlotRef }[] = [];
  for (const node of parse(raw)) {
    if (node.kind !== 'macro' || !isStructuralSlot(node.body)) continue;
    // `\{{` is the engine's escape (lex.ts normalize): the tag renders literally, so it is no slot.
    if (node.start > 0 && raw[node.start - 1] === '\\') continue;
    out.push({ start: node.start, end: node.end, ref: toRef(node.body) });
  }
  return out;
}

/** Number of top-level {{history}} slots in a raw template. */
export function historySlots(raw: string): number {
  return topSlots(raw).filter((s) => s.ref.kind === 'history').length;
}

/**
 * Replace every top-level slot of `raw` with a sentinel and register it in `refs`; the number is the
 * slot's index in `refs`. Assemble gives each preset block its own `refs` and `scope` (slotScope),
 * so a block's sentinels, and with them its text as the macro engine sees it, never depend on other
 * blocks. A block's text and its {{original}} share one `refs`: a sentinel travelling through
 * {{original}} stays in its block and still names its own slot.
 */
export function protectSlots(raw: string, refs: SlotRef[], scope = ''): string {
  let out = '';
  let pos = 0;
  for (const s of topSlots(raw)) {
    out += raw.slice(pos, s.start) + sentinel(scope, refs.length);
    refs.push(s.ref);
    pos = s.end;
  }
  return out + raw.slice(pos);
}

/** Which side of the card's examples an example slot sits on, or null for any other slot. */
function exampleSide(ref: SlotRef): 'before' | 'after' | null {
  if (ref.kind !== 'lore') return null;
  const name = ref.name.toLowerCase();
  return name === 'examples_before' ? 'before' : name === 'examples_after' ? 'after' : null;
}

/**
 * Fill every sentinel of `scope` in an expanded text with its slot's value; an unknown number stays
 * as it is. A sentinel of another scope (one that left its block through a variable) renders '': a
 * slot is placed by its own block only, never a second time elsewhere.
 *
 * Example slots are joined to what ends up next to them by a newline: presets write
 * `{{lore::examples_before}}{{examples}}{{lore::examples_after}}` back to back, and each side is its
 * own example dialogue (ST puts example entries into the same list as the card's examples).
 */
export function fillSlots(text: string, refs: readonly SlotRef[], value: (ref: SlotRef) => string, scope = ''): string {
  if (!text.includes(OPEN)) return text;
  // Literal text and rendered slots in order, so a slot can see what lands beside it.
  const parts: { text: string; side: 'before' | 'after' | null }[] = [];
  let pos = 0;
  for (const m of text.matchAll(SENTINEL)) {
    parts.push({ text: text.slice(pos, m.index), side: null });
    pos = m.index + m[0].length;
    if ((m[1] ?? '') !== scope) continue;
    const ref = refs[Number(m[2])];
    parts.push(ref ? { text: value(ref), side: exampleSide(ref) } : { text: m[0], side: null });
  }
  parts.push({ text: text.slice(pos), side: null });

  const joined = (from: number, to: number): string => parts.slice(from, to).map((p) => p.text).join('');
  parts.forEach((p, i) => {
    if (p.side === null || p.text === '') return;
    if (p.side === 'before') {
      const next = joined(i + 1, parts.length);
      if (next !== '' && !next.startsWith('\n')) p.text += '\n';
    } else {
      const prev = joined(0, i);
      if (prev !== '' && !prev.endsWith('\n')) p.text = `\n${p.text}`;
    }
  });
  return joined(0, parts.length);
}

/**
 * Split an expanded text at its first {{history}} sentinel of `scope`: [before, after]. Null when
 * the text holds none (the slot sat in a macro argument that discarded it).
 */
export function splitAtHistory(text: string, refs: readonly SlotRef[], scope = ''): [string, string] | null {
  // matchAll works on a copy of the regex, so the shared one keeps no lastIndex state.
  for (const m of text.matchAll(SENTINEL)) {
    if ((m[1] ?? '') !== scope) continue;
    if (refs[Number(m[2])]?.kind === 'history') return [text.slice(0, m.index), text.slice(m.index + m[0].length)];
  }
  return null;
}

// ---- formats (D-70) ---------------------------------------------------------------------------

/** ST's stringFormat: every `{0}` becomes the value. A function replacer, so `$&` in it stays literal. */
export function applyFormat(format: string | undefined, value: string): string {
  if (format === undefined || format === '') return value;
  return format.replace(/\{0\}/g, () => value);
}

/**
 * A slot's rendered value: wi_format wraps non-empty {{lore::before}} / {{lore::after}} values, as
 * ST's formatWorldInfo wraps only worldInfoBefore / worldInfoAfter (a blank format is no format);
 * outlets and example slots are as given (ST sends outlets and example entries unwrapped). Empty
 * values stay empty so the block holding them can drop out.
 */
export function renderSlot(ref: SlotRef, value: string, formats: Preset['formats']): string {
  if (value === '') return '';
  const wi = formats?.wi;
  if (ref.kind !== 'lore' || wi === undefined || wi.trim() === '') return value;
  const name = ref.name.toLowerCase();
  return name === 'before' || name === 'after' ? applyFormat(wi, value) : value;
}

/** Lowercased name when the raw template is exactly one macro without arguments, else null. */
export function soleMacro(raw: string): string | null {
  const nodes = parse(raw).filter((n) => !(n.kind === 'text' && n.value.trim() === ''));
  const only = nodes.length === 1 ? nodes[0] : undefined;
  return only?.kind === 'macro' && only.args.length === 0 ? only.name.toLowerCase() : null;
}

/**
 * ST's new_example_chat_prompt: every example dialogue (split on `<START>`, as ST's
 * parseMesExamples does) is headed by the format line instead of the bare `<START>` marker. A
 * header that is present but blank heads nothing: `<START>` is only a separator to ST, and the empty
 * header message is dropped (ChatCompletion.getChat), so the dialogues go out joined, no marker.
 * Without a header (a native preset, the builtin) the examples are sent as written.
 */
export function formatExamples(examples: string, header: string | undefined): string {
  if (header === undefined || examples.trim() === '') return examples;
  const chunks = examples
    .split(/<START>/i)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '');
  if (header.trim() === '') return chunks.join('\n');
  return chunks.map((chunk) => `${header}\n${chunk}`).join('\n');
}
