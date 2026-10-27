// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// D-96 amended (.notes/m3-decisions.md section L): when the turn's transport is prompted, the
// reminder (src core:remind, same place) shows the search_history call in the core block's call
// format, on a line of its own, and says to stop after it; native tools keep the D-96 text. The block
// is pinned to the parser (one well-formed call) and to the core block's example line (same opener,
// closer, envelope keys and JSON spacing), since both live in tools/prompted.ts. The fixed budget
// reserves the variant actually sent. No tools, or only the lore tools: no reminder at all.
import { describe, expect, test } from 'bun:test';
import type { AssembleInput } from '../../src/prompt/assemble.ts';
import { CORE_TOOLS_SRC, GAP_SRC, gapText, HISTORY_SRC, REMIND_CALL, REMIND_SRC, REMIND_TEXT, REMIND_TEXT_PROMPTED, remindText } from '../../src/prompt/assemble.ts';
import { promptedCallLine, remindMsg, widestGapMsgs } from '../../src/prompt/assemble/gap.ts';
import { shape, SYSTEM_NOTE_PREFIX } from '../../src/prompt/shape.ts';
import { CHARS_COUNTER, estimateMessage, estimateToolSpecs, type TokenCounter } from '../../src/prompt/tokens.ts';
import { BUILTIN_TOOL_SETS } from '../../src/engine/request.ts';
import type { PromptMsg } from '../../src/providers/types.ts';
import { parseToolArgs } from '../../src/tools/args.ts';
import { HISTORY_TOOLS, LORE_TOOLS, toolSpecs } from '../../src/tools/builtin/index.ts';
import { parsePromptedCalls, promptedCallLine as corePromptedCallLine, renderCoreBlock } from '../../src/tools/prompted.ts';
import { calls, capsWith, LEVI, MIRA_TOOLS, rig } from '../engine-m3/kit.ts';
import { CAPS, chain, longChat, okOf, run, runOk, SPECS, srcs, textOf, tokensIn, type Ok } from './fixtures.ts';

const PROMPTED = { ...CAPS, tools: 'prompted' as const };
/** 80 messages: window 4000 / 500 trims the early chat (the gap-note tests' TRIM). */
const VIEW = chain(longChat(40));
const TRIM = { view: VIEW, window: 4000, reserve: 500, tools: SPECS } as const;
/** The built-in tools' real specs (the reminder's call must satisfy search_history's schema). */
const HISTORY_SPECS = toolSpecs(HISTORY_TOOLS());
const LORE_SPECS = toolSpecs(LORE_TOOLS());

/** The section L text, written out (the `\n` are newlines). */
const SECTION_L =
  '(Part of this chat is hidden from you. If your reply depends on a detail from it — a name, a place, a promise, who said what — look it up before you write. Write the call on a line of its own, then stop:\n' +
  '<tool_call>{"name": "search_history", "args": {"query": "one or two key words"}}</tool_call>\n' +
  'If it does not, just write the reply.)';

const remindsOf = (r: Ok): PromptMsg[] => r.messages.filter((m) => m.src === REMIND_SRC);
const callLines = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('<tool_call>'));
/** The JSON envelope between a call line's tags. */
const envelope = (line: string): Record<string, unknown> => JSON.parse(line.slice('<tool_call>'.length, -'</tool_call>'.length)) as Record<string, unknown>;
/** One envelope line: `<tool_call>{"name": "x", "args": {"k": "v"}}</tool_call>`, exactly this spacing. */
const CALL_SHAPE = /^<tool_call>\{"name": "[a-z_]+", "args": \{"[a-z_]+": "[^"]+"\}\}<\/tool_call>$/;

/** The mandatory part's size as the refusal names it (window 1: nothing fits). */
function need(over: Partial<AssembleInput> = {}): number {
  const r = run({ ...over, window: 1, reserve: 0 });
  if (r.ok) throw new Error('expected a refusal');
  return tokensIn(r.message);
}
const tok = (m: PromptMsg, c: TokenCounter = CHARS_COUNTER): number => estimateMessage(m, c);
const coreTok = (transport: 'native' | 'prompted', specs = SPECS): number =>
  tok({ role: 'system', blocks: [{ k: 'text', text: renderCoreBlock(specs, transport) }], src: CORE_TOOLS_SRC, placement: 'head' });
const widestTok = (n: number): number => Math.max(...widestGapMsgs(n).map((m) => tok(m)));

describe('the text', () => {
  test('prompted: exactly section L; native: the D-96 text, unchanged', () => {
    expect(REMIND_TEXT_PROMPTED).toBe(SECTION_L);
    expect(remindText('prompted')).toBe(SECTION_L);
    expect(remindText('native')).toBe(REMIND_TEXT);
    expect(REMIND_TEXT).toBe(
      '(Part of this chat is hidden from you. If your reply depends on a detail from it — a name, a place, a promise, who said what — look it up with search_history before you write. If it does not, just write the reply.)',
    );
    expect(REMIND_CALL).toBe('<tool_call>{"name": "search_history", "args": {"query": "one or two key words"}}</tool_call>');
    expect(remindMsg('prompted')).toEqual({ role: 'system', blocks: [{ k: 'text', text: SECTION_L }], src: 'core:remind', placement: 'inline' });
    expect(remindMsg('native')).toEqual({ role: 'system', blocks: [{ k: 'text', text: REMIND_TEXT }], src: 'core:remind', placement: 'inline' });
  });

  test('the call stands on a line of its own, between "then stop:" and "If it does not"', () => {
    const lines = REMIND_TEXT_PROMPTED.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]!.endsWith('then stop:')).toBe(true);
    expect(lines[1]).toBe(REMIND_CALL);
    expect(lines[2]!.startsWith('If it does not')).toBe(true);
  });

  test('the parser reads exactly one well-formed call from it: search_history {query: "one or two key words"}', () => {
    const blocks = parsePromptedCalls(REMIND_TEXT_PROMPTED);
    expect(blocks).toHaveLength(1);
    const [b] = blocks;
    expect(b!.name).toBe('search_history');
    expect(b!.error).toBeUndefined();
    expect(JSON.parse(b!.args)).toEqual({ query: 'one or two key words' });
    // The block's span is the call line, tags included: nothing around it is read as part of it.
    expect(REMIND_TEXT_PROMPTED.slice(b!.start, b!.end)).toBe(REMIND_CALL);
    // …and the arguments pass the real search_history schema as they are (nothing repaired).
    const spec = HISTORY_SPECS.find((s) => s.name === b!.name)!;
    expect(parseToolArgs(b!.args, spec.schema, spec.name)).toEqual({ ok: true, value: { query: 'one or two key words' }, repaired: [] });
  });

  test("the block has the shape of the core block's example line: same opener, closer, keys, spacing", () => {
    for (const specs of [SPECS, HISTORY_SPECS, [...HISTORY_SPECS, ...LORE_SPECS]]) {
      const [example, ...more] = callLines(renderCoreBlock(specs, 'prompted'));
      expect(more).toEqual([]);
      const [call, ...rest] = callLines(REMIND_TEXT_PROMPTED);
      expect(rest).toEqual([]);
      // One shape for both lines…
      expect(example).toMatch(CALL_SHAPE);
      expect(call).toMatch(CALL_SHAPE);
      // …the same envelope keys in the same order…
      expect(Object.keys(envelope(example!))).toEqual(['name', 'args']);
      expect(Object.keys(envelope(call!))).toEqual(['name', 'args']);
      // …and the reminder's builder writes the example line itself back, byte for byte, from its parts.
      const ex = envelope(example!);
      expect(promptedCallLine(ex['name'] as string, ex['args'] as Record<string, unknown>)).toBe(example!);
      expect(promptedCallLine('search_history', { query: 'one or two key words' })).toBe(call!);
    }
  });

  test('one builder for both lines: the reminder uses tools/prompted.ts promptedCallLine, the one the core block example is built with', () => {
    // Section L: "built from the same constants so the two cannot drift" — not a copy kept in step by a test.
    expect(promptedCallLine).toBe(corePromptedCallLine);
    expect(callLines(renderCoreBlock(SPECS, 'prompted'))).toEqual([corePromptedCallLine('tool_name', { argument: 'value' })]);
    expect(REMIND_CALL).toBe(corePromptedCallLine('search_history', { query: 'one or two key words' }));
  });

  test('a native core block shows no call; the native reminder neither', () => {
    expect(callLines(renderCoreBlock(SPECS, 'native'))).toEqual([]);
    expect(parsePromptedCalls(REMIND_TEXT)).toEqual([]);
  });
});

describe('the request', () => {
  test('prompted: the amended reminder closes the request (one, after the question); the gap note is unchanged', () => {
    const r = runOk({ ...TRIM, caps: PROMPTED });
    expect(r.trace.trimmed).not.toBeNull();
    expect(remindsOf(r)).toHaveLength(1);
    expect(r.messages.at(-1)).toEqual(remindMsg('prompted'));
    expect(textOf(r.messages.at(-1)!)).toBe(SECTION_L);
    expect(textOf(r.messages.at(-2)!).startsWith('U40:')).toBe(true);
    expect(r.messages.some((m) => textOf(m) === REMIND_TEXT)).toBe(false);
    const gaps = r.messages.filter((m) => m.src === GAP_SRC);
    expect(gaps).toHaveLength(1);
    const posOf = (id: string): number => VIEW.path.findIndex((m) => m.id === id) + 1;
    expect(textOf(gaps[0]!)).toBe(gapText(posOf(r.trace.trimmed!.from), posOf(r.trace.trimmed!.to)));
  });

  test('native: the D-96 text, and nothing in the request shows a call', () => {
    const r = runOk(TRIM);
    expect(remindsOf(r)).toHaveLength(1);
    expect(r.messages.at(-1)).toEqual(remindMsg('native'));
    expect(r.messages.some((m) => textOf(m).includes('<tool_call>'))).toBe(false);
  });

  test("shaped 'as-user': the prompted reminder joins the last user message, the call kept whole on its own line", () => {
    const r = runOk({ ...TRIM, caps: PROMPTED });
    const out = shape({ messages: r.messages, caps: { ...PROMPTED, midSystem: 'as-user' }, prefill: null, kind: 'reply' });
    const last = out.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.src).toBe(`card_depth+${HISTORY_SRC}+${REMIND_SRC}`);
    expect(textOf(last).endsWith(`\n\n${SYSTEM_NOTE_PREFIX}${SECTION_L}`)).toBe(true);
    expect(callLines(textOf(last))).toEqual([REMIND_CALL]);
    // 'native': it stays a system message where assemble put it.
    expect(shape({ messages: r.messages, caps: PROMPTED, prefill: null, kind: 'reply' }).messages).toEqual(r.messages);
  });

  test('through the engine (built-in tools, prompted): the request carries the amended reminder; native the old one', async () => {
    const EN = 'The caravan crawled along the dusty road while the innkeeper watched it go, remembering her brother who never came back. ';
    for (const [caps, want, src] of [
      [capsWith('prompted'), SECTION_L, REMIND_SRC],
      [capsWith('prompted', { midSystem: 'as-user' }), `${SYSTEM_NOTE_PREFIX}${SECTION_L}`, `${HISTORY_SRC}+${REMIND_SRC}`],
      [capsWith('native'), REMIND_TEXT, REMIND_SRC],
    ] as const) {
      const r = await rig(calls([{ text: 'ok' }]), { caps, toolSets: BUILTIN_TOOL_SETS });
      const s = r.engine.createSession({ character: MIRA_TOOLS, persona: LEVI, config: { window: 8192 } });
      let trimmed = 0;
      for (let i = 0; i < 24; i++) {
        s.send({ text: `${i}. ${EN.repeat(6)}`, expectedVersion: s.version() });
        const p = s.preview();
        if (!p.ok) throw new Error(p.message);
        if (p.trace.trimmed === null || !p.tools.some((t) => t.name === 'search_history')) {
          expect(p.messages.some((m) => m.src.includes(REMIND_SRC))).toBe(false);
          continue;
        }
        trimmed++;
        const last = p.messages.at(-1)!;
        expect(last.src).toBe(src);
        expect(textOf(last).endsWith(want)).toBe(true);
        expect(p.messages.filter((m) => m.src.includes(REMIND_SRC))).toHaveLength(1);
      }
      expect(trimmed).toBeGreaterThan(3);
      await r.engine.close();
    }
  });
});

describe('absent', () => {
  test('no tools: no reminder, and the prompted caps change nothing (the M2 request)', () => {
    const r = runOk({ ...TRIM, caps: PROMPTED, tools: [], window: 2500 });
    expect(r.trace.trimmed).not.toBeNull();
    expect(remindsOf(r)).toEqual([]);
    expect(r.messages.some((m) => textOf(m).includes('<tool_call>'))).toBe(false);
    expect(r.messages).toEqual(runOk({ ...TRIM, tools: [], window: 2500 }).messages);
  });

  test('only the lore tools: no reminder (prompted), the only call example is the core block', () => {
    const r = runOk({ ...TRIM, caps: PROMPTED, tools: LORE_SPECS });
    expect(r.trace.trimmed).not.toBeNull();
    expect(srcs(r.messages).filter((s) => s.startsWith('core:'))).toEqual([CORE_TOOLS_SRC]);
    expect(r.messages.filter((m) => textOf(m).includes('<tool_call>')).map((m) => m.src)).toEqual([CORE_TOOLS_SRC]);
  });
});

describe('budget: the variant actually sent', () => {
  test('the prompted reminder is the longer one', () => {
    expect(tok(remindMsg('prompted'))).toBeGreaterThan(tok(remindMsg('native')) + 20);
  });

  test('the mandatory part reserves the prompted reminder; the refusal names it; one token below is refused', () => {
    const n = VIEW.path.length;
    const plain = need({ ...TRIM, caps: PROMPTED, tools: [] });
    const tools = coreTok('prompted') + widestTok(n) + tok(remindMsg('prompted'));
    const low = plain + tools;
    expect(need({ ...TRIM, caps: PROMPTED })).toBe(low);
    const refused = run({ ...TRIM, caps: PROMPTED, window: 1, reserve: 0 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain(`the tool instructions ${tools}`);
    expect(run({ ...TRIM, caps: PROMPTED, window: low, reserve: 0 }).ok).toBe(true);
    expect(run({ ...TRIM, caps: PROMPTED, window: low - 1, reserve: 0 }).ok).toBe(false);
    // Native keeps its own (shorter) reminder in the reservation.
    const nativeTools = coreTok('native') + estimateToolSpecs(SPECS, CHARS_COUNTER) + widestTok(n) + tok(remindMsg('native'));
    expect(need(TRIM)).toBe(need({ ...TRIM, tools: [] }) + nativeTools);
  });

  test('the history gets what the prompted reminder leaves: windows where its extra tokens cut one message more', () => {
    // The cut of a tool turn is the tool-less cut in a window smaller by the room and the fixed tool
    // part. Somewhere in this scan the native reminder's size would keep a message the prompted one
    // cannot: those windows must follow the prompted size.
    const n = VIEW.path.length;
    const fixedP = coreTok('prompted') + widestTok(n) + tok(remindMsg('prompted'));
    const fixedN = coreTok('prompted') + widestTok(n) + tok(remindMsg('native'));
    let differs = 0;
    for (let window = 3000; window < 3400; window++) {
      const r = okOf(run({ ...TRIM, caps: PROMPTED, window, reserve: 0 }));
      const as = (fixed: number) => okOf(run({ ...TRIM, caps: PROMPTED, tools: [], window: window - r.toolRoom - fixed, reserve: 0 }));
      const want = as(fixedP);
      expect(r.trace.trimmed).toEqual(want.trace.trimmed);
      expect(r.kept).toEqual(want.kept);
      if (JSON.stringify(as(fixedN).trace.trimmed) !== JSON.stringify(want.trace.trimmed)) differs++;
    }
    expect(differs).toBeGreaterThan(50);
  });

  test('every window token by token: the request with the prompted reminder never goes over window − room', () => {
    const view = chain(longChat(60));
    const low = need({ view, tools: SPECS, caps: PROMPTED });
    let sent = 0;
    for (let window = low; window < low + 1500; window++) {
      const r = okOf(run({ view, window, reserve: 0, tools: SPECS, caps: PROMPTED }));
      expect(r.trace.tokens.estimated).toBeLessThanOrEqual(window - r.toolRoom);
      if (remindsOf(r).length > 0) sent++;
    }
    expect(sent).toBeGreaterThan(1000);
  });

  test('trace.tokens counts the prompted reminder as sent: its row, and the estimate is the sum of the rows', () => {
    const r = runOk({ ...TRIM, caps: PROMPTED });
    expect(r.trace.blocks.map((b) => b.src)).toEqual(srcs(r.messages));
    const row = r.trace.blocks.filter((b) => b.src === REMIND_SRC);
    expect(row.map((b) => b.tok)).toEqual([tok(remindMsg('prompted'))]);
    expect(r.trace.tokens.estimated).toBe(r.trace.blocks.reduce((s, b) => s + b.tok, 0));
  });
});
