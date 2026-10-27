// SessionHandle.search (/search, history/search; §7.5) on a real session over the scripted provider:
// the same search the narrator's search_history runs, numbered on the current path, with
// '(in context)' taken from the head answer's request (its trace.trimmed), the before cursor,
// hidden messages left out, refusals, and reads while a turn runs.
import { describe, expect, test } from 'bun:test';
import { Refusal } from '../../src/engine/api.ts';
import { calls, msgTrace, rig, run, say, session } from '../engine-m2/kit.ts';
import { drain } from '../engine/kit.ts';

/** A reply of about `n` characters that mentions `word`. */
const reply = (i: number, word: string, n = 900): string => `${'Дорога и дождь. '.repeat(Math.ceil(n / 16)).slice(0, n)} ${word} ${i}.`;

describe('SessionHandle.search', () => {
  test('numbers on the path, newest first; the head answer request decides (in context); before pages back', async () => {
    const turns = 8;
    const r = await rig(calls(...Array.from({ length: turns }, (_, i) => [{ text: reply(i + 1, 'караваном') }])));
    // A window the 8 exchanges do not fit (chars/3): the oldest messages are trimmed from the last request.
    const { s } = session(r.engine, [], `${'Привет, путник. '.repeat(50)} Где мой брат?`, { window: 2048 });
    await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    for (let i = 1; i < turns; i++) await say(s, `${'Слушаю. '.repeat(60)} Что с караваном ${i}?`);

    const path = s.view().path;
    expect(path).toHaveLength(1 + 2 * turns);
    const head = path.at(-1)!;

    const all = s.search({ query: 'караван', limit: 20 });
    // Every reply and every user message after the first mentions the caravan (by another form).
    const expected = path.flatMap((m, i) => (/караван/.test(m.blocks.map((b) => ('text' in b ? b.text : '')).join('')) ? [i + 1] : [])).reverse();
    expect(all.hits.map((h) => h.n)).toEqual(expected);
    expect(all.nextBefore).toBeNull();
    expect(all.hits[0]!.id).toBe(head.id);
    expect(all.hits[0]!.speaker).toBe('Mira');
    expect(all.hits.find((h) => h.role === 'user')!.speaker).toBe('Levi');

    // (in context): the head answer's request trimmed the oldest messages; it sent the rest (not the head itself).
    const trimmed = msgTrace(r.home, s.id, head.id)!.trimmed;
    expect(trimmed).not.toBeNull();
    const cut = [path.findIndex((m) => m.id === trimmed!.from) + 1, path.findIndex((m) => m.id === trimmed!.to) + 1];
    for (const h of all.hits) expect(h.inContext).toBe(h.n !== path.length && (h.n < cut[0]! || h.n > cut[1]!));
    const marks = all.hits.map((h) => [h.n, h.inContext] as const);
    expect(marks[0]).toEqual([path.length, false]);
    const sent = marks.filter(([, c]) => c).map(([n]) => n);
    const unsent = marks.filter(([n, c]) => !c && n !== path.length).map(([n]) => n);
    expect(sent.length).toBeGreaterThan(0);
    expect(unsent.length).toBeGreaterThan(0);
    // The cut is the oldest stretch: every sent hit is newer than every trimmed one.
    expect(Math.min(...sent)).toBeGreaterThan(Math.max(...unsent));

    // Paging with before: no gaps, no repeats.
    const paged: number[] = [];
    let before: number | undefined;
    for (;;) {
      const page = s.search({ query: 'караван', limit: 3, ...(before !== undefined ? { before } : {}) });
      paged.push(...page.hits.map((h) => h.n));
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    expect(paged).toEqual(expected);

    // A hidden message leaves the search; its number stays (the others do not shift).
    const target = all.hits[1]!;
    s.hide({ messageId: target.id, hidden: true, expectedVersion: s.version() });
    const after = s.search({ query: 'караван', limit: 20 });
    expect(after.hits.map((h) => h.n)).toEqual(expected.filter((n) => n !== target.n));
    await r.engine.close();
  });

  test('stems and phrases as in search_history; refusals for bad input', async () => {
    const r = await rig(calls([{ text: 'Её брата звали Тихон.' }]));
    const { s } = session(r.engine, [], 'Как звали её брата?');
    await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    expect(s.search({ query: 'брат' }).hits.map((h) => h.n)).toEqual([3, 2]);
    expect(s.search({ query: '"брата звали"' }).hits.map((h) => h.n)).toEqual([3]);
    expect(s.search({ query: 'как звали брата' }).hits.map((h) => h.n)).toEqual([3, 2]);
    expect(s.search({ query: 'Тихон', before: 3 }).hits).toEqual([]);
    // Nothing was trimmed: the answer's request sent #1 and #2 (the answer itself is not "in context").
    expect(s.search({ query: 'брат' }).hits.map((h) => [h.n, h.inContext])).toEqual([
      [3, false],
      [2, true],
    ]);
    // A user message at the head: no request to ask, so nothing is marked.
    s.send({ text: 'А где брат?', expectedVersion: s.version() });
    expect(s.search({ query: 'брат' }).hits.map((h) => [h.n, h.inContext])).toEqual([
      [4, false],
      [3, false],
      [2, false],
    ]);
    for (const bad of [{ query: 'брат', before: 0 }, { query: 'брат', limit: 0 }, { query: 'брат', before: 1.5 }, { query: 5 }, null]) {
      expect(() => s.search(bad as never)).toThrow(Refusal);
    }
    await r.engine.close();
  });

  test('read-only: works while a turn runs, and sees only committed messages', async () => {
    const r = await rig(calls([{ text: 'Первый ответ про лампу.' }], [{ pause: 'p' }, { text: 'Второй ответ про лампу.' }]));
    const { s } = session(r.engine, [], 'Лампа горит?');
    await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }));
    const t = s.submit({ text: 'А лампа ещё горит?', expectedVersion: s.version() });
    const running = drain(t);
    // The new user message is committed; the reply is not.
    for (let i = 0; i < 50 && s.view().path.length < 4; i++) await new Promise((res) => setTimeout(res, 2));
    const mid = s.search({ query: 'лампа' });
    expect(mid.hits.map((h) => h.n)).toEqual([4, 3, 2]);
    r.provider.release('p');
    await running;
    await t.result;
    expect(s.search({ query: 'лампа' }).hits.map((h) => h.n)).toEqual([5, 4, 3, 2]);
    await r.engine.close();
  });
});
