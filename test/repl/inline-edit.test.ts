// /e without $VISUAL / $EDITOR edits the message in place, in the input line, through the real
// node:readline on a (fake) terminal. Regression for the editor that could not get the keyboard: a
// terminal editor started from inside the REPL depends on the terminal handing it the keys, which
// Warp did not do (the person's keys showed up as lines under vi and never reached it). In place,
// the REPL itself reads the keys, so any terminal works.
import { afterEach, describe, expect, test } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle } from '../../src/engine/api.ts';
import { INLINE_BREAK, namedEditor, runReplWith } from '../../src/cli/repl.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptStep } from '../../src/providers/scripted.ts';
import type { EditEntry } from '../../src/session/entries.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { calls, CONFIG, entriesOf, LEVI, MIRA } from './kit.ts';

const PARAGRAPHS = 'First paragraph.\n\nSecond paragraph.';

interface Rig {
  screen(): string;
  keys(s: string): void;
  until(text: string, from?: number): Promise<number>;
  done: Promise<number>;
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

async function rig(steps: ScriptStep[][], env: Record<string, string | undefined>): Promise<Rig> {
  const home = tmpHome('rp-core-inline-');
  const conn: Connection = { id: 'script', provider: createScriptedProvider(calls(...steps)), caps: SCRIPT_CAPS, origin: 'script:script', local: true };
  const engine = await Engine.open({ home, connections: { script: conn }, clock: fakeClock(), random: fakeRandom(11), timeZone: 'UTC' });
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
    { isTTY: true, columns: 400, rows: 50 },
  );
  const channel = { write: (t: string) => void (all += t), flush: () => Promise.resolve() };
  const done = runReplWith(
    { engine, session, config: CONFIG, home, io: { out: channel, err: channel }, onInterrupt: undefined as never, color: false },
    { terminal: { stdin: stdin as never, stdout: stdout as never }, interactive: true, exitWindowMs: 50, env },
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
    home,
    sessionId: session.id,
  };
}

const edits = (r: Rig): EditEntry[] => entriesOf(r.home, r.sessionId).filter((e): e is EditEntry => e.t === 'edit');

describe('/e edits in place when no editor is named', () => {
  test('the message is put into the input line; Enter saves; paragraph breaks round-trip through ⏎', async () => {
    const r = await rig([[{ text: PARAGRAPHS }]], {});
    await r.until('[greeting 1/2]');
    r.keys('hello\r');
    const answered = await r.until('Second paragraph.');
    r.keys('/e\r');
    const editing = await r.until('editing in place', answered);
    // The message is in the input line, ready to edit, with its line breaks shown as ⏎.
    await r.until(`First paragraph.${INLINE_BREAK}${INLINE_BREAK}Second paragraph.`, editing);
    r.keys('\x05 EDITED\r'); // Ctrl+E (end of line), then type and save
    await r.until('edited message', editing);
    const e = edits(r);
    expect(e).toHaveLength(1);
    expect(e[0]!.reason).toBe('user');
    expect(e[0]!.blocks?.at(-1)).toEqual({ k: 'text', text: `${PARAGRAPHS} EDITED` });
    r.keys('/quit\r');
    expect(await r.done).toBe(0);
  });

  test('Ctrl+C cancels the edit, writes nothing, and leaves the REPL running', async () => {
    const r = await rig([[{ text: 'Only answer.' }]], {});
    await r.until('[greeting 1/2]');
    r.keys('hello\r');
    const answered = await r.until('Only answer.');
    r.keys('/e\r');
    const editing = await r.until('editing in place', answered);
    r.keys(' never saved');
    await new Promise((res) => setTimeout(res, 30));
    r.keys('\x03');
    await r.until('edit cancelled', editing);
    expect(edits(r)).toHaveLength(0);
    // Still alive: a command after the cancel runs, and the typed text did not leak into a message.
    r.keys('/show\r');
    await r.until('Only answer.', editing + 1);
    r.keys('/quit\r');
    expect(await r.done).toBe(0);
    expect(r.screen()).not.toContain('you   › never saved');
  });

  test('a named editor ($EDITOR) still runs instead of the in-place edit', async () => {
    const r = await rig([[{ text: 'Plain answer.' }]], { EDITOR: 'sh -c "printf \' via editor\' >> \\"\\$1\\"" sh' });
    await r.until('[greeting 1/2]');
    r.keys('hello\r');
    const answered = await r.until('Plain answer.');
    r.keys('/e\r');
    await r.until('edited message', answered);
    expect(r.screen()).not.toContain('editing in place');
    // The editor appended after the final newline the runner adds; the runner takes one back.
    expect(edits(r)[0]!.blocks?.at(-1)).toEqual({ k: 'text', text: 'Plain answer.\n via editor' });
    r.keys('/quit\r');
    expect(await r.done).toBe(0);
  });
});

describe('namedEditor', () => {
  test('VISUAL first, then EDITOR; empty or blank counts as unset', () => {
    expect(namedEditor({})).toBeNull();
    expect(namedEditor({ VISUAL: '', EDITOR: '  ' })).toBeNull();
    expect(namedEditor({ EDITOR: 'nano' })).toBe('nano');
    expect(namedEditor({ VISUAL: 'code --wait', EDITOR: 'nano' })).toBe('code --wait');
    expect(namedEditor({ VISUAL: ' ', EDITOR: 'vi' })).toBe('vi');
  });
});
