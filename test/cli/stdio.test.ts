import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli/main.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { MIRA } from '../engine/kit.ts';
import { tmpHome } from '../helpers.ts';

test('rp-core --stdio speaks JSON-RPC on stdout and exits cleanly on shutdown', async () => {
  const home = tmpHome();
  const out = memoryChannel();
  const err = memoryChannel();
  async function* input(): AsyncGenerator<Uint8Array> {
    const enc = new TextEncoder();
    yield enc.encode('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"client":{"name":"test","version":"1"}}}\n');
    yield enc.encode('{"jsonrpc":"2.0","id":2,"method":"session/list","params":{}}\n');
    yield enc.encode('{"jsonrpc":"2.0","id":3,"method":"shutdown"}\n');
  }
  const code = await main(['--home', home, '--stdio'], { io: { out, err }, env: {}, exit: () => {}, input: input() });
  expect(code).toBe(0);
  expect(err.text()).toBe('');
  const frames = out.text().trim().split('\n').map((line) => JSON.parse(line));
  expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3]);
  expect(frames[0].result.protocol).toBe(1);
  expect(frames[1].result).toEqual([]);
});

test('stdio exposes configured caps and the model catalog', async () => {
  const home = tmpHome();
  writeFileSync(join(home, 'config.toml'), '[connections.mock]\nbase_url = "https://example.invalid"\n[caps."mock:demo"]\ncontext_length = 32768\n');
  const out = memoryChannel();
  const err = memoryChannel();
  async function* input(): AsyncGenerator<Uint8Array> {
    const encode = (id: number, method: string, params: Record<string, unknown> = {}) => new TextEncoder().encode(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    yield encode(1, 'initialize', { protocol: 1, client: { name: 'test', version: '1' } });
    yield encode(2, 'caps/get', { conn: 'mock', model: 'demo' });
    yield encode(3, 'models/list', { conn: 'mock' });
    yield encode(4, 'caps/probe', { conn: 'mock', model: 'demo' });
    yield encode(5, 'shutdown');
  }
  const fakeFetch = (async () => Response.json({ data: [{ id: 'demo', context_length: 32768 }] })) as unknown as typeof fetch;
  const code = await main(['--home', home, '--stdio'], { io: { out, err }, env: {}, exit: () => {}, input: input(), fetch: fakeFetch });
  expect(code).toBe(0);
  const frames = out.text().trim().split('\n').map((line) => JSON.parse(line));
  expect(frames.find((f) => f.id === 2)?.result.contextLength).toBe(32768);
  expect(frames.find((f) => f.id === 3)?.result.models).toEqual([{ id: 'demo', contextLength: 32768 }]);
  expect(frames.find((f) => f.id === 4)?.result.connection).toBe('mock');
});

test('SIGTERM closes a stdio host that is waiting for another input line', async () => {
  const home = tmpHome();
  const out = memoryChannel();
  const err = memoryChannel();
  const listeners = new Map<string, () => void>();
  const signals = {
    on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => { listeners.set(signal, listener); },
    removeListener: (signal: 'SIGINT' | 'SIGTERM') => { listeners.delete(signal); },
  };
  async function* input(): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"client":{"name":"test","version":"1"}}}\n');
    await new Promise(() => {});
  }
  const running = main(['--home', home, '--stdio'], { io: { out, err }, env: {}, exit: () => {}, input: input(), signals });
  for (let i = 0; i < 100 && !out.text().includes('"id":1'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(out.text()).toContain('"id":1');
  listeners.get('SIGTERM')?.();
  expect(await running).toBe(143);
  expect(listeners.size).toBe(0);
});

test('SIGINT stops an active stdio turn and leaves the host available', async () => {
  const home = tmpHome();
  const script = join(home, 'model.jsonl');
  writeFileSync(script, `${JSON.stringify([{ text: 'Part.' }, { pause: 'hold' }])}\n${JSON.stringify([{ text: 'Again.' }, { pause: 'hold-2' }])}\n`);
  const out = memoryChannel();
  const err = memoryChannel();
  const listeners = new Map<string, () => void>();
  const signals = {
    on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => { listeners.set(signal, listener); },
    removeListener: (signal: 'SIGINT' | 'SIGTERM') => { listeners.delete(signal); },
  };
  const chunks: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  async function* input(): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (chunks.length) yield chunks.shift()!;
      else await new Promise<void>((resolve) => { wake = resolve; });
    }
  }
  const send = (id: number, method: string, params: Record<string, unknown> = {}) => {
    chunks.push(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`));
    wake?.(); wake = undefined;
  };
  const frame = async (check: (f: Record<string, any>) => boolean): Promise<Record<string, any>> => {
    for (let i = 0; i < 200; i++) {
      const found = out.text().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).find(check);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`missing frame: ${out.text()}`);
  };
  const running = main(['--home', home, '--stdio', '--provider', `script:${script}`], { io: { out, err }, env: {}, exit: () => {}, input: input(), signals });
  send(1, 'initialize', { protocol: 1, client: { name: 'test', version: '1' } });
  await frame((f) => f.id === 1);
  send(2, 'session/new', { character: MIRA });
  const created = (await frame((f) => f.id === 2)).result;
  send(3, 'turn/submit', { sessionId: created.sessionId, text: 'Hi', expectedVersion: created.snapshot.version });
  await frame((f) => f.method === 'event' && f.params.type === 'text');
  listeners.get('SIGINT')?.();
  expect((await frame((f) => f.method === 'event' && f.params.type === 'stopped')).params.message.gen.finish).toBe('stopped');
  send(4, 'session/open', { sessionId: created.sessionId });
  const refreshed = (await frame((f) => f.id === 4)).result;
  send(5, 'turn/submit', { sessionId: created.sessionId, text: 'Again', expectedVersion: refreshed.version });
  const second = (await frame((f) => f.id === 5)).result;
  await frame((f) => f.method === 'event' && f.params.type === 'text' && f.params.turnId === second.turnId);
  listeners.get('SIGTERM')?.();
  expect(await running).toBe(143);
  expect((await frame((f) => f.method === 'event' && f.params.type === 'stopped' && f.params.turnId === second.turnId)).params.message.gen.finish).toBe('stopped');
});
