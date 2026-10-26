// caps.ts: the pessimistic record, the fold order with its source trail, glob matching, maxInFlight
// rules [D-84], and spot checks of the shipped hosts.json / models.json rows [D-54].
import { describe, expect, test } from 'bun:test';
import {
  HOST_ROWS,
  MODEL_ROWS,
  checkCapsRows,
  globMatch,
  mergeCaps,
  pessimisticCaps,
  resolveCaps,
  resolveCapsWith,
  type CapsInput,
  type CapsRow,
} from '../../src/providers/caps.ts';
import { DEFAULT_REASONING_TAGS } from '../../src/providers/reasoning-tags.ts';
import type { ModelCaps } from '../../src/providers/types.ts';
import hostsFile from '../../src/providers/caps-data/hosts.json' with { type: 'json' };
import modelsFile from '../../src/providers/caps-data/models.json' with { type: 'json' };

const LLAMA = 'http://127.0.0.1:8080';
const OLLAMA = 'http://127.0.0.1:11434';
const OPENROUTER = 'https://openrouter.ai:443';

function input(over: Partial<CapsInput>): CapsInput {
  return { dialect: 'openai-chat', origin: 'https://llm.example.com:443', local: false, model: 'mystery-model', ...over };
}

describe('pessimisticCaps', () => {
  test('an unknown openai-chat model gets the record that cannot 400', () => {
    const caps = pessimisticCaps('openai-chat', false);
    expect(caps).toEqual({
      dialect: 'openai-chat',
      maxTokensField: 'max_tokens',
      tools: 'prompted',
      toolChoice: ['auto', 'none'],
      toolChoiceHonored: false,
      parallelToolCalls: 'never',
      strictTools: false,
      structuredOutput: { mode: 'none' },
      midSystem: 'as-user',
      alternation: 'strict',
      prefill: 'none',
      reasoning: { output: 'tags', tags: [...DEFAULT_REASONING_TAGS], control: 'none', canDisable: false, echo: 'never' },
      samplers: { accepted: ['temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'frequency_penalty', 'presence_penalty'] },
      streamUsage: 'none',
      caching: 'none',
      maxInFlight: 4,
      source: [],
    });
    expect(pessimisticCaps('openai-chat', true).maxInFlight).toBe(1);
  });

  test('every call returns fresh objects', () => {
    const a = pessimisticCaps('openai-chat', true);
    a.reasoning.tags!.push('<x>');
    a.samplers.accepted.length = 0;
    a.source.push('user');
    const b = pessimisticCaps('openai-chat', true);
    expect(b.reasoning.tags).toEqual([...DEFAULT_REASONING_TAGS]);
    expect(b.samplers.accepted.length).toBe(7);
    expect(b.source).toEqual([]);
  });

  test('resolveCaps of an unknown model on an unknown host is exactly the pessimistic record', () => {
    expect(resolveCaps(input({}))).toEqual(pessimisticCaps('openai-chat', false));
    expect(resolveCaps(input({ origin: 'http://192.168.1.20:9999', local: true }))).toEqual(pessimisticCaps('openai-chat', true));
  });
});

describe('globMatch', () => {
  test('case-insensitive over the whole id', () => {
    expect(globMatch('*qwen3*', 'Qwen/QWEN3-14B-Instruct')).toBe(true);
    expect(globMatch('qwen3*', 'qwen/qwen3-14b')).toBe(false);
    expect(globMatch('gpt-5*', 'GPT-5-mini')).toBe(true);
  });

  test('* crosses slashes, ? is one character, . is literal', () => {
    expect(globMatch('*claude*', 'anthropic/claude-3.5-sonnet')).toBe(true);
    expect(globMatch('o?-mini', 'o3-mini')).toBe(true);
    expect(globMatch('o?-mini', 'o33-mini')).toBe(false);
    expect(globMatch('gpt-5.[1-9]*', 'gpt-5.1-codex')).toBe(true);
    expect(globMatch('gpt-5.[1-9]*', 'gpt-5x1')).toBe(false);
  });

  test('classes, negated classes and {a,b} alternatives', () => {
    expect(globMatch('*claude-opus-4[.-][0-5]*', 'anthropic/claude-opus-4.5')).toBe(true);
    expect(globMatch('*claude-opus-4[.-][0-5]*', 'claude-opus-4-1-20250805')).toBe(true);
    expect(globMatch('*claude-opus-4[.-][0-5]*', 'anthropic/claude-opus-4.6')).toBe(false);
    expect(globMatch('v[!0-4]', 'v7')).toBe(true);
    expect(globMatch('v[!0-4]', 'v3')).toBe(false);
    expect(globMatch('*{mistral,mixtral}*', 'mistralai/Mixtral-8x7B')).toBe(true);
    expect(globMatch('*{mistral,mixtral}*', 'MN-12B-Mag-Mell-R1')).toBe(false);
    expect(globMatch('a+b(c)', 'a+b(c)')).toBe(true);
  });
});

describe('mergeCaps', () => {
  const base = pessimisticCaps('openai-chat', true);

  test('reasoning, samplers, structuredOutput merged; arrays replaced; source appended once', () => {
    const merged = mergeCaps(
      base,
      {
        reasoning: { control: 'toggle' } as ModelCaps['reasoning'],
        samplers: { accepted: ['temperature'], wire: { repetition_penalty: 'repeat_penalty' } },
        structuredOutput: { mode: 'json_schema', confirmedBy: 'host' },
        toolChoice: ['auto'],
      },
      'host',
    );
    expect(merged.reasoning).toEqual({ ...base.reasoning, control: 'toggle' });
    expect(merged.samplers).toEqual({ accepted: ['temperature'], wire: { repetition_penalty: 'repeat_penalty' } });
    expect(merged.structuredOutput).toEqual({ mode: 'json_schema', confirmedBy: 'host' });
    expect(merged.toolChoice).toEqual(['auto']);
    expect(merged.source).toEqual(['host']);
    const again = mergeCaps(merged, { samplers: { accepted: ['top_k'], wire: { typical_p: 'typical' } } } as Partial<ModelCaps>, 'host');
    expect(again.samplers).toEqual({ accepted: ['top_k'], wire: { repetition_penalty: 'repeat_penalty', typical_p: 'typical' } });
    expect(again.source).toEqual(['host']);
  });

  test('extraBody deep-merges objects and replaces arrays', () => {
    const a = mergeCaps(base, { extraBody: { provider: { allow_fallbacks: false }, list: [1, 2] } });
    const b = mergeCaps(a, { extraBody: { provider: { order: ['x'] }, list: [3] } });
    expect(b.extraBody).toEqual({ provider: { allow_fallbacks: false, order: ['x'] }, list: [3] });
  });

  test('switching structured output off forgets who confirmed it', () => {
    const on = mergeCaps(base, { structuredOutput: { mode: 'json_schema', confirmedBy: 'host' } });
    expect(mergeCaps(on, { structuredOutput: { mode: 'none' } }).structuredOutput).toEqual({ mode: 'none' });
  });

  test('dialect, source, unknown keys and undefined values are never patched; empty patches leave no trail', () => {
    const patch = { dialect: 'anthropic', source: ['user'], bogus: 1, contextLength: undefined } as unknown as Partial<ModelCaps>;
    const merged = mergeCaps(base, patch, 'user');
    expect(merged).toEqual(base);
    expect('bogus' in merged).toBe(false);
    expect(mergeCaps(base, {}, 'catalog').source).toEqual([]);
  });

  test('the result never aliases the base or the patch', () => {
    const patch: Partial<ModelCaps> = { samplers: { accepted: ['temperature'] }, extraBody: { a: { b: 1 } } };
    const merged = mergeCaps(base, patch, 'model');
    merged.samplers.accepted.push('top_k');
    (merged.extraBody!['a'] as Record<string, number>)['b'] = 2;
    merged.reasoning.tags!.push('<x>');
    expect(patch.samplers!.accepted).toEqual(['temperature']);
    expect(patch.extraBody).toEqual({ a: { b: 1 } });
    expect(base.reasoning.tags).toEqual([...DEFAULT_REASONING_TAGS]);
    expect(base.source).toEqual([]);
  });
});

describe('resolveCaps: order and source trail', () => {
  const hosts: CapsRow[] = [
    { name: 'h', match: { port: 7000, server: 'toy' }, as_of: '2026-10-26', src: 'test', caps: { contextLength: 1, midSystem: 'native', stopMax: 9 } },
  ];
  const models: CapsRow[] = [
    { match: '*toy*', as_of: '2026-10-26', src: 'test', caps: { contextLength: 2, prefill: 'assistant-last' } },
    { match: '*TOY-B*', as_of: '2026-10-26', src: 'test', caps: { contextLength: 3 } },
  ];
  const base = { dialect: 'openai-chat' as const, origin: 'http://127.0.0.1:7000', local: true, model: 'my-toy-b' };

  test('hosts → models (file order) → catalog → probe → user, later wins', () => {
    const steps: [Partial<CapsInput>, number, ModelCaps['source']][] = [
      [{}, 3, ['host', 'model']],
      [{ catalog: { contextLength: 4 } }, 4, ['host', 'model', 'catalog']],
      [{ catalog: { contextLength: 4 }, probe: { contextLength: 5 } }, 5, ['host', 'model', 'catalog', 'probe']],
      [{ catalog: { contextLength: 4 }, probe: { contextLength: 5 }, user: { contextLength: 6 } }, 6, ['host', 'model', 'catalog', 'probe', 'user']],
      [{ user: { contextLength: 6 }, catalog: { contextLength: 4 } }, 6, ['host', 'model', 'catalog', 'user']],
    ];
    for (const [extra, ctx, trail] of steps) {
      const caps = resolveCapsWith({ ...base, ...extra }, hosts, models);
      expect(caps.contextLength).toBe(ctx);
      expect(caps.source).toEqual(trail);
      // Fields nobody overrode survive from earlier layers.
      expect(caps.midSystem).toBe('native');
      expect(caps.prefill).toBe('assistant-last');
      expect(caps.stopMax).toBe(9);
    }
  });

  test('model globs are case-insensitive; a non-matching model keeps only the host layer', () => {
    expect(resolveCapsWith({ ...base, model: 'MY-TOY-B' }, hosts, models).contextLength).toBe(3);
    const other = resolveCapsWith({ ...base, model: 'something-else' }, hosts, models);
    expect(other.contextLength).toBe(1);
    expect(other.source).toEqual(['host']);
  });

  test('a pure fold: same input, same output; inputs untouched', () => {
    const user: Partial<ModelCaps> = { samplers: { accepted: ['temperature'] } };
    const a = resolveCapsWith({ ...base, user }, hosts, models);
    const b = resolveCapsWith({ ...base, user }, hosts, models);
    expect(a).toEqual(b);
    a.samplers.accepted.push('x');
    expect(user).toEqual({ samplers: { accepted: ['temperature'] } });
    expect(hosts[0]!.caps).toEqual({ contextLength: 1, midSystem: 'native', stopMax: 9 });
  });
});

describe('resolveCaps: host matching', () => {
  test('a port guesses the server only on a local origin', () => {
    expect(resolveCaps(input({ origin: LLAMA, local: true })).source).toEqual(['host']);
    expect(resolveCaps(input({ origin: LLAMA, local: true })).extraBody).toEqual({ cache_prompt: true });
    const remote = resolveCaps(input({ origin: 'https://gpu.example.com:8080', local: false }));
    expect(remote.source).toEqual([]);
    expect(remote.extraBody).toBeUndefined();
  });

  test('a reported server beats the port guess', () => {
    const caps = resolveCaps(input({ origin: LLAMA, local: true, server: 'ollama' }));
    expect(caps.toolChoiceHonored).toBe(false);
    expect(caps.streamUsage).toBe('stream_options');
    expect(caps.extraBody).toBeUndefined(); // no llama.cpp cache_prompt on an Ollama server
    // 'unknown' means nothing was reported: the port guess applies again.
    expect(resolveCaps(input({ origin: LLAMA, local: true, server: 'unknown' })).extraBody).toEqual({ cache_prompt: true });
  });

  test('a server-only row (vLLM) applies on any port, remote too', () => {
    const caps = resolveCaps(input({ origin: 'https://gpu.example.com:443', server: 'vllm' }));
    expect(caps.samplers.accepted).toContain('repetition_penalty');
    expect(caps.samplers.wire).toBeUndefined();
    expect(caps.source).toEqual(['host']);
  });

  test('hostname rows match the hostname whatever the server', () => {
    const caps = resolveCaps(input({ origin: OPENROUTER, model: 'x/unknown' }));
    expect(caps.extraBody).toEqual({ provider: { allow_fallbacks: false } });
    expect(caps.streamUsage).toBe('always');
  });

  test('rows are limited to their dialect', () => {
    const caps = resolveCaps(input({ dialect: 'anthropic', origin: OPENROUTER }));
    expect(caps).toEqual(pessimisticCaps('anthropic', false));
  });
});

describe('resolveCaps: maxInFlight [D-84]', () => {
  test('1 local / 4 remote by default', () => {
    expect(resolveCaps(input({ origin: LLAMA, local: true })).maxInFlight).toBe(1);
    expect(resolveCaps(input({ origin: OPENROUTER })).maxInFlight).toBe(4);
  });

  test("the connection's explicit value is final, above or below the default", () => {
    expect(resolveCaps(input({ origin: LLAMA, local: true, maxInFlight: 2 })).maxInFlight).toBe(2);
    expect(resolveCaps(input({ origin: OPENROUTER, maxInFlight: 1, catalog: { maxInFlight: 3 } })).maxInFlight).toBe(1);
  });

  test('no data source raises capacity; a source may lower it', () => {
    const raised = resolveCaps(input({ origin: LLAMA, local: true, catalog: { maxInFlight: 4 }, probe: { maxInFlight: 4 }, user: { maxInFlight: 8 } }));
    expect(raised.maxInFlight).toBe(1);
    expect(resolveCaps(input({ origin: OPENROUTER, probe: { maxInFlight: 8 } })).maxInFlight).toBe(4);
    expect(resolveCaps(input({ origin: OPENROUTER, catalog: { maxInFlight: 1 } })).maxInFlight).toBe(1);
  });

  test('garbage explicit values fall back to the default', () => {
    expect(resolveCaps(input({ origin: LLAMA, local: true, maxInFlight: 0 })).maxInFlight).toBe(1);
    expect(resolveCaps(input({ origin: OPENROUTER, maxInFlight: 1.5 })).maxInFlight).toBe(4);
  });
});

describe('shipped caps-data', () => {
  test('both files are sound: as_of and src on every row, known keys and samplers, globs compile', () => {
    expect(checkCapsRows(HOST_ROWS, 'hosts')).toEqual([]);
    expect(checkCapsRows(MODEL_ROWS, 'models')).toEqual([]);
    expect(hostsFile.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(modelsFile.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(HOST_ROWS.length).toBeGreaterThanOrEqual(9);
    expect(MODEL_ROWS.length).toBeGreaterThanOrEqual(10);
  });

  test('checkCapsRows catches broken rows', () => {
    const bad = [
      { match: '*x*', as_of: '26.10.2026', src: '', caps: { samplers: { accepted: ['top_q'] }, nope: 1 } },
      { match: { port: 1 }, as_of: '2026-10-26', src: 's', caps: {} },
    ] as unknown as CapsRow[];
    expect(checkCapsRows(bad, 'models').length).toBe(5);
    expect(checkCapsRows(bad.slice(1), 'hosts')).toEqual(['hosts[0]: match needs hostname or server']);
  });

  test('llama.cpp :8080', () => {
    const c = resolveCaps(input({ origin: LLAMA, local: true, model: 'mag-mell-12b' }));
    expect(c.midSystem).toBe('native');
    expect(c.alternation).toBe('free');
    expect(c.prefill).toBe('assistant-last');
    expect(c.parallelToolCalls).toBe('send-true');
    expect(c.samplers.accepted).toEqual(expect.arrayContaining(['top_k', 'min_p', 'typical_p', 'repetition_penalty']));
    expect(c.samplers.wire).toEqual({ repetition_penalty: 'repeat_penalty' });
    expect(c.streamUsage).toBe('timings');
    expect(c.extraBody).toEqual({ cache_prompt: true });
    expect(c.tools).toBe('prompted'); // [D-15] a host preset never claims native tools for an unknown template
  });

  test('Ollama :11434 claims only what /v1 reads', () => {
    const c = resolveCaps(input({ origin: OLLAMA, local: true, model: 'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M' }));
    expect(c.toolChoiceHonored).toBe(false);
    expect(c.prefill).toBe('assistant-last');
    expect(c.streamUsage).toBe('stream_options');
    expect(c.samplers.accepted).not.toContain('top_k');
    expect(c.samplers.accepted).not.toContain('repetition_penalty');
    expect(c.contextLength).toBeUndefined();
  });

  test('LM Studio :1234 and koboldcpp :5001 rename samplers', () => {
    expect(resolveCaps(input({ origin: 'http://127.0.0.1:1234', local: true })).samplers.wire).toEqual({ repetition_penalty: 'repeat_penalty' });
    expect(resolveCaps(input({ origin: 'http://localhost:5001', local: true })).samplers.wire).toEqual({ repetition_penalty: 'rep_pen', typical_p: 'typical' });
  });

  test('OpenRouter: Claude by version, Gemini safety settings', () => {
    const old = resolveCaps(input({ origin: OPENROUTER, model: 'anthropic/claude-sonnet-4.5' }));
    expect(old.midSystem).toBe('as-user');
    expect(old.prefill).toBe('assistant-last');
    expect(old.source).toEqual(['host', 'model']);
    for (const id of ['anthropic/claude-opus-4.6', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-opus-5.5', 'anthropic/claude-3.7-sonnet:thinking', 'anthropic/claude-fable-5.1']) {
      expect(resolveCaps(input({ origin: OPENROUTER, model: id })).prefill).toBe('none');
    }
    const opus55 = resolveCaps(input({ origin: OPENROUTER, model: 'anthropic/claude-opus-5.5' }));
    expect(opus55.samplers.fixed).toBe(true);
    expect(opus55.reasoning.canDisable).toBe(false);
    expect(opus55.toolChoice).not.toContain('required');
    const gem = resolveCaps(input({ origin: OPENROUTER, model: 'google/gemini-2.5-pro' }));
    expect(gem.extraBody!['provider']).toEqual({ allow_fallbacks: false });
    expect((gem.extraBody!['safety_settings'] as { threshold: string }[]).every((s) => s.threshold === 'OFF')).toBe(true);
    // The Claude router rows stay off a local server.
    expect(resolveCaps(input({ origin: LLAMA, local: true, model: 'claude-distill-8b' })).midSystem).toBe('native');
  });

  test('DeepSeek API', () => {
    const chat = resolveCaps(input({ origin: 'https://api.deepseek.com:443', model: 'deepseek-chat' }));
    expect(chat.prefill).toBe('prefix-flag');
    expect(chat.stopMax).toBe(16);
    expect(chat.reasoning.output).toBe('reasoning_content');
    const r = resolveCaps(input({ origin: 'https://api.deepseek.com:443', model: 'deepseek-reasoner' }));
    expect(r.reasoning.echo).toBe('all-with-tools');
    expect(r.toolChoice).toEqual([]);
    expect(r.samplers.fixed).toBe(true);
  });

  test('OpenAI API: max_completion_tokens and fixed samplers for o-series / gpt-5, stop 4', () => {
    const four = resolveCaps(input({ origin: 'https://api.openai.com:443', model: 'gpt-4o' }));
    expect(four.maxTokensField).toBe('max_tokens');
    expect(four.stopMax).toBe(4);
    for (const id of ['o3', 'o4-mini', 'gpt-5', 'gpt-5.2']) {
      const c = resolveCaps(input({ origin: 'https://api.openai.com:443', model: id }));
      expect(c.maxTokensField).toBe('max_completion_tokens');
      expect(c.samplers).toEqual({ accepted: ['max_tokens'], fixed: true });
    }
    expect(resolveCaps(input({ origin: 'https://api.openai.com:443', model: 'gpt-5' })).reasoning.efforts).toContain('minimal');
    expect(resolveCaps(input({ origin: 'https://api.openai.com:443', model: 'gpt-5.4' })).reasoning.efforts).toContain('xhigh');
    // The same id through a router is not OpenAI's API.
    expect(resolveCaps(input({ origin: OPENROUTER, model: 'gpt-5' })).maxTokensField).toBe('max_tokens');
  });

  test('Qwen3 toggles thinking through chat_template_kwargs on llama.cpp only', () => {
    const local = resolveCaps(input({ origin: LLAMA, local: true, model: 'Qwen3-14B-Q4_K_M.gguf' }));
    expect(local.reasoning.tags).toEqual(['<think>']);
    expect(local.reasoning.control).toBe('toggle');
    expect(local.reasoning.canDisable).toBe(true);
    expect(local.reasoning.offShape).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    const routed = resolveCaps(input({ origin: OPENROUTER, model: 'qwen/qwen3-235b-a22b' }));
    expect(routed.reasoning.tags).toEqual(['<think>']);
    expect(routed.reasoning.control).toBe('none');
    const split = resolveCaps(input({ origin: LLAMA, local: true, model: 'Qwen3-30B-A3B-Thinking-2507' }));
    expect(split.reasoning.control).toBe('none');
    expect(split.reasoning.canDisable).toBe(false);
  });

  test('Mistral ids get 9-character tool ids; Mistral and Gemma templates get strict roles on Jinja servers', () => {
    expect(resolveCaps(input({ model: 'mistralai/Mistral-Small-3.2-24B' })).toolIdFormat).toBe('mistral9');
    const nemo = resolveCaps(input({ origin: LLAMA, local: true, model: 'Mistral-Nemo-Instruct-2407' }));
    expect(nemo.alternation).toBe('strict');
    expect(nemo.midSystem).toBe('as-user');
    expect(resolveCaps(input({ origin: LLAMA, local: true, model: 'gemma-3-12b-it' })).alternation).toBe('strict');
    expect(resolveCaps(input({ origin: OLLAMA, local: true, model: 'gemma3:12b' })).alternation).toBe('strict'); // pessimistic anyway
  });

  test('mandatory-reasoning guards', () => {
    expect(resolveCaps(input({ origin: OPENROUTER, model: 'x-ai/grok-4.5', user: { reasoning: { canDisable: true } as ModelCaps['reasoning'] } })).reasoning.canDisable).toBe(true);
    expect(resolveCaps(input({ origin: OPENROUTER, model: 'x-ai/grok-4.5' })).reasoning.canDisable).toBe(false);
  });
});
