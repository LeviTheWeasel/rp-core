// `rp-core import` for M2 kinds (D-72): ST presets → library/presets, ST world info and bare
// character_book → library/lorebooks; opts.expect and 'wrong_kind'; readings (double-encoded JSON,
// export envelopes); the self-check before saving.
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detect, importCard, ImportError, importFile, type ImportedKind } from '../../src/formats/import.ts';
import { listLibrary, loadFromLibrary } from '../../src/formats/library.ts';
import { validateLoreBook, validatePreset } from '../../src/formats/native.ts';
import { tmpHome } from '../helpers.ts';

const FIX = join(import.meta.dir, '..', 'fixtures');
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

function write(dir: string, name: string, v: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, v instanceof Uint8Array ? v : enc(v));
  return p;
}

function importError(fn: () => unknown): ImportError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ImportError) return e;
    throw e;
  }
  throw new Error('expected ImportError');
}

const stPreset = {
  temperature: 0.8,
  proxy_password: 'hunter2-secret',
  reverse_proxy: 'https://proxy.invalid',
  prompts: [
    { identifier: 'main', name: 'Main', role: 'system', content: 'Be {{char}}.' },
    { identifier: 'chatHistory', name: 'Chat History', marker: true, system_prompt: true },
  ],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
};
const card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Jay',
    description: 'd',
    first_mes: 'hi',
    character_book: { name: 'Jay lore', entries: [{ keys: ['tower'], content: 'The tower is old.', id: 7, enabled: true }] },
  },
};
const bareCard = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Kay', description: 'd', first_mes: 'hi' } };

describe('presets', () => {
  test("SillyTavern's Default.json: named after the file, valid, saved under library/presets", () => {
    const home = tmpHome();
    const r = importFile(home, join(FIX, 'presets', 'Default.json'));
    expect(r.kind).toBe('preset');
    if (r.kind !== 'preset') return;
    expect([r.id, r.value.name]).toEqual(['default', 'Default']);
    expect(r.path).toBe(join(home, 'library', 'presets', 'default.json'));
    expect(validatePreset(loadFromLibrary(home, 'presets', 'default')).ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['not_honoured', 'not_honoured']);
    // Default.json ships an empty proxy_password: the key itself never reaches the library
    const text = readFileSync(r.path, 'utf8');
    for (const key of ['proxy_password', 'reverse_proxy', 'custom_url', 'chat_completion_source', 'openai_model']) expect(text).not.toContain(key);
  });

  test('secrets never reach the library file; the name field wins over the file name; --as renames', () => {
    const home = tmpHome();
    const src = tmpHome('rp-core-src-');
    const file = write(src, 'whatever.json', { ...stPreset, name: 'My Preset' });
    const r = importFile(home, file);
    expect(r.id).toBe('my-preset');
    expect(readFileSync(r.path, 'utf8')).not.toContain('hunter2');
    expect(readFileSync(r.path, 'utf8')).not.toContain('proxy');
    const renamed = importFile(home, file, { as: 'Пресет' });
    expect([renamed.id, renamed.value.name]).toEqual(['пресет', 'My Preset']);
  });

  test('re-import is idempotent; a different file with the same name gets a suffixed id', () => {
    const home = tmpHome();
    const src = tmpHome('rp-core-src-');
    const a = write(src, 'p.json', stPreset);
    expect(importFile(home, a).id).toBe('p');
    expect(importFile(home, a).id).toBe('p');
    const b = write(tmpHome('rp-core-src-'), 'p.json', { ...stPreset, temperature: 1.2 });
    expect(importFile(home, b).id).toBe('p-2');
    expect(listLibrary(home, 'presets').map((x) => x.id)).toEqual(['p', 'p-2']);
  });

  test('double-encoded JSON and export envelopes import with a repair warning', () => {
    const home = tmpHome();
    const src = tmpHome('rp-core-src-');
    const twice = importFile(home, write(src, 'twice.json', JSON.stringify(JSON.stringify(stPreset))));
    expect([twice.kind, twice.id]).toEqual(['preset', 'twice']);
    expect(twice.warnings[0]?.code).toBe('repaired_json');
    const env = importFile(home, write(src, 'env.json', { exportedAt: '2026-10-01', type: 'preset', data: stPreset }));
    expect([env.kind, env.id]).toEqual(['preset', 'env']);
    expect(env.warnings[0]?.code).toBe('repaired_json');
  });

  test('self-check: a preset that cannot be laid out is refused as unreadable, nothing is written', () => {
    const home = tmpHome();
    const src = tmpHome('rp-core-src-');
    // A RoleCall export holding the chat twice ({{message_history}} in two blocks).
    const broken = {
      ...stPreset,
      extensions: { rolecall: {} },
      prompts: [...stPreset.prompts, { identifier: 'a', content: '{{message_history}}' }, { identifier: 'b', content: '{{message_history}}' }],
      prompt_order: [{ character_id: 100001, order: ['main', 'chatHistory', 'a', 'b'].map((identifier) => ({ identifier, enabled: true })) }],
    };
    const e = importError(() => importFile(home, write(src, 'broken.json', broken)));
    expect(e.code).toBe('unreadable');
    expect(e.message).toContain('broken.json: preset maps to an invalid preset (blocks: must contain exactly one enabled {{history}} slot');
    expect(listLibrary(home, 'presets')).toEqual([]);
  });

  test('instruct and context templates are not chat-completion presets', () => {
    const instruct = detect(enc({ name: 'ChatML', input_sequence: '<|im_start|>user', output_sequence: '<|im_start|>assistant' }));
    expect(instruct.kind).toBe('unknown');
    expect(instruct.reason).toContain('instruct template');
    expect(detect(enc({ name: 'Default', story_string: '{{description}}' })).reason).toContain('context template');
    const e = importError(() => importFile(tmpHome(), write(tmpHome('rp-core-src-'), 'chatml.json', { input_sequence: 'x' })));
    expect(e.code).toBe('unknown_format');
  });
});

// Regression: KoboldAI and text-generation presets (`temp`, `rep_pen`, `sampler_order`, no
// `temperature`), ST system prompts and reasoning templates fell through to the generic "not a
// card, preset, world info or character_book", while README promises a reason.
describe("SillyTavern's other settings files are refused with what they are", () => {
  const TC = join(FIX, 'presets', 'text-completion');

  test("SillyTavern's KoboldAI and text-generation presets (copied from its defaults)", () => {
    const kobold = detect(readFileSync(join(TC, 'kobold-Neutral.json')));
    expect(kobold).toEqual({
      kind: 'unknown',
      reason: 'this is a SillyTavern text-completion preset (KoboldAI samplers: temp, rep_pen, sampler_order), not a chat-completion preset; it is not imported',
    });
    const textgen = detect(readFileSync(join(TC, 'textgen-Neutral.json')));
    expect(textgen.kind).toBe('unknown');
    expect(textgen.reason).toStartWith('this is a SillyTavern text-completion preset (text-generation samplers: ');
    const home = tmpHome();
    const e = importError(() => importFile(home, join(TC, 'kobold-Neutral.json')));
    expect(e.code).toBe('unknown_format');
    expect(e.message).toBe(`kobold-Neutral.json: ${kobold.reason}`);
    expect(listLibrary(home, 'presets')).toEqual([]);
  });

  test('small synthetic ones: the backends by their own fields, a stray key is not enough', () => {
    expect(detect(enc({ temp: 0.7, rep_pen: 1.1, sampler_order: [6, 0, 1] })).reason).toContain('(KoboldAI samplers: temp, rep_pen, sampler_order)');
    expect(detect(enc({ temp: 1, rep_pen: 1.05, sampler_priority: ['temperature'], dry_multiplier: 0 })).reason).toContain('(text-generation samplers: temp, rep_pen, sampler_priority)');
    expect(detect(enc({ temp: 1, tfs: 1 })).reason).toContain('(NovelAI, KoboldAI or text-generation samplers: temp, tfs)');
    // One sampler-like key in an unrelated JSON stays plain unknown JSON.
    expect(detect(enc({ hello: 'world', temp: 3 })).reason).toBe('JSON that is not a character card, SillyTavern preset, world info or character_book');
  });

  test("an Advanced Formatting system prompt or reasoning template (SillyTavern's sysprompt/ and reasoning/ shapes)", () => {
    const sys = detect(enc({ name: 'Actor', content: 'You are an expert actor.', post_history: '' }));
    expect(sys).toEqual({
      kind: 'unknown',
      reason: "this is a SillyTavern system prompt (Advanced Formatting), not a chat-completion preset; it is not imported (its text belongs in a preset's main prompt)",
    });
    const reasoning = detect(enc({ name: 'DeepSeek', prefix: '<think>\n', suffix: '\n</think>', separator: '\n\n' }));
    expect(reasoning.reason).toBe('this is a SillyTavern reasoning template (Advanced Formatting: prefix, suffix, separator), not a chat-completion preset; it is not imported');
  });

  test('none of them is ever read as a card, and chat-completion presets still import', () => {
    for (const o of [
      { name: 'Actor', content: 'x', post_history: '', description: 'a prompt' },
      { name: 'Think', prefix: '<think>', suffix: '</think>', separator: '', description: 'x' },
      { name: 'K', temp: 0.7, rep_pen: 1.1, description: 'x', first_mes: 'hi' },
    ]) {
      expect(detect(enc(o)).kind).toBe('unknown');
    }
    expect(detect(readFileSync(join(FIX, 'presets', 'Default.json'))).kind).toBe('st_preset');
    expect(detect(enc(stPreset)).kind).toBe('st_preset');
  });
});

describe('lorebooks', () => {
  test("ST's Eldoria world info → library/lorebooks, valid, literal match, named after the file", () => {
    const home = tmpHome();
    const r = importFile(home, join(FIX, 'worlds', 'Eldoria.json'));
    expect(r.kind).toBe('lorebook');
    if (r.kind !== 'lorebook') return;
    expect([r.id, r.value.name, r.value.match, r.value.entries.length]).toEqual(['eldoria', 'Eldoria', 'literal', 4]);
    expect(r.path).toBe(join(home, 'library', 'lorebooks', 'eldoria.json'));
    expect(validateLoreBook(loadFromLibrary(home, 'lorebooks', 'eldoria')).ok).toBe(true);
    expect(r.value.entries.map((e) => e.id)).toEqual(['0', '1', '2', '3']);
    expect(r.value.entries[0]?.keys).toEqual(['eldoria', 'wood', 'forest', 'magical forest']);
  });

  test('an empty world info book imports as an empty lorebook', () => {
    const home = tmpHome();
    const r = importFile(home, write(tmpHome('rp-core-src-'), 'Empty Book.json', { entries: {} }));
    expect([r.kind, r.id, r.value.name]).toEqual(['lorebook', 'empty-book', 'Empty Book']);
    expect(r.value).toEqual({ name: 'Empty Book', match: 'literal', entries: [] });
    expect(r.warnings).toEqual([]);
  });

  test('a bare character_book (and a lorebook_v3 wrapper) imports with its own name', () => {
    const home = tmpHome();
    const src = tmpHome('rp-core-src-');
    const book = { name: 'Towers', scan_depth: 3, entries: [{ keys: ['tower'], content: 'Old.', id: 1 }] };
    const r = importFile(home, write(src, 'b.json', book));
    expect([r.kind, r.id]).toEqual(['lorebook', 'towers']);
    if (r.kind !== 'lorebook') return;
    // SillyTavern ignores a book's own scan_depth: it rides extras, named in a warning.
    expect(r.value.scanDepth).toBeUndefined();
    expect(r.value.extras?.scan_depth).toBe(3);
    expect(r.warnings.some((w) => w.code === 'not_honoured' && w.path === 'scan_depth')).toBe(true);
    const v3 = importFile(home, write(src, 'v3.json', { spec: 'lorebook_v3', data: { ...book, name: 'Towers V3' } }));
    expect([v3.kind, v3.id]).toEqual(['lorebook', 'towers-v3']);
  });
});

describe('expect and wrong_kind', () => {
  test('a file of another kind is refused before anything is written', () => {
    const home = tmpHome();
    const src = tmpHome('rp-core-src-');
    const files: [string, ImportedKind][] = [
      [write(src, 'p.json', stPreset), 'preset'],
      [write(src, 'w.json', { entries: {} }), 'lorebook'],
      [write(src, 'c.json', bareCard), 'character'],
    ];
    for (const [file, kind] of files) {
      for (const expectKind of ['character', 'preset', 'lorebook'] as const) {
        if (expectKind === kind) continue;
        if (expectKind === 'lorebook' && kind === 'character') continue; // a card may carry a book: below
        const e = importError(() => importFile(home, file, { expect: expectKind }));
        expect(e.code).toBe('wrong_kind');
        expect(e.message).toContain(`expected a ${expectKind === 'character' ? 'character card' : expectKind}`);
      }
      expect(importFile(home, file, { expect: kind }).kind).toBe(kind);
    }
    expect(importError(() => importCard(tmpHome(), files[0]![0])).code).toBe('wrong_kind');
    const fresh = tmpHome();
    importError(() => importFile(fresh, files[0]![0], { expect: 'lorebook' }));
    expect(['characters', 'presets', 'lorebooks'].flatMap((k) => listLibrary(fresh, k as 'presets'))).toEqual([]);
  });

  test("expect 'lorebook' on a card imports its embedded book, named after the card unless --as", () => {
    const home = tmpHome();
    const src = tmpHome('rp-core-src-');
    const file = write(src, 'jay.json', card);
    const r = importFile(home, file, { expect: 'lorebook' });
    expect([r.kind, r.id, r.path]).toEqual(['lorebook', 'jay', join(home, 'library', 'lorebooks', 'jay.json')]);
    if (r.kind !== 'lorebook') return;
    expect(r.value.name).toBe('Jay lore');
    expect(r.value.entries.map((e) => [e.id, e.keys])).toEqual([['7', ['tower']]]);
    expect(listLibrary(home, 'characters')).toEqual([]);
    expect(importFile(home, file, { expect: 'lorebook', as: 'Башня' }).id).toBe('башня');
    // the card's own (non-book) warnings are not the book's business
    expect(r.warnings.every((w) => /character_book/.test(w.path) || w.code === 'repaired_json')).toBe(true);
  });

  test("expect 'lorebook' on a card without a book is wrong_kind", () => {
    const e = importError(() => importFile(tmpHome(), write(tmpHome('rp-core-src-'), 'kay.json', bareCard), { expect: 'lorebook' }));
    expect(e.code).toBe('wrong_kind');
    expect(e.message).toContain('no embedded lorebook');
  });

  test('a PNG card with expect character still imports (new --card)', () => {
    const r = importCard(tmpHome(), join(FIX, 'cards', 'Seraphina.png'));
    expect([r.kind, r.id]).toEqual(['character', 'seraphina']);
  });
});
