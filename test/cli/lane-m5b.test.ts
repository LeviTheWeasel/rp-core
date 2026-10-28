// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5b (.notes/m5b-decisions.md, the lead's ruling H): one-shot commands — `rp-core send`, `preview`,
// `compact`, `new` without its chat — open the engine with the lane 'manual', so they never begin a
// Compendium task they cannot finish (close() would abort it and leave a begin row for the next open).
// The control: the same steps on an engine whose lane is 'auto' do begin one.
import { describe, expect, test } from 'bun:test';
import { cmdCompact } from '../../src/cli/compact.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { runSend } from '../../src/cli/oneshot.ts';
import { cmdPreview } from '../../src/cli/preview.ts';
import { loadRuntime } from '../../src/cli/runtime.ts';
import type { Connection, EngineOptions } from '../../src/engine/api.ts';
import { Engine } from '../../src/engine/engine.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall, type ScriptedProvider } from '../../src/providers/scripted.ts';
import type { JobEntry } from '../../src/session/entries.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { LEVI, MIRA } from '../repl/kit.ts';

/** The lane would begin at once: every answer accepted when it is committed, no idle wait, a remote origin (script:). */
const CONFIG = { roles: { narrator: { conn: 'script', model: 'm' } }, compendium: { enabled: true, filing: { wait: 0 }, idleDelaySec: 0 } };
const seams = (): Partial<EngineOptions> => ({ clock: fakeClock(), random: fakeRandom(3), timeZone: 'UTC' });

function scripted(script: ScriptCall[]): { conn: Connection; provider: ScriptedProvider } {
  const provider = createScriptedProvider(script);
  return { conn: { id: 'script', provider, caps: SCRIPT_CAPS, origin: 'script:lane-m5b', local: true }, provider };
}

const jobRows = (home: string, id: string): JobEntry[] => readSessionFile(home, id).entries.filter((e): e is JobEntry => e.t === 'job');

/** A closed session; with `answered`, one exchange already in it (its answer accepted, not filed). */
async function sessionIn(home: string, answered: boolean): Promise<string> {
  const { conn } = scripted([{ steps: [{ text: 'Фрол кивнул.' }] }]);
  const e = await Engine.open({ home, connections: { script: conn }, ...seams(), lane: 'manual' });
  const s = e.createSession({ character: MIRA, persona: LEVI, config: CONFIG });
  if (answered) {
    const t = s.submit({ text: 'Кто ты?', expectedVersion: s.version(), onError: 'keep' });
    for await (const _ of t.events);
    await t.result;
  }
  const id = s.id;
  await s.close();
  await e.close();
  return id;
}

/** A filing call that never answers (a begun task is aborted by close()). */
const hanging: ScriptCall = { steps: [{ pause: 'never' }] };

describe('one-shot commands open the lane manual', () => {
  test('control: a turn on an auto lane begins the filing of its answer, and close() leaves the begin row', async () => {
    const home = tmpHome('rp-core-lane-cli-');
    const id = await sessionIn(home, false);
    const { conn, provider } = scripted([{ steps: [{ text: 'Фрол кивнул.' }] }, hanging]);
    const e = await Engine.open({ home, connections: { script: conn }, ...seams(), lane: 'auto' });
    const s = e.session(id);
    const t = s.submit({ text: 'Кто ты?', expectedVersion: s.version(), onError: 'keep' });
    for await (const _ of t.events);
    await t.result;
    await s.close();
    await e.close();
    expect(provider.requests.map((r) => r.agent)).toEqual(['narrator', 'filing']);
    expect(jobRows(home, id).map((j) => j.state)).toEqual(['begin']);
  });

  test('rp-core send: the turn runs, no filing call, no job row, even when the engine is asked for an auto lane', async () => {
    const home = tmpHome('rp-core-lane-cli-');
    const id = await sessionIn(home, false);
    const { conn, provider } = scripted([{ steps: [{ text: 'Фрол кивнул.' }] }, hanging]);
    const out = memoryChannel();
    const err = memoryChannel();
    const code = await runSend({ home, sessionId: id, kind: 'reply', text: 'Кто ты?', json: false, debug: false, provider: conn, io: { out, err }, exitNow: () => {}, engine: { ...seams(), lane: 'auto' } });
    expect(code).toBe(0);
    expect(out.text()).toContain('Фрол кивнул.');
    expect(provider.requests.map((r) => r.agent)).toEqual(['narrator']);
    expect(jobRows(home, id)).toEqual([]);
  });

  test('control: opening a session with work waiting on an auto lane begins it, and close() leaves the begin row', async () => {
    const home = tmpHome('rp-core-lane-cli-');
    const id = await sessionIn(home, true);
    const { conn } = scripted([hanging]);
    const e = await Engine.open({ home, connections: { script: conn }, ...seams(), lane: 'auto' });
    await e.session(id).close();
    await e.close();
    expect(jobRows(home, id).map((j) => j.state)).toEqual(['begin']);
  });

  test('rp-core preview and compact open a session with work waiting and begin none of it', async () => {
    const home = tmpHome('rp-core-lane-cli-');
    const id = await sessionIn(home, true);
    const { conn, provider } = scripted([hanging]);
    const rt = { ...loadRuntime(home, {}), connections: { script: conn } };
    const out = memoryChannel();
    const err = memoryChannel();
    expect(await cmdPreview({ home, sessionId: id, draft: 'Ещё.', wire: false, verdicts: false, json: false, io: { out, err }, rt, engine: { ...seams(), lane: 'auto' } })).toBe(0);
    expect(await cmdCompact({ home, sessionId: id, json: false, io: { out, err }, engine: { ...seams(), connections: { script: conn }, lane: 'auto' } })).toBe(0);
    expect(provider.requests).toEqual([]);
    expect(jobRows(home, id)).toEqual([]);
    // The work is still there for the chat: the answer is accepted and not filed.
    const e = await Engine.open({ home, connections: { script: conn }, ...seams(), lane: 'manual' });
    const s = e.session(id);
    expect(s.memoryStatus().queued.map((q) => q.task)).toEqual(['file']);
    await s.close();
    await e.close();
  });
});
