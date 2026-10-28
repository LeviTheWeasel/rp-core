// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// D-184 and the fold cost through the engine (.notes/m5b-decisions.md section I): a typo fix in an old
// message makes its pass stale and the lane writes it again, which must not roll back what later
// answers filed (review lane#2: filing with wait 0 and 1, the historian's arc); and the session's view
// after a send, a turn and the lane's rows resumes from the last fold's checkpoint (review breaker#2).
import { describe, expect, test } from 'bun:test';
import type { SessionHandle } from '../../src/engine/api.ts';
import { answer, calls, char, chronicle, filed, laneRig, laneSession, memRows, pathIds, say, turnOf } from '../lane-m5b/kit.ts';

const frolOf = (s: SessionHandle): Record<string, unknown> | undefined => [...s.compendium().entries.values()].find((e) => e.name === 'Фрол')?.data;

describe('a pass written again for an old answer (review lane#2)', () => {
  test('wait 0: a typo fixed in u1 re-files a1; Фрол stays dead as a2 filed him', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол жив.'), answer('Фрол погиб.')),
      recorder: calls(
        filed(char('Фрол', { current_state: { status: 'alive' } })),
        filed(char('Фрол', { current_state: { status: 'dead' } })),
        // The re-write of a1: the model says what it said the first time.
        filed(char('Фрол', { current_state: { status: 'alive' } })),
      ),
    });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await s.memoryWait();
    await say(s, 'Что с Фролом?');
    await s.memoryWait();
    expect(frolOf(s)).toEqual({ name: 'Фрол', current_state: { status: 'dead' } });
    const [, u1, a1] = pathIds(s);
    s.edit({ messageId: u1, text: 'Кто ты? (опечатка исправлена)', expectedVersion: s.version() });
    expect(s.memoryStatus().queued.map((q) => q.key)).toEqual([`file:${a1}`]);
    await s.memoryWait();
    expect(r.recorder.requests).toHaveLength(3);
    expect(memRows(r.home, s.id).map((m) => m.key)).toEqual([`file:${a1}`, `file:${pathIds(s)[4]}`, `file:${a1}`]);
    expect(frolOf(s)).toEqual({ name: 'Фрол', current_state: { status: 'dead' } });
    await r.engine.close();
  });

  test('the default wait: a typo fixed in the answer a1 itself; Фрол stays dead', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол жив, кивнул.'), answer('Фрол погиб.'), answer('Тишина.')),
      recorder: calls(
        filed(char('Фрол', { current_state: { status: 'alive' } })),
        filed(char('Фрол', { current_state: { status: 'dead' } })),
        filed(char('Фрол', { current_state: { status: 'alive' } })),
      ),
    });
    const s = laneSession(r.engine, { historian: { interval: 0 } });
    await say(s, 'Кто ты?');
    await say(s, 'Что с Фролом?');
    await say(s, 'И?');
    await s.memoryWait();
    expect(frolOf(s)).toEqual({ name: 'Фрол', current_state: { status: 'dead' } });
    const a1 = pathIds(s)[2];
    s.edit({ messageId: a1, text: 'Фрол жив, кивнул. (опечатка)', expectedVersion: s.version() });
    await s.memoryWait();
    expect(r.recorder.requests).toHaveLength(3);
    expect(frolOf(s)).toEqual({ name: 'Фрол', current_state: { status: 'dead' } });
    await r.engine.close();
  });

  test('the historian: an old window written again after an edit keeps the newer window\'s arc overview', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол зажёг фонарь.'), answer('Свет ушёл в море.'), answer('Фонарь погас.'), answer('Темно.'), answer('Тишина.')),
      recorder: calls(
        chronicle([{ title: 'Фонарь зажжён', plot: 'Свет маяка', summary: 'Фрол зажёг фонарь.' }], [{ plot: 'Свет маяка', overview: 'V1: маяк светит.' }]),
        chronicle([{ title: 'Фонарь погас', plot: 'Свет маяка', summary: 'Фонарь погас.' }], [{ plot: 'Свет маяка', overview: 'V2: маяк погас навсегда.' }]),
        chronicle([{ title: 'Фонарь зажжён', plot: 'Свет маяка', summary: 'Фрол зажёг фонарь.' }], [{ plot: 'Свет маяка', overview: 'V1: маяк светит.' }]),
      ),
    });
    const s = laneSession(r.engine, { filing: { enabled: false }, historian: { interval: 2 } });
    const arc = (): string | undefined => s.compendium().entries.get('arc:свет маяка')?.content;
    await say(s, 'Зажги фонарь.');
    await say(s, 'Что дальше?');
    await say(s, 'Смотрю.');
    await s.memoryWait();
    await say(s, 'И?');
    await say(s, 'Ещё.');
    await s.memoryWait();
    expect(arc()).toBe('V2: маяк погас навсегда.');
    s.edit({ messageId: pathIds(s)[3], text: 'Что дальше? (опечатка)', expectedVersion: s.version() });
    await s.memoryWait();
    expect(r.recorder.requests).toHaveLength(3);
    expect(memRows(r.home, s.id).map((m) => m.by)).toEqual(['historian', 'historian', 'historian']);
    expect(arc()).toBe('V2: маяк погас навсегда.');
    await r.engine.close();
  });
});

describe('the session\'s view resumes from the last fold (review breaker#2)', () => {
  test('after a send, a turn and the lane\'s job and mem rows, entries no row changed keep the same data (no fold from the seed)', async () => {
    const r = await laneRig({
      narrator: calls(answer('Фрол у маяка.'), answer('Фрол чинит лодку.'), answer('Фрол спит.'), answer('Пришла Мира.')),
      recorder: calls(
        filed(char('Фрол', { minor_facts: ['Фрол сторожит старый маяк на мысе'] })),
        filed(char('Фрол', { minor_facts: ['Фрол чинит лодку у берега моря'] })),
        filed(char('Фрол', { minor_facts: ['Фрол спит днём после ночной вахты'] })),
        filed(char('Мира', { description: 'Фонарщица.' })),
      ),
    });
    const s = laneSession(r.engine, { filing: { wait: 0 }, historian: { interval: 0 } });
    for (const text of ['Где Фрол?', 'А сейчас?', 'А теперь?']) await say(s, text);
    await s.memoryWait();
    const frol = s.compendium().entries.get('character:фрол')!;
    expect(frol.data.minor_facts).toHaveLength(3);
    s.send({ text: 'Кто пришёл?', expectedVersion: s.version() });
    expect(s.compendium().entries.get('character:фрол')!.data).toBe(frol.data);
    await turnOf(s, 'reply');
    expect(s.compendium().entries.get('character:фрол')!.data).toBe(frol.data);
    // The lane files the new answer: a job row (the tree changes, the view does not), then a mem row.
    await s.memoryWait();
    const after = s.compendium();
    expect(after.entries.get('character:мира')!.data).toMatchObject({ name: 'Мира', description: 'Фонарщица.' });
    expect(after.entries.get('character:фрол')!.data).toBe(frol.data);
    expect(memRows(r.home, s.id)).toHaveLength(4);
    await r.engine.close();
  });
});
