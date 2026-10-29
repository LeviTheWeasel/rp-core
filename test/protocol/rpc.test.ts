import { expect, test } from 'bun:test';
import { runRpc } from '../../src/protocol/rpc.ts';
import { rig, MIRA, LEVI, calls } from '../engine/kit.ts';

function byteInput() {
  const chunks: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  return {
    input: {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        while (!ended || chunks.length) {
          if (chunks.length) { yield chunks.shift()!; continue; }
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      },
    },
    push(value: unknown): void { chunks.push(new TextEncoder().encode(`${JSON.stringify(value)}\r\n`)); wake?.(); wake = null; },
    raw(text: string): void { chunks.push(new TextEncoder().encode(text)); wake?.(); wake = null; },
    end(): void { ended = true; wake?.(); wake = null; },
  };
}

async function waitFor(frames: Record<string, any>[], check: (frame: Record<string, any>) => boolean): Promise<Record<string, any>> {
  for (let i = 0; i < 500; i++) {
    const found = frames.find(check);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`frame not received: ${JSON.stringify(frames.slice(-5))}`);
}

test('JSON-RPC handshake, session lifecycle, streamed turn and shutdown', async () => {
  const { engine, home } = await rig(calls([{ text: 'A quiet hello.' }]));
  const source = byteInput();
  const frames: Record<string, any>[] = [];
  const running = runRpc(source.input, (line) => frames.push(JSON.parse(line)), engine, home);
  source.raw('{bad json}\n');
  expect((await waitFor(frames, (f) => f.error?.code === -32700)).id).toBeNull();
  source.push({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocol: 1, client: { name: 'test-ui', version: '1' } } });
  expect((await waitFor(frames, (f) => f.id === 1)).result.protocol).toBe(1);
  source.push({ jsonrpc: '2.0', id: 'bad-params', method: 'session/list', params: [] });
  expect((await waitFor(frames, (f) => f.id === 'bad-params')).error.code).toBe(-32602);
  source.push({ jsonrpc: '2.0', id: 'unknown', method: 'missing/method' });
  expect((await waitFor(frames, (f) => f.id === 'unknown')).error.code).toBe(-32601);
  source.push({ jsonrpc: '2.0', id: 'missing-card', method: 'session/new', params: { character: 'no-such-card' } });
  expect((await waitFor(frames, (f) => f.id === 'missing-card')).error.code).toBe(-32602);
  source.push({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { character: MIRA, persona: LEVI } });
  const created = (await waitFor(frames, (f) => f.id === 2)).result;
  expect(created.snapshot.path.length).toBeGreaterThan(0);
  source.push({ jsonrpc: '2.0', id: 3, method: 'turn/submit', params: { sessionId: created.sessionId, text: 'Hi', expectedVersion: created.snapshot.version } });
  const admitted = (await waitFor(frames, (f) => f.id === 3)).result;
  expect(typeof admitted.turnId).toBe('string');
  const done = await waitFor(frames, (f) => f.method === 'event' && f.params.type === 'done');
  expect(done.params.message.blocks.some((b: { text?: string }) => b.text === 'A quiet hello.')).toBe(true);
  source.push({ jsonrpc: '2.0', id: 'recall', method: 'memory/recall', params: { sessionId: created.sessionId, turnId: admitted.turnId } });
  expect((await waitFor(frames, (f) => f.id === 'recall')).result.messageId).toBe(done.params.message.id);
  source.push({ jsonrpc: '2.0', id: 4, method: 'session/open', params: { sessionId: created.sessionId } });
  expect((await waitFor(frames, (f) => f.id === 4)).result.path.at(-1).id).toBe(done.params.message.id);
  source.push({ jsonrpc: '2.0', id: 5, method: 'shutdown', params: {} });
  await waitFor(frames, (f) => f.id === 5);
  await running;
  expect(frames.every((f) => f.jsonrpc === '2.0')).toBe(true);
});

test('turn/stop is dispatched while a model call is paused', async () => {
  const { engine, home } = await rig(calls([{ pause: 'slow' }, { text: 'too late' }]));
  const source = byteInput();
  const frames: Record<string, any>[] = [];
  const running = runRpc(source.input, (line) => frames.push(JSON.parse(line)), engine, home);
  source.push({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocol: 1, client: { name: 'test-ui', version: '1' } } });
  await waitFor(frames, (f) => f.id === 1);
  source.push({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { character: MIRA } });
  const created = (await waitFor(frames, (f) => f.id === 2)).result;
  source.push({ jsonrpc: '2.0', id: 3, method: 'turn/submit', params: { sessionId: created.sessionId, text: 'Hi', expectedVersion: created.snapshot.version } });
  const admitted = (await waitFor(frames, (f) => f.id === 3)).result;
  source.push({ jsonrpc: '2.0', id: 4, method: 'turn/stop', params: { sessionId: created.sessionId, turnId: admitted.turnId } });
  expect((await waitFor(frames, (f) => f.id === 4)).result.stopped).toBe(admitted.turnId);
  const stopped = await waitFor(frames, (f) => f.method === 'event' && f.params.type === 'stopped');
  expect(stopped.params.turnId).toBe(admitted.turnId);
  source.end();
  await running;
});

test('EOF stops an active turn and emits its terminal event before exit', async () => {
  const { engine, home } = await rig(calls([{ pause: 'slow' }, { text: 'too late' }]));
  const source = byteInput();
  const frames: Record<string, any>[] = [];
  const running = runRpc(source.input, (line) => frames.push(JSON.parse(line)), engine, home);
  source.push({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocol: 1, client: { name: 'test-ui', version: '1' } } });
  await waitFor(frames, (f) => f.id === 1);
  source.push({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { character: MIRA } });
  const created = (await waitFor(frames, (f) => f.id === 2)).result;
  source.push({ jsonrpc: '2.0', id: 3, method: 'turn/submit', params: { sessionId: created.sessionId, text: 'Hi', expectedVersion: created.snapshot.version } });
  const admitted = (await waitFor(frames, (f) => f.id === 3)).result;
  source.end();
  await running;
  expect(frames.some((f) => f.method === 'event' && f.params.type === 'stopped' && f.params.turnId === admitted.turnId)).toBe(true);
});

test('Compendium commands read and update the opened session', async () => {
  const { engine, home } = await rig([]);
  const source = byteInput();
  const frames: Record<string, any>[] = [];
  const running = runRpc(source.input, (line) => frames.push(JSON.parse(line)), engine, home);
  const ask = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    source.push({ jsonrpc: '2.0', id, method, params });
    return waitFor(frames, (f) => f.id === id);
  };
  await ask(1, 'initialize', { protocol: 1, client: { name: 'test-ui', version: '1' } });
  const created = (await ask(2, 'session/new', { character: MIRA })).result;
  const sessionId = created.sessionId;
  const added = await ask(3, 'memory/add', { sessionId, title: 'Lamp', content: 'A blue lamp.', keys: ['lamp'] });
  expect(added.result.changed).toBe(true);
  const list = await ask(4, 'memory/list', { sessionId, type: 'note' });
  expect(list.result.map((row: { name: string }) => row.name)).toEqual(['Lamp']);
  const ref = list.result[0].ref;
  expect((await ask(5, 'memory/get', { sessionId, ref })).result.entry.content).toBe('A blue lamp.');
  expect((await ask(6, 'memory/edit', { sessionId, ref, content: 'A red lamp.' })).result.changed).toBe(true);
  expect((await ask(7, 'memory/get', { sessionId, ref })).result.entry.content).toBe('A red lamp.');
  expect((await ask(8, 'memory/retire', { sessionId, ref })).result.changed).toBe(true);
  expect((await ask(9, 'memory/list', { sessionId, type: 'note' })).result).toEqual([]);
  expect((await ask(10, 'memory/restore', { sessionId, ref })).result.changed).toBe(true);
  expect((await ask(11, 'memory/status', { sessionId })).result.backlog).toBe(0);
  expect((await ask(12, 'memory/file', { sessionId, type: 'bogus', data: {} })).error.data.code).toBe('invalid_params');
  expect((await ask(14, 'director/show', { sessionId })).result.state.turn).toBe(0);
  expect((await ask(15, 'lore/test', { sessionId, text: 'I see the lamp.' })).result.ok).toBe(true);
  await ask(13, 'shutdown');
  await running;
});

test('editing during a turn holds the reply until commitAnyway', async () => {
  const { engine, home, provider } = await rig(calls([{ text: 'The answer.' }, { pause: 'gate' }]));
  const source = byteInput();
  const frames: Record<string, any>[] = [];
  const running = runRpc(source.input, (line) => frames.push(JSON.parse(line)), engine, home);
  const ask = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    source.push({ jsonrpc: '2.0', id, method, params });
    return waitFor(frames, (f) => f.id === id);
  };
  await ask(1, 'initialize', { protocol: 1, client: { name: 'test-ui', version: '1' } });
  const created = (await ask(2, 'session/new', { character: MIRA })).result;
  const sessionId = created.sessionId;
  const user = (await ask(3, 'message/send', { sessionId, text: 'What happened?', expectedVersion: created.snapshot.version })).result;
  const started = (await ask(4, 'turn/run', { sessionId, kind: 'reply', expectedVersion: user.version })).result;
  await waitFor(frames, (f) => f.method === 'event' && f.params.type === 'text' && f.params.turnId === started.turnId);
  const edited = await ask(5, 'message/edit', { sessionId, messageId: user.messageId, text: 'What changed?', expectedVersion: user.version });
  expect(edited.result.version).toBeGreaterThan(user.version);
  provider.release('gate');
  expect((await waitFor(frames, (f) => f.method === 'event' && f.params.type === 'conflict')).params.draft).toBe('The answer.');
  const snap = (await ask(6, 'session/open', { sessionId })).result;
  expect(snap.openTurns[0]).toMatchObject({ turnId: started.turnId, state: 'held', draft: 'The answer.' });
  expect((await ask(7, 'turn/run', { sessionId, kind: 'reply', expectedVersion: edited.result.version })).error.data.code).toBe('held_pending');
  const resolved = (await ask(8, 'turn/commitAnyway', { sessionId, turnId: started.turnId })).result;
  expect(resolved.outcome).toBe('committed');
  expect(resolved.message.blocks.some((block: { text?: string }) => block.text === 'The answer.')).toBe(true);
  expect((await ask(9, 'session/open', { sessionId })).result.openTurns).toEqual([]);
  await ask(10, 'shutdown');
  await running;
});
