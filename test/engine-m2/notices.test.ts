// M2: request notices keep the once-per-session rule under their key — a broken '/regex/' lore key
// is told once per entry (label), whatever other entries break later.
import { describe, expect, test } from 'bun:test';
import { regexNoticesPerEntry } from '../../src/engine/request.ts';
import { book, calls, entry, notices, rig, run, say, session, writeLibrary } from './kit.ts';

const BAD = '/(?<=sea )dragon/'; // lookbehind: re2js refuses it
const BAD2 = '/(?!x)wyrm/';

describe('lore_regex_invalid', () => {
  test('once per session per entry', async () => {
    const r = await rig(calls([{ text: 'One.' }], [{ text: 'Two.' }], [{ text: 'Three.' }]));
    writeLibrary(r.home, 'lorebooks', 'w', book('World', [entry('a', 'A', { keys: [BAD] })]));
    const { s } = session(r.engine, ['w'], 'A sea dragon.');
    const first = notices((await run(s.runTurn({ kind: 'reply', expectedVersion: s.version() }))).evs).filter((n) => n.code === 'lore_regex_invalid');
    expect(first).toHaveLength(1);
    expect(first[0]!.message).toContain(`w:a ${BAD}`);

    // A second broken entry: only it is told.
    writeLibrary(r.home, 'lorebooks', 'w', book('World', [entry('a', 'A', { keys: [BAD] }), entry('b', 'B', { keys: [BAD2] })]));
    const second = notices((await say(s, 'Wyrm.')).evs).filter((n) => n.code === 'lore_regex_invalid');
    expect(second).toHaveLength(1);
    expect(second[0]!.message).toContain(`w:b ${BAD2}`);
    expect(second[0]!.message).not.toContain('w:a');

    const third = notices((await say(s, 'Again.')).evs).filter((n) => n.code === 'lore_regex_invalid');
    expect(third).toEqual([]);
    await r.engine.close();
  });

  test('the per-entry split', () => {
    const errors = [
      { book: 'w', id: 'a', key: BAD, message: 'x' },
      { book: 'w', id: 'b', key: BAD2, message: 'y' },
      { book: 'w', id: 'a', key: '/(?=z)/', message: 'z' },
    ];
    const split = regexNoticesPerEntry(errors);
    expect(split.map((k) => k.key)).toEqual(['lore_regex_invalid:w:a', 'lore_regex_invalid:w:b']);
    expect(split[0]!.notice.message).toContain(`w:a ${BAD}, w:a /(?=z)/`);
    expect(split[1]!.notice.message).toContain(`w:b ${BAD2}`);
    expect(split[1]!.notice.message).not.toContain('w:a');
    expect(regexNoticesPerEntry([])).toEqual([]);
  });
});
