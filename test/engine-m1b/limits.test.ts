// Review M1b: what a turn asks of the server, and what it learns from the server's answer.
// - max_tokens is the reserve the budget held back (never more), capped by caps.maxOutput: once the
//   history fills its budget, prompt + max_tokens still fits the window (vLLM / OpenAI reject it
//   otherwise with a 400 the engine would misread as context_length_exceeded);
// - a server that reports far fewer prompt tokens than were sent cut the prompt (Ollama at num_ctx):
//   told once, and the call is no EMA sample;
// - the host's debug tap (EngineOptions.onProviderError) gets the raw failure, the event the fixed message.
import { describe, expect, test } from 'bun:test';
import { tokenFactorFor } from '../../src/engine/ema.ts';
import type { Event } from '../../src/protocol/events.ts';
import { replyReserve } from '../../src/prompt/budget.ts';
import { EMA_START } from '../../src/prompt/tokens.ts';
import { ProviderError, type ModelRequest, type StreamEv } from '../../src/providers/types.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { buildTree } from '../../src/session/tree.ts';
import { drain, MIRA, rig } from '../engine/kit.ts';
import { answer, fakeConn, fakeProvider } from './fake.ts';

const noticesOf = (evs: readonly Event[]): Extract<Event, { type: 'notice' }>[] => evs.filter((e): e is Extract<Event, { type: 'notice' }> => e.type === 'notice');

describe('max_tokens: the reserve, never more', () => {
  test('binding maxTokens 6000 on a 8192 window: 4096 is sent (what the budget held back), told once', async () => {
    const provider = fakeProvider(() => answer('ok'));
    const conn = fakeConn('v', provider, { caps: { contextLength: 8192 }, local: false, origin: 'http://10.0.0.5:8000' });
    const { engine } = await rig([], { connections: { v: conn } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'v', model: 'm', maxTokens: 6000 } } } });
    const evs: Event[] = [];
    for (const text of ['Hello.', 'Again.']) {
      const v = s.send({ text, expectedVersion: s.version() }).version;
      evs.push(...(await drain(s.runTurn({ kind: 'reply', expectedVersion: v }))));
    }
    expect(provider.requests.map((r) => r.maxTokens)).toEqual([4096, 4096]);
    expect(replyReserve(8192, 6000)).toBe(4096);
    const n = noticesOf(evs).filter((e) => e.code === 'max_tokens_reduced');
    expect(n).toHaveLength(1);
    expect(n[0]!.message).toContain('max_tokens 6000 does not fit');
    await engine.close();
  });

  test("caps.maxOutput caps it (and shrinks the reserve, so history gets the room); a binding within limits is sent as is", async () => {
    const provider = fakeProvider(() => answer('ok'));
    const conn = fakeConn('or', provider, {
      caps: { contextLength: 200_000 },
      perModel: { small: { contextLength: 200_000, maxOutput: 1000 }, big: { contextLength: 200_000 } },
      local: false,
      origin: 'https://openrouter.ai:443',
    });
    const { engine, home } = await rig([], { connections: { or: conn } });
    const a = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'or', model: 'small' } } } });
    let v = a.send({ text: 'Hello.', expectedVersion: a.version() }).version;
    const evs = await drain(a.runTurn({ kind: 'reply', expectedVersion: v }));
    expect(provider.requests[0]!.maxTokens).toBe(1000);
    // No explicit max_tokens: nothing was cut from the user's setting, so nothing to tell.
    expect(noticesOf(evs).map((e) => e.code)).not.toContain('max_tokens_reduced');
    const msg = readSessionFile(home, a.id).entries.find((e) => e.t === 'msg' && e.role === 'assistant' && e.trace);
    expect(msg && msg.t === 'msg' ? msg.trace?.reserve : undefined).toBe(1000);

    const b = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'or', model: 'small', maxTokens: 4000 } } } });
    v = b.send({ text: 'Hello.', expectedVersion: b.version() }).version;
    const evsB = await drain(b.runTurn({ kind: 'reply', expectedVersion: v }));
    expect(provider.requests[1]!.maxTokens).toBe(1000);
    expect(noticesOf(evsB).find((e) => e.code === 'max_tokens_reduced')?.message).toBe('max_tokens 4000 is above what or:small can write; 1000 is sent.');

    const c = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'or', model: 'big', maxTokens: 3000 } } } });
    v = c.send({ text: 'Hello.', expectedVersion: c.version() }).version;
    await drain(c.runTurn({ kind: 'reply', expectedVersion: v }));
    expect(provider.requests[2]!.maxTokens).toBe(3000);
    await engine.close();
  });
});

describe('a server that cut the prompt (reported ≪ estimated)', () => {
  /** Answers reporting `reported(req)` prompt tokens. */
  const reporting = (reported: (req: ModelRequest) => number) =>
    fakeProvider((req): StreamEv[] => answer('ok', { usage: { inputTotal: reported(req), outputTotal: 1 } }));
  const LONG = 'The rain keeps falling on the old roof. '.repeat(120); // ~1600 estimated tokens

  test('told once per session with what to do; the call is no EMA sample', async () => {
    const provider = reporting(() => 21); // Ollama kept 21 tokens of it
    const conn = fakeConn('ollama', provider, { local: true, origin: 'http://127.0.0.1:11434' });
    const { engine, home } = await rig([], { connections: { ollama: conn } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'ollama', model: 'mag' } } } });
    const evs: Event[] = [];
    for (let i = 0; i < 3; i++) {
      const v = s.send({ text: LONG, expectedVersion: s.version() }).version;
      evs.push(...(await drain(s.runTurn({ kind: 'reply', expectedVersion: v }))));
    }
    const told = noticesOf(evs).filter((e) => e.code === 'context_truncated_by_server');
    expect(told).toHaveLength(1);
    expect(told[0]!.level).toBe('warn');
    expect(told[0]!.message).toContain('[caps."ollama:mag"]');
    expect(told[0]!.message).toContain('rp-core probe ollama:mag');
    // Three poisoned samples on the path, and the factor is still the start value (not dragged to 0.8).
    const { entries } = readSessionFile(home, s.id);
    expect(tokenFactorFor(buildTree(entries), s.view(), 'mag')).toBe(EMA_START);
    await engine.close();
  });

  test('an ordinary report (ratio ~0.75) is not truncation', async () => {
    const provider = reporting((req) => Math.round(req.messages.reduce((n, m) => n + m.blocks.reduce((k, b) => k + ('text' in b ? b.text.length : 0), 0), 0) / 4));
    const conn = fakeConn('ollama', provider, { local: true, origin: 'http://127.0.0.1:11434' });
    const { engine } = await rig([], { connections: { ollama: conn } });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'ollama', model: 'mag' } } } });
    const v = s.send({ text: LONG, expectedVersion: s.version() }).version;
    const evs = await drain(s.runTurn({ kind: 'reply', expectedVersion: v }));
    expect(noticesOf(evs).map((e) => e.code)).not.toContain('context_truncated_by_server');
    await engine.close();
  });
});

describe('the debug tap', () => {
  test('onProviderError gets the raw failure (detail); the failed event only the fixed message', async () => {
    const raw = new ProviderError({ category: 'auth', code: 'auth_failed', status: 401, message: 'the server refused the API key (HTTP 401)', detail: 'Incorrect API key: sk-SECRET' });
    const provider = fakeProvider((): StreamEv[] => [{ t: 'error', err: raw, afterOutput: false }]);
    const conn = fakeConn('r', provider, { local: false, origin: 'https://api.example.com:443' });
    const seen: { callKey: string; model: string; detail?: string }[] = [];
    const { engine } = await rig([], {
      connections: { r: conn },
      extra: { onProviderError: (i) => seen.push({ callKey: i.callKey, model: i.model, ...(i.error.detail !== undefined ? { detail: i.error.detail } : {}) }) },
    });
    const s = engine.createSession({ character: MIRA, config: { roles: { narrator: { conn: 'r', model: 'm' } } } });
    const v = s.send({ text: 'Hello.', expectedVersion: s.version() }).version;
    const t = s.runTurn({ kind: 'reply', expectedVersion: v });
    const evs = await drain(t);
    expect(seen).toEqual([{ callKey: `${t.turnId}:narrator:0`, model: 'r:m', detail: 'Incorrect API key: sk-SECRET' }]);
    const failed = evs.find((e) => e.type === 'failed');
    expect(failed && failed.type === 'failed' ? failed.message : '').toBe('the server refused the API key (HTTP 401)');
    expect(JSON.stringify(evs)).not.toContain('sk-SECRET');
    await engine.close();
  });
});
