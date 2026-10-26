// Live smoke test against the user's own Ollama: SKIPPED unless RP_CORE_LIVE=1.
//   RP_CORE_LIVE=1 bun test test/adapter/live-ollama.test.ts
// It only streams a short reply (max_tokens 64) from a model that is already installed; it never
// pulls, creates or deletes models. Caps come from the shipped Ollama host preset.
import { describe, expect, test } from 'bun:test';
import { createOpenAIChatProvider } from '../../src/providers/openai-chat.ts';
import type { StreamEv } from '../../src/providers/types.ts';
import { capsAt, msg, request, textsOf } from './kit.ts';

const LIVE = process.env.RP_CORE_LIVE === '1';
const BASE = process.env.RP_CORE_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.RP_CORE_OLLAMA_MODEL ?? 'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M';

describe.skipIf(!LIVE)('live: Ollama openai-chat stream', () => {
  test(
    'a short reply streams text, then a finish naming the model, then the usage chunk Ollama sends after it',
    async () => {
      const provider = createOpenAIChatProvider({ connectionId: 'ollama', baseUrl: `${BASE}/v1`, local: true });
      const caps = capsAt('http://127.0.0.1:11434', MODEL);
      const req = request({
        model: { connection: 'ollama', model: MODEL },
        caps,
        messages: [
          msg('system', 'You are Mara, a terse tavern keeper in a fantasy roleplay. Answer in one or two sentences.'),
          msg('user', 'I shake off the rain and ask for a room.'),
        ],
        maxTokens: 64,
        samplers: { temperature: 0.7, seed: 7 },
        signal: AbortSignal.timeout(170_000),
      });
      const events: StreamEv[] = [];
      for await (const ev of provider.stream(req, { fetch, key: null })) events.push(ev);

      const errors = events.filter((e) => e.t === 'error');
      if (errors.length > 0) throw (errors[0] as Extract<StreamEv, { t: 'error' }>).err;
      const { text } = textsOf(events);
      const finish = events.find((e) => e.t === 'finish');
      const usage = events.find((e) => e.t === 'usage');
      // Visible in the test output, for the record.
      console.log(
        JSON.stringify({ textEvents: events.filter((e) => e.t === 'text').length, text, usage: usage?.t === 'usage' ? usage.u : null, finish }, null, 2),
      );

      expect(events.filter((e) => e.t === 'text').length).toBeGreaterThan(1);
      expect(text.trim().length).toBeGreaterThan(0);
      expect(finish?.t).toBe('finish');
      if (finish?.t === 'finish') {
        expect(['end', 'length']).toContain(finish.reason);
        expect(finish.model).toBe(MODEL);
      }
      expect(usage?.t).toBe('usage');
      if (usage?.t === 'usage') {
        expect(usage.u.inputTotal).toBeGreaterThan(0);
        expect(usage.u.outputTotal).toBeGreaterThan(0);
        expect(usage.u.outputTotal!).toBeLessThanOrEqual(64);
      }
      // The finish goes out with the finish_reason chunk; Ollama's usage (a choices:[] chunk) follows it.
      expect(events.findIndex((e) => e.t === 'finish')).toBeLessThan(events.findIndex((e) => e.t === 'usage'));
      expect(events.at(-1)?.t).toBe('usage');
    },
    180_000,
  );
});
