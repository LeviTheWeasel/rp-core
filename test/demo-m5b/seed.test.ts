// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// tools/fixtures/seed-innkeeper.ts --compendium off|on (M5b, D-182): the seeded 199-message chat opens
// with its Compendium off by default, so it does not start with 98 answers to file in the background;
// `--compendium on` keeps it on, and the answers wait for the chat (seeding itself starts no task).
// The tool is spawned as a person runs it (bun, a fresh --home); the session is then read with an
// in-process engine (lane 'manual', test/preload.ts) and from its journal.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Engine } from '../../src/engine/engine.ts';
import type { MemoryStatus } from '../../src/engine/api.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { ROOT } from '../cli/kit.ts';
import { innkeeperConnection } from '../fixtures/ru/innkeeper-200/load.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';

const TOOL = join(ROOT, 'tools', 'fixtures', 'seed-innkeeper.ts');

interface Seeded {
  home: string;
  code: number;
  stdout: string;
  stderr: string;
  id: string;
}

async function seedTool(args: string[]): Promise<Seeded> {
  const home = tmpHome('rp-core-seed-');
  const p = Bun.spawn([process.execPath, TOOL, '--home', home, ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { home, code, stdout, stderr, id: /^session (s_[0-9a-f]{8}) /.exec(stdout)?.[1] ?? '' };
}

/** The lane's status and the enabled flag as the engine reads the seeded session. */
async function opened(s: Seeded): Promise<{ status: MemoryStatus; enabled: boolean | undefined }> {
  const engine = await Engine.open({ home: s.home, connections: { innkeeper: innkeeperConnection() }, clock: fakeClock(), random: fakeRandom(9), timeZone: 'UTC' });
  try {
    const session = engine.session(s.id);
    const out = { status: session.memoryStatus(), enabled: session.header().config.compendium?.enabled };
    await session.close();
    return out;
  } finally {
    await engine.close();
  }
}

const jobRows = (s: Seeded) => readSessionFile(s.home, s.id).entries.filter((e) => e.t === 'job');

let off: Seeded;
let on: Seeded;

beforeAll(async () => {
  [off, on] = await Promise.all([seedTool([]), seedTool(['--compendium', 'on'])]);
}, 30_000);

describe('seed-innkeeper --compendium (D-182)', () => {
  test('default off: the session is created with the Compendium off, so nothing waits to be filed', async () => {
    expect(off.code).toBe(0);
    expect(off.stderr).toBe('');
    expect(off.stdout).toContain(`session ${off.id} · «Сонный гусь» · 199 messages · home ${off.home}\n`);
    expect(off.stdout).toContain('compendium: off · /memory on in the chat turns it on from then (the seeded answers are not filed)\n');
    expect(readSessionFile(off.home, off.id).header.config.compendium).toEqual({ enabled: false });
    const { status, enabled } = await opened(off);
    expect(enabled).toBe(false);
    expect(status).toEqual({ queued: [], parked: [], backlog: 0 });
    expect(jobRows(off)).toEqual([]);
  });

  test('on: the Compendium stays on; seeding began no task, the chat finds the 98 accepted answers to file (and a historian check)', async () => {
    expect(on.code).toBe(0);
    expect(on.stderr).toBe('');
    expect(on.stdout).toContain('compendium: on · the chat files the seeded answers in the background when it opens (/memory status shows the queue)\n');
    const { status, enabled } = await opened(on);
    expect(enabled).toBe(true);
    // 99 answers: every one but the last has the player's next message after it (filing.wait 1); after
    // their filing tasks, one historian check (the path is long past historian.interval).
    expect(status.backlog).toBe(98);
    expect(status.queued.map((q) => q.task)).toEqual([...Array<'file'>(98).fill('file'), 'hist']);
    expect(status.running).toBeUndefined();
    expect(jobRows(on)).toEqual([]);
  });

  test('a value other than off or on is a usage error (exit 64), and nothing is written', async () => {
    const bad = await seedTool(['--compendium', 'yes']);
    expect(bad.code).toBe(64);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toStartWith('--compendium must be off or on\nusage: bun tools/fixtures/seed-innkeeper.ts ');
    expect(bad.stderr).toContain('[--compendium off|on]');
  });
});
