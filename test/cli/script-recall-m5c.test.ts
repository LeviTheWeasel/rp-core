// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c, the lead's ruling K (sched#4): `rp-core chat --provider script:<file>` with RP_CORE_RECALL unset, as
// a person runs it. A script that tags no line `"agent": "recall"` (every script written before recall)
// makes recall's default lexical: no recall call takes the narrator's untagged lines, and /memory mode
// says why. A script with a recall line keeps the default (auto: sync on a script's remote origin).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, run, type RunResult } from './kit.ts';
import { tmpHome } from '../helpers.ts';

const LANTERN = join(ROOT, 'test', 'fixtures', 'ru', 'lantern', 'lantern.compendium.json');
const CARD = join(ROOT, 'test', 'demo-m5a', 'card.json');
/** The preload's RP_CORE_RECALL=lexical removed; the lane manual (nothing prefetches); no colour. */
const ENV = { RP_CORE_RECALL: undefined, RP_CORE_LANE: 'manual', NO_COLOR: '1' };
const TYPED = ['/memory mode', '— Кто ждёт у причала?', '/trace', '/quit'];

let home: string;

async function cli(args: string[], stdin?: string): Promise<RunResult> {
  return run(['--home', home, ...args], { env: ENV, ...(stdin !== undefined ? { stdin } : {}) });
}

/** A chat on a new session reading the lantern book, played by `lines` (a script file). */
async function chat(name: string, lines: string[]): Promise<RunResult> {
  const id = (await cli(['new', '--card', CARD, '--lore', 'lantern', '--no-chat'])).stdout.trim();
  const file = join(home, name);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return cli(['chat', id, '--provider', `script:${file}`], `${TYPED.join('\n')}\n`);
}

beforeAll(async () => {
  home = tmpHome('rp-core-script-recall-');
  expect((await cli(['import', LANTERN])).code).toBe(0);
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('--provider script: and recall, RP_CORE_RECALL unset', () => {
  test('no recall line: recall is lexical (no call), the narrator gets its line, /memory mode says why', async () => {
    const r = await chat('old.jsonl', ['{"caps": {"contextLength": 4096}}', '[{"text": "Ночь тиха, Ян ждёт у причала."}]']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('recall mode: lexical (the --provider script tags no line "agent": "recall")');
    expect(r.stdout).toContain('Ночь тиха, Ян ждёт у причала.');
    expect(r.stdout).not.toContain('⋯ recall:');
    expect(r.stdout).toContain('  recall: lexical (no recall call; the selector picked alone)');
  }, 30_000);

  test('a recall line: the default stays auto, and recall (sync on a remote script origin) takes its own line', async () => {
    const r = await chat('tagged.jsonl', [
      '{"caps": {"contextLength": 4096}}',
      '{"agent": "narrator", "steps": [{"text": "Ночь тиха, Ян ждёт у причала."}]}',
      '{"agent": "recall", "steps": [{"text": "{\\"entry_ids\\": []}"}]}',
    ]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('recall mode: auto (the default)');
    expect(r.stdout).toContain("here: sync (the recall model's server is not local)");
    expect(r.stdout).toContain('Ночь тиха, Ян ждёт у причала.');
    expect(r.stdout).toMatch(/\n {2}recall: sync · nothing picked · 1 call \d+\.\ds\n/);
  }, 30_000);
});
