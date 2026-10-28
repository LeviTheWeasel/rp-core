// M5a REPL (D-161): /memory list, show and tree over a session that reads the lantern book, with the
// engine's own handles (library seed first, D-150); the /trace compendium line; the memory side line.
import { describe, expect, test } from 'bun:test';
import { entryRefs } from '../../src/agents/compendium/refs.ts';
import { after, calls, editorOf, lanternRig, MIRA_TEXT } from './kit.ts';

describe('/memory list', () => {
  test('grouped by tree bucket, one line per entry, with the handles the engine gives', async () => {
    const r = await lanternRig(calls());
    r.type('/memory');
    await r.until('Bestiary (1)');
    const out = after(r.out(), '/memory');
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe('The Compendium of this path: 16 live · /memory show <ref> prints one');
    expect(lines.filter((l) => !l.startsWith('  ')).slice(1)).toEqual([
      'Cast (3)',
      'Places (3)',
      'Items (1)',
      'Powers (1)',
      'Organizations (1)',
      'Events (1)',
      'Plots (1)',
      'Threats (1)',
      'Worldbuilding (1)',
      'Narrative (1)',
      'Bestiary (1)',
      // M5b (D-177): the book's [Arc] overview is an entry of its own now (no longer plain lore).
      'Arcs (1)',
    ]);
    expect(lines).toContain('  C16 [Arc] Украденный свет — Маяк погас, фонарь пропал вместе со смотрительницей. Гильди… [lib: lantern] [148]');
    expect(lines).toContain('  C6  Серый маяк (aka маяк) — Каменная башня на краю мыса; на её крюке висел Латунный фонарь. [lib: lantern] [featured] [217]');
    expect(lines).toContain('  C2  Селина Бранд — Хочет, чтобы свет принадлежал городу. [lib: lantern] [406]');
    expect(lines).toContain('  C1  Арсений Кеттер (aka Старшина, Арсений) — Старшина Гильдии фонарщиков, сорок лет зажигает огни Вельмара. [lib: lantern] [featured] [1.6k]');
    // Every handle is the engine's: memoryList's, and entryRefs over the session's own fold.
    const rows = r.session.memoryList();
    expect(rows).toHaveLength(16);
    for (const row of rows) expect(lines.some((l) => l.startsWith(`  ${row.ref.padEnd(3)} ${row.type === 'arc' ? '[Arc] ' : ''}${row.name}`))).toBe(true);
    expect(entryRefs(r.session.compendium()).map((x) => [x.ref, x.entry.key])).toEqual(rows.map((x) => [x.ref, x.key]));
    await r.close();
  });

  test('a type, note or arc; --retired; a session entry after the library ones; errors', async () => {
    const r = await lanternRig(calls(), { editor: editorOf(MIRA_TEXT) });
    r.type(
      '/memory list location',
      '/memory list notes',
      '/memory list npc',
      '/memory new character Мира',
      '/memory retire C3 ушла в туман',
      '/memory list character',
      '/memory list character --retired',
      '/memory --retired',
      "/memory add Ключи | ключи | Ключи гильдии у Арсения.",
      '/memory list note',
    );
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(after(out, '/memory list location').trimEnd().split('\n')).toEqual([
      'Location entries on this path: 3 live · /memory show <ref> prints one',
      'Places (3)',
      '  C4 Вельмар — Портовый город на Сером мысу; ночью его улицы держат только фонари. [lib: lantern] [256]',
      '  C5 Фонарный ряд — Квартал Гильдии фонарщиков: мастерские, склады масла и колокольня, по которой… [lib: lantern] [244]',
      '  C6 Серый маяк (aka маяк) — Каменная башня на краю мыса; на её крюке висел Латунный фонарь. [lib: lantern] [featured] [217]',
    ]);
    expect(after(out, '/memory list notes')).toBe('no notes on this path\n');
    expect(after(out, '/memory list npc')).toContain('/memory list: "npc" is not an entry type (character, location, item, power, organization, event, plot, threat, worldbuilding, summary, creature, note, arc)');
    // Мира is filed after the 16 library entries (15 typed, the [Arc] overview, D-177): C17 (D-150).
    expect(after(out, '/memory list character').trimEnd().split('\n')).toEqual([
      'Character entries on this path: 3 live, 1 retired (/memory list character --retired shows them) · /memory show <ref> prints one',
      'Cast (3)',
      '  C1  Арсений Кеттер (aka Старшина, Арсений) — Старшина Гильдии фонарщиков, сорок лет зажигает огни Вельмара. [lib: lantern] [featured] [1.6k]',
      '  C2  Селина Бранд — Хочет, чтобы свет принадлежал городу. [lib: lantern] [406]',
      '  C17 Мира (aka Фонарщица) — Младшая фонарщица Вельмара и ученица Арсения Кеттера. [698]',
    ]);
    const all = after(out, '/memory list character --retired');
    expect(all).toContain('Character entries on this path: 3 live, 1 retired · /memory show <ref> prints one');
    expect(all).toContain('  C3  Ульяна (aka Смотрительница) — Смотрительница Серого маяка, тридцать зим не пропустившая ни одной ночи. [lib: lantern, edited] [retired: ушла в туман] [338]');
    expect(after(out, '/memory --retired')).toContain('The Compendium of this path: 16 live, 1 retired · /memory show <ref> prints one');
    expect(after(out, '/memory list note').trimEnd().split('\n')).toEqual([
      'Notes on this path: 1 live · /memory show <ref> prints one',
      'Notes (1)',
      '  C18 Ключи — Ключи гильдии у Арсения. · keys: ключи [24]',
    ]);
  });
});

describe('/memory show and /memory tree', () => {
  test('show: who, where from (book, overlay, rows), former names, retirement, then the full render', async () => {
    const r = await lanternRig(calls(), {
      editor: editorOf((t) => t.replace('"name": "Ульяна"', '"name": "Уля"')),
    });
    r.type('/memory show маяк', '/memory edit C3', '/memory retire C3', '/memory show Уля', '/memory show C99');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const place = after(out, '/memory show маяк').split('\n');
    expect(place[0]).toMatch(/^C6 Серый маяк · location · lib:lantern:\S+$/);
    expect(place[1]).toBe('  aka: маяк');
    expect(place[2]).toMatch(/^ {2}origin: the library book lantern, entry \S+$/);
    expect(place).toContain('  featured');
    expect(place).toContain('  # Серый маяк');
    expect(place).toContain('  Каменная башня на краю мыса; на её крюке висел Латунный фонарь.');
    // A renamed library entry: an overlay, its former name, the rows that changed it, its retirement.
    const uly = after(out, '/memory show Уля');
    expect(uly).toMatch(/^C3 Уля · character · lib:lantern:\S+\n/);
    expect(uly).toMatch(/\n {2}origin: the library book lantern, entry \S+; changed in this session \(an overlay: the book file stays as it is\)\n {2}last changed at journal row \d+\n/);
    expect(uly).toContain('\n  former names: Ульяна\n');
    expect(uly).toContain('\n  retired (out of the story; /memory restore C3 brings it back)\n');
    expect(uly).toContain('\n  # Уля\n');
    expect(after(out, '/memory show C99')).toBe('/memory show: no single entry matches "C99" (use its C<n> handle or key)\n');
  });

  test('a session entry shows the row that wrote it; a note keeps its M3 card', async () => {
    const r = await lanternRig(calls(), { editor: editorOf(MIRA_TEXT) });
    r.type('/memory new character Мира', '/memory show C17', '/memory add Ключи | | Ключи у Арсения.', '/memory show C18');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const mira = after(out, '/memory show C17');
    expect(mira).toMatch(/^C17 Мира · character · character:мира\n {2}aka: Фонарщица\n {2}origin: this session, written by you at journal row \d+\n\n {2}# Мира\n/);
    expect(mira).toContain('\n  ## Relationships\n');
    expect(after(out, '/memory show C18')).toMatch(/^C18 Ключи · note:ключи\n {2}keys: Ключи\n/);
  });

  test('tree: the session first, then each book, with counts and handles; one book; an unknown one', async () => {
    const r = await lanternRig(calls(), { editor: editorOf(MIRA_TEXT) });
    r.type('/memory tree', '/memory new character Мира', '/memory tree lantern', '/memory tree nope');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const tree = after(out, '/memory tree').trimEnd().split('\n');
    expect(tree.slice(0, 6)).toEqual([
      'World Knowledge (this session) · 0',
      'Lantern (lib: lantern) · 16',
      '  Cast · 3',
      '    Гильдия фонарщиков · 1: C1 Арсений Кеттер',
      '    Соляной суд · 1: C2 Селина Бранд',
      '    Unaffiliated · 1: C3 Ульяна',
    ]);
    expect(tree).toContain('  Places · 3');
    expect(tree).toContain('    C4 Вельмар · 3');
    expect(tree).toContain('      C5 Фонарный ряд');
    expect(tree).toContain('  Items · 1: C7 Латунный фонарь');
    const book = after(out, '/memory tree lantern').trimEnd().split('\n');
    expect(book[0]).toBe('Lantern (lib: lantern) · 16');
    expect(book.join('\n')).not.toContain('this session');
    expect(after(out, '/memory tree nope')).toBe('/memory tree: the Compendium reads no book "nope"\n');
  });

  test('an empty Compendium: list and tree say how to start', async () => {
    const r = await lanternRig(calls(), { books: [] });
    r.type('/memory', '/memory tree', '/memory list arc');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const empty = 'nothing in the Compendium on this path yet: /memory new <type> [name] files an entry';
    expect(after(out, '/memory')).toBe(`${empty}, /memory add <title> | <keys> | <text> writes a note\n`);
    expect(after(out, '/memory tree')).toBe(`${empty}\n`);
    expect(after(out, '/memory list arc')).toBe('no arcs on this path\n');
  });
});

describe('/trace', () => {
  test('one compendium line: profile, picks with their tier, what went in, by handle and name', async () => {
    const r = await lanternRig(calls([{ text: 'Мира кивает.' }]), { editor: editorOf(MIRA_TEXT) });
    r.type('/memory new character Мира', 'Я ищу Миру у Серого маяка.', '/trace');
    await r.until('  compendium: ');
    const trace = after(r.out(), '/trace');
    const line = trace.split('\n').find((l) => l.startsWith('  compendium: '))!;
    expect(line).toMatch(
      /^ {2}compendium: (lite|full) · picked 3: C17 "Мира" \(mention\), C6 "Серый маяк" \(mention\), C14 "Фонарь погас" \(mention\) · injected 3: C17 "Мира" brief \d+ tok, C6 "Серый маяк" brief \d+ tok, C14 "Фонарь погас" brief \d+ tok · block \d+ tok$/,
    );
    // The refs of the trace are the handles /memory prints.
    const stored = r.session.view().path.at(-1)!;
    expect(stored.role).toBe('assistant');
    const rows = new Map(r.session.memoryList().map((x) => [x.key, x.ref]));
    expect(rows.get('character:мира')).toBe('C17');
    await r.close();
  });

  test('no Compendium input (no typed entry): no compendium line', async () => {
    const r = await lanternRig(calls([{ text: 'Да.' }]), { books: [] });
    r.type('Привет.', '/trace');
    await r.until('trace of ');
    await r.close();
    expect(after(r.out(), '/trace')).not.toContain('compendium:');
  });
});
