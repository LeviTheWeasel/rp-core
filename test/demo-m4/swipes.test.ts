// M4 demos 2–4 (ARCHITECTURE.md §15): a swipe reuses the plan and `/regen <guidance>` replans; a rollback
// returns the previous state; a broken plan on a small model gives `director: failed (undecodable)` and
// the reply still arrives. Short Russian chats on the scripted provider; the REPL-like director lines
// go to the test output.
import { describe, expect, test } from 'bun:test';
import { renderDirective } from '../../src/agents/director/render.ts';
import type { DirectorRecord } from '../../src/agents/director/types.ts';
import type { SessionHandle } from '../../src/engine/api.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { MsgEntry } from '../../src/session/entries.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { CHARS_COUNTER, estimateTokens, MESSAGE_OVERHEAD_TOKENS } from '../../src/prompt/tokens.ts';
import { calls, drain } from '../engine/kit.ts';
import { scriptFile } from '../engine-m4/kit.ts';
import { atHead, demoEngine, directorLine, dumpState, ELISEY, MARFA } from './kit.ts';

type Plan = Record<string, unknown>;
const tagged = (p: Plan): string => `<plan>${JSON.stringify(p)}</plan>`;

const PLAN_1: Plan = {
  directive: { mood: 'настороженный', narrativeGoal: 'Марфа присматривается к гостю.', characterBeats: [{ character: 'Марфа', beat: 'проверяет, не беглый ли он' }] },
  arcUpdates: [{ title: 'Пропавший брат', description: 'Тихон ушёл на мельницу.', status: 'seeding', arcType: 'main', nextBeat: { description: 'Марфа упоминает мельницу.' } }],
  seedUpdates: [{ title: 'Ржавый ключ', action: 'plant', scope: 'world', description: 'Откроет подвал.' }],
  chapterUpdate: { action: 'start_new', title: 'Трактир' },
};
const PLAN_2: Plan = {
  directive: { mood: 'тревожный', narrativeGoal: 'Елисей слышит о мельнице.' },
  arcUpdates: [{ arcId: 'Пропавший брат', newStageTitle: 'Слух о мельнице', status: 'building', markNextBeatDelivered: true, nextBeat: { description: 'Ночью скрипят жернова.' } }],
  invisibleArcUpdates: [{ title: 'Гильдия перевозчиков', action: 'add', arcType: 'faction', description: 'Прячут что-то на мельнице.' }],
  chapterUpdate: { action: 'none' },
};
const PLAN_GENTLE: Plan = {
  directive: { mood: 'тихий', narrativeGoal: 'Марфа смягчается и наливает чаю.' },
  arcUpdates: [{ arcId: 'Пропавший брат', newStageTitle: 'Чай и разговор', nextBeat: { description: 'Марфа сама заговорит о Тихоне.' } }],
  chapterUpdate: { action: 'none' },
};
const PLAN_OTHER: Plan = {
  directive: { mood: 'мрачный', narrativeGoal: 'Елисей уходит спать, не узнав ничего.' },
  arcUpdates: [{ title: 'Ночные гости', description: 'Кто-то стучит в ставни.', status: 'seeding', arcType: 'side' }],
  chapterUpdate: { action: 'none' },
};

async function turn(s: SessionHandle, kind: 'reply' | 'swipe', lines: string[], label: string, guidance?: string): Promise<{ id: string; evs: Event[] }> {
  const t = s.runTurn({ kind, expectedVersion: s.version(), ...(guidance ? { guidance } : {}) });
  const evs = await drain(t);
  const out = await t.result;
  if (out.type !== 'done') throw new Error(`${label}: ${out.type}`);
  for (const ev of evs) {
    const line = directorLine(ev);
    if (line) lines.push(`${label.padEnd(18)} ${line}`);
  }
  return { id: out.message.id, evs };
}

const dirOf = (home: string, s: SessionHandle, id: string): DirectorRecord =>
  (readSessionFile(home, s.id).entries.find((e) => e.t === 'msg' && e.id === id) as MsgEntry).dir as DirectorRecord;

describe('demo: swipe, regen, rollback', () => {
  test('a swipe reuses the plan, /regen replans with the guidance, a rollback plans from the earlier state', async () => {
    const d = await demoEngine(
      calls(
        [{ text: tagged(PLAN_1) }],
        [{ text: 'Марфа щурится: «Издалека?»' }],
        [{ text: 'Марфа молча ставит кружку.' }], // swipe: no Director call
        [{ text: tagged(PLAN_GENTLE) }],
        [{ text: 'Марфа вздыхает и наливает чаю.' }], // /regen
        [{ text: tagged(PLAN_2) }],
        [{ text: 'Говорят, на мельнице по ночам жернова скрипят.' }],
        [{ text: tagged(PLAN_OTHER) }],
        [{ text: 'В ставни кто-то стучит.' }], // after the rollback
      ),
    );
    const s = d.engine.createSession({ character: MARFA, persona: ELISEY, config: { director: { enabled: true } } });
    const lines: string[] = [];
    s.send({ text: 'Здравствуй, хозяйка. Ищу брата.', expectedVersion: s.version() });
    const a1 = await turn(s, 'reply', lines, 'reply');
    const sw = await turn(s, 'swipe', lines, 'swipe');
    const rg = await turn(s, 'swipe', lines, '/regen помягче', 'Пусть Марфа будет помягче.');
    s.send({ text: 'Что за мельница?', expectedVersion: s.version() });
    const a2 = await turn(s, 'reply', lines, 'reply');
    const atA2 = atHead(d.home, s);

    // Rollback: back to the first answer's /regen version, then another question.
    s.select({ messageId: rg.id, expectedVersion: s.version(), exact: true });
    const back = atHead(d.home, s);
    s.send({ text: 'Пойду-ка я спать.', expectedVersion: s.version() });
    const a3 = await turn(s, 'reply', lines, 'reply after rollback');
    console.log(`\n${lines.join('\n')}\n\nat the second answer:\n${dumpState(atA2.state, atA2.record)}\n\nafter the rollback:\n${dumpState(atHead(d.home, s).state)}\n`);

    // The swipe reused the plan: no call, the same directive, reusedFrom the first answer.
    const r1 = dirOf(d.home, s, a1.id);
    const rs = dirOf(d.home, s, sw.id);
    expect(lines[1]).toContain('⋯ director: reused');
    expect(rs).toMatchObject({ reusedFrom: a1.id, attempts: [], directive: r1.directive, state: r1.state });
    const narr = d.provider.requests.filter((r) => r.agent === 'narrator');
    const dirMsg = (i: number) => narr[i]!.messages.find((m) => m.src === 'director');
    expect(dirMsg(1)).toEqual(dirMsg(0));
    // /regen replanned from the state at U, with the guidance.
    const rr = dirOf(d.home, s, rg.id);
    expect(rr.reusedFrom).toBeUndefined();
    expect(rr.directive!.mood).toBe('тихий');
    expect(rr.turn).toBe(1);
    expect(rr.state.arcs[0]!.stages.map((x) => x.title)).toEqual(['Чай и разговор']);
    const dirReqs = d.provider.requests.filter((r) => r.agent === 'director');
    expect(dirReqs).toHaveLength(4);
    expect(JSON.stringify(dirReqs[1]!.messages)).toContain('Пусть Марфа будет помягче.');
    // The second answer grew from the /regen version (its state at U).
    expect(atA2.state.turn).toBe(2);
    expect(atA2.state.invisibleArcs.map((h) => h.title)).toEqual(['Гильдия перевозчиков']);
    expect(atA2.state.arcs[0]!.stages.map((x) => x.title)).toEqual(['Чай и разговор', 'Слух о мельнице']);
    // The rollback: the state at the head is the /regen one again, and the next plan starts from it.
    expect(back.state).toEqual(rr.state);
    const r3 = dirOf(d.home, s, a3.id);
    expect(r3.turn).toBe(2);
    expect(r3.state.invisibleArcs).toEqual([]);
    expect(r3.state.arcs.map((a) => a.title)).toEqual(['Пропавший брат', 'Ночные гости']);
    expect(a2.id).not.toBe(a3.id);
    await d.engine.close();
  });
});

describe('demo: a broken plan on a small model', () => {
  test('lite on an 8k window: failed (undecodable) after the correction, the reply arrives', async () => {
    // SCRIPT_CAPS: an 8 192-token window, so 'auto' plans lite.
    const d = await demoEngine(scriptFile('director-broken.jsonl'));
    const s = d.engine.createSession({ character: MARFA, persona: ELISEY, config: { director: { enabled: true } } });
    s.send({ text: 'Здравствуй, хозяйка.', expectedVersion: s.version() });
    const lines: string[] = [];
    const t = await turn(s, 'reply', lines, 'reply');
    console.log(`\n${lines.join('\n')}\n`);
    expect(lines).toEqual([`${'reply'.padEnd(18)} ⋯ director: failed (undecodable)`]);
    const rec = dirOf(d.home, s, t.id);
    expect(rec).toMatchObject({ ok: false, code: 'undecodable', profile: 'lite', transport: 'tagged', turn: 1 });
    const dirReqs = d.provider.requests.filter((r) => r.agent === 'director');
    // The correction's prompt is longer by the echo and the correction text: its max_tokens is lower
    // by as much (D-121.4), so prompt + max_tokens stays where the first request had it.
    expect(dirReqs[0]!.maxTokens).toBe(1500);
    expect(dirReqs[1]!.maxTokens).toBeLessThan(1500);
    const sumOf = (r: (typeof dirReqs)[number]): number =>
      r.messages.reduce((n, m) => n + estimateTokens(m.blocks.reduce((t, b) => (b.k === 'text' ? t + b.text : t), ''), CHARS_COUNTER) + MESSAGE_OVERHEAD_TOKENS, 0) + r.maxTokens!;
    expect(sumOf(dirReqs[1]!)).toBeLessThanOrEqual(sumOf(dirReqs[0]!));
    expect(JSON.stringify(dirReqs[0]!.messages)).not.toContain('Shadow World');
    const answer = s.view().path.at(-1)!;
    expect(answer.blocks).toEqual([{ k: 'text', text: 'The lamp gutters, and the reply still arrives.' }]);
    // No directive went to the narrator; the contract did.
    const narr = d.provider.requests.find((r) => r.agent === 'narrator')!;
    expect(narr.messages.some((m) => m.src === 'director')).toBe(false);
    expect(narr.messages.some((m) => m.src === 'core:director')).toBe(true);
    expect(renderDirective({ pacing: 'medium' })).toBe('');
    await d.engine.close();
  });
});
