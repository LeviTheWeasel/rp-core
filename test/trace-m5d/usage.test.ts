// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5d (D-213), the adapter's usage reading: the prompt counts and the fixed usageOfTimings. Rules
// after Bunraku src/core/tokens/usage.ts readTokenReport (702d8120): llama.cpp timings without
// cache_n never give the prompt total; OpenAI cached_tokens first; Ollama's prompt_n is no "new".
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createChatParser } from '../../src/providers/openai-chat.ts';
import type { ModelCaps, StreamEv } from '../../src/providers/types.ts';
import { capsAt, chunk, request } from '../adapter/kit.ts';

const LLAMA = capsAt('http://127.0.0.1:8080', 'm');
const OLLAMA = capsAt('http://127.0.0.1:11434', 'magmell-16k');

/** The usage events of one stream: the payloads, then [DONE]. */
function usageOf(payloads: readonly string[], caps: ModelCaps = LLAMA): StreamEv[] {
  const p = createChatParser(request({ caps }));
  const out: StreamEv[] = [];
  for (const d of payloads) out.push(...p.line(d));
  out.push(...p.line('[DONE]'), ...p.end());
  return out.filter((e) => e.t === 'usage');
}

const end = (extra: Record<string, unknown>): string => chunk({ content: 'x' }, 'stop', extra);

describe('llama.cpp timings', () => {
  test('with cache_n: the total, the cache read, and the prompt counts (processed = prompt_n)', () => {
    expect(usageOf([end({ timings: { prompt_n: 96, cache_n: 3412, predicted_n: 5 } })])).toEqual([
      { t: 'usage', u: { inputTotal: 3508, inputCacheRead: 3412, outputTotal: 5 }, prompt: { processed: 96, cached: 3412 } },
    ]);
  });

  test('cache_n 0 is a full prompt evaluation, not unknown', () => {
    expect(usageOf([end({ timings: { prompt_n: 4000, cache_n: 0, predicted_n: 1 } })])).toEqual([
      { t: 'usage', u: { inputTotal: 4000, inputCacheRead: 0, outputTotal: 1 }, prompt: { processed: 4000, cached: 0 } },
    ]);
  });

  test('without cache_n: prompt_n gives no total and no prompt counts (it was read as the total before M5d)', () => {
    expect(usageOf([end({ timings: { prompt_n: 96, predicted_n: 5 } })])).toEqual([{ t: 'usage', u: { outputTotal: 5 } }]);
  });

  test('without cache_n and with usage: the usage total stands, still no prompt counts', () => {
    expect(usageOf([end({ usage: { prompt_tokens: 3508, completion_tokens: 5 }, timings: { prompt_n: 96, predicted_n: 5 } })])).toEqual([
      { t: 'usage', u: { inputTotal: 3508, outputTotal: 5 } },
    ]);
  });

  test("usage's cached_tokens wins over the timings for the prompt counts", () => {
    const evs = usageOf([
      end({
        usage: { prompt_tokens: 3508, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3400 } },
        timings: { prompt_n: 96, cache_n: 3412, predicted_n: 5 },
      }),
    ]);
    expect(evs).toEqual([{ t: 'usage', u: { inputTotal: 3508, inputCacheRead: 3400, outputTotal: 5 }, prompt: { processed: 108, cached: 3400 } }]);
  });
});

describe('Ollama /v1 usage', () => {
  test('cached_tokens gives the counts: processed = prompt_tokens − cached', () => {
    const evs = usageOf(
      [chunk({ content: 'x' }, 'stop'), JSON.stringify({ choices: [], usage: { prompt_tokens: 3508, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3412 } } })],
      OLLAMA,
    );
    expect(evs).toEqual([{ t: 'usage', u: { inputTotal: 3508, inputCacheRead: 3412, outputTotal: 5 }, prompt: { processed: 96, cached: 3412 } }]);
  });

  test('without cached_tokens nothing is known about the cache', () => {
    expect(usageOf([end({ usage: { prompt_tokens: 3508, completion_tokens: 5 } })], OLLAMA)).toEqual([{ t: 'usage', u: { inputTotal: 3508, outputTotal: 5 } }]);
  });

  test("Ollama-shaped timings (prompt_n is the whole prompt, no cache_n) are never read as processed", () => {
    const evs = usageOf([end({ usage: { prompt_tokens: 3508, completion_tokens: 5 }, timings: { prompt_n: 3508, predicted_n: 5 } })], OLLAMA);
    expect(evs).toEqual([{ t: 'usage', u: { inputTotal: 3508, outputTotal: 5 } }]);
  });

  test('cached_tokens without prompt_tokens: only the cached part', () => {
    expect(usageOf([end({ usage: { completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10 } } })], OLLAMA)).toEqual([
      { t: 'usage', u: { inputCacheRead: 10, outputTotal: 5 }, prompt: { cached: 10 } },
    ]);
  });
});

describe('the usage event', () => {
  test('goes out again when only the prompt counts changed; an unchanged one is not repeated', () => {
    const evs = usageOf([
      chunk({ content: 'x' }, 'stop', { usage: { prompt_tokens: 50, completion_tokens: 1 } }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 1 }, timings: { prompt_n: 10, cache_n: 40, predicted_n: 1 } }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 1 }, timings: { prompt_n: 10, cache_n: 40, predicted_n: 1 } }),
    ]);
    expect(evs).toEqual([
      { t: 'usage', u: { inputTotal: 50, outputTotal: 1 } },
      { t: 'usage', u: { inputTotal: 50, inputCacheRead: 40, outputTotal: 1 }, prompt: { processed: 10, cached: 40 } },
    ]);
  });

  test('a later report without counts keeps the earlier counts', () => {
    const evs = usageOf([
      chunk({ content: 'x' }, null, { timings: { prompt_n: 10, cache_n: 40, predicted_n: 1 } }),
      end({ timings: { prompt_n: 10, predicted_n: 2 } }),
    ]);
    expect(evs.at(-1)).toEqual({ t: 'usage', u: { outputTotal: 2 }, prompt: { processed: 10, cached: 40 } });
  });
});

test('the adaptation is credited: the adapter header and PROVENANCE name usage.ts readTokenReport', () => {
  const root = new URL('../../', import.meta.url);
  const header = readFileSync(new URL('src/providers/openai-chat.ts', root), 'utf8').split('\n').slice(0, 12).join('\n');
  expect(header).toContain('// Adapted from Bunraku:src/core/tokens/usage.ts@702d8120 (readTokenReport');
  expect(header).toContain('e95d90db, 4cd5b724');
  const provenance = readFileSync(new URL('PROVENANCE.md', root), 'utf8');
  const row = provenance.split('\n').find((l) => l.startsWith('| `src/providers/openai-chat.ts`') && l.includes('src/core/tokens/usage.ts'));
  expect(row).toContain('`readTokenReport`');
  expect(row).toContain('| 702d8120 | adapt |');
  expect(provenance).not.toContain('`readTokenReport`, offsets and the reasoning fallback not ported');
});
