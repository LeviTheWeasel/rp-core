// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The Director's request always fits its window (.notes/m4-decisions.md D-121), follows only the
// narrator's connection and model (D-119), never audits a hidden reply (D-123) and gets the narrator's
// server-truncation check (D-121.5). Each test failed before its fix: the lite profile sent a flat
// 1 500 max_tokens over any prompt (4 096 windows from turn 1, 8 192 after ~15 turns), an explicit
// 'full' ran on 16–20k windows with max_tokens of a few hundred, a too-small window still sent the
// call, a narrator capped at 300 tokens capped every plan, a hidden reply was quoted in the
// self-audit, and nobody was told when the server cut a Director prompt.
import { describe, expect, test } from 'bun:test';
import { DIRECTOR_OUTPUT_FLOOR } from '../../src/agents/director/call.ts';
import { Engine } from '../../src/engine/engine.ts';
import type { EngineHandle, SessionHandle } from '../../src/engine/api.ts';
import type { Event } from '../../src/protocol/events.ts';
import { CHARS_COUNTER, estimateTokens, MESSAGE_OVERHEAD_TOKENS, O200K_COUNTER, type TokenCounter } from '../../src/prompt/tokens.ts';
import type { ModelCaps, ModelRequest } from '../../src/providers/types.ts';
import { answer, fakeConn, fakeProvider, type FakeProvider } from '../engine-m1b/fake.ts';
import { ELISEY, MARFA } from '../demo-m4/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import {
  byAgent,
  calls,
  dirCall,
  directorUser,
  dirSession,
  drain,
  fullCaps,
  msgRow,
  noticeCodes,
  planOf,
  recordOf,
  rig,
  say,
  scriptConn,
  statuses,
  tagged,
  turnOf,
} from './kit.ts';

const NARR = (text = 'The lamp gutters.') => [{ text }];

/** What a request's messages count, as the Director counts its prompt (each message + its overhead). */
const promptOf = (req: ModelRequest, counter: TokenCounter): number =>
  req.messages.reduce((n, m) => n + estimateTokens(m.blocks.reduce((s, b) => (b.k === 'text' ? s + b.text : s), ''), counter) + MESSAGE_OVERHEAD_TOKENS, 0);

const noticesOf = (evs: readonly Event[]): Extract<Event, { type: 'notice' }>[] => evs.filter((e): e is Extract<Event, { type: 'notice' }> => e.type === 'notice');

// ---- D-119 ------------------------------------------------------------------------------------------

describe('following the narrator = its connection and model only (D-119)', () => {
  const narrator = { conn: 'script', model: 'default', maxTokens: 300, samplers: { temperature: 1.3, top_p: 0.5 }, reasoning: 'high' as const };

  test('a narrator capped at 300 tokens: the lite Director still asks for its own 1 500, at its own temperature', async () => {
    const r = await rig(calls(dirCall(), NARR()));
    const s = dirSession(r.engine, { config: { roles: { narrator } } });
    const { out } = await turnOf(s);
    expect(out.type).toBe('done');
    const d = byAgent(r.provider.requests, 'director')[0]!;
    const n = byAgent(r.provider.requests, 'narrator')[0]!;
    expect(n.maxTokens).toBe(300);
    expect(d.maxTokens).toBe(1_500);
    expect(d.samplers).toEqual({ temperature: 0.7 });
    // SCRIPT_CAPS can turn reasoning off: the Director's own choice, not the narrator's 'high'.
    expect(d.reasoning).toBe('none');
    await r.engine.close();
  });

  test("the full profile asks for its 16 384 under a 300-token narrator ('narrator' spelled out too)", async () => {
    const r = await rig(calls(dirCall(), NARR()), { caps: fullCaps() });
    const s = dirSession(r.engine, { config: { roles: { narrator, director: 'narrator' } } });
    await turnOf(s);
    const d = byAgent(r.provider.requests, 'director')[0]!;
    expect(d.maxTokens).toBe(16_384);
    expect(d.samplers?.top_p).toBeUndefined();
    await r.engine.close();
  });

  test('an explicit director binding keeps all its fields (D-101)', async () => {
    const dir = scriptConn('dir', calls(dirCall()), fullCaps());
    const r = await rig(calls(NARR()), { caps: fullCaps(), connections: { dir: dir.conn } });
    const s = dirSession(r.engine, {
      config: { roles: { narrator, director: { conn: 'dir', model: 'm', maxTokens: 2_000, samplers: { temperature: 0.2, top_p: 0.9 } } } },
    });
    await turnOf(s);
    const d = dir.provider.requests[0]!;
    expect(d.maxTokens).toBe(2_000);
    expect(d.samplers).toEqual({ temperature: 0.2, top_p: 0.9 });
    await r.engine.close();
  });
});

// ---- D-123: the self-audit skips a hidden reply -----------------------------------------------------

describe('the self-audit never quotes a hidden reply (D-123)', () => {
  test('hide R1, send U2 under it: no audit, the hidden prose is in no Director prompt', async () => {
    const r = await rig(calls(dirCall(), NARR('SECRET hidden prose.'), dirCall(planOf({ chapterUpdate: { action: 'none' } })), NARR('R2.')));
    const s = dirSession(r.engine, { text: 'U1' });
    const one = await turnOf(s);
    s.hide({ messageId: one.turn.messageId, hidden: true, expectedVersion: s.version() });
    await say(s, 'U2');
    const second = directorUser(byAgent(r.provider.requests, 'director')[1]!);
    expect(second).not.toContain('[SELF-AUDIT]');
    expect(second).not.toContain('SECRET hidden prose.');
    await r.engine.close();
  });

  test('a visible reply is still audited', async () => {
    const r = await rig(calls(dirCall(), NARR('Visible prose.'), dirCall(planOf({ chapterUpdate: { action: 'none' } })), NARR('R2.')));
    const s = dirSession(r.engine, { text: 'U1' });
    await turnOf(s);
    await say(s, 'U2');
    const second = directorUser(byAgent(r.provider.requests, 'director')[1]!);
    expect(second).toContain('[SELF-AUDIT]');
    expect(second).toContain('Visible prose.');
    await r.engine.close();
  });
});

// ---- D-121: the window ------------------------------------------------------------------------------

describe('the Director never sends more than its window holds (D-121)', () => {
  test("an explicit 'full' on an 18k window whose full prompt + 4 096 does not fit runs lite and says so once", async () => {
    // A long persona fills the full system prompt: ~17k tokens + 4 096 > 18 432; lite (~11k) fits.
    const caps = fullCaps({ contextLength: 18_432 });
    const r = await rig(calls(dirCall(), NARR('One.'), dirCall(planOf({ chapterUpdate: { action: 'none' } })), NARR('Two.')), { caps });
    const persona = { name: 'Levi', description: 'A traveller who talks a lot about roads, rivers and rain. '.repeat(600) };
    const s = dirSession(r.engine, { director: { profile: 'full' }, persona });
    const one = await turnOf(s);
    expect(noticeCodes(one.evs)).toEqual(['director_lite']);
    expect(noticesOf(one.evs)[0]!.message).toContain('do not fit');
    const d = byAgent(r.provider.requests, 'director')[0]!;
    expect(d.maxTokens).toBe(1_500);
    expect(directorUser(d)).not.toContain('### Shadow World');
    expect(promptOf(d, O200K_COUNTER) + d.maxTokens).toBeLessThanOrEqual(18_432);
    expect(recordOf(msgRow(r.home, s.id, one.turn.messageId).dir).profile).toBe('lite');
    const two = await say(s, 'Again.');
    expect(noticeCodes(two.evs)).toEqual([]);
    await r.engine.close();
  });

  test('the same session on a 32k window plans full', async () => {
    const r = await rig(calls(dirCall(), NARR()), { caps: fullCaps() });
    const persona = { name: 'Levi', description: 'A traveller who talks a lot about roads, rivers and rain. '.repeat(600) };
    const s = dirSession(r.engine, { director: { profile: 'full' }, persona });
    const one = await turnOf(s);
    expect(noticeCodes(one.evs)).toEqual([]);
    const d = byAgent(r.provider.requests, 'director')[0]!;
    expect(promptOf(d, O200K_COUNTER) + d.maxTokens).toBeLessThanOrEqual(32_768);
    expect(d.maxTokens).toBeGreaterThanOrEqual(4_096);
    expect(recordOf(msgRow(r.home, s.id, one.turn.messageId).dir).profile).toBe('full');
    await r.engine.close();
  });

  test('a window too small for even the shortened lite prompt: no request, failed (no_room), told once; the reply arrives', async () => {
    const dir = scriptConn('dir', calls(dirCall(), dirCall()), { ...fullCaps(), contextLength: 2_048 });
    const r = await rig(calls(NARR('One.'), NARR('Two.')), { caps: fullCaps(), connections: { dir: dir.conn } });
    const s = dirSession(r.engine, { config: { roles: { director: { conn: 'dir', model: 'm' } } } });
    const one = await turnOf(s);
    expect(dir.provider.requests).toHaveLength(0);
    expect(statuses(one.evs)).toEqual(['failed']);
    expect(one.evs.find((e) => e.type === 'director')).toMatchObject({ reason: 'no_room' });
    expect(noticeCodes(one.evs)).toEqual(['director_no_room']);
    expect(noticesOf(one.evs)[0]!.message).toContain('2048 tokens');
    expect(one.out.type).toBe('done');
    const rec = recordOf(msgRow(r.home, s.id, one.turn.messageId).dir);
    expect(rec).toMatchObject({ ok: false, code: 'no_room', turn: 1, profile: 'lite', model: 'dir:m', attempts: [] });
    expect(rec.directive).toBeUndefined();
    const two = await say(s, 'Again.');
    expect(dir.provider.requests).toHaveLength(0);
    expect(noticeCodes(two.evs)).toEqual([]);
    expect(recordOf(msgRow(r.home, s.id, two.out.type === 'done' ? two.out.message.id : '').dir)).toMatchObject({ code: 'no_room', turn: 2 });
    await r.engine.close();
  });

  test(`the floor: a window that leaves exactly ${DIRECTOR_OUTPUT_FLOOR} output tokens is used to the token, one less sends nothing`, async () => {
    /** One lite turn on a Director window of `window` tokens: its request (if any) and its notices. */
    const once = async (window: number): Promise<{ req?: ModelRequest; notices: string[] }> => {
      const dir = scriptConn('dir', calls(dirCall()), fullCaps({ contextLength: window }));
      const r = await rig(calls(NARR()), { caps: fullCaps(), connections: { dir: dir.conn } });
      const t = await turnOf(dirSession(r.engine, { director: { profile: 'lite' }, config: { roles: { director: { conn: 'dir', model: 'm' } } } }));
      await r.engine.close();
      return { ...(dir.provider.requests[0] ? { req: dir.provider.requests[0] } : {}), notices: noticeCodes(t.evs) };
    };
    // On a 3 800 window the lite prompt is shrunk all the way (no history, short lists): its size no
    // longer depends on the window.
    const probe = await once(3_800);
    expect(directorUser(probe.req!)).toContain('history is left out');
    const size = promptOf(probe.req!, O200K_COUNTER);

    const fits = await once(size + DIRECTOR_OUTPUT_FLOOR);
    expect(fits.req!.maxTokens).toBe(DIRECTOR_OUTPUT_FLOOR);
    expect(promptOf(fits.req!, O200K_COUNTER)).toBe(size);
    expect(fits.notices).toEqual([]);

    const tight = await once(size + DIRECTOR_OUTPUT_FLOOR - 1);
    expect(tight.req).toBeUndefined();
    expect(tight.notices).toEqual(['director_no_room']);
  });
});

// ---- D-121: a grown Russian state on small windows --------------------------------------------------

const WORDS = (
  'тихий дождь стучит по ставням старого трактира и в сенях пахнет мокрой шерстью дорожной пылью дёгтем ' +
  'Марфа переставляет кружки слишком долго будто ждёт чьих-то шагов за дверью у колодца скрипит ворот'
).split(' ');

/** Deterministic Russian text of about `chars` characters. */
function text(seed: number, chars = 200): string {
  let x = (seed * 2654435761) >>> 0;
  let out = '';
  while (out.length < chars) {
    x = (Math.imul(x ^ (x >>> 15), 2246822519) + 3266489917) >>> 0;
    const w = WORDS[x % WORDS.length]!;
    out += out === '' ? w[0]!.toUpperCase() + w.slice(1) : ` ${w}`;
  }
  return `${out.slice(0, Math.min(chars, 299)).trimEnd()}.`;
}

/** A moderate Russian planner: a new arc every other turn, a seed every other turn, a stage on an older arc. */
function growPlan(t: number): Record<string, unknown> {
  const arcUpdates: Record<string, unknown>[] = [];
  if (t % 2 === 1) arcUpdates.push({ title: `Нить ${t}`, description: text(t, 150), status: 'seeding', arcType: 'main', horizon: 'medium', nextBeat: text(t + 500, 150) });
  if (t > 2) arcUpdates.push({ arcId: `Нить ${t % 2 === 0 ? t - 1 : t - 2}`, newStageTitle: text(t * 3, 100), nextBeat: text(t * 5, 150) });
  const seedUpdates: Record<string, unknown>[] = [];
  if (t % 2 === 0) seedUpdates.push({ title: `Знак ${t}`, action: 'plant', description: text(t * 7, 150), payoffHorizon: 'long' });
  return {
    directive: { mood: 'напряжённый', pacing: 'slow', narrativeGoal: text(t * 11, 150), endingHook: text(t * 13, 120) },
    arcUpdates,
    seedUpdates,
    analysis: { whatHappened: text(t * 17, 150), intentions: [{ type: 'escalate', description: text(t * 19, 120), priority: 'must' }] },
    chapterUpdate: t === 1 ? { action: 'start_new', title: 'Глава 1', description: text(1, 150) } : { action: 'none', title: '' },
  };
}

/** One local connection for both roles (the Director follows the narrator): plans by the prompt's turn, prose otherwise. */
function smallModel(window: number, more: Partial<ModelCaps> = {}): { provider: FakeProvider; caps: ModelCaps } {
  const provider = fakeProvider((req) => {
    if (req.agent === 'director') {
      const turn = Number(/^## Turn (\d+)/m.exec(directorUser(req))?.[1] ?? '1');
      return answer(tagged(growPlan(turn)));
    }
    return answer(`Марфа отвечает. ${text(req.messages.length * 23, 600)}`);
  });
  return { provider, caps: { ...fullCaps(), contextLength: window, ...more } };
}

async function grow(window: number, turns: number, counter: TokenCounter, more: Partial<ModelCaps> = {}): Promise<{
  rows: { turn: number; prompt: number; max: number; shrunk: boolean }[];
  records: { ok: boolean; code?: string }[];
  notices: string[];
}> {
  const { provider, caps } = smallModel(window, more);
  const engine: EngineHandle = await Engine.open({
    home: tmpHome('rp-core-window-'),
    connections: { local: fakeConn('local', provider, { caps, local: true }) },
    clock: fakeClock(),
    random: fakeRandom(5),
    timeZone: 'UTC',
    checkpoint: { chars: 4_000, ms: 1_000, datasyncMs: 1_000 },
    retryMaxDelayMs: 5,
    counter,
  });
  const s: SessionHandle = engine.createSession({
    character: MARFA,
    persona: ELISEY,
    config: { roles: { narrator: { conn: 'local', model: 'mag', maxTokens: 300 } }, director: { enabled: true } },
  });
  const rows: { turn: number; prompt: number; max: number; shrunk: boolean }[] = [];
  const records: { ok: boolean; code?: string }[] = [];
  const notices: string[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    s.send({ text: `Ход ${turn}: ${text(turn * 3, 200)}`, expectedVersion: s.version() });
    const before = byAgent(provider.requests, 'director').length;
    const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
    const evs = await drain(t);
    const out = await t.result;
    expect(out.type).toBe('done');
    notices.push(...noticeCodes(evs));
    const ev = evs.find((e): e is Extract<Event, { type: 'director' }> => e.type === 'director' && e.status !== 'planning')!;
    records.push(ev.status === 'planned' ? { ok: true } : { ok: false, ...(ev.reason !== undefined ? { code: ev.reason } : {}) });
    for (const req of byAgent(provider.requests, 'director').slice(before)) {
      const user = directorUser(req);
      rows.push({ turn, prompt: promptOf(req, counter), max: req.maxTokens!, shrunk: user.includes('history is left out') || / more (arcs|active arcs|pending seeds) not shown\)/.test(user) });
    }
  }
  await engine.close();
  return { rows, records, notices };
}

describe('a grown Russian state on small local windows: prompt + max_tokens ≤ window on every Director request (D-121)', () => {
  // o200k is the engine's counter; the chars counter overcounts Cyrillic (2.5 chars a token), so on 8k
  // it runs out of room once the state is grown (no_room then, never an over-window request).
  for (const [window, counter, name] of [
    [8_192, O200K_COUNTER, 'o200k'],
    [8_192, CHARS_COUNTER, 'chars'],
    [4_096, O200K_COUNTER, 'o200k'],
  ] as const) {
    test(`${window} tokens, ${name} counter, 40 turns`, async () => {
      const { rows, records, notices } = await grow(window, 40, counter);
      for (const r of rows) {
        expect(r.prompt + r.max).toBeLessThanOrEqual(window);
        expect(r.max).toBeGreaterThanOrEqual(DIRECTOR_OUTPUT_FLOOR);
      }
      // Every turn either planned (one request) or found no room (no request).
      expect(records).toHaveLength(40);
      for (const rec of records) expect(rec.ok || rec.code === 'no_room').toBe(true);
      expect(rows.length).toBe(records.filter((r) => r.ok).length);
      // no_room is told once at most.
      expect(notices.filter((n) => n === 'director_no_room').length).toBe(records.some((r) => !r.ok) ? 1 : 0);
      if (window === 8_192) {
        // The first turns fit as they are; the grown state is shrunk to fit (before D-121 the o200k
        // run went over the window by turn 25 and the chars one by turn 15).
        expect(records.slice(0, 10).every((r) => r.ok)).toBe(true);
        expect(rows[0]!.shrunk).toBe(false);
        expect(rows.some((r) => r.shrunk)).toBe(true);
        if (name === 'o200k') expect(records.every((r) => r.ok)).toBe(true);
      } else {
        // 4k: only a fully shrunk prompt fits at all, and only while the state is small.
        expect(records[0]!.ok).toBe(true);
        expect(rows.every((r) => r.shrunk)).toBe(true);
      }
    }, 120_000);
  }

  test('a thinking model that cannot turn reasoning off: the lite reserve is 2 524 and still fits 8 192', async () => {
    const { rows } = await grow(8_192, 12, O200K_COUNTER, { reasoning: { output: 'reasoning_content', control: 'none', canDisable: false, echo: 'never' } });
    expect(rows.length).toBe(12);
    for (const r of rows) {
      expect(r.prompt + r.max).toBeLessThanOrEqual(8_192);
      expect(r.max).toBeLessThanOrEqual(2_524);
    }
    expect(rows[0]!.max).toBe(2_524);
  }, 120_000);
});

// ---- D-121.5: the server cut the Director's prompt ---------------------------------------------------

describe("a server that cut the Director's prompt (D-121.5)", () => {
  test('told once per session as context_truncated_by_server, with what to do', async () => {
    const usage = (inputTotal: number) => ({ usage: { inputTotal, outputTotal: 50 } });
    const r = await rig(calls(dirCall(planOf(), [usage(21)]), NARR('One.'), dirCall(planOf({ chapterUpdate: { action: 'none' } }), [usage(21)]), NARR('Two.')));
    const s = dirSession(r.engine);
    const one = await turnOf(s);
    const told = noticesOf(one.evs).filter((n) => n.code === 'context_truncated_by_server');
    expect(told).toHaveLength(1);
    expect(told[0]!.level).toBe('warn');
    expect(told[0]!.message).toContain('Director prompt');
    expect(told[0]!.message).toContain('[caps."script:default"]');
    expect(statuses(one.evs)).toEqual(['planning', 'planned']);
    const two = await say(s, 'Again.');
    expect(noticeCodes(two.evs)).toEqual([]);
    await r.engine.close();
  });

  test('an ordinary report is not truncation', async () => {
    const r = await rig(calls(dirCall(planOf(), [{ usage: { inputTotal: 3_000, outputTotal: 50 } }]), NARR()));
    const s = dirSession(r.engine);
    const one = await turnOf(s);
    expect(noticeCodes(one.evs)).not.toContain('context_truncated_by_server');
    await r.engine.close();
  });
});
