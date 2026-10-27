// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// `rp-core import x.compendium.json`, `/lore add <file>` and `new --lore` with a RoleCall Compendium
// export (D-162): detected as 'compendium' (no longer a character_book), saved as a library lorebook
// named after `lorebook.name`, so the §15 demo's `/lore add lantern` finds it. Every test gets its own
// home (test/preload.ts isolates RP_CORE_HOME as well).
import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLoreRef } from '../../src/cli/refs.ts';
import { compendiumChunks } from '../../src/formats/compendium-v1.ts';
import { detect, detectKind, ImportError, importFile } from '../../src/formats/import.ts';
import { listLibrary, loadFromLibrary } from '../../src/formats/library.ts';
import { validateLoreBook, type LoreBook } from '../../src/formats/native.ts';
import { tmpHome } from '../helpers.ts';

const LANTERN = join(import.meta.dir, '..', 'fixtures', 'ru', 'lantern', 'lantern.compendium.json');
const lantern = (): Record<string, unknown> => JSON.parse(readFileSync(LANTERN, 'utf8')) as Record<string, unknown>;

function write(name: string, v: unknown): string {
  const p = join(tmpHome('rp-core-src-'), name);
  writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
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

describe('rp-core import lantern.compendium.json', () => {
  test("detected as a compendium, not a character_book any more", () => {
    const bytes = readFileSync(LANTERN);
    expect(detect(bytes)).toEqual({ kind: 'compendium' });
    expect(detectKind(bytes, 'lantern.compendium.json')).toBe('compendium');
  });

  test('saved as library lorebook "lantern" (canonicalId of lorebook.name), valid, typed entries intact', () => {
    const home = tmpHome();
    const r = importFile(home, LANTERN);
    expect(r.kind).toBe('lorebook');
    expect(r.id).toBe('lantern');
    expect(r.path).toBe(join(home, 'library', 'lorebooks', 'lantern.json'));
    const stored = loadFromLibrary(home, 'lorebooks', 'lantern') as LoreBook;
    expect(validateLoreBook(stored).ok).toBe(true);
    expect(stored.name).toBe('Lantern');
    expect(stored.entries).toHaveLength(18);
    expect(stored.entries.filter((e) => e.meta?.type !== undefined)).toHaveLength(16);
    expect(stored.entries.find((e) => e.meta?.arc !== undefined)?.meta).toEqual({ arc: 'Украденный свет' });
    expect(r.warnings.map((w) => [w.code, w.path])).toEqual([['not_honoured', 'tree']]);
    expect(listLibrary(home, 'lorebooks')).toEqual([{ id: 'lantern', name: 'Lantern' }]);
  });

  test('importing it again is a no-op, not a copy', () => {
    const home = tmpHome();
    expect(importFile(home, LANTERN).id).toBe('lantern');
    expect(importFile(home, LANTERN).id).toBe('lantern');
    expect(listLibrary(home, 'lorebooks').map((b) => b.id)).toEqual(['lantern']);
  });

  test('--as names the book (id and name)', () => {
    const r = importFile(tmpHome(), LANTERN, { as: 'Фонари Вельмара' });
    expect([r.id, r.value.name]).toEqual(['фонари-вельмара', 'Фонари Вельмара']);
  });

  test("no lorebook.name: the file stem without RoleCall's .compendium suffix", () => {
    const f = lantern();
    f.lorebook = { ...(f.lorebook as object), name: '' };
    const r = importFile(tmpHome(), write('harbor.compendium.json', f));
    expect([r.id, r.value.name]).toEqual(['harbor', 'harbor']);
    expect(importFile(tmpHome(), write('plain.json', f)).id).toBe('plain');
  });

  test('inside an export envelope: unwrapped and said', () => {
    const r = importFile(tmpHome(), write('wrapped.json', { exportedAt: '2026-10-20', type: 'lorebook', version: '1', data: lantern() }));
    expect(r.id).toBe('lantern');
    expect(r.warnings.map((w) => w.code)).toEqual(['repaired_json', 'not_honoured']);
  });

  test('our own export imports back', () => {
    const text = [
      ...compendiumChunks({ name: 'Lantern 2', exportDate: '2026-10-27T12:00:00.000Z' }, [
        { key: 'character:мира', title: 'Мира', content: '# Мира', enabled: true, constant: false, keys: ['Мира'], type: 'character', data: { name: 'Мира' } },
      ]),
    ].join('');
    const r = importFile(tmpHome(), write('lantern2.compendium.json', text));
    if (r.kind !== 'lorebook') throw new Error(`imported as ${r.kind}`);
    expect([r.id, r.value.entries[0]?.meta]).toEqual(['lantern-2', { type: 'character', data: { name: 'Мира' } }]);
  });
});

describe('/lore add <file> and new --lore (importFile with expect: lorebook)', () => {
  test('resolveLoreRef imports the file and hands back the book', () => {
    const home = tmpHome();
    const r = resolveLoreRef(home, LANTERN);
    expect(r.id).toBe('lantern');
    expect(r.value.entries).toHaveLength(18);
    expect(r.imported?.warnings.map((w) => w.code)).toEqual(['not_honoured']);
    // and afterwards by library id, as the §15 demo types it
    expect(resolveLoreRef(home, 'lantern').value.name).toBe('Lantern');
  });

  test('expect: lorebook accepts it; expect: character refuses it by name', () => {
    expect(importFile(tmpHome(), LANTERN, { expect: 'lorebook' }).kind).toBe('lorebook');
    const e = importError(() => importFile(tmpHome(), LANTERN, { expect: 'character' }));
    expect(e.code).toBe('wrong_kind');
    expect(e.message).toBe('lantern.compendium.json: expected a character card, but this is a RoleCall Compendium export');
  });

  test('a tagged file without its lorebook object is refused with a reason, not read as a character_book', () => {
    const e = importError(() => importFile(tmpHome(), write('broken.compendium.json', { format: 'rolecall-compendium', lorebook: null, entries: [{ content: 'x' }] })));
    expect(e.code).toBe('unknown_format');
    expect(e.message).toBe('broken.compendium.json: a RoleCall Compendium export without a lorebook object and an entries list; nothing to import');
  });
});

/** The value of an own '__proto__' key (reading `o.__proto__` would give the prototype). */
const ownProto = (o: unknown): unknown => (typeof o === 'object' && o !== null ? Object.getOwnPropertyDescriptor(o, '__proto__')?.value : undefined);

describe('hostile files (review breaker#3, breaker#9)', () => {
  test('structured_data nested 20 000 levels imports flattened, with a warning; the stored book stays small', () => {
    const n = 20_000;
    const deep = `${'{"a":'.repeat(n)}"x"${'}'.repeat(n)}`;
    const home = tmpHome();
    const r = importFile(
      home,
      write(
        'deep.compendium.json',
        `{"schemaVersion":"compendium-v1.0.0","lorebook":{"name":"Deep"},"entries":[{"id":"a","title":"Глубина","content":"",` +
          `"metadata":{"entry_type":"character","structured_data":{"name":"Глубина","deep":${deep}}}}]}`,
      ),
    );
    expect(r.warnings.map((w) => [w.code, w.path])).toEqual([['too_deep', 'entries[0].metadata.structured_data']]);
    expect(statSync(r.path).size).toBeLessThan(10_000);
    const stored = loadFromLibrary(home, 'lorebooks', r.id) as LoreBook;
    expect(validateLoreBook(stored).ok).toBe(true);
    const entry = stored.entries[0];
    expect(entry?.content.startsWith('# Глубина')).toBe(true);
    let x: unknown = (entry?.meta?.data as Record<string, unknown>).deep;
    for (let level = 2; level < 33; level++) x = (x as Record<string, unknown>).a;
    expect(typeof x === 'string' && x.startsWith('{"a":{"a":') && x.endsWith('…')).toBe(true);
  });

  test("'__proto__' keys survive the import and the library round trip as plain keys", () => {
    const home = tmpHome();
    const file = write(
      'proto.compendium.json',
      '{"schemaVersion":"compendium-v1.0.0","lorebook":{"name":"Proto","__proto__":{"evil":1}},"entries":[{"id":"a","content":"x","__proto__":{"category":"Hacked"}}]}',
    );
    const r = importFile(home, file);
    expect(r.warnings.map((w) => w.message)).toEqual(['unknown lorebook field "__proto__" kept in extras', 'unknown column "__proto__" kept in extras']);
    const stored = loadFromLibrary(home, 'lorebooks', r.id) as LoreBook;
    expect(validateLoreBook(stored).ok).toBe(true);
    expect(ownProto(stored.extras)).toEqual({ evil: 1 });
    expect(ownProto(stored.entries[0]?.extras)).toEqual({ category: 'Hacked' });
    expect(stored.entries[0]?.extras?.category).toBeUndefined();
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });
});
