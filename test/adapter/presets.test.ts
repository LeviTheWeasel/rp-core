// openai-chat request snapshots: one standard RP request through every host preset of hosts.json
// (caps from resolveCaps, no hand-made caps), so a change to the data or the builder shows up as a
// diff of exactly what goes on the wire.
import { describe, expect, test } from 'bun:test';
import { buildChatRequest, type OpenAIChatOptions } from '../../src/providers/openai-chat.ts';
import type { CapsInput } from '../../src/providers/caps.ts';
import { capsAt, msg, request } from './kit.ts';

const MESSAGES = [
  msg('system', 'You are Mara, a tavern keeper.'),
  msg('system', 'Scenario: a rainy night.'),
  msg('user', 'Hello.'),
  msg('assistant', 'Mara looks up. "Evening."'),
  msg('user', 'A room, please.'),
];
const SAMPLERS = {
  temperature: 0.8,
  top_p: 0.95,
  top_k: 40,
  min_p: 0.05,
  top_a: 0.1,
  typical_p: 0.9,
  repetition_penalty: 1.1,
  frequency_penalty: 0.2,
  presence_penalty: 0.1,
  seed: 7,
};
const STOP = ['\nUser:', '\nYou:', '</s>', '<|im_end|>', '\n\n\n'];

const WIRE_HISTORY = [
  { role: 'system', content: 'You are Mara, a tavern keeper.\n\nScenario: a rainy night.' },
  { role: 'user', content: 'Hello.' },
  { role: 'assistant', content: 'Mara looks up. "Evening."' },
  { role: 'user', content: 'A room, please.' },
];
const PREFILLED = [...WIRE_HISTORY, { role: 'assistant', content: 'Mara' }];

interface Preset {
  name: string;
  origin: string;
  baseUrl: string;
  model: string;
  key: string | null;
  server?: string;
  url: string;
  body: Record<string, unknown>;
}

const JSON_ONLY = { 'Content-Type': 'application/json' };

const PRESETS: Preset[] = [
  {
    name: 'llama.cpp (:8080): every local sampler, repeat_penalty, timings instead of stream_options, cache_prompt',
    origin: 'http://127.0.0.1:8080',
    baseUrl: 'http://127.0.0.1:8080',
    model: 'mag-mell-r1-12b-q5_k_m.gguf',
    key: null,
    url: 'http://127.0.0.1:8080/v1/chat/completions',
    body: {
      model: 'mag-mell-r1-12b-q5_k_m.gguf',
      messages: PREFILLED,
      stream: true,
      max_tokens: 300,
      temperature: 0.8,
      top_p: 0.95,
      top_k: 40,
      min_p: 0.05,
      typical_p: 0.9,
      repeat_penalty: 1.1,
      frequency_penalty: 0.2,
      presence_penalty: 0.1,
      seed: 7,
      stop: STOP,
      cache_prompt: true,
    },
  },
  {
    name: 'Ollama (:11434): the OpenAI-documented samplers only, stream_options usage, assistant-last prefill',
    origin: 'http://127.0.0.1:11434',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M',
    key: null,
    url: 'http://127.0.0.1:11434/v1/chat/completions',
    body: {
      model: 'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M',
      messages: PREFILLED,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 300,
      temperature: 0.8,
      top_p: 0.95,
      frequency_penalty: 0.2,
      presence_penalty: 0.1,
      seed: 7,
      stop: STOP,
    },
  },
  {
    name: 'LM Studio (:1234): no prefill, repeat_penalty, no usage request',
    origin: 'http://127.0.0.1:1234',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'mn-12b-mag-mell-r1',
    key: null,
    url: 'http://127.0.0.1:1234/v1/chat/completions',
    body: {
      model: 'mn-12b-mag-mell-r1',
      messages: WIRE_HISTORY,
      stream: true,
      max_tokens: 300,
      temperature: 0.8,
      top_p: 0.95,
      top_k: 40,
      repeat_penalty: 1.1,
      frequency_penalty: 0.2,
      presence_penalty: 0.1,
      seed: 7,
      stop: STOP,
    },
  },
  {
    name: 'koboldcpp (:5001): rep_pen and typical renamed, top_a and min_p kept, no frequency_penalty',
    origin: 'http://127.0.0.1:5001',
    baseUrl: 'http://127.0.0.1:5001',
    model: 'koboldcpp/MN-12B-Mag-Mell-R1.Q5_K_M',
    key: null,
    url: 'http://127.0.0.1:5001/v1/chat/completions',
    body: {
      model: 'koboldcpp/MN-12B-Mag-Mell-R1.Q5_K_M',
      messages: WIRE_HISTORY,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 300,
      temperature: 0.8,
      top_p: 0.95,
      top_k: 40,
      min_p: 0.05,
      top_a: 0.1,
      typical: 0.9,
      rep_pen: 1.1,
      presence_penalty: 0.1,
      seed: 7,
      stop: STOP,
    },
  },
  {
    name: 'vLLM (server reported): repetition_penalty under its own name, stream_options',
    origin: 'http://10.0.0.5:8000',
    baseUrl: 'http://10.0.0.5:8000/v1',
    model: 'inflatebot/MN-12B-Mag-Mell-R1',
    key: null,
    server: 'vllm',
    url: 'http://10.0.0.5:8000/v1/chat/completions',
    body: {
      model: 'inflatebot/MN-12B-Mag-Mell-R1',
      messages: WIRE_HISTORY,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 300,
      temperature: 0.8,
      top_p: 0.95,
      top_k: 40,
      min_p: 0.05,
      repetition_penalty: 1.1,
      frequency_penalty: 0.2,
      presence_penalty: 0.1,
      seed: 7,
      stop: STOP,
    },
  },
  {
    name: 'OpenRouter: bearer key, stop capped at 4, provider.allow_fallbacks false, usage always on',
    origin: 'https://openrouter.ai:443',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'thedrummer/cydonia-24b-v4',
    key: 'sk-or-test',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    body: {
      model: 'thedrummer/cydonia-24b-v4',
      messages: WIRE_HISTORY,
      stream: true,
      max_tokens: 300,
      temperature: 0.8,
      top_p: 0.95,
      top_k: 40,
      min_p: 0.05,
      top_a: 0.1,
      repetition_penalty: 1.1,
      frequency_penalty: 0.2,
      presence_penalty: 0.1,
      seed: 7,
      stop: STOP.slice(0, 4),
      provider: { allow_fallbacks: false },
    },
  },
  {
    name: 'OpenRouter, Claude Opus 5: fixed sampling (no sampler at all), no prefill',
    origin: 'https://openrouter.ai:443',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-opus-5',
    key: 'sk-or-test',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    body: {
      model: 'anthropic/claude-opus-5',
      messages: WIRE_HISTORY,
      stream: true,
      max_tokens: 300,
      stop: STOP.slice(0, 4),
      provider: { allow_fallbacks: false },
    },
  },
  {
    name: 'NanoGPT: the common samplers only',
    origin: 'https://nano-gpt.com:443',
    baseUrl: 'https://nano-gpt.com/api/v1',
    model: 'TheDrummer/Cydonia-24B-v4',
    key: 'sk-nano-test',
    url: 'https://nano-gpt.com/api/v1/chat/completions',
    body: {
      model: 'TheDrummer/Cydonia-24B-v4',
      messages: WIRE_HISTORY,
      stream: true,
      max_tokens: 300,
      temperature: 0.8,
      top_p: 0.95,
      frequency_penalty: 0.2,
      presence_penalty: 0.1,
      seed: 7,
      stop: STOP,
    },
  },
  {
    name: 'DeepSeek chat: prefix-flag prefill, temperature and top_p only, stop up to 16',
    origin: 'https://api.deepseek.com:443',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    key: 'sk-ds-test',
    url: 'https://api.deepseek.com/v1/chat/completions',
    body: {
      model: 'deepseek-chat',
      messages: [...WIRE_HISTORY, { role: 'assistant', content: 'Mara', prefix: true }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 300,
      temperature: 0.8,
      top_p: 0.95,
      stop: STOP,
    },
  },
  {
    name: 'DeepSeek reasoner: fixed sampling, prefix-flag prefill',
    origin: 'https://api.deepseek.com:443',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-reasoner',
    key: 'sk-ds-test',
    url: 'https://api.deepseek.com/v1/chat/completions',
    body: {
      model: 'deepseek-reasoner',
      messages: [...WIRE_HISTORY, { role: 'assistant', content: 'Mara', prefix: true }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 300,
      stop: STOP,
    },
  },
  {
    name: 'OpenAI gpt-5.1: max_completion_tokens, no samplers, no stop',
    origin: 'https://api.openai.com:443',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.1',
    key: 'sk-oa-test',
    url: 'https://api.openai.com/v1/chat/completions',
    body: {
      model: 'gpt-5.1',
      messages: WIRE_HISTORY,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 300,
    },
  },
  {
    name: 'Mistral AI: seed as random_seed',
    origin: 'https://api.mistral.ai:443',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    key: 'sk-mi-test',
    url: 'https://api.mistral.ai/v1/chat/completions',
    body: {
      model: 'mistral-large-latest',
      messages: WIRE_HISTORY,
      stream: true,
      max_tokens: 300,
      temperature: 0.8,
      top_p: 0.95,
      frequency_penalty: 0.2,
      presence_penalty: 0.1,
      random_seed: 7,
      stop: STOP,
    },
  },
  {
    name: 'Groq: stop capped at 4, stream_options',
    origin: 'https://api.groq.com:443',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    key: 'gsk-test',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    body: {
      model: 'llama-3.3-70b-versatile',
      messages: WIRE_HISTORY,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 300,
      temperature: 0.8,
      top_p: 0.95,
      seed: 7,
      stop: STOP.slice(0, 4),
    },
  },
  {
    name: "Google's OpenAI-compatible endpoint: /v1beta/openai kept, three fields",
    origin: 'https://generativelanguage.googleapis.com:443',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.5-flash',
    key: 'AIza-test',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    body: {
      model: 'gemini-2.5-flash',
      messages: WIRE_HISTORY,
      stream: true,
      max_tokens: 300,
      temperature: 0.8,
      top_p: 0.95,
      stop: STOP,
    },
  },
];

describe('request snapshots per host preset', () => {
  for (const p of PRESETS) {
    test(p.name, () => {
      const extra: Partial<CapsInput> = p.server ? { server: p.server } : {};
      const caps = capsAt(p.origin, p.model, extra);
      const o: OpenAIChatOptions = { connectionId: 'c', baseUrl: p.baseUrl, local: p.origin.startsWith('http://') };
      const req = request({ model: { connection: 'c', model: p.model }, caps, messages: MESSAGES, samplers: SAMPLERS, stop: STOP, prefill: 'Mara', maxTokens: 300, reasoning: 'auto' });
      const http = buildChatRequest(req, o, p.key);
      expect(http.url).toBe(p.url);
      expect(http.method).toBe('POST');
      expect(http.headers).toEqual(p.key ? { ...JSON_ONLY, Authorization: `Bearer ${p.key}` } : JSON_ONLY);
      const body = JSON.parse(http.body!) as Record<string, unknown>;
      expect(body).toEqual(p.body);
      // Key order is part of the snapshot: a stable body serialises the same way every call.
      expect(Object.keys(body)).toEqual(Object.keys(p.body));
    });
  }
});
