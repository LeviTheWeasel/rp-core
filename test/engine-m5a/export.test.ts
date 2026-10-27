// M5a D-163 through the engine: memoryExport writes the session's entries and overlays as a library
// lorebook ('core') or a RoleCall compendium-v1 file ('compendium'); an existing id or file is refused
// unless force; both read back (the library seed, importFile) with the same types, names and aliases.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceFile } from '../../src/agents/compendium/export.ts';
import { importFile } from '../../src/formats/import.ts';
import { libraryDir, loadFromLibrary } from '../../src/formats/library.ts';
import type { LoreBook } from '../../src/formats/native.ts';
import { bookSession, bookText, calls, fullCaps, LANTERN, memRows, putBook, refusalOf, rig } from './kit.ts';

/** A session with a typed entry, an overlay, a note and a retired entry. */
async function filled() {
  const r = await rig(calls(), { caps: fullCaps() });
  const id = putBook(r.home, LANTERN);
  const s = bookSession(r.engine, [id]);
  s.memoryFile({ type: 'character', data: { name: 'Арсений Кеттер', aliases: ['Мастер'], description: 'Старый мастер фонарей.' } });
  s.memoryEdit({ ref: 'C1', set: { role: 'ally' } });
  s.memoryAdd({ title: 'Ключи', content: 'Ключи у Миры.' });
  s.memoryFile({ type: 'item', data: { name: 'Латунный фонарь', description: 'Фонарь гильдии.' } });
  s.memoryRetire({ ref: 'Латунный фонарь', reason: 'утерян' });
  return { r, id, s };
}

describe('memoryExport', () => {
  test("core: a library lorebook (overlays whole, plain library entries left out); refused when taken unless force", async () => {
    const { r, id, s } = await filled();
    const rows = memRows(r.home, s.id).length;
    const out = s.memoryExport({ name: 'Сессия Один', format: 'core' });
    expect(out).toEqual({ id: 'сессия-один', path: join(libraryDir(r.home, 'lorebooks'), 'сессия-один.json'), entries: 4 });
    expect(memRows(r.home, s.id)).toHaveLength(rows);
    const book = loadFromLibrary(r.home, 'lorebooks', out.id) as LoreBook;
    expect(book.name).toBe('Сессия Один');
    expect(book.entries.map((e) => [e.title, e.meta?.type ?? null, e.enabled !== false])).toEqual([
      ['Мира', 'character', true],
      ['Арсений Кеттер', 'character', true],
      ['Ключи', null, true],
      ['Латунный фонарь', 'item', false],
    ]);

    const taken = refusalOf(() => s.memoryExport({ name: 'Сессия Один', format: 'core' }));
    expect(taken.code).toBe('invalid_params');
    expect(taken.message).toContain('already exists');
    s.memoryFile({ type: 'location', data: { name: 'Старая пристань' } });
    expect(s.memoryExport({ name: 'Сессия Один', format: 'core', force: true })).toEqual({ ...out, entries: 5 });
    expect((loadFromLibrary(r.home, 'lorebooks', out.id) as LoreBook).entries).toHaveLength(5);

    // The exported book seeds another session: the same typed entries, names and aliases.
    const t = bookSession(r.engine, [out.id]);
    const seeded = t.memoryList({ includeRetired: true }).filter((x) => x.type !== 'note');
    expect(seeded.map((x) => [x.type, x.name, x.aliases])).toEqual([
      ['character', 'Мира', ['Фонарщица']],
      ['character', 'Арсений Кеттер', ['Мастер']],
      ['location', 'Старая пристань', []],
    ]);
    expect(t.memoryGet({ ref: 'Мира' }).entry.data.role).toBe('ally');
    expect(id).toBe('lantern');
    await r.engine.close();
  });

  test('compendium: <home>/exports/<id>.compendium.json, refused when it exists unless force; importFile reads it back', async () => {
    const { r, s } = await filled();
    const out = s.memoryExport({ name: 'Сессия Один', format: 'compendium' });
    const path = join(r.home, 'exports', 'сессия-один.compendium.json');
    expect(out).toEqual({ id: 'сессия-один', path, entries: 4 });
    const file = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: string; lorebook: { name: string }; entries: unknown[] };
    expect(file.lorebook.name).toBe('Сессия Один');
    expect(file.entries).toHaveLength(4);

    expect(refusalOf(() => s.memoryExport({ name: 'Сессия Один', format: 'compendium' })).code).toBe('invalid_params');
    expect(s.memoryExport({ name: 'Сессия Один', format: 'compendium', force: true })).toEqual(out);

    const back = importFile(r.home, path, { as: 'Обратно' });
    expect(back.kind).toBe('lorebook');
    const entries = (back.value as LoreBook).entries;
    const typed = entries.filter((e) => e.meta?.type !== undefined);
    expect(typed.map((e) => [e.meta!.type, e.title, e.meta!.aliases ?? [], e.enabled !== false])).toEqual([
      ['character', 'Мира', ['Фонарщица'], true],
      ['character', 'Арсений Кеттер', ['Мастер'], true],
      ['item', 'Латунный фонарь', [], false],
    ]);
    expect(typed[0]!.meta!.data).toMatchObject({ name: 'Мира', role: 'ally' });
    expect(typed[1]!.meta!.data).toMatchObject({ name: 'Арсений Кеттер', description: 'Старый мастер фонарей.' });
    expect(entries.find((e) => e.title === 'Ключи')?.content).toBe('Ключи у Миры.');
    await r.engine.close();
  });

  test('refusals: a blank name, an unknown format', async () => {
    const { r, s } = await filled();
    expect(refusalOf(() => s.memoryExport({ name: ' — ', format: 'core' })).code).toBe('invalid_params');
    expect(refusalOf(() => s.memoryExport({ name: 'x', format: 'yaml' as 'core' })).code).toBe('invalid_params');
    expect(existsSync(join(r.home, 'exports'))).toBe(false);
    await r.engine.close();
  });
});

describe('memoryExport after the review', () => {
  test('compendium: the warnings of what the file cannot keep come back (featured_dropped)', async () => {
    const { r, s } = await filled();
    s.memoryEdit({ ref: 'Мира', featured: true });
    s.memoryEdit({ ref: 'Арсений Кеттер', featured: true });
    const out = s.memoryExport({ name: 'Двое', format: 'compendium' });
    expect(out.warnings?.map((w) => w.code)).toEqual(['featured_dropped']);
    expect(out.warnings![0]!.message).toContain('"Арсений Кеттер" is written unfeatured');
    // Nothing to warn about: no key.
    s.memoryEdit({ ref: 'Арсений Кеттер', featured: false });
    expect('warnings' in s.memoryExport({ name: 'Двое', format: 'compendium', force: true })).toBe(false);
    await r.engine.close();
  });

  test('while the Compendium is off the export still folds with the readable books (ruling I): overlays are not dropped', async () => {
    const { r, id, s } = await filled();
    const on = { core: s.memoryExport({ name: 'Вкл', format: 'core' }), compendium: s.memoryExport({ name: 'Вкл', format: 'compendium' }) };
    s.configure({ compendium: { enabled: false } });
    // Off: Мира's overlay (role ally) is no entry of the view, yet the export is the same.
    expect(s.memoryList().map((x) => x.name)).not.toContain('Мира');
    const core = s.memoryExport({ name: 'Выкл', format: 'core' });
    const compendium = s.memoryExport({ name: 'Выкл', format: 'compendium' });
    expect([core.entries, compendium.entries]).toEqual([on.core.entries, on.compendium.entries]);
    const book = loadFromLibrary(r.home, 'lorebooks', core.id) as LoreBook;
    expect(book.entries.map((e) => e.title)).toEqual((loadFromLibrary(r.home, 'lorebooks', on.core.id) as LoreBook).entries.map((e) => e.title));
    expect(book.entries.find((e) => e.title === 'Мира')?.meta?.data).toMatchObject({ role: 'ally' });
    // The same rows but for the ids a name derives.
    const rows = (path: string): unknown[] =>
      (JSON.parse(readFileSync(path, 'utf8')) as { entries: Record<string, unknown>[] }).entries.map(({ id: _id, lorebook_id: _book, ...rest }) => rest);
    expect(rows(compendium.path)).toEqual(rows(on.compendium.path));
    // A book set off stays out (it is not readable), as with the Compendium on.
    s.configure({ compendium: { books: { [id]: 'off' } } });
    expect(s.memoryExport({ name: 'Без книги', format: 'core' }).entries).toBe(on.core.entries - 1);
    await r.engine.close();
  });

  test('core: a name whose id is one of this session\'s books is refused, even with force; the book is untouched', async () => {
    const { r, id, s } = await filled();
    const book = bookText(r.home, id);
    for (const force of [false, true]) {
      const refused = refusalOf(() => s.memoryExport({ name: 'Lantern', format: 'core', force }));
      expect(refused).toEqual({
        code: 'invalid_params',
        message: `the library lorebook "${id}" is one of this session's books: exporting over it would replace it with this session's part of it; choose another name`,
      });
    }
    expect(bookText(r.home, id)).toBe(book);
    await r.engine.close();
  });

  test('core --force: a failed overwrite leaves no temp file behind and the old file as it was', async () => {
    const { r, s } = await filled();
    const dir = libraryDir(r.home, 'lorebooks');
    // The target is a folder: the rename over it fails after the temp file was written.
    mkdirSync(join(dir, 'папка.json', 'inner'), { recursive: true });
    const before = readdirSync(dir).sort();
    expect(() => s.memoryExport({ name: 'Папка', format: 'core', force: true })).toThrow();
    expect(readdirSync(dir).sort()).toEqual(before);
    // A good overwrite: the new text in place, no temp file.
    s.memoryExport({ name: 'Сессия', format: 'core' });
    s.memoryFile({ type: 'location', data: { name: 'Старая пристань' } });
    s.memoryExport({ name: 'Сессия', format: 'core', force: true });
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect((JSON.parse(readFileSync(join(dir, 'сессия.json'), 'utf8')) as LoreBook).entries.map((e) => e.title)).toContain('Старая пристань');
    await r.engine.close();
  });
});

describe('replaceFile', () => {
  test('replaces a file in place; when the rename fails the temp file is removed', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'rp-replace-'));
    const path = join(dir, 'a.json');
    writeFileSync(path, 'old');
    replaceFile(path, 'new');
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['a.json']);
    mkdirSync(join(dir, 'b.json', 'x'), { recursive: true });
    expect(() => replaceFile(join(dir, 'b.json'), 'text')).toThrow();
    expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json']);
    rmSync(dir, { recursive: true, force: true });
  });
});
