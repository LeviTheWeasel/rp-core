// Bun.serve fakes for `rp-core bench ttft` (not a test file itself). Each fake keeps a toy KV cache
// per slot: a prompt is one "token" per word (plus one per role), a call processes what does not
// match its slot's cached prefix, and the slot then holds the new prompt. So call 3 processes only
// the tail when P is still in its slot, and all of P again when the agent's prompt replaced it.

export interface ChatFake {
  base: string;
  /** Every request path, in order. */
  paths: string[];
  /** Every chat body, in order. */
  bodies: Record<string, unknown>[];
  stop(): void;
}

type Msg = { role: string; content: string };

function tokensOf(messages: Msg[]): string[] {
  return messages.flatMap((m) => [`<${m.role}>`, ...m.content.split(/\s+/).filter((w) => w !== '')]);
}

function common(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const sse = (chunks: unknown[]): string => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';

export interface FakeOptions {
  /** How the server reports what it did with the prompt. */
  counts: 'timings' | 'usage' | 'none';
  /** KV slots; id_slot picks one (modulo, as llama.cpp), else slot 0. */
  slots?: number;
  /** Extra JSON routes (server info). */
  routes?: Record<string, unknown>;
  /** Answer every chat with this status instead. */
  failWith?: number;
}

export function chatFake(o: FakeOptions): ChatFake {
  const slots: string[][] = Array.from({ length: o.slots ?? 1 }, () => []);
  const f: ChatFake = { base: '', paths: [], bodies: [], stop: () => server.stop(true) };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      f.paths.push(path);
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        const body = (await req.json()) as Record<string, unknown>;
        f.bodies.push(body);
        if (o.failWith !== undefined) return Response.json({ error: { message: 'boom' } }, { status: o.failWith });
        const prompt = tokensOf(body.messages as Msg[]);
        const id = typeof body.id_slot === 'number' ? body.id_slot % slots.length : 0;
        const cached = common(slots[id]!, prompt);
        slots[id] = prompt;
        const processed = prompt.length - cached;
        const last: Record<string, unknown> = { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] };
        if (o.counts === 'timings') last.timings = { cache_n: cached, prompt_n: processed, predicted_n: 2 };
        if (o.counts === 'usage') {
          last.usage = { prompt_tokens: prompt.length, completion_tokens: 2, total_tokens: prompt.length + 2, prompt_tokens_details: { cached_tokens: cached } };
        }
        const chunks = [{ choices: [{ index: 0, delta: { content: 'Ok' } }] }, { choices: [{ index: 0, delta: { content: ' then' } }] }, last];
        return new Response(sse(chunks), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      const route = o.routes?.[path];
      if (route === undefined) return new Response('not found', { status: 404 });
      return Response.json(route);
    },
  });
  f.base = `http://127.0.0.1:${server.port}`;
  return f;
}

/** llama.cpp /props of a recent build with `slots` slots. */
export function llamaRoutes(slots: number, build = 'b11901-5320c87f'): Record<string, unknown> {
  return {
    '/props': { default_generation_settings: { n_ctx: 32768 }, total_slots: slots, build_info: build, endpoint_slots: true },
    '/v1/models': { object: 'list', data: [{ id: 'm', object: 'model', owned_by: 'llamacpp' }] },
  };
}

export const OLLAMA_ROUTES: Record<string, unknown> = {
  '/api/version': { version: '0.40.12' },
  '/api/ps': { models: [{ name: 'm:latest', model: 'm:latest', digest: 'abc', context_length: 16384 }] },
};

export const LMSTUDIO_ROUTES: Record<string, unknown> = {
  '/api/v1/models': { models: [{ type: 'llm', key: 'm', loaded_instances: [{ id: 'm' }] }] },
};
