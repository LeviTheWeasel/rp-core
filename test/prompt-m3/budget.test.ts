// M3 budget (§11, decisions C2, D-93): the core block and, for native tools, the declarations are
// part of the fixed prompt (never trimmed); the tool room toolRoom(window, reserve) is kept free by
// trimming more history; context_length_exceeded only when the mandatory part with the core block
// cannot fit (the room shrinks first, then the greeting goes). SPECS are the history tools, so the
// fixed part also reserves the gap note at its widest and the reminder (D-96, GAP_TOK).
import { describe, expect, test } from 'bun:test';
import { CORE_TOOLS_SRC, GAP_SRC, REMIND_SRC } from '../../src/prompt/assemble.ts';
import { remindMsg, widestGapMsgs } from '../../src/prompt/assemble/gap.ts';
import { TOOL_SHARE, toolRoom } from '../../src/prompt/budget.ts';
import { CHARS_COUNTER, charsEstimate, estimateMessage, estimateToolSpecs, O200K_COUNTER } from '../../src/prompt/tokens.ts';
import type { PromptMsg } from '../../src/providers/types.ts';
import { renderCoreBlock } from '../../src/tools/prompted.ts';
import { CAPS, chain, longChat, msg, okOf, RICH, run, runOk, SPECS, tokensIn } from './fixtures.ts';

const PROMPTED = { ...CAPS, tools: 'prompted' as const };
const coreMsg = (transport: 'native' | 'prompted'): PromptMsg => ({
  role: 'system',
  blocks: [{ k: 'text', text: renderCoreBlock(SPECS, transport) }],
  src: CORE_TOOLS_SRC,
  placement: 'head',
});
/** What the tools add to the fixed part, CHARS_COUNTER, factor 1. */
const NATIVE_TOK = estimateMessage(coreMsg('native'), CHARS_COUNTER) + estimateToolSpecs(SPECS, CHARS_COUNTER);
const PROMPTED_TOK = estimateMessage(coreMsg('prompted'), CHARS_COUNTER);
/**
 * D-96: what the history tools add to the fixed part on a path of `n` messages: the widest gap note
 * (both numbers as wide as n) and the reminder in the transport's variant (prompted: the longer one
 * that shows the call, D-96 amended), CHARS_COUNTER, factor 1.
 */
const GAP_TOK = (n: number, transport: 'native' | 'prompted' = 'native'): number =>
  Math.max(...widestGapMsgs(n).map((m) => estimateMessage(m, CHARS_COUNTER))) + estimateMessage(remindMsg(transport), CHARS_COUNTER);
/** base()'s chat (longChat(3)): 6 messages, one digit. */
const BASE_GAP = GAP_TOK(6);
const BASE_GAP_PROMPTED = GAP_TOK(6, 'prompted');
/** Not a chat message: the core block and the D-96 notes. */
const notChat = (m: PromptMsg): boolean => m.src !== CORE_TOOLS_SRC && m.src !== GAP_SRC && m.src !== REMIND_SRC;
/** The greeting 'Hello, traveller.' as a history message. */
const GREETING_TOK = estimateMessage({ role: 'assistant', blocks: [{ k: 'text', text: 'Hello, traveller.' }], src: 'history' }, CHARS_COUNTER);

/** The mandatory part's size as the refusal names it (window 1: nothing fits). */
function need(over: Parameters<typeof run>[0] = {}): number {
  const r = run({ window: 1, reserve: 0, ...over });
  if (r.ok) throw new Error('expected a refusal');
  return tokensIn(r.message);
}

describe('estimateToolSpecs', () => {
  test('the declarations as the openai-chat wire carries them, counted like text', () => {
    expect(estimateToolSpecs([], CHARS_COUNTER)).toBe(0);
    const wire = SPECS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
    expect(estimateToolSpecs(SPECS, CHARS_COUNTER)).toBe(charsEstimate(JSON.stringify(wire)));
    expect(estimateToolSpecs(SPECS, O200K_COUNTER)).toBeGreaterThan(50);
    expect(estimateToolSpecs(SPECS.slice(0, 1), CHARS_COUNTER)).toBeLessThan(estimateToolSpecs(SPECS, CHARS_COUNTER));
  });
});

describe('the fixed part', () => {
  test('counts the core block, and the declarations for native tools only', () => {
    const none = need();
    expect(need({ tools: SPECS })).toBe(none + NATIVE_TOK + BASE_GAP);
    expect(need({ tools: SPECS, caps: PROMPTED })).toBe(none + PROMPTED_TOK + BASE_GAP_PROMPTED);
    expect(NATIVE_TOK).toBeGreaterThan(estimateMessage(coreMsg('native'), CHARS_COUNTER));
  });

  test('scaled by the EMA factor like the rest of the fixed part', () => {
    expect(need({ tools: SPECS, tokenFactor: 1.5 })).toBeGreaterThan(need({ tokenFactor: 1.5 }) + NATIVE_TOK);
  });

  test('the refusal names the tool instructions', () => {
    const r = run({ window: 1, reserve: 0, tools: SPECS });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('context_length_exceeded');
      expect(r.message).toContain(`the tool instructions ${NATIVE_TOK + BASE_GAP}`);
    }
    const plain = run({ window: 1, reserve: 0 });
    if (!plain.ok) expect(plain.message).not.toContain('tool instructions');
  });

  test('context_length_exceeded when the mandatory part fits alone but not with the core block', () => {
    const window = need() + 5; // greeting left out, nothing else droppable kept
    const plain = okOf(run({ window, reserve: 0 }));
    expect(plain.notices.map((n) => n.code)).toContain('greeting_dropped');
    const r = run({ window, reserve: 0, tools: SPECS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('context_length_exceeded');
    // Each transport is refused exactly below its own mandatory size: the prompted catalog is the
    // longer text here, the native protocol plus its declarations the shorter.
    expect(NATIVE_TOK).toBeLessThan(PROMPTED_TOK);
    const between = need() + NATIVE_TOK + BASE_GAP;
    expect(run({ window: between, reserve: 0, tools: SPECS }).ok).toBe(true);
    expect(run({ window: between - 1, reserve: 0, tools: SPECS }).ok).toBe(false);
    expect(run({ window: between, reserve: 0, tools: SPECS, caps: PROMPTED }).ok).toBe(false);
    expect(run({ window: need() + PROMPTED_TOK + BASE_GAP_PROMPTED, reserve: 0, tools: SPECS, caps: PROMPTED }).ok).toBe(true);
    expect(run({ window: need() + PROMPTED_TOK + BASE_GAP_PROMPTED - 1, reserve: 0, tools: SPECS, caps: PROMPTED }).ok).toBe(false);
  });
});

describe('the tool room [D-93]', () => {
  const view = chain(longChat(40));

  test('toolRoom = round(0.25 × (window − reserve)); 0 without tools', () => {
    expect(TOOL_SHARE).toBe(0.25);
    expect(runOk({ tools: SPECS }).toolRoom).toBe(toolRoom(32768, 8192));
    expect(toolRoom(32768, 8192)).toBe(6144);
    expect(runOk().toolRoom).toBe(0);
    expect(runOk({ tools: SPECS, window: 10001, reserve: 1 }).toolRoom).toBe(2500);
  });

  test('a history that fits whole without tools is trimmed to leave the room', () => {
    const all = okOf(run({ view, window: 1_000_000, reserve: 0 }));
    const window = all.trace.tokens.estimated + 10; // everything fits, 10 tokens to spare
    const plain = okOf(run({ view, window, reserve: 0 }));
    expect(plain.trace.trimmed).toBeNull();
    const r = okOf(run({ view, window, reserve: 0, tools: SPECS }));
    expect(r.trace.trimmed).not.toBeNull();
    expect(r.toolRoom).toBe(toolRoom(window, 0));
    // What is sent (messages + declarations) leaves the room free.
    expect(r.trace.tokens.estimated + estimateToolSpecs(SPECS, CHARS_COUNTER)).toBeLessThanOrEqual(window - r.toolRoom);
  });

  test('the history gets exactly window − reserve − fixed − room: the same cut as a tool-less request in that much less window', () => {
    for (const [window, reserve] of [
      [4000, 500],
      [6000, 1000],
      [3000, 0],
    ] as const) {
      for (const caps of [CAPS, PROMPTED]) {
        const r = okOf(run({ view, window, reserve, tools: SPECS, caps }));
        const extra = caps.tools === 'native' ? NATIVE_TOK + GAP_TOK(view.path.length) : PROMPTED_TOK + GAP_TOK(view.path.length, 'prompted');
        const same = okOf(run({ view, window: window - r.toolRoom - extra, reserve, caps }));
        expect(r.trace.trimmed).toEqual(same.trace.trimmed);
        expect(r.kept).toEqual(same.kept);
        expect(r.messages.filter(notChat)).toEqual(same.messages);
      }
    }
  });

  test('more room, more trimming: tools never keep more history than the tool-less request', () => {
    for (const window of [2500, 3500, 5000, 8000]) {
      const plain = okOf(run({ view, window, reserve: 500 }));
      const r = okOf(run({ view, window, reserve: 500, tools: SPECS }));
      expect(r.kept.length).toBeLessThanOrEqual(plain.kept.length);
    }
  });

  test('a room the protected part cannot leave whole shrinks: every droppable message goes, the greeting stays', () => {
    const fixedTools = need({ view, tools: SPECS }); // fixed + core + declarations + the last user message
    const window = fixedTools + GREETING_TOK + 20;
    const r = okOf(run({ view, window, reserve: 0, tools: SPECS }));
    expect(r.toolRoom).toBe(20);
    expect(r.toolRoom).toBeLessThan(toolRoom(window, 0));
    expect(r.kept).toEqual(['g', 'u40']);
    expect(r.trace.trimmed).toEqual({ from: 'u1', to: 'a39' });
    expect(r.notices.map((n) => n.code)).not.toContain('greeting_dropped');
  });

  test('the greeting goes only when nothing is left for it: the room is then what remains', () => {
    const fixedTools = need({ view, tools: SPECS });
    const window = fixedTools + GREETING_TOK - 1;
    const r = okOf(run({ view, window, reserve: 0, tools: SPECS }));
    expect(r.kept).toEqual(['u40']);
    expect(r.toolRoom).toBe(GREETING_TOK - 1);
    expect(r.notices.map((n) => n.code)).toContain('greeting_dropped');
    expect(r.trace.trimmed).toEqual({ from: 'g', to: 'a39' });
  });

  test('exactly the mandatory part with the core block: room 0, still sent', () => {
    const fixedTools = need({ view, tools: SPECS });
    const r = okOf(run({ view, window: fixedTools, reserve: 0, tools: SPECS }));
    expect(r.toolRoom).toBe(0);
    expect(r.kept).toEqual(['u40']);
    expect(run({ view, window: fixedTools - 1, reserve: 0, tools: SPECS }).ok).toBe(false);
  });

  test('maxMessages still applies with tools (same grid, same protections)', () => {
    const r = okOf(run({ view, tools: SPECS, preset: { ...RICH, prefill: undefined, context: { maxMessages: 5 } } }));
    expect(r.kept.length).toBeLessThanOrEqual(5);
    expect(r.kept[0]).toBe('g');
    expect(r.kept.at(-1)).toBe('u40');
  });

  test("D-28 'prefill': no core block, no room", () => {
    const r = okOf(run({ view, preset: RICH, tools: SPECS, window: 4000, reserve: 500 }));
    expect(r.toolRoom).toBe(0);
    expect(r.tools).toEqual([]);
    const plain = okOf(run({ view, preset: RICH, window: 4000, reserve: 500 }));
    expect(r.trace.trimmed).toEqual(plain.trace.trimmed);
    expect(r.kept).toEqual(plain.kept);
  });

  test('a one-off long user message: the room is what it leaves, history all gone, the request still goes', () => {
    const big = chain([...longChat(3).slice(0, -1), msg('u3', 'user', 'x'.repeat(3000))]);
    const fixedTools = need({ view: big, tools: SPECS });
    const r = okOf(run({ view: big, window: fixedTools + GREETING_TOK + 300, reserve: 0, tools: SPECS }));
    expect(r.toolRoom).toBe(300);
    expect(r.kept).toEqual(['g', 'u3']);
  });
});
