// M5a D-164: `--keep-requests` on chat, tui and new reaches the engine (EngineOptions.keepRequests):
// a chat run as a process keeps its turn's request under <home>/sessions/<id>.requests/; without the
// flag nothing is kept; the commands that run no chat refuse the flag.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineOptions, loadRuntime } from '../../src/cli/runtime.ts';
import { tmpHome } from '../helpers.ts';
import { CARDS, newSession, run, script } from './kit.ts';

const T = 30_000;

describe('--keep-requests', () => {
  test(
    'chat: the narrator request of each turn, as JSON, named by its call key',
    async () => {
      const { home, id } = await newSession();
      const r = await run(['chat', id, '--home', home, '--keep-requests', '--provider', script('reply.jsonl')], { stdin: 'Hi Alice\n/quit\n' });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Hello there, traveller.');
      const dir = join(home, 'sessions', `${id}.requests`);
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/_narrator_0\.json$/);
      const body = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as { agent: string; callKey: string; messages: unknown[] };
      expect(body.agent).toBe('narrator');
      expect(body.callKey).toMatch(/:narrator:0$/);
      expect(JSON.stringify(body.messages)).toContain('Hi Alice');
    },
    T,
  );

  test(
    'off by default; tui and new take the flag, the other commands refuse it',
    async () => {
      const { home, id } = await newSession();
      const plain = await run(['chat', id, '--home', home, '--provider', script('reply.jsonl')], { stdin: 'Hi Alice\n/quit\n' });
      expect(plain.code).toBe(0);
      expect(existsSync(join(home, 'sessions', `${id}.requests`))).toBe(false);
      // tui parses it, then wants a terminal (not an unknown flag).
      const tui = await run(['tui', id, '--home', home, '--keep-requests']);
      expect(tui.code).toBe(64);
      expect(tui.stderr).toContain('rp-core tui needs a terminal');
      const made = await run(['new', '--card', join(CARDS, 'v3-full.json'), '--home', tmpHome('rp-core-cli-'), '--no-chat', '--keep-requests']);
      expect(made.code).toBe(0);
      const send = await run(['send', id, 'hi', '--home', home, '--keep-requests']);
      expect(send.code).toBe(64);
      expect(send.stderr).toContain('unknown flag --keep-requests');
      for (const c of ['chat', 'tui', 'new']) {
        const h = await run(['help', c]);
        expect(h.stdout).toContain('[--keep-requests]');
        expect(h.stdout).toContain('--keep-requests           keep every provider request of a turn');
        // What the file holds (review engine#6): the engine's request, not the HTTP body.
        expect(h.stdout).toContain("provider-level request for each model call (messages, tools, samplers),\n                            not the HTTP body (/preview --wire shows that), never headers or keys");
        expect(h.stdout).not.toContain('JSON body sent');
      }
    },
    T,
  );

  test('the runtime hands it to the engine options only when set', () => {
    const rt = loadRuntime(tmpHome('rp-core-cli-'), {});
    expect(engineOptions(rt).keepRequests).toBeUndefined();
    expect(engineOptions({ ...rt, keepRequests: true }).keepRequests).toBe(true);
  });
});
