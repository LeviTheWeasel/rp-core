// M5a D-153…D-156 through the engine: the selector's picks reach the request as one Compendium block
// at depth 1 (below lore, above the Director's insert), in the preview as in the turn; the brief's
// tail only when read_lore is offered; a swipe gets the block as a reply does, and an opening selects
// with an empty U (its greeting's window and the constant entries, section H). Deep entry data never
// breaks a preview, a turn or memoryGet (review breaker#3).
import { describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCK_HEADER } from '../../src/agents/compendium/place.ts';
import { libraryDir } from '../../src/formats/library.ts';
import type { LoreEntry } from '../../src/formats/native.ts';
import type { PrepEntry } from '../../src/session/entries.ts';
import {
  bookSession,
  byAgent,
  calls,
  dirCall,
  dirConfig,
  drain,
  entriesOf,
  fullCaps,
  LANTERN,
  LEVI,
  MIRA_ENTRY,
  ok,
  putBook,
  rig,
  srcTexts,
  turnOf,
} from './kit.ts';

/** A constant typed library entry: a law the narrator must always have. */
const LAW: LoreEntry = {
  id: 'e5',
  title: 'Право огня',
  keys: ['право огня'],
  content: 'Огонь нельзя гасить.',
  constant: true,
  position: 'after',
  meta: { type: 'worldbuilding', data: { topic: 'Право огня', category: 'закон', rules: ['Огонь нельзя гасить.'] } },
};

describe('the Compendium block', () => {
  test('the preview: one block at depth 1, below lore and above the Director; «Миру» names Мира', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id], { config: dirConfig() });
    const p = ok(s.preview());
    const srcs = p.messages.map((m) => m.src);
    const block = srcs.indexOf('compendium:block');
    expect(srcs.filter((x) => x === 'compendium:block')).toHaveLength(1);
    expect(srcs.indexOf(`lore:${id}:e3`)).toBe(block - 1);
    expect(srcs.indexOf('director')).toBe(block + 1);
    // Depth 1: right above U.
    expect(block + 2).toBe(p.messages.length - 1);
    expect(p.messages.at(-1)!.role).toBe('user');
    expect(p.messages[block]!.role).toBe('system');

    const text = srcTexts(p.messages, 'compendium:block')[0]!;
    expect(text.startsWith(`${BLOCK_HEADER}\n[Lore: Мира]\n# Мира`)).toBe(true);
    expect(text).toContain('[Lore: Серый маяк]');
    // The full profile (a 32k window): full renders, picked by a mention in U.
    expect(p.trace.compendium).toMatchObject({
      source: 'lexical',
      profile: 'full',
      picks: [
        { ref: 'C1', key: `lib:${id}:e1`, via: 'mention' },
        { ref: 'C2', key: `lib:${id}:e2`, via: 'mention' },
      ],
      injected: [
        { ref: 'C1', mode: 'full' },
        { ref: 'C2', mode: 'full' },
      ],
      cut: [],
      repeated: [],
      hidden: 0,
      rev: s.view().compendium.rev,
    });
    expect(r.provider.requests).toHaveLength(0);
    await r.engine.close();
  });

  test('the turn sends the block the preview showed; a swipe gets it as a reply does', async () => {
    const r = await rig(calls(dirCall(), [{ text: 'Мира поднимает фонарь.' }], dirCall(), [{ text: 'Иначе.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id], { config: dirConfig() });
    const p = ok(s.preview());
    const a = await turnOf(s);
    expect(a.out.type).toBe('done');
    const [n1] = byAgent(r.provider.requests, 'narrator');
    expect(srcTexts(n1!.messages, 'compendium:block')).toEqual(srcTexts(p.messages, 'compendium:block'));
    // trace.compendium rides prep and the commit.
    const prep = entriesOf(r.home, s.id).find((e): e is PrepEntry => e.t === 'prep');
    expect(prep!.trace.compendium!.picks.map((x) => x.ref)).toEqual(['C1', 'C2']);

    const sw = ok(s.preview());
    expect(sw.kind).toBe('swipe');
    expect(srcTexts(sw.messages, 'compendium:block')).toEqual(srcTexts(p.messages, 'compendium:block'));
    await turnOf(s, 'swipe');
    const [, n2] = byAgent(r.provider.requests, 'narrator');
    expect(srcTexts(n2!.messages, 'compendium:block')).toEqual(srcTexts(p.messages, 'compendium:block'));
    await r.engine.close();
  });

  test('the lite profile: a brief, and its read_lore tail only when the request offers read_lore', async () => {
    const lite = { compendium: { profile: 'lite' as const } };
    const withTools = await rig(calls(), { caps: fullCaps({ tools: 'native' }) });
    const id = putBook(withTools.home, LANTERN);
    const s = bookSession(withTools.engine, [id], { config: lite });
    const p = ok(s.preview());
    expect(p.tools.map((t) => t.name)).toContain('read_lore');
    const text = srcTexts(p.messages, 'compendium:block')[0]!;
    // Мира's brief leaves fields out (likes): the tail names her handle.
    expect(text).toContain('[Lore: Мира]\n# Мира\n');
    expect(text).toContain('\n(more: read_lore C1)');
    expect(p.trace.compendium).toMatchObject({ profile: 'lite', injected: [{ ref: 'C1', mode: 'brief' }, { ref: 'C2', mode: 'brief' }] });
    await withTools.engine.close();

    const noTools = await rig(calls(), { caps: fullCaps() });
    const id2 = putBook(noTools.home, LANTERN);
    const q = ok(bookSession(noTools.engine, [id2], { config: lite }).preview());
    expect(q.tools).toEqual([]);
    const plain = srcTexts(q.messages, 'compendium:block')[0]!;
    expect(plain).toContain('[Lore: Мира]\n# Мира\n');
    expect(plain).not.toContain('(more:');
    await noTools.engine.close();
  });

  test('the lore tools are offered for a live typed entry the block did not inject (D-156)', async () => {
    const r = await rig(calls(), { caps: fullCaps({ tools: 'native' }) });
    // Only typed entries: nothing of the lore is left unfired.
    const id = putBook(r.home, { name: 'Lantern', entries: LANTERN.entries.filter((e) => e.meta?.type !== undefined) });
    const named = ok(bookSession(r.engine, [id]).preview());
    expect(named.trace.compendium!.injected.map((x) => x.ref)).toEqual(['C1', 'C2']);
    expect(named.tools.map((t) => t.name)).not.toContain('read_lore');
    const unnamed = ok(bookSession(r.engine, [id], { text: 'Только Мира.' }).preview());
    expect(unnamed.trace.compendium!.injected.map((x) => x.ref)).toEqual(['C1']);
    expect(unnamed.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['search_lore', 'read_lore']));
    await r.engine.close();
  });

  test('an opening (a continue of the greeting: no user message) selects with an empty U: the greeting names, the constants come (review prompt#2)', async () => {
    const r = await rig(calls([{ text: ' Мира зажигает фонарь.' }]), { caps: fullCaps() });
    const id = putBook(r.home, { ...LANTERN, entries: [...LANTERN.entries, LAW] });
    const keeper = { name: 'Keeper', description: 'The lighthouse keeper.', greetings: ['Серый маяк светит над водой.'] };
    const s = r.engine.createSession({ character: keeper, persona: LEVI, config: { lorebooks: [id] } });
    const turn = s.runTurn({ kind: 'continue', expectedVersion: s.version() });
    await drain(turn);
    expect((await turn.result).type).toBe('done');
    const blocks = srcTexts(r.provider.requests[0]!.messages, 'compendium:block');
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block).toContain('[Lore: Серый маяк]');
    expect(block).toContain('[Lore: Право огня]\n# Право огня');
    // The law is a typed entry: it left the lore, and the block is where it is now.
    expect(r.provider.requests[0]!.messages.filter((m) => m.src === `lore:${id}:e5`)).toEqual([]);
    expect(block).not.toContain('[Lore: Мира]');
    const prep = entriesOf(r.home, s.id).find((e): e is PrepEntry => e.t === 'prep');
    expect(prep!.trace.compendium!.picks).toEqual([
      { ref: 'C2', key: `lib:${id}:e2`, via: 'window' },
      { ref: 'C3', key: `lib:${id}:e5`, via: 'constant' },
    ]);
    await r.engine.close();
  });

  test('an opening that names nothing gets no block but records its (empty) picks', async () => {
    const r = await rig(calls([{ text: ' Мира зажигает фонарь.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id], { text: null });
    const turn = s.runTurn({ kind: 'continue', expectedVersion: s.version() });
    await drain(turn);
    expect((await turn.result).type).toBe('done');
    expect(srcTexts(r.provider.requests[0]!.messages, 'compendium:block')).toEqual([]);
    const prep = entriesOf(r.home, s.id).find((e): e is PrepEntry => e.t === 'prep');
    expect(prep!.trace.compendium).toMatchObject({ picks: [], injected: [] });
    await r.engine.close();
  });

  test('entry data nested 20 000 levels deep: memoryGet, the preview and the turn all work (review breaker#3)', async () => {
    const r = await rig(calls([{ text: 'Глубина молчит.' }]), { caps: fullCaps() });
    let deep: unknown = 'дно';
    for (let i = 0; i < 20_000; i++) deep = { a: deep };
    const entry: LoreEntry = { ...MIRA_ENTRY, id: 'd1', title: 'Глубина', keys: ['Глубина'], content: 'Глубина — персонаж.', meta: { type: 'character', data: { name: 'Глубина', role: 'ally', deep } } };
    const id = putBook(r.home, { name: 'Deep', entries: [] });
    // Written compactly: the library's pretty print grows with the square of the depth.
    writeFileSync(join(libraryDir(r.home, 'lorebooks'), `${id}.json`), JSON.stringify({ name: 'Deep', entries: [entry] }));
    const s = bookSession(r.engine, [id], { text: 'Где Глубина?' });
    const got = s.memoryGet({ ref: 'C1' });
    expect(got.render).toStartWith('# Глубина\n\n## Role\nally');
    expect(got.render).toContain('…');
    expect(got.brief).toBe('# Глубина\nRole: ally');
    const p = ok(s.preview());
    expect(srcTexts(p.messages, 'compendium:block')[0]).toContain('[Lore: Глубина]\n# Глубина');
    const t = await turnOf(s);
    expect(t.out.type).toBe('done');
    await r.engine.close();
    rmSync(r.home, { recursive: true, force: true });
  });

  test('the live-run case (D-169): «Это фонарь вашего мужа, Гордея?» names «Фонарь Гордея»', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const lamp: LoreEntry = {
      id: 'e6',
      title: 'Фонарь Гордея',
      keys: [],
      content: 'Старый фонарь.',
      position: 'after',
      meta: { type: 'item', data: { name: 'Фонарь Гордея', type: 'relic', current_owner: 'Мира' } },
    };
    const id = putBook(r.home, { name: 'Lamp', entries: [lamp] });
    const p = ok(bookSession(r.engine, [id], { text: 'Это фонарь вашего мужа, Гордея?' }).preview());
    expect(p.trace.compendium!.picks).toEqual([{ ref: 'C1', key: `lib:${id}:e6`, via: 'mention' }]);
    expect(srcTexts(p.messages, 'compendium:block')[0]).toContain('[Lore: Фонарь Гордея]');
    await r.engine.close();
  });

  test('tier 2: an entry named in the last visible messages before U', async () => {
    const r = await rig(calls([{ text: 'Серый маяк молчит.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id], { text: 'Я иду в порт.' });
    await turnOf(s);
    s.send({ text: 'Что дальше?', expectedVersion: s.version() });
    const p = ok(s.preview());
    expect(p.trace.compendium!.picks).toEqual([{ ref: 'C2', key: `lib:${id}:e2`, via: 'window' }]);
    await r.engine.close();
  });
});
