// M5a REPL after the final check (.notes/m5a-decisions.md §I): a verb's notices on every path, a no-op
// too (engine#2); notices deduplicated by code and message (lorebook_missing per book); /lore add of a
// book the Compendium reads (its entries join, the handles after them change); piped input that keeps
// the editor's line out of the story when /memory new|edit is refused before the editor opens;
// /memory edit <name with spaces>; the off line and notes; the arc confirmation's field name; the
// location template's help line (fidelity#4).
import { describe, expect, test } from 'bun:test';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLine } from '../../src/cli/repl-commands.ts';
import { newEntryText } from '../../src/cli/repl-memory.ts';
import { COMPENDIUM_OFF, COMPENDIUM_OFF_NOTES } from '../../src/cli/repl.ts';
import { messageText } from '../../src/cli/render.ts';
import { importFile } from '../../src/formats/import.ts';
import type { SessionHandle } from '../../src/engine/api.ts';
import { after, calls, editorOf, LANTERN_FILE, lanternHome, lanternRig, memRows, seededSession } from './kit.ts';
import { replRig } from '../repl/kit.ts';

const TS = '2026-10-26T12:00:00.000Z';
const big = (name: string): Record<string, unknown> => ({ name, description: `${name} — ${'очень длинное описание. '.repeat(600)}` });
const fileRow = (data: Record<string, unknown>) => ({ t: 'mem' as const, ts: TS, key: null, on: null, by: 'user' as const, ops: [{ op: 'file' as const, type: 'character' as const, data }] });
const noteRow = (title: string, content: string) => ({ t: 'mem' as const, ts: TS, key: null, on: null, by: 'user' as const, ops: [{ op: 'note' as const, title, keys: [], content }] });
const LARGE = /^! The Compendium entry "Большой" \(C16\) holds \d+ characters.*\(compendium_large_entry\)$/;
const userTexts = (s: SessionHandle): string[] => s.view().path.filter((m) => m.role === 'user').map(messageText);

/** The lantern export again, its book named `name` (a second world with the same entries); its library id. */
function copyOfLantern(home: string, name: string): string {
  const src = JSON.parse(readFileSync(LANTERN_FILE, 'utf8')) as { lorebook: { name: string } };
  src.lorebook.name = name;
  const file = join(home, 'copy.compendium.json');
  writeFileSync(file, JSON.stringify(src));
  return importFile(home, file).id;
}

describe('a verb that changes nothing still prints its notices (engine#2)', () => {
  test('a restore of a live entry and a one-line note edit to the same text: "nothing changed", then the notice', async () => {
    for (const line of ['/memory restore C16', '/memory edit Ключи | | Ключи у Арсения.']) {
      const { home, book } = lanternHome();
      const id = await seededSession(home, { lorebooks: [book] }, [fileRow(big('Большой')), noteRow('Ключи', 'Ключи у Арсения.')]);
      const r = await replRig(calls([{ text: 'Мира кивает.' }]), { home, sessionId: id });
      r.type(line, 'Привет.');
      await r.until('Мира кивает.');
      await r.close();
      const out = r.out();
      const said = after(out, line).split('\n');
      expect(said[0]).toBe(line.startsWith('/memory restore') ? '/memory restore: "Большой" is not retired; nothing changed' : '/memory edit: nothing changed, nothing written');
      expect(said[1]).toMatch(LARGE);
      // Told once: the turn after it does not repeat it, and nothing was written.
      expect(out.split('(compendium_large_entry)').length - 1).toBe(1);
      expect(memRows(r)).toHaveLength(2);
    }
  });

  test('a file that merges nothing and an editor edit the engine finds already there print the notices they return', async () => {
    const notice = { level: 'warn' as const, code: 'library_entry_missing', message: 'Пропала запись книги.' };
    const r = await lanternRig(calls(), {
      editor: editorOf('{"name": "Ян"}', (t) => t.replace('"description": "', '"description": "Ещё раз: ')),
      wrap: (s) =>
        new Proxy(s, {
          get: (t, p) => {
            const unchanged = { key: t.memoryList({}).find((x) => x.ref === 'C3')!.key, changed: false, notices: [notice] };
            if (p === 'memoryFile') return () => ({ ...unchanged, ref: 'C3', change: 'merged' });
            if (p === 'memoryEdit') return () => ({ ...unchanged, notices: [{ ...notice, message: 'Пропала другая запись.' }] });
            const v = Reflect.get(t, p) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          },
        }),
    });
    r.type('/memory new character', '/memory edit C3');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(after(out, '/memory new character')).toBe(
      '/memory new: nothing changed, nothing written (character C3 "Ульяна" already holds all of it)\n! Пропала запись книги. (library_entry_missing)\n',
    );
    expect(after(out, '/memory edit C3')).toBe('/memory edit: nothing changed, nothing written\n! Пропала другая запись. (library_entry_missing)\n');
  });
});

describe('notices: once per code and message, never per code alone', () => {
  test('two missing books are two lorebook_missing lines', async () => {
    const r = await replRig(calls([{ text: 'Ок.' }]), { config: { lorebooks: ['gone-one', 'gone-two'] } });
    r.type('Привет.');
    await r.until('Ок.');
    await r.close();
    const out = r.out();
    expect(out).toContain("! The lorebook 'gone-one' is skipped: it is not in the library. (lorebook_missing)\n");
    expect(out).toContain("! The lorebook 'gone-two' is skipped: it is not in the library. (lorebook_missing)\n");
  });
});

describe('/lore add of a book the Compendium reads', () => {
  test('its entries join /memory now, the handles after them change, the session\'s changes to them apply again', async () => {
    const { home } = lanternHome();
    const harbor = copyOfLantern(home, 'Harbor');
    const r = await lanternRig(calls(), { home, editor: editorOf('{"name": "Ян"}', (t) => t.replace('"role": "', '"likes": ["чай"], "role": "')) });
    r.type('/memory new character', '/memory edit Ульяна', '/lore rm lantern', '/lore add lantern', `/lore add ${harbor}`, '/memory list character', '/memory retire C16');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(after(out, '/memory new character')).toBe('character C16 "Ян" filed (from the next turn)\n');
    expect(after(out, '/lore add lantern')).toBe(
      'lorebook lantern "Lantern" added: 18 entries (from the next turn); its 15 Compendium entries join /memory now, ' +
        "and the C<n> of the entries after them change; this session's changes to 1 of them apply again\n",
    );
    expect(after(out, `/lore add ${harbor}`)).toBe(
      `lorebook ${harbor} "Harbor" added: 18 entries (from the next turn); its 15 Compendium entries join /memory now, and the C<n> of the entries after them change\n`,
    );
    expect(after(out, '/memory list character')).toMatch(/^ +C31 Ян( |$)/m);
    // C16 is the new book's first entry now: the line above is what tells the person so.
    expect(after(out, '/memory retire C16')).toStartWith('character C16 "Арсений Кеттер" retired');
  });

  test('nothing after the book: no handle changes; a book that replaces another; off: the M2 line alone', async () => {
    const { home } = lanternHome();
    // The same book under another library id: the same name, so adding it replaces lantern.
    const twin = 'lantern-b';
    copyFileSync(join(home, 'library', 'lorebooks', 'lantern.json'), join(home, 'library', 'lorebooks', `${twin}.json`));
    const harbor = copyOfLantern(home, 'Harbor');
    const r = await lanternRig(calls(), { home, books: [], editor: editorOf('{"name": "Ян"}') });
    r.type('/lore add lantern', '/memory new character', `/lore add ${twin}`, '/memory off', `/lore add ${harbor}`);
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(after(out, '/lore add lantern')).toBe('lorebook lantern "Lantern" added: 18 entries (from the next turn); its 15 Compendium entries join /memory now\n');
    expect(after(out, `/lore add ${twin}`)).toBe(
      `lorebook ${twin} "Lantern" replaces lantern: same name, and a world is read once by name (18 entries, from the next turn; /lore add lantern brings the old one back); ` +
        `lantern's 15 Compendium entries leave /memory and ${twin}'s 15 join it now\n`,
    );
    expect(after(out, `/lore add ${harbor}`)).toBe(`lorebook ${harbor} "Harbor" added: 18 entries (from the next turn)\n`);
  });
});

describe('piped input: a /memory new|edit refused before its editor opens takes the editor\'s line', () => {
  test('a taken name, an unknown ref, a mistyped command: each JSON line is skipped, never sent as a message', async () => {
    const r = await lanternRig(calls([{ text: 'Здравствуй.' }]), { env: {}, deps: { editText: undefined } });
    r.type(
      '/memory new character Ульяна',
      '{"name": "Ульяна", "description": "моя версия"}',
      '/memory edit C99',
      '{"name": "Нет"}',
      '/memory new charcter Ян',
      '{"name": "Ян"}',
      '/memory edit',
      '{"name": "Ещё"}',
      'Привет',
    );
    await r.until('Здравствуй.');
    // The line meant for the editor may also arrive after the refusal.
    r.type('/memory new character Ульяна');
    await r.until('"Ульяна" is already C3', 2);
    r.type('{"name": "Ульяна"}', '/memory list character');
    await r.until('C3 Ульяна');
    await r.close();
    const out = r.out();
    const SKIP = '(the next line, meant for the editor, was skipped)';
    expect(after(out, '/memory new character Ульяна')).toBe(`/memory new: "Ульяна" is already C3; use /memory edit C3\n${SKIP}\n`);
    expect(after(out, '/memory edit C99')).toBe(`/memory edit: no single entry matches "C99" (use its C<n> handle or key)\n${SKIP}\n`);
    expect(after(out, '/memory new charcter Ян')).toStartWith('/memory new: "charcter" is not an entry type');
    expect(after(out, '/memory new charcter Ян')).toEndWith(`\n${SKIP}\n`);
    expect(after(out, '/memory edit')).toBe(`usage: /memory edit <ref> opens an entry in the editor; a note also takes <ref> <title> | <keys> | <text> (an empty part keeps the old value)\n${SKIP}\n`);
    expect(out).toContain('Mira › Здравствуй.');
    expect(userTexts(r.session)).toEqual(['Привет']);
    expect(memRows(r)).toHaveLength(0);
  });

  test('an entry whose text holds ⏎ cannot be edited in place: its line is skipped too', async () => {
    const r = await lanternRig(calls(), { env: {}, deps: { editText: undefined } });
    r.session.memoryFile({ type: 'character', data: { name: 'Ян', description: 'Юнга ⏎ с «Чайки».' } });
    r.type('/memory edit Ян', '{"name": "Ян", "description": "Юнга."}');
    r.end();
    expect(await r.done).toBe(0);
    expect(after(r.out(), '/memory edit Ян')).toBe(
      'this message contains ⏎ itself; set $EDITOR to edit it in an editor\n(the next line, meant for the editor, was skipped)\n/memory edit cancelled: nothing written\n',
    );
    expect(userTexts(r.session)).toEqual([]);
  });

  test('an editor of its own takes no line: the refusal alone', async () => {
    const r = await lanternRig(calls(), { editor: editorOf('{"name": "Ян"}') });
    r.type('/memory new character Ульяна', '/memory new character');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(after(out, '/memory new character Ульяна')).toBe('/memory new: "Ульяна" is already C3; use /memory edit C3\n');
    expect(after(out, '/memory new character')).toBe('character C16 "Ян" filed (from the next turn)\n');
  });
});

describe('/memory edit <name with spaces>', () => {
  test('without a "|" the whole rest of the line is the ref and opens the editor', async () => {
    const r = await lanternRig(calls(), { editor: editorOf((t) => JSON.stringify({ ...(JSON.parse(t) as object), description: 'Маяк снова горит.' })) });
    r.type('/memory edit Серый маяк');
    r.end();
    expect(await r.done).toBe(0);
    expect(after(r.out(), '/memory edit Серый маяк')).toBe('location C6 "Серый маяк" changed: set description (from the next turn; the book file stays as it is)\n');
    expect(parseLine('/memory edit Серый маяк')).toEqual({ kind: 'command', command: { name: 'memory', action: 'edit', ref: 'Серый маяк' } });
    expect(parseLine('/memory edit "Серый маяк"')).toEqual({ kind: 'command', command: { name: 'memory', action: 'edit', ref: 'Серый маяк' } });
    // With a '|' it is the note form (M3): the ref is one word, or quoted.
    expect(parseLine('/memory edit "Old lighthouse" New | | Rebuilt')).toEqual({
      kind: 'command',
      command: { name: 'memory', action: 'edit', ref: 'Old lighthouse', title: 'New', content: 'Rebuilt' },
    });
  });
});

describe('while off, notes are still sent', () => {
  test('/memory off and the whole list say only typed entries are held back; a list of notes says nothing', async () => {
    const r = await lanternRig(calls(), { books: [] });
    r.type('/memory add Ключи | ключи | Ключи у Арсения.', '/memory off', '/memory list note', '/memory list', '/memory list character');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(COMPENDIUM_OFF_NOTES).toBe('the Compendium is off for this session: typed entries are kept but not sent; notes still are (/memory on)');
    expect(after(out, '/memory off')).toBe(`${COMPENDIUM_OFF_NOTES}\n`);
    expect(after(out, '/memory list note')).not.toContain('the Compendium is off');
    expect(after(out, '/memory list note')).toContain('C1 Ключи');
    expect(after(out, '/memory list')).toStartWith(`${COMPENDIUM_OFF_NOTES}\n`);
    expect(after(out, '/memory list character')).toBe(`${COMPENDIUM_OFF}\nno character entries on this path\n`);
  });
});

describe('the location template (fidelity#4)', () => {
  test('the /memory new help line shows the type enum and current_state.status', async () => {
    const r = await lanternRig(calls(), { editor: editorOf(null) });
    r.type('/memory new location');
    r.end();
    expect(await r.done).toBe(0);
    const template = JSON.parse(r.edited[0]!) as Record<string, unknown>;
    expect(template).toEqual(JSON.parse(newEntryText('location')) as Record<string, unknown>);
    expect(template['//']).toBe(
      'fill what you know; blank fields are ignored. type: city|town|village|settlement|building|room|dungeon|wilderness|region|realm|plane; ' +
        'current_state.status: normal|under_attack|destroyed|abandoned|occupied|sealed|hidden',
    );
    expect(Object.keys(template)).toEqual(['//', 'name', 'aliases', 'description', 'type', 'parent_location', 'current_state', 'connected_to']);
  });
});

describe('/memory retire <name of several words> [reason]', () => {
  test('the longest run of leading words that names a live entry is the ref, the rest the reason', async () => {
    const { home } = lanternHome();
    const r = await lanternRig(calls(), { home });
    r.type('/memory retire Арсений Кеттер ушёл на покой', '/memory show C1', '/memory retire C2 Кеттер');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(after(out, '/memory retire Арсений Кеттер ушёл на покой')).toStartWith('character C1 "Арсений Кеттер" retired');
    const shown = after(out, '/memory show C1');
    expect(shown).toContain('ушёл на покой');
    // The reason is only what follows the name (the parser's split would keep «Кеттер» in it).
    expect(shown).not.toContain('Кеттер ушёл');
    // A handle keeps the parser's split: «Кеттер» is C2's reason, never a name.
    expect(after(out, '/memory retire C2 Кеттер')).toMatch(/^\S+ C2 ".+" retired/);
  });
});
