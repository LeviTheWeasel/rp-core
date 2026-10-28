// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c, the lead's ruling K (sched#2): a `--provider replay:` origin takes its locality from the recording.
// The scheduler took the recorded connection's origin for local or remote while recording (a configured
// connection's `local`); the replay connection's provider now says the same (`localOrigin`), so recall's
// `auto` (prefetch or sync) and `on_miss` choose as they did and the replay asks for the recorded calls.
// Without a recorded connection in config.toml it says nothing and the origin stays remote, as before.
// Nothing here reaches the network: the configured connection's provider throws if it is ever used.
import { describe, expect, test } from 'bun:test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayConnection } from '../../src/cli/provider.ts';
import { routeOf } from '../../src/cli/runtime.ts';
import type { Connection, EngineHandle } from '../../src/engine/api.ts';
import { Engine } from '../../src/engine/engine.ts';
import { connectionLocality } from '../../src/engine/sched.ts';
import { createRecordingProvider, parseRecording, type RecordedCall } from '../../src/providers/record.ts';
import { createScriptedProvider, SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import type { Provider } from '../../src/providers/types.ts';
import { drain, LEVI, MIRA } from '../engine/kit.ts';
import { putBook } from '../engine-m5a/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { HARBOR_BOOK, narr } from '../recall-engine-m5c/kit.ts';

/** A configured connection on a local server (an unused port: never contacted). */
const configured = (id: string, provider: Provider, local = true): Connection => ({
  id,
  provider,
  caps: SCRIPT_CAPS,
  origin: 'http://127.0.0.1:9',
  local,
  baseUrl: 'http://127.0.0.1:9/v1',
});
const never: Provider = {
  stream() {
    throw new Error('the configured connection was called');
  },
};

const recorded = (connection: string | undefined): RecordedCall => ({
  v: 1,
  requestHash: '0123456789abcdef',
  request: { messages: [], maxTokens: 1, samplers: {} },
  model: { ...(connection !== undefined ? { connection } : {}), model: 'm' },
  events: [],
});

describe('the replay origin is local when the recorded connection was', () => {
  test("its provider says the scheduler's locality of the recorded connection's origin; none without one", () => {
    const connections = { box: configured('box', never), lan: configured('lan', never, false) };
    const isLocal = (c: Connection): boolean => connectionLocality(() => [...Object.values(connections), c])(c.origin);
    const onBox = replayConnection('r.jsonl', [recorded('box')], () => connections);
    expect((onBox.provider as { localOrigin?: boolean }).localOrigin).toBe(true);
    expect(isLocal(onBox)).toBe(true);
    expect(routeOf({ connections, provider: onBox }, 'box', 'm')?.local).toBe(true);
    // A remote server (its config says local = false): remote.
    const onLan = replayConnection('r.jsonl', [recorded('lan')], () => ({ lan: connections.lan }));
    expect((onLan.provider as { localOrigin?: boolean }).localOrigin).toBe(false);
    expect(isLocal(onLan)).toBe(false);
    // The recorded connection gone from config.toml, or never named: nothing said, remote as before.
    for (const conn of [replayConnection('r.jsonl', [recorded('gone')], () => connections), replayConnection('r.jsonl', [recorded(undefined)], () => connections)]) {
      expect((conn.provider as { localOrigin?: boolean }).localOrigin).toBeUndefined();
      expect(isLocal(conn)).toBe(false);
    }
  });

  test('a turn recorded on a local server replays with the same config: auto picks as it did, no extra recall call', async () => {
    const dir = tmpHome('rp-core-replay-m5c-');
    const file = join(dir, 'calls.jsonl');
    writeFileSync(file, '');
    const engines: EngineHandle[] = [];
    /** One reply on a session reading the book (recall mode auto: the default; lane manual). */
    const turn = async (connections: Record<string, Connection>, override?: Connection): Promise<{ result: string; recall: string[]; local: boolean }> => {
      const home = tmpHome('rp-core-replay-m5c-');
      const engine = await Engine.open({
        home,
        connections,
        ...(override ? { providerOverride: override } : {}),
        clock: fakeClock(),
        random: fakeRandom(7),
        timeZone: 'UTC',
        lane: 'manual',
        recall: 'config',
      });
      engines.push(engine);
      const book = putBook(home, HARBOR_BOOK);
      const s = engine.createSession({
        character: MIRA,
        persona: LEVI,
        config: { roles: { narrator: { conn: 'box', model: 'm' } }, lorebooks: [book], compendium: { enabled: true, filing: { enabled: false }, historian: { interval: 0 } } },
      });
      s.send({ text: 'Я жду у двери.', expectedVersion: s.version() });
      const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
      const evs = await drain(t);
      const out = await t.result;
      const recall = evs.flatMap((e) => (e.type === 'agent' && e.agent === 'recall' ? [e.status] : []));
      const origin = (override ?? connections.box!).origin;
      return { result: out.type, recall, local: (engine as unknown as { ctx: { sched: { forOrigin(o: string, c: number): { local: boolean } } } }).ctx.sched.forOrigin(origin, 1).local };
    };
    try {
      // Record: the server is local, so auto would prefetch; the lane is manual, so on_miss (lexical): no recall call.
      const inner = createScriptedProvider([narr('Мира открывает дверь.')]);
      const rec = await turn({ box: configured('box', createRecordingProvider(inner, (l) => appendFileSync(file, `${l}\n`), { connection: 'box' })) });
      expect(rec).toEqual({ result: 'done', recall: [], local: true });
      const calls = parseRecording(readFileSync(file, 'utf8'));
      expect(calls.map((c) => c.model)).toEqual([{ connection: 'box', model: 'm' }]);
      // Replay with the same config: the replay origin is local too, so the turn asks for the one recorded call.
      const connections = { box: configured('box', never) };
      const replay = replayConnection(file, calls, () => connections);
      expect(await turn(connections, replay)).toEqual({ result: 'done', recall: [], local: true });
      expect((replay.provider as unknown as { remaining(): number }).remaining()).toBe(0);
    } finally {
      for (const e of engines) await e.close();
    }
  });
});
