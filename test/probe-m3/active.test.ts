// Active probes (providers/probe-active.ts, §8.2 source 4, §7.2) against local Bun.serve mocks that
// behave like real servers. Every probe goes through the real openai-chat provider. Checked on every
// run: never a forced tool_choice, at most ACTIVE_PROBE_MAX_CALLS calls, each call's own reply cap.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createOpenAIChatProvider } from '../../src/providers/openai-chat.ts';
import { mergeCaps } from '../../src/providers/caps.ts';
import {
  ACTIVE_PROBE_MAX_CALLS,
  ACTIVE_PROBE_MAX_TOKENS,
  ACTIVE_PROBE_TOKENS,
  PROBE_JSON_SCHEMA,
  PROBE_NOT_RUN,
  PROBE_TOOL,
  PROBE_TOOL_RESULT,
  probeMaxTokens,
  runActiveProbes,
  toolsRefusedHint,
  type ActiveProbeInput,
} from '../../src/providers/probe-active.ts';
import { createScriptedProvider, SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { ProviderError, type ModelCaps, type Provider } from '../../src/providers/types.ts';
import { capsAt } from '../adapter/kit.ts';
import { fakeClock } from '../helpers.ts';
import { ch, failing, hasTools, isToolRound2, leaker, mockServer, nativeCaller, noTools, sse, thinker, usageWithOptions, wantsJson, type Body } from './mock.ts';

const mock = mockServer();
afterAll(() => mock.stop());
afterEach(() => {
  // The invariants every run keeps, whatever the server did.
  expect(mock.bodies.length).toBeLessThanOrEqual(ACTIVE_PROBE_MAX_CALLS);
  for (const b of mock.bodies) {
    expect(b.tool_choice === undefined || b.tool_choice === 'auto' || b.tool_choice === 'none').toBe(true);
    expect(b.max_tokens).toBe(capOf(b));
    expect(b.stream).toBe(true);
  }
  mock.bodies.length = 0;
});

/** The reply cap a probe body must carry: 96 for a ping, room to think for the tool call and the JSON reply. */
function capOf(b: Body): number {
  if (wantsJson(b)) return ACTIVE_PROBE_TOKENS.json_schema;
  if (isToolRound2(b)) return ACTIVE_PROBE_TOKENS.tools_result;
  if (hasTools(b)) return ACTIVE_PROBE_TOKENS.tools;
  return ACTIVE_PROBE_TOKENS.stream;
}

/** What a turn would use for an unknown model on a local server: the pessimistic record. */
const UNKNOWN = (): ModelCaps => capsAt('http://127.0.0.1:4999', 'm');

function input(over: Partial<ActiveProbeInput> = {}): ActiveProbeInput {
  return {
    provider: createOpenAIChatProvider({ connectionId: 'mock', baseUrl: mock.base, local: true }),
    connection: 'mock',
    model: 'm',
    caps: UNKNOWN(),
    local: true,
    fetch,
    key: null,
    signal: new AbortController().signal,
    clock: fakeClock('2026-10-26T12:00:00.000Z', 10),
    timeouts: { firstByteMs: 5_000, idleMs: 5_000 },
    ...over,
  };
}

const probes = (r: { observations: { probe: string; ok: boolean; verdict: string }[] }): string[] =>
  r.observations.map((o) => {
    // ok is the verdict's shadow, kept for readers of the M3 shape.
    expect(o.ok).toBe(o.verdict === 'ok');
    return `${o.probe}:${o.verdict}`;
  });

describe('verdicts', () => {
  test('a native tool caller (llama.cpp-like): native, round trip answered, json_schema enforced, timings', async () => {
    mock.behave = nativeCaller;
    const r = await runActiveProbes(input());
    expect(probes(r)).toEqual(['stream:ok', 'tools:ok', 'tools_result:ok', 'json_schema:ok']);
    expect(r.calls).toBe(4);
    expect(r.facts).toEqual({ streamUsage: 'timings', tools: 'native', structuredOutput: { mode: 'json_schema', confirmedBy: 'probe' } });
    expect(r.observations[1]!.detail).toBe('native call (arguments in 3 fragments)');
    expect(r.observations[2]!.detail).toBe('the result was taken and used in the reply');

    // Round 1: the one tool, tool_choice auto, a system + user prompt.
    const [ping, r1, r2, json] = mock.bodies;
    expect(ping!.tools).toBeUndefined();
    expect((r1!.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual([PROBE_TOOL.name]);
    expect(r1!.tool_choice).toBe('auto');
    // Round 2 is the loop's final round: the call echoed (content null), its result as a tool message,
    // and no tools at all on a server that does not honour tool_choice.
    expect(r2!.messages.slice(2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'lookup_word', arguments: '{"key":"amber-7"}' } }] },
      { role: 'tool', tool_call_id: 'call_abc', content: PROBE_TOOL_RESULT },
    ]);
    expect(r2!.tools).toBeUndefined();
    expect(r2!.tool_choice).toBeUndefined();
    // The json probe asks for no JSON; the schema rides in response_format.
    expect(json!.response_format).toEqual({ type: 'json_schema', json_schema: PROBE_JSON_SCHEMA });
    expect(JSON.stringify(json!.messages)).not.toContain('JSON');
  });

  test('a model that leaks <tool_call> as text: prompted; it ignores response_format: structured none', async () => {
    mock.behave = leaker;
    const r = await runActiveProbes(input());
    expect(probes(r)).toEqual(['stream:ok', 'tools:no', 'json_schema:no']);
    expect(r.observations[1]!.detail).toBe('leaked as text: <tool_call>-style tags');
    expect(r.observations[2]!.detail).toBe('ignored: the reply is prose');
    expect(r.facts).toEqual({ streamUsage: 'timings', tools: 'prompted', structuredOutput: { mode: 'none' } });
  });

  test('a server that refuses tools (HTTP 400): prompted, with a fixed hint per server kind', async () => {
    mock.behave = noTools;
    const r = await runActiveProbes(input());
    expect(probes(r)).toEqual(['stream:ok', 'tools:no', 'json_schema:ok']);
    expect(r.observations[1]!.detail).toBe('refused: the server refused the request (HTTP 400)');
    // The server's own words never reach an observation (§13).
    expect(JSON.stringify(r.observations)).not.toContain('template');
    expect(r.facts.tools).toBe('prompted');
    expect(toolsRefusedHint('llama.cpp')).toContain('--jinja');
    expect(toolsRefusedHint(undefined)).toContain('prompted transport');
  });

  test('a model that answers in prose: no tool call, nothing written about tools', async () => {
    mock.behave = (b) => (hasTools(b) ? sse([ch({ content: 'I would guess "sunset".' }), ch({}, 'stop', { usage: { prompt_tokens: 9, completion_tokens: 5 } })]) : nativeCaller(b));
    const r = await runActiveProbes(input());
    expect(r.observations[1]).toMatchObject({ probe: 'tools', ok: false, detail: 'no tool call' });
    expect(r.facts.tools).toBeUndefined();
  });

  test('a native call with broken arguments is still native: echoed as {} (as the loop does), the round trip decides', async () => {
    mock.behave = (b) =>
      hasTools(b) && !isToolRound2(b)
        ? sse([ch({ tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'lookup_word', arguments: 'amber-7' } }] }), ch({}, 'tool_calls')])
        : nativeCaller(b);
    const r = await runActiveProbes(input());
    expect(r.observations[1]!.detail).toBe('native call (its arguments do not parse) (arguments in 1 fragment)');
    expect((mock.bodies[2]!.messages[2]!.tool_calls as { function: { arguments: string } }[])[0]!.function.arguments).toBe('{}');
    expect(r.facts.tools).toBe('native');
  });

  test('round 2 refused: the server cannot take tool results, prompted', async () => {
    mock.behave = (b) => (isToolRound2(b) ? Response.json({ error: { message: 'bad role tool' } }, { status: 422 }) : nativeCaller(b));
    const r = await runActiveProbes(input());
    expect(probes(r)).toEqual(['stream:ok', 'tools:ok', 'tools_result:no', 'json_schema:ok']);
    expect(r.facts.tools).toBe('prompted');
  });

  test('JSON that breaks the schema, and JSON cut by the token cap', async () => {
    mock.behave = (b) => (wantsJson(b) ? sse([ch({ content: '{"mood":"blue","count":1}' }), ch({}, 'stop')]) : nativeCaller(b));
    expect((await runActiveProbes(input())).observations.at(-1)!.detail).toBe('ignored: the reply is JSON that breaks the schema');
    mock.bodies.length = 0;
    mock.behave = (b) => (wantsJson(b) ? sse([ch({ content: '{"mood":"viri' }), ch({}, 'length')]) : nativeCaller(b));
    const cut = await runActiveProbes(input());
    expect(cut.observations.at(-1)).toMatchObject({ verdict: 'inconclusive', detail: `the reply hit the ${ACTIVE_PROBE_TOKENS.json_schema}-token cap` });
    expect(cut.facts.structuredOutput).toBeUndefined();
  });
});

describe('the stream probe', () => {
  test('usage only with stream_options (Ollama): one retry with it, streamUsage stream_options', async () => {
    mock.behave = usageWithOptions;
    const r = await runActiveProbes(input());
    expect(probes(r)).toEqual(['stream:ok', 'stream_usage:ok', 'tools:ok', 'tools_result:ok', 'json_schema:ok']);
    expect(r.observations[0]!.detail).toContain('no usage in the stream');
    expect(r.observations[1]!.usage).toEqual({ inputTotal: 12, outputTotal: 3 });
    expect(mock.bodies[0]!.stream_options).toBeUndefined();
    expect(mock.bodies[1]!.stream_options).toEqual({ include_usage: true });
    expect(r.facts.streamUsage).toBe('stream_options');
    expect(r.calls).toBe(5);
  });

  test('caps that already ask for usage get no retry; usage that came anyway writes nothing', async () => {
    mock.behave = usageWithOptions;
    const caps = capsAt('http://127.0.0.1:11434', 'm'); // the Ollama preset: stream_options
    const r = await runActiveProbes(input({ caps }));
    expect(r.observations.map((o) => o.probe)).not.toContain('stream_usage');
    expect(r.facts.streamUsage).toBeUndefined();
  });

  test('a server that refuses stream_options: none', async () => {
    mock.behave = (b) => (b.stream_options ? Response.json({ error: { message: 'unknown field' } }, { status: 400 }) : sse([ch({ content: 'ready' }), ch({}, 'stop')]));
    const r = await runActiveProbes(input());
    expect(r.observations[1]).toMatchObject({ probe: 'stream_usage', ok: false, detail: 'the server refused stream_options (the server refused the request (HTTP 400))' });
    expect(r.facts.streamUsage).toBe('none');
  });

  test('usage without asking: always', async () => {
    mock.behave = (b) => (hasTools(b) || wantsJson(b) ? Response.json({ error: {} }, { status: 400 }) : sse([ch({ content: 'ready' }), ch({}, 'stop', { usage: { prompt_tokens: 5, completion_tokens: 1 } })]));
    expect((await runActiveProbes(input())).facts.streamUsage).toBe('always');
  });

  test('reasoning in reasoning_content, in reasoning, in <think> tags', async () => {
    const thinking = (field: string | null) => (b: Body) => {
      if (hasTools(b) || wantsJson(b)) return nativeCaller(b);
      const first = field === null ? { content: '<think>The guest wants a word.</think>ready' } : { [field]: 'The guest wants a word.' };
      return sse([ch(first), ...(field === null ? [] : [ch({ content: 'ready' })]), ch({}, 'stop', { timings: { prompt_n: 3, predicted_n: 2 } })]);
    };
    mock.behave = thinking('reasoning_content');
    let r = await runActiveProbes(input());
    expect(r.facts.reasoning).toEqual({ output: 'reasoning_content' } as ModelCaps['reasoning']);
    expect(r.observations[0]!.detail).toContain('reasoning in reasoning_content');
    mock.bodies.length = 0;
    mock.behave = thinking('reasoning');
    r = await runActiveProbes(input());
    expect(r.facts.reasoning).toEqual({ output: 'reasoning' } as ModelCaps['reasoning']);
    mock.bodies.length = 0;
    mock.behave = thinking(null);
    r = await runActiveProbes(input());
    expect(r.facts.reasoning).toEqual({ output: 'tags' } as ModelCaps['reasoning']);
    expect(r.observations[0]!.detail).toContain('reasoning in inline tags');
    mock.bodies.length = 0;
    // No reasoning at all is not evidence of anything.
    mock.behave = nativeCaller;
    expect((await runActiveProbes(input())).facts.reasoning).toBeUndefined();
  });

  test('a server that ignores stream:true is noted', async () => {
    mock.behave = (b) =>
      hasTools(b) || wantsJson(b)
        ? Response.json({ error: { message: 'no' } }, { status: 400 })
        : Response.json({ object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } });
    const r = await runActiveProbes(input());
    expect(r.observations[0]!.detail).toContain('the server ignored stream:true');
    expect(r.facts.streamUsage).toBe('always');
  });
});

describe('thinking models (review: a 96-token cap gave them no verdict)', () => {
  const OLLAMA = (): ModelCaps => capsAt('http://127.0.0.1:11434', 'qwen3:14b');

  test('150 tokens of thought before the call and before the JSON: native and enforced; the ping stays at 96', async () => {
    mock.behave = thinker({ ping: 60, tools: 150, round2: 80, json: 120 });
    const r = await runActiveProbes(input({ caps: OLLAMA() }));
    expect(probes(r)).toEqual(['stream:ok', 'tools:ok', 'tools_result:ok', 'json_schema:ok']);
    expect(r.facts).toMatchObject({ tools: 'native', structuredOutput: { mode: 'json_schema', confirmedBy: 'probe' }, reasoning: { output: 'reasoning' } });
    expect(mock.bodies.map((b) => b.max_tokens)).toEqual([96, 1024, 512, 512]);
  });

  test('a model that thinks past even the larger caps: inconclusive (not "not ok"), and nothing written about tools or JSON', async () => {
    mock.behave = thinker({ ping: 10, tools: 2000, round2: 0, json: 2000 });
    const r = await runActiveProbes(input({ caps: OLLAMA() }));
    expect(probes(r)).toEqual(['stream:ok', 'tools:inconclusive', 'json_schema:inconclusive']);
    expect(r.observations[1]!.detail).toBe(`the reply hit the ${ACTIVE_PROBE_TOKENS.tools}-token cap before any tool call (it was still thinking)`);
    expect(r.observations[2]!.detail).toBe(`the reply hit the ${ACTIVE_PROBE_TOKENS.json_schema}-token cap before any text (it was still thinking)`);
    expect(r.facts.tools).toBeUndefined();
    expect(r.facts.structuredOutput).toBeUndefined();
  });

  test('a non-thinker of the same server still pings at 96', async () => {
    mock.behave = thinker({ ping: 0, tools: 0, round2: 0, json: 0 });
    const r = await runActiveProbes(input({ caps: OLLAMA() }));
    expect(r.facts.tools).toBe('native');
    expect(mock.bodies[0]!.max_tokens).toBe(96);
  });
});

describe('server errors are asked again (review: one HTTP 500 was taken as a refusal)', () => {
  test('a 500 on the first tools call and a native call on the second: tools native, the detail says so', async () => {
    mock.behave = failing(1, (b) => hasTools(b) && !isToolRound2(b), nativeCaller);
    const r = await runActiveProbes(input());
    expect(probes(r)).toEqual(['stream:ok', 'tools:ok', 'tools_result:ok', 'json_schema:ok']);
    expect(r.observations[1]!.detail).toBe('native call (arguments in 3 fragments) (second try: the first got HTTP 500)');
    expect(r.facts.tools).toBe('native');
    expect(r.calls).toBe(5);
  });

  test('a 500 on every tools call (llama.cpp without --jinja): refused on both tries, prompted', async () => {
    mock.behave = failing(99, hasTools, nativeCaller);
    const r = await runActiveProbes(input());
    expect(probes(r)).toEqual(['stream:ok', 'tools:no', 'json_schema:ok']);
    expect(r.observations[1]!.detail).toBe('refused: the server failed or is overloaded (HTTP 500) on both tries');
    expect(r.facts.tools).toBe('prompted');
  });

  test('a single 500 on json_schema with the repeat enforced: confirmed; repeated: none', async () => {
    mock.behave = failing(1, wantsJson, nativeCaller);
    let r = await runActiveProbes(input());
    expect(r.facts.structuredOutput).toEqual({ mode: 'json_schema', confirmedBy: 'probe' });
    mock.bodies.length = 0;
    mock.behave = failing(99, wantsJson, nativeCaller);
    r = await runActiveProbes(input());
    expect(r.observations.at(-1)).toMatchObject({ probe: 'json_schema', verdict: 'no', detail: 'refused: the server failed or is overloaded (HTTP 500) on both tries' });
    expect(r.facts.structuredOutput).toEqual({ mode: 'none' });
  });

  test('a single 500 with no call left to repeat it: inconclusive, no fact', async () => {
    // ping (no usage) 1, stream_usage 2, tools 500 3, tools again 4, tools_result 5, json_schema 500 6.
    const tools = failing(1, (b) => hasTools(b) && !isToolRound2(b), usageWithOptions);
    mock.behave = failing(1, wantsJson, tools);
    const r = await runActiveProbes(input());
    expect(r.calls).toBe(6);
    expect(r.observations.at(-1)).toMatchObject({ probe: 'json_schema', verdict: 'inconclusive', detail: 'the server failed or is overloaded (HTTP 500)' });
    expect(r.facts.structuredOutput).toBeUndefined();
    expect(r.facts.tools).toBe('native');
  });

  test('a probe the run had no call left for says so (inconclusive, no fact), never silently missing', async () => {
    // ping 500 (1), ping again (2), no usage: stream_usage (3), tools 500 (4), tools again (5),
    // tools_result (6): json_schema has no call left.
    let n = 0;
    mock.behave = failing(1, (b) => !hasTools(b) && !wantsJson(b) && !b.stream_options && n++ === 0, failing(1, (b) => hasTools(b) && !isToolRound2(b), (b) => {
      if (hasTools(b) || wantsJson(b)) return nativeCaller(b);
      return sse([ch({ role: 'assistant', content: 'ready' }), ch({}, 'stop')]);
    }));
    const r = await runActiveProbes(input());
    expect(r.calls).toBe(6);
    expect(probes(r)).toEqual(['stream:ok', 'stream_usage:no', 'tools:ok', 'tools_result:ok', 'json_schema:inconclusive']);
    expect(r.observations.at(-1)).toMatchObject({ probe: 'json_schema', detail: PROBE_NOT_RUN, ms: 0 });
    expect(PROBE_NOT_RUN).toBe('not run: the run had made its 6 calls (a repeated call counts)');
    expect(r.facts.structuredOutput).toBeUndefined();
  });

  test('Ollama: a 500 on both tries is a runner that failed, not a refusal (it refuses tools with 400): inconclusive, no fact', async () => {
    mock.behave = failing(99, hasTools, nativeCaller);
    const r = await runActiveProbes(input({ server: 'ollama' }));
    expect(probes(r)).toEqual(['stream:ok', 'tools:inconclusive', 'json_schema:ok']);
    expect(r.observations[1]!.detail).toBe('the server failed or is overloaded (HTTP 500) on both tries');
    expect(r.facts.tools).toBeUndefined();
    mock.bodies.length = 0;
    // llama.cpp (and a server of unknown kind) still reads it as the refusal it is there.
    mock.behave = failing(99, hasTools, nativeCaller);
    const l = await runActiveProbes(input({ server: 'llama.cpp' }));
    expect(l.facts.tools).toBe('prompted');
    // An Ollama 400 stays a refusal.
    mock.bodies.length = 0;
    mock.behave = noTools;
    expect((await runActiveProbes(input({ server: 'ollama' }))).facts.tools).toBe('prompted');
  });

  test('a 503 twice is still no refusal; a 400 needs no repeat', async () => {
    mock.behave = failing(99, hasTools, nativeCaller, 503);
    let r = await runActiveProbes(input());
    expect(r.observations[1]).toMatchObject({ probe: 'tools', verdict: 'inconclusive' });
    expect(r.facts.tools).toBeUndefined();
    mock.bodies.length = 0;
    mock.behave = noTools;
    r = await runActiveProbes(input());
    expect(mock.bodies.filter(hasTools)).toHaveLength(1);
    expect(r.facts.tools).toBe('prompted');
  });
});

describe('failures, limits, aborts', () => {
  test('a failed ping ends the run: one call, one observation, no facts', async () => {
    mock.behave = () => Response.json({ error: { message: 'bad key' } }, { status: 401 });
    const r = await runActiveProbes(input());
    expect(r.calls).toBe(1);
    expect(r.observations).toEqual([{ probe: 'stream', verdict: 'no', ok: false, detail: 'the server refused the API key (HTTP 401); the other probes were skipped', ms: 10 }]);
    expect(r.facts).toEqual({});
  });

  test('nothing listening: unreachable, no throw', async () => {
    const r = await runActiveProbes(input({ provider: createOpenAIChatProvider({ connectionId: 'x', baseUrl: 'http://127.0.0.1:9', local: true }) }));
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]!.detail).toContain('could not be reached');
    expect(r.facts).toEqual({});
  });

  test('a slow probe times out (inconclusive: nothing written for it); the others still count', async () => {
    mock.behave = async (b) => {
      if (wantsJson(b)) await Bun.sleep(400);
      return nativeCaller(b);
    };
    const r = await runActiveProbes(input({ timeouts: { firstByteMs: 150, idleMs: 150 } }));
    expect(r.observations.at(-1)).toMatchObject({ probe: 'json_schema', verdict: 'inconclusive', ok: false, detail: 'the server did not answer in time' });
    expect(r.facts).toEqual({ streamUsage: 'timings', tools: 'native' });
  });

  test("a stream that never ends after its finish keeps the answer (finish grace)", async () => {
    // The ping's body sends its finish and then stays open: the probe must not hang or fail.
    mock.behave = (b) => {
      if (hasTools(b) || wantsJson(b)) return Response.json({ error: {} }, { status: 400 });
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(ch({ content: 'ready' }, 'stop', { usage: { prompt_tokens: 1, completion_tokens: 1 } }))}\n\n`));
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    };
    const r = await runActiveProbes(input());
    expect(r.observations[0]).toMatchObject({ probe: 'stream', ok: true });
  }, 15_000);

  test("the caller's abort is rethrown (nothing should be stored)", async () => {
    mock.behave = async (b) => {
      await Bun.sleep(300);
      return nativeCaller(b);
    };
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('ctrl-c')), 50);
    await expect(runActiveProbes(input({ signal: ctrl.signal }))).rejects.toThrow('ctrl-c');
  });

  test("the caller's abort is rethrown when the provider ends with an error event after it (no throw), and no further call is made", async () => {
    const ctrl = new AbortController();
    let streams = 0;
    const provider: Provider = {
      async *stream(req) {
        streams++;
        // An adapter that turns the abort into an error event rather than throwing it.
        await new Promise<void>((resolve) => (req.signal.aborted ? resolve() : req.signal.addEventListener('abort', () => resolve(), { once: true })));
        yield { t: 'error', err: new ProviderError({ category: 'network', code: 'unreachable', message: 'the connection failed' }), afterOutput: false };
      },
    };
    setTimeout(() => ctrl.abort(new Error('ctrl-c')), 20);
    await expect(runActiveProbes(input({ provider, caps: SCRIPT_CAPS, signal: ctrl.signal }))).rejects.toThrow('ctrl-c');
    expect(streams).toBe(1);
  });

  test("a call never asks for more than the caps' maxOutput or the window leaves: a server that refuses a larger max_tokens is not read as refusing tools", async () => {
    expect(probeMaxTokens('tools', {})).toBe(1024);
    expect(probeMaxTokens('tools', { maxOutput: 512 })).toBe(512);
    expect(probeMaxTokens('stream', { maxOutput: 512 })).toBe(96);
    expect(probeMaxTokens('tools', { contextLength: 1024 })).toBe(512);
    expect(probeMaxTokens('json_schema', { contextLength: 300 })).toBe(16);
    // OpenAI / vLLM: max_tokens past the model's limit is a 400.
    mock.behave = (b: Body) => (Number(b.max_tokens) > 512 ? Response.json({ error: { message: 'max_tokens is too large' } }, { status: 400 }) : nativeCaller(b));
    const r = await runActiveProbes(input({ caps: { ...UNKNOWN(), maxOutput: 512 } }));
    expect(mock.bodies.map((b) => b.max_tokens)).toEqual([96, 512, 512, 512]);
    expect(r.facts.tools).toBe('native');
    expect(probes(r)).toEqual(['stream:ok', 'tools:ok', 'tools_result:ok', 'json_schema:ok']);
    mock.bodies.length = 0; // their caps are not ACTIVE_PROBE_TOKENS (the afterEach would check that)
  });

  test('at most ACTIVE_PROBE_MAX_CALLS calls, each with its own cap (the afterEach checks every body)', async () => {
    mock.behave = usageWithOptions; // the longest run: 5 calls
    const r = await runActiveProbes(input());
    expect(r.calls).toBeLessThanOrEqual(ACTIVE_PROBE_MAX_CALLS);
    expect(ACTIVE_PROBE_MAX_CALLS).toBe(6);
    expect(ACTIVE_PROBE_TOKENS).toEqual({ stream: 96, stream_usage: 96, tools: 1024, tools_result: 512, json_schema: 512 });
    expect(ACTIVE_PROBE_MAX_TOKENS).toBe(1024);
    expect(mock.bodies.map((b) => b.max_tokens)).toEqual([96, 96, 1024, 512, 512]);
  });
});

describe('the DeepSeek echo and replay on round 2', () => {
  test('reasoning of round 1 goes back as reasoning_content; no tool_choice ever on a record without one', async () => {
    mock.behave = (b) => {
      if (hasTools(b) && !isToolRound2(b)) {
        return sse([
          ch({ reasoning_content: 'I should look it up.' }),
          ch({ tool_calls: [{ index: 0, id: 'call_ds', type: 'function', function: { name: 'lookup_word', arguments: '{"key":"amber-7"}' } }] }),
          ch({}, 'tool_calls', { usage: { prompt_tokens: 5, completion_tokens: 9 } }),
        ]);
      }
      return nativeCaller(b);
    };
    const caps = mergeCaps(UNKNOWN(), {
      toolChoice: [],
      reasoning: { output: 'reasoning_content', control: 'none', canDisable: false, echo: 'all-with-tools' } as ModelCaps['reasoning'],
    });
    const r = await runActiveProbes(input({ caps }));
    expect(r.facts.tools).toBe('native');
    const [, r1, r2] = mock.bodies;
    expect(r1).not.toHaveProperty('tool_choice');
    expect(r2!.messages[2]).toMatchObject({ role: 'assistant', content: null, reasoning_content: 'I should look it up.' });
  });

  test('replay payloads of round 1 ride on its message (OpenRouter reasoning_details)', async () => {
    mock.behave = (b) => {
      if (hasTools(b) && !isToolRound2(b)) {
        return sse([
          ch({ reasoning: 'hm', reasoning_details: [{ type: 'reasoning.encrypted', data: 'enc' }] }),
          ch({ tool_calls: [{ index: 0, id: 'call_or', type: 'function', function: { name: 'lookup_word', arguments: '{"key":"amber-7"}' } }] }),
          ch({}, 'tool_calls', { usage: { prompt_tokens: 5, completion_tokens: 9 } }),
        ]);
      }
      return nativeCaller(b);
    };
    const r = await runActiveProbes(input());
    expect(mock.bodies[2]!.messages[2]).toMatchObject({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'enc' }] });
    // reasoning_details wins over the plain `reasoning` OpenRouter sends next to it.
    expect(r.facts.reasoning).toEqual({ output: 'reasoning_details' } as ModelCaps['reasoning']);
  });
});

test('an in-process provider works too (no bytes to watch: usage from the events)', async () => {
  const provider = createScriptedProvider([
    { steps: [{ text: 'ready' }, { usage: { inputTotal: 3, outputTotal: 1 } }] },
    { steps: [{ tool: { name: 'lookup_word', args: { key: 'amber-7' } } }] },
    { steps: [{ text: 'It is heliotrope.' }] },
    { steps: [{ text: 'Hello!' }] },
  ]);
  const r = await runActiveProbes(input({ provider, caps: SCRIPT_CAPS }));
  expect(probes(r)).toEqual(['stream:ok', 'tools:ok', 'tools_result:ok', 'json_schema:no']);
  expect(r.facts).toEqual({ streamUsage: 'always', tools: 'native', structuredOutput: { mode: 'none' } });
  expect(provider.requests.map((q) => q.toolChoice)).toEqual([undefined, 'auto', 'none', undefined]);
  expect(provider.requests[2]!.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
});
