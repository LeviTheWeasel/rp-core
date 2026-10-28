// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5b REPL (.notes/m5b-decisions.md D-180, D-181): /memory undo|refile|retry|wait|status over a real
// engine whose lane is 'manual' (test/preload.ts), so `/memory wait` runs the filing and historian passes
// on the scripted answers that follow the narrator's; the lane's lines between turns; /memory show's
// agent provenance.
import { afterEach, describe, expect, test } from 'bun:test';
import { answer, blocks, calls, char, chronicle, filed, handleOf, jobRows, memRows, pathIds, refused, replRig, said, type ReplRig } from './kit.ts';

let rig: ReplRig | null = null;
afterEach(async () => {
  await rig?.engine.close();
  rig = null;
});

/**
 * Run the lines as a script (each after the previous one ended), then end the input. The REPL closes
 * its session at the end: the rig's handle is the session opened again (nothing runs: the lane is manual).
 */
async function script(r: ReplRig, ...lines: string[]): Promise<string> {
  r.type(...lines);
  r.end();
  expect(await r.done).toBe(0);
  r.session = r.engine.session(r.session.id);
  return r.out();
}

describe('/memory wait and status', () => {
  test('a filing pass runs at /memory wait: its line, then where the lane stands; status before and after', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.'), filed(char('Фрол', { description: 'Смотритель маяка.' }))));
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory status', '/memory wait', '/memory status', '/memory wait');
    const [, , a1] = pathIds(rig);
    // A1 (#3) is accepted once U2 follows it (filing.wait 1): queued, nothing runs by itself in manual mode.
    expect(said(out, '/memory status')).toBe("the Compendium's background lane: 1 queued · 1 answer not filed yet\n  queued: filing #3\n");
    expect(said(out, '/memory wait')).toBe('⋯ memory: filing #3 → +1: C1 "Фрол"\nthe background lane is idle\n');
    expect(said(out, '/memory status', 2)).toBe("the Compendium's background lane is idle: nothing queued, nothing parked\n");
    expect(said(out, '/memory wait', 2)).toBe('the background lane is idle: nothing to do\n');
    expect(memRows(rig).map((m) => [m.key, m.by, m.on])).toEqual([[`file:${a1}`, 'filing', a1!]]);
    expect(rig.provider.requests.map((q) => q.agent)).toEqual(['narrator', 'narrator', 'filing']);
  });

  test('/memory wait with the Compendium off says so and runs nothing; status says it is off', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.')), { config: { compendium: { enabled: false } } });
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory wait', '/memory status');
    expect(said(out, '/memory wait')).toBe('the Compendium is off for this session: nothing runs in the background (/memory on)\n');
    expect(said(out, '/memory status')).toBe(
      "the Compendium is off for this session: entries are kept but not sent (/memory on)\nthe Compendium's background lane is idle: nothing queued, nothing parked\n",
    );
    expect(jobRows(rig)).toEqual([]);
    expect(rig.provider.requests).toHaveLength(2);
  });

  test('the historian runs after the filing pass: its line names the entries it made; /memory show gives the provenance', async () => {
    rig = await replRig(
      calls(
        answer('Фрол кивнул.'),
        answer('Дальше.'),
        filed(char('Фрол', { description: 'Смотритель маяка.' })),
        chronicle([{ title: 'Встреча с Фролом', plot: 'Пропавший фонарь', summary: 'Леви встретил Фрола у маяка.' }], [{ plot: 'Пропавший фонарь', overview: 'Фонарь пропал.' }]),
      ),
      { config: { compendium: { enabled: true, historian: { interval: 1 } } } },
    );
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory wait', '/memory show Встреча с Фролом', '/memory show Фрол');
    const [greeting, , a1] = pathIds(rig);
    const hist = `hist:${greeting}-${a1}`;
    expect(said(out, '/memory wait')).toBe(
      [
        '⋯ memory: filing #3 → +1: C1 "Фрол"',
        '⋯ memory: historian #1–#3 → +3: C2 "Пропавший фонарь", C3 "Встреча с Фролом", C4 [Arc] "Пропавший фонарь"',
        'the background lane is idle',
        '',
      ].join('\n'),
    );
    const histRow = memRows(rig).find((m) => m.key === hist)!;
    expect(histRow.by).toBe('historian');
    const summary = said(out, '/memory show Встреча с Фролом').split('\n');
    expect(summary.slice(0, 3)).toEqual([
      `C3 Встреча с Фролом · summary · summary:${a1}.0`,
      `  origin: this session, filed by the historian from #3 (${hist}) at journal row ${histRow.seq}`,
      '  covers messages #1 … #3',
    ]);
    const fileRow = memRows(rig).find((m) => m.key === `file:${a1}`)!;
    expect(said(out, '/memory show Фрол').split('\n')[1]).toBe(`  origin: this session, filed by the filing agent from #3 (file:${a1}) at journal row ${fileRow.seq}`);
  });

  test('/memory show: the last row that changed an entry is named by its agent too', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.'), filed(char('Фрол')), answer('Третий.'), filed(char('Фрол', { age: '40' }))));
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory wait', 'Ещё.', '/memory wait', '/memory show Фрол');
    const [, , a1, , a2] = pathIds(rig);
    const [first, second] = memRows(rig);
    expect(said(out, '/memory wait', 2)).toBe('⋯ memory: filing #5 → +1: C1 "Фрол"\nthe background lane is idle\n');
    expect(said(out, '/memory show Фрол').split('\n')[1]).toBe(
      `  origin: this session, filed by the filing agent from #3 (file:${a1}) at journal row ${first!.seq}; last changed at row ${second!.seq} by the filing agent from #5 (file:${a2})`,
    );
  });

  test('a pass with nothing to file says so (an empty answer, or items the entries already hold)', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.'), filed(char('Фрол')), answer('Третий.'), filed(), answer('Четвёртый.'), filed(char('Фрол'))));
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory wait', 'Ещё.', '/memory wait', 'И ещё.', '/memory wait');
    expect(said(out, '/memory wait', 2)).toBe('⋯ memory: filing #5 → nothing to file\nthe background lane is idle\n');
    expect(said(out, '/memory wait', 3)).toBe('⋯ memory: filing #7 → nothing to file\nthe background lane is idle\n');
    expect(memRows(rig).map((m) => m.ops.length)).toEqual([1, 0, 0]);
  });
});

describe('stopping /memory wait', () => {
  test('Ctrl+C stops waiting; the pass goes on and its line comes at the prompt when it ends', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.'), [{ pause: 'f' }, { text: JSON.stringify({ filings: [char('Фрол')] }) }]), { interactive: true });
    rig.type('Кто ты?');
    await rig.until('[swipe 1/1');
    rig.type('Ясно.');
    await rig.until('[swipe 1/1', 2);
    rig.type('/memory wait');
    await new Promise((r) => setTimeout(r, 20));
    rig.interrupt();
    await rig.until('(stopped waiting; the background work goes on: /memory status shows it)');
    rig.type('/memory status');
    await rig.until('  running: filing #3 · job j_');
    rig.provider.release('f');
    await rig.until('⋯ memory: filing #3 → +1: C1 "Фрол"');
    expect(rig.out()).toEndWith('⋯ memory: filing #3 → +1: C1 "Фрол"\n');
    await rig.close();
  });

  test('stopped, then /quit: the session closes with the pass cut off; its begin row stays for the next open', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.'), [{ pause: 'never' }]), { interactive: true });
    rig.type('Кто ты?');
    await rig.until('[swipe 1/1');
    rig.type('Ясно.');
    await rig.until('[swipe 1/1', 2);
    rig.type('/memory wait');
    await new Promise((r) => setTimeout(r, 20));
    rig.interrupt();
    await rig.until('(stopped waiting;');
    rig.type('/quit');
    expect(await rig.done).toBe(0);
    expect(jobRows(rig).map((j) => j.state)).toEqual(['begin']);
  });
});

describe('/memory undo and refile', () => {
  test('undo takes the pass back (its entries on the next line); again changes nothing; refile queues it and wait files it again', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.'), filed(char('Фрол')), filed(char('Фрол', { age: '40' }))));
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory wait', '/memory undo 3', '/memory undo #3', '/memory list', '/memory wait', '/memory refile 3', '/memory refile 3', '/memory wait');
    const [, , a1] = pathIds(rig);
    expect(said(out, '/memory undo 3')).toBe(
      'undone: filing #3; what it wrote leaves the Compendium from the next turn (/memory refile #3 file runs it again)\n⋯ memory: undo → −1: character "Фрол"\n',
    );
    expect(said(out, '/memory undo #3')).toBe('/memory undo: the pass bound to message #3 is already undone or being filed again; nothing changed\n');
    expect(said(out, '/memory list')).toStartWith('nothing in the Compendium on this path yet');
    // A reverted key counts as covered: nothing to run.
    expect(said(out, '/memory wait', 2)).toBe('the background lane is idle: nothing to do\n');
    expect(said(out, '/memory refile 3')).toBe('filing #3 queued again (/memory wait waits for it)\n');
    expect(said(out, '/memory refile 3', 2)).toBe('/memory refile: filing #3 is already queued or running; nothing changed\n');
    expect(said(out, '/memory wait', 3)).toBe('⋯ memory: filing #3 → +1: C1 "Фрол"\nthe background lane is idle\n');
    expect(memRows(rig).map((m) => [m.key, m.by])).toEqual([
      [`file:${a1}`, 'filing'],
      [null, 'user'],
      [`file:${a1}`, 'filing'],
    ]);
    expect(rig.session.memoryGet({ ref: 'Фрол' }).entry.data).toEqual({ name: 'Фрол', age: '40' });
  });

  test('a message is named by its number, #number or id prefix; file|hist picks the pass; refusals are one red line', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.'), filed(char('Фрол'))));
    rig.type('Кто ты?', 'Ясно.', '/memory wait');
    await rig.until('the background lane is idle');
    const a1 = pathIds(rig)[2]!;
    const out = await script(rig, '/memory undo 4', '/memory undo 99', '/memory undo ffff', '/memory undo 3 hist', `/memory undo ${a1.slice(0, 6)} file`, '/memory undo 3 both', '/memory undo');
    expect(said(out, '/memory undo 4')).toBe('/memory undo: no filing or historian pass is bound to message #4\n');
    expect(said(out, '/memory undo 99')).toBe('there is no message 99: this path has 5 messages (/show numbers them)\n');
    expect(said(out, '/memory undo ffff')).toBe('/memory undo: no message starts with "ffff"\n');
    expect(said(out, '/memory undo 3 hist')).toBe('/memory undo: no historian pass is bound to message #3\n');
    expect(said(out, `/memory undo ${a1.slice(0, 6)} file`)).toStartWith('undone: filing #3;');
    expect(said(out, '/memory undo 3 both')).toBe('/memory undo: "both" is neither file nor hist (the filing pass or the historian\'s)\n');
    expect(said(out, '/memory undo')).toBe(
      '/memory undo needs a message: its number as /show prints it (5 or #5) or its id, then file or hist if you like (/memory undo <ref|#n> [file|hist])\n',
    );
  });

  test('during a turn, undo/refile/retry are refused at once; wait and status run after the answer', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), [{ text: 'Part ' }, { pause: 'p' }, { text: 'end.' }]), { interactive: true });
    rig.type('Кто ты?');
    await rig.until('[swipe 1/1');
    rig.type('Ясно.');
    await rig.until('Mira › Part');
    rig.type('/memory undo 3', '/memory refile 3', '/memory retry', '/memory status');
    await rig.until('(runs when this answer ends)');
    expect(rig.out()).toContain('refused [session_busy]: /memory changes the story while an answer is being written; wait for it or press Ctrl+C');
    expect(rig.out().split('refused [session_busy]').length - 1).toBe(3);
    rig.provider.release('p');
    await rig.until("the Compendium's background lane: 1 queued");
    await rig.close();
  });
});

describe('/memory retry and parked passes', () => {
  test('every failed attempt gets a line, the last parks it; refile is refused for it; retry [#n] queues it again', async () => {
    rig = await replRig(calls(answer('Фрол кивнул.'), answer('Дальше.'), refused(), refused(), refused(), filed(char('Фрол'))));
    const out = await script(rig, 'Кто ты?', 'Ясно.', '/memory wait', '/memory status', '/memory refile 3', '/memory retry 1', '/memory retry 2', '/memory retry', '/memory wait');
    const a1 = pathIds(rig)[2]!;
    expect(said(out, '/memory wait')).toBe(
      [
        '⋯ memory: filing #3 failed [provider_error] (attempt 1 of 3)',
        '⋯ memory: filing #3 failed [provider_error] (attempt 2 of 3)',
        '⋯ memory: filing #3 failed [provider_error] (attempt 3 of 3)',
        '⋯ memory: filing #3 parked after 3 failed attempts: /memory retry #3 runs it again',
        'the background lane is idle · 1 parked (/memory retry runs it again) · 1 answer not filed yet',
        '',
      ].join('\n'),
    );
    expect(said(out, '/memory status')).toBe(
      "the Compendium's background lane: 1 parked · 1 answer not filed yet\n  parked: filing #3 after 3 failed attempts (/memory retry #3 runs it again)\n",
    );
    // The lead's ruling K: the pass by its name, never its key; the way back names the message.
    expect(said(out, '/memory refile 3')).toBe('/memory refile: filing #3 is parked after 3 failed attempts: /memory retry #3 runs it again\n');
    expect(out).not.toContain(`file:${a1}`);
    // The greeting is outside the pass's range [U1, A1]; U1 (#2) is inside it.
    expect(said(out, '/memory retry 1')).toBe('/memory retry: nothing is parked for message #1; nothing changed\n');
    expect(said(out, '/memory retry 2')).toBe('queued again: filing #3 (/memory wait waits for it)\n');
    expect(said(out, '/memory retry')).toBe('/memory retry: nothing is parked on this path; nothing changed\n');
    expect(said(out, '/memory wait', 2)).toBe('⋯ memory: filing #3 → +1: C1 "Фрол"\nthe background lane is idle\n');
    expect(jobRows(rig).map((j) => [j.state, j.attempt])).toEqual([
      ['begin', 1],
      ['failed', 1],
      ['begin', 2],
      ['failed', 2],
      ['begin', 3],
      ['failed', 3],
      ['retry', 1],
      ['begin', 1],
    ]);
  });
});

describe('the lane between turns', () => {
  /** A lane event as the session publishes it (session.ts publish, the lane's own path to the bus). */
  const publish = (r: ReplRig, body: Record<string, unknown>): void => (r.session as unknown as { publish(b: unknown): void }).publish(body);

  test('what the lane says while an answer streams waits for it: after its status line, before the next line', async () => {
    rig = await replRig(calls([{ text: 'Part ' }, { pause: 'p' }, { text: 'end.' }], answer('Next.')));
    rig.type('Go');
    await rig.until('Mira › Part');
    publish(rig, { type: 'notice', level: 'warn', code: 'memory_starved', message: 'Turns took the filing task away 3 times in a row.' });
    publish(rig, { type: 'agent', agent: 'filing', status: 'preempted', job: 'j_00000000' });
    await new Promise((r) => setTimeout(r, 20));
    expect(rig.out()).not.toContain('memory_starved');
    rig.provider.release('p');
    const out = await script(rig, 'Again');
    // The answer whole (nothing glued into it), its status line, then the lane's two lines.
    expect(said(out, 'Go').split('\n')).toEqual([
      'Mira › Part end.',
      expect.stringMatching(/^ {2}\[swipe 1\/1 · [\d.]+s · end\]/),
      '! Turns took the filing task away 3 times in a row. (memory_starved)',
      '⋯ memory: filing gave way to a turn; it runs again at the next pause',
      '',
    ]);
  });

  test('at the prompt they show at once; a notice shows once per code and message', async () => {
    rig = await replRig(calls(answer('Hi.')), { interactive: true });
    rig.type('Go');
    await rig.until('[swipe 1/1');
    const notice = { type: 'notice', level: 'info', code: 'slots_shared', message: 'The connections a, b are one server.' };
    publish(rig, notice);
    publish(rig, notice);
    publish(rig, { ...notice, message: 'The connections c, d are one server.' });
    await rig.until('c, d are one server');
    const out = rig.out();
    expect(out.split('a, b are one server').length - 1).toBe(1);
    expect(out).toEndWith('! The connections a, b are one server. (slots_shared)\n! The connections c, d are one server. (slots_shared)\n');
    await rig.close();
  });

  test('a backlog notice comes between turns, once', async () => {
    rig = await replRig(calls(...['1.', '2.', '3.', '4.', '5.', '6.', '7.'].map(answer)));
    const out = await script(rig, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
    const notice = '! 5 answers are waiting to be filed into the Compendium';
    expect(out.split(notice).length - 1).toBe(1);
    // A1…A5 accepted when U6 is sent: the turn of `f` crossed everyN + 3 = 4.
    expect(said(out, 'f')).toMatch(/^Mira › 6\.\n {2}\[swipe 1\/1[^\n]*\n! 5 answers are waiting to be filed into the Compendium: [^\n]*\(memory_backlog\)\n$/);
    expect(blocks(out).map((b) => b.line)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  test('another session\'s lane events are not shown (the bus carries every open session\'s)', async () => {
    rig = await replRig(calls(answer('Hi.')), { interactive: true });
    const other = rig.engine.createSession({ character: { name: 'Ян', description: '', greetings: ['Привет.'] } });
    (other as unknown as { publish(b: unknown): void }).publish({ type: 'notice', level: 'warn', code: 'memory_backlog', message: 'Not this session.' });
    rig.type('Go');
    await rig.until('[swipe 1/1');
    publish(rig, { type: 'notice', level: 'warn', code: 'memory_backlog', message: 'This session.' });
    await rig.until('This session.');
    expect(rig.out()).not.toContain('Not this session.');
    await other.close();
    await rig.close();
  });
});

describe('/trace', () => {
  test('the {{recap}} slot: its arcs with the revision sent, its summaries, the boundary', async () => {
    const { lanternRig } = await import('../repl-m5a/kit.ts');
    const r = await lanternRig(calls(answer('Фрол кивнул.')));
    rig = r;
    const out = await script(r, 'Кто ты?', '/trace');
    const greeting = pathIds(r)[0]!;
    const arc = handleOf(r, 'Украденный свет', 'arc');
    expect(said(out, '/trace')).toContain(`\n  recap: 1 arc: ${arc} "Украденный свет" rev 0 · boundary ${greeting}\n`);
  });
});
