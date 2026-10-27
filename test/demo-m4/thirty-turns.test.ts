// M4 demo 1 (ARCHITECTURE.md §15): after 30 scripted turns the Director's state at the head holds
// chapters, arcs with their next beat, seeds and hidden arcs. A Russian story; the plans are scripted
// (a model's answers, tagged <plan>), everything else is the real engine: runDirector, readPlan,
// applyPlan, fitState, the journal and the fold. The readable dump is printed to the test output.
import { describe, expect, test } from 'bun:test';
import { STATE_LIMITS } from '../../src/agents/director/types.ts';
import { calls, drain } from '../engine/kit.ts';
import { atHead, bytesOf, demoEngine, directorLine, dumpState, ELISEY, MARFA } from './kit.ts';

type Plan = Record<string, unknown>;

const MOODS = ['настороженный', 'тревожный', 'тихий', 'напряжённый', 'спокойный', 'мрачный'];

/** What the Director decides on each turn of the story (1-based); anything absent: no update. */
const STORY: Record<number, { arcs?: Plan[]; seeds?: Plan[]; hidden?: Plan[]; chapter?: Plan }> = {
  1: {
    chapter: { action: 'start_new', title: 'Трактир на перекрёстке', description: 'Елисей приходит в трактир Марфы.', themes: ['дорога', 'недоверие'], tone: 'сдержанный' },
    arcs: [{ title: 'Пропавший брат', description: 'Тихон ушёл на мельницу и не вернулся.', status: 'seeding', arcType: 'main', priority: 'active', horizon: 'long', nextBeat: { description: 'Марфа проговаривается, что видела Тихона.' } }],
  },
  2: { seeds: [{ title: 'Ржавый ключ под половицей', action: 'plant', scope: 'world', description: 'Ключ откроет подвал мельницы.', payoffHorizon: 'medium' }] },
  3: { arcs: [{ title: 'Долг трактирщицы', description: 'Марфа должна перевозчикам.', status: 'seeding', arcType: 'character', priority: 'background', horizon: 'medium', nextBeat: { description: 'К Марфе приходит сборщик долга.' } }] },
  4: {
    arcs: [{ arcId: 'Пропавший брат', newStageTitle: 'Марфа видела Тихона', status: 'building', markNextBeatDelivered: true, nextBeat: { description: 'Елисей находит след у брода.' } }],
    hidden: [{ title: 'Гильдия перевозчиков', action: 'add', arcType: 'faction', description: 'Перевозчики прячут что-то на мельнице.', surfaceCondition: 'когда Елисей спустится в подвал' }],
  },
  5: { seeds: [{ title: 'Ржавый ключ под половицей', action: 'reinforce', reinforcement: 'Половица скрипит под ногой.' }] },
  6: { arcs: [{ title: 'Чужаки на тракте', description: 'Двое всадников спрашивают о Елисее.', status: 'seeding', arcType: 'side', priority: 'active', horizon: 'short', nextBeat: { description: 'Всадники ночуют в трактире.' } }] },
  7: { seeds: [{ title: 'Песня, которую никто не помнит', action: 'plant', scope: 'player', description: 'Тихон пел её в детстве.', payoffHorizon: 'long' }] },
  8: { seeds: [{ title: 'Ржавый ключ под половицей', action: 'reinforce', reinforcement: 'Марфа прячет взгляд, когда Елисей встаёт на половицу.' }] },
  9: { arcs: [{ arcId: 'Пропавший брат', newStageTitle: 'След у брода', markNextBeatDelivered: true, nextBeat: { description: 'У брода находится оброненный нож Тихона.' } }] },
  10: { hidden: [{ title: 'Гильдия перевозчиков', action: 'update', status: 'building', newClue: 'На лодке у брода — клеймо гильдии.' }] },
  11: { arcs: [{ arcId: 'Чужаки на тракте', newStageTitle: 'Всадники в трактире', markNextBeatDelivered: true, nextBeat: { description: 'Один из всадников узнаёт нож.' } }] },
  12: { arcs: [{ title: 'Тайна старой мельницы', description: 'Мельница стоит, но жернова мелют по ночам.', status: 'seeding', arcType: 'mystery', priority: 'active', horizon: 'medium', nextBeat: { description: 'Ночью слышен скрип жерновов.' } }] },
  13: { hidden: [{ title: 'Староста ведёт двойную игру', action: 'add', arcType: 'npc_agenda', description: 'Староста получает долю от перевозчиков.', surfaceCondition: 'если Елисей покажет нож старосте' }] },
  14: { seeds: [{ title: 'Сломанная печать на письме', action: 'plant', scope: 'world', description: 'Письмо Тихона вскрывали до Елисея.', payoffHorizon: 'medium' }] },
  15: {
    chapter: { action: 'start_new', title: 'Дорога к мельнице', description: 'Елисей идёт к мельнице.', themes: ['ночь', 'вода'], tone: 'тревожный', closingMoment: 'Елисей уходит из трактира до рассвета.' },
    arcs: [{ arcId: 'Тайна старой мельницы', newStageTitle: 'Скрип жерновов', status: 'building', markNextBeatDelivered: true, nextBeat: { description: 'На двери мельницы свежий замок.' } }],
  },
  16: { arcs: [{ arcId: 'Пропавший брат', newStageTitle: 'Нож Тихона', markNextBeatDelivered: true, nextBeat: { description: 'Нож приводит к лодочнику.' } }] },
  17: { hidden: [{ title: 'Гильдия перевозчиков', action: 'update', newClue: 'Лодочник отводит глаза при слове «мельница».' }] },
  18: { seeds: [{ title: 'Ржавый ключ под половицей', action: 'resolve', outcome: 'Ключ подходит к замку мельницы.' }] },
  19: { arcs: [{ arcId: 'Долг трактирщицы', newStageTitle: 'Сборщик долга', status: 'building', markNextBeatDelivered: true, nextBeat: { description: 'Марфа просит Елисея молчать о долге.' } }] },
  20: {
    arcs: [{ arcId: 'Чужаки на тракте', newStageTitle: 'Всадники уехали', status: 'complete', markNextBeatDelivered: true }],
    seeds: [{ title: 'Сломанная печать на письме', action: 'reinforce', reinforcement: 'На сургуче чужой оттиск.' }],
  },
  21: { hidden: [{ title: 'Староста ведёт двойную игру', action: 'update', newClue: 'Староста знает о ноже раньше, чем ему сказали.' }] },
  22: { arcs: [{ arcId: 'Тайна старой мельницы', newStageTitle: 'Свежий замок', markNextBeatDelivered: true, nextBeat: { description: 'В подвале мельницы — мешки с чужим зерном.' } }] },
  23: { arcs: [{ arcId: 'Пропавший брат', newStageTitle: 'Лодочник', status: 'climax', markNextBeatDelivered: true, nextBeat: { description: 'Голос Тихона из-за двери подвала.' } }] },
  24: { seeds: [{ title: 'Песня, которую никто не помнит', action: 'reinforce', reinforcement: 'Кто-то насвистывает знакомый мотив у реки.' }] },
  25: { seeds: [{ title: 'Ворон на коньке крыши', action: 'plant', scope: 'world', description: 'Ворон прилетает перед бедой.', payoffHorizon: 'short' }] },
  26: { hidden: [{ title: 'Гильдия перевозчиков', action: 'update', status: 'approaching_player', newClue: 'Ночью у мельницы причаливает лодка без фонаря.' }] },
  27: { chapter: { action: 'update', title: 'Дорога к мельнице', status: 'concluding' } },
  28: { arcs: [{ arcId: 'Долг трактирщицы', newStageTitle: 'Просьба о молчании', markNextBeatDelivered: true, nextBeat: { description: 'Марфа отдаёт Елисею фонарь мужа.' } }] },
  29: { arcs: [{ arcId: 'Тайна старой мельницы', newStageTitle: 'Чужое зерно', status: 'climax', markNextBeatDelivered: true, nextBeat: { description: 'Жернова останавливаются, когда входит Елисей.' } }] },
  30: { seeds: [{ title: 'Ворон на коньке крыши', action: 'reinforce', reinforcement: 'Ворон каркает трижды.' }] },
};

function planFor(turn: number): Plan {
  const e = STORY[turn] ?? {};
  return {
    directive: {
      mood: MOODS[turn % MOODS.length],
      pacing: turn % 5 === 0 ? 'fast' : 'slow',
      narrativeGoal: `Ход ${turn}: сцена продвигает поиски Тихона на шаг.`,
      characterBeats: [{ character: 'Марфа', beat: turn % 2 === 0 ? 'отвечает уклончиво' : 'проговаривается о прошлом' }],
    },
    arcUpdates: e.arcs ?? [],
    seedUpdates: e.seeds ?? [],
    invisibleArcUpdates: e.hidden ?? [],
    analysis: {
      whatHappened: `Елисей сделал ход ${turn}.`,
      intentions: [{ type: 'reveal', description: 'Постепенно раскрыть, где Тихон', priority: 'should', targetTurn: 'soon' }],
    },
    chapterUpdate: e.chapter ?? { action: 'none', title: '' },
  };
}

const USER = (turn: number): string => `Елисей (ход ${turn}): расспрашиваю Марфу и смотрю по сторонам.`;
const NARRATOR = (turn: number): string => `Марфа отвечает на ход ${turn}, и в трактире становится чуть тише.`;

describe('demo: 30 turns with the Director', () => {
  test('the state at the head has chapters, arcs with a next beat, seeds and hidden arcs', async () => {
    const script = calls(...Array.from({ length: 30 }, (_, i) => [[{ text: `<plan>${JSON.stringify(planFor(i + 1))}</plan>` }], [{ text: NARRATOR(i + 1) }]]).flat());
    const d = await demoEngine(script);
    const s = d.engine.createSession({ character: MARFA, persona: ELISEY, config: { director: { enabled: true } } });
    const lines: string[] = [];
    for (let turn = 1; turn <= 30; turn++) {
      s.send({ text: USER(turn), expectedVersion: s.version() });
      const t = s.runTurn({ kind: 'reply', expectedVersion: s.version() });
      for (const ev of await drain(t)) {
        const line = directorLine(ev);
        if (line) lines.push(`${String(turn).padStart(2)} ${line}`);
      }
      expect((await t.result).type).toBe('done');
    }
    expect(d.provider.remaining()).toBe(0);

    const { state, record } = atHead(d.home, s);
    console.log(`\n${lines.join('\n')}\n\n${dumpState(state, record)}\n`);

    expect(record).toMatchObject({ ok: true, turn: 30 });
    expect(lines.every((l) => l.includes('planned'))).toBe(true);
    // Chapters: the current one (concluding) and the completed first.
    expect(state.chapters.map((c) => [c.number, c.title, c.status])).toEqual([
      [1, 'Трактир на перекрёстке', 'complete'],
      [2, 'Дорога к мельнице', 'concluding'],
    ]);
    expect(state.currentChapterId).toBe('chapter-2');
    // Arcs with their next beat.
    const arcs = new Map(state.arcs.map((a) => [a.title, a]));
    expect([...arcs.keys()].sort()).toEqual(['Долг трактирщицы', 'Пропавший брат', 'Тайна старой мельницы', 'Чужаки на тракте'].sort());
    expect(arcs.get('Пропавший брат')).toMatchObject({ status: 'climax', nextBeat: { description: 'Голос Тихона из-за двери подвала.', status: 'pending' } });
    expect(arcs.get('Пропавший брат')!.stages.map((x) => x.title)).toEqual(['Марфа видела Тихона', 'След у брода', 'Нож Тихона', 'Лодочник']);
    expect(arcs.get('Тайна старой мельницы')!.nextBeat?.status).toBe('pending');
    expect(arcs.get('Чужаки на тракте')!.status).toBe('complete');
    expect(state.arcs.filter((a) => a.nextBeat?.status === 'pending').length).toBeGreaterThanOrEqual(3);
    // Seeds: planted, reinforced, one paid off.
    const seeds = new Map(state.seeds.map((x) => [x.hint, x]));
    expect(seeds.get('Ржавый ключ под половицей')).toMatchObject({ payoffDelivered: true, payoffTurn: 18 });
    expect(seeds.get('Ржавый ключ под половицей')!.reinforcements).toHaveLength(2);
    expect(seeds.get('Ворон на коньке крыши')).toMatchObject({ payoffDelivered: false, plantedAtTurn: 25 });
    expect(state.seeds.filter((x) => !x.payoffDelivered).length).toBe(3);
    // Hidden arcs with their clues.
    const hidden = new Map(state.invisibleArcs.map((h) => [h.title, h]));
    expect(hidden.get('Гильдия перевозчиков')).toMatchObject({ status: 'approaching_player' });
    expect(hidden.get('Гильдия перевозчиков')!.playerClues.map((c) => c.turn)).toEqual([10, 17, 26]);
    expect(hidden.get('Староста ведёт двойную игру')!.playerClues).toHaveLength(1);
    expect(state.nextIntentions).toEqual([{ type: 'reveal', description: 'Постепенно раскрыть, где Тихон', priority: 'should', targetTurn: 'soon' }]);
    expect(bytesOf(state)).toBeLessThanOrEqual(STATE_LIMITS.hardBytes);
    await d.engine.close();
  });
});
