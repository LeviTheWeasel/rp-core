import { afterEach, describe, expect, test } from 'bun:test';
import { TextAttributes, TextRenderable, type CapturedSpan } from '@opentui/core';
import type { Event, Notice } from '../../src/protocol/events.ts';
import { makeStyle, prefix } from '../../src/cli/repl-render.ts';
import type { TurnView } from '../../src/cli/repl-view.ts';
import { displayLabels } from '../../src/cli/tui/sanitize.ts';
import type { Names } from '../../src/cli/tui/types.ts';
import { answerStatus } from '../../src/cli/tui/view.ts';
import { chatRig, ev, msg, NAMES, row, rows, textEvents, type ChatRig } from './chat-kit.ts';

const style = makeStyle(true);
let rig: ChatRig | null = null;
afterEach(async () => {
  await rig?.setup.dispose();
  rig = null;
});

interface Turn {
  tv: TurnView;
  seen: Event[];
  notices: Notice[];
  push(...evs: Event[]): void;
}

function turn(r: ChatRig, o: { continueFrom?: string; show?: boolean; names?: Names } = {}): Turn {
  const seen: Event[] = [];
  const notices: Notice[] = [];
  const names = o.names ?? NAMES;
  const tv = r.t.turn({
    label: names.char,
    names,
    showReasoning: () => o.show ?? false,
    notice: (n) => notices.push(n),
    ...(o.continueFrom !== undefined ? { continueFrom: o.continueFrom } : {}),
    onEvent: (e) => seen.push(e),
  });
  return { tv, seen, notices, push: (...evs) => evs.forEach((e) => tv.push(e)) };
}

const start = (messageId = 'a1', kind: 'reply' | 'swipe' | 'continue' = 'reply') =>
  ev({ type: 'start', turnId: 't1', kind, messageId, parentId: 'u1' });

async function open(o: Parameters<typeof chatRig>[0] = {}): Promise<ChatRig> {
  rig = await chatRig({ width: 60, height: 20, ...o });
  return rig;
}

describe('streaming a turn', () => {
  test('start, reasoning, text deltas with offsets, a tool, done', async () => {
    const r = await open();
    r.t.echo(`${prefix(NAMES.user, style)}hello`);
    const t = turn(r);
    t.push(start());
    expect(rows(await r.frame())).toEqual(['you  › hello', 'Mira › …']);
    t.push(...textEvents('t1', ['let me ', 'think'], 'reasoning'));
    expect(rows(await r.frame())).toEqual(['you  › hello', '  ⋯ thinking (12 chars)']);
    t.push(...textEvents('t1', ['*She ', 'smiles.* "Hi', '!"']));
    // The action italic without its asterisks (polish2).
    expect(rows(await r.frame())).toEqual(['you  › hello', '  ⋯ thinking (12 chars)', 'Mira › She smiles. "Hi!"']);
    const italic = r.setup.captureSpans().lines.flatMap((l) => l.spans).find((s) => s.text.includes('She smiles.'));
    expect((italic!.attributes & TextAttributes.ITALIC) !== 0).toBe(true);
    t.push(ev({ type: 'tool', turnId: 't1', callId: 'c1', name: 'search_history', phase: 'start', args: { query: 'брат' } }));
    t.push(ev({ type: 'tool', turnId: 't1', callId: 'c1', name: 'search_history', phase: 'done', ok: true, summary: '2 hits' }));
    // D-55: the next round's leading "\n" is not shown; the text resumes indented under the prefix
    t.push(...textEvents('t1', ['\nShe waits.'], 'text', 19));
    const done = msg('a1', 'assistant', '*She smiles.* "Hi!"\nShe waits.', { reasoning: 'let me think' });
    t.push(ev({ type: 'changed', version: 3, change: 'msg', id: 'a1' }), ev({ type: 'done', turnId: 't1', message: done }));
    t.tv.finish();
    const f = rows(await r.frame());
    expect(f.slice(0, 3)).toEqual(['you  › hello', '  ⋯ thinking (12 chars)', 'Mira › She smiles. "Hi!"']);
    expect(f[3]).toStartWith('  ⋯ search_history');
    expect(f[4]).toBe('       She waits.');
    expect(t.tv.kept).toBe(true);
    expect(t.seen.map((e) => e.type)).toEqual(['start', 'reasoning', 'reasoning', 'text', 'text', 'text', 'tool', 'tool', 'text', 'changed', 'done']);
    expect(r.t.lastCardId()).toBe('a1');
    // the status line goes under the card
    r.t.status(answerStatus(done, style));
    expect(rows(await r.frame()).at(-1)).toBe('  [swipe 1/1 · end]');
  });

  test('re-delivered deltas do not repeat; escapes split across deltas never show', async () => {
    const r = await open();
    const t = turn(r);
    t.push(start());
    t.push(ev({ type: 'reasoning', turnId: 't1', delta: 'abc', offset: 0 }));
    t.push(ev({ type: 'reasoning', turnId: 't1', delta: 'abc', offset: 0 }));
    t.push(ev({ type: 'reasoning', turnId: 't1', delta: 'de', offset: 3 }));
    t.push(ev({ type: 'text', turnId: 't1', delta: 'Hello ', offset: 0 }));
    t.push(ev({ type: 'text', turnId: 't1', delta: 'Hello ', offset: 0 }));
    t.push(ev({ type: 'text', turnId: 't1', delta: '\x1b[3', offset: 6 }));
    t.push(ev({ type: 'text', turnId: 't1', delta: '1mworld', offset: 9 }));
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', 'Hello \x1b[31mworld') }));
    t.tv.finish();
    expect(rows(await r.frame())).toEqual(['  ⋯ thinking (5 chars)', 'Mira › Hello world']);
    expect(t.tv.kept).toBe(false);
  });

  test('a gap in the offsets: the card is repainted from done', async () => {
    const r = await open();
    const t = turn(r);
    t.push(start());
    t.push(ev({ type: 'text', turnId: 't1', delta: 'One ', offset: 0 }));
    t.push(ev({ type: 'text', turnId: 't1', delta: 'three', offset: 8 }));
    expect(rows(await r.frame())).toEqual(['Mira › One']);
    const done = msg('a1', 'assistant', 'One two three', { finish: 'length', edited: true });
    t.push(ev({ type: 'done', turnId: 't1', message: done }));
    t.tv.finish();
    // T-15: the markers are in the status line only, not before the repainted text.
    r.t.status(answerStatus(done, style));
    expect(rows(await r.frame())).toEqual(['Mira › One two three', '  [swipe 1/1 · length · edited]']);
  });

  test('nothing streamed (a hook replaced the reply): done shows the message', async () => {
    const r = await open();
    const t = turn(r);
    t.push(start(), ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', 'Whole *reply*') }));
    t.tv.finish();
    expect(rows(await r.frame())).toEqual(['Mira › Whole reply']);
  });

  test('reasoning shown under /think show', async () => {
    const r = await open();
    const t = turn(r, { show: true });
    t.push(start(), ...textEvents('t1', ['step one\n', 'step two'], 'reasoning'), ...textEvents('t1', ['Done.']));
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', 'Done.', { reasoning: 'step one\nstep two' }) }));
    t.tv.finish();
    expect(rows(await r.frame())).toEqual(['  ⋯ step one', '    step two', 'Mira › Done.']);
  });

  test('notices go to the Repl', async () => {
    const r = await open();
    const t = turn(r);
    t.push(start(), ev({ type: 'notice', level: 'warn', code: 'tools_off', message: 'no tools' }));
    expect(t.notices).toEqual([{ level: 'warn', code: 'tools_off', message: 'no tools' }]);
  });
});

/** Every span of the frame whose text contains `s`. */
function spans(r: ChatRig, s: string): CapturedSpan[] {
  return r.setup.captureSpans().lines.flatMap((l) => l.spans).filter((sp) => sp.text.includes(s));
}
const italic = (r: ChatRig, s: string): boolean[] => spans(r, s).map((sp) => (sp.attributes & TextAttributes.ITALIC) !== 0);

describe('continue (T-15: a block of its own after the /c row, as the REPL prints it)', () => {
  test('a new block `Mira › …last words` + the addition under the echo; on done the first card shows the whole answer and both status rows the new status', async () => {
    const r = await open();
    const m = msg('a1', 'assistant', 'She opens the door.', { finish: 'length' });
    r.t.card(m, NAMES);
    r.t.status(answerStatus(m, style));
    r.t.echo(`${prefix(NAMES.user, style)}/c`);
    const t = turn(r, { continueFrom: 'She opens the door.' });
    t.push(start('a1', 'continue'), ...textEvents('t1', [' It creaks', '.']));
    let f = rows(await r.frame());
    expect(f).toEqual(['Mira › She opens the door.', '  [swipe 1/1 · length]', 'you  › /c', 'Mira › …She opens the door. It creaks.']);
    const full = msg('a1', 'assistant', 'She opens the door. It creaks.');
    t.push(ev({ type: 'done', turnId: 't1', message: full }));
    t.tv.finish();
    r.t.status(answerStatus(full, style));
    f = rows(await r.frame());
    expect(f).toEqual([
      'Mira › She opens the door. It creaks.',
      '  [swipe 1/1 · end]',
      'you  › /c',
      'Mira › …She opens the door. It creaks.',
      '  [swipe 1/1 · end]',
    ]);
    expect(r.t.lastCardId()).toBe('a1');
  });

  test('after rows taller than the screen (F1, /usage): the continuation streams at the bottom, in view', async () => {
    const r = await open({ width: 60, height: 12 });
    const m = msg('a1', 'assistant', 'First answer.');
    r.t.card(m, NAMES);
    r.t.status(answerStatus(m, style));
    for (let i = 0; i < 30; i++) r.t.system(style.dim(`help row ${i}`));
    r.t.echo(`${prefix(NAMES.user, style)}/c`);
    const t = turn(r, { continueFrom: 'First answer.' });
    t.push(start('a1', 'continue'), ...textEvents('t1', [' MORE-1']));
    let f = rows(await r.frame());
    expect(f.at(-1)).toBe('Mira › …First answer. MORE-1');
    t.push(...textEvents('t1', [' MORE-2.'], 'text', 7));
    const full = msg('a1', 'assistant', 'First answer. MORE-1 MORE-2.');
    t.push(ev({ type: 'done', turnId: 't1', message: full }));
    t.tv.finish();
    r.t.status(answerStatus(full, style));
    f = rows(await r.frame());
    expect(f.slice(-3)).toEqual(['you  › /c', 'Mira › …First answer. MORE-1 MORE-2.', '  [swipe 1/1 · end]']);
    // The first card (scrolled away) was repainted from the committed answer, off-screen and unseen until scrolled to.
    r.t.scroll('top');
    expect(rows(await r.frame()).slice(0, 2)).toEqual(['Mira › First answer. MORE-1 MORE-2.', '  [swipe 1/1 · end]']);
  });

  test('the addition starts in the prose state of the text before it (a stop inside *…*)', async () => {
    const r = await open({ width: 80 });
    const before = '*Она идёт к ';
    r.t.card(msg('a1', 'assistant', before, { finish: 'stopped' }), NAMES);
    const t = turn(r, { continueFrom: before });
    t.push(start('a1', 'continue'), ...textEvents('t1', ['двери.* «Привет», ', '— говорит она.']));
    await r.frame();
    expect(italic(r, 'двери.')).toEqual([true]);
    expect(italic(r, '«Привет»')).toEqual([false]);
    expect(italic(r, 'говорит она')).toEqual([false]);
    const full = msg('a1', 'assistant', `${before}двери.* «Привет», — говорит она.`);
    t.push(ev({ type: 'done', turnId: 't1', message: full }));
    t.tv.finish();
    await r.frame();
    // Kept as streamed: still right. The first card (which had no status row) is repainted, its [stopped] gone.
    const f = rows(await r.frame());
    expect(f[0]).toBe('Mira › Она идёт к двери. «Привет», — говорит она.');
    expect(f.join('\n')).not.toContain('[stopped]');
    expect(italic(r, 'двери.')).toEqual([true, true]);
    expect(italic(r, 'говорит она')).toEqual([false, false]);
  });

  test('a repaint of the addition (a gap) is styled from the text before it too', async () => {
    const r = await open({ width: 80 });
    const before = '*She walks to the ';
    r.t.card(msg('a1', 'assistant', before), NAMES);
    const t = turn(r, { continueFrom: before });
    t.push(start('a1', 'continue'), ev({ type: 'text', turnId: 't1', delta: 'door', offset: 0 }), ev({ type: 'text', turnId: 't1', delta: '"Hi."', offset: 9 }));
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', `${before}door.* "Hi."`) }));
    t.tv.finish();
    expect(rows(await r.frame()).at(-1)).toBe('Mira › …She walks to the door. "Hi."');
    expect(italic(r, 'door.')).toEqual([true, true]);
    expect(italic(r, '"Hi."')).toEqual([false, false]);
  });

  test('a cue-mode result that differs from the stream repaints the block from done', async () => {
    const r = await open();
    r.t.card(msg('a1', 'assistant', 'Base text.'), NAMES);
    const t = turn(r, { continueFrom: 'Base text.' });
    t.push(start('a1', 'continue'), ...textEvents('t1', [' More.']));
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', 'Base text.\n\nMore.') }));
    t.tv.finish();
    expect(rows(await r.frame())).toEqual(['Mira › Base text.', 'More.', 'Mira › …Base text.', 'More.']);
  });

  test('not the newest card: a new block after …last words; the old card stays as it was', async () => {
    const r = await open();
    r.t.card(msg('a1', 'assistant', 'An old answer that ends here.'), NAMES);
    r.t.card(msg('u2', 'user', 'later'), NAMES);
    const t = turn(r, { continueFrom: 'An old answer that ends here.' });
    t.push(start('a1', 'continue'), ...textEvents('t1', [' And more.']));
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', 'An old answer that ends here. And more.') }));
    t.tv.finish();
    const all = (await r.frame()).split('\n').map(row);
    expect(all.slice(0, 5)).toEqual(['Mira › An old answer that ends here.', '', 'you  › later', '', 'Mira › …An old answer that ends here. And more.']);
    expect(r.t.lastCardId()).toBe('a1');
  });

  test('a second continue repaints the first card, not the first continue\'s block', async () => {
    const r = await open({ width: 70 });
    const m = msg('a1', 'assistant', 'One.');
    r.t.card(m, NAMES);
    r.t.status(answerStatus(m, style));
    let text = 'One.';
    for (const [i, add] of [' Two.', ' Three.'].entries()) {
      const t = turn(r, { continueFrom: text });
      t.push(ev({ type: 'start', turnId: `t${i}`, kind: 'continue', messageId: 'a1', parentId: 'u1' }), ...textEvents(`t${i}`, [add]));
      text += add;
      const full = msg('a1', 'assistant', text);
      t.push(ev({ type: 'done', turnId: `t${i}`, message: full }));
      t.tv.finish();
      r.t.status(answerStatus(full, style));
    }
    expect(rows(await r.frame())).toEqual([
      'Mira › One. Two. Three.',
      '  [swipe 1/1 · end]',
      'Mira › …One. Two.',
      '  [swipe 1/1 · end]',
      'Mira › …One. Two. Three.',
      '  [swipe 1/1 · end]',
    ]);
  });
});

describe('the prose state runs over the whole answer (T-15)', () => {
  test('a held line mid-action: the rest keeps the action\'s italics, the kept card matches a card of the same text', async () => {
    const r = await open({ width: 80 });
    const t = turn(r);
    t.push(start(), ...textEvents('t1', ['*She walks to the']));
    t.tv.interject();
    r.t.system(style.dim('(held: sent when this answer ends)'));
    t.push(...textEvents('t1', [' door and listens.* "Hello," she says.'], 'text', 17));
    const text = '*She walks to the door and listens.* "Hello," she says.';
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', text) }));
    t.tv.finish();
    await r.frame();
    expect(italic(r, 'She walks to the')).toEqual([true]);
    expect(italic(r, 'door and listens.')).toEqual([true]);
    expect(italic(r, '"Hello,"')).toEqual([false]);
    expect(italic(r, 'she says.')).toEqual([false]);
  });

  test('inside a quote across a notice row: the closing quote does not reopen one', async () => {
    const r = await open({ width: 80 });
    const t = turn(r);
    t.push(start(), ...textEvents('t1', ['"Hello, my']));
    t.tv.interject();
    r.t.system(style.yellow('! a notice'));
    t.push(...textEvents('t1', [' friend." *She smiles.*'], 'text', 10));
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', '"Hello, my friend." *She smiles.*') }));
    t.tv.finish();
    await r.frame();
    expect(italic(r, 'friend."')).toEqual([false]);
    expect(italic(r, 'She smiles.')).toEqual([true]);
  });

  test('a side line mid-action (no new line after it): the action stays italic; after a D-55 "\\n" it is closed', async () => {
    const r = await open({ width: 80 });
    const t = turn(r);
    const tool = (id: string) => [
      ev({ type: 'tool', turnId: 't1', callId: id, name: 'roll', phase: 'start', args: {} }),
      ev({ type: 'tool', turnId: 't1', callId: id, name: 'roll', phase: 'done', ok: true, summary: '4' }),
    ];
    t.push(start(), ...textEvents('t1', ['*She reads']), ...tool('c1'), ...textEvents('t1', [' the map.* Done'], 'text', 10));
    t.push(...tool('c2'), ...textEvents('t1', ['\n*Waits'], 'text', 25), ...tool('c3'), ...textEvents('t1', ['\nplain.'], 'text', 32));
    await r.frame();
    expect(italic(r, 'the map.')).toEqual([true]);
    expect(italic(r, 'Done')).toEqual([false]);
    expect(italic(r, 'Waits')).toEqual([true]);
    expect(italic(r, 'plain.')).toEqual([false]);
  });
});

describe('widths and headers (T-16)', () => {
  test('text resuming under the header is indented by the label\'s columns (a CJK name)', async () => {
    const r = await open({ width: 60 });
    const names = displayLabels('美咲', { warp: false });
    const t = turn(r, { names });
    t.push(start(), ...textEvents('t1', ['First part.']));
    t.tv.interject();
    r.t.system('(held)');
    t.push(...textEvents('t1', [' Second part.'], 'text', 11));
    await r.frame();
    const f = rows(await r.frame());
    expect(f[0]).toBe('美咲 › First part.');
    expect(Bun.stringWidth(f[0]!.slice(0, f[0]!.indexOf('First')))).toBe(7);
    // 7 columns under `美咲 › `, then the delta's own leading space.
    expect(f[2]).toBe(`${' '.repeat(7)} Second part.`);
  });

  test('a label with escape sequences and controls never shows them', async () => {
    const r = await open({ width: 60, warp: true });
    const names: Names = { char: 'Mira\x1b[31m 👨‍👩‍👧', user: 'you\x07', width: 7 };
    r.t.card(msg('m1', 'assistant', 'Hi.'), names);
    r.t.card(msg('u1', 'user', 'Yo.'), names);
    const t = turn(r, { names });
    t.push(start('a2'), ...textEvents('t1', ['Live.']));
    const f = rows(await r.frame());
    expect(f).toEqual(['Mira 👨👩👧 › Hi.', 'you › Yo.', 'Mira 👨👩👧 › Live.']);
  });
});

describe('streaming cost (T-16)', () => {
  test('deltas between two frames reach the card\'s text buffer once', async () => {
    const r = await open();
    const t = turn(r);
    t.push(start());
    await r.frame();
    const card = r.ui.transcript.getChildren().at(-1) as TextRenderable;
    let sets = 0;
    const proto = Object.getPrototypeOf(card) as object;
    const desc = Object.getOwnPropertyDescriptor(TextRenderable.prototype, 'content') ?? Object.getOwnPropertyDescriptor(proto, 'content')!;
    Object.defineProperty(card, 'content', {
      get: () => desc.get!.call(card),
      set: (v) => {
        sets++;
        desc.set!.call(card, v);
      },
      configurable: true,
    });
    t.push(...textEvents('t1', Array.from({ length: 50 }, (_, i) => `w${i} `)));
    expect(sets).toBe(0);
    const f = rows(await r.frame());
    expect(sets).toBe(1);
    expect(f.join(' ')).toContain('w49');
  });
});

describe('stops, failures, conflicts, interjections', () => {
  // T-17 (one stop marker): the [stopped] row used to come before the status line, which says `stopped` too.
  test('stopped with a kept partial: no [stopped] row, the status line under the card says it', async () => {
    const r = await open();
    const t = turn(r);
    t.push(start(), ...textEvents('t1', ['Partial ', 'answ']));
    const m = msg('a1', 'assistant', 'Partial answ', { finish: 'stopped' });
    t.push(ev({ type: 'stopped', turnId: 't1', message: m }));
    t.tv.finish();
    expect(rows(await r.frame())).toEqual(['Mira › Partial answ']);
    r.t.status(answerStatus(m, style));
    expect(rows(await r.frame())).toEqual(['Mira › Partial answ', '  [swipe 1/1 · stopped]']);
    const sp = r.setup.captureSpans().lines[1]!.spans[0]!;
    expect((sp.attributes & TextAttributes.DIM) !== 0).toBe(true);
  });

  test('stopped with a kept answer whose status line does not say stopped: the dim [stopped] row stays', async () => {
    const r = await open();
    const t = turn(r);
    t.push(start(), ...textEvents('t1', ['Whole.']));
    t.push(ev({ type: 'stopped', turnId: 't1', message: msg('a1', 'assistant', 'Whole.', { finish: 'end' }) }));
    t.tv.finish();
    expect(rows(await r.frame())).toEqual(['Mira › Whole.', '[stopped]']);
    const sp = r.setup.captureSpans().lines[1]!.spans[0]!;
    expect((sp.attributes & TextAttributes.DIM) !== 0).toBe(true);
  });

  test('stopped before anything arrived: no empty card stays', async () => {
    const r = await open();
    r.t.echo(`${prefix(NAMES.user, style)}hi`);
    const t = turn(r);
    t.push(start(), ev({ type: 'stopped', turnId: 't1', message: null }));
    t.tv.finish();
    expect(rows(await r.frame())).toEqual(['you  › hi', '[stopped] nothing had arrived; nothing was kept']);
    expect(r.t.lastCardId()).toBe(null);
  });

  test('failed: a red row, and the kept note when a partial was committed', async () => {
    const r = await open({ width: 80 });
    const t = turn(r);
    t.push(start(), ...textEvents('t1', ['Some text']));
    t.push(ev({ type: 'changed', version: 2, change: 'msg', id: 'a1' }));
    t.push(ev({ type: 'failed', turnId: 't1', category: 'provider', code: 'timeout', message: 'too slow', draft: 'Some text' }));
    t.tv.finish();
    expect(t.tv.kept).toBe(true);
    expect(rows(await r.frame())).toEqual([
      'Mira › Some text',
      '✗ the answer failed (provider/timeout): too slow',
      '  the partial answer was kept, marked [interrupted]',
    ]);
  });

  test('conflict: a yellow row with the draft when the card did not show it', async () => {
    const r = await open({ width: 80 });
    const t = turn(r);
    t.push(start(), ev({ type: 'conflict', turnId: 't1', draft: 'The lost draft.' }));
    t.tv.finish();
    expect(rows(await r.frame())).toEqual(['! the session changed during the turn; the answer was not committed', '  draft: The lost draft.']);
  });

  test('interject: text after the Repl\'s row goes under it, indented', async () => {
    const r = await open();
    const t = turn(r);
    t.push(start(), ...textEvents('t1', ['First part']));
    t.tv.interject();
    r.t.system(style.dim('(held: sent when this answer ends)'));
    t.push(...textEvents('t1', [' second part.'], 'text', 10));
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', 'First part second part.') }));
    t.tv.finish();
    expect(rows(await r.frame())).toEqual(['Mira › First part', '(held: sent when this answer ends)', '        second part.']);
  });

  test('interject before any output: the empty card moves under the row', async () => {
    const r = await open();
    const t = turn(r);
    t.push(start());
    t.tv.interject();
    r.t.system('(held)');
    t.push(...textEvents('t1', ['Text.']));
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', 'Text.') }));
    t.tv.finish();
    const all = (await r.frame()).split('\n').map(row);
    expect(all.slice(0, 3)).toEqual(['(held)', '', 'Mira › Text.']);
  });
});

describe('scrolling while a turn streams', () => {
  test('sticky at the bottom; scrolled up the view stays; bottom re-engages', async () => {
    const r = await open({ width: 40, height: 10 });
    for (let i = 0; i < 20; i++) r.t.system(`row ${i}`);
    const t = turn(r);
    t.push(start());
    const words = Array.from({ length: 30 }, (_, i) => `w${i} `);
    const evs = textEvents('t1', words);
    for (const e of evs.slice(0, 10)) t.push(e);
    let f = rows(await r.frame());
    expect(f.at(-1)).toContain('w9');
    r.t.scroll('pageUp');
    const up = rows(await r.frame());
    for (const e of evs.slice(10)) t.push(e);
    expect(rows(await r.frame())).toEqual(up);
    r.t.scroll('bottom');
    f = rows(await r.frame());
    expect(f.at(-1)).toContain('w29');
  });
});
