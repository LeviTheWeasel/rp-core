// One-shot `rp-core send` on the scripted provider (§12.3), run as processes: output channels,
// event order, swipe/continue, refusals, failures, and exit codes.
import { describe, expect, test } from 'bun:test';
import type { Event } from '../../src/protocol/events.ts';
import type { MessageView } from '../../src/session/view.ts';
import { jsonl, newSession, run, runsOf, script } from './kit.ts';

const T = 30_000;

async function showPath(home: string, id: string): Promise<MessageView[]> {
  const r = await run(['show', id, '--json', '--home', home]);
  if (r.code !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as MessageView[];
}

const textOf = (m: MessageView): string => m.blocks.map((b) => (b.k === 'text' ? b.text : '')).join('');

describe('send reply', () => {
  test(
    'text mode streams the answer to stdout, ends with a newline, exits 0',
    async () => {
      const { home, id } = await newSession();
      const r = await run(['send', id, 'Hi Alice', '--home', home, '--provider', script('reply.jsonl')]);
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('Hello there, traveller.\n');
      const path = await showPath(home, id);
      expect(path.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
      expect(textOf(path[1]!)).toBe('Hi Alice');
      expect(textOf(path[2]!)).toBe('Hello there, traveller.');
      expect(path[2]!.gen).toMatchObject({ kind: 'model', connection: 'script', finish: 'end' });
    },
    T,
  );

  test(
    '--json: stdout is pure JSONL of events in order start, text…, changed, done',
    async () => {
      const { home, id } = await newSession();
      const r = await run(['send', id, 'Hi', '--json', '--home', home, '--provider', script('reply.jsonl')]);
      expect(r.code).toBe(0);
      const evs = jsonl(r.stdout);
      expect(runsOf(evs)).toEqual(['start', 'text', 'changed', 'done']);
      for (const e of evs) {
        expect(e.sessionId).toBe(id);
        expect(typeof e.ts).toBe('string');
      }
      const start = evs[0] as Extract<Event, { type: 'start' }>;
      expect(start.kind).toBe('reply');
      // Deltas rebuild the answer by offset; done carries the authoritative message.
      let text = '';
      for (const e of evs) if (e.type === 'text') text = text.slice(0, e.offset) + e.delta;
      expect(text).toBe('Hello there, traveller.');
      const done = evs.at(-1) as Extract<Event, { type: 'done' }>;
      expect(done.message.id).toBe(start.messageId);
      expect(textOf(done.message)).toBe('Hello there, traveller.');
    },
    T,
  );

  test(
    '"-" reads the text from stdin',
    async () => {
      const { home, id } = await newSession();
      const r = await run(['send', id, '-', '--home', home, '--provider', script('reply.jsonl')], { stdin: 'From a pipe\n' });
      expect(r.code).toBe(0);
      const path = await showPath(home, id);
      expect(textOf(path[1]!)).toBe('From a pipe');
    },
    T,
  );
});

describe('swipe and continue', () => {
  test(
    'swipe creates a sibling of the last answer; show reports swipe 2/2',
    async () => {
      const { home, id } = await newSession();
      expect((await run(['send', id, 'Hi', '--home', home, '--provider', script('reply.jsonl')])).code).toBe(0);
      const first = (await showPath(home, id)).at(-1)!;
      const r = await run(['send', id, '--kind', 'swipe', '--json', '--home', home, '--provider', script('swipe.jsonl')]);
      expect(r.code).toBe(0);
      const evs = jsonl(r.stdout);
      expect(runsOf(evs)).toEqual(['start', 'text', 'changed', 'done']);
      expect(evs[0]).toMatchObject({ type: 'start', kind: 'swipe', parentId: first.parent });
      const path = await showPath(home, id);
      const last = path.at(-1)!;
      expect(last.id).not.toBe(first.id);
      expect(last.parent).toBe(first.parent);
      expect(last.swipe).toEqual({ index: 1, count: 2 });
      expect(textOf(last)).toBe('A different answer.');
      const shown = await run(['show', id, '--home', home]);
      expect(shown.stdout).toContain(`assistant · ${last.id} · swipe 2/2`);
    },
    T,
  );

  test(
    'swipe with guidance is accepted; continue appends to the last answer',
    async () => {
      const { home, id } = await newSession();
      expect((await run(['send', id, 'Hi', '--home', home, '--provider', script('reply.jsonl')])).code).toBe(0);
      const g = await run(['send', id, '--kind', 'swipe', '--guidance', 'be shorter', '--home', home, '--provider', script('swipe.jsonl')]);
      expect(g.code).toBe(0);
      expect((await showPath(home, id)).at(-1)!.gen?.guidance).toBe('be shorter');

      const c = await run(['send', id, '--kind', 'continue', '--home', home, '--provider', script('continue.jsonl')]);
      expect(c.code).toBe(0);
      expect(c.stdout).toBe(' And then she smiled.\n');
      const path = await showPath(home, id);
      expect(path).toHaveLength(3); // continue edits in place: no new message
      expect(textOf(path.at(-1)!)).toBe('A different answer. And then she smiled.');
    },
    T,
  );
});

describe('refusals (exit 5)', () => {
  test(
    'swipe with nothing to swipe: refusal JSON on stderr, nothing written, nothing on stdout',
    async () => {
      const { home, id } = await newSession();
      const r = await run(['send', id, '--kind', 'swipe', '--json', '--home', home, '--provider', script('swipe.jsonl')]);
      expect(r.code).toBe(5);
      expect(r.stdout).toBe('');
      const last = JSON.parse(r.stderr.trim().split('\n').pop()!);
      expect(last).toMatchObject({ type: 'refusal', code: 'nothing_to_swipe' });
      expect(typeof last.message).toBe('string');
      expect((await showPath(home, id)).length).toBe(1);
    },
    T,
  );

  test(
    'no --provider in M1a: no_connection, with a hint in text mode; the user line is not written',
    async () => {
      const { home, id } = await newSession();
      const r = await run(['send', id, 'Hi', '--home', home]);
      expect(r.code).toBe(5);
      expect(r.stderr).toContain('refused (no_connection)');
      expect(r.stderr).toContain('--provider script:<file>');
      expect(r.stderr).toContain('{"type":"refusal","code":"no_connection"');
      expect((await showPath(home, id)).length).toBe(1);
    },
    T,
  );

  test(
    'an unknown session: session_not_found',
    async () => {
      const { home } = await newSession();
      const r = await run(['send', 's_deadbeef', 'Hi', '--json', '--home', home, '--provider', script('reply.jsonl')]);
      expect(r.code).toBe(5);
      expect(r.stdout).toBe('');
      expect(JSON.parse(r.stderr.trim())).toMatchObject({ type: 'refusal', code: 'session_not_found' });
    },
    T,
  );
});

describe('failures (exit 3)', () => {
  test(
    'a provider error before output: failed event, exit 3, nothing committed',
    async () => {
      const { home, id } = await newSession();
      const r = await run(['send', id, 'Hi', '--json', '--home', home, '--provider', script('fail.jsonl')]);
      expect(r.code).toBe(3);
      const evs = jsonl(r.stdout);
      expect(runsOf(evs)).toEqual(['start', 'failed']);
      expect(evs.at(-1)).toMatchObject({ type: 'failed', category: 'auth', code: 'auth_failed', draft: '' });
      const text = await run(['send', id, 'Again', '--home', home, '--provider', script('fail.jsonl')]);
      expect(text.code).toBe(3);
      expect(text.stdout).toBe('');
      expect(text.stderr).toContain('the answer failed (auth/auth_failed): bad key');
      expect((await showPath(home, id)).every((m) => m.role !== 'assistant' || m.gen?.kind === 'greeting')).toBe(true);
    },
    T,
  );

  test(
    'a failure after output keeps the partial answer as [interrupted] (onError keep), exit 3',
    async () => {
      const { home, id } = await newSession();
      const r = await run(['send', id, 'Hi', '--home', home, '--provider', script('fail-after-output.jsonl')]);
      expect(r.code).toBe(3);
      expect(r.stdout).toBe('Half an answer\n');
      expect(r.stderr).toContain('the partial answer was kept, marked [interrupted]');
      const last = (await showPath(home, id)).at(-1)!;
      expect(last.gen?.finish).toBe('interrupted');
      expect(textOf(last)).toBe('Half an answer');
      const shown = await run(['show', id, '--home', home]);
      expect(shown.stdout).toContain('[interrupted]');
    },
    T,
  );

  test(
    '--debug prints the raw failure event to stderr',
    async () => {
      const { home, id } = await newSession();
      const r = await run(['send', id, 'Hi', '--debug', '--home', home, '--provider', script('fail.jsonl')]);
      expect(r.code).toBe(3);
      const raw = r.stderr.split('\n').find((l) => l.startsWith('{'));
      expect(JSON.parse(raw!)).toMatchObject({ type: 'failed', code: 'auth_failed', message: 'bad key' });
    },
    T,
  );
});
