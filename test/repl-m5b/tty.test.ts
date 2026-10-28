// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5b on a (fake) terminal through the real node:readline (D-181): what the background lane says while
// the person sits at the prompt goes above a fresh prompt, and what they had typed comes back with it.
import { afterEach, expect, test } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle } from '../../src/engine/api.ts';
import { runReplWith } from '../../src/cli/repl.ts';
import { createScriptedProvider, SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { calls, CONFIG, LEVI, MIRA } from '../repl/kit.ts';

const open: { stdin: PassThrough; done: Promise<number>; engine: EngineHandle }[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) {
    r.stdin.end();
    await r.done;
    await r.engine.close();
  }
});

test('a lane notice at the prompt: on its own line, then the prompt again with the typed text', async () => {
  const home = tmpHome('rp-core-tty-m5b-');
  const provider = createScriptedProvider(calls([{ text: 'Hi.' }]));
  const conn: Connection = { id: 'script', provider, caps: SCRIPT_CAPS, origin: 'script:script', local: true };
  const engine = await Engine.open({ home, connections: { script: conn }, clock: fakeClock(), random: fakeRandom(7), timeZone: 'UTC' });
  const session = engine.createSession({ character: MIRA, persona: LEVI });
  let all = '';
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(this: { isRaw: boolean }, m: boolean) { this.isRaw = m; return this; } });
  const stdout = Object.assign(
    new Writable({
      write(chunk, _enc, cb) {
        all += String(chunk);
        cb();
      },
    }),
    { isTTY: true, columns: 200, rows: 50 },
  );
  const channel = { write: (t: string) => void (all += t), flush: () => Promise.resolve() };
  const done = runReplWith(
    { engine, session, config: CONFIG, home, io: { out: channel, err: channel }, onInterrupt: undefined as never, color: false },
    { terminal: { stdin: stdin as never, stdout: stdout as never }, interactive: true, exitWindowMs: 50 },
  );
  open.push({ stdin, done, engine });
  const until = async (text: string, from = 0): Promise<number> => {
    for (let waited = 0; ; waited += 5) {
      const at = all.indexOf(text, from);
      if (at >= 0) return at;
      if (waited > 5000) throw new Error(`timed out waiting for ${JSON.stringify(text)}; screen:\n${JSON.stringify(all)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await until('you  › ');
  stdin.write('half a line');
  await until('half a line');
  const before = all.length;
  (session as unknown as { publish(b: unknown): void }).publish({ type: 'notice', level: 'warn', code: 'memory_backlog', message: '5 answers are waiting to be filed.' });
  const at = await until('! 5 answers are waiting to be filed. (memory_backlog)', before);
  // The notice starts a line of its own (never glued to the typed text), the prompt comes back after it.
  expect(all.slice(before, at)).toBe('\n');
  const after = all.slice(at);
  expect(after).toStartWith('! 5 answers are waiting to be filed. (memory_backlog)\n');
  expect(after).toContain('you  › half a line');
  // The typed text is still the line Enter sends.
  stdin.write('\r');
  await until('Mira › Hi.');
  expect(provider.requests).toHaveLength(1);
  expect(JSON.stringify(provider.requests[0]!.messages)).toContain('half a line');
});
