// A local OpenAI-compatible mock for the active-probe tests (not a test file itself). Each test sets
// a `behave` function that answers one parsed chat request; the server records every request body.
// Behaviours below imitate what the M3 note describes for real servers (llama.cpp fragments with
// timings, Ollama's whole call and stream_options usage, a model that leaks <tool_call> as text, a
// server that refuses `tools`, one that enforces json_schema and one that ignores it).

export type Body = Record<string, unknown> & { messages: Record<string, unknown>[] };

export interface Mock {
  base: string;
  /** Every chat request body, in order. */
  bodies: Body[];
  /** Every request path (catalog GETs included). */
  paths: string[];
  behave: (b: Body) => Response | Promise<Response>;
  /** Models listed at /v1/models. */
  models: string[];
  stop(): void;
}

export function mockServer(): Mock {
  const m: Mock = {
    base: '',
    bodies: [],
    paths: [],
    models: ['m'],
    behave: () => new Response('no behaviour', { status: 500 }),
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      m.paths.push(url.pathname);
      if (req.method === 'GET' && url.pathname === '/v1/models') return Response.json({ object: 'list', data: m.models.map((id) => ({ id, object: 'model' })) });
      if (url.pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
      const body = (await req.json()) as Body;
      m.bodies.push(body);
      return m.behave(body);
    },
  });
  m.base = `http://127.0.0.1:${server.port}`;
  return m;
}

/** One chat chunk with one choice. */
export function ch(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }], ...extra };
}

/** An SSE response of these chunks, then [DONE]. */
export function sse(chunks: Record<string, unknown>[], done = true): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

export const isToolRound2 = (b: Body): boolean => b.messages.some((m) => m.role === 'tool');
export const wantsJson = (b: Body): boolean => b.response_format !== undefined;
export const hasTools = (b: Body): boolean => Array.isArray(b.tools) && b.tools.length > 0;
const TIMINGS = { timings: { prompt_n: 12, cache_n: 0, predicted_n: 3 } };
const USAGE = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };

/** A model whose text reply ends with llama.cpp timings in the last chunk. */
function reply(text: string, extra: Record<string, unknown> = TIMINGS): Response {
  return sse([ch({ role: 'assistant', content: text }), ch({}, 'stop', extra)]);
}

/**
 * llama.cpp-like: the call in fragments (index, id on the first only, arguments split), finish
 * tool_calls, timings last; round 2 names the result; json_schema enforced.
 */
export function nativeCaller(b: Body): Response {
  if (wantsJson(b)) return reply('{"mood":"viridian","count":3}');
  if (isToolRound2(b)) return reply('The word is heliotrope.');
  if (hasTools(b)) {
    return sse([
      ch({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'lookup_word', arguments: '' } }] }),
      ch({ tool_calls: [{ index: 0, function: { arguments: '{"key":' } }] }),
      ch({ tool_calls: [{ index: 0, function: { arguments: '"amber-7"}' } }] }),
      ch({}, 'tool_calls', TIMINGS),
    ]);
  }
  return reply('ready');
}

/** A model that writes the call as Hermes/Qwen markup in its text; it ignores response_format. */
export function leaker(b: Body): Response {
  if (hasTools(b)) return reply('<tool_call>\n{"name": "lookup_word", "arguments": {"key": "amber-7"}}\n</tool_call>');
  if (wantsJson(b)) return reply('Hello there, traveller!');
  return reply('ready');
}

/** A server whose template has no tools: 400 on any request carrying `tools`. */
export function noTools(b: Body): Response {
  if (hasTools(b)) return Response.json({ error: { message: 'tools are not supported by this template', type: 'invalid_request_error' } }, { status: 400 });
  return nativeCaller(b);
}

/** Ollama-like: usage only when stream_options.include_usage is sent (a choices:[] chunk after the finish). */
export function usageWithOptions(b: Body): Response {
  const opts = b.stream_options as { include_usage?: boolean } | undefined;
  const tail = opts?.include_usage ? [{ object: 'chat.completion.chunk', model: 'mock', choices: [], usage: USAGE }] : [];
  const text = wantsJson(b) ? '{"mood":"heliotrope","count":1}' : isToolRound2(b) ? 'heliotrope' : 'ready';
  if (hasTools(b) && !isToolRound2(b)) {
    // Ollama sends the whole call in one delta.
    return sse([
      ch({ role: 'assistant', content: '', tool_calls: [{ id: 'call_x1', index: 0, type: 'function', function: { name: 'lookup_word', arguments: '{"key":"amber-7"}' } }] }),
      ch({}, 'tool_calls'),
      ...tail,
    ]);
  }
  return sse([ch({ role: 'assistant', content: text }), ch({}, 'stop'), ...tail]);
}

/**
 * An Ollama /v1 thinking model (qwen3, gemma4, the R1 distills): `think` tokens of reasoning in
 * delta.reasoning before the reply, counted against max_tokens as Ollama counts them; a reply that
 * would not fit ends with finish 'length' while still thinking. The reply itself is nativeCaller's
 * (a whole call in one delta, an enforced schema, the result named in round 2).
 */
export function thinker(think: { ping: number; tools: number; round2: number; json: number }): (b: Body) => Response {
  return (b) => {
    const max = Number(b.max_tokens);
    const n = wantsJson(b) ? think.json : isToolRound2(b) ? think.round2 : hasTools(b) ? think.tools : think.ping;
    const thought = Array.from({ length: Math.min(n, max) }, (_, i) => ch({ reasoning: `w${i} ` }));
    if (n >= max) return sse([ch({ role: 'assistant', content: '' }), ...thought, ch({}, 'length')]);
    if (wantsJson(b)) return sse([...thought, ch({ content: '{"mood":"viridian","count":2}' }), ch({}, 'stop')]);
    if (isToolRound2(b)) return sse([...thought, ch({ content: 'The word is heliotrope.' }), ch({}, 'stop')]);
    if (hasTools(b)) {
      return sse([...thought, ch({ content: '', tool_calls: [{ id: 'call_q', index: 0, type: 'function', function: { name: 'lookup_word', arguments: '{"key":"amber-7"}' } }] }), ch({}, 'tool_calls')]);
    }
    return sse([...thought, ch({ content: 'ready' }), ch({}, 'stop')]);
  };
}

/** A behaviour that answers HTTP `status` (an Ollama runner crash's words) to the first `times` requests `when` matches. */
export function failing(times: number, when: (b: Body) => boolean, then: (b: Body) => Response, status = 500): (b: Body) => Response {
  let left = times;
  return (b) => {
    if (when(b) && left > 0) {
      left--;
      return Response.json({ error: { message: 'llama runner process has terminated: CUDA error: out of memory' } }, { status });
    }
    return then(b);
  };
}
