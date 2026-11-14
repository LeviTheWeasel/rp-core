// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Bun.serve fakes of three local servers for the M5d demo (not a test file itself).
// - llama.cpp: /props, /slots, /v1/models and a streaming chat. Each slot keeps the prompt it last
//   processed (one "token" per word, plus one per message role); a call reuses the longest common
//   prefix with its slot and processes the rest, and its final chunk carries llama.cpp's timings
//   (prompt_n processed, cache_n reused). id_slot picks the slot (modulo the slot count, as llama.cpp
//   does); without one every call lands on slot 0, the case where an agent's prompt evicts the
//   narrator's. The first token waits a little per processed token, so a cold prompt is slower.
// - Ollama: /api/version, /api/ps, /api/show and /v1 chat whose usage has cached_tokens. One model is
//   loaded at a time; a call for another name reloads, which empties the cache.
// - LM Studio: /api/v1/models (one of the two models not loaded) and a chat with no prompt counts.
// The Director's request is told from the narrator's by its prompt ("## YOUR PLAN").

export interface ChatSeen {
  agent: 'director' | 'narrator' | 'other';
  model: string;
  /** The body's id_slot, or null when it had none. */
  idSlot: number | null;
  /** The slot the fake used (llama.cpp only). */
  slot?: number;
  total: number;
  processed: number;
  cached: number;
}

export interface Fake {
  base: string;
  paths: string[];
  chats: ChatSeen[];
  /** Empties the caches and the records, as a restarted server. */
  reset(): void;
  stop(): void;
}

type Part = { type?: string; text?: string };
type Msg = { role: string; content: string | Part[] | null };

const words = (s: string): string[] => s.split(/\s+/).filter((w) => w !== '');
const textOf = (c: Msg['content']): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join(' ') : '');

/** The prompt as the fake's tokens: a role marker per message, then its words. */
export function tokensOf(messages: readonly Msg[]): string[] {
  return messages.flatMap((m) => [`<${m.role}>`, ...words(textOf(m.content))]);
}

function common(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const PLAN = {
  directive: { mood: 'quiet', pacing: 'slow', narrativeGoal: 'The ferry keeps to its schedule, but someone on board does not belong.' },
  arcUpdates: [{ title: 'The Late Passenger', description: 'A passenger with no ticket and a dry coat in the rain.', status: 'seeding', arcType: 'mystery' }],
  seedUpdates: [],
  invisibleArcUpdates: [],
  analysis: { whatHappened: 'The clerk opened the ticket window.' },
  chapterUpdate: { action: 'start_new', title: 'The Night Ferry' },
};

const REPLIES = [
  'Rain needles the canal. The night ferry noses up to the landing, its lamp swinging, and a man in a dry grey coat steps off before the gangway is down.',
  'The man in grey slides a coin under the glass, not a ticket. "One more crossing," he says, and his voice carries no water in it at all.',
  'Somewhere behind the ticket office the bell rope creaks, though no one is pulling it.',
];

function agentOf(body: Record<string, unknown>): ChatSeen['agent'] {
  const text = JSON.stringify(body.messages ?? []);
  if (text.includes('## YOUR PLAN')) return 'director';
  return 'narrator';
}

/** The answer text for a request: the Director's plan in the shape its transport asks for, else a line of the story. */
function answerOf(agent: ChatSeen['agent'], body: Record<string, unknown>, n: number): string {
  if (agent !== 'director') return REPLIES[n % REPLIES.length]!;
  const json = JSON.stringify(PLAN);
  if (body.response_format !== undefined || body.tools !== undefined) return json;
  // The tagged transport: continue an assistant prefill if there is one.
  const msgs = body.messages as Msg[];
  const last = msgs.at(-1);
  if (last?.role === 'assistant') {
    const pre = textOf(last.content);
    const whole = `<plan>${json}</plan>`;
    return whole.startsWith(pre) ? whole.slice(pre.length) : json;
  }
  return `<plan>${json}</plan>`;
}

const sse = (chunks: unknown[]): string => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
const pause = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** The stream of one answer, `text` in a few chunks, the last one carrying `extra` (usage, timings). */
function stream(model: string, text: string, extra: Record<string, unknown>): Response {
  const parts = text.match(/.{1,40}/gs) ?? [''];
  const chunks: unknown[] = parts.map((p) => ({ object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] }));
  chunks.push({ object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...extra });
  return new Response(sse(chunks), { headers: { 'Content-Type': 'text/event-stream' } });
}

interface Common {
  /** ms the first token waits per processed token (default 0.1). */
  msPerToken?: number;
}

export interface LlamaOptions extends Common {
  slots: number;
  build: string;
  /** /props answers this late (ms). */
  propsDelayMs?: number;
}

export function llamaFake(o: LlamaOptions): Fake {
  let slots: string[][] = [];
  const f: Fake = {
    base: '',
    paths: [],
    chats: [],
    reset() {
      slots = Array.from({ length: o.slots }, () => []);
      f.chats.length = 0;
      f.paths.length = 0;
    },
    stop: () => server.stop(true),
  };
  f.reset();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      f.paths.push(path);
      if (path === '/props') {
        await pause(o.propsDelayMs ?? 0);
        return Response.json({
          default_generation_settings: { n_ctx: 32768, params: {} },
          total_slots: o.slots,
          model_path: 'models/lumen-12b.Q4_K_M.gguf',
          build_info: o.build,
          endpoint_slots: true,
        });
      }
      if (path === '/slots') return Response.json(slots.map((s, id) => ({ id, n_ctx: 32768, is_processing: false, prompt_tokens: s.length })));
      if (path === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'm', object: 'model', owned_by: 'llamacpp' }] });
      if (path !== '/v1/chat/completions' || req.method !== 'POST') return new Response('not found', { status: 404 });
      const body = (await req.json()) as Record<string, unknown>;
      const agent = agentOf(body);
      const prompt = tokensOf(body.messages as Msg[]);
      const idSlot = typeof body.id_slot === 'number' ? body.id_slot : null;
      const slot = idSlot === null ? 0 : idSlot % slots.length;
      const cached = common(slots[slot]!, prompt);
      slots[slot] = prompt;
      const processed = prompt.length - cached;
      const n = f.chats.filter((c) => c.agent === agent).length;
      f.chats.push({ agent, model: String(body.model), idSlot, slot, total: prompt.length, processed, cached });
      await pause(Math.round(processed * (o.msPerToken ?? 0.1)));
      const text = answerOf(agent, body, n);
      const out = words(text).length;
      return stream(String(body.model), text, {
        usage: { prompt_tokens: prompt.length, completion_tokens: out, total_tokens: prompt.length + out },
        timings: { cache_n: cached, prompt_n: processed, predicted_n: out, prompt_ms: processed * (o.msPerToken ?? 0.1), predicted_ms: out * 10 },
      });
    },
  });
  f.base = `http://127.0.0.1:${server.port}`;
  return f;
}

export interface OllamaOptions extends Common {
  /** name → [blob, parameters text] as /api/show gives them. */
  models: Record<string, { blob: string; parameters: string }>;
}

export function ollamaFake(o: OllamaOptions): Fake {
  let loaded: { name: string; cache: string[] } | null = null;
  const f: Fake = {
    base: '',
    paths: [],
    chats: [],
    reset() {
      loaded = null;
      f.chats.length = 0;
      f.paths.length = 0;
    },
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      f.paths.push(path);
      if (path === '/api/version') return Response.json({ version: '0.40.12' });
      if (path === '/api/ps') {
        const m = loaded?.name;
        return Response.json({ models: m ? [{ name: m, model: m, digest: 'f00d', context_length: /32k/.test(m) ? 32768 : 16384 }] : [] });
      }
      if (path === '/api/show' && req.method === 'POST') {
        const b = (await req.json()) as { model?: string; name?: string };
        const name = b.model ?? b.name ?? '';
        const m = o.models[name] ?? o.models[name.replace(/:latest$/, '')];
        if (!m) return Response.json({ error: `model '${name}' not found` }, { status: 404 });
        return Response.json({
          modelfile: `# Modelfile generated by "ollama show"\n# FROM ${name}\n\nFROM ${m.blob}\n${m.parameters
            .split('\n')
            .map((l) => `PARAMETER ${l}`)
            .join('\n')}\n`,
          parameters: m.parameters,
          details: { format: 'gguf', family: 'llama' },
          model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 },
          capabilities: ['completion'],
        });
      }
      if (path !== '/v1/chat/completions' || req.method !== 'POST') return new Response('not found', { status: 404 });
      const body = (await req.json()) as Record<string, unknown>;
      const agent = agentOf(body);
      const model = String(body.model);
      // Another name, even on the same blob with other runner options, is a reload: the cache starts empty.
      if (loaded?.name !== model) loaded = { name: model, cache: [] };
      const prompt = tokensOf(body.messages as Msg[]);
      const cached = common(loaded.cache, prompt);
      loaded.cache = prompt;
      const processed = prompt.length - cached;
      const n = f.chats.filter((c) => c.agent === agent).length;
      f.chats.push({ agent, model, idSlot: typeof body.id_slot === 'number' ? body.id_slot : null, total: prompt.length, processed, cached });
      await pause(Math.round(processed * (o.msPerToken ?? 0.1)));
      const text = answerOf(agent, body, n);
      const out = words(text).length;
      return stream(model, text, {
        usage: { prompt_tokens: prompt.length, completion_tokens: out, total_tokens: prompt.length + out, prompt_tokens_details: { cached_tokens: cached } },
      });
    },
  });
  f.base = `http://127.0.0.1:${server.port}`;
  return f;
}

export interface LmStudioOptions {
  /** model key → loaded. */
  models: Record<string, boolean>;
}

export function lmStudioFake(o: LmStudioOptions): Fake {
  const f: Fake = {
    base: '',
    paths: [],
    chats: [],
    reset() {
      f.chats.length = 0;
      f.paths.length = 0;
    },
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      f.paths.push(path);
      if (path === '/api/v1/models') {
        return Response.json({
          models: Object.entries(o.models).map(([key, on]) => ({ type: 'llm', key, display_name: key, loaded_instances: on ? [{ id: key, config: { context_length: 16384 } }] : [] })),
        });
      }
      if (path !== '/v1/chat/completions' || req.method !== 'POST') return new Response('not found', { status: 404 });
      const body = (await req.json()) as Record<string, unknown>;
      const agent = agentOf(body);
      const prompt = tokensOf(body.messages as Msg[]);
      const n = f.chats.filter((c) => c.agent === agent).length;
      f.chats.push({ agent, model: String(body.model), idSlot: null, total: prompt.length, processed: prompt.length, cached: 0 });
      const text = answerOf(agent, body, n);
      // LM Studio reports the usage totals, never what it reused.
      const out = words(text).length;
      return stream(String(body.model), text, { usage: { prompt_tokens: prompt.length, completion_tokens: out, total_tokens: prompt.length + out } });
    },
  });
  f.base = `http://127.0.0.1:${server.port}`;
  return f;
}
