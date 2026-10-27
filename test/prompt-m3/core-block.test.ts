// M3 core block (§8.3, decisions C2): one system message, placement 'head', src 'core:tools', right
// after the last system message of the leading run (before new_chat and the history), only when
// tools survive the prefill rule [D-28]; its text is tools/prompted.ts renderCoreBlock.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_PRESET, type Preset } from '../../src/formats/native.ts';
import { CORE_TOOLS_SRC } from '../../src/prompt/assemble.ts';
import { leadingSystemRun, shape } from '../../src/prompt/shape.ts';
import { CHARS_COUNTER, estimateMessage } from '../../src/prompt/tokens.ts';
import { renderCoreBlock } from '../../src/tools/prompted.ts';
import { CAPS, chain, coreAt, longChat, LORE, msg, RICH, runOk, SPECS, srcs, textOf } from './fixtures.ts';

const PROMPTED = { ...CAPS, tools: 'prompted' as const };

describe('presence', () => {
  test('absent without tools, present with them', () => {
    expect(coreAt(runOk().messages)).toBe(-1);
    expect(coreAt(runOk({ tools: SPECS }).messages)).toBeGreaterThanOrEqual(0);
  });

  test('one system message, placement head, src core:tools, offered tools returned', () => {
    const r = runOk({ tools: SPECS });
    const cores = r.messages.filter((m) => m.src === CORE_TOOLS_SRC);
    expect(cores).toHaveLength(1);
    expect(cores[0]).toEqual({ role: 'system', blocks: [{ k: 'text', text: renderCoreBlock(SPECS, 'native') }], src: 'core:tools', placement: 'head' });
    expect(r.tools).toEqual(SPECS);
    expect(CORE_TOOLS_SRC).toBe('core:tools');
  });

  test('native: the protocol only; prompted: protocol, how to call, the catalog', () => {
    const native = textOf(runOk({ tools: SPECS }).messages.find((m) => m.src === CORE_TOOLS_SRC)!);
    const prompted = textOf(runOk({ tools: SPECS, caps: PROMPTED }).messages.find((m) => m.src === CORE_TOOLS_SRC)!);
    expect(native).toBe(renderCoreBlock(SPECS, 'native'));
    expect(prompted).toBe(renderCoreBlock(SPECS, 'prompted'));
    expect(prompted.startsWith(native)).toBe(true);
    expect(native).not.toContain('<tool_call>');
    expect(prompted).toContain('<tool_call>');
    expect(prompted).toContain('### `search_history`');
    expect(prompted).toContain('### `read_history`');
  });

  test('deterministic and independent of the chat: the same tools give the same block', () => {
    const a = runOk({ tools: SPECS });
    const b = runOk({ tools: SPECS, seed: 7, now: '2027-01-01T00:00:00.000Z' });
    expect(a.messages[coreAt(a.messages)]).toEqual(b.messages[coreAt(b.messages)]!);
    expect(runOk({ tools: SPECS })).toEqual(a);
  });

  test("D-28 'prefill' turns the tools off: no core block; 'tools' keeps it and skips the prefill", () => {
    const off = runOk({ preset: RICH, tools: SPECS });
    expect(coreAt(off.messages)).toBe(-1);
    expect(off.trace.prefill).toBe('tools_off');
    const on = runOk({ preset: RICH, tools: SPECS, prefillVsTools: 'tools' });
    expect(coreAt(on.messages)).toBeGreaterThanOrEqual(0);
    expect(on.prefill).toBeNull();
    expect(on.trace.prefill).toBe('skipped_for_tools');
    expect(on.notices.map((n) => n.code)).toContain('prefill_skipped_for_tools');
  });

  test('a model without assistant prefill keeps the tools (the prefill was not sendable anyway)', () => {
    const r = runOk({ preset: RICH, tools: SPECS, caps: { ...CAPS, prefill: 'none' } });
    expect(coreAt(r.messages)).toBeGreaterThanOrEqual(0);
    expect(r.trace.prefill).toBe('unsupported');
  });

  test('continue never carries the core block', () => {
    const view = chain([...longChat(2), msg('a2', 'assistant', 'The road', { model: { connection: 'local', model: 'm1' } })]);
    const r = runOk({ view, kind: 'continue', tools: SPECS });
    expect(coreAt(r.messages)).toBe(-1);
    expect(r.tools).toEqual([]);
    expect(r.toolRoom).toBe(0);
  });
});

describe('placement', () => {
  test('builtin preset: after the last leading system block, right before the history', () => {
    const r = runOk({ tools: SPECS });
    const at = coreAt(r.messages);
    expect(srcs(r.messages).slice(0, at + 2)).toEqual(['main', 'description', 'personality', 'scenario', 'persona', 'core:tools', 'history']);
    expect(leadingSystemRun(r.messages)).toBe(at + 1);
    expect(r.messages.slice(0, at + 1).every((m) => m.placement === 'head')).toBe(true);
    expect(r.messages[at + 1]!.placement).toBeUndefined(); // history stays as it was
  });

  test('with top blocks and top lore: after the leading system run, before a user block, a later system block, new_chat and history', () => {
    const r = runOk({ preset: RICH, lorebooks: LORE, tools: SPECS, prefillVsTools: 'tools' });
    expect(srcs(r.messages).slice(0, 9)).toEqual(['lore:top', 'pinned', 'main', 'lore_before', 'core:tools', 'user_hint', 'lore_after', 'new_chat', 'history']);
    const at = coreAt(r.messages);
    expect(r.messages.slice(0, at + 1).every((m) => m.role === 'system' && m.placement === 'head')).toBe(true);
    expect(r.messages[at + 1]!.placement).toBe('inline');
  });

  test('a preset that opens with a user block: the core block is the first message', () => {
    const p: Preset = {
      name: 'user-first',
      blocks: [
        { id: 'opener', role: 'user', enabled: true, content: 'Hello, {{char}}.', at: 'relative' },
        { id: 'main', role: 'system', enabled: true, content: 'Write {{char}}.', at: 'relative' },
        { id: 'history', role: 'system', enabled: true, content: '{{history}}', at: 'relative' },
      ],
    };
    const r = runOk({ preset: p, tools: SPECS });
    expect(srcs(r.messages).slice(0, 4)).toEqual(['core:tools', 'opener', 'main', 'history']);
    expect(r.messages[0]!.placement).toBe('head');
    expect(r.messages[1]!.placement).toBe('inline');
    expect(r.messages[2]!.placement).toBe('inline'); // a system block after a user block is not the head
  });

  test('a preset with only the history block: the core block alone opens the request', () => {
    const p: Preset = { name: 'bare', blocks: [{ id: 'history', role: 'system', enabled: true, content: '{{history}}', at: 'relative' }] };
    const r = runOk({ preset: p, tools: SPECS });
    expect(srcs(r.messages)[0]).toBe('core:tools');
    expect(srcs(r.messages)[1]).toBe('history');
  });

  test('the rest of the request is the tool-less one with the core block added (and maybe less history)', () => {
    const without = runOk({ lorebooks: LORE });
    const withTools = runOk({ lorebooks: LORE, tools: SPECS });
    expect(withTools.trace.trimmed).toBeNull(); // a big window: nothing trimmed either way
    const rest = withTools.messages.filter((m) => m.src !== CORE_TOOLS_SRC);
    expect(rest).toEqual(without.messages);
  });

  test('shape keeps it in the leading run: as-user mid-system and strict post-processing', () => {
    const r = runOk({ tools: SPECS });
    const asUser = shape({ messages: r.messages, caps: { ...CAPS, midSystem: 'as-user', alternation: 'strict' }, prefill: null, kind: 'reply' });
    expect(leadingSystemRun(asUser.messages)).toBe(coreAt(r.messages) + 1);
    expect(asUser.messages[coreAt(r.messages)]!.src).toBe('core:tools');
    // 'strict' (ST): the leading system messages become one; the core block's text is in it.
    const strict = shape({ messages: r.messages, caps: CAPS, prefill: null, kind: 'reply', postProcessing: 'strict' });
    expect(strict.messages[0]!.role).toBe('system');
    expect(strict.messages[0]!.src.split('+')).toContain('core:tools');
    expect(textOf(strict.messages[0]!)).toContain(renderCoreBlock(SPECS, 'native'));
  });
});

describe('trace', () => {
  test('one trace row for the core block, counted like any message', () => {
    const r = runOk({ tools: SPECS });
    const at = coreAt(r.messages);
    expect(r.trace.blocks[at]).toEqual({ src: 'core:tools', role: 'system', tok: estimateMessage(r.messages[at]!, CHARS_COUNTER) });
    expect(r.trace.blocks).toHaveLength(r.messages.length);
    expect(r.trace.tokens.estimated).toBe(r.trace.blocks.reduce((a, b) => a + b.tok, 0));
  });

  test('builtin preset with the M1 preset unchanged: the core block never lands inside a preset block', () => {
    const r = runOk({ preset: BUILTIN_PRESET, tools: SPECS });
    for (const m of r.messages) if (m.src !== CORE_TOOLS_SRC) expect(textOf(m)).not.toContain('## Looking things up');
  });
});
