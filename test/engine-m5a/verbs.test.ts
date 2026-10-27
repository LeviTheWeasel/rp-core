// M5a D-159: the memory verbs over the whole Compendium (typed entries, library entries and their
// overlays, arcs, notes): one human row each after a dry run that refuses in words; their events; the
// notices told once per key; what swipe, rewind and fork keep.
import { describe, expect, test } from 'bun:test';
import type { CEntry, EntryType } from '../../src/agents/compendium/types.ts';
import type { MemoryRow } from '../../src/engine/api.ts';
import { sameEntry } from '../../src/engine/session.ts';
import type { Event } from '../../src/protocol/events.ts';
import {
  bookSession,
  bookText,
  calls,
  collect,
  drain,
  fullCaps,
  LANTERN,
  LEVI,
  memRows,
  MIRA,
  ok,
  putBook,
  refusalOf,
  rig,
  tick,
  turnOf,
  writeRaw,
} from './kit.ts';

const memoryEvents = (seen: readonly Event[]) =>
  seen.flatMap((e) => (e.type === 'memory' ? [{ change: e.change, ref: e.ref, kind: e.kind, name: e.name, by: e.by }] : []));
const notices = (seen: readonly Event[]) => seen.flatMap((e) => (e.type === 'notice' ? [e.code] : []));

describe('memoryFile', () => {
  test('creates, merges into a session entry, and into a library entry (an overlay); events created / merged', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const events = collect(r.engine);
    const id = putBook(r.home, LANTERN);
    const book = bookText(r.home, id);
    const s = bookSession(r.engine, [id]);

    expect(s.memoryFile({ type: 'character', data: { name: 'Арсений Кеттер', description: 'Старый мастер фонарей.' } })).toEqual({
      key: 'character:арсений кеттер',
      ref: 'C3',
      change: 'created',
      changed: true,
    });
    expect(s.memoryFile({ type: 'character', data: { name: 'арсений кеттер', likes: ['чай'] } })).toEqual({ key: 'character:арсений кеттер', ref: 'C3', change: 'merged', changed: true });
    // By an alias of the library's Мира: her library entry becomes an overlay, the book file is untouched.
    expect(s.memoryFile({ type: 'character', data: { name: 'Фонарщица', likes: ['ночные смены'] } })).toEqual({ key: `lib:${id}:e1`, ref: 'C1', change: 'merged', changed: true });
    expect(bookText(r.home, id)).toBe(book);
    const mira = s.memoryGet({ ref: 'C1' });
    expect(mira.entry.data.likes).toEqual(['тёплый свет', 'тишина порта', 'ночные смены']);
    expect(mira.entry.origin).toEqual({ kind: 'library', book: id, id: 'e1', overlay: true });

    const rows = memRows(r.home, s.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.key === null && x.on === null && x.by === 'user' && x.ops.length === 1 && x.ops[0]!.op === 'file')).toBe(true);

    await tick();
    expect(memoryEvents(events.seen)).toEqual([
      { change: 'created', ref: 'character:арсений кеттер', kind: 'character', name: 'Арсений Кеттер', by: 'user' },
      { change: 'merged', ref: 'character:арсений кеттер', kind: 'character', name: 'Арсений Кеттер', by: 'user' },
      { change: 'merged', ref: `lib:${id}:e1`, kind: 'character', name: 'Мира', by: 'user' },
    ]);
    await r.engine.close();
    await events.done;
  });

  test('the dry run refuses in words and writes nothing: missing fields, a classic name, an unknown type, a blank name', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    const before = memRows(r.home, s.id).length;

    const missing = refusalOf(() => s.memoryFile({ type: 'worldbuilding', data: { topic: 'Право огня' } }));
    expect(missing).toEqual({ code: 'invalid_params', message: 'a worldbuilding needs category, description' });
    const classic = refusalOf(() => s.memoryFile({ type: 'organization', data: { name: 'Гильдия' } }));
    expect(classic.code).toBe('invalid_params');
    expect(classic.message).toContain('plain (untyped) entry of the book "Lantern"');
    expect(classic.message).toContain(`lib:${id}:e4`);
    const unknown = refusalOf(() => s.memoryFile({ type: 'npc' as EntryType, data: { name: 'Тень' } }));
    expect(unknown.code).toBe('invalid_params');
    expect(unknown.message).toContain('unknown entry type "npc"');
    expect(refusalOf(() => s.memoryFile({ type: 'character', data: { name: '!!!' } }))).toEqual({
      code: 'invalid_params',
      message: 'the name needs at least one letter or digit',
    });
    expect(refusalOf(() => s.memoryFile({ type: 'character', data: [] as unknown as Record<string, unknown> })).code).toBe('invalid_params');
    expect(memRows(r.home, s.id)).toHaveLength(before);
    await r.engine.close();
  });

  test('while the Compendium is off, a name a readable book has is refused (it would share the name once it is on)', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id], { config: { compendium: { enabled: false } } });
    const before = memRows(r.home, s.id).length;
    const byName = refusalOf(() => s.memoryFile({ type: 'character', data: { name: 'Мира' } }));
    expect(byName.code).toBe('invalid_params');
    expect(byName.message).toContain(`"Мира" is an entry of the book ${id}`);
    expect(byName.message).toContain('/memory on');
    expect(refusalOf(() => s.memoryFile({ type: 'character', data: { name: 'Мира Ванс', aliases: ['Фонарщица'] } })).code).toBe('invalid_params');
    expect(memRows(r.home, s.id)).toHaveLength(before);
    // Another type, or a name no book has, is filed as usual.
    expect(s.memoryFile({ type: 'location', data: { name: 'Мира' } }).changed).toBe(true);
    expect(s.memoryFile({ type: 'character', data: { name: 'Тим' } }).changed).toBe(true);
    s.configure({ compendium: { enabled: true } });
    expect(s.memoryList({ type: 'character' }).filter((m) => m.name === 'Мира')).toHaveLength(1);
    await r.engine.close();
  });

  test('session_busy during a turn', async () => {
    const r = await rig(calls([{ delay: 20 }, { text: 'Мира кивает.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    expect(refusalOf(() => s.memoryFile({ type: 'character', data: { name: 'Тень' } })).code).toBe('session_busy');
    expect(refusalOf(() => s.memoryEdit({ ref: 'C1', set: { role: 'ally' } })).code).toBe('session_busy');
    expect(refusalOf(() => s.memoryExport({ name: 'x', format: 'core' })).code).toBe('session_busy');
    // Reading works meanwhile.
    expect(s.memoryList().map((x) => x.ref)).toEqual(['C1', 'C2']);
    await drain(turn);
    await r.engine.close();
  });
});

describe('memoryEdit, memoryRetire, memoryRestore', () => {
  test('a library entry: set / unset / keys / featured make an overlay; the book file is never written', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const events = collect(r.engine);
    const id = putBook(r.home, LANTERN);
    const book = bookText(r.home, id);
    const s = bookSession(r.engine, [id]);
    expect(s.memoryEdit({ ref: 'C1', set: { role: 'ally' }, unset: ['likes'], keys: ['Мира', 'фонарщица'], featured: true })).toEqual({ key: `lib:${id}:e1`, changed: true });
    const e = s.memoryGet({ ref: 'Мира' }).entry;
    expect(e.data.role).toBe('ally');
    expect(e.data.likes).toBeUndefined();
    expect(e.keys).toEqual(['Мира', 'фонарщица']);
    expect(e.featured).toBe(true);
    expect(e.origin).toMatchObject({ overlay: true });
    expect(bookText(r.home, id)).toBe(book);

    // A rename by the identity field: the key stays, the old name is kept as a former name.
    s.memoryEdit({ ref: `lib:${id}:e1`, set: { name: 'Мира Ванс' } });
    const renamed = s.memoryGet({ ref: 'C1' }).entry;
    expect(renamed.name).toBe('Мира Ванс');
    expect(renamed.prov.formerNames).toEqual(['Мира']);
    expect(s.memoryGet({ ref: 'Мира' }).entry.key).toBe(`lib:${id}:e1`);

    // Retire and restore, by handle; events with the entry's kind.
    expect(s.memoryRetire({ ref: 'C2', reason: ' снесён ' })).toEqual({ key: `lib:${id}:e2`, changed: true });
    expect(s.memoryList().map((x) => x.ref)).toEqual(['C1']);
    expect(s.memoryList({ includeRetired: true }).find((x) => x.ref === 'C2')!.retired).toEqual({ reason: 'снесён' });
    expect(refusalOf(() => s.memoryRetire({ ref: 'C2' }))).toEqual({ code: 'invalid_params', message: '"Серый маяк" is already retired' });
    expect(s.memoryRestore({ ref: 'C2' })).toEqual({ key: `lib:${id}:e2`, changed: true });
    // Restoring a live entry is already done: nothing written, no event (the lead's ruling).
    const rows = memRows(r.home, s.id).length;
    expect(s.memoryRestore({ ref: 'C2' })).toEqual({ key: `lib:${id}:e2`, changed: false });
    expect(memRows(r.home, s.id)).toHaveLength(rows);

    await tick();
    expect(memoryEvents(events.seen).map((x) => [x.change, x.ref, x.kind])).toEqual([
      ['edited', `lib:${id}:e1`, 'character'],
      ['edited', `lib:${id}:e1`, 'character'],
      ['retired', `lib:${id}:e2`, 'location'],
      ['restored', `lib:${id}:e2`, 'location'],
    ]);
    expect(bookText(r.home, id)).toBe(book);
    await r.engine.close();
    await events.done;
  });

  test('refusals: not_found, nothing to change, a note-only field, the identity field unset, a blank rename, bad aliases', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    s.memoryAdd({ title: 'Ключи', content: 'Ключи у Миры.' });
    const before = memRows(r.home, s.id).length;
    expect(refusalOf(() => s.memoryEdit({ ref: 'C99', set: { role: 'ally' } })).code).toBe('not_found');
    expect(refusalOf(() => s.memoryEdit({ ref: 'Никто', set: { role: 'ally' } })).code).toBe('not_found');
    expect(refusalOf(() => s.memoryEdit({ ref: 'C1' })).message).toBe('nothing to change: give set, unset, keys or featured');
    expect(refusalOf(() => s.memoryEdit({ ref: 'C1', title: 'Мира' })).message).toContain('is a character: change it with set and unset');
    expect(refusalOf(() => s.memoryEdit({ ref: 'C1', unset: ['name'] })).message).toBe('the name of a character cannot be removed; rename it with set.name');
    expect(refusalOf(() => s.memoryEdit({ ref: 'C1', set: { name: ' ' } })).message).toBe('a new name needs at least one letter or digit');
    expect(refusalOf(() => s.memoryEdit({ ref: 'C1', set: { aliases: 'Фонарщица' } })).message).toBe('aliases must be a list of strings');
    // A note keeps M3's fields.
    expect(refusalOf(() => s.memoryEdit({ ref: 'C3', set: { content: 'x' } })).message).toContain('is a note');
    expect(s.memoryEdit({ ref: 'C3', content: 'Ключи у Арсения.', featured: true })).toEqual({ key: 'note:ключи', changed: true });
    expect(s.memoryGet({ ref: 'C3' }).entry).toMatchObject({ content: 'Ключи у Арсения.', featured: true });
    expect(memRows(r.home, s.id)).toHaveLength(before + 1);
    await r.engine.close();
  });

  test('an arc: set.content replaces its overview, its plot cannot be renamed', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const s0 = r.engine.createSession({ character: MIRA, persona: LEVI });
    const sid = s0.id;
    await s0.close();
    writeRaw(r.home, sid, (log) => {
      log.append({ t: 'mem', ts: '2026-10-26T12:00:00.000Z', key: null, on: null, by: 'user', ops: [{ op: 'arc', plot: 'Украденный свет', overview: 'Фонарь пропал.' }] });
    });
    const s = r.engine.session(sid);
    const arcs = s.memoryList({ type: 'arc' });
    expect(arcs).toEqual([
      // An arc's size is its overview's length (its data is {}).
      { ref: 'C2', key: 'arc:украденный свет', type: 'arc', name: 'Украденный свет', aliases: [], tagline: '', origin: 'session', size: 'Фонарь пропал.'.length },
    ] satisfies MemoryRow[]);
    // The arc created its plot first.
    expect(s.memoryList({ type: 'plot' }).map((x) => x.name)).toEqual(['Украденный свет']);
    expect(s.memoryEdit({ ref: 'C2', set: { content: 'Фонарь нашли на маяке.' } })).toEqual({ key: 'arc:украденный свет', changed: true });
    expect(s.memoryGet({ ref: 'C2' }).entry.content).toBe('Фонарь нашли на маяке.');
    expect(s.memoryList({ type: 'arc' })[0]!.size).toBe('Фонарь нашли на маяке.'.length);
    expect(refusalOf(() => s.memoryEdit({ ref: 'C2', set: { name: 'Другое' } })).message).toContain('its plot name cannot change');
    expect(refusalOf(() => s.memoryEdit({ ref: 'C2', set: { content: ' ' } })).message).toBe("an arc's overview cannot be blank");
    await r.engine.close();
  });
});

describe('reading verbs', () => {
  test('memoryList rows and filters, memoryGet, compendium()', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    s.memoryAdd({ title: 'Ключи', content: 'Ключи у Миры.' });
    s.memoryFile({ type: 'item', data: { name: 'Латунный фонарь', description: 'Фонарь гильдии. Пропал.' } });
    expect(s.memoryList()).toEqual([
      {
        ref: 'C1',
        key: `lib:${id}:e1`,
        type: 'character',
        name: 'Мира',
        aliases: ['Фонарщица'],
        tagline: 'Младшая фонарщица Вельмара.',
        origin: { book: id, id: 'e1' },
        size: JSON.stringify(LANTERN.entries[0]!.meta!.data).length,
      },
      {
        ref: 'C2',
        key: `lib:${id}:e2`,
        type: 'location',
        name: 'Серый маяк',
        aliases: [],
        tagline: 'Старый маяк на мысу над гаванью.',
        origin: { book: id, id: 'e2' },
        size: JSON.stringify(LANTERN.entries[1]!.meta!.data).length,
      },
      // A note's size is its text's length.
      { ref: 'C3', key: 'note:ключи', type: 'note', name: 'Ключи', aliases: [], tagline: '', origin: 'session', size: 'Ключи у Миры.'.length },
      {
        ref: 'C4',
        key: 'item:латунный фонарь',
        type: 'item',
        name: 'Латунный фонарь',
        aliases: [],
        tagline: 'Фонарь гильдии.',
        origin: 'session',
        size: JSON.stringify({ name: 'Латунный фонарь', description: 'Фонарь гильдии. Пропал.' }).length,
      },
    ] satisfies MemoryRow[]);
    expect(s.memoryList({ type: 'note' }).map((x) => x.ref)).toEqual(['C3']);
    expect(s.memoryList({ type: 'location' }).map((x) => x.ref)).toEqual(['C2']);
    expect(refusalOf(() => s.memoryList({ type: 'npc' as EntryType })).code).toBe('invalid_params');

    const got = s.memoryGet({ ref: 'с1' });
    expect(got.ref).toBe('C1');
    expect(got.render.startsWith('# Мира\n')).toBe(true);
    expect(got.brief.startsWith('# Мира\nМладшая фонарщица Вельмара.')).toBe(true);
    expect(refusalOf(() => s.memoryGet({ ref: 'C9' })).code).toBe('not_found');
    expect(s.compendium()).toBe(s.view().compendium);
    await r.engine.close();
  });

  test('memoryTree: the session tree first, then one per readable book, with the book entries\' categories', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, { ...LANTERN, entries: LANTERN.entries.map((e) => (e.id === 'e1' ? { ...e, extras: { category: 'Люди' } } : e)) });
    const s = bookSession(r.engine, [id]);
    s.memoryAdd({ title: 'Ключи', content: 'Ключи у Миры.' });
    const trees = s.memoryTree();
    expect(trees).toHaveLength(2);
    const ids = (n: { entryIds: string[]; children: { entryIds: string[]; children: unknown[] }[] }): string[] => [
      ...n.entryIds,
      ...n.children.flatMap((c) => ids(c as never)),
    ];
    expect(ids(trees[0]!)).toEqual(['note:ключи']);
    expect(trees[1]!.label).toBe('Lantern');
    expect(ids(trees[1]!).sort()).toEqual([`lib:${id}:e1`, `lib:${id}:e2`]);
    const people = trees[1]!.children.find((c) => c.label === 'Люди');
    expect(people?.entryIds).toEqual([`lib:${id}:e1`]);
    expect(s.memoryTree({ book: id })).toEqual([trees[1]!]);
    expect(refusalOf(() => s.memoryTree({ book: 'nope' })).code).toBe('not_found');
    await r.engine.close();
  });
});

describe('notices, swipe, rewind and fork', () => {
  test('compendium_large_entry and library_entry_missing: the verbs return them, once per key per open session, and publish none', async () => {
    const r = await rig(calls([{ text: 'Мира кивает.' }]), { caps: fullCaps() });
    const events = collect(r.engine);
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    const long = 'Очень длинная история фонаря. '.repeat(450);
    const large = s.memoryFile({ type: 'item', data: { name: 'Латунный фонарь', history: long } });
    expect(large.notices?.map((n) => [n.level, n.code])).toEqual([['info', 'compendium_large_entry']]);
    expect(large.notices![0]!.message).toContain('"Латунный фонарь" (C3)');
    // The same key again: told already.
    expect(s.memoryFile({ type: 'item', data: { name: 'Латунный фонарь', legend: 'Ещё одна легенда.' } }).notices).toBeUndefined();
    // An overlay of a library entry whose book is then set off: its row is skipped; the next verb returns it.
    s.memoryEdit({ ref: 'C1', set: { role: 'ally' } });
    s.configure({ compendium: { books: { [id]: 'off' } } });
    const missing = s.memoryAdd({ title: 'Ключи', content: 'Ключи у Миры.' });
    expect(missing.notices?.map((n) => [n.level, n.code])).toEqual([['warn', 'library_entry_missing']]);
    expect(s.memoryAdd({ title: 'Дверь', content: 'Дверь заперта.' }).notices).toBeUndefined();
    // A preview shows every notice again; the turn tells none of them twice.
    const p = ok(s.preview());
    expect(p.notices.map((n) => n.code)).toEqual(expect.arrayContaining(['compendium_large_entry', 'library_entry_missing']));
    const t = await turnOf(s);
    const told = t.evs.flatMap((e) => (e.type === 'notice' ? [e.code] : []));
    expect(told).not.toContain('library_entry_missing');
    expect(told).not.toContain('compendium_large_entry');
    // Returned, not published: no front end has to listen to the session bus for them.
    await tick();
    expect(notices(events.seen).filter((c) => c === 'compendium_large_entry' || c === 'library_entry_missing')).toEqual([]);
    await r.engine.close();
    await events.done;
  });

  test('a notice no verb returned is still the next turn\'s to tell', async () => {
    const r = await rig(calls([{ text: 'Мира кивает.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s0 = bookSession(r.engine, [id]);
    s0.memoryEdit({ ref: 'C1', set: { role: 'ally' } });
    s0.configure({ compendium: { books: { [id]: 'off' } } });
    const sid = s0.id;
    await s0.close();
    // Reopened: a reading verb tells nothing; the turn does.
    const s = r.engine.session(sid);
    s.memoryList();
    const t = await turnOf(s);
    expect(t.evs.flatMap((e) => (e.type === 'notice' ? [e.code] : []))).toContain('library_entry_missing');
    await r.engine.close();
  });

  test('a swipe and a rewind keep the human rows; a fork keeps the keys', async () => {
    const r = await rig(calls([{ text: 'Первый ответ.' }], [{ text: 'Второй ответ.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    const u = s.view().head!;
    s.memoryFile({ type: 'character', data: { name: 'Арсений Кеттер' } });
    s.memoryEdit({ ref: 'C1', set: { role: 'ally' } });
    await turnOf(s);
    await turnOf(s, 'swipe');
    const keys = (): string[] => s.memoryList().map((x) => x.key);
    expect(keys()).toEqual([`lib:${id}:e1`, `lib:${id}:e2`, 'character:арсений кеттер']);
    // Rewind to the greeting.
    const greeting = s.view().path[0]!.id;
    s.select({ messageId: greeting, expectedVersion: s.version(), exact: true });
    expect(keys()).toEqual([`lib:${id}:e1`, `lib:${id}:e2`, 'character:арсений кеттер']);
    expect(s.memoryGet({ ref: 'C1' }).entry.data.role).toBe('ally');

    const forked = s.fork({ at: u });
    const f = r.engine.session(forked);
    expect(f.memoryList().map((x) => [x.ref, x.key])).toEqual([
      ['C1', `lib:${id}:e1`],
      ['C2', `lib:${id}:e2`],
      ['C3', 'character:арсений кеттер'],
    ]);
    expect(f.memoryGet({ ref: 'Мира' }).entry.data.role).toBe('ally');
    await r.engine.close();
  });
});

describe('after the review: pinned file rows, no-op verbs, renames (D-168, the lead\'s rulings)', () => {
  test('a file row stores the key its dry run produced (op.target): a new key, a session match, a library match by alias', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    s.memoryFile({ type: 'character', data: { name: 'Арсений Кеттер', description: 'Старый мастер фонарей.' } });
    s.memoryFile({ type: 'character', data: { name: 'арсений кеттер', likes: ['чай'] } });
    s.memoryFile({ type: 'character', data: { name: 'Фонарщица', likes: ['ночные смены'] } });
    expect(memRows(r.home, s.id).map((x) => x.ops[0])).toEqual([
      { op: 'file', type: 'character', data: { name: 'Арсений Кеттер', description: 'Старый мастер фонарей.' }, target: 'character:арсений кеттер' },
      { op: 'file', type: 'character', data: { name: 'арсений кеттер', likes: ['чай'] }, target: 'character:арсений кеттер' },
      { op: 'file', type: 'character', data: { name: 'Фонарщица', likes: ['ночные смены'] }, target: `lib:${id}:e1` },
    ]);
    await r.engine.close();
  });

  test('attaching a book later never re-homes the user\'s entries nor loses their edits (no classic_conflict on refold)', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const s = bookSession(r.engine, []);
    s.memoryFile({ type: 'character', data: { name: 'Мира', description: 'Хранительница маяка.' } });
    s.memoryEdit({ ref: 'Мира', set: { role: 'antagonist' } });
    s.memoryFile({ type: 'organization', data: { name: 'Гильдия', description: 'Своя гильдия.' } });
    s.memoryEdit({ ref: 'Гильдия', set: { leader: 'Арсений' } });
    const id = putBook(r.home, LANTERN);
    s.configure({ lorebooks: [id] });
    const rows = s.memoryList().map((x) => [x.ref, x.key]);
    expect(rows).toEqual([
      ['C1', `lib:${id}:e1`],
      ['C2', `lib:${id}:e2`],
      ['C3', 'character:мира'],
      ['C4', 'organization:гильдия'],
    ]);
    expect(s.memoryGet({ ref: 'character:мира' }).entry.data.role).toBe('antagonist');
    expect(s.memoryGet({ ref: 'C1' }).entry.data.role).toBe('protagonist');
    expect(s.memoryGet({ ref: 'C4' }).entry.data.leader).toBe('Арсений');
    expect(s.compendium().issues).toEqual([]);
    await r.engine.close();
  });

  test('a fork keeps a hand-filed summary\'s key: its retire and its edit still apply there', async () => {
    const r = await rig(calls([{ text: 'Первый ответ.' }]), { caps: fullCaps() });
    const s = bookSession(r.engine, [], { text: null });
    // Config rows a fork does not copy shift the seqs of every row after them.
    s.configure({ reasoningShown: true });
    s.configure({ reasoningShown: false });
    s.send({ text: 'Мы идём к маяку.', expectedVersion: s.version() });
    const u = s.view().head!;
    const night = s.memoryFile({ type: 'summary', data: { title: 'Ночь у маяка', summary: 'Они дошли до маяка.' } });
    s.memoryRetire({ ref: night.key, reason: 'не было' });
    const morning = s.memoryFile({ type: 'summary', data: { title: 'Утро', summary: 'Текст.' } });
    s.memoryEdit({ ref: morning.key, set: { summary: 'Исправленный текст.' } });
    await turnOf(s);
    const state = (h: { memoryList(i: { includeRetired: boolean }): MemoryRow[]; memoryGet(i: { ref: string }): { entry: { data: Record<string, unknown> } } }) =>
      h.memoryList({ includeRetired: true }).map((x) => [x.key, x.retired?.reason ?? null, h.memoryGet({ ref: x.key }).entry.data.summary]);
    const before = state(s);
    expect(before).toEqual([
      [night.key, 'не было', 'Они дошли до маяка.'],
      [morning.key, null, 'Исправленный текст.'],
    ]);
    const f = r.engine.session(s.fork({ at: u }));
    expect(state(f)).toEqual(before);
    expect(f.compendium().issues).toEqual([]);
    await r.engine.close();
  });

  test('a verb whose dry run changes nothing writes nothing and says so (changed:false), no event', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const events = collect(r.engine);
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    s.memoryFile({ type: 'character', data: { name: 'Арсений Кеттер', role: 'mentor', likes: ['чай'] } });
    s.memoryAdd({ title: 'Ключи', content: 'Ключи у Миры.' });
    const rows = memRows(r.home, s.id).length;
    await tick();
    const seen = events.seen.length;

    // An edit that sets what is there, unsets what is not, and featured:false on an unfeatured entry.
    expect(s.memoryEdit({ ref: 'Арсений Кеттер', set: { role: 'mentor' }, unset: ['age'], featured: false })).toEqual({ key: 'character:арсений кеттер', changed: false });
    // A library entry: no overlay out of a no-op.
    expect(s.memoryEdit({ ref: 'C1', set: { role: 'protagonist' } })).toEqual({ key: `lib:${id}:e1`, changed: false });
    expect(s.memoryGet({ ref: 'C1' }).entry.origin).toEqual({ kind: 'library', book: id, id: 'e1', overlay: false });
    // A note with the same text; a file that adds nothing new (by name and by a known list item).
    expect(s.memoryEdit({ ref: 'Ключи', content: 'Ключи у Миры.' })).toEqual({ key: 'note:ключи', changed: false });
    expect(s.memoryFile({ type: 'character', data: { name: 'Арсений Кеттер', likes: ['чай'] } })).toEqual({
      key: 'character:арсений кеттер',
      ref: 'C3',
      change: 'merged',
      changed: false,
    });
    // A restore of a live entry.
    expect(s.memoryRestore({ ref: 'C3' })).toEqual({ key: 'character:арсений кеттер', changed: false });
    expect(memRows(r.home, s.id)).toHaveLength(rows);
    await tick();
    expect(events.seen.slice(seen).filter((e) => e.type === 'memory')).toEqual([]);

    // A real change still writes.
    expect(s.memoryEdit({ ref: 'Арсений Кеттер', set: { role: 'ally' } })).toEqual({ key: 'character:арсений кеттер', changed: true });
    expect(memRows(r.home, s.id)).toHaveLength(rows + 1);
    await r.engine.close();
    await events.done;
  });

  test('a rename onto a name another live entry of the type answers to (name, alias, former name) is refused', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    s.memoryFile({ type: 'character', data: { name: 'Арсений Кеттер' } });
    s.memoryFile({ type: 'character', data: { name: 'Тихон' } });
    s.memoryEdit({ ref: 'Тихон', set: { name: 'Тихон Старый' } });
    const rows = memRows(r.home, s.id).length;
    // The library Мира's name and her alias.
    const byName = refusalOf(() => s.memoryEdit({ ref: 'Арсений Кеттер', set: { name: 'мира' } }));
    expect(byName.code).toBe('invalid_params');
    expect(byName.message).toBe('"Мира" (C1) already answers to the name "мира"; a character cannot be renamed to a name another character has');
    expect(refusalOf(() => s.memoryEdit({ ref: 'Арсений Кеттер', set: { name: 'Фонарщица' } })).message).toContain('"Мира" (C1) already answers');
    // Тихон's former name.
    expect(refusalOf(() => s.memoryEdit({ ref: 'Арсений Кеттер', set: { name: 'Тихон' } })).message).toContain('"Тихон Старый" (C4) already answers');
    expect(memRows(r.home, s.id)).toHaveLength(rows);
    // A new spelling of the entry's own name is no rename onto another's, even when another has that name too
    // (filed while the book was not attached, so there was no library Мира to merge into; the row is
    // pinned to its own key, D-168, and stays apart when the book comes back).
    s.configure({ lorebooks: [] });
    const own = s.memoryFile({ type: 'character', data: { name: 'Мира', description: 'Своя Мира.' } }).key;
    s.configure({ lorebooks: [id] });
    expect(s.memoryEdit({ ref: own, set: { name: 'МИРА' } }).changed).toBe(true);
    // A name of another type, of a retired entry, or the entry's own former name is free.
    s.memoryRetire({ ref: 'Тихон Старый' });
    expect(s.memoryEdit({ ref: 'Арсений Кеттер', set: { name: 'Тихон' } }).changed).toBe(true);
    expect(s.memoryEdit({ ref: 'C3', set: { name: 'Серый маяк' } }).changed).toBe(true);
    expect(s.memoryEdit({ ref: 'C3', set: { name: 'Арсений Кеттер' } }).changed).toBe(true);
    await r.engine.close();
  });
});

/** A 2 000-level value ({k:{k:…{leaf}}}, compact); `leaf` is the innermost object. */
function deepValue(levels: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let v: Record<string, unknown> = leaf;
  for (let i = 0; i < levels; i++) v = { k: v };
  return v;
}

const userEntry = (data: Record<string, unknown>): CEntry => ({
  key: 'character:ада',
  type: 'character',
  name: 'Ада',
  aliases: [],
  tagline: '',
  data,
  keys: [],
  origin: { kind: 'session' },
  prov: { created: null, lastSeq: 1, appended: {}, createdSeq: 1 },
});

describe('after the final check (the lead\'s ruling I): bounded no-op check, aliases, one name per live entry, untold notices', () => {
  test('the no-op check uses the merge\'s bounded comparison: deep data is never walked by JS recursion past its bound', () => {
    // The deepest JS stack any read of the leaf sees: an unbounded deepEq reaches it ~2 000 frames down.
    let frames = 0;
    const probe = (): Record<string, unknown> => {
      const leaf: Record<string, unknown> = {};
      Object.defineProperty(leaf, 'v', {
        enumerable: true,
        get() {
          const limit = Error.stackTraceLimit;
          Error.stackTraceLimit = Infinity;
          frames = Math.max(frames, new Error().stack!.split('\n').length);
          Error.stackTraceLimit = limit;
          return 1;
        },
      });
      return leaf;
    };
    expect(sameEntry(userEntry({ deep: deepValue(2_000, probe()) }), userEntry({ deep: deepValue(2_000, probe()) }))).toBe(true);
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThan(400);
    frames = 0;
    expect(sameEntry(userEntry({ deep: deepValue(2_000, probe()) }), userEntry({ deep: deepValue(2_000, { v: 2 }) }))).toBe(false);
    expect(frames).toBeLessThan(400);
  });

  test('a 2 000-level value through the verbs: the same value is no change, a changed leaf is one', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const s = bookSession(r.engine, []);
    const deep = deepValue(2_000, { v: 1 });
    s.memoryFile({ type: 'character', data: { name: 'Ада', deep } });
    const rows = memRows(r.home, s.id).length;
    expect(s.memoryEdit({ ref: 'Ада', set: { deep: deepValue(2_000, { v: 1 }) } })).toEqual({ key: 'character:ада', changed: false });
    expect(s.memoryFile({ type: 'character', data: { name: 'Ада', deep: deepValue(2_000, { v: 1 }) } }).changed).toBe(false);
    expect(memRows(r.home, s.id)).toHaveLength(rows);
    expect(s.memoryEdit({ ref: 'Ада', set: { deep: deepValue(2_000, { v: 2 }) } })).toEqual({ key: 'character:ада', changed: true });
    expect(memRows(r.home, s.id)).toHaveLength(rows + 1);
    await r.engine.close();
  });

  test('set.aliases equal to the aliases the entry shows is no change: no row, no overlay; with other fields only they are written', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    s.memoryFile({ type: 'character', data: { name: 'Ада', description: 'Смотрительница.' } });
    const rows = memRows(r.home, s.id).length;
    // The library Мира shows the book's meta.aliases; spacing, the name itself and repeats are what the fold drops.
    expect(s.memoryEdit({ ref: 'C1', set: { aliases: ['Фонарщица'] } })).toEqual({ key: `lib:${id}:e1`, changed: false });
    expect(s.memoryEdit({ ref: 'C1', set: { aliases: [' Фонарщица ', 'Мира', 'фонарщица'] } })).toEqual({ key: `lib:${id}:e1`, changed: false });
    expect(s.memoryGet({ ref: 'C1' }).entry.origin).toEqual({ kind: 'library', book: id, id: 'e1', overlay: false });
    // A session entry with no aliases.
    expect(s.memoryEdit({ ref: 'Ада', set: { aliases: [] } })).toEqual({ key: 'character:ада', changed: false });
    expect(memRows(r.home, s.id)).toHaveLength(rows);
    // Next to a real change only the change is written.
    expect(s.memoryEdit({ ref: 'C1', set: { aliases: ['Фонарщица'], role: 'ally' } }).changed).toBe(true);
    expect(memRows(r.home, s.id).at(-1)!.ops).toEqual([{ op: 'edit', ref: `lib:${id}:e1`, set: { role: 'ally' } }]);
    expect(s.memoryGet({ ref: 'C1' }).entry.data.aliases).toBeUndefined();
    // Another alias list is a change.
    expect(s.memoryEdit({ ref: 'C1', set: { aliases: ['Фонарщица', 'Мирка'] } }).changed).toBe(true);
    expect(s.memoryGet({ ref: 'C1' }).entry.aliases).toEqual(['Фонарщица', 'Мирка']);
    await r.engine.close();
  });

  test('set.aliases (and a file that merges an alias) onto a name another live entry of the type answers to is refused', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    s.memoryFile({ type: 'character', data: { name: 'Кай' } });
    s.memoryFile({ type: 'character', data: { name: 'Ада' } });
    s.memoryFile({ type: 'location', data: { name: 'Причал', description: 'Старый причал.' } });
    const rows = memRows(r.home, s.id).length;
    expect(refusalOf(() => s.memoryEdit({ ref: 'Ада', set: { aliases: ['кай'] } }))).toEqual({
      code: 'invalid_params',
      message: '"Кай" (C3) already answers to the name "кай"; a character cannot take a name another character has',
    });
    // The library Мира's alias, and a name given by a title field.
    expect(refusalOf(() => s.memoryEdit({ ref: 'Ада', set: { aliases: ['Ада-старшая', 'Фонарщица'] } })).message).toBe(
      '"Мира" (C1) already answers to the name "Фонарщица"; a character cannot take a name another character has',
    );
    expect(refusalOf(() => s.memoryEdit({ ref: 'Ада', set: { title: 'Кай' } })).message).toContain('"Кай" (C3) already answers to the name "Кай"');
    // A file naming both merges into the first and would give it the other's name.
    expect(refusalOf(() => s.memoryFile({ type: 'character', data: { name: 'Кай', aliases: ['Ада'] } })).message).toBe(
      '"Ада" (C4) already answers to the name "Ада"; filing it into "Кай" (C3) would give a character a name another character has',
    );
    expect(memRows(r.home, s.id)).toHaveLength(rows);
    // Names of another type and of retired entries are free; so are names the entry already answers to.
    expect(s.memoryEdit({ ref: 'Ада', set: { aliases: ['Причал'] } }).changed).toBe(true);
    s.memoryRetire({ ref: 'Кай' });
    expect(s.memoryEdit({ ref: 'Ада', set: { aliases: ['Причал', 'Кай'] } }).changed).toBe(true);
    await r.engine.close();
  });

  test('a restore while another live entry of the type answers to one of its names is refused; summaries are exempt', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const s = bookSession(r.engine, []);
    s.memoryFile({ type: 'character', data: { name: 'Ада', aliases: ['Смотрительница'] } });
    s.memoryRetire({ ref: 'Ада' });
    expect(s.memoryFile({ type: 'character', data: { name: 'Ада' } }).key).toBe('character:ада#2');
    const rows = memRows(r.home, s.id).length;
    expect(refusalOf(() => s.memoryRestore({ ref: 'character:ада' }))).toEqual({
      code: 'invalid_params',
      message: '"Ада" (C2) already answers to the name "Ада"; "Ада" (C1) cannot be restored while another character answers to one of its names',
    });
    expect(memRows(r.home, s.id)).toHaveLength(rows);
    // Once the other is retired the restore goes through.
    s.memoryRetire({ ref: 'character:ада#2' });
    expect(s.memoryRestore({ ref: 'character:ада' })).toEqual({ key: 'character:ада', changed: true });
    // An alias counts too.
    s.memoryRetire({ ref: 'character:ада' });
    s.memoryFile({ type: 'character', data: { name: 'Смотрительница' } });
    expect(refusalOf(() => s.memoryRestore({ ref: 'character:ада' })).message).toContain('already answers to the name "Смотрительница"');

    // Summaries never merge by name: a title another summary has is free to rename to and to restore.
    const night = s.memoryFile({ type: 'summary', data: { title: 'Ночь', summary: 'Они дошли до маяка.' } }).key;
    expect(s.memoryFile({ type: 'summary', data: { title: 'Ночь', summary: 'Вторая ночь.' } }).key).toBe('summary:user:ночь#2');
    const morning = s.memoryFile({ type: 'summary', data: { title: 'Утро', summary: 'Рассвет.' } }).key;
    expect(s.memoryEdit({ ref: morning, set: { title: 'Ночь' } }).changed).toBe(true);
    s.memoryRetire({ ref: night });
    expect(s.memoryRestore({ ref: night }).changed).toBe(true);
    await r.engine.close();
  });

  test('a no-op verb returns the notices no verb or turn told yet, and marks them told', async () => {
    const r = await rig(calls([{ text: 'Мира кивает.' }]), { caps: fullCaps() });
    const s0 = bookSession(r.engine, []);
    s0.memoryFile({ type: 'character', data: { name: 'Ада' } });
    const sid = s0.id;
    await s0.close();
    // A large entry written by a raw row: nothing has told its notice yet.
    writeRaw(r.home, sid, (log) => {
      const long = 'Очень длинная история фонаря. '.repeat(450);
      log.append({ t: 'mem', ts: '2026-10-26T12:00:00.000Z', key: null, on: null, by: 'user', ops: [{ op: 'file', type: 'item', data: { name: 'Латунный фонарь', history: long } }] });
    });
    const s = r.engine.session(sid);
    const rows = memRows(r.home, sid).length;
    const w = s.memoryRestore({ ref: 'Ада' });
    expect(w.changed).toBe(false);
    expect(w.notices?.map((n) => n.code)).toEqual(['compendium_large_entry']);
    expect(s.memoryEdit({ ref: 'Ада', set: { aliases: [] } }).notices).toBeUndefined();
    expect(memRows(r.home, sid)).toHaveLength(rows);
    // Told by the verb: the turn does not tell it again.
    const t = await turnOf(s);
    expect(t.evs.flatMap((e) => (e.type === 'notice' ? [e.code] : []))).not.toContain('compendium_large_entry');
    await r.engine.close();
  });
});
