// The M1a demo (§15): kill -9 in the middle of a slow scripted answer, then the next open recovers
// it as [interrupted]; and the signal policy of a one-shot send (SIGINT → stopped, exit 2;
// SIGTERM → partial kept, exit 143). The slow script is 40 text steps 150 ms apart, so a turn
// lasts ~6 s and the first checkpoint lands after ~1 s (default cadence: 1 s or 400 chars).
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageView } from '../../src/session/view.ts';
import { collect, journal, jsonl, newSession, run, runsOf, script, spawnCli, until } from './kit.ts';

const T = 60_000;

async function showPath(home: string, id: string): Promise<MessageView[]> {
  const r = await run(['show', id, '--json', '--home', home]);
  if (r.code !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as MessageView[];
}

const textOf = (m: MessageView): string => m.blocks.map((b) => (b.k === 'text' ? b.text : '')).join('');

/** The text of every chk line written after byte `from` of the journal. */
function chkText(home: string, id: string, from = 0): string {
  return journal(home, id)
    .slice(from)
    .split('\n')
    .filter((l) => l.includes('"t":"chk"'))
    .map((l) => (JSON.parse(l) as { text: string }).text)
    .join('');
}

/** Start a slow send, wait for its first checkpoint, kill -9 it. Returns the partial text on disk. */
async function crashSlowTurn(home: string, id: string, args: string[]): Promise<string> {
  const from = journal(home, id).length;
  const p = spawnCli(['send', id, ...args, '--home', home, '--provider', script('slow.jsonl')]);
  const out = collect(p.stdout);
  await until(() => chkText(home, id, from) !== '', 15_000, 'the first chk line');
  p.kill('SIGKILL');
  await p.exited;
  await out.done;
  expect(p.signalCode).toBe('SIGKILL');
  const partial = chkText(home, id, from);
  expect(partial.startsWith('step1 ')).toBe(true);
  // The lock of the dead process is left behind; the next open must see it as stale.
  expect(existsSync(join(home, 'sessions', `${id}.lock`))).toBe(true);
  return partial;
}

describe('crash demo (kill -9)', () => {
  test(
    'reply: the next send recovers the partial answer as [interrupted], show prints it',
    async () => {
      const { home, id } = await newSession('Seraphina.png');
      const partial = await crashSlowTurn(home, id, ['Tell me a story']);

      // show does not take the lock and never recovers: it hints instead.
      const before = await run(['show', id, '--home', home]);
      expect(before.code).toBe(0);
      expect(before.stderr).toContain('1 interrupted turn');
      expect(before.stdout).not.toContain('step1');

      const r = await run(['send', id, 'Are you all right?', '--json', '--home', home, '--provider', script('reply.jsonl')]);
      expect(r.code).toBe(0);
      const evs = jsonl(r.stdout);
      expect(evs[0]).toMatchObject({ type: 'recovered', outcome: 'interrupted' });
      expect(runsOf(evs)).toEqual(['recovered', 'start', 'text', 'changed', 'done']);

      const path = await showPath(home, id);
      expect(path.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);
      const recovered = path[2]!;
      expect(recovered.gen?.finish).toBe('interrupted');
      expect(textOf(recovered)).toBe(partial);
      expect(textOf(path[3]!)).toBe('Are you all right?');
      expect(textOf(path[4]!)).toBe('Hello there, traveller.');

      const shown = await run(['show', id, '--home', home]);
      expect(shown.stdout).toContain(`assistant · ${recovered.id} · swipe 1/1 · [interrupted]`);
      expect(shown.stdout).toContain(`  ${partial.trimEnd()}`);
      expect(shown.stderr).toBe('');
      expect(existsSync(join(home, 'sessions', `${id}.lock`))).toBe(false);
    },
    T,
  );

  test(
    'swipe: the recovered answer is a sibling of the swiped one, not its child',
    async () => {
      const { home, id } = await newSession();
      expect((await run(['send', id, 'Hi', '--home', home, '--provider', script('reply.jsonl')])).code).toBe(0);
      const first = (await showPath(home, id)).at(-1)!;
      const partial = await crashSlowTurn(home, id, ['--kind', 'swipe']);

      const r = await run(['send', id, 'Go on', '--json', '--home', home, '--provider', script('reply.jsonl')]);
      expect(r.code).toBe(0);
      expect(jsonl(r.stdout)[0]).toMatchObject({ type: 'recovered', outcome: 'interrupted' });

      const path = await showPath(home, id);
      const recovered = path[2]!;
      expect(recovered.id).not.toBe(first.id);
      expect(recovered.parent).toBe(first.parent);
      expect(recovered.swipe).toEqual({ index: 1, count: 2 });
      expect(recovered.gen?.finish).toBe('interrupted');
      expect(textOf(recovered)).toBe(partial);
      expect((await run(['show', id, '--home', home])).stdout).toContain('swipe 2/2 · [interrupted]');
    },
    T,
  );
});

describe('signals', () => {
  test(
    'SIGINT during a slow send: exit 2, the partial answer is committed as [stopped]',
    async () => {
      const { home, id } = await newSession();
      const p = spawnCli(['send', id, 'Tell me a story', '--home', home, '--provider', script('slow.jsonl')]);
      const out = collect(p.stdout);
      const err = collect(p.stderr);
      await until(() => out.text().includes('step2'), 15_000, 'streamed text');
      p.kill('SIGINT');
      const code = await p.exited;
      await Promise.all([out.done, err.done]);
      expect(code).toBe(2);
      expect(out.text().startsWith('step1 step2')).toBe(true);
      expect(out.text().endsWith('\n')).toBe(true);
      expect(err.text()).toContain('[stopped] the partial answer was kept');

      const last = (await showPath(home, id)).at(-1)!;
      expect(last.role).toBe('assistant');
      expect(last.gen?.finish).toBe('stopped');
      // Everything printed before the stop is in the committed answer (it may hold a little more).
      expect(textOf(last).startsWith(out.text().trimEnd())).toBe(true);
      expect((await run(['show', id, '--home', home])).stdout).toContain('[stopped]');
      expect(existsSync(join(home, 'sessions', `${id}.lock`))).toBe(false);
    },
    T,
  );

  test(
    'SIGINT with --json: the last event is stopped with the message',
    async () => {
      const { home, id } = await newSession();
      const p = spawnCli(['send', id, 'Tell me a story', '--json', '--home', home, '--provider', script('slow.jsonl')]);
      const out = collect(p.stdout);
      await until(() => out.text().includes('"type":"text"'), 15_000, 'a text event');
      p.kill('SIGINT');
      expect(await p.exited).toBe(2);
      await out.done;
      const evs = jsonl(out.text());
      expect(runsOf(evs)).toEqual(['start', 'text', 'changed', 'stopped']);
      expect(evs.at(-1)).toMatchObject({ type: 'stopped', message: { role: 'assistant', gen: { finish: 'stopped' } } });
    },
    T,
  );

  test(
    'SIGTERM: the session is closed with the partial answer kept, exit 143',
    async () => {
      const { home, id } = await newSession();
      const p = spawnCli(['send', id, 'Tell me a story', '--json', '--home', home, '--provider', script('slow.jsonl')]);
      const out = collect(p.stdout);
      await until(() => out.text().includes('"type":"text"'), 15_000, 'a text event');
      p.kill('SIGTERM');
      expect(await p.exited).toBe(143);
      await out.done;
      const evs = jsonl(out.text());
      expect(evs.at(-1)).toMatchObject({ type: 'stopped' });
      const last = (await showPath(home, id)).at(-1)!;
      expect(last.gen?.finish).toBe('stopped');
      expect(textOf(last).startsWith('step1')).toBe(true);
      expect(existsSync(join(home, 'sessions', `${id}.lock`))).toBe(false);
    },
    T,
  );
});
