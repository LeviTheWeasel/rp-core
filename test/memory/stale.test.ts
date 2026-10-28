// The fold through the session tree (D-143): TreeIndex.touched, staleness of agent rows by edits and
// hides, swipes and rewinds, forks, and the library seed passed to foldView / foldViewAt.
import { describe, expect, test } from 'bun:test';
import { librarySeed } from '../../src/agents/compendium/library.ts';
import type { EntryInput, MemOp } from '../../src/session/entries.ts';
import { foldView, foldViewAt } from '../../src/session/fold.ts';
import { planFork } from '../../src/session/fork.ts';
import { buildTree } from '../../src/session/tree.ts';
import { edit, head, hide, makeHeader, msg, seqd, TS } from '../session/fixtures.ts';
import { file } from './fixtures.ts';
import { lantern } from './kit.ts';

const fileRow = (on: string, range: [string, string], ops: MemOp[]): EntryInput => ({ t: 'mem', ts: TS, key: `file:${on}`, on, by: 'filing', range, ops }) as EntryInput;
const userRow = (ops: MemOp[], on: string | null = null): EntryInput => ({ t: 'mem', ts: TS, key: null, on, by: 'user', ops }) as EntryInput;

/** g → u1 → a1 → u2 → a2; a filing row for each answer, covering its user line and the answer. */
function chat(extra: EntryInput[] = []): EntryInput[] {
  return [
    msg('g0000001', null, 'assistant', 'Здравствуй.', { gen: { kind: 'greeting' } }),
    msg('u0000001', 'g0000001', 'user', 'Где Мира?'),
    msg('a0000001', 'u0000001', 'assistant', 'Мира у маяка.'),
    fileRow('a0000001', ['u0000001', 'a0000001'], [file('character', { name: 'Мира', current_state: { location: 'маяк' } })]),
    msg('u0000002', 'a0000001', 'user', 'А Кай?'),
    msg('a0000002', 'u0000002', 'assistant', 'Кай ушёл.'),
    fileRow('a0000002', ['u0000002', 'a0000002'], [file('character', { name: 'Кай' })]),
    ...extra,
  ];
}
const keysOf = (entries: EntryInput[]) => [...foldView(makeHeader(), seqd(entries)).compendium.entries.keys()];

describe('TreeIndex.touched', () => {
  test('the newest edit (any reason) and hide-true seq per message; an un-hide touches nothing', () => {
    const tree = buildTree(seqd(chat([edit('a0000001', 'Мира ушла.'), hide('u0000002'), hide('u0000002', false), edit('a0000002', 'x', { reason: 'continue' }), edit('zzzzzzzz', 'x')])));
    expect([...tree.touched]).toEqual([
      ['a0000001', 8],
      ['u0000002', 9],
      ['a0000002', 11],
    ]);
  });
});

describe('staleness through the tree', () => {
  test('a user edit inside the range drops the row and frees its key', () => {
    expect(keysOf(chat())).toEqual(['character:мира', 'character:кай']);
    const view = foldView(makeHeader(), seqd(chat([edit('u0000001', 'Где же Мира?')])));
    expect([...view.compendium.entries.keys()]).toEqual(['character:кай']);
    expect(view.compendium.tasks.get('file:a0000001')).toEqual({ seq: 4, status: 'stale', range: ['u0000001', 'a0000001'] });
    expect(view.compendium.tasks.get('file:a0000002')).toEqual({ seq: 7, status: 'applied', range: ['u0000002', 'a0000002'] });
  });

  test('a continue edit stales too (the text changed); a hide does; an un-hide does not', () => {
    expect(keysOf(chat([edit('a0000002', 'Кай ушёл далеко.', { reason: 'continue' })]))).toEqual(['character:мира']);
    expect(keysOf(chat([hide('a0000001')]))).toEqual(['character:кай']);
    // Hidden then shown again: the hide still counts (its seq is newer than the row).
    expect(keysOf(chat([hide('a0000001'), hide('a0000001', false)]))).toEqual(['character:кай']);
    // Hidden before the row was written, shown after: only the un-hide is newer, and it does not count.
    const early = [
      msg('g0000001', null, 'assistant', 'Здравствуй.', { gen: { kind: 'greeting' } }),
      msg('u0000001', 'g0000001', 'user', 'Где Мира?'),
      msg('a0000001', 'u0000001', 'assistant', 'Мира у маяка.'),
      hide('u0000001'),
      fileRow('a0000001', ['u0000001', 'a0000001'], [file('character', { name: 'Мира' })]),
      hide('u0000001', false),
    ];
    expect(keysOf(early)).toEqual(['character:мира']);
  });

  test('a refile after the edit applies again (the newest row of the key)', () => {
    const refile = fileRow('a0000001', ['u0000001', 'a0000001'], [file('character', { name: 'Мира', current_state: { location: 'дом' } })]);
    const view = foldView(makeHeader(), seqd(chat([edit('u0000001', 'Где же Мира?'), refile])));
    expect(view.compendium.entries.get('character:мира')?.data.current_state).toEqual({ location: 'дом' });
    expect(view.compendium.tasks.get('file:a0000001')).toMatchObject({ seq: 9, status: 'applied' });
  });
});

describe('swipes, rewinds and forks', () => {
  test("a swipe's view at U drops the replaced answer's row; selecting the swipe brings in its own", () => {
    const entries = seqd(
      chat([
        msg('a000002b', 'u0000002', 'assistant', 'Кай остался.'),
        fileRow('a000002b', ['u0000002', 'a000002b'], [file('character', { name: 'Кай', current_state: { status: 'alive' } }), file('item', { name: 'Нож' })]),
      ]),
    );
    const tree = buildTree(entries);
    expect([...foldViewAt(makeHeader(), tree, 'u0000002').compendium.entries.keys()]).toEqual(['character:мира']);
    expect([...foldView(makeHeader(), entries).compendium.entries.keys()]).toEqual(['character:мира', 'character:кай', 'item:нож']);
    expect([...foldView(makeHeader(), [...entries, { t: 'head', ts: TS, leaf: 'a0000002', seq: 99 }]).compendium.entries.keys()]).toEqual(['character:мира', 'character:кай']);
  });

  test('a rewind to an earlier message drops later rows; global human rows stay', () => {
    const entries = seqd(chat([userRow([{ op: 'note', title: 'Фонарь', keys: [], content: 'x' }]), head('a0000001')]));
    expect([...foldView(makeHeader(), entries).compendium.entries.keys()]).toEqual(['character:мира', 'note:фонарь']);
  });

  test('a fork copies the rows of its path and keeps their keys', () => {
    const source = { header: makeHeader(), entries: seqd(chat([userRow([{ op: 'edit', ref: 'character:мира', set: { tier: 'A' } }])])) };
    const fork = planFork(source, 'a0000001', { newId: 's_0000f001', now: TS });
    const view = foldView(fork.header, fork.entries);
    expect([...view.compendium.entries.keys()]).toEqual(['character:мира']);
    expect(view.compendium.entries.get('character:мира')?.data.tier).toBe('A');
    expect([...view.compendium.tasks.keys()]).toEqual(['file:a0000001']);
  });

  test('a fork renumbers seq; hand-filed summaries keep their keys, so their retire and edit still apply (D-168)', () => {
    const summary = (title: string): MemOp => file('summary', { title, summary: `${title}.` });
    const source = {
      header: makeHeader(),
      entries: seqd(
        chat([
          // A fork copies no head entry: every later row moves down.
          head('a0000002'),
          userRow([summary('Встреча')]),
          userRow([summary('Ссора')]),
          userRow([{ op: 'retire', ref: 'summary:user:встреча', reason: '' }]),
          userRow([{ op: 'edit', ref: 'summary:user:ссора', set: { summary: 'Помирились.' } }]),
        ]),
      ),
    };
    const fork = planFork(source, 'a0000002', { newId: 's_0000f001', now: TS });
    for (const { header, entries } of [source, fork]) {
      const c = foldView(header, entries).compendium;
      expect([...c.entries.keys()]).toEqual(['character:мира', 'character:кай', 'summary:user:встреча', 'summary:user:ссора']);
      expect(c.entries.get('summary:user:встреча')?.retired).toEqual({ reason: '' });
      expect(c.entries.get('summary:user:ссора')?.data.summary).toBe('Помирились.');
      expect(c.issues).toEqual([]);
    }
    expect(fork.entries.find((e) => e.t === 'mem' && e.by === 'user')?.seq).toBeLessThan(source.entries.find((e) => e.t === 'mem' && e.by === 'user')!.seq);
  });
});

describe('the library seed through foldView', () => {
  test('foldView and foldViewAt take the seed; without it the view holds the session rows only', () => {
    const seed = librarySeed([lantern()], { enabled: true });
    const entries = seqd(chat([userRow([{ op: 'edit', ref: 'lib:lantern:e1', set: { tier: 'A' } }])]));
    const view = foldView(makeHeader(), entries, undefined, { library: seed });
    expect([...view.compendium.entries.keys()]).toEqual(['lib:lantern:e1', 'lib:lantern:e2', 'lib:lantern:e3', 'lib:lantern:k2', 'character:мира', 'character:кай']);
    expect(view.compendium.entries.get('lib:lantern:e1')?.origin).toMatchObject({ overlay: true });
    const at = foldViewAt(makeHeader(), buildTree(entries), 'a0000001', { library: seed });
    expect([...at.compendium.entries.keys()]).toEqual(['lib:lantern:e1', 'lib:lantern:e2', 'lib:lantern:e3', 'lib:lantern:k2', 'character:мира']);
    const plain = foldView(makeHeader(), entries);
    expect([...plain.compendium.entries.keys()]).toEqual(['character:мира', 'character:кай']);
    expect(plain.compendium.issues).toEqual([{ seq: 8, op: 0, why: 'library_entry_missing', key: 'lib:lantern:e1' }]);
  });
});
