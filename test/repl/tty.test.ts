// The REPL on a (fake) terminal, through the real node:readline (review M1b, §12.4 "Ввод"): keys typed
// while an answer streams never land inside it, readline's redraws (Backspace, a line clear: cursor
// to column 1, clear to the end of the screen, "you › …") never erase it, Ctrl+C stops the turn
// even with text typed, and that text comes back at the prompt afterwards.
import { afterEach, describe, expect, test } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle } from '../../src/engine/api.ts';
import { runReplWith } from '../../src/cli/repl.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptStep } from '../../src/providers/scripted.ts';
import type { MsgEntry } from '../../src/session/entries.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { calls, CONFIG, entriesOf, LEVI, MIRA } from './kit.ts';

/** The text of a journal message (its text blocks joined). */
const textOf = (m: MsgEntry): string => (m.blocks ?? []).reduce((s, b) => (b.k === 'text' ? s + b.text : s), '');

/** A stream of words with a pause before each: long enough to type into and to stop. */
function slowWords(n: number, ms: number): ScriptStep[] {
  const out: ScriptStep[] = [];
  for (let i = 1; i <= n; i++) out.push({ delay: ms }, { text: `step${i} ` });
  return out;
}

interface TtyRig {
  /** Everything both the REPL and readline wrote to the terminal, escapes included. */
  screen(): string;
  keys(s: string): void;
  until(text: string, from?: number): Promise<number>;
  done: Promise<number>;
  engine: EngineHandle;
  home: string;
  sessionId: string;
}

const open: { stdin: PassThrough; done: Promise<number>; engine: EngineHandle }[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) {
    r.stdin.end();
    await r.done;
    await r.engine.close();
  }
});

async function ttyRig(steps: ScriptStep[][]): Promise<TtyRig> {
  const home = tmpHome('rp-core-tty-');
  const provider = createScriptedProvider(calls(...steps));
  const conn: Connection = { id: 'script', provider, caps: SCRIPT_CAPS, origin: 'script:script', local: true };
  const engine = await Engine.open({ home, connections: { script: conn }, clock: fakeClock(), random: fakeRandom(7), timeZone: 'UTC', checkpoint: { chars: 8, ms: 5, datasyncMs: 5 } });
  const session = engine.createSession({ character: MIRA, persona: LEVI });

  let all = '';
  // The fake terminal: a TTY stdin readline puts in raw mode, and one screen both writers share.
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
  return {
    screen: () => all,
    keys: (s) => void stdin.write(s),
    async until(text: string, from = 0): Promise<number> {
      for (let waited = 0; ; waited += 5) {
        const at = all.indexOf(text, from);
        if (at >= 0) return at;
        if (waited > 5000) throw new Error(`timed out waiting for ${JSON.stringify(text)}; screen:\n${JSON.stringify(all)}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    done,
    engine,
    home,
    sessionId: session.id,
  };
}

/** The part of the screen from the answer's label to the [stopped] line. */
function answerArea(screen: string, from: number): string {
  const start = screen.indexOf('Mira › ', from);
  const end = screen.indexOf('[stopped]', start);
  return screen.slice(start, end);
}

describe('REPL on a terminal: typing while an answer streams', () => {
  test('Ctrl+C with text typed stops the turn at once; the keys never land in the answer; the text comes back at the prompt', async () => {
    const r = await ttyRig([slowWords(40, 40), [{ text: 'Second answer.' }]]);
    await r.until('[greeting 1/2]');
    r.keys('start\r');
    const first = await r.until('step2');
    r.keys('half-typed');
    await new Promise((res) => setTimeout(res, 60));
    r.keys('\x03'); // Ctrl+C
    const stopped = await r.until('[stopped]', first);
    const area = answerArea(r.screen(), first - 20);
    // Nothing of readline inside the answer: no echoed keys, no redraw (column 1 + clear down).
    expect(area).not.toContain('half-typed');
    expect(area).not.toContain('\x1b[1G');
    expect(area).not.toContain('\x1b[0J');
    // Stopped by the first press (the stream had 40 words at 40 ms; it did not run on).
    expect(area).not.toContain('step20');
    // The prompt comes back with the held text, ready to send.
    await r.until('half-typed', stopped);
    r.keys('\r');
    await r.until('Second answer.', stopped);
    const msgs = entriesOf(r.home, r.sessionId).filter((e): e is MsgEntry => e.t === 'msg');
    expect(msgs.find((m) => m.role === 'assistant' && m.gen?.kind === 'model')?.gen?.finish).toBe('stopped');
    expect(msgs.filter((m) => m.role === 'user').map(textOf)).toEqual(['start', 'half-typed']);
    r.keys('/quit\r');
    expect(await r.done).toBe(0);
  });

  test('Backspace and a typed line while it streams: no redraw erases the answer; a whole line is held and sent after it', async () => {
    const r = await ttyRig([slowWords(12, 25), [{ text: 'Held reply.' }]]);
    await r.until('[greeting 1/2]');
    r.keys('go\r');
    const first = await r.until('step2');
    r.keys('abc');
    r.keys('\x7f'); // Backspace: readline redraws its line
    r.keys('\x15'); // Ctrl+U: and again
    r.keys('next line\r');
    const end = await r.until('[swipe 1/1', first);
    const answer = r.screen().slice(r.screen().indexOf('Mira › ', first - 20), end);
    expect(answer).not.toContain('\x1b[1G');
    expect(answer).not.toContain('abc');
    expect(answer).toContain('step12');
    // The held line is sent once the answer is done, and answered.
    await r.until('Held reply.', end);
    r.keys('/quit\r');
    expect(await r.done).toBe(0);
  });

  test('at the prompt, Ctrl+C with text typed clears the line (it does not quit, nothing is sent)', async () => {
    const r = await ttyRig([[{ text: 'Only answer.' }]]);
    await r.until('[greeting 1/2]');
    r.keys('never sent');
    await r.until('never sent');
    r.keys('\x03');
    r.keys('sent\r');
    await r.until('Only answer.');
    const users = entriesOf(r.home, r.sessionId).filter((e): e is MsgEntry => e.t === 'msg' && e.role === 'user');
    expect(users.map(textOf)).toEqual(['sent']);
    r.keys('/quit\r');
    expect(await r.done).toBe(0);
  });
});
