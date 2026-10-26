// The library folder (§5.2): atomic writes under canonicalId, id-2 on collision, tolerant listing.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { libraryDir, listLibrary, loadFromLibrary, saveToLibrary } from '../../src/formats/library.ts';
import { tmpHome } from '../helpers.ts';

describe('library', () => {
  test('libraryDir', () => {
    expect(libraryDir('/h', 'lorebooks')).toBe(join('/h', 'library', 'lorebooks'));
  });

  test('save writes pretty JSON under canonicalId and leaves no temp files', () => {
    const home = tmpHome();
    const { id, path } = saveToLibrary(home, 'characters', 'Мира Солнцева', { name: 'Мира Солнцева', n: 1 });
    expect(id).toBe('мира-солнцева');
    expect(path).toBe(join(home, 'library', 'characters', 'мира-солнцева.json'));
    expect(readFileSync(path, 'utf8')).toBe('{\n  "name": "Мира Солнцева",\n  "n": 1\n}\n');
    expect(readdirSync(libraryDir(home, 'characters'))).toEqual(['мира-солнцева.json']);
  });

  test('collisions: different content → id-2, id-3; same content → same id', () => {
    const home = tmpHome();
    const a = saveToLibrary(home, 'presets', 'Alice', { name: 'Alice', v: 1 });
    const b = saveToLibrary(home, 'presets', 'alice', { name: 'alice', v: 2 });
    const c = saveToLibrary(home, 'presets', 'ALICE!', { name: 'ALICE!', v: 3 });
    const again = saveToLibrary(home, 'presets', 'Alice', { name: 'alice', v: 2 });
    expect([a.id, b.id, c.id, again.id]).toEqual(['alice', 'alice-2', 'alice-3', 'alice-2']);
    expect(loadFromLibrary(home, 'presets', 'alice')).toEqual({ name: 'Alice', v: 1 });
    expect(loadFromLibrary(home, 'presets', 'alice-3')).toEqual({ name: 'ALICE!', v: 3 });
    expect(readdirSync(libraryDir(home, 'presets')).sort()).toEqual(['alice-2.json', 'alice-3.json', 'alice.json']);
  });

  test('an unnamed value saves as untitled', () => {
    expect(saveToLibrary(tmpHome(), 'personas', '***', { name: '' }).id).toBe('untitled');
  });

  test('load: missing → null, broken JSON throws, unsafe ids are refused', () => {
    const home = tmpHome();
    expect(loadFromLibrary(home, 'characters', 'nobody')).toBeNull();
    const dir = libraryDir(home, 'characters');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{ nope');
    expect(() => loadFromLibrary(home, 'characters', 'broken')).toThrow(/invalid JSON/);
    for (const bad of ['../x', 'a/b', 'a\\b', '.hidden', '']) {
      expect(() => loadFromLibrary(home, 'characters', bad)).toThrow(/invalid library id/);
    }
  });

  test('list: sorted ids with names; missing folder → []; broken and temp files tolerated', () => {
    const home = tmpHome();
    expect(listLibrary(home, 'lorebooks')).toEqual([]);
    saveToLibrary(home, 'lorebooks', 'Zeta', { name: 'Zeta', entries: [] });
    saveToLibrary(home, 'lorebooks', 'Alpha', { name: 'Alpha', entries: [] });
    const dir = libraryDir(home, 'lorebooks');
    writeFileSync(join(dir, 'broken.json'), '{');
    writeFileSync(join(dir, '.123-1.tmp'), 'partial');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect(listLibrary(home, 'lorebooks')).toEqual([
      { id: 'alpha', name: 'Alpha' },
      { id: 'broken', name: 'broken' },
      { id: 'zeta', name: 'Zeta' },
    ]);
    expect(existsSync(join(dir, 'alpha.json'))).toBe(true);
  });
});
