// foldCompendium's checkpoints: a refold that resumes from an earlier fold's state gives exactly what a
// fold from the seed gives (fresh row objects never hit a checkpoint).
import { describe, expect, test } from 'bun:test';
import { foldCompendium, type FoldOptions } from '../../src/agents/compendium/apply.ts';
import { librarySeed } from '../../src/agents/compendium/library.ts';
import type { CompendiumView } from '../../src/agents/compendium/types.ts';
import type { MemEntry, MemOp } from '../../src/session/entries.ts';
import { file, note, row } from './fixtures.ts';
import { lantern } from './kit.ts';

const SEED = librarySeed([lantern()], { enabled: true });
const PATH = Array.from({ length: 400 }, (_, i) => `m${String(i).padStart(7, '0')}`);

/** 2 600 rows of every kind: filing rows with ranges, refiles, reverts, notes, edits, arcs, overlays. */
function session(): MemEntry[] {
  const rows: MemEntry[] = [];
  let seq = 0;
  for (let i = 0; rows.length < 2600; i++) {
    const at = PATH[(i % 390) + 1]!;
    const k = i % 10;
    const ops: MemOp[] =
      k < 5
        ? [file('character', { name: `Гость ${i % 40}`, traits: [`черта ${i % 13}`, `смотрит на маяк ночь ${i % 7}`], memories: [{ what_happened: `Встреча ${i % 23}`, when: `день ${i % 9}` }] })]
        : k === 5
          ? [file('character', { name: 'Уля', relationships: [{ with: `Гость ${i % 40}`, nature: 'ally' }] }), { op: 'arc', plot: `Сюжет ${i % 6}`, overview: `Обзор ${i}` }]
          : k === 6
            ? [note(`Заметка ${i % 30}`)]
            : k === 7
              ? [{ op: 'edit', ref: `character:гость ${i % 40}`, set: { tier: `T${i % 4}` } }]
              : k === 8
                ? [{ op: i % 20 === 8 ? 'retire' : 'restore', ref: `character:гость ${(i * 3) % 40}`, reason: 'x' } as MemOp]
                : [{ op: 'revert', key: `file:${PATH[((i - 3) % 390) + 1]}` }];
    const agent = k < 6;
    rows.push(row(++seq, ops, agent ? { key: `file:${at}`, on: at, by: 'filing', range: [PATH[i % 390]!, at] } : k === 9 ? { on: at } : {}));
  }
  return rows;
}

const plain = (v: CompendiumView) => ({ entries: [...v.entries], rev: v.rev, lastSeq: v.lastSeq, issues: v.issues, tasks: [...v.tasks], effects: v.effects });
/** The same fold from the seed: fresh row objects never hit a checkpoint. */
const fromScratch = (rows: MemEntry[], opts: FoldOptions) => plain(foldCompendium(structuredClone(rows), opts));

describe('checkpoints', () => {
  const rows = session();
  const opts: FoldOptions = { pathSet: new Set(PATH), path: PATH, touched: new Map(), library: SEED };

  test('the same rows again, more rows, fewer rows: the same as a fold from the seed', () => {
    const first = foldCompendium(rows, opts);
    expect(plain(first)).toEqual(fromScratch(rows, opts));
    expect(first.entries.size).toBeGreaterThan(50);
    expect(plain(foldCompendium(rows, opts))).toEqual(plain(first));
    const more = [...rows, row(1001, [file('character', { name: 'Гость 3', traits: ['новая'] })], { key: 'file:extra', on: PATH[5]!, by: 'filing', range: [PATH[4]!, PATH[5]!] })];
    expect(plain(foldCompendium(more, opts))).toEqual(fromScratch(more, opts));
    // Fewer rows resume from the checkpoint kept every 2 048 rows.
    const fewer = rows.slice(0, 2300);
    expect(plain(foldCompendium(fewer, opts))).toEqual(fromScratch(fewer, opts));
    expect(plain(foldCompendium(rows, opts))).toEqual(plain(first));
  });

  test('another path, other touched messages, another seed: the same as a fold from the seed', () => {
    foldCompendium(rows, opts);
    const short = { ...opts, pathSet: new Set(PATH.slice(0, 200)), path: PATH.slice(0, 200) };
    expect(plain(foldCompendium(rows, short))).toEqual(fromScratch(rows, short));
    const touched = { ...opts, touched: new Map([[PATH[300]!, 550], [PATH[20]!, 900]]) };
    expect(plain(foldCompendium(rows, touched))).toEqual(fromScratch(rows, touched));
    const noSeed = { ...opts, library: undefined };
    expect(plain(foldCompendium(rows, noSeed))).toEqual(fromScratch(rows, noSeed));
  });

  test("a view's entries can be changed by its reader without changing the next fold", () => {
    const v = foldCompendium(rows, opts);
    for (const e of v.entries.values()) {
      e.aliases.push('x');
      e.keys.push('y');
      e.prov.lastSeq = -1;
      e.name = 'changed';
    }
    v.issues.push({ seq: 0, op: 0, why: 'x' });
    v.effects.length = 0;
    expect(plain(foldCompendium(rows, opts))).toEqual(fromScratch(rows, opts));
  });
});
