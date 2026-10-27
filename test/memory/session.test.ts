// The M3 note verbs end to end (api.ts: notes, memoryAdd/Edit/Retire/Restore; §5.8, decisions F1–F5).
import { describe, expect, test } from 'bun:test';
import { Refusal, type RefusalCode, type SessionHandle } from '../../src/engine/api.ts';
import type { SessionImpl } from '../../src/engine/session.ts';
import type { Event } from '../../src/protocol/events.ts';
import { notesBook } from '../../src/agents/compendium/notes.ts';
import type { MemEntry } from '../../src/session/entries.ts';
import { calls, drain, entriesOf, LEVI, MIRA, rig, withUserMessage } from '../engine/kit.ts';

function refusal(fn: () => unknown): RefusalCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof Refusal) return e.code;
    throw e;
  }
  throw new Error('expected a Refusal');
}

/** Collect every engine event until the engine closes. */
function collect(engine: { events(): AsyncIterable<Event> }): { seen: Event[]; done: Promise<void> } {
  const seen: Event[] = [];
  const tail = engine.events();
  const done = (async () => {
    for await (const ev of tail) seen.push(ev);
  })();
  return { seen, done };
}

const memRows = (home: string, id: string): MemEntry[] => entriesOf(home, id).filter((e): e is MemEntry => e.t === 'mem');
const summary = (s: SessionHandle) => s.notes().map((n) => ({ key: n.key, name: n.name, keys: n.keys, content: n.content, retired: n.retired }));

describe('note verbs', () => {
  test('add, list, edit, retire, restore: one durable mem row each, a memory event each, the version unmoved', async () => {
    const { engine, home } = await rig([]);
    const events = collect(engine);
    const s = engine.createSession({ character: MIRA, persona: LEVI });
    const version = s.version();
    expect(s.notes()).toEqual([]);

    expect(s.memoryAdd({ title: ' Брат ', content: ' Старший брат Миры. ', keys: [' брат ', 'Тим', '', 'брат'] })).toEqual({ key: 'note:брат' });
    expect(s.memoryAdd({ title: 'Лампа', content: 'Мигает.' })).toEqual({ key: 'note:лампа' });
    // The same title again is a second note (the key is taken).
    expect(s.memoryAdd({ title: 'брат!', content: 'Другой брат.', keys: [] })).toEqual({ key: 'note:брат#2' });
    expect(summary(s)).toEqual([
      { key: 'note:брат', name: 'Брат', keys: ['брат', 'Тим'], content: 'Старший брат Миры.', retired: undefined },
      { key: 'note:лампа', name: 'Лампа', keys: ['Лампа'], content: 'Мигает.', retired: undefined },
      { key: 'note:брат#2', name: 'брат!', keys: ['брат!'], content: 'Другой брат.', retired: undefined },
    ]);

    // Edit by handle: a rename keeps the key; keys and text by key; an emptied key list falls back to the title.
    expect(s.memoryEdit({ ref: 'C1', title: 'Брат Миры' })).toEqual({ key: 'note:брат' });
    expect(s.memoryEdit({ ref: 'note:лампа', content: 'Погасла.', keys: ['фонарь', ' лампа '] })).toEqual({ key: 'note:лампа' });
    expect(s.memoryEdit({ ref: 'Лампа', keys: [' '] })).toEqual({ key: 'note:лампа' });
    expect(s.notes()[0]).toMatchObject({ key: 'note:брат', name: 'Брат Миры', keys: ['брат', 'Тим'] });
    expect(s.notes()[1]).toMatchObject({ key: 'note:лампа', name: 'Лампа', content: 'Погасла.', keys: ['Лампа'] });

    // Retire by title, restore by handle.
    expect(s.memoryRetire({ ref: 'лампа', reason: ' погасла ' })).toEqual({ key: 'note:лампа' });
    expect(s.notes()[1]!.retired).toEqual({ reason: 'погасла' });
    expect(refusal(() => s.memoryRetire({ ref: 'C2' }))).toBe('invalid_params'); // already retired
    expect(s.memoryRestore({ ref: 'Лампа' })).toEqual({ key: 'note:лампа' });
    expect(s.notes()[1]!.retired).toBeUndefined();
    expect(refusal(() => s.memoryRestore({ ref: 'C2' }))).toBe('invalid_params'); // not retired

    // Each verb wrote exactly one human row with one op; none of them moved the version.
    const rows = memRows(home, s.id);
    expect(rows.map((r) => [r.key, r.on, r.by, r.ops.length])).toEqual(Array(8).fill([null, null, 'user', 1]));
    expect(rows.map((r) => r.ops[0]!.op)).toEqual(['note', 'note', 'note', 'edit', 'edit', 'edit', 'retire', 'restore']);
    expect(rows[0]!.ops[0]).toEqual({ op: 'note', title: 'Брат', keys: ['брат', 'Тим'], content: 'Старший брат Миры.' });
    expect(rows[3]!.ops[0]).toEqual({ op: 'edit', ref: 'note:брат', set: { title: 'Брат Миры' } });
    expect(rows[4]!.ops[0]).toEqual({ op: 'edit', ref: 'note:лампа', set: { content: 'Погасла.' }, keys: ['фонарь', 'лампа'] });
    expect(rows[6]!.ops[0]).toEqual({ op: 'retire', ref: 'note:лампа', reason: 'погасла' });
    expect(s.version()).toBe(version);
    expect(s.view().compendium.issues).toEqual([]);

    await engine.close();
    await events.done;
    const memory = events.seen.filter((e) => e.type === 'memory');
    expect(memory.map((e) => (e.type === 'memory' ? [e.change, e.ref, e.name, e.kind, e.by] : null))).toEqual([
      ['note', 'note:брат', 'Брат', 'note', 'user'],
      ['note', 'note:лампа', 'Лампа', 'note', 'user'],
      ['note', 'note:брат#2', 'брат!', 'note', 'user'],
      ['edited', 'note:брат', 'Брат Миры', 'note', 'user'],
      ['edited', 'note:лампа', 'Лампа', 'note', 'user'],
      ['edited', 'note:лампа', 'Лампа', 'note', 'user'],
      ['retired', 'note:лампа', 'Лампа', 'note', 'user'],
      ['restored', 'note:лампа', 'Лампа', 'note', 'user'],
    ]);
    expect(memory.every((e) => e.sessionId === s.id)).toBe(true);
    // No `changed` event: the version did not move.
    expect(events.seen.some((e) => e.type === 'changed')).toBe(false);
  });

  test('refused with session_busy while a turn runs; nothing is written; notes() still reads', async () => {
    const { engine, home, provider } = await rig(calls([{ pause: 'p' }, { text: 'ok' }]));
    const { s, version } = withUserMessage(engine);
    s.memoryAdd({ title: 'Лампа', content: 'Мигает.' });
    const turn = s.runTurn({ kind: 'reply', expectedVersion: version });
    const before = entriesOf(home, s.id).length;
    expect(refusal(() => s.memoryAdd({ title: 'Мост', content: 'x' }))).toBe('session_busy');
    expect(refusal(() => s.memoryEdit({ ref: 'C1', content: 'x' }))).toBe('session_busy');
    expect(refusal(() => s.memoryRetire({ ref: 'C1' }))).toBe('session_busy');
    expect(refusal(() => s.memoryRestore({ ref: 'C1' }))).toBe('session_busy');
    // busy comes first, even for invalid input
    expect(refusal(() => s.memoryAdd({ title: '', content: '' }))).toBe('session_busy');
    expect(s.notes().map((n) => n.key)).toEqual(['note:лампа']);
    expect(entriesOf(home, s.id).filter((e) => e.t === 'mem')).toHaveLength(1);
    provider.release('p');
    await drain(turn);
    expect(entriesOf(home, s.id).length).toBeGreaterThan(before); // the turn's own lines only
    expect(memRows(home, s.id)).toHaveLength(1);
    // After the turn the verbs work again.
    expect(s.memoryRetire({ ref: 'C1' })).toEqual({ key: 'note:лампа' });
    await engine.close();
  });

  test('invalid_params and not_found, and nothing written for either', async () => {
    const { engine, home } = await rig([]);
    const s = engine.createSession({ character: MIRA, persona: LEVI });
    s.memoryAdd({ title: 'Брат', content: 'Один.' });
    s.memoryAdd({ title: 'Брат', content: 'Другой.' });
    const before = entriesOf(home, s.id).length;
    const bad: [() => unknown, RefusalCode][] = [
      [() => s.memoryAdd(null as never), 'invalid_params'],
      [() => s.memoryAdd({ title: '', content: 'x' }), 'invalid_params'],
      [() => s.memoryAdd({ title: '  !!! ', content: 'x' }), 'invalid_params'],
      [() => s.memoryAdd({ title: 'T', content: '   ' }), 'invalid_params'],
      [() => s.memoryAdd({ title: 'T', content: 5 as never }), 'invalid_params'],
      [() => s.memoryAdd({ title: 'T', content: 'x', keys: 'x' as never }), 'invalid_params'],
      [() => s.memoryAdd({ title: 'T', content: 'x', keys: [1] as never }), 'invalid_params'],
      [() => s.memoryEdit({ ref: 'C1' }), 'invalid_params'], // nothing to change
      [() => s.memoryEdit({ ref: 'C1', title: '?' }), 'invalid_params'],
      [() => s.memoryEdit({ ref: 'C1', content: '' }), 'invalid_params'],
      [() => s.memoryEdit({ ref: 5 as never, content: 'x' }), 'invalid_params'],
      [() => s.memoryEdit({ ref: ' ', content: 'x' }), 'invalid_params'],
      [() => s.memoryRetire({ ref: 'C1', reason: 3 as never }), 'invalid_params'],
      [() => s.memoryRestore(undefined as never), 'invalid_params'],
      [() => s.memoryEdit({ ref: 'C9', content: 'x' }), 'not_found'],
      [() => s.memoryEdit({ ref: 'note:нет', content: 'x' }), 'not_found'],
      [() => s.memoryRetire({ ref: 'Брат' }), 'not_found'], // two live notes share the title
      [() => s.memoryRestore({ ref: 'Мост' }), 'not_found'],
    ];
    for (const [fn, code] of bad) expect(refusal(fn)).toBe(code);
    expect(entriesOf(home, s.id)).toHaveLength(before);
    await engine.close();
  });

  test('view() sees a note right after memoryAdd (the cache is keyed on the last mem row too)', async () => {
    const { engine } = await rig([]);
    const { s, version } = withUserMessage(engine);
    const impl = s as SessionImpl;
    const v1 = s.view();
    const t1 = impl.tree();
    expect(v1.compendium.entries.size).toBe(0);
    s.memoryAdd({ title: 'Лампа', content: 'Мигает.' });
    expect(s.version()).toBe(version); // no versioned write happened
    const v2 = s.view();
    expect(v2).not.toBe(v1);
    expect([...v2.compendium.entries.keys()]).toEqual(['note:лампа']);
    expect(impl.tree()).not.toBe(t1);
    expect(impl.tree().mems).toHaveLength(1);
    expect(impl.tree().lastMemSeq).toBe(v2.compendium.lastSeq);
    // Unchanged state → the cached objects come back.
    expect(s.view()).toBe(v2);
    expect(impl.tree()).toBe(impl.tree());
    // A retire shows at once too.
    s.memoryRetire({ ref: 'C1' });
    expect(s.view().compendium.entries.get('note:лампа')!.retired).toEqual({ reason: '' });
    await engine.close();
  });

  test('a rename without keys moves the key a keyless add took from the title; written keys stay', async () => {
    const { engine, home } = await rig([]);
    const s = engine.createSession({ character: MIRA, persona: LEVI });
    s.memoryAdd({ title: 'Незнакомец', content: 'Высокий, в сером плаще.' });
    s.memoryAdd({ title: 'Старик', content: 'Сидит у печи.', keys: ['старик'] });
    s.memoryEdit({ ref: 'C1', title: 'Тихон' });
    s.memoryEdit({ ref: 'C2', title: 'Дед Ерофей' });
    expect(s.notes().map((n) => [n.name, n.keys])).toEqual([
      ['Тихон', ['Тихон']],
      ['Дед Ерофей', ['старик']],
    ]);
    expect(notesBook(s.view().compendium)!.entries.map((e) => e.keys)).toEqual([['Тихон'], ['старик']]);
    // One edit row carries the rename and the moved key.
    expect(memRows(home, s.id)[2]!.ops[0]).toEqual({ op: 'edit', ref: 'note:незнакомец', set: { title: 'Тихон' }, keys: ['Тихон'] });
    // Text only, or keys given with the rename: the keys are as the user left them.
    s.memoryEdit({ ref: 'C1', content: 'Брат Марфы.' });
    s.memoryEdit({ ref: 'C1', title: 'Тихон Ильич', keys: ['Тихон', 'брат'] });
    s.memoryEdit({ ref: 'C1', title: 'Тиша' });
    expect(s.notes()[0]).toMatchObject({ name: 'Тиша', keys: ['Тихон', 'брат'], content: 'Брат Марфы.' });
    expect(memRows(home, s.id).slice(4).map((r) => r.ops[0])).toEqual([
      { op: 'edit', ref: 'note:незнакомец', set: { content: 'Брат Марфы.' } },
      { op: 'edit', ref: 'note:незнакомец', set: { title: 'Тихон Ильич' }, keys: ['Тихон', 'брат'] },
      { op: 'edit', ref: 'note:незнакомец', set: { title: 'Тиша' } },
    ]);
    await engine.close();
  });

  test('a reopened session keeps its notes; a fork copies them', async () => {
    const { engine } = await rig([]);
    const { s, userId } = withUserMessage(engine);
    s.memoryAdd({ title: 'Брат', content: 'Старший.', keys: ['брат'] });
    s.memoryAdd({ title: 'Мост', content: 'Сгорел.' });
    s.memoryEdit({ ref: 'C1', title: 'Брат Миры' });
    s.memoryRetire({ ref: 'Мост', reason: 'сгорел' });
    const before = summary(s);
    expect(before).toHaveLength(2);
    await s.close();

    const again = engine.session(s.id);
    expect(summary(again)).toEqual(before);
    expect(again.view().compendium.issues).toEqual([]);

    const forkId = again.fork({ at: userId });
    const fork = engine.session(forkId);
    expect(summary(fork)).toEqual(before);
    // The fork's notes live on: a new note goes to the fork only.
    fork.memoryAdd({ title: 'Только в форке', content: 'x' });
    expect(fork.notes()).toHaveLength(3);
    expect(again.notes()).toHaveLength(2);
    await engine.close();
  });

  test('notes are global: a swipe and a rewind keep them', async () => {
    const { engine } = await rig(calls([{ text: 'First answer.' }], [{ text: 'Second answer.' }]));
    const { s, version, userId } = withUserMessage(engine);
    const first = await s.runTurn({ kind: 'reply', expectedVersion: version }).result;
    expect(first.type).toBe('done');
    s.memoryAdd({ title: 'Лампа', content: 'Мигает.' });
    const swiped = await s.runTurn({ kind: 'swipe', expectedVersion: s.version() }).result;
    expect(swiped.type).toBe('done');
    expect(s.notes().map((n) => n.key)).toEqual(['note:лампа']);
    s.select({ messageId: userId, expectedVersion: s.version(), exact: true });
    expect(s.view().head).toBe(userId);
    expect(s.notes().map((n) => n.key)).toEqual(['note:лампа']);
    await engine.close();
  });
});
