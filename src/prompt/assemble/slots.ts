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

/**
 * Fill every sentinel of `scope` in an expanded text with its slot's value; an unknown number stays
 * as it is. A sentinel of another scope (one that left its block through a variable) renders '': a
 * slot is placed by its own block only, never a second time elsewhere.
 */
export function fillSlots(text: string, refs: readonly SlotRef[], value: (ref: SlotRef) => string, scope = ''): string {
  if (!text.includes(OPEN)) return text;
  return text.replace(SENTINEL, (m, sc: string | undefined, i: string) => {
    if ((sc ?? '') !== scope) return '';
    const ref = refs[Number(i)];
    return ref ? value(ref) : m;
  });
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
 * A slot's rendered value: wi_format wraps non-empty lore and outlet values, the rest are as given.
 * Empty values stay empty so the block holding them can drop out.
 */
export function renderSlot(ref: SlotRef, value: string, formats: Preset['formats']): string {
  if (value === '') return '';
  return ref.kind === 'lore' || ref.kind === 'outlet' ? applyFormat(formats?.wi, value) : value;
}

/** Lowercased name when the raw template is exactly one macro without arguments, else null. */
export function soleMacro(raw: string): string | null {
  const nodes = parse(raw).filter((n) => !(n.kind === 'text' && n.value.trim() === ''));
  const only = nodes.length === 1 ? nodes[0] : undefined;
  return only?.kind === 'macro' && only.args.length === 0 ? only.name.toLowerCase() : null;
}

/**
 * ST's new_example_chat_prompt: every example dialogue (split on `<START>`, as ST's
 * parseMesExamples does) is headed by the format line instead of the bare `<START>` marker.
 */
export function formatExamples(examples: string, header: string | undefined): string {
  if (header === undefined || header === '' || examples.trim() === '') return examples;
  return examples
    .split(/<START>/i)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk) => `${header}\n${chunk}`)
    .join('\n');
}
