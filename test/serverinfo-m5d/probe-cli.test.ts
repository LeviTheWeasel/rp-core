// `rp-core probe <conn>` with the M5d server info (cli/catalog.ts): the server-info line, the slot
// pinning verdict for llama.cpp in text and --json, and nothing extra when the read is off.
import { afterAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdProbe, type ProbeResult } from '../../src/cli/catalog.ts';
import type { Io } from '../../src/cli/io.ts';
import { loadRuntime } from '../../src/cli/runtime.ts';
import { fakeClock, tmpHome } from '../helpers.ts';
import { fake, llamaProps, ollamaShow, type Fake } from './fakes.ts';

const fakes: Fake[] = [];
afterAll(() => {
  for (const f of fakes) f.stop();
});

function llamaServer(props: Record<string, unknown>): Fake {
  const f = fake({ '/v1/models': { object: 'list', data: [{ id: 'm', object: 'model', owned_by: 'llamacpp' }] }, '/props': props });
  fakes.push(f);
  return f;
}

async function probe(f: Fake, opts: { json: boolean; maxInFlight?: number; serverInfo?: 'auto' | 'off'; conn?: string; more?: string }) {
  const h = tmpHome('rp-core-serverinfo-m5d-');
  const extra = opts.maxInFlight !== undefined ? `max_in_flight = ${opts.maxInFlight}\n` : '';
  writeFileSync(join(h, 'config.toml'), `[connections.local]\nbase_url = "${f.base}/v1"\n${extra}${opts.conn ?? ''}\n${opts.more ?? ''}`);
  let out = '';
  const io: Io = { out: { write: (t) => void (out += t), flush: async () => {} }, err: { write: () => {}, flush: async () => {} } };
  const code = await cmdProbe({
    rt: loadRuntime(h, {}),
    io,
    json: opts.json,
    clock: fakeClock(),
    fetch,
    timeoutMs: 2_000,
    write: false,
    target: 'local',
    serverInfo: opts.serverInfo ?? 'auto',
  });
  return { code, out };
}

describe('probe: slot pinning verdict', () => {
  test('a recent llama.cpp with 2 slots: on, in text', async () => {
    const f = llamaServer(llamaProps());
    const r = await probe(f, { json: false, maxInFlight: 2 });
    expect(r.code).toBe(0);
    expect(r.out).toContain('\n  server info: llama.cpp b11901, 2 slots\n');
    expect(r.out).toContain('\n  slot pinning: on — narrator 0, agents 1 (2 slots, build b11901)\n');
  });

  test('--json carries the server info and the verdict', async () => {
    const f = llamaServer(llamaProps());
    const r = await probe(f, { json: true });
    const [res] = JSON.parse(r.out) as ProbeResult[];
    expect(res!.serverInfo).toEqual({ kind: 'llama.cpp', totalSlots: 2, build: 11901, endpointSlots: true });
    expect(res!.slotPin).toEqual({ pin: { narrator: 0, agents: 1 }, why: '2 slots, build b11901' });
  });

  test('an old build at capacity 2: off, with the reason', async () => {
    const f = llamaServer(llamaProps({ build_info: 'b9000-1a2b3c4d' }));
    const r = await probe(f, { json: false, maxInFlight: 2 });
    expect(r.out).toContain('\n  slot pinning: off — build b9000 is older than b11552 and capacity is 2');
    const j = JSON.parse((await probe(f, { json: true, maxInFlight: 2 })).out) as ProbeResult[];
    expect(j[0]!.slotPin?.pin).toBeNull();
  });

  test('the same old build at the local default capacity 1: on', async () => {
    const f = llamaServer(llamaProps({ build_info: 'b9000-1a2b3c4d' }));
    const j = JSON.parse((await probe(f, { json: true })).out) as ProbeResult[];
    expect(j[0]!.slotPin).toEqual({ pin: { narrator: 0, agents: 1 }, why: '2 slots, capacity 1 (build b9000)' });
  });

  test('one slot: off, how to get two', async () => {
    const f = llamaServer(llamaProps({ total_slots: 1 }));
    const r = await probe(f, { json: false });
    expect(r.out).toContain('slot pinning: off — the server has 1 slot; pinning needs 2 (start it with -np 2 --no-kv-unified)');
  });

  test('local = false (a tunnel on a loopback port): not read, as a session would not; a note says so', async () => {
    const f = llamaServer(llamaProps());
    const r = await probe(f, { json: false, conn: 'local = false\n' });
    expect(r.out).not.toContain('server info:');
    expect(r.out).not.toContain('slot pinning');
    expect(r.out).toContain('server info not read: local = false, so a session never reads this server or pins its slots by the rule');
    expect(f.paths.filter((p) => p === '/props')).toHaveLength(1);
  });

  test('another connection at the same origin with a lower capacity: a note gives the verdict a session using both gets', async () => {
    const f = llamaServer(llamaProps({ build_info: 'b9000-1a2b3c4d' }));
    const r = await probe(f, { json: false, maxInFlight: 2, more: `[connections.side]\nbase_url = "${f.base}/v1"\nmax_in_flight = 1\n` });
    expect(r.out).toContain('\n  slot pinning: off — build b9000 is older than b11552 and capacity is 2');
    expect(r.out).toContain(`a session that also uses side at ${f.base} gets capacity 1 there: slot pinning: on — narrator 0, agents 1 (2 slots, capacity 1 (build b9000))`);
    // Nothing to add when the other connection would not change the verdict.
    const g = llamaServer(llamaProps());
    const same = await probe(g, { json: false, maxInFlight: 2, more: `[connections.side]\nbase_url = "${g.base}/v1"\nmax_in_flight = 1\n` });
    expect(same.out).not.toContain('a session that also uses');
  });

  test('off: no server-info read, no verdict, the M3 output', async () => {
    const f = llamaServer(llamaProps());
    const r = await probe(f, { json: false, serverInfo: 'off' });
    expect(r.out).not.toContain('server info:');
    expect(r.out).not.toContain('slot pinning');
    expect(f.paths.filter((p) => p === '/props')).toHaveLength(1);
    const j = JSON.parse((await probe(f, { json: true, serverInfo: 'off' })).out) as ProbeResult[];
    expect(j[0]!.serverInfo).toBeUndefined();
    expect(j[0]!.slotPin).toBeUndefined();
  });
});

test('probe on Ollama: the server-info line, no pinning verdict', async () => {
  const f = fake({
    '/v1/models': { object: 'list', data: [{ id: 'magmell-16k:latest', object: 'model', owned_by: 'library' }] },
    '/api/version': { version: '0.40.12' },
    '/api/ps': { models: [{ name: 'magmell-16k:latest', context_length: 16384 }] },
    '/api/show': () => Response.json(ollamaShow('/models/blobs/sha256-0d1f', 'num_ctx 16384')),
  });
  fakes.push(f);
  const r = await probe(f, { json: false });
  expect(r.out).toContain('\n  server info: ollama 0.40.12, loaded: magmell-16k:latest (ctx 16384)\n');
  expect(r.out).not.toContain('slot pinning');
});
