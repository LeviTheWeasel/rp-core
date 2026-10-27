// D-96 (.notes/m3-decisions.md): the gap note and the tool reminder. When the offered tools hold the
// history tools and the history sent leaves out a run of messages, the request carries a system
// message `core:gap` right before the first chat message sent after the run, naming it in the
// history tools' numbering (path positions from 1, the greeting #1, hidden messages counted), and a
// system message `core:remind` after every depth-0 insert. Both are fixed: reserved at their widest
// before the cut, never trimmed. Neither exists without tools, with only the lore tools, or on a
// continue; depth inserts keep counting chat messages only; the tool room and `kept` are unchanged.
import { describe, expect, test } from 'bun:test';
import type { AssembleInput } from '../../src/prompt/assemble.ts';
import { CORE_TOOLS_SRC, GAP_SRC, gapText, HISTORY_SRC, REMIND_SRC, REMIND_TEXT } from '../../src/prompt/assemble.ts';
import { gapMsg, HISTORY_TOOL_NAMES, offersHistoryTools, remindMsg, widestGapMsgs } from '../../src/prompt/assemble/gap.ts';
import { toolRoom } from '../../src/prompt/budget.ts';
import { shape, SYSTEM_NOTE_PREFIX } from '../../src/prompt/shape.ts';
import { CHARS_COUNTER, estimateMessage, estimateToolSpecs, O200K_COUNTER, type TokenCounter } from '../../src/prompt/tokens.ts';
import type { PromptMsg, ToolSpec } from '../../src/providers/types.ts';
import type { MessageView, PathView } from '../../src/session/view.ts';
import { HISTORY_TOOLS, LORE_TOOLS, toolSpecs } from '../../src/tools/builtin/index.ts';
import { searchHistory } from '../../src/tools/builtin/history.ts';
import { CAPS, chain, longChat, msg, okOf, RICH, run, runOk, SPECS, srcs, textOf, tokensIn, type Ok } from './fixtures.ts';

const PROMPTED = { ...CAPS, tools: 'prompted' as const };
/** Specs named like the lore tools: never a gap note. */
const LORE_SPECS: ToolSpec[] = SPECS.map((s, i) => ({ ...s, name: i === 0 ? 'read_lore' : 'search_lore' }));

/** Path position (#n of the history tools) of a message id. */
const posOf = (view: PathView, id: string): number => view.path.findIndex((m) => m.id === id) + 1;
const hide = (ms: MessageView[], ids: readonly string[]): MessageView[] => ms.map((m) => (ids.includes(m.id) ? { ...m, hidden: true } : m));
const notChat = (m: PromptMsg): boolean => m.src !== CORE_TOOLS_SRC && m.src !== GAP_SRC && m.src !== REMIND_SRC;
const gapsOf = (r: Ok): PromptMsg[] => r.messages.filter((m) => m.src === GAP_SRC);
const remindsOf = (r: Ok): PromptMsg[] => r.messages.filter((m) => m.src === REMIND_SRC);
/** Index of the chat message (src history) whose text starts with `head`. */
const chatAt = (r: Ok, head: string): number => r.messages.findIndex((m) => m.src === HISTORY_SRC && textOf(m).startsWith(head));

/** The mandatory part's size as the refusal names it (window 1: nothing fits). */
function need(over: Partial<AssembleInput> = {}): number {
  const r = run({ ...over, window: 1, reserve: 0 });
  if (r.ok) throw new Error('expected a refusal');
  return tokensIn(r.message);
}

/** 80 messages: g (#1), u1 (#2), a1 (#3), … a39 (#79), u40 (#80). Window 4000 / 500 trims u1..a16 (#2–#33). */
const VIEW = chain(longChat(40));
const TRIM = { view: VIEW, window: 4000, reserve: 500, tools: SPECS } as const;

describe('the texts', () => {
  test('range with an en dash, singular when A = B; the reminder; the sources', () => {
    expect(gapText(2, 161)).toBe(
      '[Messages #2–#161 of this chat are not shown here. search_history finds what was said in them; read_history shows them in full.]',
    );
    expect(gapText(5, 5)).toBe('[Message #5 of this chat is not shown here. search_history finds what was said in it; read_history shows it in full.]');
    expect(REMIND_TEXT).toBe(
      '(Part of this chat is hidden from you. If your reply depends on a detail from it — a name, a place, a promise, who said what — look it up with search_history before you write. If it does not, just write the reply.)',
    );
    expect([GAP_SRC, REMIND_SRC]).toEqual(['core:gap', 'core:remind']);
    expect(gapMsg(2, 3)).toEqual({ role: 'system', blocks: [{ k: 'text', text: gapText(2, 3) }], src: 'core:gap', placement: 'inline' });
    expect(remindMsg('native')).toEqual({ role: 'system', blocks: [{ k: 'text', text: REMIND_TEXT }], src: 'core:remind', placement: 'inline' });
  });

  test('the history tools are the builtins: both must be offered', () => {
    expect([...HISTORY_TOOL_NAMES].sort() as string[]).toEqual(HISTORY_TOOLS().map((t) => t.name).sort());
    expect(offersHistoryTools(toolSpecs(HISTORY_TOOLS()))).toBe(true);
    expect(offersHistoryTools(toolSpecs([...HISTORY_TOOLS(), ...LORE_TOOLS()]))).toBe(true);
    expect(offersHistoryTools(toolSpecs(LORE_TOOLS()))).toBe(false);
    expect(offersHistoryTools(SPECS.filter((s) => s.name === 'search_history'))).toBe(false);
    expect(offersHistoryTools([])).toBe(false);
  });

  test('the widest note: both numbers as wide as the path length, never narrower than a real one', () => {
    expect(widestGapMsgs(9).map(textOf)).toEqual([
      '[Messages #9\u2013#9 of this chat are not shown here. search_history finds what was said in them; read_history shows them in full.]',
      gapText(9, 9),
    ]);
    expect(textOf(widestGapMsgs(10)[0]!)).toContain('#99–#99 ');
    expect(textOf(widestGapMsgs(201)[0]!)).toContain('#999–#999 ');
    expect(textOf(widestGapMsgs(1000)[1]!)).toContain('#9999 ');
    const most = (n: number, c: TokenCounter): number => Math.max(...widestGapMsgs(n).map((m) => estimateMessage(m, c)));
    for (const c of [CHARS_COUNTER, O200K_COUNTER]) {
      for (const n of [1, 9, 10, 99, 100, 201, 999, 1000, 12_345]) {
        const top = most(n, c);
        for (const [a, b] of [
          [1, n],
          [2, n],
          [n, n],
          [1, 1],
          [Math.ceil(n / 2), n],
          [Math.max(1, n - 1), n],
          [10 ** (String(n).length - 1), n],
        ] as const) {
          if (a <= b) expect(estimateMessage(gapMsg(a, b), c)).toBeLessThanOrEqual(top);
        }
      }
    }
  });
});

describe('the gap note', () => {
  test('right after the greeting, right before the first message kept after the run, numbered #2–#33', () => {
    const r = runOk(TRIM);
    expect(r.trace.trimmed).toEqual({ from: 'u1', to: 'a16' });
    expect(gapsOf(r)).toHaveLength(1);
    const at = r.messages.indexOf(gapsOf(r)[0]!);
    expect(r.messages[at]).toEqual(gapMsg(2, 33));
    expect(textOf(r.messages[at]!)).toBe(gapText(2, 33));
    expect(r.messages[at - 1]).toMatchObject({ src: HISTORY_SRC, role: 'assistant' });
    expect(textOf(r.messages[at - 1]!)).toBe('Hello, traveller.');
    expect(at).toBe(chatAt(r, 'U17:') - 1);
    expect(srcs(r.messages).slice(at - 2, at + 2)).toEqual([CORE_TOOLS_SRC, HISTORY_SRC, GAP_SRC, HISTORY_SRC]);
  });

  test('the numbers are the history tools\' numbers (search_history finds #2 and #33 there)', () => {
    const r = runOk(TRIM);
    const names = { char: 'Mira', user: 'Levi' };
    const first = searchHistory(VIEW, 'u40', 'U1', { names }).hits.map((h) => h.n);
    const last = searchHistory(VIEW, 'u40', 'A16', { names }).hits.map((h) => h.n);
    expect([first, last]).toEqual([[2], [33]]);
    expect(textOf(gapsOf(r)[0]!)).toBe(gapText(first[0]!, last[0]!));
    expect(posOf(VIEW, r.trace.trimmed!.from)).toBe(2);
    expect(posOf(VIEW, r.trace.trimmed!.to)).toBe(33);
  });

  test('hidden messages inside the range stay inside it: #2–#27 covers 24 sent-able messages and 2 hidden ones', () => {
    const view = chain(hide(longChat(40), ['a5', 'u6']));
    const r = runOk({ ...TRIM, view });
    expect(r.trace.trimmed).toEqual({ from: 'u1', to: 'a13' });
    expect(textOf(gapsOf(r)[0]!)).toBe(gapText(2, 27));
    expect(r.messages.indexOf(gapsOf(r)[0]!)).toBe(chatAt(r, 'U14:') - 1);
  });

  test('a hidden message at the edge of the range is outside it (the run is the trimmed chat messages)', () => {
    // u1 (#2) hidden: the run starts at a1 (#3). u17 (#34) hidden: the run ends at a16 (#33), A17 (#35) follows.
    const head = runOk({ ...TRIM, view: chain(hide(longChat(40), ['u1'])) });
    expect(head.trace.trimmed!.from).toBe('a1');
    expect(textOf(gapsOf(head)[0]!)).toBe(gapText(3, 34));
    const tail = runOk({ ...TRIM, view: chain(hide(longChat(40), ['u17'])) });
    expect(tail.trace.trimmed).toEqual({ from: 'u1', to: 'a16' });
    expect(textOf(gapsOf(tail)[0]!)).toBe(gapText(2, 33));
    expect(tail.messages.indexOf(gapsOf(tail)[0]!)).toBe(chatAt(tail, 'A17:') - 1);
  });

  test('A = B: the singular form (one long message left out, the hidden one after it not named)', () => {
    const view = chain([msg('g', 'assistant', 'Hello, traveller.', { greeting: true }), msg('u1', 'user', 'x'.repeat(3000)), msg('a1', 'assistant', 'Hidden.', { hidden: true }), msg('u2', 'user', 'U2: and now?')]);
    const window = need({ view, tools: SPECS }) + 400;
    const r = runOk({ view, window, reserve: 0, tools: SPECS });
    expect(r.trace.trimmed).toEqual({ from: 'u1', to: 'u1' });
    expect(srcs(r.messages).slice(-4)).toEqual([HISTORY_SRC, GAP_SRC, HISTORY_SRC, REMIND_SRC]);
    expect(textOf(gapsOf(r)[0]!)).toBe('[Message #2 of this chat is not shown here. search_history finds what was said in it; read_history shows it in full.]');
    expect(r.kept).toEqual(['g', 'u2']);
  });

  test('the greeting dropped: the run starts at #1 and the note opens the chat part', () => {
    const greetingTok = estimateMessage({ role: 'assistant', blocks: [{ k: 'text', text: 'Hello, traveller.' }], src: HISTORY_SRC }, CHARS_COUNTER);
    // No card depth prompt here, so nothing else is placed in front of the one chat message left.
    const cast = { character: { name: 'Mira', description: 'A cartographer.', greetings: ['Hello, traveller.'] } };
    const window = need({ view: VIEW, cast, tools: SPECS }) + greetingTok - 1;
    const r = runOk({ view: VIEW, cast, window, reserve: 0, tools: SPECS });
    expect(r.notices.map((n) => n.code)).toContain('greeting_dropped');
    expect(r.trace.trimmed).toEqual({ from: 'g', to: 'a39' });
    expect(r.kept).toEqual(['u40']);
    expect(textOf(gapsOf(r)[0]!)).toBe(gapText(1, 79));
    // The chat part: the note, the one message, the reminder; nothing of the chat before the note.
    const at = r.messages.indexOf(gapsOf(r)[0]!);
    expect(r.messages.slice(0, at).some((m) => m.src === HISTORY_SRC)).toBe(false);
    expect(srcs(r.messages).slice(at)).toEqual([GAP_SRC, HISTORY_SRC, REMIND_SRC]);
    // With the card's depth-2 prompt, which the one chat message left pushes in front of it: the note
    // still sits right before the message (depths count chat messages only, the note is not one).
    const withDepth = runOk({ view: VIEW, window: need({ view: VIEW, tools: SPECS }) + greetingTok - 1, reserve: 0, tools: SPECS });
    expect(withDepth.kept).toEqual(['u40']);
    expect(srcs(withDepth.messages).slice(-4)).toEqual(['card_depth', GAP_SRC, HISTORY_SRC, REMIND_SRC]);
    expect(textOf(gapsOf(withDepth)[0]!)).toBe(gapText(1, 79));
  });

  test('a chat without a greeting: the run starts at its first message, the note opens the chat part', () => {
    const view = chain(longChat(40).slice(1));
    const r = runOk({ ...TRIM, view });
    expect(r.trace.trimmed!.from).toBe('u1');
    const at = r.messages.indexOf(gapsOf(r)[0]!);
    expect(textOf(r.messages[at]!)).toBe(gapText(1, posOf(view, r.trace.trimmed!.to)));
    expect(r.messages.slice(0, at).some((m) => m.src === HISTORY_SRC)).toBe(false);
    expect(r.messages[at + 1]!.src).toBe(HISTORY_SRC);
  });

  test('prompted tools too; one note, one reminder', () => {
    const r = runOk({ ...TRIM, caps: PROMPTED });
    expect(gapsOf(r)).toHaveLength(1);
    expect(remindsOf(r)).toHaveLength(1);
    expect(textOf(gapsOf(r)[0]!)).toBe(gapText(2, posOf(VIEW, r.trace.trimmed!.to)));
  });
});

describe('the reminder', () => {
  test('the last message, after every depth-0 insert (author note, director, guidance)', () => {
    const r = runOk({
      ...TRIM,
      authorNote: { text: 'Note: rain.', depth: 0, role: 'system' },
      placements: [{ depth: 0, role: 'system', src: 'director', text: 'Direct the scene.' }],
      guidance: { text: 'Make it rain.' },
    });
    expect(r.messages.at(-1)).toEqual(remindMsg('native'));
    expect(srcs(r.messages).slice(-5)).toEqual([HISTORY_SRC, 'author_note', 'director', 'guidance', REMIND_SRC]);
    expect(textOf(r.messages.at(-5)!).startsWith('U40:')).toBe(true);
  });

  test('a preset with post-history blocks: the reminder stays at depth 0, before them (as any depth-0 insert)', () => {
    const r = runOk({ ...TRIM, preset: RICH, prefillVsTools: 'tools', guidance: { text: 'Make it rain.' } });
    expect(srcs(r.messages).slice(-5)).toEqual([HISTORY_SRC, 'guidance', REMIND_SRC, 'jailbreak', 'tail']);
  });
});

describe('depth inserts count chat messages only', () => {
  const inserts: Partial<AssembleInput> = {
    authorNote: { text: 'Note: rain.', depth: 3, role: 'system' },
    placements: [
      { depth: 5, role: 'system', src: 'compendium', srcId: 'x', text: 'A memory.' },
      { depth: 0, role: 'system', src: 'director', text: 'Direct the scene.' },
    ],
    guidance: { text: 'Make it rain.' },
  };

  test('the same request as the tool-less one at the same cut, with the core block and the two notes added', () => {
    for (const caps of [CAPS, PROMPTED]) {
      const r = runOk({ ...TRIM, ...inserts, caps });
      const coreTok = estimateMessage(r.messages.find((m) => m.src === CORE_TOOLS_SRC)!, CHARS_COUNTER) + (caps.tools === 'native' ? estimateToolSpecs(SPECS, CHARS_COUNTER) : 0);
      const gapTok = Math.max(...widestGapMsgs(VIEW.path.length).map((m) => estimateMessage(m, CHARS_COUNTER))) + estimateMessage(remindMsg(caps.tools === 'prompted' ? 'prompted' : 'native'), CHARS_COUNTER);
      const same = runOk({ ...TRIM, ...inserts, caps, tools: [], window: TRIM.window - r.toolRoom - coreTok - gapTok });
      expect(r.trace.trimmed).toEqual(same.trace.trimmed);
      expect(r.messages.filter(notChat)).toEqual(same.messages);
    }
  });

  test('each insert has exactly its depth in chat messages after it', () => {
    const r = runOk({ ...TRIM, ...inserts });
    const chatAfter = (src: string): number => r.messages.slice(r.messages.findIndex((m) => m.src === src) + 1).filter((m) => m.src === HISTORY_SRC).length;
    expect(chatAfter('author_note')).toBe(3);
    expect(chatAfter('compendium:x')).toBe(5);
    expect(chatAfter('card_depth')).toBe(2);
    expect(chatAfter('guidance')).toBe(0);
  });

  test('an insert as deep as the kept messages after the greeting sits between the greeting and the note', () => {
    const first = runOk(TRIM);
    const depth = first.kept.length - 1; // the messages after the greeting
    const r = runOk({ ...TRIM, authorNote: { text: 'Note: rain.', depth, role: 'system' } });
    expect(r.trace.trimmed).toEqual(first.trace.trimmed);
    const at = r.messages.indexOf(gapsOf(r)[0]!);
    expect(srcs(r.messages).slice(at - 2, at + 2)).toEqual([HISTORY_SRC, 'author_note', GAP_SRC, HISTORY_SRC]);
    expect(textOf(r.messages[at + 1]!).startsWith('U17:')).toBe(true);
  });
});

describe('budget', () => {
  test('reserved in the fixed part at the widest width: never over the window, on any window', () => {
    const view = chain(longChat(60)); // 120 messages: the reservation has three digits, the real notes fewer
    for (const counter of [CHARS_COUNTER, O200K_COUNTER]) {
      for (const tokenFactor of [1, 1.3]) {
        for (const caps of [CAPS, PROMPTED]) {
          const low = need({ view, tools: SPECS, counter, tokenFactor, caps });
          let gaps = 0;
          for (let window = low; window < low + 4000; window += counter === CHARS_COUNTER ? 37 : 151) {
            const r = run({ view, window, reserve: 0, tools: SPECS, counter, tokenFactor, caps });
            expect(r.ok).toBe(true);
            if (!r.ok) continue;
            const decl = caps.tools === 'native' ? estimateToolSpecs(SPECS, counter) : 0;
            expect((r.trace.tokens.estimated + decl) * tokenFactor).toBeLessThanOrEqual(window - r.toolRoom);
            if (gapsOf(r).length > 0) gaps++;
          }
          expect(gaps).toBeGreaterThan(5);
        }
      }
    }
  });

  test('every window from the mandatory part up, token by token: a three-digit note never pushes the request over', () => {
    // Where the cut fills the history to the last token, a reservation narrower than the real note
    // (#2–#119 here) would overflow by its missing digits.
    const view = chain(longChat(60));
    const low = need({ view, tools: SPECS });
    let wide = 0;
    for (let window = low; window < low + 1500; window++) {
      const r = okOf(run({ view, window, reserve: 0, tools: SPECS }));
      expect(r.trace.tokens.estimated + estimateToolSpecs(SPECS, CHARS_COUNTER)).toBeLessThanOrEqual(window - r.toolRoom);
      if (gapsOf(r).some((m) => /#\d{3} /.test(textOf(m)))) wide++;
    }
    expect(wide).toBeGreaterThan(100);
  });

  test('the refusal counts the reservation with the tool instructions; one token less than the mandatory part is refused', () => {
    const low = need({ ...TRIM });
    expect(low).toBeGreaterThan(need({ ...TRIM, tools: LORE_SPECS }));
    expect(run({ ...TRIM, window: low, reserve: 0 }).ok).toBe(true);
    expect(run({ ...TRIM, window: low - 1, reserve: 0 }).ok).toBe(false);
  });

  test('trace.tokens counts both, one row each; the tool room and kept are unchanged', () => {
    const r = runOk(TRIM);
    expect(r.trace.blocks.map((b) => b.src)).toEqual(srcs(r.messages));
    const rows = r.trace.blocks.filter((b) => b.src === GAP_SRC || b.src === REMIND_SRC);
    expect(rows.map((b) => b.tok)).toEqual([estimateMessage(gapsOf(r)[0]!, CHARS_COUNTER), estimateMessage(remindMsg('native'), CHARS_COUNTER)]);
    expect(r.trace.tokens.estimated).toBe(r.trace.blocks.reduce((s, b) => s + b.tok, 0));
    expect(r.toolRoom).toBe(toolRoom(4000, 500));
    expect(r.kept).toEqual(['g', ...VIEW.path.slice(33).map((m) => m.id)]);
  });
});

describe('absent', () => {
  test('without tools: the tool-less request has neither, even when trimmed', () => {
    const r = runOk({ ...TRIM, tools: [], window: 2500 });
    expect(r.trace.trimmed).not.toBeNull();
    expect(gapsOf(r)).toEqual([]);
    expect(remindsOf(r)).toEqual([]);
  });

  test('with only the lore tools: neither, and the budget is the core block alone', () => {
    const r = runOk({ ...TRIM, tools: LORE_SPECS });
    expect(r.trace.trimmed).not.toBeNull();
    expect(srcs(r.messages)).not.toContain(GAP_SRC);
    expect(srcs(r.messages)).not.toContain(REMIND_SRC);
    const one = runOk({ ...TRIM, tools: SPECS.filter((s) => s.name === 'search_history') });
    expect(srcs(one.messages).filter((s) => s.startsWith('core:'))).toEqual([CORE_TOOLS_SRC]);
  });

  test('with the history tools but nothing left out: neither (the reservation simply goes unused)', () => {
    const r = runOk({ view: VIEW, window: 1_000_000, reserve: 0, tools: SPECS });
    expect(r.trace.trimmed).toBeNull();
    expect(srcs(r.messages).filter((s) => s.startsWith('core:'))).toEqual([CORE_TOOLS_SRC]);
    expect(r.messages.filter(notChat)).toEqual(runOk({ view: VIEW, window: 1_000_000, reserve: 0 }).messages);
  });

  test('on a continue: no tools, so neither', () => {
    const view = chain([...longChat(40), msg('a40', 'assistant', 'The road', { model: { connection: 'local', model: 'm1' } })]);
    for (const caps of [CAPS, { ...CAPS, prefill: 'none' as const }]) {
      const r = runOk({ view, kind: 'continue', window: 2500, reserve: 0, tools: SPECS, caps });
      expect(r.trace.trimmed).not.toBeNull();
      expect(r.tools).toEqual([]);
      expect(srcs(r.messages).filter((s) => s.startsWith('core:'))).toEqual([]);
    }
  });

  test("D-28 'prefill' turns the tools off: neither", () => {
    const r = runOk({ ...TRIM, preset: RICH });
    expect(r.trace.prefill).toBe('tools_off');
    expect(srcs(r.messages).filter((s) => s.startsWith('core:'))).toEqual([]);
  });
});

describe('shaping: ordinary system messages', () => {
  test("'as-user': the note joins the next user message, the reminder the last one, as the author's note would", () => {
    const r = runOk(TRIM);
    const out = shape({ messages: r.messages, caps: { ...CAPS, midSystem: 'as-user' }, prefill: null, kind: 'reply' });
    const u17 = out.messages.find((m) => m.src === `${GAP_SRC}+${HISTORY_SRC}`)!;
    expect(textOf(u17).startsWith(`${SYSTEM_NOTE_PREFIX}${gapText(2, 33)}\n\nU17:`)).toBe(true);
    // After the last user message (which already took the card's depth-2 note): appended to it.
    const last = out.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.src).toBe(`card_depth+${HISTORY_SRC}+${REMIND_SRC}`);
    expect(textOf(last).endsWith(`\n\n${SYSTEM_NOTE_PREFIX}${REMIND_TEXT}`)).toBe(true);
  });

  test("'native': both stay system messages where assemble put them", () => {
    const r = runOk(TRIM);
    const out = shape({ messages: r.messages, caps: CAPS, prefill: null, kind: 'reply' });
    expect(out.messages).toEqual(r.messages);
  });
});
