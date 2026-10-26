// Ported from Bunraku:src/formats/sillytavern/preset.test.ts@702d8120 (on its fixture
// samples/rolecall/presets/spec-walk.preset.json), RoleCall:packages/presets-core/src/__tests__/
// prompt-post-processing-roundtrip.test.ts@fb8dc623e and
// RoleCall:apps/rc/src/lib/presets/__tests__/preset-marker-slots.test.ts@fb8dc623e (the cases that
// still apply), plus Bunraku's teaching fixtures samples/sillytavern/fixtures/*.preset.json and
// samples/sillytavern/presets/plain.preset.json@702d8120.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ST chat-completion presets → core.preset/1 (st-preset.ts, import.ts detect; §10.2, §19.8). The
// fixtures are copied unchanged into test/fixtures/presets/bunraku/ (PROVENANCE.md). Expectations
// follow SillyTavern where the sources did not:
// - bare samplers ({temperature, top_p}) are not a preset (D-72; Bunraku claimed them);
// - a preset is named by its own `name` field when it has one, else after the file;
// - a duplicate prompt identifier is kept, disabled, under a suffixed id (Bunraku skipped it); a
//   legacy divider row is an ordinary empty block (divider groups are not ported, §19.8);
// - RoleCall's `prompt_post_processing` is not ST's key: a plain ST file's value is kept in extras,
//   not applied (the round trip's expectation flipped, as §19.8 asks); an unknown mode is not
//   normalised to 'none' but left out, in extras, with a warning;
// - markers become slot macros in the block text (§10.2); RoleCall's editor-only `marker` flag on
//   the structural five has no counterpart.
// Not taken: the emitter and every round trip (rp-core has no exporter yet), regex extraction
// (regex scripts are not honoured: extras plus a warning), the nemo-wiki dialect.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detect } from '../../src/formats/import.ts';
import { validatePreset, type Preset } from '../../src/formats/native.ts';
import { stPresetToPreset } from '../../src/formats/st-preset.ts';
import { assemble } from '../../src/prompt/assemble.ts';
import { input, longView, textOf } from '../prompt-m2/fixtures.ts';

const DIR = join(import.meta.dir, '..', 'fixtures', 'presets', 'bunraku');
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
const raw = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(DIR, `${name}.preset.json`), 'utf8')) as Record<string, unknown>;
const convert = (name: string) => stPresetToPreset(raw(name), `${name}.preset`);

const DUP = '5c1f0a52-19f6-4b58-b6ed-116e6ad565c9';
const ORPHAN = '0af1b2c3-d4e5-4f60-8172-93a4b5c6d7e8';

describe('detect (Bunraku)', () => {
  test('the spec-walk fixture and a prompt-manager shell are presets; bare samplers are not (D-72)', () => {
    expect(detect(readFileSync(join(DIR, 'spec-walk.preset.json'))).kind).toBe('st_preset');
    expect(detect(enc({ prompts: [], prompt_order: [] })).kind).toBe('st_preset');
    expect(detect(enc({ temperature: 1, top_p: 0.9 })).reason).toContain('not a SillyTavern chat-completion preset');
  });

  test('templates, other apps\' wrappers, an envelope of bare samplers and a textgen grid are refused', () => {
    expect(detect(enc({ name: 'I', system_prompt: 'x', input_sequence: 'a', output_sequence: 'b' })).reason).toContain('instruct template');
    expect(detect(enc({ name: 'C', story_string: '{{system}}' })).reason).toContain('context template');
    expect(detect(enc({ type: 'lumiverse_preset', data: {} })).kind).toBe('unknown');
    expect(detect(enc({ type: 'marinara_preset', data: { preset: {}, sections: [] } })).kind).toBe('unknown');
    expect(detect(enc({ exportedAt: 't', type: 'preset', version: '1.0', data: { temperature: 1 } })).kind).toBe('unknown');
    expect(detect(enc({ temp: 0.7, top_p: 0.9, top_k: 40 })).kind).toBe('unknown');
  });
});

describe('spec-walk.preset.json (Bunraku parse)', () => {
  const r = convert('spec-walk');
  const byId = new Map(r.value.blocks.map((b) => [b.id, b]));

  test('the name is the file\'s own; settings land sparsely', () => {
    expect(r.value.name).toBe('Spec Walk RC');
    expect(convert('plain').value.name).toBe('plain.preset'); // no name field: after the file
    expect(r.value.samplers?.temperature).toBe(0.9);
    expect(r.value.context?.maxContext).toBe(32000);
    expect(r.value.formats?.wi).toBe('[World: {0}]');
    // Settings rp-core does not honour ride extras; the live ones warn.
    expect(r.value.extras).toMatchObject({ reasoning_effort: 'high', n: 1, image_inlining: false });
    expect(r.warnings.map((w) => w.path)).toContain('reasoning_effort');
    expect(validatePreset(r.value).ok).toBe(true);
  });

  test('the enabled law: the global order decides, the orphan is appended disabled, the duplicate is kept disabled', () => {
    expect(r.value.blocks.map((b) => b.id)).toEqual(['main', '━━━ Style ━━━', DUP, 'chatHistory', 'worldInfoBefore', `${DUP}-2`, ORPHAN]);
    expect(byId.get('main')!.enabled).toBe(true);
    expect(byId.get(DUP)).toMatchObject({ enabled: false, content: 'Write vivid prose. No purple filler.' }); // the order says off; the first copy wins
    expect(byId.get(`${DUP}-2`)).toMatchObject({ enabled: false, content: 'later duplicate, first wins' });
    expect(byId.get(ORPHAN)!.enabled).toBe(false);
    expect(r.warnings.find((w) => w.code === 'duplicate_prompt')?.message).toContain('duplicate prompt identifier');
    // The divider row: an enabled block with nothing to send.
    expect(byId.get('━━━ Style ━━━')).toMatchObject({ enabled: true, content: '' });
    // A per-character order (424242) rides extras untouched.
    expect(r.value.extras?.prompt_order).toEqual([{ character_id: 424242, order: [{ identifier: 'main', enabled: false }, { identifier: 'chatHistory', enabled: true }] }]);
  });

  test('the marker law: main is content, chatHistory and worldInfoBefore are slots; a relative block keeps its depth in extras', () => {
    expect(byId.get('main')).toMatchObject({ content: 'You are {{char}}. Stay in character.', override: 'card_system' });
    expect(byId.get('chatHistory')!.content).toBe('{{history}}');
    expect(byId.get('worldInfoBefore')).toMatchObject({ content: '{{lore::before}}', at: 'relative' });
    expect(byId.get('worldInfoBefore')!.extras?.injection_depth).toBe(7);
  });

  test('unknown top-level keys survive in extras; the bundled regex scripts are not honoured and said', () => {
    expect(r.value.extras?.custom_unknown_knob).toEqual({ keep: 'me' });
    expect(r.value.extras?.another_unknown).toBe(7);
    expect(r.warnings.filter((w) => w.path.startsWith('extensions.')).map((w) => w.path)).toEqual(['extensions.regex_scripts', 'extensions.linkedRegexScripts']);
  });
});

describe('post-processing (RoleCall round trip, expectation flipped: ST reads custom_prompt_post_processing)', () => {
  const pp = (extra: Record<string, unknown>) => stPresetToPreset({ name: 'Round-trip preset', prompts: [], prompt_order: [], ...extra }, 'p');

  test("ST's key is applied; RoleCall's key in a plain ST file is kept, not applied", () => {
    expect(pp({ custom_prompt_post_processing: 'merge' }).value.postProcessing).toBe('merge');
    const rc = pp({ prompt_post_processing: 'merge' });
    expect(rc.value.postProcessing).toBeUndefined();
    expect(rc.value.extras?.prompt_post_processing).toBe('merge');
    expect(rc.warnings.map((w) => w.path)).toContain('prompt_post_processing');
  });

  test("an unsupported mode is not exported as 'none': it is left out, kept in extras, with a warning", () => {
    const r = pp({ custom_prompt_post_processing: 'provider-private-mode' });
    expect(r.value.postProcessing).toBeUndefined();
    expect(r.value.extras?.custom_prompt_post_processing).toBe('provider-private-mode');
    expect(r.warnings.find((w) => w.path === 'custom_prompt_post_processing')?.code).toBe('invalid_value');
  });
});

describe('marker slots (RoleCall preset-marker-slots)', () => {
  const IDS = ['chatHistory', 'personaDescription', 'dialogueExamples', 'charDescription', 'charPersonality', 'scenario', 'worldInfoBefore', 'worldInfoAfter'];
  const marker = (identifier: string) => ({ identifier, name: identifier, system_prompt: true, marker: true });
  const r = stPresetToPreset(
    {
      prompts: [...IDS.map(marker), marker('not-a-slot')],
      prompt_order: [{ character_id: 100001, order: [...IDS, 'not-a-slot'].map((identifier) => ({ identifier, enabled: true })) }],
    },
    'm',
  );

  test('each canonical ST marker identifier becomes its own slot, every slot once', () => {
    const content = Object.fromEntries(r.value.blocks.map((b) => [b.id, b.content]));
    expect(content).toMatchObject({
      chatHistory: '{{history}}',
      personaDescription: '{{persona}}',
      dialogueExamples: '{{lore::examples_before}}{{examples}}{{lore::examples_after}}',
      charDescription: '{{description}}',
      charPersonality: '{{personality}}',
      scenario: '{{scenario}}',
      worldInfoBefore: '{{lore::before}}',
      worldInfoAfter: '{{lore::after}}',
    });
    const slots = IDS.map((id) => content[id]);
    expect(new Set(slots).size).toBe(IDS.length);
    expect(r.value.blocks.filter((b) => IDS.includes(b.id)).every((b) => b.role === 'system' && b.at === 'relative' && b.enabled)).toBe(true);
  });

  test('a marker that names no slot sends nothing and says so', () => {
    expect(r.value.blocks.find((b) => b.id === 'not-a-slot')).toMatchObject({ enabled: false, content: '' });
    expect(r.warnings.map((w) => w.code)).toEqual(['unknown_marker']);
  });
});

describe("Bunraku's teaching presets import and assemble", () => {
  const build = (p: Preset) => {
    const res = assemble(input({ view: longView(), preset: p }));
    if (!res.ok) throw new Error(`${res.code}: ${res.message}`);
    return res.messages.map((m) => `${m.src}: ${textOf(m)}`);
  };

  test('minimal: two text blocks around the card slots and the chat; nothing to warn about', () => {
    const r = convert('minimal');
    expect(r.warnings).toEqual([]);
    const out = build(r.value);
    expect(out[0]).toStartWith('main: You are Mira, writing one turn of a back and forth story with Levi.');
    expect(out.at(-1)).toBe("jailbreak: Before writing: stay in Mira's voice, keep it short, and leave Levi something to answer.");
    expect(out.filter((l) => l.startsWith('history: '))).toHaveLength(6);
  });

  test('utility: setvar / getvar resolve in block order, the toggle block is off, the reminder sits at depth 0', () => {
    const r = convert('utility');
    const out = build(r.value);
    expect(out).toContain('utility_output_length: Reply length setting: medium. Aim for two or three short paragraphs and stop there.');
    expect(out).toContain('utility_output_language: Write every reply in English, narration and dialogue alike.');
    expect(r.value.blocks.find((b) => b.id === 'utility_formatting_toggle')!.enabled).toBe(false);
    expect(out.at(-1)).toBe('preset:utility_final_reminder: Reminder: reply in English at the medium length set above.');
    // {{if}} / {{else}} / {{/if}} are not macros SillyTavern's classic engine or rp-core expands: said at import, sent as written.
    expect(r.warnings.filter((w) => w.code === 'unknown_macro').map((w) => w.message.split(' ')[0])).toEqual(['{{else}}', '{{/if}}']);
  });

  test("tracker: no global order (its order is character 100000), so SillyTavern's default order applies and its tracker blocks stay off", () => {
    const r = convert('tracker');
    expect(r.warnings.map((w) => w.code)).toEqual(['no_global_order']);
    expect(r.value.blocks.filter((b) => b.id.startsWith('tracker-')).map((b) => b.enabled)).toEqual([false, false, false]);
    expect(build(r.value).some((l) => l.includes('Current scene'))).toBe(false);
  });

  test('plain and spec-walk build the same request (spec-walk is plain plus RoleCall extras)', () => {
    expect(build(convert('spec-walk').value)).toEqual(build(convert('plain').value));
  });
});
