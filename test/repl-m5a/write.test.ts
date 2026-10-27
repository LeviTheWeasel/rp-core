// M5a REPL (D-160, D-161): /memory new and /memory edit through the editor (the JSON template, a JSON
// error or a refusal re-opens it with the same text, an empty or unchanged text cancels, the diff
// becomes set/unset), the "already C<n>" check, retire/restore of any entry, the one-line note edit.
import { describe, expect, test } from 'bun:test';
import { after, calls, editorOf, lanternHome, lanternRig, memRows, MIRA_DATA, MIRA_TEXT, seededSession } from './kit.ts';
import { replRig } from '../repl/kit.ts';

const parse = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

describe('/memory new', () => {
  test('the template: the help key first, the LITE fields empty by kind, the name filled; saved → one file row', async () => {
    const r = await lanternRig(calls(), { editor: editorOf(MIRA_TEXT) });
    r.type('/memory new character Мира', '/memory list character');
    r.end();
    expect(await r.done).toBe(0);
    const template = parse(r.edited[0]!);
    expect(Object.keys(template)).toEqual(['//', 'name', 'aliases', 'description', 'role', 'current_state', 'relationships', 'memories']);
    expect(template).toMatchObject({ name: 'Мира', aliases: [], description: '', role: '', current_state: {}, relationships: [], memories: [] });
    const help = template['//'] as string;
    expect(help.startsWith('fill what you know; blank fields are ignored. role: protagonist|antagonist|ally|rival|neutral|background|deity|player_character; ')).toBe(true);
    for (const s of [
      'current_state.status: alive|dead|missing|transformed|imprisoned|unknown',
      'relationships[].nature: ally|enemy|romantic|family|mentor|rival|unknown',
      'relationships[].status: active|past|strained|unknown',
      'memories[].emotional_weight: trivial|notable|formative|defining',
    ]) {
      expect(help).toContain(s);
    }
    expect(help).not.toContain('\n');
    // The template is pretty JSON, one field per line.
    expect(r.edited[0]!.split('\n')[1]).toStartWith('  "//": "fill what you know');
    const out = r.out();
    expect(after(out, '/memory new character Мира')).toBe('character C16 "Мира" filed (from the next turn)\n');
    expect(out).toContain('  C16 Мира (aka Фонарщица) — Младшая фонарщица Вельмара и ученица Арсения Кеттера. [698]');
    const rows = memRows(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ key: null, on: null, by: 'user' });
    // D-168: the key the dry run produced is pinned in the row.
    expect(rows[0]!.ops).toEqual([{ op: 'file', type: 'character', data: MIRA_DATA, target: 'character:мира' }]);
  });

  test('blank fields are dropped at every depth; other types: summary, worldbuilding, no name given', async () => {
    const r = await lanternRig(calls(), {
      editor: editorOf(
        (t) => t.replace('"description": ""', '"description": "Мальчишка с пристани."').replace('"relationships": []', '"relationships": [{"with": "", "nature": ""}]'),
        (t) => t.replace('"title": ""', '"title": "Ночь у маяка"').replace('"summary": ""', '"summary": "Мира и Ян ждут прилива."'),
        (t) => t,
      ),
    });
    r.type('/memory new character Ян', '/memory new summary', '/memory new worldbuilding');
    r.end();
    expect(await r.done).toBe(0);
    expect(Object.keys(parse(r.edited[1]!))).toEqual(['//', 'title', 'summary', 'significance', 'participants']);
    expect(parse(r.edited[1]!)['//']).toBe('fill what you know; blank fields are ignored. significance: minor|moderate|major|pivotal');
    expect(Object.keys(parse(r.edited[2]!))).toEqual(['//', 'topic', 'category', 'description', 'key_facts', 'rules']);
    expect(parse(r.edited[2]!)['//']).toBe('fill what you know; blank fields are ignored.');
    const out = r.out();
    expect(out).toContain('character C16 "Ян" filed (from the next turn)');
    expect(out).toContain('summary C17 "Ночь у маяка" filed (from the next turn)');
    expect(after(out, '/memory new worldbuilding')).toBe('/memory new: nothing changed, nothing written\n');
    expect(memRows(r).map((m) => m.ops[0])).toEqual([
      { op: 'file', type: 'character', data: { name: 'Ян', description: 'Мальчишка с пристани.' }, target: 'character:ян' },
      { op: 'file', type: 'summary', data: { title: 'Ночь у маяка', summary: 'Мира и Ян ждут прилива.' }, target: 'summary:user:ночь у маяка' },
    ]);
  });

  test('a name a live entry of that type already has is refused before the editor opens (by name or alias)', async () => {
    const r = await lanternRig(calls(), { editor: editorOf(MIRA_TEXT) });
    r.type('/memory new character Мира', '/memory new character мира', '/memory new location маяк', '/memory new item Мира');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(after(out, '/memory new character мира')).toBe('/memory new: "мира" is already C16; use /memory edit C16\n');
    expect(after(out, '/memory new location маяк')).toBe('/memory new: "маяк" is already C6 (Серый маяк); use /memory edit C6\n');
    // Another type may share the name: the editor opens (and is cancelled here).
    expect(after(out, '/memory new item Мира')).toBe('/memory new cancelled: nothing written\n');
    expect(r.edited).toHaveLength(2);
    expect(memRows(r)).toHaveLength(1);
  });

  test('a JSON error, a taken name or a refusal is one line, then the editor opens again with the same text', async () => {
    const broken = '{ "name": "Ян", ';
    const missing = '{ "topic": "Право тумана" }';
    const taken = '{ "name": "Новый", "aliases": ["Старшина"] }';
    const r = await lanternRig(calls(), {
      editor: editorOf(broken, '[1, 2]', '{ "name": "Ян", "description": "Юнга." }', missing, null, taken, (t) => t),
    });
    r.type('/memory new character Ян', '/memory new worldbuilding', '/memory new character');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const first = after(out, '/memory new character Ян').split('\n');
    expect(first[0]).toMatch(/^\/memory new: the text is not valid JSON \(.+\); the editor opens again$/);
    expect(first[1]).toBe('/memory new: the text must be one JSON object, { … }; the editor opens again');
    expect(first[2]).toBe('character C16 "Ян" filed (from the next turn)');
    // Each re-opening starts from the text that failed.
    expect(r.edited[1]).toBe(broken);
    expect(r.edited[2]).toBe('[1, 2]');
    expect(after(out, '/memory new worldbuilding')).toBe(
      '/memory new: a worldbuilding needs category, description; the editor opens again\n/memory new cancelled: nothing written\n',
    );
    expect(r.edited[4]).toBe(missing);
    // A name typed in the editor is checked too (an alias of the library's Арсений here); saving the
    // same text again gives up.
    expect(after(out, '/memory new character')).toBe(
      '/memory new: "Старшина" is already C1 (Арсений Кеттер); use /memory edit C1; the editor opens again\n/memory new: nothing changed, nothing written\n',
    );
    expect(memRows(r).map((m) => m.ops[0])).toEqual([{ op: 'file', type: 'character', data: { name: 'Ян', description: 'Юнга.' }, target: 'character:ян' }]);
  });

  test('cancel: the editor cancelled, an empty text, the template unchanged; parse errors', async () => {
    const r = await lanternRig(calls(), { editor: editorOf(null, '  \n', (t) => t) });
    r.type('/memory new plot', '/memory new plot', '/memory new plot', '/memory new', '/memory new npc Ян', '/memory new note Ян');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('/memory new cancelled: nothing written');
    expect(out.split('/memory new: nothing changed, nothing written').length - 1).toBe(2);
    expect(after(out, '/memory new')).toBe('/memory new needs a type: character, location, item, power, organization, event, plot, threat, worldbuilding, summary, creature (then a name if you like)\n');
    expect(after(out, '/memory new npc Ян')).toBe('/memory new: "npc" is not an entry type (character, location, item, power, organization, event, plot, threat, worldbuilding, summary, creature)\n');
    expect(after(out, '/memory new note Ян')).toBe('/memory new files a typed entry; a note is written with /memory add <title> | <keys> | <text>\n');
    expect(memRows(r)).toEqual([]);
  });
});

describe('/memory edit', () => {
  test('a library entry: its data and the help key; the diff → set and unset (an overlay; the book is untouched)', async () => {
    const r = await lanternRig(calls(), {
      editor: editorOf((t) => {
        const o = parse(t);
        o.description = 'Смотрительница маяка. Пропала.';
        delete o.role;
        o.likes = ['чайки'];
        return JSON.stringify(o, null, 2);
      }),
    });
    r.type('/memory edit C3', '/memory list character');
    r.end();
    expect(await r.done).toBe(0);
    const text = parse(r.edited[0]!);
    expect(Object.keys(text)).toEqual(['//', 'name', 'aliases', 'description', 'role', 'current_state', 'relationships']);
    expect(text.aliases).toEqual(['Смотрительница']);
    expect(text['//'] as string).toStartWith('change what you need: a new name renames it, a field you blank or remove is removed. role: protagonist|');
    const out = r.out();
    expect(after(out, '/memory edit C3')).toBe('character C3 "Ульяна" changed: set description, likes; removed role (from the next turn; the book file stays as it is)\n');
    expect(out).toContain('  C3 Ульяна (aka Смотрительница) — Смотрительница маяка. [lib: lantern, edited] [');
    const rows = memRows(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ops[0]).toMatchObject({ op: 'edit', set: { description: 'Смотрительница маяка. Пропала.', likes: ['чайки'] }, unset: ['role'] });
    expect((rows[0]!.ops[0] as { ref: string }).ref).toMatch(/^lib:lantern:/);
  });

  test('unchanged writes nothing: the same text, the same object re-formatted, blank fields added', async () => {
    const r = await lanternRig(calls(), {
      editor: editorOf(
        (t) => t,
        (t) => JSON.stringify(parse(t)),
        (t) => JSON.stringify({ ...parse(t), likes: [], notes: '  ' }),
      ),
    });
    r.type('/memory edit C3', '/memory edit C3', '/memory edit Вельмар');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out().split('/memory edit: nothing changed, nothing written').length - 1).toBe(3);
    expect(memRows(r)).toEqual([]);
    // A library entry whose data names it by `name` and holds no aliases still opens with both.
    expect(Object.keys(parse(r.edited[2]!)).slice(0, 3)).toEqual(['//', 'name', 'aliases']);
  });

  test('rename, aliases, removing every alias; a refusal and a JSON error re-open the editor', async () => {
    const r = await lanternRig(calls(), {
      editor: editorOf(
        (t) => t.replace('"name": "Ульяна"', '"name": ""'),
        (t) => `${t}}`,
        // The editor shows the broken text again: the fix drops the stray brace.
        (t) => t.slice(0, -1).replace('"name": ""', '"name": "Уля"').replace('"Смотрительница"', '"Смотрительница", "Тётя Уля"'),
        (t) => {
          const o = parse(t);
          delete o.aliases;
          return JSON.stringify(o);
        },
      ),
    });
    r.type('/memory edit C3', '/memory edit Уля', '/memory show C3');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const first = after(out, '/memory edit C3').split('\n');
    expect(first[0]).toBe('/memory edit: the name of a character cannot be removed; rename it with set.name; the editor opens again');
    expect(first[1]).toMatch(/^\/memory edit: the text is not valid JSON \(.+\); the editor opens again$/);
    expect(first[2]).toBe('character C3 "Уля" changed: set name, aliases (from the next turn; the book file stays as it is)');
    expect(r.edited[1]).toContain('"name": ""');
    expect(after(out, '/memory edit Уля')).toBe('character C3 "Уля" changed: removed aliases (from the next turn; the book file stays as it is)\n');
    const show = after(out, '/memory show C3');
    expect(show).toContain('  former names: Ульяна');
    expect(show).not.toContain('aka:');
    expect(memRows(r).map((m) => m.ops[0])).toMatchObject([
      { op: 'edit', set: { name: 'Уля', aliases: ['Смотрительница', 'Тётя Уля'] } },
      { op: 'edit', unset: ['aliases'] },
    ]);
  });

  test('a session entry; a note opens its text; the one-line form is a note\'s; an unknown ref', async () => {
    const r = await lanternRig(calls(), {
      editor: editorOf(MIRA_TEXT, (t) => t.replace('"role": "protagonist"', '"role": "ally"'), 'Ключи у Миры.', null),
    });
    r.type(
      '/memory new character Мира',
      '/memory edit C16',
      '/memory add Ключи | | Ключи у Арсения.',
      '/memory edit C17',
      '/memory edit C17',
      '/memory edit C16 Новое имя | |',
      '/memory edit C99',
    );
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(after(out, '/memory edit C16')).toBe('character C16 "Мира" changed: set role (from the next turn)\n');
    expect(r.edited[2]).toBe('Ключи у Арсения.');
    expect(out).toContain('note C17 "Ключи" changed: text (from the next turn)');
    expect(out).toContain('/memory edit cancelled: nothing written');
    expect(after(out, '/memory edit C16 Новое имя | |')).toBe(
      '/memory edit: C16 "Мира" is a character; /memory edit C16 opens it in the editor (the one-line form is a note\'s)\n',
    );
    expect(after(out, '/memory edit C99')).toBe('/memory edit: no single entry matches "C99" (use its C<n> handle or key)\n');
    expect(memRows(r).map((m) => m.ops[0]!.op)).toEqual(['file', 'edit', 'note', 'edit']);
    expect(memRows(r)[1]!.ops[0]).toEqual({ op: 'edit', ref: 'character:мира', set: { role: 'ally' } });
    expect(memRows(r)[3]!.ops[0]).toEqual({ op: 'edit', ref: 'note:ключи', set: { content: 'Ключи у Миры.' } });
  });

  test('an arc: its overview is set.content; a removed overview is refused and re-opens', async () => {
    const home = lanternHome().home;
    const id = await seededSession(home, {}, [
      { t: 'mem', ts: '2026-10-26T12:00:00.000Z', key: null, on: null, by: 'user', ops: [{ op: 'arc', plot: 'Украденный свет', overview: 'Фонарь пропал.' }] },
    ]);
    const r = await replRig(calls(), {
      home,
      sessionId: id,
      editor: editorOf(
        (t) => {
          const o = parse(t);
          delete o.overview;
          return JSON.stringify(o);
        },
        (t) => JSON.stringify({ ...parse(t), overview: 'Фонарь нашли на маяке.' }),
      ),
    });
    r.type('/memory list arc', '/memory edit C2', '/memory show C2');
    r.end();
    expect(await r.done).toBe(0);
    expect(parse(r.edited[0]!)).toEqual({ '//': "change the arc's overview; its plot name cannot change here.", overview: 'Фонарь пропал.' });
    const out = r.out();
    expect(after(out, '/memory list arc')).toContain('  C2 [Arc] Украденный свет — Фонарь пропал. [14]');
    expect(after(out, '/memory edit C2')).toBe(
      "/memory edit: an arc's overview cannot be removed; the editor opens again\narc C2 \"Украденный свет\" changed: set overview (from the next turn)\n",
    );
    expect(after(out, '/memory show C2')).toMatch(/^C2 \[Arc\] Украденный свет · arc · arc:украденный свет\n[\s\S]*\n {2}# \[Arc\] Украденный свет\n\n {2}Фонарь нашли на маяке\.\n$/);
    const rows = memRows({ home, session: { id } });
    expect(rows.at(-1)!.ops[0]).toEqual({ op: 'edit', ref: 'arc:украденный свет', set: { content: 'Фонарь нашли на маяке.' } });
  });
});

describe('retire, restore, add', () => {
  test('any entry, by handle, key or name; a refusal is one line and writes nothing', async () => {
    const r = await lanternRig(calls());
    r.type('/memory retire маяк сгорел', '/memory retire C6', '/memory restore Серый маяк', '/memory restore C6', '/memory retire C99');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(after(out, '/memory retire маяк сгорел')).toBe('location C6 "Серый маяк" retired: it leaves the story: no block, no lore tools (/memory restore C6 brings it back)\n');
    expect(after(out, '/memory retire C6')).toBe('/memory retire: "Серый маяк" is already retired\n');
    expect(after(out, '/memory restore Серый маяк')).toBe('location C6 "Серый маяк" restored: it is back in the story from the next turn\n');
    // A restore of a live entry writes nothing (the lead's ruling on no-op verbs).
    expect(after(out, '/memory restore C6')).toBe('/memory restore: "Серый маяк" is not retired; nothing changed\n');
    expect(after(out, '/memory retire C99')).toBe('/memory retire: no single entry matches "C99" (use its C<n> handle or key)\n');
    expect(memRows(r).map((m) => m.ops[0]!.op)).toEqual(['retire', 'restore']);
  });

  test('every writing subcommand is refused while an answer is written; list, show and tree wait for it', async () => {
    const r = await lanternRig(calls([{ text: 'Part ' }, { pause: 'p' }, { text: 'done.' }]), { interactive: true });
    r.type('Go');
    await r.until('Mira › Part');
    r.type('/memory new plot', '/memory edit C1', '/memory retire C1', '/memory export x', '/memory tree');
    await r.until('(runs when this answer ends)');
    // new, edit, retire and export (an export writes no row, but one rule holds for every memory verb).
    expect(r.out().split('refused [session_busy]: /memory changes the story').length - 1).toBe(4);
    r.provider.release('p');
    await r.until('Lantern (lib: lantern) · 15');
    r.type('/quit');
    expect(await r.done).toBe(0);
    expect(memRows(r)).toEqual([]);
    expect(r.edited).toEqual([]);
  });
});
