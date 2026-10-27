// M3 additions to the scripted provider (decisions G2): tool steps with raw argsText, {replay}
// steps, the optional {"caps": …} first line of a script FILE (parseScriptFile, scriptCapsWith).
// SCRIPT_CAPS, parseScript and hashRequest are unchanged.
import { describe, expect, test } from 'bun:test';
import { createScriptedProvider, hashRequest, parseScript, parseScriptFile, SCRIPT_CAPS, scriptCapsWith } from '../../src/providers/scripted.ts';
import * as testing from '../../src/testing/index.ts';
import type { ModelRequest, StreamEv } from '../../src/providers/types.ts';
import { collect } from '../adapter/kit.ts';

const env = { fetch, key: null };

function req(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: { connection: 'script', model: 'mock-model' },
    caps: SCRIPT_CAPS,
    messages: [{ role: 'user', blocks: [{ k: 'text', text: 'Any storms?' }], src: 'history' }],
    maxTokens: 64,
    samplers: {},
    signal: new AbortController().signal,
    callKey: 't:narrator:0',
    agent: 'narrator',
    ...over,
  };
}

describe('tool steps with argsText', () => {
  test('argsText goes out verbatim as one tool_args delta (broken JSON stays broken)', async () => {
    const [call] = parseScript(JSON.stringify([{ tool: { name: 'search_lore', argsText: '{"query": "amber"', id: 'c1' } }, { tool: { name: 'read_lore', argsText: '' } }]));
    expect(call!.steps).toEqual([{ tool: { name: 'search_lore', argsText: '{"query": "amber"', id: 'c1' } }, { tool: { name: 'read_lore', argsText: '' } }]);
    const evs = await collect(createScriptedProvider([call!]).stream(req(), env));
    expect(evs).toEqual([
      { t: 'tool_start', i: 0, id: 'c1', name: 'search_lore' },
      { t: 'tool_args', i: 0, d: '{"query": "amber"' },
      { t: 'tool_end', i: 0 },
      // An empty argsText sends no delta, as a server that sent no arguments.
      { t: 'tool_start', i: 1, id: 'call_1_1', name: 'read_lore' },
      { t: 'tool_end', i: 1 },
      { t: 'finish', reason: 'end', raw: 'end' },
    ]);
  });

  test('args keeps its M1 behaviour (JSON.stringify, {} when missing)', async () => {
    const [call] = parseScript(JSON.stringify([{ tool: { name: 'look' } }, { tool: { name: 'roll', args: 'not an object' } }]));
    const evs = await collect(createScriptedProvider([call!]).stream(req(), env));
    expect(evs.filter((e) => e.t === 'tool_args')).toEqual([
      { t: 'tool_args', i: 0, d: '{}' },
      { t: 'tool_args', i: 1, d: '"not an object"' },
    ]);
  });

  test('bad tool steps are refused with the line number', () => {
    expect(() => parseScript(`[{"text":"a"}]\n[{"tool":{"name":"x","args":{},"argsText":"{}"}}]`)).toThrow('script line 2: step 1: give tool.args or tool.argsText, not both');
    expect(() => parseScript('[{"tool":{"name":"x","argsText":3}}]')).toThrow('tool.argsText must be a string');
    expect(() => parseScript('[{"tool":{"name":"x","split":3}}]')).toThrow('unknown field "split"');
  });
});

describe('replay steps', () => {
  test('a {replay} step yields a replay event; connection and model default to the request', async () => {
    const [call] = parseScript(
      JSON.stringify([
        { text: 'Hm.' },
        { replay: { kind: 'reasoning_details', payload: [{ type: 'reasoning.encrypted', data: 'x' }] } },
        { replay: { kind: 'tool_extra', connection: 'other', model: 'm2', payload: { c1: { a: 1 } } } },
        { finish: 'end' },
      ]),
    );
    const evs = await collect(createScriptedProvider([call!]).stream(req(), env));
    expect(evs).toEqual<StreamEv[]>([
      { t: 'text', i: 0, d: 'Hm.' },
      { t: 'replay', r: { kind: 'reasoning_details', connection: 'script', model: 'mock-model', payload: [{ type: 'reasoning.encrypted', data: 'x' }] } },
      { t: 'replay', r: { kind: 'tool_extra', connection: 'other', model: 'm2', payload: { c1: { a: 1 } } } },
      { t: 'finish', reason: 'end', raw: 'end' },
    ]);
  });

  test('the payload is a copy per call (a consumer that changes it changes nothing else)', async () => {
    const calls = parseScript('[{"replay":{"kind":"tool_extra","payload":{"c1":{"a":1}}}}]');
    const provider = createScriptedProvider(calls);
    const [ev] = await collect(provider.stream(req(), env));
    ((ev as Extract<StreamEv, { t: 'replay' }>).r.payload as { c1: { a: number } }).c1.a = 2;
    expect(calls[0]!.steps[0]).toEqual({ replay: { kind: 'tool_extra', payload: { c1: { a: 1 } } } });
  });

  test('bad replay steps are refused', () => {
    expect(() => parseScript('[{"replay":{"kind":"thoughts","payload":1}}]')).toThrow('unknown replay kind "thoughts"');
    expect(() => parseScript('[{"replay":{"kind":"tool_extra"}}]')).toThrow('replay.payload is required');
    expect(() => parseScript('[{"replay":{"kind":"tool_extra","payload":1,"model":2}}]')).toThrow('replay.model must be a string');
    expect(() => parseScript('[{"replay":[]}]')).toThrow('"replay" must be an object');
  });
});

describe('parseScriptFile and the caps line', () => {
  test('a first line {"caps": …} is a partial caps record; the calls keep their editor line numbers', () => {
    const text = '\n{"caps": {"tools": "native", "toolChoiceHonored": false}}\n[{"text":"a"}]\n\n[{"tool":{"name":"search_lore","args":{"query":"x"}}}]\n';
    const file = parseScriptFile(text);
    expect(file.caps).toEqual({ tools: 'native', toolChoiceHonored: false });
    expect(file.calls).toEqual([{ steps: [{ text: 'a' }] }, { steps: [{ tool: { name: 'search_lore', args: { query: 'x' } } }] }]);
    expect(() => parseScriptFile('{"caps": {"tools": "prompted"}}\n[{"text":"a"}]\n[{"nope":1}]')).toThrow('script line 3: step 1: unknown step "nope"');
  });

  test('without a caps line it is parseScript; parseScript itself still refuses a caps line', () => {
    expect(parseScriptFile('[{"text":"a"}]')).toEqual({ calls: [{ steps: [{ text: 'a' }] }] });
    expect(parseScriptFile('')).toEqual({ calls: [] });
    expect(() => parseScript('{"caps": {"tools": "native"}}\n[{"text":"a"}]')).toThrow('script line 1: unknown field "caps"');
  });

  test('a caps line anywhere but first, or a bad caps record, is an error naming the line', () => {
    expect(() => parseScriptFile('[{"text":"a"}]\n{"caps": {"tools": "native"}}')).toThrow('script line 2: a {"caps": ...} line must be the first line of the file');
    expect(() => parseScriptFile('{"caps": {"tools": "nativ"}}')).toThrow('script line 1: caps.tools must be one of native, prompted, none, got "nativ"');
    expect(() => parseScriptFile('{"caps": {"toolz": "native"}}')).toThrow('script line 1: caps: unknown caps key toolz');
    expect(() => parseScriptFile('{"caps": {"dialect": "anthropic"}}')).toThrow('unknown caps key dialect');
    expect(() => parseScriptFile('{"caps": {"samplers": {"accepted": ["top_q"]}}}')).toThrow('unknown sampler top_q');
    expect(() => parseScriptFile('{"caps": "native"}')).toThrow('"caps" must be an object');
    expect(() => parseScriptFile('{"caps": {}, "steps": []}')).toThrow('unknown field "steps"');
    expect(() => parseScriptFile('{"caps": {"toolChoiceHonored": "yes"}}')).toThrow('caps.toolChoiceHonored must be a boolean');
  });

  test('scriptCapsWith merges over SCRIPT_CAPS; SCRIPT_CAPS keeps tools none', () => {
    const caps = scriptCapsWith({ tools: 'prompted', reasoning: { echo: 'all-with-tools' } as never });
    expect(caps.tools).toBe('prompted');
    expect(caps.reasoning).toEqual({ ...SCRIPT_CAPS.reasoning, echo: 'all-with-tools' });
    expect(caps.source).toEqual(['script']);
    expect(scriptCapsWith()).toEqual(SCRIPT_CAPS);
    expect(scriptCapsWith()).not.toBe(SCRIPT_CAPS);
    expect(SCRIPT_CAPS.tools).toBe('none');
  });

  test('exported from rp-core/testing', () => {
    expect(testing.parseScriptFile).toBe(parseScriptFile);
    expect(testing.scriptCapsWith).toBe(scriptCapsWith);
  });
});

test('hashRequest ignores toolChoice and stop (unchanged; documented)', () => {
  const base = req();
  expect(hashRequest({ ...base, toolChoice: 'none', stop: ['<tool_result'] })).toBe(hashRequest(base));
  expect(hashRequest({ ...base, tools: [{ name: 'a', description: 'd', schema: {} }] })).not.toBe(hashRequest(base));
});
