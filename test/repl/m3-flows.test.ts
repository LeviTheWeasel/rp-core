// M3 REPL flows over the scripted provider (§12.4, decisions F6 and H): /memory add → list → show →
// edit → retire → restore with the journal rows they write, /search and its next page, the banner's
// tools word per caps, tool rounds as side lines and in /trace (native and prompted), /preview with the
// core block, the 'tools: off (prefill)' status item, and /probe --active where it cannot run.
import { afterAll, describe, expect, test } from 'bun:test';
import { BUILTIN_PRESET, type Preset } from '../../src/formats/native.ts';
import { SCRIPT_CAPS, type ScriptCall } from '../../src/providers/scripted.ts';
import type { ModelCaps } from '../../src/providers/types.ts';
import type { MemEntry } from '../../src/session/entries.ts';
import { writeLibrary } from '../engine-m2/kit.ts';
import { tmpHome } from '../helpers.ts';
import { calls, entriesOf, replRig, type ReplRig, type ReplRigOptions } from './kit.ts';

const rigs: ReplRig[] = [];
async function rig(script: ScriptCall[], o: ReplRigOptions = {}): Promise<ReplRig> {
  const r = await replRig(script, o);
  rigs.push(r);
  return r;
}
afterAll(async () => {
  for (const r of rigs) await r.engine.close().catch(() => {});
});

const capsWith = (tools: ModelCaps['tools']): ModelCaps => ({ ...SCRIPT_CAPS, tools });

/** The human mem rows of a session, as written. */
const memRows = (r: ReplRig): MemEntry[] => entriesOf(r.home, r.session.id).filter((e): e is MemEntry => e.t === 'mem');

/**
 * A session whose history cannot fit its window, so a turn offers search_history and read_history
 * (D-92): a small window and many long messages of the player's.
 */
function longHistory(r: ReplRig, n = 40): void {
  for (let i = 1; i <= n; i++) {
    const filler = ' The road goes on through the dunes and the wind keeps blowing sand into every pack and every boot.'.repeat(3);
    // Only day 3 mentions the caravan: one short hit, so the search leaves tool room for the answer.
    r.session.send({ text: `Day ${i}: ${i === 3 ? 'the caravan moves on.' : 'we walk on.'}${filler}`, expectedVersion: r.session.version() });
  }
}
// A tool room (a quarter of window − reserve) that one search result does not use up.
const SMALL_WINDOW = { window: 3000, roles: { narrator: { conn: 'script', model: 'default', maxTokens: 64 } } } as const;

describe('/memory', () => {
  test('add → list → show → edit → retire → restore: one line each, one human mem row per change', async () => {
    const r = await rig(calls());
    const v0 = r.session.version();
    r.type(
      '/memory',
      "/memory add Brother | Yan, brother | Mira's brother Yan sails the north road.",
      '/memory add Lamp | | The lamp in the window never goes out.',
      '/memory',
      '/memory show C1',
      '/memory edit C1 Big brother | | He came back in spring.',
      '/memory show big brother',
      '/memory retire C2 it went out at last',
      '/memory',
      '/memory restore Lamp',
      '/memory show C2',
    );
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('nothing in the Compendium on this path yet: /memory new <type> [name] files an entry, /memory add <title> | <keys> | <text> writes a note');
    expect(out).toContain('note C1 "Brother" added (note:brother): from the next turn it is sent when Yan or brother comes up');
    expect(out).toContain('note C2 "Lamp" added (note:lamp): from the next turn it is sent when Lamp comes up');
    expect(out).toContain(
      [
        'The Compendium of this path: 2 live · /memory show <ref> prints one',
        'Notes (2)',
        "  C1 Brother — Mira's brother Yan sails the north road. · keys: Yan, brother [40]",
        '  C2 Lamp — The lamp in the window never goes out. · keys: Lamp [38]',
      ].join('\n'),
    );
    expect(out).toMatch(/C1 Brother · note:brother\n {2}keys: Yan, brother\n {2}written by you at journal row \d+\n {2}sent when one of its keys comes up in the last 4 messages, as:\n {4}\[Memory: Brother\]\n {4}Mira's brother Yan sails the north road\./);
    // A confirmation names the note by its handle and its (new) title.
    expect(out).toContain('note C1 "Big brother" changed: title, text (from the next turn)');
    // Looked up by its new title; its key stays.
    expect(out).toMatch(/C1 Big brother · note:brother\n {2}keys: Yan, brother\n {2}written by you at journal row \d+; last changed at row \d+/);
    expect(out).toContain('    [Memory: Big brother]\n    He came back in spring.');
    expect(out).toContain('note C2 "Lamp" retired: it no longer fires (/memory restore C2 brings it back)');
    // M5a: a retired entry is counted, and listed with --retired.
    expect(out).toContain('The Compendium of this path: 1 live, 1 retired (/memory list --retired shows them) · /memory show <ref> prints one');
    expect(out).toContain('note C2 "Lamp" restored: it fires again from the next turn');
    expect(out).toMatch(/C2 Lamp · note:lamp\n {2}keys: Lamp\n {2}written by you at journal row \d+; last changed at row \d+\n {2}sent when/);

    const rows = memRows(r);
    expect(rows.map((m) => m.ops.map((o) => o.op))).toEqual([['note'], ['note'], ['edit'], ['retire'], ['restore']]);
    expect(rows.every((m) => m.by === 'user' && m.key === null && m.on === null)).toBe(true);
    expect(rows[0]!.ops[0]).toEqual({ op: 'note', title: 'Brother', keys: ['Yan', 'brother'], content: "Mira's brother Yan sails the north road." });
    expect(rows[1]!.ops[0]).toEqual({ op: 'note', title: 'Lamp', keys: ['Lamp'], content: 'The lamp in the window never goes out.' });
    expect(rows[2]!.ops[0]).toEqual({ op: 'edit', ref: 'note:brother', set: { title: 'Big brother', content: 'He came back in spring.' } });
    expect(rows[3]!.ops[0]).toEqual({ op: 'retire', ref: 'note:lamp', reason: 'it went out at last' });
    expect(rows[4]!.ops[0]).toEqual({ op: 'restore', ref: 'note:lamp' });
    // Notes never move the version (§5.8): the story did not change.
    expect(r.session.version()).toBe(v0);
  });

  test('a note fires when its key comes up: the request carries it, /trace names it by its title', async () => {
    const r = await rig(calls([{ text: 'He is at sea.' }]));
    r.type("/memory add Brother | Yan | Mira's brother Yan sails the north road.", 'Have you heard from Yan?', '/trace');
    r.end();
    expect(await r.done).toBe(0);
    const sent = r.provider.requests[0]!.messages.map((m) => m.blocks.map((b) => (b.k === 'text' ? b.text : '')).join('')).join('\n');
    expect(sent).toContain("[Memory: Brother]\nMira's brother Yan sails the north road.");
    expect(r.out()).toContain('    ✓ "Brother" @notes:note:brother (key)');
  });

  test('errors are one line each and write nothing', async () => {
    const r = await rig(calls());
    r.type(
      '/memory add Brother | | Yan.',
      '/memory show C9',
      '/memory edit C9 New |',
      '/memory restore C1',
      '/memory retire C1',
      '/memory retire C1',
      '/memory add !!! | | text',
      '/memory edit C1 | | x',
      '/memory add Two words',
    );
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    // M5a: every entry is looked up the same way (the engine's words).
    expect(out).toContain('/memory show: no single entry matches "C9" (use its C<n> handle or key)\n');
    expect(out).toContain('/memory edit: no single entry matches "C9" (use its C<n> handle or key)\n');
    expect(out).toContain('/memory restore: "Brother" is not retired; nothing changed\n');
    expect(out).toContain('note C1 "Brother" retired');
    expect(out).toContain('/memory retire: "Brother" is already retired\n');
    expect(out).toContain('/memory add: a note title needs at least one letter or digit\n');
    // A retired note can still be edited by its handle.
    expect(out).toContain('note C1 "Brother" changed: text (from the next turn)');
    expect(out).toContain('usage: /memory add <title> | <keys> | <text>');
    expect(out).not.toContain('    at ');
    expect(memRows(r).map((m) => m.ops[0]!.op)).toEqual(['note', 'retire', 'edit']);
  });

  test('a change during an answer is refused (session_busy); /memory itself waits for the answer', async () => {
    const r = await rig(calls([{ text: 'Part ' }, { pause: 'p' }, { text: 'done.' }]), { interactive: true });
    r.type('Go');
    await r.until('Mira › Part');
    r.type('/memory add Brother | | Yan.', '/memory');
    await r.until('(runs when this answer ends)');
    expect(r.out()).toContain('refused [session_busy]: /memory changes the story while an answer is being written');
    r.provider.release('p');
    await r.until('nothing in the Compendium on this path yet');
    r.type('/quit');
    expect(await r.done).toBe(0);
    expect(memRows(r)).toEqual([]);
  });
});

describe('/search', () => {
  test('the hits as the narrator\'s tool gives them, newest first, then the next page; misses and errors', async () => {
    const r = await rig(calls());
    for (let i = 1; i <= 12; i++) r.session.send({ text: `Message ${i}: the caravan moves on.`, expectedVersion: r.session.version() });
    r.session.send({ text: 'Nothing about it here.', expectedVersion: r.session.version() });
    r.type('/search caravan', '/search caravan before=4', '/search dragon', '/search', '/search caravan before=0');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    // #1 is the greeting; the player's messages are #2..#14.
    const first = Array.from({ length: 10 }, (_, k) => `#${13 - k} Levi: Message ${12 - k}: the caravan moves on.`);
    expect(out).toContain(`${first.join('\n')}\n(older matches: /search caravan before=4)\n`);
    expect(out).toContain('#3 Levi: Message 2: the caravan moves on.\n#2 Levi: Message 1: the caravan moves on.\n');
    expect(out).not.toContain('/search caravan before=2');
    expect(out).toContain('no messages match\n');
    expect(out).toContain('/search needs words to look for');
    expect(out).toContain('/search: before= takes a message number (the #n of a hit), got "0"');
    expect(out).not.toContain('#14 Levi');
  });
});

describe('banner', () => {
  test('(tools: native|prompted|off) from the narrator route\'s caps', async () => {
    for (const [tools, word] of [
      ['native', 'native'],
      ['prompted', 'prompted'],
      ['none', 'off'],
    ] as const) {
      const r = await rig(calls(), { caps: capsWith(tools) });
      r.end();
      expect(await r.done).toBe(0);
      expect(r.out().split('\n')[0]).toBe(`session ${r.session.id} · Mira · narrator script:default (tools: ${word}) · ctx ?`);
    }
  });

  test('under --provider the override connection\'s caps speak', async () => {
    const r = await rig(calls(), {
      deps: { override: { conn: 'script', plays: 'script', windowOf: () => 8192, capsOf: () => capsWith('prompted') } },
    });
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out().split('\n')[0]).toBe(`session ${r.session.id} · Mira · narrator script:default (tools: prompted) · ctx 8192`);
  });
});

describe('tool rounds in the chat', () => {
  test('native: search_history runs as a side line, the answer follows, /trace shows the rounds and the call', async () => {
    const r = await rig(
      calls([{ tool: { name: 'search_history', args: { query: 'caravan' } } }], [{ text: 'The caravan left at dawn.' }]),
      { caps: capsWith('native'), config: SMALL_WINDOW },
    );
    longHistory(r);
    r.type('Where did the caravan go?', '/trace');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toMatch(/\n {2}⋯ search_history "caravan" → [^\n]+\nMira › The caravan left at dawn\.\n {2}\[swipe 1\/1 · /);
    expect(r.provider.requests).toHaveLength(2);
    expect(out).toMatch(/\n {2}rounds: 2 · native tools · ended: answer · tool room \d+ of \d+ tok used\n {2}tool calls: 1\n {4}round 0 · search_history · ok · \d+ chars\n/);
  });

  test('prompted: the call markup never shows; the side line and the answer do', async () => {
    const r = await rig(
      calls([{ text: '<tool_call>{"name": "search_history", "args": {"query": "caravan"}}</tool_call>' }], [{ text: 'The caravan left at dawn.' }]),
      { caps: capsWith('prompted'), config: SMALL_WINDOW },
    );
    longHistory(r);
    r.type('Where did the caravan go?', '/trace');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).not.toContain('<tool_call>');
    expect(out).toMatch(/ {2}⋯ search_history "caravan" → [^\n]+\nMira › The caravan left at dawn\./);
    expect(out).toMatch(/ {2}rounds: 2 · prompted tools · ended: answer · /);
    expect(out).toMatch(/ {4}round 0 · search_history · ok · \d+ chars/);
  });

  test('/preview shows the core block like any message and the tools with their transport', async () => {
    const r = await rig(calls(), { caps: capsWith('native'), config: SMALL_WINDOW });
    longHistory(r);
    r.type('/preview');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toMatch(/#\d+ system · core:tools · \d+ tok\n/);
    expect(out).toMatch(/\ntools: read_history, search_history \(native\)\n/);
  });

  test("a note that did not fire offers the lore tools; the preset's prefill turns them off: 'tools: off (prefill)'", async () => {
    const home = tmpHome('rp-core-repl-');
    const preset: Preset = { ...(JSON.parse(JSON.stringify(BUILTIN_PRESET)) as Preset), name: 'prefilled', prefill: '*Mira' };
    writeLibrary(home, 'presets', 'prefilled', preset);
    const r = await rig(calls([{ text: ' smiles.*' }], [{ text: 'Again.' }]), { home, caps: capsWith('native'), config: { preset: 'prefilled' } });
    r.type('/memory add Brother | Yan | Mira\'s brother Yan sails the north road.', 'Hello there.', '/preset builtin', 'And now?');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toMatch(/\[swipe 1\/1 · [^\]]*· tools: off \(prefill\)\]/);
    expect(out).toContain('(prefill_disables_tools)');
    expect(r.provider.requests[0]!.tools ?? []).toEqual([]);
    // Without the prefill the same turn offers the lore tools, and the status says nothing about them.
    expect((r.provider.requests[1]!.tools ?? []).map((t) => t.name)).toEqual(['read_lore', 'search_lore']);
    expect(out.match(/tools: off \(prefill\)/g)).toHaveLength(1);
  });
});

describe('/probe --active where it cannot run', () => {
  test('under --provider it says to probe from the shell; without a probe runner too', async () => {
    const r = await rig(calls(), { deps: { override: { conn: 'script', plays: 'recording', windowOf: () => null } } });
    r.type('/probe --active');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toContain('/probe --active: this chat plays a recording (--provider); probe from the shell: rp-core probe <connection>:<model> --active');

    const bare = await rig(calls());
    bare.type('/probe --active --write', '/probe');
    bare.end();
    expect(await bare.done).toBe(0);
    expect(bare.out()).toContain('/probe --active is not available in this chat; from the shell: rp-core probe <connection>:<model> --active');
    expect(bare.out()).toContain("/probe --active [--write] also tests the narrator's model here");
  });

  test('with a runner: the narrator binding is the target, the report is printed, --write says when it applies', async () => {
    const seen: { target: string; write: boolean }[] = [];
    const r = await rig(calls(), {
      deps: {
        probe: async (p) => {
          seen.push({ target: p.target, write: p.write });
          p.io.out.write('script\n  active probes (4 calls):\n  probe facts: tools native\n');
          return { code: 0, written: p.write };
        },
      },
    });
    r.type('/probe --active', '/probe --active --write');
    r.end();
    expect(await r.done).toBe(0);
    expect(seen).toEqual([
      { target: 'script:default', write: false },
      { target: 'script:default', write: true },
    ]);
    const out = r.out();
    expect(out).toContain(
      'probing script:default: a few short calls (at most 6, replies of 96 to 1024 tokens; Ctrl+C stops)…\nscript\n  active probes (4 calls):\n  probe facts: tools native\n',
    );
    expect(out.match(/the stored facts apply from the next rp-core chat/g)).toHaveLength(1);
  });

  test('--write that stored nothing does not say the stored facts apply (review fix)', async () => {
    const r = await rig(calls(), {
      deps: {
        probe: async (p) => {
          p.io.out.write('  probe facts: none (nothing conclusive)\n  not stored: the server told nothing worth keeping (kind unknown, no limits)\n');
          return { code: 0, written: false };
        },
      },
    });
    r.type('/probe --active --write');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toContain('not stored: the server told nothing worth keeping');
    expect(r.out()).not.toContain('stored facts apply');
  });

  test('Ctrl+C stops a probe that waits on a silent server: one press, nothing stored, the chat goes on (review fix)', async () => {
    let signal: AbortSignal | undefined;
    const r = await rig(calls([{ text: 'Still here.' }]), {
      deps: {
        // A probe that only ends when it is stopped, as cmdProbe does against a server that never answers.
        probe: (p) =>
          new Promise((_, reject) => {
            signal = p.signal;
            p.signal.addEventListener('abort', () => reject(p.signal.reason));
          }),
      },
    });
    r.type('/probe --active --write');
    await r.until('Ctrl+C stops)…');
    r.interrupt();
    await r.until('(probe stopped; nothing stored)');
    expect(signal?.aborted).toBe(true);
    r.type('Are you there?');
    r.end();
    const settled = await Promise.race([r.done, Bun.sleep(3000).then(() => 'still running')]);
    expect(settled).toBe(0);
    const out = r.out();
    expect(out).not.toContain('press Ctrl+C again');
    expect(out).not.toContain('stored facts apply');
    expect(out).toContain('Still here.');
  });
});

describe('model_not_found names the binding and the way out (review fix)', () => {
  test('the failed answer is followed by one dim hint with the narrator binding, rp-core models and /model', async () => {
    const r = await rig(calls([{ error: { code: 'model_not_found', status: 404 } }]));
    r.type('Hello?');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('✗ the answer failed (request/model_not_found)');
    expect(out).toContain(
      '  (the narrator is script:default: rp-core models script lists what the server has; /model narrator script:<model> switches this chat (config.toml [roles] only sets new sessions))',
    );
  });

  test('not under --provider (the script is not the binding), and not for other failures', async () => {
    const played = await rig(calls([{ error: { code: 'model_not_found', status: 404 } }]), { deps: { override: { conn: 'script', plays: 'script', windowOf: () => null } } });
    played.type('Hello?');
    played.end();
    await played.done;
    expect(played.out()).toContain('request/model_not_found');
    expect(played.out()).not.toContain('the narrator is');
    const other = await rig(calls([{ error: { code: 'bad_request', status: 400 } }]));
    other.type('Hello?');
    other.end();
    await other.done;
    expect(other.out()).not.toContain('the narrator is');
  });
});
