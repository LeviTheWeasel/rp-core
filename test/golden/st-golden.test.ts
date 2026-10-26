// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// SillyTavern golden snapshots (ARCHITECTURE.md §14 "Golden-фикстуры сборщика", §15 M2): each case
// in test/golden/st/ is imported with rp-core's own importers and assembled; the request must equal
// what SillyBunny sent (expected.json) once the named deviations below are normalised away.
//
// Named deviations (both sides are normalised, nothing else is):
// - G-1 example dialogue: ST sends an "[Example Chat]" system marker and one named system message
//   per line (example_user / example_assistant); rp-core sends the examples slot as one system
//   message, "Name: text" lines under each marker (§10.2 example slots). Compared as that text.
// - G-2 example-positioned lore without speaker lines: ST's parseMesExamples keeps only its marker
//   and drops the text; rp-core sends the text under the marker (no silent loss). Case 02.
// - G-3 in-chat merging (D-47): ST joins its extension prompts at one depth and role (author's note,
//   card depth prompt, world info, in that key order) into one message; rp-core keeps one message
//   per source, in the same order (depth.ts SOURCE_RANK). Compared merged, in rp-core's own order,
//   so the order itself is checked.
// - G-4 whole-word keys (D-46): ST's ASCII \W boundary fires `мир` inside `мирный`; rp-core's
//   Unicode boundary does not. Case 03.
import { describe, expect, test } from 'bun:test';
import { CASES, runCase, textOf, type GoldenRun, type Row } from './run.ts';

const EXAMPLE_MARKER = '[Example Chat]';

/** ST side: example runs (G-1) become one message; G-4 drops the ASCII-boundary hit. */
function stRows(run: GoldenRun): Row[] {
  const { character, persona } = run.c;
  const out: Row[] = [];
  let examples: string[] | null = null;
  const flush = (): void => {
    if (examples) out.push({ role: 'system', content: examples.join('\n') });
    examples = null;
  };
  for (const m of run.c.expected.messages) {
    const isMarker = m.role === 'system' && !m.name && m.content === EXAMPLE_MARKER;
    if (isMarker || m.name === 'example_user' || m.name === 'example_assistant') {
      examples ??= [];
      examples.push(isMarker ? EXAMPLE_MARKER : `${m.name === 'example_user' ? persona.name : character.name}: ${m.content}`);
      continue;
    }
    flush();
    let content = m.content;
    if (run.c.name === '03-wi-keys') content = dropLine(content, 'KEY мир (whole word; text has мирный).'); // G-4
    out.push({ role: m.role, content });
  }
  flush();
  return out;
}

const isExtensionPrompt = (src: string | undefined): boolean => src === 'author_note' || src === 'card_depth' || (src ?? '').startsWith('lore:');

/** rp-core side: G-2 drops plain-text example lore; G-3 merges same-role extension prompts. */
function rpRows(run: GoldenRun): Row[] {
  const plainExampleLore = new Set(
    run.result.trace.lore.fired
      .map((f) => run.c.world?.entries.find((e) => e.id === f.id))
      .filter((e) => e !== undefined && (e.position === 'examples_before' || e.position === 'examples_after'))
      .map((e) => e!.content)
      .filter((text) => !/^[^:\n]+:/m.test(text)),
  );
  const out: Row[] = [];
  const msgs = run.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.placement === 'inline' && isExtensionPrompt(m.src)) {
      const group = [m];
      while (i + 1 < msgs.length && msgs[i + 1]!.placement === 'inline' && isExtensionPrompt(msgs[i + 1]!.src) && msgs[i + 1]!.role === m.role) {
        group.push(msgs[++i]!);
      }
      out.push({ role: m.role, content: group.map((g) => textOf(g)).join('\n') });
      continue;
    }
    let content = textOf(m);
    if (content.startsWith(EXAMPLE_MARKER)) {
      content = content
        .split('\n')
        .filter((line) => !plainExampleLore.has(line))
        .join('\n');
    }
    out.push({ role: m.role, content });
  }
  return out;
}

const dropLine = (text: string, line: string): string =>
  text
    .split('\n')
    .filter((l) => l !== line)
    .join('\n');

describe('SillyTavern golden snapshots (SillyBunny 3021edcae)', () => {
  for (const name of CASES) {
    test(`${name}: the request equals SillyTavern's, deviations G-1…G-4 aside`, () => {
      const run = runCase(name);
      expect(rpRows(run)).toEqual(stRows(run));
      // The preset's reply cap and samplers are what ST sent.
      const p = run.c.expected.params;
      const s = run.c.preset.samplers ?? {};
      expect([s.max_tokens, s.temperature, s.top_p, s.presence_penalty, s.frequency_penalty]).toEqual([
        p.max_tokens,
        p.temperature,
        p.top_p,
        p.presence_penalty,
        p.frequency_penalty,
      ] as (number | undefined)[]);
    });
  }

  test('the deviations are real: without normalisation the cases differ exactly there', () => {
    // G-3 (case 06): rp-core keeps the author's note, card depth note and world info apart, in ST's order.
    const six = runCase('06-depth-sources').messages.filter((m) => m.placement === 'inline' && isExtensionPrompt(m.src));
    expect(six.map((m) => m.src)).toEqual(['author_note', 'card_depth', 'lore:world:0']);
    // G-4 (case 03): the Cyrillic whole-word entry does not fire in rp-core.
    const three = runCase('03-wi-keys');
    expect(three.c.expected.messages[1]!.content).toContain('KEY мир (whole word; text has мирный).');
    expect(three.result.trace.lore.fired.map((f) => f.id)).not.toContain('5');
    // G-2 (case 02): the plain example lore is sent under its marker.
    const two = runCase('02-wi-positions').messages.find((m) => textOf(m).startsWith(EXAMPLE_MARKER))!;
    expect(textOf(two)).toBe(
      `${EXAMPLE_MARKER}\nWI examples top, keyed harbor.\n${EXAMPLE_MARKER}\nLevi: Is the lamp lit?\nMira: Since dusk. It always is.\n${EXAMPLE_MARKER}\nWI examples bottom, keyed harbor.`,
    );
  });

  test('the lore budget of case 04 is ST\'s: 25 % of (1200 − 200) = 250 tokens', () => {
    expect(runCase('04-wi-budget').result.trace.lore.budget).toBe(250);
  });
});
