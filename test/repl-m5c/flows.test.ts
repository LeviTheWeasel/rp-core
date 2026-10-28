// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// M5c in the REPL (.notes/m5c-decisions.md D-206, ruling H): /memory recall prints an answer's record
// (sync, a reuse, a failure, a prefetch adopted), /trace gets its recall line, /memory mode shows and
// sets compendium.recall.mode (the next reply follows it), /memory profile names each agent's profile
// and window, /model shows recall following the recorder; with an auto lane on a local origin the
// prefetch's lane line names the answer and the picks, /memory status and /memory wait say it runs.
import { describe, expect, test } from 'bun:test';
import { entriesOf } from '../repl/kit.ts';
import { line, narr, pausedPicks, picks, recallRepl, said } from './kit.ts';

const recallLines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('  recall: '));

describe('sync recall: the record, the trace line, the reuse', () => {
  test('/memory recall and /trace after a sync recall; a swipe reuses the record (0 calls); --turn reaches the replaced version; a player message and the greeting have none', async () => {
    const r = await recallRepl([picks(['Арсений Кеттер', 'Серый маяк'], [{ usage: { inputTotal: 200, outputTotal: 8 } }]), narr('Мира кивает.'), narr('Мира молчит.')], {
      recall: { mode: 'sync' },
      compendium: { profile: 'full' },
    });
    r.type('Кто здесь был?');
    await r.until('Mira › Мира кивает.');
    const first = r.session.view().path[2]!.id;
    r.type('/trace', '/memory recall', '/r', '/trace', '/memory recall', `/memory recall --turn ${first}`, '/memory recall 2', '/memory recall #1');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(r.provider.requests.map((q) => q.agent)).toEqual(['recall', 'narrator', 'narrator']);
    expect(said(out, 'Кто здесь был?')).toContain('  ⋯ recall: recalled (2)');
    expect(said(out, '/trace')).toMatch(/\n {2}recall: sync · 2 picked: C3 "Арсений Кеттер", C2 "Серый маяк" · 1 call \d+\.\ds\n {2}compendium: full · picked 2: C3 "Арсений Кеттер" \(model\)/);
    expect(said(out, '/memory recall')).toMatch(
      /^recall for #3: sync · recalled 2 · full · script:default · tagged\n {2}picks, in recall's order:\n {4}1\. C3 "Арсений Кеттер"\n {4}2\. C2 "Серый маяк"\n {2}read: 2 by name\n {2}1 call · \d+\.\ds · 200 in \/ 8 out tokens\n$/,
    );
    // The swipe: the record of the answer it replaced, no recall call.
    expect(said(out, '/r')).toContain('  ⋯ recall: reused (2)');
    const replaced = `${first} (another version of #3)`;
    expect(recallLines(said(out, '/trace', 2))).toEqual([`  recall: reused from ${replaced} · 2 picked: C3 "Арсений Кеттер", C2 "Серый маяк" · 0 calls`]);
    expect(said(out, '/memory recall', 2)).toContain(`recall for #3: reused from ${replaced} · recalled 2 · full`);
    expect(said(out, '/memory recall', 2)).toContain(`  0 calls: the picks of ${replaced}`);
    expect(said(out, `/memory recall --turn ${first}`)).toContain(`recall for ${replaced}: sync · recalled 2`);
    expect(said(out, '/memory recall 2')).toBe("/memory recall: message #2 is the player's; recall runs before an answer (/memory recall takes the answer)\n");
    expect(said(out, '/memory recall #1')).toBe('#1 is a greeting: recall runs before a reply, so it has none\n');
    await r.engine.close();
  });

  test('a failed sync recall: the turn goes on lexical; the card says why, /trace says failed → lexical with its call', async () => {
    const r = await recallRepl([line('recall', [{ error: { code: 'bad_request', status: 400 } }]), narr('Мира кивает.')], { recall: { mode: 'sync' } });
    r.type('Кто здесь был?', '/trace', '/memory recall');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(said(out, 'Кто здесь был?')).toContain('  ⋯ recall: fallback [provider_error]');
    expect(recallLines(said(out, '/trace'))[0]).toMatch(/^ {2}recall: sync · failed \[provider_error\] → lexical · 1 call \d+\.\ds$/);
    expect(said(out, '/memory recall')).toMatch(/^recall for #3: sync · failed \[provider_error\] · lite · script:default · tagged\n {2}the server failed: the selector picked alone \(lexical\)\n {2}1 call · \d+\.\ds\n$/);
    await r.engine.close();
  });

  test('without a record: the mode was lexical (or off), or the Compendium had nothing to give', async () => {
    const r = await recallRepl([narr('Мира кивает.'), narr('Мира молчит.')], { recall: { mode: 'lexical' } });
    r.type('Кто здесь был?', '/memory recall', '/trace', '/memory mode off', 'Ну?', '/memory recall', '/trace');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(r.provider.requests.map((q) => q.agent)).toEqual(['narrator', 'narrator']);
    expect(said(out, '/memory recall')).toBe('recall for #3: none: recall did not run, the selector picked alone (lexical; /memory mode)\n');
    expect(recallLines(said(out, '/trace'))).toEqual(['  recall: lexical (no recall call; the selector picked alone)']);
    expect(said(out, '/memory recall', 2)).toBe('recall for #5: none: recall was off (no recall call; /memory mode)\n');
    expect(recallLines(said(out, '/trace', 2))).toEqual(['  recall: off (no recall call)']);
    await r.engine.close();
  });
});

describe('/memory mode, /memory profile, /model', () => {
  test('bare /memory mode: the default and what auto does on a remote server; setting lexical writes the config and the next reply makes no recall call; again: nothing changed', async () => {
    const r = await recallRepl([narr('Мира кивает.')]);
    r.type('/memory mode', '/memory mode lexical', '/memory mode lexical', 'Кто здесь был?', '/memory mode');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(said(out, '/memory mode')).toBe(
      "recall mode: auto (the default)\n  here: sync (the recall model's server is not local): recall (script:default) picks the entries the narrator needs beside the Director, before each reply\n",
    );
    expect(said(out, '/memory mode lexical')).toBe(
      'recall mode: lexical (set for this session, from the next reply)\n  no recall call: the selector picks the entries named in the conversation and those the recent messages bring up\n',
    );
    expect(said(out, '/memory mode lexical', 2)).toBe('recall mode is already lexical for this session; nothing changed\n');
    expect(said(out, '/memory mode', 2).split('\n')[0]).toBe("recall mode: lexical (this session's compendium.recall.mode)");
    expect(r.provider.requests.map((q) => q.agent)).toEqual(['narrator']);
    const rows = entriesOf(r.home, r.session.id).filter((e) => e.t === 'config');
    expect(rows.map((e) => (e as { patch: unknown }).patch)).toEqual([{ compendium: { recall: { mode: 'lexical' } } }]);
    await r.engine.close();
  });

  test('RP_CORE_RECALL is named when it gave the mode; the Compendium off is said', async () => {
    const r = await recallRepl([], { recallDefault: 'off' });
    r.type('/memory mode', '/memory off', '/memory mode');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(said(out, '/memory mode').split('\n')[0]).toBe('recall mode: off (RP_CORE_RECALL)');
    expect(said(out, '/memory mode', 2)).toContain('the Compendium is off for this session: recall runs only while it is on (/memory on)');
    await r.engine.close();
  });

  test("/memory profile: the block by the narrator's window, recall by its own model's, filing and the historian by the recorder's; a set profile decides for all", async () => {
    const r = await recallRepl([], {
      config: { roles: { narrator: { conn: 'script', model: 'default' }, recall: { conn: 'alt', model: 'small' } } },
      windows: { alt: 32768 },
      compendium: { filing: { enabled: true } },
    });
    r.type('/memory profile', '/model');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(said(out, '/memory profile')).toBe(
      [
        'Compendium profiles (compendium.profile auto: lite below a 24576-token window, full from it):',
        "  block     lite: the narrator's window 8192 < 24576 · script:default",
        "  recall    full: the recall model's window 32768 ≥ 24576 · alt:small · up to 10 picks, reading the last 20 messages",
        "  filing    lite: the recorder's window 8192 < 24576 · script:default (follows the narrator)",
        "  historian lite: the recorder's window 8192 < 24576 · script:default (follows the narrator) · not running: compendium.historian.interval is 0",
        '',
      ].join('\n'),
    );
    expect(said(out, '/model')).toContain('  recall   alt:small');
    await r.engine.close();

    const s = await recallRepl([], { compendium: { profile: 'full' }, recall: { mode: 'off' } });
    s.type('/memory profile', '/model');
    s.end();
    expect(await s.done).toBe(0);
    const prof = said(s.out(), '/memory profile');
    expect(prof.split('\n')[0]).toBe('Compendium profiles (compendium.profile full: every agent runs full, whatever its window):');
    expect(prof).toContain(
      "  recall    full: set (the recall model's window 8192) · script:default (follows the recorder, which follows the narrator) · up to 10 picks, reading the last 20 messages · not running: recall mode off (/memory mode)",
    );
    expect(said(s.out(), '/model')).toContain('  recall   recorder (follows)');
    await s.engine.close();
  });
});

describe('the prefetch in the REPL (auto lane, local origin)', () => {
  test('/memory status and /memory wait [sec] say it runs; its lane line names the answer and the picks; the turn adopts it; /trace and /memory recall say prefetch after #1', async () => {
    const r = await recallRepl([pausedPicks('p1', ['Арсений Кеттер']), narr('Мира кивает.'), pausedPicks('p2', ['Серый маяк'])], {
      recall: { mode: 'auto' },
      compendium: { idleDelaySec: 0 },
      lane: 'auto',
      local: true,
    });
    r.type('/memory mode', '/memory status', '/memory wait 0.2', '/memory wait');
    await r.until('you  › /memory wait', 2);
    r.provider.release('p1');
    r.type('/memory status', 'Кто здесь был?', '/trace', '/memory recall', '/memory status', '/memory wait');
    // Released once the last wait waits, so the prefetch's line is its own.
    await r.until('you  › /memory wait', 3);
    r.provider.release('p2');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(said(out, '/memory mode')).toContain("here: prefetch (the recall model's server is local)");
    expect(said(out, '/memory status')).toBe("the Compendium's background lane: 1 running\n  recall: the prefetch after #1 runs\n");
    expect(said(out, '/memory wait 0.2')).toBe('still working after 0.2 s: the recall prefetch after #1 runs (/memory status)\n');
    expect(said(out, '/memory wait')).toBe('⋯ recall: prefetched after #1 → 1: C3 "Арсений Кеттер"\nthe background lane is idle\n');
    expect(said(out, '/memory status', 2)).toBe(
      "the Compendium's background lane is idle: nothing queued, nothing parked\n  recall: prefetched after #1, ready for the next reply: 1 picked: C3 \"Арсений Кеттер\"\n",
    );
    expect(said(out, 'Кто здесь был?')).toContain('  ⋯ recall: adopted (1)');
    expect(recallLines(said(out, '/trace'))[0]).toMatch(/^ {2}recall: prefetch after #1 · 1 picked: C3 "Арсений Кеттер" · 0 calls in this turn \(the prefetch: 1 call \d+\.\ds\)$/);
    expect(said(out, '/trace')).toMatch(/\n {2}calls: narrator script:default \d+\.\ds\n/);
    expect(said(out, '/memory recall')).toMatch(/^recall for #3: prefetch after #1 · recalled 1 · lite · script:default · tagged\n[\s\S]*\n {2}1 call in the background, without the player's message · \d+\.\ds\n$/);
    expect(said(out, '/memory status', 3)).toBe("the Compendium's background lane: 1 running\n  recall: the prefetch after #3 runs\n");
    expect(said(out, '/memory wait', 2)).toBe('⋯ recall: prefetched after #3 → 1: C2 "Серый маяк"\nthe background lane is idle\n');
    expect(r.provider.requests.map((q) => [q.agent, q.callKey])).toEqual([
      ['recall', expect.stringMatching(/^p_[0-9a-f]{8}:recall:0$/)],
      ['narrator', expect.stringMatching(/:narrator:0$/)],
      ['recall', expect.stringMatching(/^p_[0-9a-f]{8}:recall:0$/)],
    ]);
    await r.engine.close();
  });

  test('a manual lane never prefetches: /memory status says nothing of recall, /memory wait has nothing to do', async () => {
    const r = await recallRepl([], { recall: { mode: 'auto' }, lane: 'manual', local: true });
    r.type('/memory status', '/memory wait');
    r.end();
    expect(await r.done).toBe(0);
    expect(said(r.out(), '/memory status')).toBe("the Compendium's background lane is idle: nothing queued, nothing parked\n");
    expect(said(r.out(), '/memory wait')).toBe('the background lane is idle: nothing to do\n');
    expect(r.provider.requests).toEqual([]);
    await r.engine.close();
  });

  test('Ctrl+C stops /memory wait while the prefetch runs; it goes on and its line comes at the next pause', async () => {
    const r = await recallRepl([pausedPicks('p1', ['Арсений Кеттер'])], { recall: { mode: 'auto' }, compendium: { idleDelaySec: 0 }, lane: 'auto', local: true });
    r.type('/memory wait');
    await r.until('you  › /memory wait');
    await new Promise((res) => setTimeout(res, 20));
    r.interrupt();
    await r.until('(stopped waiting;');
    r.provider.release('p1');
    await r.until('⋯ recall: prefetched after #1 → 1: C3 "Арсений Кеттер"');
    r.end();
    expect(await r.done).toBe(0);
    await r.engine.close();
  });
});

/** Until `ok()` holds (polled every 2 ms, at most 5 s). */
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !ok(); waited += 2) {
    if (waited > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((res) => setTimeout(res, 2));
  }
}

describe('after the review (ruling K)', () => {
  test('a manual lane: /memory mode and /memory profile never claim a prefetch; the reply makes no recall call (cli#3)', async () => {
    const r = await recallRepl([narr('Мира кивает.')], { lane: 'manual', local: true });
    r.type('/memory mode', '/memory profile', 'Кто здесь был?', '/trace');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(said(out, '/memory mode')).toBe(
      'recall mode: auto (the default)\n  here: no prefetch: the lane is manual (RP_CORE_LANE), so compendium.recall.on_miss decides each reply: the selector picks alone (lexical)\n',
    );
    expect(said(out, '/memory profile')).toContain('not running: recall mode auto, but the lane is manual (RP_CORE_LANE): no prefetch, and on_miss gives lexical (/memory mode)');
    expect(said(out, '/memory mode')).not.toContain('in the background');
    expect(recallLines(said(out, '/trace'))).toEqual(['  recall: lexical (no recall call; the selector picked alone)']);
    expect(r.provider.requests.map((q) => q.agent)).toEqual(['narrator']);
    await r.engine.close();
  });

  test('a swipe while the prefetch after #3 runs: its line says it was dropped, not that it runs again (cli#6)', async () => {
    const r = await recallRepl([picks(['Арсений Кеттер']), narr('Мира кивает.'), pausedPicks('p2', ['Серый маяк']), narr('Мира молчит.'), picks(['Серый маяк'])], {
      recall: { mode: 'auto' },
      compendium: { idleDelaySec: 0 },
      lane: 'auto',
      local: true,
    });
    r.type('/memory wait', 'Кто здесь был?');
    await r.until('Mira › Мира кивает.');
    // The prefetch after #3 has asked (it waits for p2) when the swipe comes.
    await until(() => r.provider.requests.length === 3, 'the prefetch after #3');
    r.type('/r');
    await r.until('Mira › Мира молчит.');
    r.type('/memory wait');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    const swiped = r.provider.requests[2]!.callKey;
    expect(out).toMatch(/⋯ recall: the prefetch after [0-9a-f]{8} \(another version of #3\) gave way to a turn and was dropped: that answer was replaced \(a swipe, a regen or a rewind\)\n/);
    expect(out).not.toContain('runs again at the next pause');
    expect(out).toContain('⋯ recall: prefetched after #3 → 1: C2 "Серый маяк"');
    // The swiped-away answer's prefetch never ran again: the last one follows the new #3.
    expect(r.provider.requests.map((q) => q.agent)).toEqual(['recall', 'narrator', 'recall', 'narrator', 'recall']);
    expect(r.provider.requests[4]!.callKey).not.toBe(swiped);
    await r.engine.close();
  });

  test('a prefetch the reply waited for: no lane line after the answer, and the card says it did not read the message (cli#9)', async () => {
    const r = await recallRepl([pausedPicks('p1', ['Арсений Кеттер']), narr('Мира кивает.'), pausedPicks('p2', ['Серый маяк'])], {
      recall: { mode: 'auto', graceSec: 5 },
      compendium: { idleDelaySec: 0 },
      lane: 'auto',
      local: true,
    });
    await until(() => r.provider.requests.length === 1, 'the prefetch after #1');
    r.type('Кто здесь был?');
    // The turn waits for it (grace); it ends only now, after the player's message.
    await new Promise((res) => setTimeout(res, 50));
    r.provider.release('p1');
    await r.until('Mira › Мира кивает.');
    r.type('/memory recall');
    await r.until('you  › /memory recall');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(said(out, 'Кто здесь был?')).toContain('  ⋯ recall: adopted (1)');
    expect(out).not.toContain('⋯ recall: prefetched after #1');
    expect(said(out, '/memory recall')).toMatch(/\n {2}1 call in the background, without the player's message · \d+\.\ds\n$/);
    r.provider.release('p2');
    await r.engine.close();
  });

  test("/trace of a continue that recalled nothing shows that request's recall, not the answer's (breaker#5)", async () => {
    const r = await recallRepl([picks(['Арсений Кеттер']), narr('Мира кивает.'), narr(' И уходит.')], { recall: { mode: 'sync' }, compendium: { profile: 'full' } });
    r.type('Кто здесь был?', '/trace', '/memory mode lexical', '/c', '/trace', '/memory recall');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(recallLines(said(out, '/trace'))[0]).toMatch(/^ {2}recall: sync · 1 picked: C3 "Арсений Кеттер" · 1 call \d+\.\ds$/);
    const second = said(out, '/trace', 2);
    expect(second).toContain('(its last continue)');
    expect(recallLines(second)).toEqual(['  recall: lexical (no recall call; the selector picked alone)']);
    expect(second).toContain('  compendium: full · nothing picked');
    // /memory recall is the answer's: its newest record, the sync one.
    expect(said(out, '/memory recall').split('\n')[0]).toBe('recall for #3: sync · recalled 1 · full · script:default · tagged');
    await r.engine.close();
  });
});
