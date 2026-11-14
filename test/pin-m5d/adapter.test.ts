// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5d (D-211), the adapter side of slot pinning: `slot_pin` in config, the caps key, and `id_slot`
// in the openai-chat body by agent, under the connection's own extra_body / exclude_body (D-53).
// The wire is checked against a Bun.serve fake of llama.cpp that records each body's id_slot.
import { afterAll, describe, expect, test } from 'bun:test';
import { CONFIG_TEMPLATE, parseConfig, ConfigError } from '../../src/config/config.ts';
import { mergeCaps, resolveCaps } from '../../src/providers/caps.ts';
import { buildChatRequest, createOpenAIChatProvider, type OpenAIChatOptions } from '../../src/providers/openai-chat.ts';
import type { CallAgent, ModelCaps, StreamEv } from '../../src/providers/types.ts';
import { capsAt, request } from '../adapter/kit.ts';

const LLAMA = capsAt('http://127.0.0.1:8080', 'm');
const PINNED: ModelCaps = mergeCaps(LLAMA, { slotPin: { narrator: 0, agents: 1 } }, 'user');
const OPTS: OpenAIChatOptions = { connectionId: 'local', baseUrl: 'http://127.0.0.1:8080', local: true };
const AGENTS: CallAgent[] = ['narrator', 'director', 'recall', 'filing', 'historian'];

const bodyOf = (caps: ModelCaps, agent: CallAgent, o: OpenAIChatOptions = OPTS): Record<string, unknown> =>
  JSON.parse(buildChatRequest(request({ caps, agent }), o, null).body ?? '{}') as Record<string, unknown>;

describe('slot_pin in config', () => {
  const conf = (line: string) => parseConfig(`[connections.local]\nbase_url = "http://127.0.0.1:8080"\n\n[caps."local:m"]\n${line}\n`, null);

  test('true pins the narrator to 0 and the agents to 1; false is an explicit never (null), not unset', () => {
    expect(conf('slot_pin = true').caps['local:m']).toEqual({ slotPin: { narrator: 0, agents: 1 } });
    expect(conf('slot_pin = false').caps['local:m']).toEqual({ slotPin: null });
    expect('slotPin' in conf('tools = "native"').caps['local:m']!).toBe(false);
  });

  test('the template names it (commented out) and still parses', () => {
    expect(CONFIG_TEMPLATE).toContain('\n# slot_pin = true ');
    expect(parseConfig(CONFIG_TEMPLATE, null).caps).toEqual({});
  });

  test('anything but a boolean is refused', () => {
    expect(() => conf('slot_pin = 1')).toThrow(ConfigError);
    expect(() => conf('slot_pin = "yes"')).toThrow(ConfigError);
  });

  test('the override survives the caps fold, null included', () => {
    const at = { dialect: 'openai-chat' as const, origin: 'http://127.0.0.1:8080', local: true, model: 'm' };
    expect(resolveCaps(at).slotPin).toBeUndefined();
    expect(resolveCaps({ ...at, user: { slotPin: { narrator: 0, agents: 1 } } }).slotPin).toEqual({ narrator: 0, agents: 1 });
    expect(resolveCaps({ ...at, user: { slotPin: null } }).slotPin).toBeNull();
    // A later patch replaces an earlier one either way.
    expect(mergeCaps(PINNED, { slotPin: null }).slotPin).toBeNull();
    expect(mergeCaps(mergeCaps(LLAMA, { slotPin: null }), { slotPin: { narrator: 0, agents: 1 } }).slotPin).toEqual({ narrator: 0, agents: 1 });
  });
});

describe('id_slot in the body', () => {
  test('by agent: the narrator gets slotPin.narrator, every other agent slotPin.agents', () => {
    expect(AGENTS.map((a) => bodyOf(PINNED, a).id_slot)).toEqual([0, 1, 1, 1, 1]);
    const odd = mergeCaps(LLAMA, { slotPin: { narrator: 3, agents: 2 } });
    expect(AGENTS.map((a) => bodyOf(odd, a).id_slot)).toEqual([3, 2, 2, 2, 2]);
  });

  test('no id_slot without slotPin, and none for slotPin null', () => {
    for (const a of AGENTS) {
      expect('id_slot' in bodyOf(LLAMA, a)).toBe(false);
      expect('id_slot' in bodyOf(mergeCaps(LLAMA, { slotPin: null }), a)).toBe(false);
    }
  });

  test("the connection's extra_body and exclude_body, and the model's extra_body id_slot, still win", () => {
    expect(bodyOf(PINNED, 'narrator', { ...OPTS, overrides: { extraBody: { id_slot: 5 } } }).id_slot).toBe(5);
    expect(bodyOf(PINNED, 'director', { ...OPTS, overrides: { extraBody: { id_slot: 5 } } }).id_slot).toBe(5);
    expect('id_slot' in bodyOf(PINNED, 'narrator', { ...OPTS, overrides: { excludeBody: ['id_slot'] } })).toBe(false);
    // An id_slot in the model's own extra_body ([caps."conn:model"]) is the user's too: the pin never replaces it.
    const hand = mergeCaps(PINNED, { extraBody: { id_slot: 7 } }, 'user');
    expect(AGENTS.map((a) => bodyOf(hand, a).id_slot)).toEqual([7, 7, 7, 7, 7]);
    expect(bodyOf(mergeCaps(LLAMA, { extraBody: { id_slot: 2 } }, 'user'), 'narrator').id_slot).toBe(2);
  });
});

describe('against a llama.cpp fake', () => {
  const seen: unknown[] = [];
  const sse = (...chunks: unknown[]): string => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      seen.push('id_slot' in body ? body.id_slot : 'none');
      return new Response(
        sse(
          { choices: [{ index: 0, delta: { content: 'ok' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], timings: { cache_n: 900, prompt_n: 12, predicted_n: 1 } },
        ),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  });
  afterAll(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;

  async function call(caps: ModelCaps, agent: CallAgent): Promise<StreamEv[]> {
    const p = createOpenAIChatProvider({ connectionId: 'local', baseUrl: base, local: true });
    const out: StreamEv[] = [];
    for await (const ev of p.stream(request({ caps, agent }), { fetch, key: null })) out.push(ev);
    return out;
  }

  test('each body carries its agent\'s slot; the usage event carries the prompt counts', async () => {
    seen.length = 0;
    const evs = await call(PINNED, 'narrator');
    await call(PINNED, 'director');
    await call(PINNED, 'filing');
    await call(LLAMA, 'narrator');
    expect(seen).toEqual([0, 1, 1, 'none']);
    expect(evs.find((e) => e.t === 'usage')).toEqual({
      t: 'usage',
      u: { inputTotal: 912, inputCacheRead: 900, outputTotal: 1 },
      prompt: { processed: 12, cached: 900 },
    });
  });
});
