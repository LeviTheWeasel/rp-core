// agents/compendium/apply.ts: normalizeName and the M3 Compendium fold (notes only, §5.8).
import { describe, expect, test } from 'bun:test';
import { foldCompendium, normalizeName } from '../../src/agents/compendium/apply.ts';
import { librarySeed } from '../../src/agents/compendium/library.ts';
import type { CEntry } from '../../src/agents/compendium/types.ts';
import type { MemEntry, MemOp } from '../../src/session/entries.ts';
import { file, NO_PATH, note, row } from './fixtures.ts';
import { source, typed } from './kit.ts';

const fold = (rows: MemEntry[], path: Iterable<string> = NO_PATH) => foldCompendium(rows, { pathSet: new Set(path) });
const keysOf = (rows: MemEntry[], path?: Iterable<string>) => [...fold(rows, path).entries.keys()];
const entry = (rows: MemEntry[], key: string): CEntry => {
  const e = fold(rows).entries.get(key);
  if (!e) throw new Error(`no entry ${key}`);
  return e;
};

describe('normalizeName', () => {
  test("Bunraku's rule: lower case, punctuation and '_' to spaces, whitespace collapsed, trimmed", () => {
    expect(normalizeName('Жан-Поль')).toBe('жан поль');
    expect(normalizeName("O'Brien")).toBe('o brien');
    expect(normalizeName('  Mira   Vance\t\n')).toBe('mira vance');
    expect(normalizeName('snake_case')).toBe('snake case');
    expect(normalizeName('Room 101!')).toBe('room 101');
    expect(normalizeName('Мира, Фонарщица.')).toBe('мира фонарщица');
    expect(normalizeName('龍城')).toBe('龍城');
  });

  test('ё folds to е, in either case', () => {
    expect(normalizeName('Ёж')).toBe('еж');
    expect(normalizeName('ёж')).toBe('еж');
    expect(normalizeName('Еж')).toBe('еж');
    expect(normalizeName('Алёна')).toBe(normalizeName('Алена'));
    // A decomposed ё (е + U+0308) is composed by NFKC first, then folded.
    expect(normalizeName('Ёж')).toBe('еж');
  });

  test('NFKC: compatibility forms and decomposed letters name the same thing', () => {
    expect(normalizeName('Ｍｉｒａ')).toBe('mira');
    expect(normalizeName('ﬁre')).toBe('fire');
    expect(normalizeName('йод')).toBe(normalizeName('йод'));
    expect(normalizeName('Café')).toBe(normalizeName('Café'));
  });

  test('combining marks are kept inside a word (D-46), never turned into a space', () => {
    // Cyrillic о + combining acute has no precomposed form: Bunraku's class would split the word.
    expect(normalizeName('Мо́ре')).toBe('мо́ре');
    expect(normalizeName('a̲b')).toBe('a̲b');
  });

  test("'' when there is no letter or digit", () => {
    for (const s of ['', '   ', '!!!', '—', '́', ' ̲ ', '_-_']) expect(normalizeName(s)).toBe('');
  });
});

describe('foldCompendium: notes', () => {
  test('an empty fold', () => {
    expect(fold([])).toEqual({ entries: new Map(), rev: '', lastSeq: 0, issues: [], tasks: new Map(), effects: [] });
  });

  test('note creates an entry keyed by the normalized title', () => {
    const v = fold([row(3, [note('Брат', 'Старший брат Миры.', ['брат', 'Тим'])])]);
    expect([...v.entries.keys()]).toEqual(['note:брат']);
    expect(v.entries.get('note:брат')).toEqual({
      key: 'note:брат',
      type: null,
      name: 'Брат',
      aliases: [],
      tagline: '',
      data: {},
      keys: ['брат', 'Тим'],
      content: 'Старший брат Миры.',
      origin: { kind: 'session' },
      prov: { created: null, lastSeq: 3, appended: {}, createdSeq: 3 },
    });
    expect(v.lastSeq).toBe(3);
    expect(v.rev).toMatch(/^[0-9a-f]{16}$/);
    expect(v.issues).toEqual([]);
  });

  test("a taken key gets '#2', '#3' — taken by a live or by a retired note", () => {
    const live = [row(1, [note('Брат')]), row(2, [note('брат!')]), row(3, [note('БРАТ')])];
    expect(keysOf(live)).toEqual(['note:брат', 'note:брат#2', 'note:брат#3']);
    const retired = [row(1, [note('Ёж')]), row(2, [{ op: 'retire', ref: 'note:еж', reason: 'gone' }]), row(3, [note('Еж')])];
    const v = fold(retired);
    expect([...v.entries.keys()]).toEqual(['note:еж', 'note:еж#2']);
    expect(v.entries.get('note:еж')!.retired).toEqual({ reason: 'gone' });
    expect(v.entries.get('note:еж#2')!.retired).toBeUndefined();
  });

  test('a renamed note keeps its key, and its old title stays taken', () => {
    const rows = [row(1, [note('Мира')]), row(2, [{ op: 'edit', ref: 'note:мира', set: { title: 'Мира Ванс' } }]), row(3, [note('Мира')])];
    const v = fold(rows);
    expect([...v.entries.keys()]).toEqual(['note:мира', 'note:мира#2']);
    expect(v.entries.get('note:мира')!.name).toBe('Мира Ванс');
    // A new note titled like the renamed one's new name gets its own key.
    expect(keysOf([...rows, row(4, [note('Мира Ванс')])])).toEqual(['note:мира', 'note:мира#2', 'note:мира ванс']);
  });

  test('edit: title renames, content and keys are replaced, other set fields go to data, unset and featured', () => {
    const rows = [
      row(1, [note('Лампа', 'Мигает.', ['лампа', 'свет'])]),
      row(2, [{ op: 'edit', ref: 'note:лампа', set: { title: 'Старая лампа', content: 'Погасла.', mood: 'grim' }, keys: ['фонарь'], featured: true }]),
    ];
    const e = entry(rows, 'note:лампа');
    expect(e).toMatchObject({ name: 'Старая лампа', content: 'Погасла.', keys: ['фонарь'], data: { mood: 'grim' }, featured: true });
    expect(e.prov).toEqual({ created: null, lastSeq: 2, appended: {}, createdSeq: 1 });

    const more = [...rows, row(3, [{ op: 'edit', ref: 'note:лампа', unset: ['mood'], featured: false, keys: [] }])];
    const e2 = entry(more, 'note:лампа');
    expect(e2.data).toEqual({});
    expect(e2.featured).toBeUndefined();
    expect(e2.keys).toEqual([]);
    expect(e2.content).toBe('Погасла.'); // untouched by an edit that does not set it
  });

  test('an invalid edit is skipped whole', () => {
    const base = [row(1, [note('Лампа', 'Мигает.')])];
    const bad: MemOp[] = [
      { op: 'edit', ref: 'note:лампа', set: { title: '!!!', content: 'never' } },
      { op: 'edit', ref: 'note:лампа', set: { content: 5 } },
      { op: 'edit', ref: 'note:лампа', unset: ['content'] },
      { op: 'edit', ref: 'note:лампа', keys: 'лампа' as never },
      { op: 'edit', ref: 'note:лампа', featured: 'yes' as never },
      { op: 'edit', ref: 'note:лампа', set: [] as never },
    ];
    const v = fold([...base, row(2, bad)]);
    // M5a: an issue names the entry it concerns.
    expect(v.issues).toEqual(bad.map((_, i) => ({ seq: 2, op: i, why: 'invalid', key: 'note:лампа' })));
    expect(v.entries.get('note:лампа')).toMatchObject({ name: 'Лампа', content: 'Мигает.', keys: ['Лампа'], data: {} });
    expect(v.entries.get('note:лампа')!.prov.lastSeq).toBe(1);
  });

  test('retire and restore set and clear `retired`', () => {
    const rows = [row(1, [note('Мост')]), row(4, [{ op: 'retire', ref: 'note:мост', reason: 'сгорел' }])];
    expect(entry(rows, 'note:мост').retired).toEqual({ reason: 'сгорел' });
    expect(entry(rows, 'note:мост').prov.lastSeq).toBe(4);
    const back = [...rows, row(6, [{ op: 'restore', ref: 'note:мост' }])];
    expect(entry(back, 'note:мост').retired).toBeUndefined();
    expect(entry(back, 'note:мост').prov.lastSeq).toBe(6);
    // A retire without a reason string is read leniently as ''.
    expect(entry([row(1, [note('Мост')]), row(2, [{ op: 'retire', ref: 'note:мост' } as never])], 'note:мост').retired).toEqual({ reason: '' });
  });

  test('an edit of a retired note applies (refs name keys, live or not)', () => {
    const rows = [row(1, [note('Мост')]), row(2, [{ op: 'retire', ref: 'note:мост', reason: '' }]), row(3, [{ op: 'edit', ref: 'note:мост', set: { content: 'Руины.' } }])];
    expect(entry(rows, 'note:мост')).toMatchObject({ content: 'Руины.', retired: { reason: '' } });
  });

  test("an unknown or missing ref is an issue 'not_found'; the rest of the row still applies", () => {
    const v = fold([
      row(1, [note('Мост')]),
      row(2, [
        { op: 'edit', ref: 'note:башня', set: { content: 'x' } },
        { op: 'retire', ref: 'note:мост', reason: 'r' },
        { op: 'restore', ref: 'C9' },
      ]),
    ]);
    expect(v.issues).toEqual([
      { seq: 2, op: 0, why: 'not_found' },
      { seq: 2, op: 2, why: 'not_found' },
    ]);
    expect(v.entries.get('note:мост')!.retired).toEqual({ reason: 'r' });
  });

  test("M5a: file, arc and revert apply; an unknown op is 'unknown_op'; malformed ops 'invalid'", () => {
    const ops = [
      { op: 'file', type: 'character', data: { name: 'Mira' } },
      { op: 'arc', plot: 'The lamp', overview: 'It goes out.' },
      { op: 'revert', key: 'file:a0000001' },
      { op: 'merge', what: 'later' },
      { op: 'note', title: '!!!', keys: [], content: 'x' },
      { op: 'note', title: 'T', keys: [], content: 3 },
      { op: 'note', title: 'T', keys: [1], content: 'x' },
      { op: 'edit', set: {} },
    ] as unknown as MemOp[];
    const v = fold([row(5, ops)]);
    expect(v.issues.map((i) => [i.op, i.why])).toEqual([
      [3, 'unknown_op'],
      [4, 'invalid'],
      [5, 'invalid'],
      [6, 'invalid'],
      [7, 'invalid'],
    ]);
    expect([...v.entries.keys()]).toEqual(['character:mira', 'plot:the lamp', 'arc:the lamp']);
    expect(v.lastSeq).toBe(5);
    expect(v.rev).not.toBe('');
  });

  test('a note without keys reads as keys []', () => {
    expect(entry([row(1, [{ op: 'note', title: 'Мост', content: 'x' } as never])], 'note:мост').keys).toEqual([]);
  });

  test('rows bound to an off-path message are ignored; on:null rows apply everywhere', () => {
    const rows = [
      row(1, [note('Global')]),
      row(2, [note('On path')], { on: 'a0000001' }),
      row(3, [note('Off path')], { on: 'a000001b' }),
      row(4, [{ op: 'retire', ref: 'note:global', reason: 'swiped away' }], { on: 'a000001b' }),
    ];
    const v = fold(rows, ['g0000001', 'u0000001', 'a0000001']);
    expect([...v.entries.keys()]).toEqual(['note:global', 'note:on path']);
    expect(v.entries.get('note:global')!.retired).toBeUndefined();
    expect(v.entries.get('note:on path')!.prov.created).toBe('a0000001');
    expect(v.lastSeq).toBe(2);
    // Only on:null rows on an empty path.
    expect(keysOf(rows)).toEqual(['note:global']);
    // The ignored rows do not change rev.
    expect(fold(rows, ['a0000001']).rev).toBe(fold(rows.slice(0, 2), ['a0000001']).rev);
  });

  test('rows apply in seq order whatever order they come in', () => {
    const rows = [
      row(1, [note('Мост')]),
      row(2, [{ op: 'retire', ref: 'note:мост', reason: '' }]),
      row(3, [note('Мост')]),
      row(4, [{ op: 'edit', ref: 'note:мост#2', set: { content: 'Новый.' } }]),
    ];
    const shuffled = [rows[3]!, rows[1]!, rows[2]!, rows[0]!];
    expect(fold(shuffled)).toEqual(fold(rows));
    expect(shuffled.map((r) => r.seq)).toEqual([4, 2, 3, 1]); // the input is not reordered in place
    // An op that refers to a note created by a LATER row finds nothing.
    const early = fold([row(1, [{ op: 'edit', ref: 'note:мост', set: { content: 'x' } }]), row(2, [note('Мост', 'y')])]);
    expect(early.issues).toEqual([{ seq: 1, op: 0, why: 'not_found' }]);
    expect(early.entries.get('note:мост')!.content).toBe('y');
  });

  test('several ops in one row apply in order', () => {
    const v = fold([row(1, [note('Мост'), { op: 'edit', ref: 'note:мост', set: { content: 'B' } }, note('Мост')])]);
    expect([...v.entries.keys()]).toEqual(['note:мост', 'note:мост#2']);
    expect(v.entries.get('note:мост')!.content).toBe('B');
  });

  test('rev: same rows → same rev; another op → another rev', () => {
    const rows = [row(1, [note('Мост')]), row(2, [{ op: 'retire', ref: 'note:мост', reason: '' }])];
    expect(fold(rows).rev).toBe(fold(structuredClone(rows)).rev);
    expect(fold(rows).rev).not.toBe(fold([rows[0]!]).rev);
    expect(fold(rows).rev).not.toBe(fold([rows[0]!, row(2, [{ op: 'retire', ref: 'note:мост', reason: 'x' }])]).rev);
  });

  test('the view never aliases the rows', () => {
    const rows = [row(1, [note('Мост', 'x', ['мост'])])];
    const e = fold(rows).entries.get('note:мост')!;
    e.keys.push('changed');
    expect((rows[0]!.ops[0] as { keys: string[] }).keys).toEqual(['мост']);
    // A second fold starts from scratch.
    expect(fold(rows).entries.get('note:мост')!.keys).toEqual(['мост']);
  });
});

/** Median and min of `n` (odd) timed runs of `fn` (after one warm-up); `prepare` runs untimed before each. */
function time<T>(fn: (input: T) => unknown, prepare: () => T, n = 7): { median: number; min: number } {
  fn(prepare()); // warm-up (JIT)
  const runs: number[] = [];
  for (let i = 0; i < n; i++) {
    const input = prepare();
    const t0 = performance.now();
    fn(input);
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  return { median: runs[(n - 1) / 2]!, min: runs[0]! };
}

describe('benchmark', () => {
  test('a fold of 5 000 note rows and 1 500 notes under 30 ms (§5.8)', () => {
    const rows: MemEntry[] = [];
    let seq = 0;
    for (let i = 0; i < 1500; i++) rows.push(row(++seq, [note(`Note number ${i % 700} — Мира`, `Text ${i} `.repeat(20), [`key${i}`, `ключ ${i}`])]));
    const keys = [...foldCompendium(rows, { pathSet: new Set() }).entries.keys()];
    for (let i = 0; rows.length < 5000; i++) {
      const ref = keys[(i * 7) % keys.length]!;
      const ops: MemOp[] = [
        { op: 'edit', ref, set: { content: `Edited ${i}`, title: `Renamed ${i}` }, keys: [`k${i}`] },
        { op: 'retire', ref, reason: `r${i}` },
        { op: 'restore', ref },
      ];
      rows.push(row(++seq, [ops[i % 3]!], i % 5 === 0 ? { on: 'm0000001' } : {}));
    }
    const pathSet = new Set(['m0000001']);
    // Fresh row objects each run: a fold from scratch (no checkpoint to resume from).
    const t = time((r: MemEntry[]) => foldCompendium(r, { pathSet }), () => structuredClone(rows));
    const v = foldCompendium(rows, { pathSet });
    console.log(`[bench] foldCompendium over ${rows.length} rows (${v.entries.size} notes): median ${t.median.toFixed(2)} ms, min ${t.min.toFixed(2)} ms`);
    expect(v.entries.size).toBe(1500);
    expect(v.issues).toEqual([]);
    expect(t.median).toBeLessThan(30);
  });
});

describe('benchmark (M5a)', () => {
  /** 1 500 library entries in two books; 5 000 rows on a 6 000-message path: filing rows that create and merge (into the books too), arcs, summaries, edits, notes. */
  function typedSession() {
    const PLACES = ['маяк', 'гавань', 'рынок', 'башня', 'пристань'];
    const lib = Array.from({ length: 1500 }, (_, i) =>
      typed(`e${i}`, i % 3 === 0 ? 'location' : 'character', {
        name: `Персонаж ${i}`,
        aliases: [`П${i}`],
        description: `Житель города номер ${i}. Знает ${PLACES[i % 5]} и всех соседей.`,
        traits: [`черта ${i % 17}`, `привычка ${i % 11}`, 'всегда носит фонарь у пояса'],
        relationships: [{ with: `Персонаж ${(i + 1) % 1500}`, nature: 'ally' }],
      }),
    );
    const seed = librarySeed([source('city', 'Город', lib.slice(0, 900)), source('port', 'Порт', lib.slice(900))], { enabled: true });
    const path = Array.from({ length: 6000 }, (_, i) => `m${String(i).padStart(7, '0')}`);
    const rows: MemEntry[] = [];
    let seq = 0;
    for (let i = 0; rows.length < 5000; i++) {
      const who = i % 4 === 0 ? `Персонаж ${(i * 7) % 1500}` : `Гость ${i % 300}`;
      const ops: MemOp[] = [
        file('character', {
          name: who,
          aliases: i % 5 === 0 ? [`Гость-${i % 300}`] : [],
          description: `Пришёл в город на ${i % 40} день. Ищет ${PLACES[i % 5]}.`,
          traits: [`упрямый ${i % 9}`, `смотрит на ${PLACES[i % 5]} по ночам`, 'всегда носит старый фонарь у пояса'],
          memories: [{ what_happened: `Встреча ${i % 50}`, when: `день ${i % 40}`, changed_belief: 'Свет можно унести.' }],
          relationships: [{ with: `Гость ${(i + 1) % 300}`, nature: i % 2 === 0 ? 'ally' : 'rival' }],
        }),
      ];
      if (i % 10 === 0) ops.push({ op: 'arc', plot: `Сюжет ${i % 30}`, overview: `Обзор ${i}.` });
      if (i % 25 === 0) ops.push(file('summary', { title: `Итог ${i}`, summary: `Что было к ${i}.` }));
      const kind = i % 8;
      if (kind === 7) rows.push(row(++seq, [{ op: 'edit', ref: `lib:city:e${i % 900}`, set: { tier: `T${i % 5}` } }]));
      else if (kind === 6) rows.push(row(++seq, [note(`Заметка ${i % 200}`)]));
      else rows.push(row(++seq, ops, { key: `file:${path[i + 1]}`, on: path[i + 1]!, by: 'filing', range: [path[i]!, path[i + 1]!] }));
    }
    const touched = new Map(path.filter((_, i) => i % 97 === 0).map((id): [string, number] => [id, 9_000]));
    return { rows, seed, path, opts: { pathSet: new Set(path), path, touched, library: seed } };
  }

  test('5 000 typed rows over a 1 500-entry library seed: a refold under 30 ms (D-143)', () => {
    const { rows, seed, opts } = typedSession();
    const v = foldCompendium(rows, opts);
    const overlays = [...v.entries.values()].filter((e) => e.origin.kind === 'library' && e.origin.overlay).length;
    expect(v.entries.size).toBeGreaterThan(2500);
    expect(overlays).toBeGreaterThan(300);
    expect(v.issues).toEqual([]);
    // From scratch (fresh row objects), as on opening a session.
    const cold = time((r: MemEntry[]) => foldCompendium(r, opts), () => structuredClone(rows));
    // The view after one more row, as after a turn: resumes from the last fold's checkpoint.
    let n = 0;
    const append = time(
      (r: MemEntry[]) => foldCompendium(r, opts),
      () => {
        n++;
        foldCompendium(rows, opts);
        return [...rows, row(100_000 + n, [file('character', { name: 'Гость 7', traits: [`новое ${n}`] })], { key: `file:x${n}`, on: 'm0005999', by: 'filing', range: ['m0005998', 'm0005999'] })];
      },
    );
    // A swipe's view at U (the last answer's rows dropped) and the head again.
    const swipe = time((r: MemEntry[]) => foldCompendium(r, { ...opts, pathSet: new Set(opts.path.slice(0, 4000)), path: opts.path.slice(0, 4000) }), () => rows);
    console.log(
      `[bench] typed fold over ${rows.length} rows + ${seed.entries.length} seed entries (${v.entries.size} entries, ${overlays} overlays, ${v.effects.length} effects): ` +
        `cold median ${cold.median.toFixed(2)} ms; refold after a new row median ${append.median.toFixed(2)} ms; at an earlier leaf median ${swipe.median.toFixed(2)} ms`,
    );
    expect(append.median).toBeLessThan(30);
    expect(swipe.median).toBeLessThan(30);
    // The fold from scratch is not the session's common case; a guard against regressions only.
    expect(cold.median).toBeLessThan(150);
  });

  test('5 000 rows adding to one list without a key fn fold from scratch under 500 ms (review breaker#6)', () => {
    // Each row files a new possession and repeats an older one: one set lookup each, not a scan of the list.
    const rows = Array.from({ length: 5000 }, (_, i) =>
      row(i + 1, [file('character', { name: 'Мира', possessions: [{ name: `вещь ${i}`, note: 'старая' }, { note: 'старая', name: `вещь ${i >> 1}` }] })]),
    );
    const t = time((r: MemEntry[]) => foldCompendium(r, { pathSet: NO_PATH }), () => structuredClone(rows), 3);
    const v = foldCompendium(rows, { pathSet: NO_PATH });
    const e = v.entries.get('character:мира')!;
    console.log(`[bench] 5000 rows into one unkeyed list, from scratch: median ${t.median.toFixed(2)} ms, min ${t.min.toFixed(2)} ms`);
    expect((e.data.possessions as { name: string }[]).map((p) => p.name)).toEqual(Array.from({ length: 5000 }, (_, i) => `вещь ${i}`));
    expect(e.prov.appended.possessions).toHaveLength(5000);
    expect(v.issues.map((i) => i.why)).toEqual(['large_entry']);
    expect(t.median).toBeLessThan(500);
  });
});
