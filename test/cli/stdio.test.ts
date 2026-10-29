import { expect, test } from 'bun:test';
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
