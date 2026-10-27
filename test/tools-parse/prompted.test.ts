// Ported from RoleCall:apps/rc/src/lib/ai/prompted-tool-calls/__tests__/{prompted-tool-calls,
// attribute-open-tag,fenced-tool-calls}.test.ts@fb8dc623e (35 cases).
// Copyright (C) 2026 NemoVonNirgend, Levi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// tools/prompted.ts: the tolerant parser and the stripper. RoleCall's 35 cases: the 7 + 8 parse cases
// ported (args come back as raw text; "missing closing tag" and "<tool_calls>" FLIPPED, see
// docs/PARITY-RC.md TD-2 / TD-3); the 2 catalog cases adapted to rp-core's core block (the third,
// "disabled this turn", DROPPED: no tools means no core block at all); the 2 batch and 3 streaming
// attribute-form strip cases ported with rp-core's seams (TD-5); the 12 fence cases ported, each with
// a streaming twin (char by char and in uneven chunks) that must equal the batch strip (TD-6).
import { describe, expect, test } from 'bun:test';
import { parseToolArgs } from '../../src/tools/args.ts';
import {
  createPromptedStripper,
  cutAtPromptedStop,
  parsePromptedCalls,
  PROMPTED_STOP,
  stripPromptedCalls,
  type PromptedBlock,
} from '../../src/tools/prompted.ts';

/** Every push and end() of a stripper fed `parts`, joined. */
function streamed(parts: readonly string[]): string {
  const s = createPromptedStripper();
  let out = '';
  for (const p of parts) out += s.push(p);
  return out + s.end();
}
const chars = (text: string): string[] => [...text];
/** Uneven chunks: 1, 2, 3, 5, 8, … characters. */
function uneven(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (let k = 0; at < text.length; k++) {
    const n = [1, 2, 3, 5, 8, 13][k % 6]!;
    out.push(text.slice(at, at + n));
    at += n;
  }
  return out;
}
/** The batch strip, checked against two streamings of the same text. */
function strip(text: string): string {
  const batch = stripPromptedCalls(text);
  expect(streamed(chars(text))).toBe(batch);
  expect(streamed(uneven(text))).toBe(batch);
  return batch;
}

/** RoleCall's ParsedToolCall view of a block: args parsed (no schema), parseError as a flag. */
function view(b: PromptedBlock): { name: string; args: unknown; error: boolean } {
  const parsed = parseToolArgs(b.args, { type: 'object' }, b.name ?? 'tool');
  return { name: b.name ?? '', args: parsed.ok ? parsed.value : b.args, error: b.error !== undefined };
}

describe('RoleCall prompted-tool-calls.test.ts — parse (ported)', () => {
  test('parses a clean single block', () => {
    const content = 'Sure, planning now.\n<tool_call>{"name": "commit_planning_round", "args": {"directive": {"mood": "tense"}}}</tool_call>';
    const calls = parsePromptedCalls(content);
    expect(calls).toHaveLength(1);
    expect(view(calls[0]!)).toEqual({ name: 'commit_planning_round', args: { directive: { mood: 'tense' } }, error: false });
    expect(calls[0]!.args).toBe('{"directive":{"mood":"tense"}}');
    expect([calls[0]!.start, calls[0]!.end]).toEqual([20, content.length]);
  });
  test("recovers a block fenced in a code block and prefixed with 'json'", () => {
    const calls = parsePromptedCalls('Here goes:\n<tool_call>\n```json\n{"name": "ping", "args": {}}\n```\n</tool_call>');
    expect(calls.map(view)).toEqual([{ name: 'ping', args: {}, error: false }]);
  });
  test('parses multiple blocks interleaved with prose', () => {
    const content =
      'thinking...\n<tool_call>{"name": "ping", "args": {}}</tool_call>\nmore prose\n' +
      '<tool_call>{"name": "commit_planning_round", "args": {"directive": {"mood": "calm"}}}</tool_call>';
    expect(parsePromptedCalls(content).map((c) => c.name)).toEqual(['ping', 'commit_planning_round']);
  });
  test('FLIP (TD-2): a block missing its closing tag counts when the JSON inside is complete', () => {
    // RoleCall flagged "missing </tool_call>" and its btw loop never ran the call.
    const calls = parsePromptedCalls('<tool_call>{"name": "ping", "args": {}}');
    expect(calls).toEqual([{ name: 'ping', args: '{}', start: 0, end: 39 }]);
    // Cut inside the JSON: still an error, named when the name is readable.
    expect(parsePromptedCalls('<tool_call>{"name": "ping", "args": {"q": "br')).toEqual([
      { name: 'ping', args: '', start: 0, end: 45, error: expect.stringContaining('was cut off') },
    ]);
  });
  test('repairs loose JSON (trailing comma)', () => {
    const calls = parsePromptedCalls('<tool_call>{"name": "commit_planning_round", "args": {"directive": {"mood": "wry"},}}</tool_call>');
    expect(calls.map(view)).toEqual([{ name: 'commit_planning_round', args: { directive: { mood: 'wry' } }, error: false }]);
  });
  test('flags a malformed body with no name', () => {
    const calls = parsePromptedCalls('<tool_call>not json at all</tool_call>');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBeNull();
    expect(calls[0]!.error).toContain('not readable JSON (not a JSON object)');
  });
  test('returns no calls when content has no blocks', () => {
    expect(parsePromptedCalls('just a normal reply')).toEqual([]);
  });
});

describe('RoleCall attribute-open-tag.test.ts — parse (ported)', () => {
  test('still parses the documented envelope form', () => {
    const calls = parsePromptedCalls('sure\n<tool_call>{"name":"read_scene_messages","args":{"from_index":30,"to_index":55}}</tool_call>');
    expect(calls.map(view)).toEqual([{ name: 'read_scene_messages', args: { from_index: 30, to_index: 55 }, error: false }]);
  });
  test('parses the exact block the Dramaturg emitted', () => {
    const calls = parsePromptedCalls('<tool_call name="read_scene_messages">\n{"from_index": 30, "to_index": 55} </tool_call>');
    expect(calls).toEqual([{ name: 'read_scene_messages', args: '{"from_index": 30, "to_index": 55}', start: 0, end: 86 }]);
  });
  test('accepts single quotes and extra attributes on the tag', () => {
    const calls = parsePromptedCalls("<tool_call id='7' name='read_scene_messages'>{\"from_index\": 1}</tool_call>");
    expect(calls.map(view)).toEqual([{ name: 'read_scene_messages', args: { from_index: 1 }, error: false }]);
  });
  test('accepts an args key nested inside the attribute-form body', () => {
    const calls = parsePromptedCalls('<tool_call name="read_scene_messages">{"args":{"from_index":2}}</tool_call>');
    expect(calls.map((c) => [c.name, c.args])).toEqual([['read_scene_messages', '{"from_index":2}']]);
  });
  test('treats a self-closing named tag as a no-arg call', () => {
    expect(parsePromptedCalls('<tool_call name="list_panels" />')).toEqual([{ name: 'list_panels', args: '', start: 0, end: 32 }]);
  });
  test('FLIP (TD-3): <tool_calls> is a container, its calls are read', () => {
    // RoleCall skipped the longer tag name entirely.
    const calls = parsePromptedCalls('<tool_calls>{"name":"read_scene_messages"}</tool_calls>');
    expect(calls).toEqual([{ name: 'read_scene_messages', args: '', start: 0, end: 55 }]);
  });
  test('still reports an empty unnamed block as a parse error', () => {
    const calls = parsePromptedCalls('<tool_call></tool_call>');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.error).toStartWith('The <tool_call> block is empty.');
  });
  test('parses multiple attribute-form blocks in one reply', () => {
    const content = ['first', '<tool_call name="read_scene_messages">{"from_index":0}</tool_call>', 'then', '<tool_call name="list_panels">{}</tool_call>'].join('\n');
    expect(parsePromptedCalls(content).map((c) => c.name)).toEqual(['read_scene_messages', 'list_panels']);
  });
});

describe('RoleCall attribute-open-tag.test.ts — strip (ported, rp-core seams: TD-5)', () => {
  test('removes the attribute-form block from the visible reply', () => {
    // RoleCall: "Let me look.\n\ndone" (both line breaks kept). The seam keeps the wider side's one.
    expect(strip('Let me look.\n<tool_call name="read_scene_messages">{"from_index":30}</tool_call>\ndone')).toBe('Let me look.\ndone');
  });
  test('removes an attribute-form block whose closing tag never arrived', () => {
    // RoleCall: "Let me look.\n". Whitespace a removal leaves at the end goes too.
    expect(strip('Let me look.\n<tool_call name="read_scene_messages">{"fr')).toBe('Let me look.');
  });
});

describe('RoleCall attribute-open-tag.test.ts — streaming (adapted to push/end)', () => {
  test('never leaks attribute-form markup, even split across chunks', () => {
    const content = 'Let me look.\n<tool_call name="read_scene_messages">{"from_index":30}</tool_call>\ndone';
    const s = createPromptedStripper();
    const seen: string[] = [];
    for (const ch of content) seen.push(s.push(ch));
    seen.push(s.end());
    expect(seen.join('')).toBe('Let me look.\ndone');
    for (const piece of seen) {
      expect(piece).not.toContain('<');
      expect(piece).not.toContain('read_scene_messages');
    }
  });
  test('still passes through prose containing an angle bracket', () => {
    expect(streamed(chars('a < b and c > d'))).toBe('a < b and c > d');
  });
  test('holds back a partial opener; end() flushes it when no tag came', () => {
    const s = createPromptedStripper();
    // RoleCall: visible "text ", carry "<tool_c". The trailing space is held too (a seam may need it).
    expect(s.push('text <tool_c')).toBe('text');
    expect(s.end()).toBe(' <tool_c');
  });
});

const CALL = '<tool_call>{"name":"patch_visual_novel","arguments":{}}</tool_call>';

describe('RoleCall fenced-tool-calls.test.ts — a fence wrapping only the call (ported + streaming twins)', () => {
  test('goes with it when it hugs the prose', () => {
    const out = strip(`Let me read.\n\n\`\`\`${CALL}\`\`\`Found it.`);
    expect(out).not.toContain('`');
    expect(out).toBe('Let me read.\n\nFound it.');
  });
  test('goes with it when it sits on its own lines', () => {
    const out = strip(['Let me read.', '', '```', CALL, '```', '', 'Found it.'].join('\n'));
    expect(out).not.toContain('```');
    expect(out.replace(/\n+/g, '\n').trim()).toBe('Let me read.\nFound it.');
  });
  test('takes a fence carrying an info string', () => {
    const out = strip(`Reading.\n\`\`\`json\n${CALL}\n\`\`\`\nDone.`);
    expect(out).not.toContain('```');
    expect(out).not.toContain('json');
  });
  test('handles tildes, which are a fence too', () => {
    expect(strip(`Reading.\n~~~\n${CALL}\n~~~\nDone.`)).not.toContain('~~~');
  });
  test('still removes the call when there is no fence at all', () => {
    const out = strip(`Reading.\n\n${CALL}\n\nDone.`);
    expect(out).not.toContain('tool_call');
    expect(out).toBe('Reading.\n\nDone.');
  });
});

describe('RoleCall fenced-tool-calls.test.ts — fences that are not the call\'s own (ported + streaming twins)', () => {
  test('leaves a real code block the model wrote before the call', () => {
    const out = strip(['Here is the shape:', '```json', '{"a":1}', '```', CALL, 'Done.'].join('\n'));
    expect(out).toContain('```json');
    expect(out).toContain('{"a":1}');
    expect(out).toContain('```');
    expect(out).not.toContain('tool_call');
  });
  test('leaves a code block the model opened after the call', () => {
    const out = strip(['Reading.', CALL, '```json', '{"a":1}', '```', 'Done.'].join('\n'));
    expect(out).toContain('```json');
    expect(out).toContain('{"a":1}');
    expect(out).not.toContain('tool_call');
  });
  test('leaves an opening fence the model never closed', () => {
    const out = strip(`Reading.\n\`\`\`\n${CALL}`);
    expect(out).toContain('```');
    expect(out).not.toContain('tool_call');
  });
  test('does not pair a backtick fence with a tilde one', () => {
    const out = strip(`Reading.\n\`\`\`\n${CALL}\n~~~\nDone.`);
    expect(out).toContain('```');
    expect(out).toContain('~~~');
  });
  test('does not let a shorter closer end a longer opener', () => {
    expect(strip(`Reading.\n\`\`\`\`\n${CALL}\n\`\`\`\nDone.`)).toContain('````');
  });
});

describe('RoleCall fenced-tool-calls.test.ts — more than one call (ported + streaming twins)', () => {
  test("takes each one's own fence", () => {
    const out = strip(`First.\n\`\`\`\n${CALL}\n\`\`\`\nSecond.\n\`\`\`\n${CALL}\n\`\`\`\nThird.`);
    expect(out).not.toContain('```');
    expect(out.replace(/\n+/g, '\n').trim()).toBe('First.\nSecond.\nThird.');
  });
  test('survives two calls sharing one fence (TD-6: the shared fence goes too)', () => {
    const out = strip(`Doing both.\n\`\`\`\n${CALL}\n${CALL}\n\`\`\`\nDone.`);
    expect(out).not.toContain('tool_call');
    expect(out).toContain('Doing both.');
    expect(out).toContain('Done.');
    expect(out.match(/Done\./g)).toHaveLength(1);
    // RoleCall left an empty fenced block here; a run of blocks shares the fence around it.
    expect(out).toBe('Doing both.\nDone.');
  });
});

describe('the tolerant parser (§8.3 additions)', () => {
  test('`arguments` and `parameters` are read (TD-1: RoleCall read only `args`)', () => {
    expect(parsePromptedCalls('<tool_call>{"name": "search_history", "arguments": {"query": "брат"}}</tool_call>')[0]!.args).toBe('{"query":"брат"}');
    expect(parsePromptedCalls('<tool_call>{"name": "search_history", "parameters": {"query": "брат"}}</tool_call>')[0]!.args).toBe('{"query":"брат"}');
    // `args` wins when several are present; a string value is kept as written.
    expect(parsePromptedCalls('<tool_call>{"name": "x", "arguments": {"a": 1}, "args": "{\\"b\\": 2}"}</tool_call>')[0]!.args).toBe('{"b": 2}');
    // `null` is no arguments (RoleCall failed the envelope on it).
    expect(parsePromptedCalls('<tool_call>{"name": "x", "args": null}</tool_call>')[0]).toMatchObject({ name: 'x', args: '' });
  });
  test('OpenAI and salvage spellings of the envelope', () => {
    expect(parsePromptedCalls('<tool_call>{"function": {"name": "x", "arguments": "{\\"q\\": 1}"}}</tool_call>')[0]).toMatchObject({ name: 'x', args: '{"q": 1}' });
    expect(parsePromptedCalls('<tool_call>{"tool": "x", "input": {"q": 1}}</tool_call>')[0]).toMatchObject({ name: 'x', args: '{"q":1}' });
  });
  test('tags in any case and with whitespace, like tools/leaks.ts', () => {
    const calls = parsePromptedCalls('<TOOL_CALL>{"name": "a"}</Tool_Call >\n< tool_call name="b">{}</ tool_call>');
    expect(calls.map((c) => c.name)).toEqual(['a', 'b']);
    expect(stripPromptedCalls('x <TOOL_CALL>{"name": "a"}</Tool_Call > y')).toBe('x y');
  });
  test('a fence around and inside, Cyrillic arguments', () => {
    const text = 'Сейчас.\n```\n<tool_call>\n```json\n{"name": "search_history", "args": {"query": "брат трактирщицы"}}\n```\n</tool_call>\n```\nДальше.';
    expect(parsePromptedCalls(text).map(view)).toEqual([{ name: 'search_history', args: { query: 'брат трактирщицы' }, error: false }]);
    expect(strip(text)).toBe('Сейчас.\nДальше.');
  });
  test('a block left unclosed before the next one counts when its JSON is complete', () => {
    const text = '<tool_call>{"name": "a", "args": {}}\n<tool_call>{"name": "b", "args": {}}</tool_call>';
    expect(parsePromptedCalls(text).map((c) => [c.name, c.error])).toEqual([
      ['a', undefined],
      ['b', undefined],
    ]);
    expect(strip(`Hi ${text} there`)).toBe('Hi there');
  });
  test('several calls in one block: an array, NDJSON, a tool_calls wrapper (one block each, shared span)', () => {
    const arr = parsePromptedCalls('<tool_call>[{"name": "a", "args": {"q": 1}}, {"name": "b", "args": {}}]</tool_call>');
    expect(arr.map((c) => [c.name, c.args, c.start, c.end])).toEqual([
      ['a', '{"q":1}', 0, 83],
      ['b', '{}', 0, 83],
    ]);
    expect(parsePromptedCalls('<tool_call>{"name": "a"}\n{"name": "b"}</tool_call>').map((c) => c.name)).toEqual(['a', 'b']);
    expect(parsePromptedCalls('<tool_call>{"tool_calls": [{"name": "a"}, {"name": "b"}]}</tool_call>').map((c) => c.name)).toEqual(['a', 'b']);
    expect(parsePromptedCalls('<tool_calls>\n<tool_call>{"name": "a"}</tool_call>\n<tool_call name="b">{}</tool_call>\n</tool_calls>').map((c) => c.name)).toEqual(['a', 'b']);
  });
  test('the python-call body names the call', () => {
    expect(parsePromptedCalls('<tool_call>search_history(query="брат", limit=3)</tool_call>')).toEqual([
      { name: 'search_history', args: '{"query": "брат", "limit": 3}', start: 0, end: 60 },
    ]);
  });
  test('unreadable blocks still become calls with an error (the name kept when readable)', () => {
    const [a, b, c] = parsePromptedCalls('<tool_call>{"name": "search_lore", "args": {"q": }} x}</tool_call><tool_call>{"args": {}}</tool_call><tool_call>[]</tool_call>');
    expect(a).toMatchObject({ name: 'search_lore', error: expect.stringContaining('not readable JSON') });
    expect(b).toMatchObject({ name: null, error: expect.stringContaining('has no "name"') });
    expect(c).toMatchObject({ name: null, error: expect.stringContaining('holds no call') });
  });
  test('an opener cut before its ">" is a cut-off block (name kept when whole)', () => {
    expect(parsePromptedCalls('Hm. <tool_call name="search_history" ')).toEqual([
      { name: 'search_history', args: '', start: 4, end: 37, error: expect.stringContaining('cut off') },
    ]);
    expect(parsePromptedCalls('<tool_call')).toEqual([{ name: null, args: '', start: 0, end: 10, error: expect.stringContaining('cut off') }]);
    expect(stripPromptedCalls('Hm. <tool_call name="search_history" ')).toBe('Hm.');
  });
  test('a closing tag inside a JSON string ends the block (not string-aware, pinned)', () => {
    const calls = parsePromptedCalls('<tool_call>{"name": "search_history", "args": {"query": "</tool_call>"}}</tool_call>');
    expect(calls[0]).toMatchObject({ name: 'search_history', args: '{"query":""}' });
  });
  test('a hallucinated <tool_result> (the server ignored the stop) is never read or shown', () => {
    const text = 'Looking.\n<tool_call>{"name": "a"}</tool_call>\n<tool_result name="a">invented</tool_result>\nShe said so.<tool_call>{"name": "b"}</tool_call>';
    expect(parsePromptedCalls(text).map((c) => c.name)).toEqual(['a']);
    expect(strip(text)).toBe('Looking.');
    expect(PROMPTED_STOP).toBe('<tool_result');
  });
  test('cutAtPromptedStop: the raw text for the wire ends before a hallucinated result', () => {
    expect(cutAtPromptedStop('A <tool_call>{"name": "a"}</tool_call>\n<tool_result name="a">x</tool_result>\nB')).toBe('A <tool_call>{"name": "a"}</tool_call>\n');
    expect(cutAtPromptedStop('A <tool_call>{"name": "a"}<TOOL_RESULT>x')).toBe('A <tool_call>{"name": "a"}');
    expect(cutAtPromptedStop('No results here. <tool_call>{"name": "a"}</tool_call>')).toBe('No results here. <tool_call>{"name": "a"}</tool_call>');
  });
  test('a stray closer is removed from the text and is no call', () => {
    expect(parsePromptedCalls('done</tool_call> now')).toEqual([]);
    expect(strip('done</tool_call> now')).toBe('done now');
  });
  test('look-alikes are prose', () => {
    for (const text of ['a <tool_caller> b', '<tool_call_x>', 'x < tool', '<tool_c', '1 < 2 > 0', '</tool_call', '<tool-call>{}</tool-call>']) {
      expect(parsePromptedCalls(text)).toEqual([]);
      expect(strip(text)).toBe(text);
    }
  });
  test('text without blocks is returned unchanged, whitespace included', () => {
    for (const text of ['', '   ', '  Hello  \n\n', 'Line\r\n\r\nLine  ']) expect(strip(text)).toBe(text);
  });
});

describe('the streaming stripper', () => {
  test('no text event ever carries a partial tag', () => {
    const text = 'She nodded.<tool_call name="search_history">{"query":"брат"}</tool_call> Then: <tool_call>{"name":"read_history","args":{"from":3}}</tool_call>';
    const s = createPromptedStripper();
    for (const ch of text) {
      const out = s.push(ch);
      expect(out).not.toMatch(/<|tool|query/);
    }
    expect(s.end()).toBe('');
  });
  test('prose flows while nothing could start a tag', () => {
    const s = createPromptedStripper();
    expect(s.push('She ')).toBe('She');
    expect(s.push('nodded')).toBe(' nodded');
    expect(s.push('. <')).toBe('.');
    expect(s.push('3 >')).toBe(' <3 >');
    expect(s.push(' ')).toBe('');
    expect(s.end()).toBe(' ');
  });
  test('a finished block waits for what follows it (a fence or another block may)', () => {
    const s = createPromptedStripper();
    expect(s.push('A\n```\n<tool_call>{"name":"a"}</tool_call>\n')).toBe('A');
    expect(s.push('``')).toBe('');
    expect(s.push('`\nB')).toBe('\nB');
    expect(s.end()).toBe('');
  });
  test('end() drops an unclosed block and whitespace left by it', () => {
    const s = createPromptedStripper();
    expect(s.push('Okay. <tool_call>{"name": "a", "args": {"q": "x"')).toBe('Okay.');
    expect(s.end()).toBe('');
  });
});

describe('an unclosed block whose call is complete, then prose (review: unclosed-complete-json-then-prose)', () => {
  test('the call runs and the prose after it stays (it was an ERR_CUT, and the prose was erased)', () => {
    const text = 'Mira looks up. <tool_call>{"name":"search_lore","args":{"query":"x"}}\nThe tavern was quiet that night.';
    expect(parsePromptedCalls(text)).toEqual([{ name: 'search_lore', args: '{"query":"x"}', start: 15, end: text.indexOf('\nThe') }]);
    expect(strip(text)).toBe('Mira looks up.\nThe tavern was quiet that night.');
    // While streaming the block may still get its closer: the prose waits for end().
    const s = createPromptedStripper();
    expect(s.push(text)).toBe('Mira looks up.');
    expect(s.end()).toBe('\nThe tavern was quiet that night.');
    // The wire keeps the round as written (the user now sees the same prose the model wrote).
    expect(cutAtPromptedStop(text)).toBe(text);
  });
  test('a whole python call, the attribute form, a fence inside the tags, a fence around the block', () => {
    const py = '<tool_call>search_lore(query="брат (старший)")\nОна кивнула.';
    expect(parsePromptedCalls(py)).toEqual([{ name: 'search_lore', args: '{"query": "брат (старший)"}', start: 0, end: py.indexOf('\n') }]);
    expect(strip(py)).toBe('Она кивнула.');
    const attr = 'Hm. <tool_call name="search_lore">{"query": "lantern"}\n*She nods.*';
    expect(parsePromptedCalls(attr).map(view)).toEqual([{ name: 'search_lore', args: { query: 'lantern' }, error: false }]);
    expect(strip(attr)).toBe('Hm.\n*She nods.*');
    const inner = '<tool_call>\n```json\n{"name": "a", "args": {}}\n```\nAfter.';
    expect(parsePromptedCalls(inner)).toEqual([{ name: 'a', args: '{}', start: 0, end: inner.indexOf('\nAfter') }]);
    expect(strip(inner)).toBe('After.');
    const around = 'Before.\n```\n<tool_call>{"name": "a", "args": {}}\n```\nAfter.';
    expect(parsePromptedCalls(around)).toEqual([{ name: 'a', args: '{}', start: 8, end: around.indexOf('After') }]);
    expect(strip(around)).toBe('Before.\nAfter.');
  });
  test('before the next opener or a hallucinated result, the prose in between stays too', () => {
    const next = '<tool_call>{"name": "a", "args": {}}\nShe waits.\n<tool_call>{"name": "b", "args": {}}</tool_call>';
    expect(parsePromptedCalls(next).map((b) => [b.name, b.error])).toEqual([
      ['a', undefined],
      ['b', undefined],
    ]);
    expect(strip(next)).toBe('She waits.');
    const result = '<tool_call>{"name": "a", "args": {}}\nShe waits.\n<tool_result name="a">invented</tool_result>';
    expect(parsePromptedCalls(result).map((b) => b.name)).toEqual(['a']);
    expect(strip(result)).toBe('She waits.');
  });
  test('a complete value with no name: its own error, not "cut off"; the prose stays', () => {
    const text = '<tool_call>{"query": "x"}\nThe tavern.';
    expect(parsePromptedCalls(text)).toEqual([{ name: null, args: '', start: 0, end: 25, error: expect.stringContaining('has no "name"') }]);
    expect(strip(text)).toBe('The tavern.');
  });
  test('still cut off: a value that never closes, or a tail that may be more of the call (nothing raw is shown)', () => {
    for (const text of [
      '<tool_call>{"name": "a", "args": {"q": "x"}\nThe tavern.',
      '<tool_call>{"name": "a"}\n{"name": "b", "args": {"q": "br',
      '<tool_call>{"name": "a"}\n[{"name": "b"',
      '<tool_call>{"name": "a"}\n[search_lore(query="y"',
      '<tool_call>{"name": "a"}</tool_cal',
      '<tool_call>{"name": "a"}\n<tool_ca',
      '<tool_call>{"name": "a"}, {"name": "b", "args": {"q": "br',
      '<tool_call>{"name": "a"}}\n{"name": "b"',
      '<tool_call>{"name": "a"}\nsearch_lore(query="y")',
      '<tool_call>search_lore(query="x"\nThe tavern.',
    ]) {
      const blocks = parsePromptedCalls(text);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.error).toContain('cut off');
      expect(strip(text)).toBe('');
    }
  });
  test('punctuation left after the value goes with the block, never into the story (review: parse-residue-raw-markup)', () => {
    const J = '{"name": "lookup", "args": {"q": "door"}}';
    for (const [text, kept] of [
      [`Mira nods. <tool_call>${J}}`, 'Mira nods.'],
      [`Mira nods. <tool_call>${J}}\nThe tavern was quiet.`, 'Mira nods.\nThe tavern was quiet.'],
      [`Mira nods. <tool_call>${J}},\n}\nThe tavern was quiet.`, 'Mira nods.\nThe tavern was quiet.'],
      [`Mira nods. <tool_call>${J},`, 'Mira nods.'],
      [`Mira nods. <tool_call>${J});\nShe waits.`, 'Mira nods.\nShe waits.'],
      [`Mira nods. <tool_call>${J}] She waits.`, 'Mira nods. She waits.'],
    ] as const) {
      expect([text, parsePromptedCalls(text).map(view)]).toEqual([text, [{ name: 'lookup', args: { q: 'door' }, error: false }]]);
      expect([text, strip(text)]).toEqual([text, kept]);
    }
  });
  test('more calls after a comma are more calls of the same block, never dropped and never shown', () => {
    const J = (q: string) => `{"name": "lookup", "args": {"q": "${q}"}}`;
    for (const [text, kept] of [
      [`Mira nods. <tool_call>${J('door')}, ${J('key')}`, 'Mira nods.'],
      [`Mira nods. <tool_call>${J('door')},\n${J('key')}\nShe waits.`, 'Mira nods.\nShe waits.'],
      ['Mira nods. <tool_call>[lookup(q="door"), lookup(q="key")]\nShe waits.', 'Mira nods.\nShe waits.'],
    ] as const) {
      expect([text, parsePromptedCalls(text).map(view)]).toEqual([
        text,
        [
          { name: 'lookup', args: { q: 'door' }, error: false },
          { name: 'lookup', args: { q: 'key' }, error: false },
        ],
      ]);
      expect([text, strip(text)]).toEqual([text, kept]);
    }
    // A comma before prose is punctuation; a python call needs no space before '(' to count.
    const prose = `<tool_call>${J('door')}, and (quietly) she left.`;
    expect(parsePromptedCalls(prose).map(view)).toEqual([{ name: 'lookup', args: { q: 'door' }, error: false }]);
    expect(strip(prose)).toBe('and (quietly) she left.');
  });
  test('prose that opens with "[" or "<" but cannot be the call stays (review: parse-bracket-angle-prose-still-erased)', () => {
    const J = '{"name": "lookup", "args": {"q": "door"}}';
    for (const [text, kept] of [
      [`Mira. <tool_call>${J}\n[OOC: thanks]`, 'Mira.\n[OOC: thanks]'],
      [`Mira. <tool_call>${J}\n<i>She smiles.</i>`, 'Mira.\n<i>She smiles.</i>'],
      [`Mira. <tool_call>${J}<br>She smiles.`, 'Mira. <br>She smiles.'],
    ] as const) {
      expect([text, parsePromptedCalls(text).map(view)]).toEqual([text, [{ name: 'lookup', args: { q: 'door' }, error: false }]]);
      expect([text, strip(text)]).toEqual([text, kept]);
    }
  });
  test('a python call, then prose that ends in ")": the prose stays and the call keeps its own arguments (review: parse-python-prose-paren-still-erased)', () => {
    const text = 'Mira. <tool_call>search_lore(query="x")\nThe end.\n(OOC: hope that works)';
    expect(parsePromptedCalls(text).map(view)).toEqual([{ name: 'search_lore', args: { query: 'x' }, error: false }]);
    expect(strip(text)).toBe('Mira.\nThe end.\n(OOC: hope that works)');
  });
  test('a body that reads as complete as a whole keeps that reading (the block runs to its end)', () => {
    const text = '<tool_call>f(q="x")\nf(q="y")';
    expect(parsePromptedCalls(text)).toMatchObject([{ name: 'f', start: 0, end: text.length }]);
    expect(strip(text)).toBe('');
  });
});
