// Shared helpers for the transport tests (not a test file itself).

export const enc = new TextEncoder();

/** An async byte source from string or byte chunks, in order. */
export async function* bytesOf(chunks: readonly (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield typeof c === 'string' ? enc.encode(c) : c;
}

/** Everything an async iterable yields. */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wall-clock milliseconds for timing assertions in tests (tests may read the clock; src/ may not). */
export const nowMs = (): number => performance.now();

/** The rejection of a promise (fails the test when it resolves). */
export async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

/** A ReadableStream that records cancellation and pulls (ends, errors, or stalls after the chunks). */
export function spiedStream(chunks: readonly (string | Uint8Array)[], then: 'end' | 'stall' | 'forever' | Error = 'end') {
  const state = { cancelled: false, pulled: 0, bytes: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[state.pulled];
      state.pulled++;
      if (next !== undefined) {
        const b = typeof next === 'string' ? enc.encode(next) : next;
        state.bytes += b.byteLength;
        controller.enqueue(b);
        return;
      }
      if (then === 'end') return controller.close();
      if (then instanceof Error) return controller.error(then);
      if (then === 'forever') {
        const b = new Uint8Array(16 * 1024).fill(0x78);
        state.bytes += b.byteLength;
        controller.enqueue(b);
        return;
      }
      return new Promise<void>(() => {}); // stall: only a cancel ends it
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** Fake fetch recording every call; `reply` decides the response for call n (0-based). */
export function fakeFetch(reply: (url: string, init: RequestInit & { timeout?: unknown }, n: number) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit & { timeout?: unknown } }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const i = (init ?? {}) as RequestInit & { timeout?: unknown };
    calls.push({ url, init: i });
    return reply(url, i, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

export const redirect = (status: number, location: string | null, body?: ReadableStream<Uint8Array>): Response =>
  new Response(body ?? null, { status, headers: location === null ? {} : { location } });
