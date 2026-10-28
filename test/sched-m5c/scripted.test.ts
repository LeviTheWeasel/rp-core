// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c scripted provider (D-207): a line tagged with an agent goes to that agent's requests; untagged
// lines keep the order they always had; a script file's first line may say its origin is local. After the
// review (ruling K): a hash mismatch names the script call that holds the hash, a misplaced header its own
// keys, and a script with no recall line makes recall's default lexical as an engine's override.
import { describe, expect, test } from 'bun:test';
import { Engine, scriptRecallDefault } from '../../src/engine/engine.ts';
import type { EngineHandle } from '../../src/engine/api.ts';
import { createScriptedProvider, parseScript, parseScriptFile, SCRIPT_CAPS, type ScriptCall, type ScriptedProvider } from '../../src/providers/scripted.ts';
import { PROVIDER_ERROR_MESSAGE, type CallAgent, type ModelRequest, type ProviderEnv, type StreamEv } from '../../src/providers/types.ts';
import { settle } from '../infra/fake-timers.ts';
import { byAgent, calls, dirCall, dirSession, fullCaps, planOf, rig, textOf as messageText, turnOf } from '../engine-m4/kit.ts';
import { tmpHome } from '../helpers.ts';

const env: ProviderEnv = { fetch, key: null };

function req(agent: CallAgent): ModelRequest {
  return {
    model: { connection: 'script', model: 'script' },
    caps: SCRIPT_CAPS,
    messages: [{ role: 'user', blocks: [{ k: 'text', text: 'Any storms?' }], src: 'history' }],
    maxTokens: 64,
    samplers: {},
    signal: new AbortController().signal,
    callKey: `turn-1:${agent}:0`,
    agent,
  };
}

async function textOf(it: AsyncIterable<StreamEv>): Promise<string> {
  let out = '';
  for await (const ev of it) {
    if (ev.t === 'text') out += ev.d;
    if (ev.t === 'error') return `error ${ev.err.code}: ${ev.err.message}`;
  }
  return out;
}

const line = (text: string, agent?: CallAgent): ScriptCall => ({ steps: [{ text }], ...(agent !== undefined ? { agent } : {}) });

describe('parsing the agent tag', () => {
  test('{"steps", "agent"} tags a line; arrays and lines without it stay untagged', () => {
    const text = '{"steps": [{"text": "plan"}], "agent": "director"}\n[{"text": "a"}]\n{"steps": [{"text": "picks"}], "agent": "recall", "requestHash": "0123456789abcdef"}\n{"steps": []}';
    expect(parseScript(text)).toEqual([
      { steps: [{ text: 'plan' }], agent: 'director' },
      { steps: [{ text: 'a' }] },
      { steps: [{ text: 'picks' }], requestHash: '0123456789abcdef', agent: 'recall' },
      { steps: [] },
    ]);
  });

  test('an unknown agent or a wrong type is an error naming the line', () => {
    expect(() => parseScript('[{"text":"a"}]\n{"steps": [], "agent": "recaller"}')).toThrow(
      'script line 2: "agent" must be one of narrator, director, recall, filing, historian, got "recaller"',
    );
    expect(() => parseScript('{"steps": [], "agent": 3}')).toThrow('script line 1: "agent" must be one of');
    expect(() => parseScript('{"steps": [], "agnet": "recall"}')).toThrow('script line 1: unknown field "agnet" (allowed: steps, requestHash, agent)');
  });
});

describe('taking lines by agent', () => {
  test('an untagged script plays in order, whoever asks (unchanged)', async () => {
    const p = createScriptedProvider([line('one'), line('two'), line('three')]);
    expect(await textOf(p.stream(req('recall'), env))).toBe('one');
    expect(await textOf(p.stream(req('director'), env))).toBe('two');
    expect(await textOf(p.stream(req('narrator'), env))).toBe('three');
    expect(p.remaining()).toBe(0);
  });

  test("each agent takes its own first line; a line tagged for another is never taken", async () => {
    const p = createScriptedProvider([line('picks', 'recall'), line('plan', 'director'), line('reply'), line('picks 2', 'recall')]);
    expect(p.remaining()).toBe(4);
    // The narrator has no line of its own: it takes the first untagged one, past the tagged lines.
    expect(await textOf(p.stream(req('narrator'), env))).toBe('reply');
    expect(await textOf(p.stream(req('director'), env))).toBe('plan');
    expect(await textOf(p.stream(req('recall'), env))).toBe('picks');
    expect(await textOf(p.stream(req('recall'), env))).toBe('picks 2');
    expect(p.remaining()).toBe(0);
  });

  test('an agent whose own lines ran out falls back to the untagged lines in order', async () => {
    const p = createScriptedProvider([line('plan', 'director'), line('first'), line('second')]);
    expect(await textOf(p.stream(req('director'), env))).toBe('plan');
    expect(await textOf(p.stream(req('director'), env))).toBe('first');
    expect(await textOf(p.stream(req('narrator'), env))).toBe('second');
  });

  test('Director and recall at once: each gets its own answer whichever asks first', async () => {
    for (const first of ['director', 'recall'] as const) {
      const p = createScriptedProvider([
        { steps: [{ pause: 'dir' }, { text: '<plan>{}</plan>' }], agent: 'director' },
        { steps: [{ text: '{"picks": ["e1"]}' }], agent: 'recall' },
        line('the reply'),
      ]);
      const second = first === 'director' ? 'recall' : 'director';
      const a = textOf(p.stream(req(first), env));
      const b = textOf(p.stream(req(second), env));
      p.release('dir');
      const got = { [first]: await a, [second]: await b };
      expect(got).toEqual({ director: '<plan>{}</plan>', recall: '{"picks": ["e1"]}' });
      expect(await textOf(p.stream(req('narrator'), env))).toBe('the reply');
    }
  });

  test('requests are recorded in arrival order whatever line each took', async () => {
    const p = createScriptedProvider([line('plan', 'director'), line('reply')]);
    const n = req('narrator');
    const d = req('director');
    const sn = p.stream(n, env);
    const sd = p.stream(d, env);
    expect(p.requests).toEqual([n, d]);
    expect(p.remaining()).toBe(0);
    expect([await textOf(sn), await textOf(sd)]).toEqual(['reply', 'plan']);
  });

  test('out of lines for this agent: script_exhausted, naming what is left for the others', async () => {
    const p = createScriptedProvider([line('plan', 'director'), line('picks', 'recall'), line('picks 2', 'recall')]);
    const out = await textOf(p.stream(req('narrator'), env));
    const head = `error script_exhausted: ${PROVIDER_ERROR_MESSAGE.script_exhausted}`;
    expect(out).toBe(`${head}: request 1 has no call left (the script has 3); left for other agents: director 1, recall 2`);
    expect(p.remaining()).toBe(3);
    // With nothing tagged left over, the message is the one it always was.
    const q = createScriptedProvider([line('only')]);
    await textOf(q.stream(req('narrator'), env));
    expect(await textOf(q.stream(req('recall'), env))).toBe(`${head}: request 2 has no call left (the script has 1)`);
  });
});

describe('a script that says its origin is local', () => {
  test('the first line may carry "local", with or without caps; parseScriptFile returns it', () => {
    expect(parseScriptFile('{"local": true}\n[{"text":"a"}]')).toEqual({ calls: [{ steps: [{ text: 'a' }] }], local: true });
    expect(parseScriptFile('{"caps": {"contextLength": 4096}, "local": false}\n[{"text":"a"}]')).toEqual({
      calls: [{ steps: [{ text: 'a' }] }],
      caps: { contextLength: 4096 },
      local: false,
    });
    expect(parseScriptFile('{"caps": {"maxInFlight": 2}}\n[{"text":"a"}]')).toEqual({ calls: [{ steps: [{ text: 'a' }] }], caps: { maxInFlight: 2 } });
  });

  test('a wrong "local", an unknown key or such a line later in the file is an error naming the line', () => {
    expect(() => parseScriptFile('{"local": "yes"}')).toThrow('script line 1: "local" must be a boolean');
    expect(() => parseScriptFile('{"local": true, "slots": 2}')).toThrow('script line 1: unknown field "slots" (allowed: caps, local)');
    expect(() => parseScriptFile('[{"text":"a"}]\n{"local": true}')).toThrow('script line 2: a {"local": ...} line must be the first line of the file');
    expect(() => parseScript('{"local": true}')).toThrow('script line 1: unknown field "local"');
  });

  test('a misplaced header names its own keys and says caps and local share the first line (ruling K, sched#9)', () => {
    const together = '(caps and local go together there, in one object: {"caps": {...}, "local": true})';
    expect(() => parseScriptFile('{"caps": {"tools": "prompted"}}\n{"local": true}\n[{"text":"a"}]')).toThrow(`script line 2: a {"local": ...} line must be the first line of the file ${together}`);
    expect(() => parseScriptFile('{"local": true}\n{"caps": {"tools": "prompted"}}\n[{"text":"a"}]')).toThrow(`script line 2: a {"caps": ...} line must be the first line of the file ${together}`);
    expect(() => parseScriptFile('[{"text":"a"}]\n{"caps": {}, "local": false}')).toThrow(`script line 2: a {"caps": ..., "local": ...} line must be the first line of the file ${together}`);
    // The combined form the message points to parses.
    expect(parseScriptFile('{"caps": {"tools": "prompted"}, "local": true}\n[{"text":"a"}]')).toEqual({ calls: [{ steps: [{ text: 'a' }] }], caps: { tools: 'prompted' }, local: true });
  });

  test('createScriptedProvider shows localOrigin only when it is given', () => {
    expect('localOrigin' in createScriptedProvider([])).toBe(false);
    expect(createScriptedProvider([], { localOrigin: true }).localOrigin).toBe(true);
    expect(createScriptedProvider([], { localOrigin: false }).localOrigin).toBe(false);
  });
});

describe('a hash mismatch names the script call that holds the hash (ruling K, sched#8)', () => {
  const hashed = (text: string, agent?: CallAgent): ScriptCall => ({ ...line(text, agent), requestHash: '0123456789abcdef' });

  test('a request that takes a later line: its call number, and the request it came in as', async () => {
    // Line 1 waits for the Director; the narrator, asking first, takes line 2.
    const p = createScriptedProvider([line('plan', 'director'), hashed('reply')]);
    const out = await textOf(p.stream(req('narrator'), env));
    expect(out).toStartWith("error bad_request: script call 2 (taken by request 1, the narrator's): request hash mismatch: expected 0123456789abcdef, actual ");
    // Recall asks first and takes its own line 2; the narrator, second, takes line 1.
    const q = createScriptedProvider([hashed('reply'), line('picks', 'recall')]);
    await textOf(q.stream(req('recall'), env));
    expect(await textOf(q.stream(req('narrator'), env))).toStartWith("error bad_request: script call 1 (taken by request 2, the narrator's): request hash mismatch");
  });

  test('untagged lines in order: the call is the request, as it always said', async () => {
    const p = createScriptedProvider([line('one'), hashed('two')]);
    await textOf(p.stream(req('narrator'), env));
    expect(await textOf(p.stream(req('narrator'), env))).toStartWith('error bad_request: script call 2: request hash mismatch: expected 0123456789abcdef');
  });
});

describe('a script with no recall line (ruling K, sched#4)', () => {
  test('recallTagged: whether any line is tagged "agent": "recall"', () => {
    expect(createScriptedProvider([]).recallTagged).toBe(false);
    expect(createScriptedProvider([line('reply'), line('plan', 'director')]).recallTagged).toBe(false);
    expect(createScriptedProvider([line('reply'), line('picks', 'recall')]).recallTagged).toBe(true);
  });

  test("as the engine's override it makes recall's default lexical, after EngineSeams.recall and RP_CORE_RECALL", async () => {
    const saved = process.env.RP_CORE_RECALL;
    const opened: EngineHandle[] = [];
    const defaultOf = async (provider: ScriptedProvider, seam?: 'off' | 'config'): Promise<string | undefined> => {
      const engine = await Engine.open({
        home: tmpHome(),
        providerOverride: { id: 'script', provider, caps: SCRIPT_CAPS, origin: 'script:s.jsonl', local: true },
        ...(seam !== undefined ? { recall: seam } : {}),
      });
      opened.push(engine);
      return (engine as unknown as { ctx: { recallDefault?: string } }).ctx.recallDefault;
    };
    try {
      delete process.env.RP_CORE_RECALL;
      expect(scriptRecallDefault({ provider: createScriptedProvider([line('reply')]) })).toBe('lexical');
      expect(scriptRecallDefault({ provider: createScriptedProvider([line('picks', 'recall')]) })).toBeUndefined();
      expect(scriptRecallDefault({ provider: { stream: () => (async function* () {})() } })).toBeUndefined();
      expect(scriptRecallDefault(undefined)).toBeUndefined();
      expect(await defaultOf(createScriptedProvider([line('reply')]))).toBe('lexical');
      expect(await defaultOf(createScriptedProvider([line('picks', 'recall'), line('reply')]))).toBeUndefined();
      // The seam decides first ('config': nothing replaces the default), then RP_CORE_RECALL.
      expect(await defaultOf(createScriptedProvider([line('reply')]), 'config')).toBeUndefined();
      expect(await defaultOf(createScriptedProvider([line('reply')]), 'off')).toBe('off');
      process.env.RP_CORE_RECALL = 'off';
      expect(await defaultOf(createScriptedProvider([line('reply')]))).toBe('off');
    } finally {
      if (saved === undefined) delete process.env.RP_CORE_RECALL;
      else process.env.RP_CORE_RECALL = saved;
      for (const e of opened) await e.close();
    }
  });
});

describe('through the engine', () => {
  test("a turn's Director and narrator take their tagged lines even when the script lists the reply first", async () => {
    const plan = planOf();
    const r = await rig([{ steps: [{ text: 'Mira answers.' }], agent: 'narrator' }, { steps: dirCall(plan), agent: 'director' }], { caps: fullCaps() });
    const s = dirSession(r.engine);
    const { out } = await turnOf(s);
    expect(out.type).toBe('done');
    expect(r.provider.requests.map((q) => q.agent)).toEqual(['director', 'narrator']);
    expect(byAgent(r.provider.requests, 'narrator')).toHaveLength(1);
    expect(messageText(s.view().path.at(-1)!)).toBe('Mira answers.');
    expect(r.provider.remaining()).toBe(0);
    await settle();
    await r.engine.close();
  });

  test('the same script untagged gives the Director the reply line (why the tag exists)', async () => {
    const r = await rig(calls([{ text: 'Mira answers.' }], dirCall()), { caps: fullCaps() });
    const s = dirSession(r.engine);
    await turnOf(s);
    // The Director asked first and took the reply line; the narrator never got 'Mira answers.'.
    expect(r.provider.requests[0]?.agent).toBe('director');
    expect(s.view().path.map((m) => messageText(m))).not.toContain('Mira answers.');
    await r.engine.close();
  });
});
