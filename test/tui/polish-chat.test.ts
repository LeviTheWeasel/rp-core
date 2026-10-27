// Levi's second look at the TUI's chat (TUI decisions T-17): `**bold**` rendered as markdown (in cards
// and while streaming; the line REPL unchanged), and (polish2) `*italic*` too, literal asterisks kept;
// OpenTUI's own selection readable on every transcript renderable, and /help listing the keys when the
// left pane does not show them. (One stop marker: stream.test.ts and e2e.test.ts.)
import { afterEach, describe, expect, test } from 'bun:test';
import { TextAttributes, TextRenderable, type CapturedSpan } from '@opentui/core';
import { helpText } from '../../src/cli/repl-commands.ts';
import { createProseStyler, makeStyle, SGR } from '../../src/cli/repl-render.ts';
import type { ReplViewContext } from '../../src/cli/repl-view.ts';
import { keyRows } from '../../src/cli/tui/keys.ts';
import { MONO_THEME, THEME } from '../../src/cli/tui/theme.ts';
import { HISTORY_BATCH, selectionColours } from '../../src/cli/tui/transcript.ts';
import { createChatStyler, proseChunks, visibleText } from '../../src/cli/tui/turn-view.ts';
import { LAYOUT, type Theme, type TranscriptApi } from '../../src/cli/tui/types.ts';
import { TuiView } from '../../src/cli/tui/view.ts';
import { chatRig, ev, msg, NAMES, rows, textEvents, type ChatRig } from './chat-kit.ts';
import { calls, tuiRig, type TuiRig } from './kit.ts';

const style = makeStyle(true);
const B = SGR.boldOn;
const b = SGR.intensityOff;
const I = SGR.italicOn;
const i = SGR.italicOff;

let rig: ChatRig | null = null;
let tui: TuiRig | null = null;
afterEach(async () => {
  await rig?.setup.dispose();
  rig = null;
  if (tui && !tui.setup.renderer.isDestroyed) await tui.close();
  tui = null;
});

const whole = (s: string): string => {
  const st = createChatStyler();
  return st.push(s) + st.end();
};
const pieces = (parts: readonly string[]): string => {
  const st = createChatStyler();
  return parts.map((p) => st.push(p)).join('') + st.end();
};
/** The line REPL's prose styling of a whole text. */
const repl = (s: string): string => {
  const st = createProseStyler(true);
  return st.push(s) + st.end();
};

// ---- the styler ----------------------------------------------------------------------------------------

describe('createChatStyler: the REPL\'s prose styling as markdown, **bold** and *italic* without asterisks (T-17, polish2)', () => {
  test('**bold** is bold, its asterisks dropped; in speech too', () => {
    expect(whole('She is **very** tired.')).toBe(`She is ${B}very${b} tired.`);
    expect(whole('"I **really** mean it."')).toBe(`"I ${B}really${b} mean it."`);
  });

  test('an *action* is italic without its asterisks: where every * marks a span, the REPL\'s styling with the asterisks dropped', () => {
    expect(whole('She *waves* and *nods*.')).toBe(`She ${I}waves${i} and ${I}nods${i}.`);
    for (const s of ['*waves*', '*She says "no" and leaves.*', '*unclosed\nnext line', '*Он шепчет «тише» и уходит*', '"Hi." *She waves* "Bye."', '(*sighs*) fine']) {
      expect(whole(s)).toBe(repl(s).replaceAll('*', ''));
    }
  });

  test('a * that marks nothing is a literal asterisk: drawn, toggling nothing', () => {
    // Blank after it (cannot open), a letter or digit before it (intraword), nothing after it.
    for (const s of ['5 * 3 = 15', 'end *', '* a list item', 'f*ck', '5*3', 'x*', 'a * b * c', 'sh*t, he says']) expect(whole(s)).toBe(s);
    // Inside an action: a blank before it or a letter after it cannot close the action.
    expect(whole('*he says f*ck loudly*')).toBe(`${I}he says f*ck loudly${i}`);
    expect(whole('*she counts 5 * 3*')).toBe(`${I}she counts 5 * 3${i}`);
    expect(whole('*waves* 2 * 2')).toBe(`${I}waves${i} 2 * 2`);
    // The REPL italicises the rest after such a *; the chat does not.
    expect(repl('5 * 3')).toBe(`5 ${I}* 3${i}`);
  });

  test('*emphasis* in speech is italic too; the end of the speech ends it; speech in an action stays plain', () => {
    expect(whole('"I *really* mean it."')).toBe(`"I ${I}really${i} mean it."`);
    expect(whole('"*sighs* fine"')).toBe(`"${I}sighs${i} fine"`);
    expect(whole('"I *really mean it." Then')).toBe(`"I ${I}really mean it.${i}" Then`);
    expect(whole('*She says "I *do*" and goes*')).toBe(`${I}She says ${i}"I ${I}do${i}"${I} and goes${i}`);
    expect(whole('«Я *правда* здесь»')).toBe(`«Я ${I}правда${i} здесь»`);
  });

  test('*** edge cases: ***both*** bold and italic with no asterisks; a scene break *** and **** stay asterisks', () => {
    expect(whole('***both***')).toBe(`${I}${B}both${b}${i}`);
    expect(whole('*she **really** waves*')).toBe(`${I}she ${B}really${b} waves${i}`);
    expect(whole('**bold *and italic***')).toBe(`${B}bold ${I}and italic${b}${i}`);
    for (const s of ['***', '***\nNext.', 'a\n***\nb', '****', '** b', 'a ** b', 'end **']) expect(whole(s)).toBe(s);
  });

  test('a newline ends an open bold (a stray ** cannot bolden the rest), as it ends an action', () => {
    expect(whole('**open\nnext')).toBe(`${B}open${b}\nnext`);
    expect(whole('*act **both\nplain')).toBe(`${I}act ${B}both${b}${i}\nplain`);
    expect(whole('"a *b\nc')).toBe(`"a ${I}b${i}\nc`);
  });

  test('any split into deltas gives the output of the whole text (** split across deltas, * then *)', () => {
    const texts = [
      '***both*** and **bold** *act* "q **x**"\n**open\n***',
      'a**b**c',
      '*She **really** waves.* "No."',
      '** b **',
      '**x***y*',
      '5 * 3 *x* f*ck "a *b* c" * end *',
      '*he says f*ck* «*тише*» x*',
    ];
    for (const t of texts) {
      const want = whole(t);
      const cps = [...t];
      for (let a = 0; a <= cps.length; a++) {
        for (let c = a; c <= cps.length; c++) {
          const got = pieces([cps.slice(0, a).join(''), cps.slice(a, c).join(''), cps.slice(c).join('')]);
          if (got !== want) throw new Error(`${JSON.stringify(t)} split at ${a}/${c}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
        }
      }
      expect(pieces(cps)).toBe(want);
    }
  });

  test('held asterisks: decided by the next character, or by flush() / end() as if nothing followed', () => {
    const st = createChatStyler();
    expect(st.push('Hi **')).toBe('Hi ');
    expect(st.push('x**')).toBe(`${B}x`);
    expect(st.push(' y')).toBe(`${b} y`);
    // A * the next character makes a marker: never drawn.
    const g = createChatStyler();
    expect(g.push('Hi *')).toBe('Hi ');
    expect(g.push('x*')).toBe(`${I}x`);
    expect(g.push(' y')).toBe(`${i} y`);
    // Nothing follows (a side line): a * that cannot open is drawn.
    const f = createChatStyler();
    expect(f.push('Hi *')).toBe('Hi ');
    expect(f.flush()).toBe('*');
    expect(f.end()).toBe('');
    // ...and one that closes the open action is not.
    const c = createChatStyler();
    expect(c.push('*act*')).toBe(`${I}act`);
    expect(c.flush()).toBe(i);
  });

  test('seed(): the text before a continue sets the state; its held asterisks are not drawn again', () => {
    const st = createChatStyler();
    expect(st.seed('She *waves*')).toBe(`She ${I}waves`);
    expect(st.push(' Then **runs**.') + st.end()).toBe(`${i} Then ${B}runs${b}.`);
    const open = createChatStyler();
    open.seed('He says **');
    expect(open.push('loud** words.') + open.end()).toBe(`${B}loud${b} words.`);
    // A literal * the last words already show is not drawn a second time; an opener restyles only.
    const lit = createChatStyler();
    expect(lit.seed('Total: 5 *')).toBe('Total: 5 ');
    expect(lit.push(' 3') + lit.end()).toBe(' 3');
    const opener = createChatStyler();
    opener.seed('She *');
    expect(opener.push('waves* ok') + opener.end()).toBe(`${I}waves${i} ok`);
  });

  test('visibleText: what the chat shows, the asterisks of bold and italic dropped, literal ones kept', () => {
    expect(visibleText('She is **very** *tired*')).toBe('She is very tired');
    expect(visibleText('*f*ck* 5 * 3 end *')).toBe('f*ck 5 * 3 end *');
  });

  test('the line REPL is unchanged: its styler keeps every asterisk (** as two italic toggles)', () => {
    expect(repl('**bold**')).toBe(`${I}**${i}bold${I}**${i}`);
    expect(repl('*waves* ok')).toBe(`${I}*waves*${i} ok`);
    expect(repl('"I *really* mean it."')).toBe('"I *really* mean it."');
  });
});

// ---- the transcript ------------------------------------------------------------------------------------

function spans(r: ChatRig): CapturedSpan[] {
  return r.setup.captureSpans().lines.flatMap((l) => l.spans);
}
/** Each span's text that contains `s`, with whether it is bold / italic. */
function looks(r: ChatRig, s: string): { text: string; bold: boolean; italic: boolean }[] {
  return spans(r)
    .filter((sp) => sp.text.includes(s))
    .map((sp) => ({ text: sp.text, bold: (sp.attributes & TextAttributes.BOLD) !== 0, italic: (sp.attributes & TextAttributes.ITALIC) !== 0 }));
}

function turn(r: ChatRig, o: { continueFrom?: string } = {}) {
  const tv = r.t.turn({
    label: NAMES.char,
    names: NAMES,
    showReasoning: () => false,
    notice: () => {},
    ...(o.continueFrom !== undefined ? { continueFrom: o.continueFrom } : {}),
  });
  return { tv, push: (...evs: ReturnType<typeof ev>[]) => evs.forEach((e) => tv.push(e)) };
}
const start = (kind: 'reply' | 'continue' = 'reply') => ev({ type: 'start', turnId: 't1', kind, messageId: 'a1', parentId: 'u1' });

describe('**bold** and *italic* in the chat (T-17, polish2)', () => {
  test('a card: bold and the *action* italic, without their asterisks', async () => {
    rig = await chatRig({ width: 60, height: 10 });
    rig.t.card(msg('a1', 'assistant', 'She is **very** tired. *She yawns.*'), NAMES);
    expect(rows(await rig.frame())).toEqual(['Mira › She is very tired. She yawns.']);
    expect(looks(rig, 'very')).toEqual([{ text: 'very', bold: true, italic: false }]);
    expect(looks(rig, 'tired.')[0]!.bold).toBe(false);
    expect(looks(rig, 'She yawns.')).toEqual([{ text: 'She yawns.', bold: false, italic: true }]);
  });

  test('a card: literal asterisks stay, plain; emphasis in speech is italic', async () => {
    rig = await chatRig({ width: 70, height: 10 });
    rig.t.card(msg('a1', 'assistant', '"I *really* mean it." 5 * 3 is f*ck all *'), NAMES);
    expect(rows(await rig.frame())).toEqual(['Mira › "I really mean it." 5 * 3 is f*ck all *']);
    expect(looks(rig, 'really')).toEqual([{ text: 'really', bold: false, italic: true }]);
    expect(spans(rig).filter((sp) => sp.text.includes('*')).every((sp) => (sp.attributes & TextAttributes.ITALIC) === 0)).toBe(true);
  });

  test('streaming: a ** or * split across deltas never shows; the card ends as the stored text\'s card', async () => {
    rig = await chatRig({ width: 60, height: 10 });
    const t = turn(rig);
    const parts = ['She is *', '*ve', 'ry*', '* tired. *', 'yawns*'];
    const evs = textEvents('t1', parts);
    t.push(start(), evs[0]!);
    expect(rows(await rig.frame())).toEqual(['Mira › She is']);
    t.push(evs[1]!, evs[2]!);
    expect(rows(await rig.frame())).toEqual(['Mira › She is very']);
    expect(looks(rig, 'very')[0]!.bold).toBe(true);
    t.push(evs[3]!);
    expect(rows(await rig.frame())).toEqual(['Mira › She is very tired.']);
    t.push(evs[4]!);
    expect(rows(await rig.frame())).toEqual(['Mira › She is very tired. yawns']);
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', parts.join('')) }));
    t.tv.finish();
    const streamed = rows(await rig.frame());
    const streamedSpans = spans(rig).map((s) => [s.text, s.attributes]);
    expect(streamed).toEqual(['Mira › She is very tired. yawns']);
    expect(looks(rig, 'yawns')[0]!.italic).toBe(true);
    // The same text as a finished card looks the same.
    const other = await chatRig({ width: 60, height: 10 });
    try {
      other.t.card(msg('a1', 'assistant', parts.join('')), NAMES);
      expect(rows(await other.frame())).toEqual(streamed);
      expect(spans(other).map((s) => [s.text, s.attributes])).toEqual(streamedSpans);
    } finally {
      await other.setup.dispose();
    }
  });

  test('*** while streaming: the word bold and italic, no asterisk drawn', async () => {
    rig = await chatRig({ width: 60, height: 10 });
    const t = turn(rig);
    t.push(start(), ...textEvents('t1', ['*', '**bo', 'th*', '**', ' then']));
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', '***both*** then') }));
    t.tv.finish();
    expect(rows(await rig.frame())).toEqual(['Mira › both then']);
    expect(looks(rig, 'both')).toEqual([{ text: 'both', bold: true, italic: true }]);
    expect(looks(rig, ' then')[0]!.italic).toBe(false);
  });

  test('an *action* streamed: italic, its asterisks never drawn (one alone in a delta too)', async () => {
    rig = await chatRig({ width: 60, height: 10 });
    const t = turn(rig);
    t.push(start(), ...textEvents('t1', ['*']));
    expect(rows(await rig.frame())).toEqual(['Mira ›']);
    t.push(...textEvents('t1', ['wa'], 'text', 1));
    expect(rows(await rig.frame())).toEqual(['Mira › wa']);
    t.push(...textEvents('t1', ['ves*', ' ok'], 'text', 3));
    expect(rows(await rig.frame())).toEqual(['Mira › waves ok']);
    expect(looks(rig, 'waves')[0]!.italic).toBe(true);
    expect(looks(rig, ' ok')[0]!.italic).toBe(false);
  });

  test('literal asterisks streamed: 5 * 3, f*ck and a lone * at the end stay drawn, nothing italic', async () => {
    rig = await chatRig({ width: 60, height: 10 });
    const t = turn(rig);
    const text = '5 * 3, f*ck *';
    t.push(start(), ...textEvents('t1', ['5 *', ' 3, f*', 'ck *']));
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', text) }));
    t.tv.finish();
    expect(rows(await rig.frame())).toEqual(['Mira › 5 * 3, f*ck *']);
    expect(spans(rig).some((sp) => (sp.attributes & TextAttributes.ITALIC) !== 0)).toBe(false);
  });

  test('a side line: asterisks held for the next character go out before it, on the text\'s line', async () => {
    rig = await chatRig({ width: 60, height: 12 });
    const t = turn(rig);
    const tool = [
      ev({ type: 'tool', turnId: 't1', callId: 'c1', name: 'roll', phase: 'start', args: {} }),
      ev({ type: 'tool', turnId: 't1', callId: 'c1', name: 'roll', phase: 'done', ok: true, summary: '4' }),
    ];
    t.push(start(), ...textEvents('t1', ['She is **very** sure *']), ...tool, ...textEvents('t1', ['\nMore.'], 'text', 22));
    const f = rows(await rig.frame());
    expect(f[0]).toBe('Mira › She is very sure *');
    expect(f.slice(1).join('\n')).not.toContain('*');
    expect(looks(rig, 'very')[0]!.bold).toBe(true);
  });

  test('a continue: the addition\'s **bold** is bold; the asterisk the text before ends with is not drawn again', async () => {
    rig = await chatRig({ width: 70, height: 10 });
    const before = 'She *waves*';
    const t = turn(rig, { continueFrom: before });
    t.push(start('continue'), ...textEvents('t1', [' Then **', 'runs**.']));
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', `${before} Then **runs**.`) }));
    t.tv.finish();
    expect(rows(await rig.frame())).toEqual(['Mira › …She waves Then runs.']);
    expect(looks(rig, 'runs')[0]!.bold).toBe(true);
    expect(looks(rig, ' Then ')[0]!.italic).toBe(false);
    // The repaint path builds the same from the stored text.
    expect(proseChunks(' Then **runs**.', THEME, false, before).map((c) => c.text).join('')).toBe(' Then runs.');
  });

  test('a continue\'s `…last words` show the text as the chat does (** and * dropped)', async () => {
    rig = await chatRig({ width: 70, height: 10 });
    const before = 'She is **very** tired. *She yawns.*';
    const t = turn(rig, { continueFrom: before });
    t.push(start('continue'), ...textEvents('t1', [' Then sleeps.']));
    expect(rows(await rig.frame())).toEqual(['Mira › …She is very tired. She yawns. Then sleeps.']);
  });

  test('a continue inside an action: the addition italic, its closing * dropped; the card it continues is repainted without asterisks', async () => {
    rig = await chatRig({ width: 70, height: 10 });
    const before = '*She walks to the ';
    rig.t.card(msg('a1', 'assistant', before, { finish: 'stopped' }), NAMES);
    const t = turn(rig, { continueFrom: before });
    t.push(start('continue'), ...textEvents('t1', ['door.', '* "Hi."']));
    t.push(ev({ type: 'done', turnId: 't1', message: msg('a1', 'assistant', `${before}door.* "Hi."`) }));
    t.tv.finish();
    expect(rows(await rig.frame())).toEqual(['Mira › She walks to the door. "Hi."', 'Mira › …She walks to the door. "Hi."']);
    expect(looks(rig, 'door.').map((x) => x.italic)).toEqual([true, true]);
    expect(looks(rig, '"Hi."').map((x) => x.italic)).toEqual([false, false]);
  });
});

// ---- selection --------------------------------------------------------------------------------------------

/** Select from the start of `from` to `cols` cells into `to` (OpenTUI's own selection, as a mouse drag makes it). */
async function select(r: ChatRig, from: TextRenderable, to: TextRenderable, cols: number): Promise<CapturedSpan[]> {
  const renderer = r.setup.renderer;
  renderer.startSelection(from, from.x, from.y);
  renderer.updateSelection(to, to.x + cols, to.y);
  await r.frame();
  return spans(r).filter((s) => s.bg.intent !== 'rgb' || s.bg.toInts()[3] !== 0);
}

describe('OpenTUI\'s selection on the transcript (T-17)', () => {
  for (const [name, theme] of [['colour', THEME], ['NO_COLOR', MONO_THEME]] as [string, Theme][]) {
    test(`${name}: selected text is the default foreground on palette 8 (a card, a status row, a system row)`, async () => {
      rig = await chatRig({ width: 50, height: 12, theme });
      const m = msg('a1', 'assistant', 'She is **very** tired. *She yawns.*');
      rig.t.card(m, NAMES);
      rig.t.status(style.dim('  [swipe 1/1 · end]'));
      rig.t.system(style.yellow('! a notice'));
      await rig.frame();
      const nodes = rig.ui.transcript.content.getChildren() as TextRenderable[];
      expect(nodes.length).toBe(3);
      const selected = await select(rig, nodes[0]!, nodes[2]!, 5);
      expect(selected.map((s) => s.text).join('|')).toContain('Mira');
      expect(selected.map((s) => s.text).join('|')).toContain('swipe');
      expect(selected.map((s) => s.text).join('|')).toContain('! a n');
      for (const s of selected) {
        expect([s.text, s.bg.intent, s.bg.slot]).toEqual([s.text, 'indexed', 8]);
        expect([s.text, s.fg.intent]).toEqual([s.text, 'default']);
      }
      expect(rig.setup.renderer.getSelection()?.getSelectedText()).toContain('She is very tired.');
    });
  }

  test('every transcript renderable carries the colours: cards, rows, archive blocks, the `earlier messages` row', async () => {
    rig = await chatRig({ width: 50, height: 12 });
    const path = Array.from({ length: LAYOUT.liveCards + HISTORY_BATCH + 4 }, (_, k) => msg(`m${k}`, k % 2 ? 'assistant' : 'user', `line ${k}`));
    rig.t.showPath(path, NAMES, () => null);
    rig.t.system('a row');
    const nodes = rig.ui.transcript.content.getChildren() as TextRenderable[];
    expect(nodes.length).toBeGreaterThan(LAYOUT.liveCards);
    const want = selectionColours(THEME);
    expect(want.selectionBg.intent).toBe('indexed');
    expect(want.selectionBg.slot).toBe(8);
    expect(want.selectionFg.equals(THEME.text)).toBe(true);
    for (const n of nodes) {
      expect(n.selectionBg?.equals(want.selectionBg)).toBe(true);
      expect(n.selectionFg?.equals(want.selectionFg)).toBe(true);
    }
    expect((nodes[0]!.plainText)).toContain('earlier messages');
  });

  test('a live turn\'s card too', async () => {
    rig = await chatRig({ width: 50, height: 12 });
    const t = turn(rig);
    t.push(start(), ...textEvents('t1', ['Streaming now']));
    await rig.frame();
    const node = (rig.ui.transcript.content.getChildren() as TextRenderable[])[0]!;
    const selected = await select(rig, node, node, 8);
    expect(selected.map((s) => s.text).join('')).toBe('Mira › St');
    for (const s of selected) expect([s.bg.slot, s.fg.intent]).toEqual([8, 'default']);
  });
});

// ---- /help ------------------------------------------------------------------------------------------------

describe('/help in the TUI (T-17)', () => {
  function view(keysShown: (() => boolean) | undefined) {
    const sys: string[] = [];
    const transcript: TranscriptApi = {
      showPath: () => {},
      card: () => {},
      system: (s) => sys.push(s),
      echo: () => {},
      status: () => {},
      turn: () => ({ push: () => {}, finish: () => {}, interject: () => {}, kept: false }),
      scroll: () => {},
      lastCardId: () => null,
    };
    const ctx = { style: makeStyle(false), bannerInfo: () => { throw new Error('not here'); } } as unknown as ReplViewContext;
    const v = new TuiView({
      ctx,
      transcript,
      models: { update: () => {} },
      agents: { event: () => {}, refresh: () => {}, reset: () => {} },
      prices: {},
      extra: () => ({ newlineKey: 'Alt+Enter', mouse: true }),
      status: () => {},
      log: () => {},
      ...(keysShown ? { keysShown } : {}),
    });
    return { v, sys };
  }

  test('the left pane hidden: the Repl\'s help, then the TUI note and every key row', () => {
    const { v, sys } = view(() => false);
    v.line(helpText());
    expect(sys[0]).toBe(helpText());
    const rest = sys.slice(1);
    expect(rest[0]).toContain('In the TUI: /e and Ctrl+E edit in the input box');
    expect(rest.join('\n')).not.toContain('on the left');
    const keys = keyRows({ newlineKey: 'Alt+Enter', mouse: true });
    expect(rest.length).toBe(1 + keys.length);
    keys.forEach(([label, description], k) => expect(rest[1 + k]).toMatch(new RegExp(`^ {2}${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} +${description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)));
    expect(rest.join('\n')).toContain('mouse: on');
  });

  test('the left pane shown (or the host does not say): one note that points at it', () => {
    for (const keysShown of [() => true, undefined]) {
      const { v, sys } = view(keysShown);
      v.line(helpText());
      expect(sys.slice(1)).toHaveLength(1);
      expect(sys[1]).toContain('listed on the left');
    }
  });

  test('end to end: at 100 columns (no left pane) /help lists the keys in the chat; at 130 it points left until F2 hides the panes', async () => {
    tui = await tuiRig(calls(), { width: 100, height: 60 });
    await tui.until('Hello, Levi');
    await tui.send('/help');
    let f = await tui.until('Ctrl+R');
    expect(f).toContain('guided reroll');
    expect(f).not.toContain('listed on the left');
    await tui.close();
    tui = await tuiRig(calls(), { width: 130, height: 60 });
    await tui.until('Hello, Levi');
    await tui.send('/help');
    f = await tui.until('listed on the left');
    // The chat column (between the two side panes) has no key rows; only the Models pane lists them.
    const chat = f.split('\n').map((r) => [...r].slice(LAYOUT.left, 130 - LAYOUT.right).join(''));
    expect(chat.join('\n')).not.toMatch(/Ctrl\+R +swipe/);
    await tui.setup.mockInput.pressKeys(['F2']);
    await tui.gone('Agents');
    await tui.send('/help');
    f = await tui.until('Ctrl+R');
    expect(f).toMatch(/Ctrl\+R +swipe/);
  }, 30_000);
});

