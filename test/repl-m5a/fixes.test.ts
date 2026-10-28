// M5a REPL after the review (.notes/m5a-decisions.md §H): /memory on|off and what /memory says while the
// Compendium is off (engine#3), the notices the verbs return (engine#2) and the export's warnings
// (fidelity#5, breaker#10), the editor re-opened only where a person can fix the text (engine#5), what
// /lore rm does to /memory (engine#8), the entry limit apart from the budget in /trace (prompt#8), and
// verbs that change nothing (the ruling on no-op verbs).
import { describe, expect, test } from 'bun:test';
import { compendiumTraceLine } from '../../src/cli/repl-render.ts';
import { parseLine } from '../../src/cli/repl-commands.ts';
import { messageText } from '../../src/cli/render.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { currentConfig } from '../../src/session/fold.ts';
import type { CompendiumTrace } from '../../src/session/entries.ts';
import { after, calls, editorOf, lanternHome, lanternRig, memRows, MIRA_TEXT, seededSession } from './kit.ts';
import { replRig } from '../repl/kit.ts';

const OFF = 'the Compendium is off for this session: entries are kept but not sent (/memory on)';

const enabledOf = (r: { home: string; session: { id: string } }): unknown => {
  const f = readSessionFile(r.home, r.session.id);
  return currentConfig(f.header, f.entries).compendium?.enabled;
};

describe('/memory on|off (engine#3)', () => {
  test('a session stored with the Compendium off: /memory and every confirmation say so; /memory on switches it at once', async () => {
    const r = await lanternRig(calls(), {
      config: { compendium: { enabled: false } },
      editor: editorOf(
        MIRA_TEXT,
        (t) => t.replace('"role": "protagonist"', '"role": "rival"'),
        (t) => t.replace('"description": ""', '"description": "Юнга."'),
      ),
    });
    r.type(
      '/memory',
      '/memory new character Мира',
      '/memory edit Мира',
      '/memory retire Мира',
      '/memory restore Мира',
      '/memory add Ключи | | Ключи у Арсения.',
      '/memory off',
      '/memory on',
      '/memory list character',
      '/memory new character Ян',
      '/memory on',
    );
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    // Off: no library entry is listed (the books' typed entries are plain lore), and the list says why.
    expect(after(out, '/memory')).toStartWith(`${OFF}\nnothing in the Compendium on this path yet`);
    expect(after(out, '/memory new character Мира')).toBe(`character C1 "Мира" filed; ${OFF}\n`);
    expect(after(out, '/memory edit Мира')).toBe(`character C1 "Мира" changed: set role; ${OFF}\n`);
    expect(after(out, '/memory retire Мира')).toBe(`character C1 "Мира" retired (/memory restore C1 brings it back); ${OFF}\n`);
    expect(after(out, '/memory restore Мира')).toBe(`character C1 "Мира" restored; ${OFF}\n`);
    // A note is sent whatever the switch says.
    expect(after(out, '/memory add Ключи | | Ключи у Арсения.')).toBe('note C2 "Ключи" added (note:ключи): from the next turn it is sent when Ключи comes up\n');
    expect(after(out, '/memory off')).toBe('the Compendium is already off for this session (/memory on)\n');
    // On: the book's 16 entries (15 typed, the [Arc] overview, D-177) come first, the session's handles follow them.
    expect(out.split('› /memory on\n')[1]).toStartWith('the Compendium is on for this session: 18 live entries on this path, sent as they come up from the next turn (/memory lists them)\n');
    const list = after(out, '/memory list character');
    expect(list).not.toContain(OFF);
    expect(list).toContain('C17 Мира');
    expect(list).toContain('C1  Арсений Кеттер');
    expect(out).toContain('character C19 "Ян" filed (from the next turn)\n');
    expect(out.endsWith('the Compendium is already on for this session\n')).toBe(true);
    expect(enabledOf(r)).toBe(true);
  });

  test('/memory off: entries are kept, the list says it is off, the books are plain lore; parsing', async () => {
    const r = await lanternRig(calls());
    r.type('/memory off', '/memory list location');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(after(out, '/memory off')).toBe(`${OFF}; the books' typed entries are sent as plain lore\n`);
    expect(after(out, '/memory list location')).toBe(`${OFF}\nno location entries on this path\n`);
    expect(enabledOf(r)).toBe(false);
    expect(parseLine('/memory on now')).toEqual({ kind: 'error', message: "/memory on takes nothing after it (/memory on sends the Compendium's entries, /memory off stops it)" });
    expect(parseLine('/memory OFF')).toEqual({ kind: 'command', command: { name: 'memory', action: 'off' } });
  });
});

describe('notices and warnings (engine#2, fidelity#5, breaker#10)', () => {
  const big = (name: string): string => JSON.stringify({ name, description: `${name} — ${'очень длинное описание. '.repeat(600)}` });

  test('a verb prints the notices it returns, one line each; the next turn does not repeat them', async () => {
    const r = await lanternRig(calls([{ text: 'Мира кивает.' }]), { editor: editorOf(big('Большой'), big('Огромный')) });
    r.type('/memory new character Большой', '/memory new character Огромный', 'Привет.');
    await r.until('Мира кивает.');
    await r.close();
    const out = r.out();
    const first = after(out, '/memory new character Большой').split('\n');
    expect(first[0]).toBe('character C17 "Большой" filed (from the next turn)');
    expect(first[1]).toMatch(/^! The Compendium entry "Большой" \(C17\) holds \d+ characters.*\(compendium_large_entry\)$/);
    // The second entry's notice has the same code: it is shown too (one per entry, not one per code).
    expect(after(out, '/memory new character Огромный').split('\n')[1]).toMatch(/^! The Compendium entry "Огромный" \(C18\) holds/);
    expect(out.split('(compendium_large_entry)').length - 1).toBe(2);
  });

  test('a turn tells two entries\' notices of one code as two lines', async () => {
    const { home, book } = lanternHome();
    const row = (name: string) => ({ t: 'mem' as const, ts: '2026-10-26T12:00:00.000Z', key: null, on: null, by: 'user' as const, ops: [{ op: 'file' as const, type: 'character' as const, data: JSON.parse(big(name)) as Record<string, unknown> }] });
    const id = await seededSession(home, { lorebooks: [book] }, [row('Большой'), row('Огромный')]);
    const r = await replRig(calls([{ text: 'Мира кивает.' }]), { home, sessionId: id });
    r.type('Привет.');
    await r.until('Мира кивает.');
    await r.close();
    const out = r.out();
    expect(out).toMatch(/^! The Compendium entry "Большой" \(C17\) holds .*\(compendium_large_entry\)$/m);
    expect(out).toMatch(/^! The Compendium entry "Огромный" \(C18\) holds .*\(compendium_large_entry\)$/m);
  });

  test('/memory export --format compendium prints the warnings the export returns', async () => {
    const r = await lanternRig(calls());
    for (const name of ['Альфа', 'Бета']) {
      r.session.memoryFile({ type: 'character', data: { name, description: `${name} из порта.` } });
      r.session.memoryEdit({ ref: name, featured: true });
    }
    r.type('/memory export two --format compendium');
    r.end();
    expect(await r.done).toBe(0);
    const lines = after(r.out(), '/memory export two --format compendium').split('\n');
    expect(lines[0]).toStartWith('exported 2 entries as a RoleCall Compendium file (compendium-v1.0.0): ');
    expect(lines[1]).toBe('  ! "Бета" is written unfeatured: RoleCall keeps one featured character per book, and "Альфа" is it (entries[1].is_featured)');
  });
});

describe('the editor after an error (engine#5)', () => {
  test('piped input and no editor of its own: the error is said, nothing is written, the script goes on', async () => {
    const r = await lanternRig(calls([{ text: 'Здравствуй.' }]), { env: {}, deps: { editText: undefined } });
    r.type('/memory new character', '{"description": "без имени"}', '/memory edit Ульяна', '{"name": ""}', 'Привет', '/memory list character');
    await r.until('Здравствуй.');
    await r.close();
    const out = r.out();
    expect(after(out, '/memory new character')).toMatch(/^editing in place: .*\n\/memory new: a character needs name; nothing written\n$/);
    expect(after(out, '/memory edit Ульяна')).toMatch(/^editing in place: .*\n\/memory edit: the name of a character cannot be removed; rename it with set\.name; nothing written\n$/);
    // The next lines ran as the script meant them: a message and a command.
    expect(out).toContain('Mira › Здравствуй.');
    expect(after(out, '/memory list character')).toContain('  C3 Ульяна (aka Смотрительница)');
    expect(memRows(r)).toHaveLength(0);
    expect(r.session.view().path.filter((m) => m.role === 'user').map(messageText)).toEqual(['Привет']);
  });

  test('an editor of its own (a named $EDITOR, the host\'s) still opens again', async () => {
    const r = await lanternRig(calls(), { editor: editorOf('{"description": "без имени"}', '{"name": "Ян"}') });
    r.type('/memory new character');
    r.end();
    expect(await r.done).toBe(0);
    expect(after(r.out(), '/memory new character')).toBe('/memory new: a character needs name; the editor opens again\ncharacter C17 "Ян" filed (from the next turn)\n');
  });
});

describe('/lore rm of a book the Compendium reads (engine#8)', () => {
  test('its entries leave /memory now, the handles after them change, the session\'s changes come back with the book', async () => {
    const r = await lanternRig(calls(), { editor: editorOf(MIRA_TEXT, (t) => t.replace('"role": "', '"likes": ["чай"], "role": "')) });
    r.type('/memory new character Мира', '/memory edit Ульяна', '/lore rm lantern', '/memory list character', '/lore add lantern', '/memory off', '/lore rm lantern');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const rm = out.split('› /lore rm lantern\n')[1]!.split('\n')[0];
    expect(rm).toBe(
      'lorebook lantern removed (from the next turn; it stays in the library); its 16 Compendium entries leave /memory now, and the C<n> of the entries after them change; ' +
        "this session's changes to 1 of them are kept and come back if the book returns (/lore add lantern)",
    );
    expect(after(out, '/memory list character')).toContain('  C1 Мира (aka Фонарщица)');
    // With the Compendium off the book adds nothing to /memory: the M2 line alone.
    expect(after(out, '/lore rm lantern')).toBe('lorebook lantern removed (from the next turn; it stays in the library)\n');
  });

  test('no session changes and nothing after the book: only that its entries leave', async () => {
    const r = await lanternRig(calls());
    r.type('/lore rm lantern');
    r.end();
    expect(await r.done).toBe(0);
    expect(after(r.out(), '/lore rm lantern')).toBe('lorebook lantern removed (from the next turn; it stays in the library); its 16 Compendium entries leave /memory now\n');
  });
});

describe('/trace: the entry limit apart from the budget (prompt#8)', () => {
  const trace = (over: Partial<CompendiumTrace>): CompendiumTrace => ({
    rev: 'r',
    source: 'lexical',
    profile: 'lite',
    picks: [],
    injected: [],
    cut: [],
    repeated: [],
    hidden: 0,
    budget: { share: 5000, lore: 0, block: 79 },
    ...over,
  });
  const picks = (n: number): CompendiumTrace['picks'] => Array.from({ length: n }, (_, i) => ({ ref: `C${i + 1}`, key: `k${i + 1}`, via: 'mention' as const }));

  test('a lite turn with 7 picks that fit: the 7th is over the entry limit, not cut by the budget', () => {
    const line = compendiumTraceLine(
      trace({
        picks: picks(7),
        injected: picks(6).map((p) => ({ ref: p.ref, tok: 12, mode: 'brief' as const })),
        cut: [{ ref: 'C7', tok: 12 }],
      }),
    );
    expect(line).toContain(' · over the entry limit (lite: 6) 1: C7 12 tok · block 79 tok');
    expect(line).not.toContain('cut by the budget');
  });

  test('both: a budget cut before the limit is reached, limit cuts after it', () => {
    const p = picks(9);
    const injected = ['C1', 'C3', 'C4', 'C5', 'C6', 'C7'].map((ref) => ({ ref, tok: 10, mode: 'brief' as const }));
    const line = compendiumTraceLine(
      trace({ picks: p, injected, cut: [{ ref: 'C2', tok: 900 }, { ref: 'C8', tok: 10 }, { ref: 'C9', tok: 11 }] }),
      new Map([['k2', 'Мира']]),
    );
    expect(line).toContain(' · over the entry limit (lite: 6) 2: C8 10 tok, C9 11 tok · cut by the budget 1: C2 "Мира" 900 tok · ');
  });

  test('full: under 12 injected every cut is the budget\'s', () => {
    const line = compendiumTraceLine(
      trace({ profile: 'full', picks: picks(7), injected: picks(6).map((p) => ({ ref: p.ref, tok: 12, mode: 'full' as const })), cut: [{ ref: 'C7', tok: 4000 }] }),
    );
    expect(line).toContain(' · cut by the budget 1: C7 4000 tok · ');
    expect(line).not.toContain('entry limit');
  });
});

describe('verbs that change nothing write nothing (the ruling on no-op verbs)', () => {
  test('a note edit to the text it has, a restore of a live entry: "nothing changed", no row', async () => {
    const r = await lanternRig(calls());
    r.type('/memory add Ключи | | Ключи у Арсения.', '/memory edit Ключи | | Ключи у Арсения.', '/memory restore Ключи', '/memory restore C6');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(after(out, '/memory edit Ключи | | Ключи у Арсения.')).toBe('/memory edit: nothing changed, nothing written\n');
    expect(after(out, '/memory restore Ключи')).toBe('/memory restore: "Ключи" is not retired; nothing changed\n');
    expect(after(out, '/memory restore C6')).toBe('/memory restore: "Серый маяк" is not retired; nothing changed\n');
    expect(memRows(r).map((m) => m.ops[0]!.op)).toEqual(['note']);
  });

  test('a file or an editor edit the engine finds already there: "nothing changed" instead of "filed" or "changed"', async () => {
    // The REPL's own checks catch these first; a stand-in session answers changed:false to show the line.
    const r = await lanternRig(calls(), {
      editor: editorOf('{"name": "Ян"}', (t) => t.replace('"description": "', '"description": "Ещё раз: ')),
      wrap: (s) =>
        new Proxy(s, {
          get: (t, p) => {
            const unchanged = { key: t.memoryList({}).find((x) => x.ref === 'C3')!.key, changed: false };
            if (p === 'memoryFile') return () => ({ ...unchanged, ref: 'C3', change: 'merged' });
            if (p === 'memoryEdit') return () => unchanged;
            const v = Reflect.get(t, p) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          },
        }),
    });
    r.type('/memory new character', '/memory edit C3');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(after(out, '/memory new character')).toBe('/memory new: nothing changed, nothing written (character C3 "Ульяна" already holds all of it)\n');
    expect(after(out, '/memory edit C3')).toBe('/memory edit: nothing changed, nothing written\n');
    expect(memRows(r)).toHaveLength(0);
  });
});
