// The real openai-chat adapter inside the real engine, against local Bun.serve mocks (review M1b):
// - §8.8 first-byte / idle timeouts are about BYTES: SSE keep-alive comments (OpenRouter's
//   ': OPENROUTER PROCESSING', DeepSeek's ': keep-alive', llama.cpp's ':' pings) keep a live server's
//   call open, although they carry no event;
// - the finish is delivered with the chunk that carries finish_reason, so a stall, a Stop or an error
//   between it and [DONE] costs only the usage (the answer commits with the provider's finish).
import { afterAll, describe, expect, test } from 'bun:test';
import type { Connection, TurnOutcome } from '../../src/engine/api.ts';
import { createOpenAIChatProvider } from '../../src/providers/openai-chat.ts';
import { resolveCaps } from '../../src/providers/caps.ts';
import { originOf } from '../../src/providers/http.ts';
import type { Event } from '../../src/protocol/events.ts';
import { drain, MIRA, rig, types } from '../engine/kit.ts';

const enc = new TextEncoder();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Handler = (req: Request) => Response | Promise<Response>;
let handler: Handler = () => new Response('x', { status: 500 });
// idleTimeout 0: Bun.serve would otherwise close a socket that is silent mid-body after 10 s.
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    await req.text();
    return handler(req);
  },
});
afterAll(() => server.stop(true));
const BASE = `http://127.0.0.1:${server.port}`;
const SSE = { 'content-type': 'text/event-stream' };
const data = (o: unknown): string => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
const delta = (d: object, finish: string | null = null): object => ({ choices: [{ index: 0, delta: d, finish_reason: finish }], model: 'served' });

/** A body of parts sent at their times (ms from the start); 'stall' never closes. */
function body(parts: { at: number; s: string }[], then: 'end' | 'stall' = 'end'): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(c) {
      const t0 = performance.now();
      for (const p of parts) {
        const wait = p.at - (performance.now() - t0);
        if (wait > 0) await sleep(wait);
        try {
          c.enqueue(enc.encode(p.s));
        } catch {
          return; // the client went away
        }
      }
      if (then === 'end') c.close();
      else await new Promise(() => {});
    },
  });
}

/** `comment` every `every` ms from `from` to `to` (exclusive). */
function comments(comment: string, from: number, to: number, every: number): { at: number; s: string }[] {
  const out: { at: number; s: string }[] = [];
  for (let at = from; at < to; at += every) out.push({ at, s: comment });
  return out;
}

function conn(): Connection {
  return {
    id: 'mock',
    provider: createOpenAIChatProvider({ connectionId: 'mock', baseUrl: BASE, local: true }),
    caps: resolveCaps({ dialect: 'openai-chat', origin: originOf(BASE), local: true, model: 'm' }),
    origin: originOf(BASE),
    local: true,
    dialect: 'openai-chat',
    baseUrl: BASE,
  };
}

async function turn(opts: { firstByteMs: number; idleMs: number; stopAfterMs?: number }): Promise<{ evs: Event[]; result: TurnOutcome }> {
  const { engine } = await rig([], {
    connections: { mock: conn() },
    extra: { timeouts: { firstByteMs: opts.firstByteMs, idleMs: opts.idleMs }, retryMaxDelayMs: 5 },
  });
  try {
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'mock', model: 'm' } } } });
    const v = s.send({ text: 'Hello.', expectedVersion: s.version() }).version;
    const t = s.runTurn({ kind: 'reply', expectedVersion: v });
    if (opts.stopAfterMs !== undefined) setTimeout(() => t.stop(), opts.stopAfterMs);
    const evs = await drain(t);
    return { evs, result: await t.result };
  } finally {
    await engine.close();
  }
}

const notices = (evs: readonly Event[]): string[] => evs.flatMap((e) => (e.type === 'notice' ? [e.code] : []));

describe('§8.8: timeouts are measured on bytes, keep-alive comments included', () => {
  test('keep-alive comments for longer than both timeouts before the first token: the answer arrives', async () => {
    handler = () =>
      new Response(body([...comments(': OPENROUTER PROCESSING\n\n', 0, 700, 50), { at: 750, s: data(delta({ content: 'Hello there.' }, 'stop')) }, { at: 760, s: data('[DONE]') }]), {
        headers: SSE,
      });
    const { result } = await turn({ firstByteMs: 300, idleMs: 300 });
    expect(result.type).toBe('done');
  });

  test("llama.cpp-style ':' pings mid-answer keep the idle timer from firing", async () => {
    handler = () =>
      new Response(
        body([{ at: 0, s: data(delta({ content: 'Part one, ' })) }, ...comments(':\n\n', 50, 650, 50), { at: 700, s: data(delta({ content: 'part two.' }, 'stop')) }, { at: 710, s: data('[DONE]') }]),
        { headers: SSE },
      );
    const { result } = await turn({ firstByteMs: 2000, idleMs: 250 });
    expect(result.type).toBe('done');
    if (result.type === 'done') expect(result.message.blocks).toEqual([{ k: 'text', text: 'Part one, part two.' }]);
  });

  test('one early comment, then a quiet prompt: the first-byte allowance still holds (idle alone does not end it)', async () => {
    handler = () => new Response(body([{ at: 0, s: ': ping\n\n' }, { at: 450, s: data(delta({ content: 'Late but fine.' }, 'stop')) }, { at: 460, s: data('[DONE]') }]), { headers: SSE });
    const { result } = await turn({ firstByteMs: 900, idleMs: 150 });
    expect(result.type).toBe('done');
  });

  test('comments, then silence past both deadlines: a timeout, reported as no response (never a Stop)', async () => {
    handler = () => new Response(body([{ at: 0, s: ': keep-alive\n\n' }], 'stall'), { headers: SSE });
    const { result } = await turn({ firstByteMs: 200, idleMs: 150 });
    expect(result.type).toBe('failed');
    if (result.type === 'failed') expect([result.code, result.message]).toEqual(['timeout', 'no response from the model in time']);
  });

  test('a silent server is still timed out at the first-byte deadline', async () => {
    handler = async () => {
      await sleep(600);
      return new Response(data(delta({ content: 'late' }, 'stop')) + data('[DONE]'), { headers: SSE });
    };
    const { result } = await turn({ firstByteMs: 150, idleMs: 150 });
    expect(result.type === 'failed' && result.code).toBe('timeout');
  });

  test('text, then silence: the idle timeout (no comments to keep it alive)', async () => {
    handler = () => new Response(body([{ at: 0, s: data(delta({ content: 'Partial words' })) }], 'stall'), { headers: SSE });
    const { result } = await turn({ firstByteMs: 2000, idleMs: 150 });
    expect(result.type).toBe('failed');
    if (result.type === 'failed') expect([result.code, result.message]).toEqual(['timeout', 'the model stopped sending']);
  });
});

describe('between finish_reason and [DONE]: the finished answer is kept', () => {
  const finished = [
    { at: 0, s: data(delta({ content: 'A whole answer.' })) },
    { at: 10, s: data(delta({}, 'stop')) },
  ];

  test('a stall after finish_reason: done with the provider finish, told as a tail failure', async () => {
    handler = () => new Response(body(finished, 'stall'), { headers: SSE });
    const { evs, result } = await turn({ firstByteMs: 2000, idleMs: 200 });
    expect(result.type).toBe('done');
    if (result.type === 'done') expect(result.message.gen?.finish).toBe('end');
    expect(notices(evs)).toEqual(['stream_tail_failed']);
  });

  test('a Stop after finish_reason, before [DONE]: done with finish end (not stopped), nothing reported as failed', async () => {
    handler = () => new Response(body(finished, 'stall'), { headers: SSE });
    const { evs, result } = await turn({ firstByteMs: 2000, idleMs: 5000, stopAfterMs: 200 });
    expect(types(evs)).toEqual(['start', 'text', 'changed', 'done']);
    expect(result.type).toBe('done');
    if (result.type === 'done') expect(result.message.gen?.finish).toBe('end');
  });

  test('an error object after finish_reason is a tail failure, not a failed answer', async () => {
    handler = () => new Response(body([...finished, { at: 20, s: data({ error: { message: 'usage accounting failed' } }) }]), { headers: SSE });
    const { evs, result } = await turn({ firstByteMs: 2000, idleMs: 2000 });
    expect(result.type).toBe('done');
    expect(notices(evs)).toEqual(['stream_tail_failed']);
  });
});
