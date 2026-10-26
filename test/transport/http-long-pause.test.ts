// [slow] Bun fetch on long pauses (§8.8 "Поведение Bun fetch на длинных паузах не проверено; проверка — на M1").
// guardedFetch passes `timeout: false`; these tests show that a 20 s pause before the first byte and a
// 20 s pause mid-body do not end a request nobody aborted, and that Bun's idle timer (which the option
// switches off) is real. Findings: .notes/m1b-bun-fetch.md. ~25 s in total (the two pauses run in
// parallel). Set RP_CORE_SKIP_SLOW=1 to skip.
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { bodyBytes, guardedFetch } from '../../src/providers/http.ts';
import { enc, nowMs, sleep } from './kit.ts';

const SLOW = process.env.RP_CORE_SKIP_SLOW !== '1';
const PAUSE_MS = 20_000;

describe.skipIf(!SLOW)('[slow] Bun fetch on long pauses', () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0, // Bun.serve closes idle sockets after 10 s by default: a mock must turn that off
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/first') {
        await sleep(PAUSE_MS);
        return new Response('data: late\n\n');
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(enc.encode('data: one\n\n'));
            await sleep(PAUSE_MS);
            c.enqueue(enc.encode('data: two\n\n'));
            c.close();
          },
        }),
      );
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  afterAll(() => server.stop(true));

  async function read(path: string): Promise<{ text: string; ms: number }> {
    const never = new AbortController().signal;
    const t0 = nowMs();
    const res = await guardedFetch({ url: origin + path, method: 'POST', headers: {}, body: '{}' }, { fetch, signal: never, allowedOrigin: origin });
    let text = '';
    for await (const c of bodyBytes(res, never)) text += new TextDecoder().decode(c);
    return { text, ms: nowMs() - t0 };
  }

  test(
    '20 s before the first byte and 20 s mid-body both survive when no signal aborts',
    async () => {
      const [first, mid] = await Promise.all([read('/first'), read('/mid')]);
      expect(first.text).toBe('data: late\n\n');
      expect(mid.text).toBe('data: one\n\ndata: two\n\n');
      expect(first.ms).toBeGreaterThanOrEqual(PAUSE_MS - 50);
      expect(mid.ms).toBeGreaterThanOrEqual(PAUSE_MS - 50);
    },
    45_000,
  );

  test(
    "Bun's idle timer is real, and guardedFetch switches it off (child process, BUN_CONFIG_HTTP_IDLE_TIMEOUT=2)",
    async () => {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'idle-probe.ts'), '6000'], {
        env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: '2' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const r = JSON.parse(out.trim().split('\n').pop()!) as Record<string, string>;
      // A plain fetch dies on the idle timer (TimeoutError after ~2-4 s) ...
      expect(r.plainFirst).toMatch(/^error TimeoutError/);
      expect(r.plainMid).toMatch(/^error TimeoutError/);
      // ... while guardedFetch waits out the 6 s pause both before the first byte and mid-body.
      expect(r.guardedFirst).toMatch(/^ok \d+ late$/);
      expect(r.guardedMid).toMatch(/^ok \d+ ab$/);
    },
    30_000,
  );
});
