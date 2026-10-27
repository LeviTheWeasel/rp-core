// M4 demo 5 (ARCHITECTURE.md §15, D-61, D-116): a scripted 300-turn run with VERBOSE RUSSIAN plans
// through the real pipeline (runDirector: readPlan, applyPlan, enrichFromMomentum, the persona filter,
// fitState; the journal) keeps every stored snapshot under the hard cap in UTF-8 bytes. The planner
// writes every text near its 300-character limit in Cyrillic (2 bytes a character), adds arcs, seeds
// and hidden arcs every turn, long directives and ten intentions; the median and the max size go to the
// test output. Two planners: one that fills every directive list to its limit (its authored directive
// alone is over the cap, so fitState's last step drops lastDirective every turn) and one with a
// directive of a usual size (the state's own texts are what fitState has to hold).
import { describe, expect, test } from 'bun:test';
import { checkRecord } from '../../src/agents/director/state.ts';
import { STATE_LIMITS } from '../../src/agents/director/types.ts';
import type { MsgEntry } from '../../src/session/entries.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { calls, drain } from '../engine/kit.ts';
import { fullCaps } from '../engine-m4/kit.ts';
import { bytesOf, demoEngine, ELISEY, MARFA } from './kit.ts';

type Plan = Record<string, unknown>;

const WORDS = (
  'тихий дождь стучит по ставням старого трактира и в сенях пахнет мокрой шерстью дорожной пылью дёгтем ' +
  'Марфа переставляет кружки слишком долго будто ждёт чьих-то шагов за дверью у колодца скрипит ворот ' +
  'мельница на холме молчит но ночью над запрудой поднимается туман и в нём мелькают огни лодок ' +
  'перевозчики говорят вполголоса староста считает монеты под лампой а ворон сидит на коньке крыши'
).split(' ');

/** A deterministic Russian text of about `chars` characters (never over 300). */
function text(seed: number, chars = 290): string {
  let x = (seed * 2654435761) >>> 0;
  let out = '';
  while (out.length < chars) {
    x = (Math.imul(x ^ (x >>> 15), 2246822519) + 3266489917) >>> 0;
    const w = WORDS[x % WORDS.length]!;
    out += (out === '' ? w[0]!.toUpperCase() + w.slice(1) : ` ${w}`);
  }
  return out.slice(0, Math.min(chars, 299)).trimEnd() + '.';
}

const title = (kind: string, n: number): string => `${kind} ${n}: ${text(n * 7 + kind.length, 60)}`.slice(0, 78);

/** The planner of turn `t`: verbose on every state field; `max` fills every directive list too. */
function verbosePlan(t: number, directive: 'max' | 'usual'): Plan {
  const arcs: Plan[] = [];
  // Two new arcs a turn, with long texts and a next beat.
  for (const k of [0, 1]) {
    const n = t * 2 + k;
    arcs.push({ title: title('Нить', n), description: text(n), status: 'seeding', arcType: k ? 'side' : 'main', priority: 'active', horizon: 'medium', nextBeat: { description: text(n + 1000) } });
  }
  // Three older arcs move: a new stage, a delivered beat and a new one; the oldest of them completes.
  for (const back of [1, 3, 5]) {
    const n = (t - back) * 2;
    if (n < 2) continue;
    arcs.push({ arcId: title('Нить', n), newStageTitle: text(n * 3 + t, 280), markNextBeatDelivered: true, nextBeat: { description: text(n * 5 + t) }, ...(back === 5 ? { status: 'complete' } : {}) });
  }
  const seeds: Plan[] = [0, 1].map((k) => ({ title: title('Знак', t * 2 + k), action: 'plant', scope: 'world', description: text(t * 13 + k), payoffHorizon: 'long' }));
  if (t > 4) seeds.push({ title: title('Знак', (t - 4) * 2), action: 'reinforce', reinforcement: text(t * 17) });
  if (t > 8) seeds.push({ title: title('Знак', (t - 8) * 2 + 1), action: 'resolve', outcome: text(t * 19) });
  const hidden: Plan[] = [];
  if (t % 2 === 0) hidden.push({ title: title('Тень', t), action: 'add', arcType: 'conspiracy', description: text(t * 23), surfaceCondition: text(t * 29) });
  if (t > 4) hidden.push({ title: title('Тень', t - (t % 2) - 2), action: 'update', newClue: text(t * 31), newStageTitle: text(t * 37, 200) });
  const many = (seed: number, n: number): string[] => Array.from({ length: n }, (_, i) => text(seed + i * 101));
  const usual = {
    mood: 'напряжённый',
    pacing: 'slow',
    narrativeGoal: text(t * 41),
    endingHook: text(t * 43),
    arcDirections: [0, 1].map((i) => ({ arcName: title('Нить', Math.max(2, (t - i) * 2)), instruction: text(t * 79 + i), urgency: 'moderate' })),
    characterBeats: [{ character: 'Марфа', beat: text(t * 97), motivation: text(t * 101) }],
  };
  return {
    directive: directive === 'usual' ? usual : {
      mood: 'напряжённый, настороженный, тревожный',
      pacing: 'slow',
      narrativeGoal: text(t * 41),
      endingHook: text(t * 43),
      include: { themes: many(t * 47, 12), sensoryDetails: many(t * 53, 12), foreshadowing: many(t * 59, 12) },
      avoid: { topics: many(t * 61, 12), revelations: many(t * 67, 12) },
      sceneGuidance: { setting: text(t * 71), atmosphere: text(t * 73), tension_level: 7 },
      arcDirections: Array.from({ length: 12 }, (_, i) => ({ arcName: title('Нить', Math.max(2, (t - i) * 2)), instruction: text(t * 79 + i), urgency: 'moderate' })),
      callbacks: Array.from({ length: 12 }, (_, i) => ({ reference: text(t * 83 + i, 120), instruction: text(t * 89 + i) })),
      characterBeats: Array.from({ length: 12 }, (_, i) => ({ character: 'Марфа', beat: text(t * 97 + i), motivation: text(t * 101 + i) })),
      dialogueGuidance: Array.from({ length: 6 }, (_, i) => ({ character: 'Марфа', tone: text(t * 103 + i, 120), hints: many(t * 107 + i, 6) })),
    },
    arcUpdates: arcs,
    seedUpdates: seeds,
    invisibleArcUpdates: hidden,
    analysis: {
      whatHappened: text(t * 109),
      summary: text(t * 113),
      intentions: Array.from({ length: 10 }, (_, i) => ({ type: 'escalate', description: text(t * 127 + i), priority: 'must', targetTurn: 'next' })),
    },
    chapterUpdate:
      t % 25 === 1
        ? { action: 'start_new', title: `Глава ${Math.ceil(t / 25)}: ${text(t, 60)}`, description: text(t * 131), themes: many(t * 137, 12), tone: text(t * 139, 120), closingMoment: text(t * 149) }
        : { action: 'update', title: '', description: text(t * 151), themes: many(t * 157, 12) },
  };
}

const TURNS = 300;

describe('demo: 300 verbose Russian turns stay under the cap', () => {
  test.each(['max', 'usual'] as const)(`every stored state is at most ${STATE_LIMITS.hardBytes} bytes (UTF-8): directive %s`, async (directive) => {
    const plans = Array.from({ length: TURNS }, (_, i) => `<plan>${JSON.stringify(verbosePlan(i + 1, directive))}</plan>`);
    const script = calls(...plans.flatMap((p, i) => [[{ text: p }], [{ text: `Марфа отвечает на ход ${i + 1}.` }]]));
    const d = await demoEngine(script, fullCaps());
    const s = d.engine.createSession({ character: MARFA, persona: ELISEY, config: { director: { enabled: true } } });
    const failed: string[] = [];
    for (let turn = 1; turn <= TURNS; turn++) {
      s.send({ text: `Ход ${turn}: ${text(turn * 3, 120)}`, expectedVersion: s.version() });
      const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
      for (const ev of await drain(t)) if (ev.type === 'director' && ev.status === 'failed') failed.push(`${turn}: ${ev.reason}`);
      expect((await t.result).type).toBe('done');
    }
    await d.engine.close();
    expect(failed).toEqual([]);

    const records = readSessionFile(d.home, s.id)
      .entries.filter((e): e is MsgEntry & { t: 'msg' } => e.t === 'msg' && e.role === 'assistant' && e.dir !== undefined)
      .map((e) => checkRecord(e.dir));
    expect(records).toHaveLength(TURNS);
    const sizes = records.map((r) => bytesOf(r!.state));
    const sorted = [...sizes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const max = sorted.at(-1)!;
    const over = sizes.filter((n) => n > STATE_LIMITS.hardBytes).length;
    const typical = sizes.filter((n) => n <= STATE_LIMITS.typicalBytes).length;
    const steps = new Map<string, number>();
    for (const r of records) for (const k of r!.skipped) if (k.path === 'state' && k.why.startsWith('fit:')) steps.set(k.why, (steps.get(k.why) ?? 0) + 1);
    console.log(
      `\n300 verbose Russian turns (directive ${directive}): state bytes median ${median}, max ${max}, over ${STATE_LIMITS.hardBytes}: ${over}, ` +
        `within the typical ${STATE_LIMITS.typicalBytes}: ${typical}; the last record: ${records.at(-1)!.state.arcs.length} arcs, ` +
        `${records.at(-1)!.state.seeds.length} seeds, ${records.at(-1)!.state.invisibleArcs.length} hidden arcs; ` +
        `fit steps used: ${[...steps].map(([k, n]) => `${k} ×${n}`).join(', ') || 'none'}; ` +
        `self-audits kept: ${records.filter((r) => r!.state.lastDirective !== undefined).length}\n`,
    );
    expect(records.every((r) => r !== null && r.ok)).toBe(true);
    expect(max).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
    expect(records.at(-1)!.turn).toBe(TURNS);
  }, 60_000);
});
