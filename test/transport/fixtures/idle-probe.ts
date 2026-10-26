// Run as a child process by http-long-pause.test.ts with BUN_CONFIG_HTTP_IDLE_TIMEOUT set low (seconds).
// Shows that Bun's global fetch idle timer is real (a plain fetch dies on a pause longer than it) and
// that guardedFetch switches it off (the same pause survives). Prints one JSON line.
import { bodyBytes, guardedFetch } from '../../../src/providers/http.ts';

const pauseMs = Number(process.argv[2] ?? 6000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  idleTimeout: 0, // Bun.serve's own default (10 s) would close the socket from the server side
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/first') {
      await sleep(pauseMs);
      return new Response('late');
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode('a'));
          await sleep(pauseMs);
          c.enqueue(enc.encode('b'));
          c.close();
        },
      }),
    );
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const never = new AbortController().signal;

async function plain(path: string): Promise<string> {
  const t0 = performance.now();
  try {
    const res = await fetch(origin + path, { method: 'POST', body: '{}' });
    await res.text();
    return `ok ${Math.round(performance.now() - t0)}`;
  } catch (e) {
    return `error ${(e as Error).name} ${Math.round(performance.now() - t0)}`;
  }
}

async function guarded(path: string): Promise<string> {
  const t0 = performance.now();
  try {
    const res = await guardedFetch({ url: origin + path, method: 'POST', headers: {}, body: '{}' }, { fetch, signal: never, allowedOrigin: origin });
    let text = '';
    for await (const c of bodyBytes(res, never)) text += new TextDecoder().decode(c);
    return `ok ${Math.round(performance.now() - t0)} ${text}`;
  } catch (e) {
    return `error ${(e as Error).name} ${Math.round(performance.now() - t0)}`;
  }
}

const [plainFirst, plainMid, guardedFirst, guardedMid] = await Promise.all([plain('/first'), plain('/mid'), guarded('/first'), guarded('/mid')]);
console.log(JSON.stringify({ bun: Bun.version, idleEnv: process.env.BUN_CONFIG_HTTP_IDLE_TIMEOUT, pauseMs, plainFirst, plainMid, guardedFirst, guardedMid }));
server.stop(true);
