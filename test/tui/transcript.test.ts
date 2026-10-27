import { afterEach, describe, expect, test } from 'bun:test';
import { TextAttributes, type CapturedSpan } from '@opentui/core';
import { makeStyle, prefix, statusLine } from '../../src/cli/repl-render.ts';
import type { ReplViewContext } from '../../src/cli/repl-view.ts';
import { ARCHIVE_BLOCK, HISTORY_BATCH } from '../../src/cli/tui/transcript.ts';
import { MONO_THEME, THEME } from '../../src/cli/tui/theme.ts';
import { LAYOUT, type TranscriptApi } from '../../src/cli/tui/types.ts';
import { answerStatus, TuiView } from '../../src/cli/tui/view.ts';
import type { MessageView } from '../../src/session/view.ts';
import { chatRig, ev, msg, NAMES, row, rows, textEvents, type ChatRig } from './chat-kit.ts';

/** RP_CORE_PERF=1: the wall-clock thresholds run too (they flake on a loaded machine, so not by default). */
const PERF = process.env.RP_CORE_PERF === '1';

const style = makeStyle(true);
let rig: ChatRig | null = null;
afterEach(async () => {
  await rig?.setup.dispose();
  rig = null;
});

async function open(o: Parameters<typeof chatRig>[0] = {}): Promise<ChatRig> {
  rig = await chatRig(o);
  return rig;
}

/** The span whose text contains `s` (first match on any row). */
function span(r: ChatRig, s: string): CapturedSpan | undefined {
  for (const line of r.setup.captureSpans().lines) for (const sp of line.spans) if (sp.text.includes(s)) return sp;
  return undefined;
}

const has = (sp: CapturedSpan | undefined, attr: number): boolean => sp !== undefined && (sp.attributes & attr) !== 0;

describe('transcript: cards and rows', () => {
  test('a card: bold coloured header, prose italics, wrapped text', async () => {
    const r = await open({ width: 40 });
    r.t.card(msg('m1', 'assistant', '*Mira looks up.* "Hello, Levi." The lamp flickers and the night goes on.'), NAMES);
    const f = rows(await r.frame());
    // The action italic without its asterisks (polish2).
    expect(f[0]).toBe('Mira › Mira looks up. "Hello, Levi." The');
    expect(f[1]).toBe('lamp flickers and the night goes on.');
    expect(f.length).toBe(2);
    expect(has(span(r, 'Mira'), TextAttributes.BOLD)).toBe(true);
    const head = r.setup.captureSpans().lines[0]!.spans[0]!;
    expect(head.text.startsWith('Mira')).toBe(true);
    expect(head.fg.equals(THEME.char)).toBe(true);
    expect(has(span(r, 'Mira looks up.'), TextAttributes.ITALIC)).toBe(true);
    expect(has(span(r, '"Hello, Levi."'), TextAttributes.ITALIC)).toBe(false);
    expect(r.t.lastCardId()).toBe('m1');
  });

  test('the player\'s card uses the padded user label', async () => {
    const r = await open();
    r.t.card(msg('u1', 'user', 'hello'), NAMES);
    expect(rows(await r.frame())).toEqual(['you  › hello']);
    expect(r.setup.captureSpans().lines[0]!.spans[0]!.fg.equals(THEME.user)).toBe(true);
  });

  test('system rows keep the Repl\'s tones; unknown sequences never show', async () => {
    const r = await open();
    r.t.system(style.yellow('! a warning'));
    r.t.system(style.red('error: bad'));
    r.t.system(`${style.dim('dim')} and \x1b[4munderline\x1b[24m \x1b]0;title\x07done`);
    r.t.system('two\nlines');
    const f = rows(await r.frame());
    expect(f).toEqual(['! a warning', 'error: bad', 'dim and underline done', 'two', 'lines']);
    expect(span(r, '! a warning')!.fg.equals(THEME.yellow)).toBe(true);
    expect(span(r, 'error: bad')!.fg.equals(THEME.red)).toBe(true);
    expect(has(span(r, 'dim'), TextAttributes.DIM)).toBe(true);
  });

  test('echo: the player\'s line after a blank line, the label in the player\'s colour', async () => {
    const r = await open();
    r.t.card(msg('m1', 'assistant', 'Hi.'), NAMES);
    r.t.echo(`${prefix(NAMES.user, style)}hello there`);
    const all = (await r.frame()).split('\n').map(row);
    expect(all.slice(0, 3)).toEqual(['Mira › Hi.', '', 'you  › hello there']);
    const you = r.setup.captureSpans().lines[2]!.spans[0]!;
    expect(you.text.startsWith('you')).toBe(true);
    expect(you.fg.equals(THEME.user)).toBe(true);
    expect(has(you, TextAttributes.BOLD)).toBe(true);
  });

  test('status: a dim line under the card; again right after it replaces it, after other rows it is a new row (never off-screen)', async () => {
    const r = await open({ width: 70 });
    const m = msg('m1', 'assistant', 'Answer.');
    r.t.card(m, NAMES);
    r.t.status(answerStatus(m, style));
    r.t.status(answerStatus({ ...m, hidden: true }, style));
    expect(rows(await r.frame())).toEqual(['Mira › Answer.', '  [swipe 1/1 · end · hidden]']);
    r.t.echo(`${prefix(NAMES.user, style)}/usage`);
    r.t.status(answerStatus({ ...m, edited: true }, style));
    const f = rows(await r.frame());
    expect(f).toEqual(['Mira › Answer.', '  [swipe 1/1 · end · hidden]', 'you  › /usage', '  [swipe 1/1 · end · edited]']);
    expect(has(span(r, '[swipe'), TextAttributes.DIM)).toBe(true);
  });

  test('T-15: the status line has no REPL hints; the markers show once, in it, not before the text', async () => {
    const r = await open({ width: 70 });
    const cut = msg('m1', 'assistant', 'Cut off', { finish: 'length', edited: true });
    r.t.card(cut, NAMES);
    r.t.status(answerStatus(cut, style));
    // Without a status row (an edit shows the message alone) the card keeps them.
    r.t.card(msg('m2', 'assistant', 'Edited alone', { edited: true }), NAMES);
    const greeting = { ...msg('g1', 'assistant', 'Hello.', { edited: true, swipe: [0, 2] }), gen: { kind: 'greeting' } } as MessageView;
    r.t.card(greeting, NAMES);
    r.t.status(answerStatus(greeting, style));
    expect(rows(await r.frame())).toEqual([
      'Mira › Cut off',
      '  [swipe 1/1 · length · edited]',
      'Mira › [edited] Edited alone',
      'Mira › Hello.',
      '  [greeting 1/2 · edited]',
    ]);
    // A path: the same, cards with a status line carry no markers, the player's (no status line) do.
    r.t.showPath([msg('u1', 'user', 'secret', { hidden: true }), cut], NAMES, (m) => (m.role === 'assistant' ? answerStatus(m, style) : null));
    expect(rows(await r.frame())).toEqual(['you  › [hidden] secret', 'Mira › Cut off', '  [swipe 1/1 · length · edited]']);
  });

  test('Cyrillic and wide characters', async () => {
    const r = await open({ width: 30 });
    r.t.card(msg('m1', 'assistant', 'Ёжик съел щи. 漢字かな 😀 конец'), NAMES);
    const f = rows(await r.frame());
    expect(f[0]).toBe('Mira › Ёжик съел щи. 漢字かな');
    expect(f[1]).toBe('😀 конец');
  });

  test('markers: hidden, edited and a finish other than end; reasoning folded or shown', async () => {
    const r = await open({ width: 60 });
    r.t.card(msg('u1', 'user', 'secret', { hidden: true, edited: true }), NAMES);
    r.t.card(msg('m1', 'assistant', 'Cut off', { finish: 'length', reasoning: 'let me think' }), NAMES);
    const f = rows(await r.frame());
    expect(f).toEqual(['you  › [hidden] [edited] secret', '  ⋯ thinking (12 chars)', 'Mira › [length] Cut off']);
    expect(has(span(r, '[hidden]'), TextAttributes.DIM)).toBe(true);
  });

  test('reasoning shown under /think show', async () => {
    const r = await open({ width: 60, showReasoning: () => true });
    r.t.card(msg('m1', 'assistant', 'Yes.', { reasoning: 'first\nsecond' }), NAMES);
    expect(rows(await r.frame())).toEqual(['  ⋯ first', '    second', 'Mira › Yes.']);
  });

  test('model text is sanitised: escapes, controls, tabs', async () => {
    const r = await open();
    r.t.card(msg('m1', 'assistant', 'a\x1b[31mred\x1b[0m\tb\x07c\x1b]0;pwned\x07d'), NAMES);
    expect(rows(await r.frame())).toEqual(['Mira › ared  bcd']);
  });

  test('U+2028 / U+2029 are line breaks, in a card and in a streamed answer (T-16)', async () => {
    const r = await open();
    r.t.card(msg('m1', 'assistant', 'One.\u2028Two.\u2029Three.'), NAMES);
    const tv = r.t.turn({ label: NAMES.char, names: NAMES, showReasoning: () => false, notice: () => {} });
    tv.push(ev({ type: 'start', turnId: 't', kind: 'reply', messageId: 'a2', parentId: 'm1' }));
    for (const e of textEvents('t', ['Four.\u2028', 'Five.'])) tv.push(e);
    expect(rows(await r.frame())).toEqual(['Mira › One.', 'Two.', 'Three.', 'Mira › Four.', 'Five.']);
  });

  test('mono theme: no colours, attributes stay', async () => {
    const r = await open({ theme: MONO_THEME });
    r.t.card(msg('m1', 'assistant', '*waves*'), NAMES);
    await r.frame();
    const head = r.setup.captureSpans().lines[0]!.spans[0]!;
    expect(head.fg.equals(THEME.char)).toBe(false);
    expect(head.fg.intent).toBe('default');
    expect(has(head, TextAttributes.BOLD)).toBe(true);
    expect(has(span(r, 'waves'), TextAttributes.ITALIC)).toBe(true);
  });

  test('showPath clears what was shown and renders the whole path with status lines', async () => {
    const r = await open({ width: 60 });
    r.t.system('old row');
    const path = [msg('g', 'assistant', 'Greeting.'), msg('u', 'user', 'Hi.'), msg('a', 'assistant', 'Answer.')];
    r.t.showPath(path, NAMES, (m) => (m.role === 'assistant' ? style.dim(`  [${m.id}]`) : null));
    const all = (await r.frame()).split('\n').map(row);
    expect(all.slice(0, 8)).toEqual(['Mira › Greeting.', '  [g]', '', 'you  › Hi.', '', 'Mira › Answer.', '  [a]', '']);
    expect(r.t.lastCardId()).toBe('a');
  });
});

describe('transcript: scrolling', () => {
  test('pages by the viewport height − 2, top and bottom; sticky at the bottom', async () => {
    const r = await open({ width: 40, height: 12 });
    for (let i = 0; i < 40; i++) r.t.system(`row ${i}`);
    let f = rows(await r.frame());
    expect(f[f.length - 1]).toBe('row 39');
    const box = r.ui.transcript;
    const view = box.viewport.height;
    const bottom = box.scrollTop;
    r.t.scroll('pageUp');
    await r.frame();
    expect(box.scrollTop).toBe(bottom - (view - 2));
    // scrolled up: new rows do not move the view
    const before = rows(await r.frame());
    r.t.system('row 40');
    expect(rows(await r.frame())).toEqual(before);
    r.t.scroll('top');
    f = rows(await r.frame());
    expect(f[0]).toBe('row 0');
    r.t.scroll('pageDown');
    await r.frame();
    expect(box.scrollTop).toBe(view - 2);
    r.t.scroll('bottom');
    f = rows(await r.frame());
    expect(f[f.length - 1]).toBe('row 40');
    // sticky again: the next row shows
    r.t.system('row 41');
    f = rows(await r.frame());
    expect(f[f.length - 1]).toBe('row 41');
  });
});

describe('transcript: archive folding (T-7)', () => {
  test('2 000 cards: renderables stay bounded and a streaming frame stays cheap', async () => {
    const r = await open({ width: 120, height: 40 });
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const m = msg(`m${i}`, i % 2 ? 'assistant' : 'user', `Card ${i}: *she smiles* "Привет" and a few more words. `.repeat(2));
      r.t.card(m, NAMES);
      if (i % 2) r.t.status(statusLine(m, style));
    }
    const entries = n + n / 2;
    const children = r.ui.transcript.getChildren().length;
    expect(children).toBeLessThanOrEqual(LAYOUT.liveCards + ARCHIVE_BLOCK + Math.ceil(entries / ARCHIVE_BLOCK));
    expect(children).toBeGreaterThanOrEqual(LAYOUT.liveCards);
    await r.setup.renderOnce();
    const tv = r.t.turn({ label: NAMES.char, names: NAMES, showReasoning: () => false, notice: () => {} });
    tv.push(ev({ type: 'start', turnId: 't', kind: 'reply', messageId: 'live', parentId: `m${n - 1}` }));
    let total = 0;
    const deltas = textEvents('t', Array.from({ length: 40 }, (_, i) => `word${i} `));
    for (const e of deltas) {
      tv.push(e);
      const t0 = performance.now();
      await r.setup.renderOnce();
      total += performance.now() - t0;
    }
    if (PERF) expect(total / deltas.length).toBeLessThan(15);
    const f = rows(r.setup.captureCharFrame());
    expect(f.some((x) => x.includes('word39'))).toBe(true);
    // the oldest card is still there, inside an archive block
    r.t.scroll('top');
    const top = rows(await r.frame());
    expect(top[0]).toStartWith('you  › Card 0: she smiles "Привет"');
  });

  test('folded history looks the same as cards built from a path', async () => {
    const make = (i: number) => msg(`m${i}`, i % 3 === 0 ? 'user' : 'assistant', `Line ${i} *act* "say"`);
    const n = LAYOUT.liveCards + ARCHIVE_BLOCK * 2 + 7;
    const a = await chatRig({ width: 50, height: 30 });
    const b = await chatRig({ width: 50, height: 30 });
    try {
      const path = Array.from({ length: n }, (_, i) => make(i));
      const statusOf = (m: (typeof path)[number]) => (m.role === 'assistant' ? style.dim(`  [${m.id}]`) : null);
      a.t.showPath(path, NAMES, statusOf);
      for (const m of path) {
        b.t.card(m, NAMES);
        const s = statusOf(m);
        if (s) b.t.status(s);
      }
      expect(await a.frame()).toBe(await b.frame());
      expect(a.ui.transcript.scrollHeight).toBe(b.ui.transcript.scrollHeight);
      a.t.scroll('top');
      b.t.scroll('top');
      const top = await a.frame();
      expect(top).toBe(await b.frame());
      expect(rows(top).slice(0, 4)).toEqual(['you  › Line 0 act "say"', 'Mira › Line 1 act "say"', '  [m1]', 'Mira › Line 2 act "say"']);
      expect(a.t.lastCardId()).toBe(`m${n - 1}`);
    } finally {
      await a.setup.dispose();
      await b.setup.dispose();
    }
  });
});

describe('transcript: opening a long story (T-16)', () => {
  const story = (n: number) => Array.from({ length: n }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user', `Line ${i} *act* "say"`));
  const statusOf = (m: MessageView) => (m.role === 'assistant' ? style.dim(`  [${m.id}]`) : null);

  test('only the newest entries and one batch of history are built; Ctrl+Home builds the rest a batch at a time', async () => {
    const r = await open({ width: 60, height: 20 });
    const n = 1500;
    r.t.showPath(story(n), NAMES, statusOf);
    const box = r.ui.transcript;
    // The newest LAYOUT.liveCards entries (100 messages here: a card and a status row each for half of them)…
    const tailMessages = Math.ceil((LAYOUT.liveCards * 2) / 3);
    const waiting = n - tailMessages - HISTORY_BATCH;
    // …one row counting what is not built, HISTORY_BATCH messages in archive blocks, and the mounted entries.
    expect(box.getChildren().length).toBeLessThanOrEqual(1 + Math.ceil((HISTORY_BATCH * 1.5) / ARCHIVE_BLOCK) + 1 + LAYOUT.liveCards + 1);
    expect(rows(await r.frame()).at(-1)).toBe(`  [m${n - 1}]`);
    r.t.scroll('top');
    let top = rows(await r.frame());
    expect(top[0]).toBe(`⋯ ${waiting - HISTORY_BATCH} earlier messages · Ctrl+Home loads more`);
    expect(top[1]).toBe(`you  › Line ${waiting - HISTORY_BATCH} act "say"`);
    expect(has(span(r, 'earlier messages'), TextAttributes.DIM)).toBe(true);
    for (let k = 0; k < 10 && top[0]!.startsWith('⋯'); k++) {
      r.t.scroll('top');
      top = rows(await r.frame());
    }
    expect(top.slice(0, 3)).toEqual(['you  › Line 0 act "say"', 'Mira › Line 1 act "say"', '  [m1]']);
    // All of it now, in the order of the path, with the gaps a card gets.
    const all = (await r.frame()).split('\n').map(row);
    expect(all.slice(0, 5)).toEqual(['you  › Line 0 act "say"', '', 'Mira › Line 1 act "say"', '  [m1]', '']);
    expect(r.t.lastCardId()).toBe(`m${n - 1}`);
  });

  test('a path loaded through Ctrl+Home looks the same as the same messages appended one by one', async () => {
    const n = LAYOUT.liveCards + HISTORY_BATCH + 140;
    const path = story(n);
    const a = await chatRig({ width: 50, height: 30 });
    const b = await chatRig({ width: 50, height: 30 });
    try {
      a.t.showPath(path, NAMES, statusOf);
      for (const m of path) {
        b.t.card(m, NAMES);
        const st = statusOf(m);
        if (st) b.t.status(st);
      }
      await a.frame();
      await b.frame();
      a.t.scroll('top');
      while (rows(await a.frame())[0]!.startsWith('⋯')) a.t.scroll('top');
      b.t.scroll('top');
      expect(await a.frame()).toBe(await b.frame());
      expect(a.ui.transcript.scrollHeight).toBe(b.ui.transcript.scrollHeight);
      a.t.scroll('bottom');
      b.t.scroll('bottom');
      expect(await a.frame()).toBe(await b.frame());
    } finally {
      await a.setup.dispose();
      await b.setup.dispose();
    }
  });
});

describe('TuiView (the chat side)', () => {
  function view(log: string[] = []) {
    const calls: string[] = [];
    const transcript: TranscriptApi = {
      showPath: () => calls.push('path'),
      card: () => calls.push('card'),
      system: (s) => calls.push(`sys:${s}`),
      echo: (s) => calls.push(`echo:${s}`),
      status: (s) => calls.push(`status:${s}`),
      turn: () => ({ push: () => {}, finish: () => {}, interject: () => {}, kept: false }),
      scroll: () => {},
      lastCardId: () => null,
    };
    const ctx = { style: makeStyle(false), bannerInfo: () => { throw new Error('not here'); } } as unknown as ReplViewContext;
    const v = new TuiView({ ctx, transcript, models: { update: () => {} }, agents: { event: () => {}, refresh: () => {}, reset: () => {} }, prices: {}, extra: () => ({ newlineKey: 'Ctrl+J', mouse: false }), status: () => {}, log: (t) => log.push(t) });
    return { v, calls };
  }

  test('lastSaid: the Repl\'s lines since the player\'s last line (the exit reason for the host to print, T-14)', () => {
    const { v, calls } = view();
    v.line('first');
    v.echo('/quit');
    v.line('(1 answer failed: script_exhausted; exit 3)');
    expect(v.lastSaid).toEqual(['(1 answer failed: script_exhausted; exit 3)']);
    expect(calls).toContain('sys:(1 answer failed: script_exhausted; exit 3)');
  });

  test('a turn\'s failure and conflict rows reach the file log (they are not Repl lines)', () => {
    const log: string[] = [];
    const { v } = view(log);
    const tv = v.turn({ label: 'Mira', showReasoning: () => false, notice: () => {} });
    tv.push(ev({ type: 'failed', turnId: 't', category: 'provider', code: 'timeout', message: 'too slow', draft: '' }));
    tv.push(ev({ type: 'conflict', turnId: 't', draft: 'x' }));
    tv.finish();
    expect(log).toEqual(['the answer failed (provider/timeout): too slow', 'the session changed during the turn; the answer was not committed']);
  });

  test('answerStatus: the REPL\'s items, no hints', () => {
    const m = msg('a', 'assistant', 'x', { swipe: [1, 3] });
    expect(answerStatus(m, makeStyle(false))).toBe('  [swipe 2/3 · end]');
    expect(statusLine(m, makeStyle(false))).toBe('  [swipe 2/3 · end]   /r swipe  /c continue  /e edit');
  });
});
