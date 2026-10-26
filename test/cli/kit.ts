// Shared helpers for the CLI process tests (not a test file itself): every test spawns
// `bun src/cli/main.ts` with its own temporary --home, as a user or CI would run it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Event } from '../../src/protocol/events.ts';
import { tmpHome } from '../helpers.ts';

export const ROOT = join(import.meta.dir, '..', '..');
export const MAIN = join(ROOT, 'src', 'cli', 'main.ts');
export const CARDS = join(ROOT, 'test', 'fixtures', 'cards');
export const SCRIPTS = join(ROOT, 'test', 'fixtures', 'scripts');

export const script = (name: string): string => `script:${join(SCRIPTS, name)}`;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function spawnCli(args: readonly string[], opts: { stdin?: string } = {}) {
  return Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: ROOT,
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
}

export async function run(args: readonly string[], opts: { stdin?: string } = {}): Promise<RunResult> {
  const p = spawnCli(args, opts);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** A fresh home with one session made from `card` (default v3-full.json). */
export async function newSession(card = 'v3-full.json'): Promise<{ home: string; id: string }> {
  const home = tmpHome('rp-core-cli-');
  const r = await run(['new', '--card', join(CARDS, card), '--home', home]);
  if (r.code !== 0) throw new Error(`new failed (${r.code}): ${r.stderr}`);
  return { home, id: r.stdout.trim() };
}

/** Parse stdout as JSONL; throws on any line that is not a JSON object (stdout must be pure). */
export function jsonl(stdout: string): Event[] {
  const lines = stdout.split('\n');
  if (lines.pop() !== '') throw new Error('stdout does not end with a newline');
  return lines.map((l, i) => {
    const v = JSON.parse(l) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`line ${i + 1} is not an object: ${l}`);
    return v as Event;
  });
}

/** Collapse runs of one type: [start, text, text, done] → [start, text, done]. */
export const runsOf = (evs: readonly { type: string }[]): string[] =>
  evs.map((e) => e.type).filter((t, i, all) => i === 0 || all[i - 1] !== t);

export function journal(home: string, id: string): string {
  const f = join(home, 'sessions', `${id}.jsonl`);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

/** Poll until `cond` holds (or fail after `ms`). */
export async function until(cond: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const deadline = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** Collect a child's stdout as it streams. */
export function collect(stream: ReadableStream<Uint8Array>): { text(): string; done: Promise<void> } {
  let acc = '';
  const dec = new TextDecoder();
  const done = (async () => {
    for await (const chunk of stream) acc += dec.decode(chunk, { stream: true });
    acc += dec.decode();
  })();
  return { text: () => acc, done };
}
