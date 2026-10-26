// M2 REPL flows over a scripted provider with a temporary library: /preset switches what the next
// request is built from, /lore add|rm|test, /preview prints the request the next turn sends, /trace
// names the lore that fired (§12.4, §15 M2 "Отладка", D-45).
import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promptText } from '../../src/cli/repl-render.ts';
import type { MessageView } from '../../src/session/view.ts';
import { calls, entriesOf, replRig, type ReplRig, type ReplRigOptions } from './kit.ts';
import type { ScriptCall } from '../../src/providers/scripted.ts';
import { importFile } from '../../src/formats/import.ts';
import { tmpHome } from '../helpers.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'cli-m2');
const PRESET = join(FIXTURES, 'Lighthouse.json');
const HARBOR = join(FIXTURES, 'Harbor.json');
const CARD = join(import.meta.dir, '..', 'fixtures', 'cards', 'v3-full.json');
const LIGHTHOUSE_8K = PRESET; // openai_max_context 8192
const DEFAULT_ST = join(import.meta.dir, '..', 'fixtures', 'presets', 'Default.json'); // 4095

const rigs: ReplRig[] = [];
async function rig(script: ScriptCall[], o: ReplRigOptions = {}): Promise<ReplRig> {
  const r = await replRig(script, o);
  rigs.push(r);
  return r;
}

/** The config patches the REPL wrote, in order. */
const configs = (r: ReplRig): Record<string, unknown>[] =>
  entriesOf(r.home, r.session.id)
    .filter((e) => e.t === 'config')
    .map((e) => (e as unknown as { patch: Record<string, unknown> }).patch);

const systemText = (r: ReplRig, call: number): string =>
  r.provider.requests[call]!.messages
    .filter((m) => m.role === 'system')
    .map(promptText)
    .join('\n');

describe('/preset', () => {
  test('a SillyTavern preset file is imported, its warnings shown briefly, and the next request is built from it', async () => {
    const r = await rig(calls([{ text: 'One.' }], [{ text: 'Two.' }]));
    r.type('Hello', `/preset ${PRESET}`, '/preset', 'Again');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain(`imported preset lighthouse from ${PRESET} (1 warning)`);
    expect(out).toContain('! not honoured: squashing system messages; kept in extras (squash_system_messages)');
    // The model's window is unknown here (no windowOf): the preset's limit is named as the cap.
    expect(out).toContain('preset → lighthouse "Lighthouse" (from the next turn; it caps the window at 8192 tokens)');
    expect(out).toContain('preset: lighthouse · it caps the window at 8192 tokens\n  builtin     the built-in layout\n* lighthouse');
    expect(systemText(r, 0)).not.toContain('You narrate a quiet lighthouse tale');
    expect(systemText(r, 1)).toContain('You narrate a quiet lighthouse tale as Mira. Keep answers short.');
    expect(systemText(r, 1)).toContain('Stay in the fog.');
    // The preset's samplers ride the request too.
    expect(r.provider.requests[1]!.samplers.temperature).toBe(0.7);
    expect(configs(r)).toContainEqual({ preset: 'lighthouse' });
  });

  test('switching back by id and to builtin; a wrong kind, an unknown id and a missing file change nothing', async () => {
    const r = await rig(calls());
    r.type(`/preset ${PRESET}`, '/preset builtin', '/preset lighthouse', '/preset lighthouse', `/preset ${CARD}`, '/preset nowhere', '/preset ./missing.json');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('preset → builtin (from the next turn)');
    expect(out).toContain('the session already uses preset lighthouse');
    expect(out).toContain('cannot import');
    expect(out).toContain('expected a preset');
    expect(out).toContain('no file and no library preset named "nowhere" (the library has: builtin, lighthouse)');
    expect(out).toContain('no such file: ./missing.json');
    expect(configs(r)).toEqual([{ preset: 'lighthouse' }, { preset: 'builtin' }, { preset: 'lighthouse' }]);
  });
});

describe("the preset's window cap (openai_max_context) is shown", () => {
  test('in the banner before the first answer, and when /preset switches to a preset that shrinks the window', async () => {
    const home = tmpHome('rp-core-repl-');
    importFile(home, LIGHTHOUSE_8K, { expect: 'preset' });
    const r = await rig(calls(), { home, config: { preset: 'lighthouse' }, windowOf: () => 16384 });
    r.type(`/preset ${DEFAULT_ST}`, '/preset builtin', `/preset ${DEFAULT_ST}`);
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out.split('\n')[0]).toEndWith('· ctx 8192');
    expect(out).toContain("preset → default \"Default\" (from the next turn; it caps the window at 4095 of the model's 16384 tokens)");
    expect(out).toContain('preset → builtin (from the next turn)');
  });
});

describe('/lore', () => {
  test('add a world info file, list it, test a text, remove it', async () => {
    const r = await rig(calls());
    r.type(`/lore add ${HARBOR}`, '/lore', '/lore test We walk up to the lighthouse.', '/lore add harbor', '/lore rm harbor', '/lore', '/lore rm harbor', '/lore rm @card');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain(`imported lorebook harbor from ${HARBOR}`);
    expect(out).toContain('lorebook harbor "Harbor" added: 3 entries (from the next turn)');
    expect(out).toContain('lorebooks, in the order a turn scans them:\n  harbor  "Harbor" · 3 entries (1 disabled)');
    expect(out).toContain('lore test: a reply to your text (nothing is sent)');
    expect(out).toContain('  ✓ "Gull Point lighthouse" harbor:0 · key · keys: lighthouse');
    expect(out).toMatch(/ {2}✗ "Evening fog" harbor:1 · no-key-match/);
    expect(out).toMatch(/ {2}✗ "The keeper" harbor:2 · disabled/);
    // Fired first, then the rest; then the totals with the budget.
    expect(out.indexOf('✓ "Gull Point lighthouse"')).toBeLessThan(out.indexOf('✗ "Evening fog"'));
    expect(out).toMatch(/1 of 3 fired · \d+ tok of lore · \d+ of \d+ budget tok/);
    expect(out).toContain('lorebook harbor is already in this session');
    expect(out).toContain('lorebook harbor removed (from the next turn; it stays in the library)');
    expect(out).toContain('no lorebooks: /lore add <id|file> adds one');
    expect(out).toContain('in the library, not in this session: harbor (/lore add <id>)');
    expect(out).toContain('/lore rm: harbor is not a lorebook of this session (it has none)');
    expect(out).toContain("/lore rm: @card is the card's own book");
    expect(configs(r)).toEqual([{ lorebooks: ['harbor'] }, { lorebooks: [] }]);
    // /lore test sends nothing and writes nothing but the config.
    expect(r.provider.requests).toHaveLength(0);
  });

  test("the card's embedded book is listed and tested with the session's books", async () => {
    const character = {
      name: 'Mira',
      description: 'A cartographer.',
      greetings: ['Hello.'],
      book: { name: 'Mira notes', entries: [{ id: 'm1', title: 'Maps', content: 'Mira draws maps of dreams.', keys: ['map'], position: 'before' as const }] },
    };
    const r = await rig(calls(), { character });
    r.type(`/lore add ${HARBOR}`, '/lore', '/lore test Show me the map of the lighthouse.');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('@card   the card\'s own book "Mira notes" · 1 entry');
    expect(out).toContain('✓ "Maps" @card:m1 · key · keys: map');
    expect(out).toContain('✓ "Gull Point lighthouse" harbor:0 · key · keys: lighthouse');
    expect(out).toContain('2 of 4 fired');
  });

  test('a changed copy of a world added again replaces it (same name): one Harbor is read, its entries fire once', async () => {
    // Regression: the re-import got a new id (harbor-2) and both books were scanned, so the old and
    // the new text of every entry went out together. SillyTavern world names are unique.
    const dir = tmpHome('rp-core-src-');
    const copy = join(dir, 'Harbor.json');
    writeFileSync(copy, readFileSync(HARBOR, 'utf8').replace('nine years', 'ten years'));
    const r = await rig(calls());
    r.type(`/lore add ${HARBOR}`, `/lore add ${copy}`, '/lore', '/lore test the lighthouse');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('imported lorebook harbor-2');
    expect(out).toContain('lorebook harbor-2 "Harbor" replaces harbor: same name, and a world is read once by name');
    expect(out).toContain('lorebooks, in the order a turn scans them:\n  harbor-2  "Harbor" · 3 entries (1 disabled)');
    expect(out).toContain('in the library, not in this session: harbor');
    expect(out.match(/✓ "Gull Point lighthouse"/g)).toHaveLength(1);
    expect(out).toContain('✓ "Gull Point lighthouse" harbor-2:0');
    expect(configs(r).at(-1)).toEqual({ lorebooks: ['harbor-2'] });
  });

  test('/lore test also says why a book was skipped (missing from the library)', async () => {
    // Regression: the notices were dropped, so a missing book read as "no key matched".
    const r = await rig(calls());
    r.type(`/lore add ${HARBOR}`);
    await r.until('added: 3 entries');
    rmSync(join(r.home, 'library', 'lorebooks', 'harbor.json'));
    r.type('/lore test the lighthouse');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toContain("The lorebook 'harbor' is skipped: it is not in the library. (lorebook_missing)");
  });

  test('/lore add refuses a preset; an unknown id lists the library', async () => {
    const r = await rig(calls());
    r.type(`/lore add ${PRESET}`, '/lore add atlantis');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toContain('expected a lorebook');
    expect(r.out()).toContain('no file and no library lorebook named "atlantis" (the library has no lorebooks yet)');
    expect(configs(r)).toEqual([]);
  });

  test('/lore add and /preset are refused while an answer is written; /lore test waits for it', async () => {
    const r = await rig(calls([{ text: 'Slow ' }, { pause: 'go' }, { text: 'answer.' }]), { interactive: true });
    r.type('Hello');
    await r.until('Mira › Slow');
    r.type(`/lore add ${HARBOR}`, '/preset builtin', '/lore test the lighthouse');
    await r.until('(runs when this answer ends)');
    expect(r.out()).toContain('refused [session_busy]: /lore changes the story while an answer is being written');
    expect(r.out()).toContain('refused [session_busy]: /preset changes the story');
    r.provider.release('go');
    await r.until('lore test: a reply to your text');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toContain('no lore entries to test');
    expect(configs(r)).toEqual([]);
  });
});

describe('/preview', () => {
  test('prints the messages the next turn sends: role, source, tokens and full text, then the settings', async () => {
    const r = await rig(calls([{ text: 'First answer.' }], [{ text: 'Second answer.' }]));
    r.type(`/lore add ${HARBOR}`, 'The lighthouse is dark tonight.', '/preview', '/r');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const at = out.indexOf('preview of a swipe');
    expect(at).toBeGreaterThan(0);
    const section = out.slice(at, out.indexOf('prefill:', at));
    // The swipe that followed sent exactly what the preview printed, in that order.
    const sent = r.provider.requests[1]!.messages;
    let from = 0;
    sent.forEach((m, i) => {
      const head = section.indexOf(`#${i + 1} ${m.role} · ${m.src} · `, from);
      expect(head).toBeGreaterThanOrEqual(from);
      const body = section.indexOf(promptText(m), head);
      expect(body).toBeGreaterThan(head);
      from = body;
    });
    expect(section).not.toContain(`#${sent.length + 1} `);
    expect(section).toContain('The Gull Point lighthouse has been dark for nine years.');
    expect(out).toMatch(/preview of a swipe \(a new answer to [0-9a-f]{8}\) · script:default\n {2}window 8192 · reserve \d+ · prompt ~\d+ tok/);
    expect(out).toMatch(/prefill: none · max tokens \d+ · samplers: /);
    expect(out).toContain('tools: none');
    expect(out).toContain('  ✓ "Gull Point lighthouse" harbor:0 (key)');
    // The preview itself was not sent.
    expect(r.provider.requests).toHaveLength(2);
  });

  test('a past answer by its /show number or id; a greeting, your own message and --wire on a script', async () => {
    const r = await rig(calls([{ text: 'An answer.' }]));
    r.type('Hello', '/preview 3', '/preview 1', '/preview 2', '/preview --wire', '/preview 9');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const answer = r.session.view().path[2]!.id;
    expect(out).toContain(`preview of a reply to ${r.session.view().path[1]!.id} · script:default`);
    expect(out).toContain('/preview: message 1 is a greeting; it was not generated');
    expect(out).toContain('/preview: message 2 is yours');
    expect(out).toContain('(no wire form: this connection is an in-process provider; the messages follow)');
    expect(out).toContain('there is no message 9');
    expect(answer).toMatch(/^[0-9a-f]{8}$/);
  });

  test('/preview <id prefix> of an answer', async () => {
    const r = await rig(calls([{ text: 'An answer.' }]));
    r.type('Hello');
    await r.until('Mira › An answer.');
    const answer = r.session.view().path.at(-1) as MessageView;
    r.type(`/preview ${answer.id.slice(0, 6)}`, '/preview ffffffffff');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toContain(`preview of a reply to ${answer.parent} · script:default`);
    expect(r.out()).toContain('/preview: no message');
  });
});

describe('/trace', () => {
  test('lists the lore that fired, with why and the budget', async () => {
    const r = await rig(calls([{ text: 'It is.' }]));
    r.type(`/lore add ${HARBOR}`, 'Is the lighthouse dark?', '/trace');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toMatch(/ {2}lore fired: 1 · budget \d+ tok\n {4}✓ "Gull Point lighthouse" harbor:0 \(key\)/);
    expect(systemText(r, 0)).toContain('The Gull Point lighthouse has been dark for nine years.');
  });
});
