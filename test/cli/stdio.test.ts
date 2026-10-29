import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli/main.ts';
import { memoryChannel } from '../../src/cli/io.ts';
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
