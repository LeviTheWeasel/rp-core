// The M2 final fix, REPL side: /trace recomputes the verdicts of the answer it shows (D-45), /preview
// takes --verdicts, /preview --wire keeps the notices, the banner and /preset name the window a preset
// caps and take it from the --provider override's connection, and a piped script or replay that
// stops says why in the words of what it plays.
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importFile } from '../../src/formats/import.ts';
import { tmpHome } from '../helpers.ts';
import { calls, replRig, type ReplRig, type ReplRigOptions } from './kit.ts';
import type { ScriptCall } from '../../src/providers/scripted.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'cli-m2');
const HARBOR = join(FIXTURES, 'Harbor.json');
const LIGHTHOUSE_8K = join(FIXTURES, 'Lighthouse.json'); // openai_max_context 8192

async function rig(script: ScriptCall[], o: ReplRigOptions = {}): Promise<ReplRig> {
  return replRig(script, o);
}

/** Harbor plus an entry that matches but never wins its roll (probability 0): a miss with a reason of its own. */
function stormyHarbor(): string {
  const dir = tmpHome('rp-core-src-');
  const world = JSON.parse(readFileSync(HARBOR, 'utf8')) as { entries: Record<string, Record<string, unknown>> };
  world.entries['3'] = { ...world.entries['0']!, uid: 3, comment: 'Storm', content: 'A storm brews over the bay.', probability: 0 };
  const file = join(dir, 'Harbor.json');
  writeFileSync(file, JSON.stringify(world, null, 2));
  return file;
}

describe('/trace recomputes the lore verdicts of the answer it shows [D-45]', () => {
  test('after the stored lines: a miss with its own reason on a line, the no-key-match and disabled ones as one count', async () => {
    const r = await rig(calls([{ text: 'It is.' }]));
    r.type(`/lore add ${stormyHarbor()}`, 'Is the lighthouse dark?', '/trace');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const at = out.indexOf('trace of ');
    const trace = out.slice(at);
    expect(trace).toMatch(/ {2}lore fired: 1 · budget \d+ tok\n {4}✓ "Gull Point lighthouse" harbor:0 \(key\)\n {2}lore not fired \(recomputed from its seed\):\n/);
    expect(trace).toContain('    ✗ "Storm" harbor:3 · chance · keys: lighthouse\n');
    expect(trace).toContain('    ✗ 2 more: no-key-match 1, disabled 1');
    // The rebuild matches what was sent: no notice.
    expect(trace).not.toContain('preview_inputs_changed');
    // Nothing was sent for it.
    expect(r.provider.requests).toHaveLength(1);
  });

  test("the rebuild's preview_inputs_changed notice follows when today's inputs differ", async () => {
    const r = await rig(calls([{ text: 'It is.' }]));
    r.type(`/lore add ${HARBOR}`, 'Is the lighthouse dark?', '/note Be grim.', '/trace');
    r.end();
    expect(await r.done).toBe(0);
    const trace = r.out().slice(r.out().indexOf('trace of '));
    expect(trace).toContain('    ✗ 2 entries: no-key-match 1, disabled 1');
    expect(trace).toMatch(/ {2}! Since this answer was written, the author's note or other in-chat inserts changed: .*\(preview_inputs_changed\)/);
  });
});

describe('/preview --verdicts', () => {
  test('the next turn and a past answer, with every entry printed as /lore test prints it', async () => {
    const r = await rig(calls([{ text: 'It is.' }]));
    r.type(`/lore add ${HARBOR}`, 'Is the lighthouse dark?', '/preview 3 --verdicts', '/preview --verdicts');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out.split('lore verdicts:\n').length - 1).toBe(2);
    expect(out).toContain('  ✓ "Gull Point lighthouse" harbor:0 · key · keys: lighthouse · ');
    expect(out).toMatch(/ {2}✗ "The keeper" harbor:2 · disabled/);
    expect(out).toMatch(/1 of 3 fired · \d+ tok of lore · \d+ of \d+ budget tok/);
    expect(r.provider.requests).toHaveLength(1);
  });
});

describe('/preview --wire keeps the notices', () => {
  test("after the body: a past answer's preview_inputs_changed, a skipped book's notice", async () => {
    const r = await rig(calls([{ text: 'It is.' }]), { wire: true, config: { lorebooks: ['gone'] } });
    r.type('Is the lighthouse dark?', '/note Be grim.', '/preview 3 --wire');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const at = out.indexOf('POST http://127.0.0.1:9/v1/chat/completions');
    expect(at).toBeGreaterThan(0);
    const after = out.slice(at);
    expect(after).toContain('"max_tokens"');
    expect(after).toMatch(/\n! Since this answer was written, the author's note or other in-chat inserts changed: .*\(preview_inputs_changed\)/);
    expect(after).toContain("The lorebook 'gone' is skipped");
    expect(after.indexOf('"max_tokens"')).toBeLessThan(after.indexOf('preview_inputs_changed'));
  });
});

describe("the window a preset caps, and the override's window", () => {
  test("the model's window unknown: the banner says ctx ≤N and bare /preset names the cap", async () => {
    const home = tmpHome('rp-core-repl-');
    importFile(home, LIGHTHOUSE_8K, { expect: 'preset' });
    const r = await rig(calls(), { home, config: { preset: 'lighthouse' } });
    r.type('/preset');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out.split('\n')[0]).toEndWith('· ctx ≤8192');
    expect(out).toContain('preset: lighthouse · it caps the window at 8192 tokens\n');
  });

  test("bare /preset names the cap against the model's window when it shrinks it, and not when it does not", async () => {
    const home = tmpHome('rp-core-repl-');
    importFile(home, LIGHTHOUSE_8K, { expect: 'preset' });
    const small = await rig(calls(), { home, config: { preset: 'lighthouse' }, windowOf: () => 4096 });
    small.type('/preset');
    small.end();
    expect(await small.done).toBe(0);
    expect(small.out()).toContain('preset: lighthouse\n');
    const big = await rig(calls(), { home, config: { preset: 'lighthouse' }, windowOf: () => 32768 });
    big.type('/preset');
    big.end();
    expect(await big.done).toBe(0);
    expect(big.out()).toContain("preset: lighthouse · it caps the window at 8192 of the model's 32768 tokens\n");
  });

  test('under --provider script:/replay: the banner takes the window of the connection every turn runs on', async () => {
    // config.toml's connection says 32768; the override (SCRIPT_CAPS) says 8192, and turns use 8192.
    const plain = await rig(calls(), { windowOf: () => 32768 });
    plain.end();
    await plain.done;
    expect(plain.out().split('\n')[0]).toEndWith('· ctx 32768');
    const o = await rig(calls(), { windowOf: () => 32768, deps: { override: { conn: 'script', plays: 'script', windowOf: () => 8192 } } });
    o.type('/preset');
    o.end();
    await o.done;
    expect(o.out().split('\n')[0]).toEndWith('· ctx 8192');
  });
});

describe('a piped script or replay that stops says why in its own words', () => {
  const stops = async (plays: 'script' | 'recording'): Promise<{ code: number; out: string }> => {
    const r = await rig(calls([{ text: 'One.' }]), { deps: { failExit: true, override: { conn: 'script', plays, windowOf: () => 8192 } } });
    r.type('Hello', 'Again', 'More');
    r.end();
    return { code: await r.done, out: r.out() };
  };

  test('a script that ran out of calls is not "a recording that no longer matches"', async () => {
    const s = await stops('script');
    expect(s.code).toBe(3);
    expect(s.out).toContain('(stopped: the script ran out of calls (script_exhausted); the rest of the input is not run)');
    expect(s.out).not.toContain('no longer matches');
    const rec = await stops('recording');
    expect(rec.out).toContain('(stopped: the recording ran out of calls (script_exhausted); the rest of the input is not run)');
  });
});

