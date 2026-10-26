// session/tree.ts: property tests over random trees (fakeRandom) plus targeted cases.
import { describe, expect, test } from 'bun:test';
import type { Entry, EntryInput } from '../../src/session/entries.ts';
import { foldView } from '../../src/session/fold.ts';
import { buildTree, effectiveMessage, newestDescendant, pathTo, siblings, tails } from '../../src/session/tree.ts';
import { fakeRandom } from '../helpers.ts';
import { edit, head, hide, makeHeader, msg, seqd, text, TS } from './fixtures.ts';

/** Random session history: replies, swipes, rewinds, old-swipe selection, edits, hides and junk. */
function randomHistory(seed: number, steps: number): { entries: Entry[]; expectedHead: string | null; expectedVersion: number } {
  const rnd = fakeRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[((rnd(1)[0]! << 8) | rnd(1)[0]!) % xs.length]!;
  const ids: string[] = [];
  const parentOf = new Map<string, string | null>();
  const kids = new Map<string | null, string[]>();
  const inputs: EntryInput[] = [];
  let headId: string | null = null;
  let version = 0;
  let n = 0;
  const newId = () => `m${String(n++).padStart(7, '0')}`;
  const addMsg = (parent: string | null) => {
    const id = newId();
    inputs.push(msg(id, parent, ids.length % 2 ? 'user' : 'assistant'));
    ids.push(id);
    parentOf.set(id, parent);
    kids.set(parent, [...(kids.get(parent) ?? []), id]);
    headId = id;
    version = inputs.length;
  };
  for (let i = 0; i < steps; i++) {
    const op = rnd(1)[0]! % 100;
    if (ids.length === 0 || op < 40) addMsg(headId); // reply under the head
    else if (op < 50) addMsg(parentOf.get(pick(ids)) ?? null); // swipe: sibling of a random message
    else if (op < 55) addMsg(null); // another greeting root
    else if (op < 65) {
      const leaf = pick(ids); // rewind
      inputs.push(head(leaf));
      headId = leaf;
      version = inputs.length;
    } else if (op < 72) {
      // select an old swipe: head on its newest descendant
      let cur = pick(ids);
      for (let k = kids.get(cur); k && k.length; k = kids.get(cur)) cur = k[k.length - 1]!;
      inputs.push(head(cur));
      headId = cur;
      version = inputs.length;
    } else if (op < 80) {
      inputs.push(edit(pick(ids), `edited ${i}`));
      version = inputs.length;
    } else if (op < 86) {
      inputs.push(hide(pick(ids), op % 2 === 0));
      version = inputs.length;
    } else if (op < 89) {
      // orphan: the parent's line was lost; the orphan and anything under it stay out of the tree
      inputs.push(msg(newId(), 'lost0000', 'user'));
      version = inputs.length;
    } else if (op < 91) {
      inputs.push(head('nowhere0')); // head on an unknown leaf: ignored, but still versioned
      version = inputs.length;
    } else if (op < 93) {
      inputs.push(msg(pick(ids), null)); // duplicate id: ignored
      version = inputs.length;
    } else {
      inputs.push({ t: 'chk', turn: 't_x', text: 'delta' } as EntryInput); // not versioned
    }
  }
  return { entries: seqd(inputs), expectedHead: headId, expectedVersion: version };
}

describe('tree properties (random trees)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    test(`seed ${seed}`, () => {
      const { entries, expectedHead, expectedVersion } = randomHistory(seed, 60 + seed * 5);
      const idx = buildTree(entries);
      expect(idx.head).toBe(expectedHead);
      expect(idx.version).toBe(expectedVersion);

      // every non-root parent exists
      for (const m of idx.msgs.values()) if (m.parent !== null) expect(idx.msgs.has(m.parent)).toBe(true);

      // path is a root → head chain
      const path = pathTo(idx, idx.head);
      if (idx.head === null) expect(path).toEqual([]);
      else {
        expect(path[path.length - 1]).toBe(idx.head);
        expect(idx.msgs.get(path[0]!)!.parent).toBeNull();
        for (let i = 1; i < path.length; i++) expect(idx.msgs.get(path[i]!)!.parent).toBe(path[i - 1]!);
      }

      // tails ∩ path = ∅; tails are exactly the leaves off the path
      const pathSet = new Set(path);
      const t = tails(idx, pathSet);
      for (const id of t) {
        expect(pathSet.has(id)).toBe(false);
        expect(idx.children.get(id)?.length ?? 0).toBe(0);
      }
      const leaves = [...idx.msgs.keys()].filter((id) => !(idx.children.get(id)?.length));
      expect(new Set([...t, ...leaves.filter((l) => pathSet.has(l))])).toEqual(new Set(leaves));

      // children are ordered by seq; siblings include self; newestDescendant is a leaf below id
      for (const [, list] of idx.children) {
        for (let i = 1; i < list.length; i++) expect(idx.msgs.get(list[i]!)!.seq).toBeGreaterThan(idx.msgs.get(list[i - 1]!)!.seq);
      }
      for (const id of idx.msgs.keys()) {
        expect(siblings(idx, id)).toContain(id);
        const leaf = newestDescendant(idx, id);
        expect(idx.children.get(leaf)?.length ?? 0).toBe(0);
        expect(pathTo(idx, leaf)).toContain(id);
      }

      // the PathView agrees, and swipe positions index into the sibling list
      const view = foldView(makeHeader(), entries, idx);
      expect(view.path.map((m) => m.id)).toEqual(path);
      for (const m of view.path) {
        const sibs = siblings(idx, m.id);
        expect(m.swipe.count).toBe(sibs.length);
        expect(sibs[m.swipe.index]).toBe(m.id);
      }
    });
  }
});

describe('tree basics', () => {
  test('empty log', () => {
    const idx = buildTree([]);
    expect(idx.head).toBeNull();
    expect(idx.version).toBe(0);
    expect(pathTo(idx, null)).toEqual([]);
    expect(pathTo(idx, 'unknown')).toEqual([]);
    expect(siblings(idx, 'unknown')).toEqual([]);
  });

  test('head: newest msg vs newest head entry, whichever is later; config etc. do not version', () => {
    const entries = seqd([
      msg('g0000001', null),
      msg('g0000002', null), // second greeting
      head('g0000001'), // greeting swipe back
      { t: 'config', ts: TS, patch: { preset: 'x' } } as EntryInput,
      msg('u0000001', 'g0000001', 'user'),
      { t: 'end', ts: TS, turn: 't', outcome: 'failed' } as EntryInput,
    ]);
    const idx = buildTree(entries);
    expect(idx.head).toBe('u0000001');
    expect(idx.version).toBe(5);
    expect(siblings(idx, 'g0000002')).toEqual(['g0000001', 'g0000002']);
    const after = buildTree([...entries, ...seqd([head('g0000002')], 7)]);
    expect(after.head).toBe('g0000002');
    expect(after.version).toBe(7);
    expect(tails(after, new Set(pathTo(after, after.head)))).toEqual(['u0000001']);
  });

  test('entries out of seq order are sorted first', () => {
    const entries = seqd([msg('a0000001', null), msg('a0000002', 'a0000001'), head('a0000001')]);
    const idx = buildTree([entries[2]!, entries[0]!, entries[1]!]);
    expect(idx.head).toBe('a0000001');
  });

  test('effectiveMessage: latest edit with blocks wins; continue brings gen; edited = a user edit', () => {
    const entries = seqd([
      msg('a0000001', null, 'assistant', 'original', { gen: { kind: 'model', model: 'm1' } }),
      { t: 'edit', ts: TS, target: 'a0000001', reason: 'continue', blocks: text('original and more'), gen: { kind: 'model', model: 'm2' } } as EntryInput,
    ]);
    let idx = buildTree(entries);
    expect(effectiveMessage(idx, 'a0000001')).toEqual({ blocks: text('original and more'), edited: false, gen: { kind: 'model', model: 'm2' } });
    idx = buildTree([...entries, ...seqd([edit('a0000001', 'by hand'), { t: 'edit', ts: TS, target: 'a0000001', reason: 'user', vars: { x: 1 } } as EntryInput], 3)]);
    expect(effectiveMessage(idx, 'a0000001')).toEqual({ blocks: text('by hand'), edited: true, gen: { kind: 'model', model: 'm2' } });
    expect(effectiveMessage(idx, 'missing')).toEqual({ blocks: [], edited: false });
  });
});

describe('tail commits (§5.3, §6.6)', () => {
  test('a msg with tail:true joins the tree and bumps the version but leaves the head', () => {
    const es = seqd([
      msg('g1', null),
      msg('g2', null),
      head('g1'),
      msg('u1', 'g1', 'user'),
      head('g2'),
      msg('a1', 'u1', 'assistant', 'late answer', { tail: true }),
    ]);
    const idx = buildTree(es);
    expect(idx.msgs.has('a1')).toBe(true);
    expect(idx.head).toBe('g2');
    expect(idx.version).toBe(6);
    expect(tails(idx, new Set(pathTo(idx, idx.head)))).toEqual(['a1']);
    // A later ordinary msg moves the head as always.
    expect(buildTree([...es, ...seqd([msg('u2', 'g2', 'user')], 7)]).head).toBe('u2');
  });
});
