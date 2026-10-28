// M5a REPL (D-161, D-163): /memory export in both formats, the --force rule, its parsing; the help
// lines and the subcommands that arrive with M5c.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { helpText, parseLine } from '../../src/cli/repl-commands.ts';
import { importFile } from '../../src/formats/import.ts';
import { loadFromLibrary } from '../../src/formats/library.ts';
import type { LoreBook } from '../../src/formats/native.ts';
import { after, calls, editorOf, lanternRig, memRows, MIRA_TEXT } from './kit.ts';

describe('/memory export', () => {
  test('core (the default): a library lorebook; again only with --force; then a RoleCall file, which imports back', async () => {
    const r = await lanternRig(calls(), { editor: editorOf(MIRA_TEXT, (t) => t.replace('"description": "Смотрительница', '"description": "Бывшая смотрительница')) });
    r.type(
      '/memory new character Мира',
      '/memory edit Ульяна',
      '/memory add Ключи | | Ключи у Арсения.',
      '/memory export Фонари Вельмара',
      '/memory export Фонари Вельмара',
      '/memory export Фонари Вельмара --force',
      '/memory export lantern-out --format compendium',
      '/memory export lantern-out --format=compendium',
      '/memory export lantern-out --format compendium --force',
    );
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const bookPath = join(r.home, 'library', 'lorebooks', 'фонари-вельмара.json');
    // Мира, the overlay of Ульяна and the note: the plain library entries stay in the library.
    expect(after(out, '/memory export Фонари Вельмара')).toBe(
      `/memory export: the library lorebook "фонари-вельмара" already exists (${bookPath}); export with force to overwrite it (/memory export Фонари Вельмара --format core --force)\n`,
    );
    expect(out).toContain(`exported 3 entries as the library lorebook фонари-вельмара: ${bookPath}\n`);
    expect(after(out, '/memory export Фонари Вельмара --force')).toBe(`exported 3 entries as the library lorebook фонари-вельмара: ${bookPath}\n`);
    const book = loadFromLibrary(r.home, 'lorebooks', 'фонари-вельмара') as LoreBook;
    expect(book.name).toBe('Фонари Вельмара');
    // Handle order: the overlay (C3) first, then the session's entries.
    expect(book.entries.map((e) => e.title)).toEqual(['Ульяна', 'Мира', 'Ключи']);

    const file = join(r.home, 'exports', 'lantern-out.compendium.json');
    expect(out).toContain(`exported 3 entries as a RoleCall Compendium file (compendium-v1.0.0): ${file}\n`);
    expect(after(out, '/memory export lantern-out --format=compendium')).toBe(
      `/memory export: the export "lantern-out.compendium.json" already exists (${file}); export with force to overwrite it (/memory export lantern-out --format compendium --force)\n`,
    );
    expect(after(out, '/memory export lantern-out --format compendium --force')).toBe(`exported 3 entries as a RoleCall Compendium file (compendium-v1.0.0): ${file}\n`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ format: 'rolecall-compendium', schemaVersion: 'compendium-v1.0.0' });
    // An export writes no row.
    expect(memRows(r).map((m) => m.ops[0]!.op)).toEqual(['file', 'edit', 'note']);
    // The round trip of the demo: the file imports as a typed book again.
    const back = importFile(r.home, file, { as: 'Обратно' });
    const mira = (back.value as LoreBook).entries.find((e) => e.title === 'Мира')!;
    expect(mira.meta).toMatchObject({ type: 'character', aliases: ['Фонарщица'] });
  });

  test('an empty scope still writes a valid file; parse errors', async () => {
    const r = await lanternRig(calls());
    r.type('/memory export empty --format compendium', '/memory export', '/memory export x --format yaml', '/memory export x --bogus', '/memory export x --format');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('exported 0 entries as a RoleCall Compendium file (compendium-v1.0.0): ');
    expect(existsSync(join(r.home, 'exports', 'empty.compendium.json'))).toBe(true);
    expect(after(out, '/memory export')).toBe('/memory export needs a name: /memory export <name> [--format core|compendium] [--force]\n');
    expect(after(out, '/memory export x --format yaml')).toBe('/memory export: --format takes core or compendium, got "yaml"\n');
    expect(after(out, '/memory export x --bogus')).toBe('/memory export: unknown flag --bogus (/memory export <name> [--format core|compendium] [--force])\n');
    expect(after(out, '/memory export x --format')).toBe('/memory export: --format takes core or compendium\n');
  });

  test('parsing: the words left after the flags are the name', () => {
    const cmd = (l: string): unknown => {
      const p = parseLine(l);
      return p.kind === 'command' ? p.command : p;
    };
    expect(cmd('/memory export Фонари Вельмара')).toEqual({ name: 'memory', action: 'export', exportName: 'Фонари Вельмара' });
    expect(cmd('/memory export --force out --format core')).toEqual({ name: 'memory', action: 'export', exportName: 'out', format: 'core', force: true });
    expect(cmd('/memory export "my book"')).toEqual({ name: 'memory', action: 'export', exportName: 'my book' });
    expect(cmd('/memory export a --format core --format compendium')).toEqual({ kind: 'error', message: '/memory export: --format given twice' });
  });
});

describe('help and later', () => {
  test('/help lists the M5a subcommands; recall\'s are later (the agents\' arrived with M5b)', async () => {
    const help = helpText();
    for (const s of [
      '/memory [list] [type|note|arc] [--retired]',
      '/memory show <ref>, /memory tree [book]',
      '/memory new <type> [name]',
      '/memory edit <ref>  change an entry in the editor',
      '/memory add <title> | <keys> | <text>',
      '/memory edit <ref> <title> | <keys> | <text>',
      '/memory retire <ref> [reason], /memory restore <ref>',
      '/memory export <name> [--format core|compendium] [--force]',
      'Later: /memory recall|profile|mode (M5c, recall).',
    ]) {
      expect(help).toContain(s);
    }
    const r = await lanternRig(calls());
    r.type('/memory recall', '/memory profile lite', '/memory mode sync', '/memory forget C1');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    for (const s of ['recall', 'profile', 'mode']) expect(out).toContain(`/memory ${s} arrives with M5c (recall)\n`);
    expect(after(out, '/memory forget C1')).toBe('/memory: "forget" is not a subcommand; /memory lists the Compendium, then show, tree, new, add, edit, retire, restore, export, on, off, undo, refile, retry, wait, status\n');
  });
});
