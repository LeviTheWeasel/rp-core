// M2: the session's lorebooks (SessionConfig.lorebooks) are loaded from the library in config order
// for every turn and handed to assemble; a missing, unreadable or invalid one is skipped with one
// 'lorebook_missing' notice per id per session, and the turn still runs.
import { describe, expect, test } from 'bun:test';
import { loadLorebooks } from '../../src/engine/request.ts';
import { tmpHome } from '../helpers.ts';
import type { SessionHandle } from '../../src/engine/api.ts';
import { book, calls, entry, firedOf, msgTrace, notices, rig, run, say, session, writeLibrary } from './kit.ts';

describe('loadLorebooks', () => {
  test('config order; a repeated id once, at its first place', () => {
    const home = tmpHome();
    writeLibrary(home, 'lorebooks', 'b1', book('One', [entry('e1', 'one')]));
    writeLibrary(home, 'lorebooks', 'b2', book('Two', [entry('e2', 'two')]));
    const r = loadLorebooks(home, ['b2', 'b1', 'b2']);
    expect(r.sources.map((s) => [s.key, s.book.name])).toEqual([
      ['b2', 'Two'],
      ['b1', 'One'],
    ]);
    expect(r.notices).toEqual([]);
  });

  test('missing, unreadable, invalid and @-ids are skipped with a notice naming the id and the reason', () => {
    const home = tmpHome();
    writeLibrary(home, 'lorebooks', 'ok', book('Ok', [entry('e', 'x')]));
    writeLibrary(home, 'lorebooks', 'broken', '{ not json');
    writeLibrary(home, 'lorebooks', 'invalid', { name: 'Bad', entries: [{ id: 'e', keys: 'dragon', content: 1, position: 'before' }] });
    const r = loadLorebooks(home, ['gone', 'broken', 'ok', 'invalid', '@card', '../escape']);
    expect(r.sources.map((s) => s.key)).toEqual(['ok']);
    expect(r.notices.map((n) => n.key)).toEqual([
      'lorebook_missing:gone',
      'lorebook_missing:broken',
      'lorebook_missing:invalid',
      'lorebook_missing:@card',
      'lorebook_missing:../escape',
    ]);
    for (const n of r.notices) {
      expect(n.notice.level).toBe('warn');
      expect(n.notice.code).toBe('lorebook_missing');
    }
    const msg = r.notices.map((n) => n.notice.message);
    expect(msg[0]).toBe("The lorebook 'gone' is skipped: it is not in the library.");
    expect(msg[1]).toContain("'broken' is skipped: it cannot be read (invalid JSON");
    expect(msg[2]).toContain("'invalid' is skipped: it is invalid (entries[0].");
    expect(msg[4]).toContain('cannot be read (invalid library id');
  });
});

describe('books reach the turn', () => {
  test('in config order: constant entries of both books fire, the later book after the earlier', async () => {
    const r = await rig(calls([{ text: 'Mm.' }]));
    writeLibrary(r.home, 'lorebooks', 'b1', book('One', [entry('e1', 'FROM-ONE', { constant: true })]));
    writeLibrary(r.home, 'lorebooks', 'b2', book('Two', [entry('e2', 'FROM-TWO', { constant: true })]));
    const { s } = session(r.engine, ['b2', 'b1']);
    const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const { evs } = await run(t);
    expect(evs.at(-1)?.type).toBe('done');
    const id = t.messageId;
    // Gathered (and accepted) in config order: b2 first.
    expect(firedOf(msgTrace(r.home, s.id, id))).toEqual(['b2:e2:constant', 'b1:e1:constant']);
    // Both texts were sent.
    const sent = JSON.stringify(r.provider.requests[0]!.messages);
    expect(sent).toContain('FROM-ONE');
    expect(sent).toContain('FROM-TWO');
    await r.engine.close();
  });

  test('a missing book: one notice over two turns, and the turns run with the other books', async () => {
    const r = await rig(calls([{ text: 'One.' }], [{ text: 'Two.' }]));
    writeLibrary(r.home, 'lorebooks', 'here', book('Here', [entry('e', 'PRESENT', { constant: true })]));
    const { s } = session(r.engine, ['gone', 'here']);
    const first = await run2(s);
    const second = await say(s, 'Again.');
    const told = notices([...first, ...second.evs]).filter((n) => n.code === 'lorebook_missing');
    expect(told).toHaveLength(1);
    expect(told[0]!.message).toContain("'gone'");
    expect(told[0]!.level).toBe('warn');
    expect(r.provider.requests).toHaveLength(2);
    for (const req of r.provider.requests) expect(JSON.stringify(req.messages)).toContain('PRESENT');
    await r.engine.close();
  });

  test('two missing books are told once each', async () => {
    const r = await rig(calls([{ text: 'One.' }], [{ text: 'Two.' }]));
    const { s } = session(r.engine, ['gone1', 'gone2']);
    const evs = [...(await run2(s)), ...(await say(s, 'Again.')).evs];
    expect(notices(evs).filter((n) => n.code === 'lorebook_missing').map((n) => n.message.match(/'([^']+)'/)?.[1])).toEqual(['gone1', 'gone2']);
    await r.engine.close();
  });

  test('a book is read at every turn: adding it to the library later takes effect without a notice again', async () => {
    const r = await rig(calls([{ text: 'One.' }], [{ text: 'Two.' }]));
    const { s } = session(r.engine, ['late']);
    await run2(s);
    writeLibrary(r.home, 'lorebooks', 'late', book('Late', [entry('e', 'ARRIVED', { constant: true })]));
    const second = await say(s, 'Again.');
    expect(notices(second.evs).filter((n) => n.code === 'lorebook_missing')).toEqual([]);
    expect(JSON.stringify(r.provider.requests[1]!.messages)).toContain('ARRIVED');
    expect(JSON.stringify(r.provider.requests[0]!.messages)).not.toContain('ARRIVED');
    await r.engine.close();
  });
});

/** The reply to the session's pending user message. */
async function run2(s: SessionHandle) {
  const { evs, out } = await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
  if (out.type !== 'done') throw new Error(`turn did not finish: ${JSON.stringify(out)}`);
  return evs;
}
