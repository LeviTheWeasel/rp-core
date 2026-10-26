// `rp-core import` detection and saving (D-72): fixed order PNG card, JSON card, ST preset, ST WI,
// bare character_book, else refuse; readings as-is, double-encoded, export envelope.
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detect, detectKind, ImportError, importFile } from '../../src/formats/import.ts';
import { listLibrary, loadFromLibrary } from '../../src/formats/library.ts';
import { tmpHome } from '../helpers.ts';
import { b64json, chunk, makePng } from './png-writer.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'cards');
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Jay', description: 'd', first_mes: 'hi' } };
const preset = { temperature: 1, prompts: [{ identifier: 'main' }], prompt_order: [], name: 'P', extensions: {} };
const worldInfo = { entries: { '0': { uid: 0, key: ['a'], content: 'x' } } };
const charBook = { name: 'B', entries: [{ keys: ['a'], content: 'x' }], extensions: {} };

describe('detectKind', () => {
  test('each kind in the fixed order', () => {
    expect(detectKind(readFileSync(join(FIXTURES, 'Seraphina.png')), 'Seraphina.png')).toBe('png_card');
    expect(detectKind(enc(card), 'c.json')).toBe('json_card');
    expect(detectKind(enc({ name: 'Flat', description: 'd' }), 'c.json')).toBe('json_card');
    expect(detectKind(enc(preset), 'p.json')).toBe('st_preset');
    expect(detectKind(enc(worldInfo), 'w.json')).toBe('st_worldinfo');
    expect(detectKind(enc({ entries: {} }), 'w.json')).toBe('st_worldinfo');
    expect(detectKind(enc(charBook), 'b.json')).toBe('character_book');
    expect(detectKind(enc({ spec: 'lorebook_v3', data: charBook }), 'b.json')).toBe('character_book');
  });

  test('order: a card that also looks like something else is still a card; WI beats character_book', () => {
    // a settings-looking flat object is never a card (firewall); with samplers only it is no preset either
    expect(detectKind(enc({ name: 'x', description: 'd', temperature: 1 }), 'x.json')).toBe('unknown');
    expect(detectKind(enc({ name: 'x', description: 'd', temperature: 1, prompt_order: [] }), 'x.json')).toBe('st_preset');
    // a V2 envelope is a card even if its data carries entries-like fields
    expect(detectKind(enc({ ...card, data: { ...card.data, entries: [] } }), 'x.json')).toBe('json_card');
    // an object with both an entries object and preset markers is a preset (preset comes first)
    expect(detectKind(enc({ ...worldInfo, prompts: [] }), 'x.json')).toBe('st_preset');
  });

  test('readings: double-encoded and enveloped files are recognised', () => {
    expect(detectKind(enc(JSON.stringify(JSON.stringify(card))), 'c.json')).toBe('json_card');
    expect(detectKind(enc({ exportedAt: '2026-10-01', type: 'preset', data: preset }), 'p.json')).toBe('st_preset');
    expect(detectKind(enc(JSON.stringify(JSON.stringify({ version: '1', type: 'card', data: card }))), 'c.json')).toBe('json_card');
  });

  test('the honest reading wins over repairs', () => {
    // a card that is itself an envelope-looking object stays a card
    expect(detectKind(enc({ ...card, exportedAt: 'x', type: 'preset' }), 'c.json')).toBe('json_card');
  });

  test('unknown: garbage, plain JSON, a PNG without a card, an Agnai memory book', () => {
    expect(detectKind(enc('not json'), 'x')).toBe('unknown');
    expect(detectKind(enc({ hello: 'world' }), 'x.json')).toBe('unknown');
    expect(detectKind(enc('"just a string"'), 'x.json')).toBe('unknown');
    expect(detectKind(makePng([{ type: 'tEXt', keyword: 'Software', text: 'x' }]), 'x.png')).toBe('unknown');
    expect(detectKind(enc({ name: 'm', entries: [{ keywords: ['a'], entry: 'x' }] }), 'x.json')).toBe('unknown');
  });

  test('only chat-completion presets are SillyTavern presets (D-72): text-completion presets and request bodies are refused with a reason', () => {
    // SillyBunny's NovelAI presets (default/content/presets/novel/*.json) carry temperature and no prompts.
    const novel = { temperature: 1.16, max_length: 150, min_length: 1, top_k: 175, tail_free_sampling: 0.9, repetition_penalty: 1.68, order: [1, 0, 3] };
    expect(detect(enc(novel))).toEqual({
      kind: 'unknown',
      reason: 'this is a SillyTavern text-completion preset (NovelAI samplers: max_length, min_length, tail_free_sampling), not a chat-completion preset; it is not imported',
    });
    expect(detect(enc({ model: 'gpt-4o', temperature: 0.7, messages: [{ role: 'user', content: 'hi' }] })).reason).toContain('an API request body');
    expect(detect(enc({ temperature: 0.7 })).reason).toContain('not a SillyTavern chat-completion preset');
    // A legacy (pre prompt-manager) preset and one with only a global order still are presets.
    expect(detectKind(enc({ temperature: 0.9, main_prompt: 'Be {{char}}.' }), 'p.json')).toBe('st_preset');
    expect(detectKind(enc({ temperature: 0.9, openai_max_context: 4095 }), 'p.json')).toBe('st_preset');
  });

  test('a PNG card in iTXt is detected', () => {
    expect(detectKind(makePng([{ type: 'iTXt', keyword: 'ccv3', text: b64json(card), compressed: true }]), 'x.png')).toBe('png_card');
  });
});

describe('importFile', () => {
  const write = (dir: string, name: string, v: unknown): string => {
    const p = join(dir, name);
    writeFileSync(p, v instanceof Uint8Array ? v : enc(v));
    return p;
  };

  test('a PNG card lands in library/characters under its canonical id', () => {
    const home = tmpHome();
    const r = importFile(home, join(FIXTURES, 'Seraphina.png'));
    expect(r.kind).toBe('character');
    expect(r.id).toBe('seraphina');
    expect(r.path).toBe(join(home, 'library', 'characters', 'seraphina.json'));
    expect(r.value.name).toBe('Seraphina');
    // Seraphina's linked world "Eldoria" is its embedded character_book: no "import it separately" warning.
    expect(r.warnings.map((w) => w.path)).not.toContain('data.extensions.world');
    expect(r.kind === 'character' ? r.value.book?.name : undefined).toBe('Eldoria');
    expect(loadFromLibrary(home, 'characters', 'seraphina')).toEqual(JSON.parse(JSON.stringify(r.value)));
  });

  test('re-import is idempotent; --as renames the library id only; a changed card gets id-2', () => {
    const home = tmpHome();
    const src = tmpHome('rp-core-src-');
    const file = write(src, 'jay.json', card);
    expect(importFile(home, file).id).toBe('jay');
    expect(importFile(home, file).id).toBe('jay');
    const renamed = importFile(home, file, { as: 'Джей Второй' });
    expect(renamed.id).toBe('джей-второй');
    expect(renamed.value.name).toBe('Jay');
    const changed = write(src, 'jay2.json', { ...card, data: { ...card.data, description: 'changed' } });
    expect(importFile(home, changed).id).toBe('jay-2');
    expect(listLibrary(home, 'characters').map((x) => x.id)).toEqual(['jay', 'jay-2', 'джей-второй']);
  });

  test('double-encoded JSON card imports with a repair warning', () => {
    const home = tmpHome();
    const file = write(tmpHome('rp-core-src-'), 'x.json', JSON.stringify(JSON.stringify(card)));
    const r = importFile(home, file);
    expect(r.value.name).toBe('Jay');
    expect(r.warnings.map((w) => w.code)).toContain('repaired_json');
  });

  test('M2: presets and world books import into their library folders', () => {
    const home = tmpHome();
    const src = tmpHome('rp-core-src-');
    const p = importFile(home, write(src, 'p.json', preset));
    expect([p.kind, p.id, p.path]).toEqual(['preset', 'p', join(home, 'library', 'presets', 'p.json')]);
    const w = importFile(home, write(src, 'w.json', worldInfo));
    expect([w.kind, w.id, w.path]).toEqual(['lorebook', 'w', join(home, 'library', 'lorebooks', 'w.json')]);
    const b = importFile(home, write(src, 'b.json', charBook));
    expect([b.kind, b.id]).toEqual(['lorebook', 'b']);
    expect(listLibrary(home, 'lorebooks').map((x) => x.id)).toEqual(['b', 'w']);
  });

  test('unknown files say why; missing files are unreadable', () => {
    const home = tmpHome();
    const src = tmpHome('rp-core-src-');
    const err = (file: string): ImportError => {
      try {
        importFile(home, file);
      } catch (e) {
        if (e instanceof ImportError) return e;
        throw e;
      }
      throw new Error('expected ImportError');
    };
    const unknown = err(write(src, 'u.json', { hello: 1 }));
    expect(unknown.code).toBe('unknown_format');
    expect(unknown.message).toContain('u.json');
    expect(err(join(src, 'missing.png')).code).toBe('unreadable');
    const broken = err(write(src, 'bad.png', makePng([{ type: 'tEXt', keyword: 'chara', text: 'not-a-card' }])));
    expect(broken.code).toBe('unreadable');
    // Foreign JSON records name what they are.
    const vn = err(write(src, 'vn.json', { name: 'VN', description: 'd', cast: [], scenes: [], story_graph: [] }));
    expect(vn.code).toBe('unknown_format');
    expect(vn.message).toContain('visual-novel project');
    const agnai = err(write(src, 'robot.json', { kind: 'character', name: 'Robot', greeting: 'Beep.', scenario: 's', persona: {} }));
    expect(agnai.message).toContain('Agnai character');
    // A PNG whose only card chunk is corrupt is a card file: the import says what is wrong with it.
    const kw = new TextEncoder().encode('ccv3');
    const base = makePng([]);
    const zbad = chunk('zTXt', Uint8Array.of(...kw, 0, 0, 0x78, 0x9c, 1, 2, 3, 4, 5));
    const corrupt = new Uint8Array([...base.subarray(0, base.length - 12), ...zbad, ...base.subarray(base.length - 12)]);
    expect(detectKind(corrupt, 'c.png')).toBe('png_card');
    const zerr = err(write(src, 'c.png', corrupt));
    expect(zerr.code).toBe('unreadable');
    expect(zerr.message).toContain('the ccv3 chunk could not be decoded');
    expect(listLibrary(home, 'characters')).toEqual([]);
  });
});
