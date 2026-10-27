// The request of a tool turn (.notes/m3-decisions.md C): the two-pass selection, the M2 invariant,
// the prefill rule, the DeepSeek echo (D-94 revised), the notes book, and the preview as round 0.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from '../../src/engine/api.ts';
import { BUILTIN_PRESET, type Character, type Preset } from '../../src/formats/native.ts';
import { libraryDir } from '../../src/formats/library.ts';
import { buildChatRequest, ECHO_PLACEHOLDER } from '../../src/providers/openai-chat.ts';
import { BUILTIN_TOOL_SETS } from '../../src/engine/request.ts';
import { createScriptedProvider, hashRequest, SCRIPT_CAPS, type ScriptCall } from '../../src/providers/scripted.ts';
import type { ModelCaps, ModelRequest } from '../../src/providers/types.ts';
import { O200K_COUNTER } from '../../src/prompt/tokens.ts';
import { PROMPTED_STOP } from '../../src/tools/prompted.ts';
import { LEVI } from '../engine/kit.ts';
import { calls, capsWith, codes, lookupTool, MIRA_TOOLS, msgText, notices, reply, rig, scriptConn, session, sets, traceOf, type ToolLog } from './kit.ts';

/** The openai-chat wire body of a request (no I/O). */
const chatBody = (q: ModelRequest): { messages: Record<string, unknown>[] } =>
  JSON.parse(buildChatRequest(q, { connectionId: q.model.connection, baseUrl: 'http://127.0.0.1:1', local: true }, null).body!) as { messages: Record<string, unknown>[] };

/** Mira without a book: nothing of the lore is left unfired. */
const MIRA_PLAIN: Character = { ...MIRA_TOOLS, book: undefined } as Character;
delete (MIRA_PLAIN as { book?: unknown }).book;

const withoutSignal = (q: ModelRequest) => {
  const { signal: _s, caps: _c, ...rest } = q;
  return rest;
};

describe('two-pass selection (C1)', () => {
  test('nothing to offer: the request, trace and committed blocks are exactly what a tool-less model gets', async () => {
    const script = (): ScriptCall[] => calls([{ text: 'The door is red.' }, { usage: { inputTotal: 400, outputTotal: 9 } }]);
    const tools = await rig(script(), { caps: capsWith('native') });
    const none = await rig(script(), { caps: capsWith('none') });
    const a = session(tools.engine, 'Where is the red door?', {}, MIRA_PLAIN);
    const b = session(none.engine, 'Where is the red door?', {}, MIRA_PLAIN);
    const ra = await reply(a);
    const rb = await reply(b);
    const [qa] = tools.provider.requests;
    const [qb] = none.provider.requests;
    expect(withoutSignal(qa!)).toEqual(withoutSignal(qb!));
    expect(hashRequest(qa!)).toBe(hashRequest(qb!));
    expect(qa!.tools).toBeUndefined();
    expect(qa!.toolChoice).toBeUndefined();
    expect(qa!.stop).toBeUndefined();
    if (ra.out.type !== 'done' || rb.out.type !== 'done') throw new Error('not done');
    expect(ra.out.message.blocks).toEqual([{ k: 'text', text: 'The door is red.' }]);
    expect(ra.out.message.blocks).toEqual(rb.out.message.blocks);
    expect(ra.out.message.gen).toMatchObject({ transport: 'none', rounds: 1 });
    const ta = traceOf(tools.home, a.id, ra.out.message.id)!;
    const tb = traceOf(none.home, b.id, rb.out.message.id)!;
    expect(ta.rounds).toBeUndefined();
    expect(ta.tools).toBeUndefined();
    expect({ ...ta, calls: [] }).toEqual({ ...tb, calls: [] });
    await tools.engine.close();
    await none.engine.close();
  });

  test('unfired lore offers the lore set; a long chat the history set; caps.tools none nothing', async () => {
    const log: ToolLog = { runs: [] };
    const toolSets = sets([lookupTool(log, 'lore_tool')], [lookupTool(log, 'history_tool')]);

    const lore = await rig(calls([{ text: 'ok' }]), { toolSets });
    await reply(session(lore.engine));
    expect(lore.provider.requests[0]!.tools?.map((t) => t.name)).toEqual(['lore_tool']);
    await lore.engine.close();

    // A long chat in a small window: pass A trimmed the history.
    const long = await rig(calls([{ text: 'ok' }]), { toolSets });
    const s = long.engine.createSession({ character: MIRA_PLAIN, persona: LEVI, config: { window: 2400 } });
    for (let i = 0; i < 40; i++) s.send({ text: `Message ${i}: ${'the caravan moves on through the dunes. '.repeat(5)}`, expectedVersion: s.version() });
    await reply(s);
    expect(long.provider.requests[0]!.tools?.map((t) => t.name)).toEqual(['history_tool']);
    await long.engine.close();

    const off = await rig(calls([{ text: 'ok' }]), { toolSets, caps: capsWith('none') });
    await reply(session(off.engine));
    expect(off.provider.requests[0]!.tools).toBeUndefined();
    expect(off.provider.requests[0]!.messages.some((m) => m.src === 'core:tools')).toBe(false);
    await off.engine.close();
  });

  test('C1 reads the request sent: when pass B trims history pass A kept, the history set is offered too', async () => {
    const log: ToolLog = { runs: [] };
    const toolSets = sets([lookupTool(log, 'lore_tool')], [lookupTool(log, 'history_tool')]);
    const r = await rig(calls([{ text: 'ok' }]), { toolSets });
    const s = r.engine.createSession({ character: MIRA_TOOLS, persona: LEVI, config: { window: 2400 } });
    const rows: { n: number; trimmed: boolean; tools: string[] }[] = [];
    for (let i = 0; i < 40; i++) {
      s.send({ text: `Message ${i}: ${'the caravan moves on through the dunes. '.repeat(5)}`, expectedVersion: s.version() });
      const p = s.preview();
      if (!p.ok) throw new Error(p.code);
      rows.push({ n: i + 1, trimmed: p.trace.trimmed !== null, tools: p.tools.map((t) => t.name) });
    }
    // Every request that leaves history out offers the history tools (the lore set rides along).
    expect(rows.filter((x) => x.trimmed && !x.tools.includes('history_tool'))).toEqual([]);
    expect(rows.filter((x) => x.trimmed).length).toBeGreaterThan(0);
    expect(rows.filter((x) => !x.trimmed).every((x) => x.tools.join() === 'lore_tool')).toBe(true);
    await r.engine.close();
  });

  test('…and with the built-in history tools that request carries the D-96 gap note and the reminder', async () => {
    // o200k, ~330-token messages, an 8k model window: pass B used to trim from message 12 while the
    // history tools (and so D-96) came only once pass A trimmed, six messages later.
    const EN = 'The caravan crawled along the dusty road while the innkeeper watched it go, remembering her brother who never came back. ';
    const r = await rig(calls([{ text: 'ok' }]), { toolSets: BUILTIN_TOOL_SETS, extra: { counter: O200K_COUNTER } });
    const s = r.engine.createSession({ character: MIRA_TOOLS, persona: LEVI, config: { window: 16384 } });
    let trimmed = 0;
    for (let i = 0; i < 24; i++) {
      s.send({ text: `${i}. ${EN.repeat(12)}`, expectedVersion: s.version() });
      const p = s.preview();
      if (!p.ok) throw new Error(p.code);
      if (p.trace.trimmed === null) continue;
      trimmed++;
      expect([i + 1, p.tools.map((t) => t.name)]).toEqual([i + 1, ['read_history', 'read_lore', 'search_history', 'search_lore']]);
      expect(p.messages.filter((m) => m.src === 'core:gap' || m.src === 'core:remind').map((m) => m.src)).toEqual(['core:gap', 'core:remind']);
    }
    expect(trimmed).toBeGreaterThan(6);
    await r.engine.close();
  });

  test('…and where both sets do not fit beside the history pass B cut, the history set goes alone (lore gives way)', async () => {
    // o200k, built-in tools, a 3 072 window: pass B with the lore tools trims history pass A kept, the
    // history set plus the lore set leaves too little tool room, the history set alone fits.
    const EN = 'The caravan crawled along the dusty road while the innkeeper watched it go, remembering her brother who never came back. ';
    const r = await rig(calls([{ text: 'ok' }]), { toolSets: BUILTIN_TOOL_SETS, extra: { counter: O200K_COUNTER } });
    const s = r.engine.createSession({ character: MIRA_TOOLS, persona: LEVI, config: { window: 3072 } });
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      s.send({ text: `${i}. ${EN.repeat(3)}`, expectedVersion: s.version() });
      const p = s.preview();
      if (!p.ok) throw new Error(p.code);
      const names = p.tools.map((t) => t.name).join(',');
      seen.add(`${p.trace.trimmed !== null}:${names}`);
      // No request leaves history out while it offers tools without the history ones.
      if (p.trace.trimmed !== null && p.tools.length > 0) {
        expect([i + 1, names]).toEqual([i + 1, expect.stringContaining('read_history')]);
        expect(p.messages.filter((m) => m.src === 'core:gap' || m.src === 'core:remind').map((m) => m.src)).toEqual(['core:gap', 'core:remind']);
      }
    }
    // The band this covers: trimmed requests that carry the history set alone.
    expect(seen.has('true:read_history,search_history')).toBe(true);
    await r.engine.close();
  });

  test('lore that fired, or is disabled, offers nothing', async () => {
    const fired: Character = { ...MIRA_TOOLS, book: { name: 'World', entries: [{ id: 'd', keys: ['door'], content: 'Doors are red.', position: 'before' }] } };
    const r = await rig(calls([{ text: 'ok' }]));
    await reply(session(r.engine, 'Where is the red door?', {}, fired));
    expect(r.provider.requests[0]!.tools).toBeUndefined();
    await r.engine.close();

    const disabled: Character = { ...MIRA_TOOLS, book: { name: 'World', entries: [{ id: 'u', keys: ['unicorn'], content: 'x', position: 'before', enabled: false }] } };
    const r2 = await rig(calls([{ text: 'ok' }]));
    await reply(session(r2.engine, 'Where is the red door?', {}, disabled));
    expect(r2.provider.requests[0]!.tools).toBeUndefined();
    await r2.engine.close();
  });

  test('D-28: a preset prefill turns the tools off (trace, notice, no tools sent); prefill_vs_tools = tools keeps them', async () => {
    const preset: Preset = { ...structuredClone(BUILTIN_PRESET), name: 'pf', prefill: 'Mira:' };
    const write = (home: string) => {
      mkdirSync(libraryDir(home, 'presets'), { recursive: true });
      writeFileSync(join(libraryDir(home, 'presets'), 'pf.json'), JSON.stringify(preset));
    };
    const r = await rig(calls([{ text: ' Hello.' }]));
    write(r.home);
    const s = session(r.engine, 'Where is the red door?', { preset: 'pf' });
    const { out, evs } = await reply(s);
    const q = r.provider.requests[0]!;
    expect(q.tools).toBeUndefined();
    expect(q.prefill).toBe('Mira:');
    expect(q.messages.some((m) => m.src === 'core:tools')).toBe(false);
    expect(codes(evs)).toContain('prefill_disables_tools');
    if (out.type !== 'done') throw new Error(out.type);
    expect(traceOf(r.home, s.id, out.message.id)!.prefill).toBe('tools_off');
    expect(out.message.gen?.transport).toBe('none');
    await r.engine.close();

    const t = await rig(calls([{ text: 'Hello.' }]));
    write(t.home);
    const s2 = session(t.engine, 'Where is the red door?', { preset: 'pf', narrator: { prefillVsTools: 'tools' } });
    const done = await reply(s2);
    expect(t.provider.requests[0]!.tools?.map((x) => x.name)).toEqual(['lookup']);
    expect(t.provider.requests[0]!.prefill).toBeUndefined();
    expect(codes(done.evs)).toContain('prefill_skipped_for_tools');
    await t.engine.close();
  });
});

describe('the DeepSeek echo (C3, D-94 revised)', () => {
  const deepseek = (canDisable: boolean): ModelCaps =>
    capsWith('native', { reasoning: { output: 'reasoning_content', control: 'toggle', canDisable, echo: 'all-with-tools' } });

  test('a greeting needs no reasoning: tools on, thinking untouched, no notice', async () => {
    const r = await rig(calls([{ reasoning: 'Think.' }, { text: 'Hi.' }]), { caps: deepseek(true) });
    const { evs } = await reply(session(r.engine));
    const q = r.provider.requests[0]!;
    expect(q.tools?.map((t) => t.name)).toEqual(['lookup']);
    expect(q.reasoning).toBeUndefined();
    expect(codes(evs)).not.toContain('caps.suggest');
    await r.engine.close();
  });

  test('every earlier answer has this model\'s reasoning: it rides the history', async () => {
    const r = await rig(calls([{ reasoning: 'Think.' }, { text: 'Hi.' }], [{ reasoning: 'Again.' }, { text: 'Yes.' }]), { caps: deepseek(true) });
    const s = session(r.engine);
    await reply(s);
    s.send({ text: 'And the door?', expectedVersion: s.version() });
    const { evs } = await reply(s);
    const q = r.provider.requests[1]!;
    expect(q.reasoning).toBeUndefined();
    expect(q.tools?.map((t) => t.name)).toEqual(['lookup']);
    const answer = q.messages.filter((m) => m.role === 'assistant' && m.src === 'history').at(-1)!;
    expect(answer.blocks).toEqual([{ k: 'reasoning', text: 'Think.' }, { k: 'text', text: 'Hi.' }]);
    expect(codes(evs)).not.toContain('caps.suggest');
    await r.engine.close();
  });

  test('an answer of another model: thinking stays on, tools are offered, nothing is told; the wire sends the placeholder for it (D-94 revised)', async () => {
    const other = scriptConn('other', calls([{ text: 'Hi from another model.' }]), structuredClone(SCRIPT_CAPS));
    const r = await rig(
      calls(
        [{ tool: { name: 'lookup', args: { q: 'door' } } }],
        [{ reasoning: 'Red, I think.' }, { text: 'Red.' }],
        [{ reasoning: 'Again.' }, { text: 'Yes.' }],
      ),
      { caps: deepseek(true), connections: { other: other.conn } },
    );
    const s = session(r.engine, 'Where is the red door?', { roles: { narrator: { conn: 'other', model: 'default', reasoning: 'high' } } });
    await reply(s);
    s.configure({ roles: { narrator: { conn: 'script', model: 'default', reasoning: 'high' } } });
    s.send({ text: 'And the door?', expectedVersion: s.version() });
    const second = await reply(s);
    expect(second.out.type).toBe('done');
    const [q1, q2] = r.provider.requests;
    // The user's thinking setting stands on every call of the turn; the tools stay.
    expect(q1!.reasoning).toBe('high');
    expect(q2!.reasoning).toBe('high');
    expect(q1!.tools?.map((t) => t.name)).toEqual(['lookup']);
    expect(codes(second.evs)).not.toContain('caps.suggest');
    // The foreign answer has no reasoning of this model: one space goes out for it, as for the greeting.
    const wire = chatBody(q1!).messages.filter((m) => m.role === 'assistant');
    expect(wire.map((m) => m.reasoning_content)).toEqual([ECHO_PLACEHOLDER, ECHO_PLACEHOLDER]);
    // The next tool turn echoes the answer this model wrote with thinking on: the chat converges.
    s.send({ text: 'More?', expectedVersion: s.version() });
    const third = await reply(s);
    const q3 = r.provider.requests[2]!;
    expect(q3.reasoning).toBe('high');
    expect(q3.tools?.map((t) => t.name)).toEqual(['lookup']);
    expect(chatBody(q3).messages.filter((m) => m.role === 'assistant').map((m) => m.reasoning_content)).toEqual([ECHO_PLACEHOLDER, ECHO_PLACEHOLDER, 'Red, I think.']);
    expect(codes(third.evs)).not.toContain('caps.suggest');
    await r.engine.close();
  });

  test('a model that cannot turn thinking off keeps its tools too: no tools-off plan, no notice', async () => {
    const r = await rig(calls([{ text: 'Hi.' }], [{ text: 'Yes.' }]), { caps: deepseek(false) });
    const s = session(r.engine);
    await reply(s);
    s.send({ text: 'And the door?', expectedVersion: s.version() });
    const { evs } = await reply(s);
    const q = r.provider.requests[1]!;
    expect(q.tools?.map((t) => t.name)).toEqual(['lookup']);
    expect(q.reasoning).toBeUndefined();
    expect(q.messages.some((m) => m.src === 'core:tools')).toBe(true);
    expect(codes(evs)).not.toContain('caps.suggest');
    await r.engine.close();
  });

  test("binding reasoning 'none' on a model that can turn thinking off: nothing is echoed, nothing told", async () => {
    // The first answer has this model's reasoning (thinking was on), the second turn has it off.
    const r = await rig(calls([{ reasoning: 'Think.' }, { text: 'Hi.' }], [{ text: 'Yes.' }], [{ text: 'Again.' }]), { caps: deepseek(true) });
    const s = session(r.engine);
    await reply(s);
    s.configure({ roles: { narrator: { conn: 'script', model: 'default', reasoning: 'none' } } });
    s.send({ text: 'And the door?', expectedVersion: s.version() });
    const second = await reply(s);
    const q = r.provider.requests[1]!;
    expect(q.reasoning).toBe('none');
    expect(q.tools?.map((t) => t.name)).toEqual(['lookup']);
    // The history goes text-only: the adapter would not send the reasoning, so it is not counted either.
    expect(q.messages.some((m) => m.blocks.some((b) => b.k === 'reasoning'))).toBe(false);
    for (const m of chatBody(q).messages) expect(m).not.toHaveProperty('reasoning_content');
    expect(codes(second.evs)).not.toContain('caps.suggest');
    // …and an answer without reasoning in the context tells nothing either.
    s.send({ text: 'More?', expectedVersion: s.version() });
    const third = await reply(s);
    expect(codes(third.evs)).not.toContain('caps.suggest');
    await r.engine.close();
  });

  test('HTTP 400 on a request that echoed the placeholder: caps.suggest names tools = "none", once per session', async () => {
    const refused = { error: { code: 'bad_request' as const, status: 400 } };
    const r = await rig(calls([refused], [refused]), { caps: deepseek(true) });
    const s = session(r.engine);
    const first = await reply(s);
    expect(first.out.type).toBe('failed');
    // The greeting went out with the placeholder.
    expect(chatBody(r.provider.requests[0]!).messages.find((m) => m.role === 'assistant')!.reasoning_content).toBe(ECHO_PLACEHOLDER);
    const told = notices(first.evs).filter((n) => n.code === 'caps.suggest');
    expect(told.map((n) => n.level)).toEqual(['warn']);
    expect(told[0]!.message).toContain('[caps."script:default"]');
    expect(told[0]!.message).toContain('tools = "none"');
    const again = await reply(s);
    expect(again.out.type).toBe('failed');
    expect(codes(again.evs)).not.toContain('caps.suggest');
    await r.engine.close();
  });

  test('a 400 that says the context is too long is no refusal of the placeholder: nothing told, the notice stays for a real one', async () => {
    const overflow = { error: { code: 'context_length_exceeded' as const, status: 400 } };
    const refused = { error: { code: 'bad_request' as const, status: 400 } };
    const r = await rig(calls([overflow], [refused]), { caps: deepseek(true) });
    const s = session(r.engine);
    const first = await reply(s);
    expect(first.out).toMatchObject({ type: 'failed', code: 'context_length_exceeded' });
    expect(chatBody(r.provider.requests[0]!).messages.find((m) => m.role === 'assistant')!.reasoning_content).toBe(ECHO_PLACEHOLDER);
    expect(codes(first.evs)).not.toContain('caps.suggest');
    // The once-per-session notice was not used up: the plain refusal that follows is told.
    const again = await reply(s);
    expect(again.out.type).toBe('failed');
    expect(notices(again.evs).filter((n) => n.code === 'caps.suggest').map((n) => n.message)).toEqual([expect.stringContaining('tools = "none"')]);
    await r.engine.close();
  });

  test('HTTP 400 without the placeholder (no echo, or thinking off) says nothing of it', async () => {
    const refused = { error: { code: 'bad_request' as const, status: 400 } };
    const plain = await rig(calls([refused]), { caps: capsWith('native') });
    const a = await reply(session(plain.engine));
    expect(a.out.type).toBe('failed');
    expect(codes(a.evs)).not.toContain('caps.suggest');
    await plain.engine.close();

    const off = await rig(calls([refused]), { caps: deepseek(true) });
    const b = await reply(session(off.engine, 'Where is the red door?', { roles: { narrator: { conn: 'script', model: 'default', reasoning: 'none' } } }));
    expect(b.out.type).toBe('failed');
    expect(codes(b.evs)).not.toContain('caps.suggest');
    await off.engine.close();
  });
});

describe('notes (C5)', () => {
  test('a note added with memoryAdd fires on "брата" in the next request', async () => {
    const r = await rig(calls([{ text: 'Он в городе.' }]), { caps: capsWith('none') });
    const s = r.engine.createSession({ character: MIRA_PLAIN, persona: LEVI });
    s.memoryAdd({ title: 'Брат', keys: ['брат'], content: 'У Миры есть брат Олег.' });
    s.send({ text: 'Я видел твоего брата вчера.', expectedVersion: s.version() });
    const { out } = await reply(s);
    const q = r.provider.requests[0]!;
    expect(q.messages.some((m) => msgText(m).includes('[Memory: Брат]\nУ Миры есть брат Олег.'))).toBe(true);
    if (out.type !== 'done') throw new Error(out.type);
    expect(traceOf(r.home, s.id, out.message.id)!.lore.fired).toEqual([expect.objectContaining({ book: '@notes' })]);
    await r.engine.close();
  });

  test('a live note that did not fire offers the lore set', async () => {
    const r = await rig(calls([{ text: 'ok' }]));
    const s = r.engine.createSession({ character: MIRA_PLAIN, persona: LEVI });
    s.memoryAdd({ title: 'Ключ', keys: ['ключ'], content: 'Ключ под ковриком.' });
    s.send({ text: 'Where is the red door?', expectedVersion: s.version() });
    await reply(s);
    expect(r.provider.requests[0]!.tools?.map((t) => t.name)).toEqual(['lookup']);
    await r.engine.close();
  });
});

describe('preview is round 0 (§6.1)', () => {
  /** A scripted connection whose provider shows its wire: the fields the tool loop sets. */
  function wired(script: ScriptCall[], caps: ModelCaps): { conn: Connection; requests: ModelRequest[] } {
    const provider = createScriptedProvider(script);
    const wire = (req: ModelRequest) => ({
      url: 'mem://script',
      body: { tools: req.tools?.map((t) => t.name) ?? null, toolChoice: req.toolChoice ?? null, stop: req.stop ?? null, reasoning: req.reasoning ?? null, n: req.messages.length },
    });
    return { conn: { id: 'script', provider: Object.assign(provider, { wire }), caps, origin: 'script:script', local: true }, requests: provider.requests };
  }

  for (const transport of ['native', 'prompted'] as const) {
    test(`${transport}: messages, tools and the wire are what round 0 sends`, async () => {
      const w = wired(calls([{ text: 'ok' }]), capsWith(transport));
      const r = await rig([], { connections: { script: w.conn } });
      const s = session(r.engine);
      const p = s.preview();
      if (!p.ok) throw new Error(p.message);
      await reply(s);
      const q = w.requests[0]!;
      expect(p.messages).toEqual(q.messages);
      expect(p.tools).toEqual(transport === 'native' ? q.tools! : [{ name: 'lookup', description: 'Look something up.', schema: expect.any(Object) }]);
      expect(p.wire?.body).toEqual({
        tools: transport === 'native' ? ['lookup'] : null,
        toolChoice: transport === 'native' ? 'auto' : null,
        stop: transport === 'native' ? null : [PROMPTED_STOP],
        reasoning: null,
        n: q.messages.length,
      });
      expect((p.wire?.body as { toolChoice: unknown }).toolChoice).toEqual(q.toolChoice ?? null);
      await r.engine.close();
    });
  }
});
