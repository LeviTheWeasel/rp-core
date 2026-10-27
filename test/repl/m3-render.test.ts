// M3 REPL and send output, pure: the banner's tools word, the 'tools: off (prefill)' status item, tool
// side lines (and the round separator after them), /trace rounds and tool rows, the /preview tools
// line, /memory listings and cards, /search hits, and send's text-mode tool lines.
import { describe, expect, test } from 'bun:test';
import type { MemoryRow, PreviewResult } from '../../src/engine/api.ts';
import type { CEntry } from '../../src/agents/compendium/types.ts';
import type { Event, EventBody } from '../../src/protocol/events.ts';
import type { Trace } from '../../src/session/entries.ts';
import type { MessageView } from '../../src/session/view.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { createTextRenderer, describeEvent, toolArgsText, toolLine } from '../../src/cli/render.ts';
import {
  bannerLine,
  makeStyle,
  previewToolsText,
  renderMemoryList,
  renderNoteCard,
  renderPreview,
  renderSearch,
  renderTrace,
  Screen,
  sideLine,
  statusItems,
  statusLine,
  stripAnsi,
  toolTraceLines,
  toolsWord,
  TurnPrinter,
} from '../../src/cli/repl-render.ts';

const plain = makeStyle(false);
const ansi = makeStyle(true);
const ev = (body: EventBody): Event => ({ sessionId: 's_1', ts: '2026-10-26T12:00:00.000Z', ...body }) as Event;
const T = 't_1';
const tool = (over: Partial<Extract<EventBody, { type: 'tool' }>> = {}): EventBody => ({
  type: 'tool',
  turnId: T,
  callId: 'call_0_0',
  name: 'search_history',
  round: 0,
  phase: 'done',
  ok: true,
  ...over,
});
const text = (delta: string): EventBody => ({ type: 'text', turnId: T, delta, offset: 0 });

function msg(over: Partial<MessageView> = {}): MessageView {
  return {
    id: 'a1b2c3d4',
    parent: 'u1',
    role: 'assistant',
    blocks: [{ k: 'text', text: 'She nods.' }],
    hidden: false,
    edited: false,
    swipe: { index: 0, count: 1 },
    gen: { kind: 'model', connection: 'script', model: 'default', finish: 'end', ms: 7900, usage: { outputTotal: 386 } },
    ...over,
  };
}

const trace = (over: Partial<Trace> = {}): Trace => ({
  seed: 1,
  now: '2026-10-26T12:00:00.000Z',
  window: 8192,
  reserve: 512,
  tokens: { estimated: 300 },
  blocks: [{ src: 'main', role: 'system', tok: 20 }],
  lore: { fired: [], cut: [], budget: 0 },
  recap: { ids: [], arcs: [], boundary: null },
  prefill: null,
  macros: { unknown: [] },
  trimmed: null,
  calls: [],
  agents: {},
  presetHash: 'h',
  loreHashes: {},
  ...over,
});

const note = (over: Partial<CEntry> = {}): CEntry => ({
  key: 'note:brother',
  type: null,
  name: 'Brother',
  aliases: [],
  tagline: '',
  data: {},
  keys: ['Yan', 'brother'],
  content: "Mira's brother Yan sails the north road.",
  origin: { kind: 'session' },
  prov: { created: null, lastSeq: 4, appended: {}, createdSeq: 4 },
  ...over,
});

describe('banner and status', () => {
  test('the tools word follows the narrator route\'s caps.tools; none and unknown caps read off', () => {
    expect(toolsWord('native')).toBe('native');
    expect(toolsWord('prompted')).toBe('prompted');
    expect(toolsWord('none')).toBe('off');
    expect(toolsWord(null)).toBe('off');
    const head = { id: 's_4fa2', title: 'Mira' };
    const local = { conn: 'local', model: 'qwen3-14b' };
    expect(bannerLine(head, local, 16384, plain, undefined, 'prompted')).toBe('session s_4fa2 · Mira · narrator local:qwen3-14b (tools: prompted) · ctx 16384');
    expect(bannerLine(head, local, 16384, plain, undefined, 'native')).toContain('(tools: native)');
    expect(bannerLine(head, local, 16384, plain, undefined, 'none')).toContain('(tools: off)');
    expect(bannerLine(head, local, null, plain, 4095, 'native')).toBe('session s_4fa2 · Mira · narrator local:qwen3-14b (tools: native) · ctx ≤4095');
  });

  test("'tools: off (prefill)' when the answer's trace says the preset's prefill turned tools off (D-28)", () => {
    expect(statusItems(msg(), { prefill: 'tools_off' })).toEqual(['swipe 1/1', '386 tok', '7.9s', 'end', 'tools: off (prefill)']);
    expect(statusLine(msg(), plain, { prefill: 'tools_off' })).toBe('  [swipe 1/1 · 386 tok · 7.9s · end · tools: off (prefill)]   /r swipe  /c continue  /e edit');
    for (const prefill of ['sent', 'skipped_for_tools', 'unsupported', null] as const) expect(statusItems(msg(), { prefill })).not.toContain('tools: off (prefill)');
    // No trace: the M2 line, unchanged.
    expect(statusLine(msg(), plain)).toBe('  [swipe 1/1 · 386 tok · 7.9s · end]   /r swipe  /c continue  /e edit');
  });
});

describe('tool lines', () => {
  test('toolArgsText: a string as is, an object\'s first string quoted and the rest as key=value, cut to the width', () => {
    expect(toolArgsText('караван')).toBe('караван');
    expect(toolArgsText({ query: 'караван' })).toBe('"караван"');
    expect(toolArgsText({ query: 'old map', before: 40, limit: 5 })).toBe('"old map" before=40 limit=5');
    expect(toolArgsText({ from: 3, to: 9 })).toBe('from=3 to=9');
    expect(toolArgsText({ ids: ['L1', 'L3'] })).toBe('ids=L1,L3');
    expect(toolArgsText({})).toBe('');
    expect(toolArgsText(undefined)).toBe('');
    const long = toolArgsText({ query: 'a'.repeat(100) });
    expect(long).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
  });

  test('one line per finished call, whatever its round; start is silent', () => {
    expect(toolLine(ev(tool({ phase: 'start' })) as Extract<Event, { type: 'tool' }>)).toBeNull();
    expect(sideLine(ev(tool({ args: { query: 'караван' }, summary: '2 hits' })))).toBe('⋯ search_history "караван" → 2 hits');
    expect(sideLine(ev(tool({ round: 3, name: 'read_lore', args: { ids: ['L1'] }, summary: '1 entry' })))).toBe('⋯ read_lore ids=L1 → 1 entry');
    expect(sideLine(ev(tool({ name: 'read_history', args: { from: 3 }, ok: false })))).toBe('⋯ read_history from=3 → failed');
    expect(sideLine(ev(tool({ name: 'search_lore', summary: '' })))).toBe('⋯ search_lore → ok');
    // send's text mode says the same through describeEvent.
    expect(describeEvent(ev(tool({ args: { query: 'x' }, summary: 'no hits' })))).toBe('⋯ search_history "x" → no hits');
    expect(describeEvent(ev(tool({ phase: 'start' })))).toBeNull();
  });
});

/** Print events through a TurnPrinter (plain), return the screen text. */
function printTurn(events: EventBody[]): string {
  let out = '';
  const p = new TurnPrinter({ screen: new Screen((s) => (out += s)), style: plain, label: 'Mira', showReasoning: () => false, notice: () => {} });
  for (const b of events) p.push(ev(b));
  p.finish();
  return out;
}

describe('TurnPrinter with tool rounds', () => {
  const done: EventBody = { type: 'done', turnId: T, message: msg() };

  test('a round that only calls: the side line, then the answer under the prefix', () => {
    const out = printTurn([tool({ phase: 'start' }), tool({ args: { query: 'map' }, summary: '1 hit' }), text('She unrolls the map.'), done]);
    expect(out).toBe('  ⋯ search_history "map" → 1 hit\nMira › She unrolls the map.\n');
  });

  test('text, a call, text: the round separator "\\n" is not shown after the side line (D-55)', () => {
    const out = printTurn([text('She frowns.'), tool({ args: { query: 'map' }, summary: '1 hit' }), text('\n'), text('Then she nods.'), done]);
    expect(out).toBe('Mira › She frowns.\n  ⋯ search_history "map" → 1 hit\n       Then she nods.\n');
    // Glued to the text, the separator is dropped too; a second newline is the model's own.
    const glued = printTurn([text('She frowns.'), tool({ summary: '1 hit' }), text('\n\nThen.'), done]);
    expect(glued).toBe('Mira › She frowns.\n  ⋯ search_history → 1 hit\n       \nThen.\n');
  });

  test('a newline in ordinary text is kept', () => {
    expect(printTurn([text('One.'), text('\nTwo.'), done])).toBe('Mira › One.\nTwo.\n');
  });
});

describe('/trace: rounds and tool rows', () => {
  const rounds: Trace['rounds'] = { n: 3, transport: 'prompted', ended: 'answer', room: 2048, roomLeft: 1530 };
  const tools: Trace['tools'] = [
    { round: 0, callId: 'call_0_0', name: 'search_history', ok: true, chars: 412 },
    { round: 1, callId: 'call_1_0', name: 'read_history', ok: true, repaired: ['jsonrepair'], chars: 6000, cut: true },
    { round: 1, callId: 'call_1_1', name: 'read_lore', ok: false, chars: 31 },
    { round: 2, callId: 'call_2_0', name: 'search_lore', ok: false, refused: 'final_round' },
    { round: 1, callId: 'call_1_2', name: 'roll_dice', ok: false, refused: 'unknown_tool', chars: 1 },
  ];

  test('the loop line: calls, transport, why it ended, room used of the reserve; one line per call', () => {
    expect(toolTraceLines({ rounds, tools })).toEqual([
      '  rounds: 3 · prompted tools · ended: answer · tool room 518 of 2048 tok used',
      '  tool calls: 5',
      '    round 0 · search_history · ok · 412 chars',
      '    round 1 · read_history · ok · repaired: jsonrepair · 6000 chars · cut',
      '    round 1 · read_lore · error · 31 chars',
      '    round 2 · search_lore · refused: final_round',
      '    round 1 · roll_dice · refused: unknown_tool · 1 char',
    ]);
    expect(toolTraceLines({ rounds: { ...rounds, ended: 'guard' } })[0]).toContain('ended: guard (the same call kept coming back)');
    expect(toolTraceLines({ rounds: { ...rounds, ended: 'max_rounds', roomLeft: 4000 } })[0]).toContain('ended: max_rounds (the round limit) · tool room 0 of 2048 tok used');
  });

  test('renderTrace: after the calls; nothing for a turn without tools (an M2 trace)', () => {
    const calls = [{ callKey: 't:narrator:0', agent: 'narrator', model: 'm', ms: 1200 }];
    const out = renderTrace('abcd1234', { trace: trace({ calls, rounds, tools: tools.slice(0, 1) }), continued: false }).split('\n');
    const at = out.indexOf('  calls: narrator m 1.2s');
    expect(out.slice(at + 1)).toEqual(['  rounds: 3 · prompted tools · ended: answer · tool room 518 of 2048 tok used', '  tool calls: 1', '    round 0 · search_history · ok · 412 chars']);
    const m2 = renderTrace('abcd1234', { trace: trace({ calls }), continued: false });
    expect(m2).not.toContain('rounds');
    expect(m2).not.toContain('tool calls');
  });
});

describe('/preview: the core block and the tools line', () => {
  const ok: Extract<PreviewResult, { ok: true }> = {
    ok: true,
    kind: 'reply',
    upTo: 'u1',
    model: { connection: 'local', model: 'qwen' },
    messages: [
      { role: 'system', src: 'main', blocks: [{ k: 'text', text: 'You are the narrator.' }] },
      { role: 'system', src: 'core:tools', blocks: [{ k: 'text', text: 'You can look things up.' }] },
      { role: 'user', src: 'history', blocks: [{ k: 'text', text: 'Hello' }] },
    ],
    prefill: null,
    tools: [
      { name: 'read_lore', description: 'Read', schema: { type: 'object' } },
      { name: 'search_lore', description: 'Search', schema: { type: 'object' } },
    ],
    maxTokens: 400,
    samplers: {},
    trace: trace({
      blocks: [
        { src: 'main', role: 'system', tok: 6 },
        { src: 'core:tools', role: 'system', tok: 7 },
        { src: 'history', role: 'user', tok: 2 },
      ],
    }),
    notices: [],
  };

  test('the core block is a message like any other; the tools line names the tools and the transport', () => {
    const lines = renderPreview(ok, plain, undefined, 'native').split('\n');
    expect(lines).toContain('#2 system · core:tools · 7 tok');
    expect(lines[lines.indexOf('#2 system · core:tools · 7 tok') + 1]).toBe('You can look things up.');
    expect(lines).toContain('tools: read_lore, search_lore (native)');
    expect(renderPreview(ok, plain, undefined, 'prompted')).toContain('tools: read_lore, search_lore (prompted)');
    // Without the caps (a host that does not say), only the names.
    expect(renderPreview(ok, plain).endsWith('\ntools: read_lore, search_lore')).toBe(true);
  });

  test('previewToolsText: none, and off (prefill) when the preset prefill won', () => {
    expect(previewToolsText({ tools: [], trace: trace() })).toBe('none');
    expect(previewToolsText({ tools: [], trace: trace({ prefill: 'tools_off' }) }, 'native')).toBe("off (prefill): the preset's prefill wins this turn (prefill_vs_tools)");
  });
});

describe('/memory and /search output', () => {
  test('the list (M5a: the Compendium list): handle, title — text, keys, size; a retired note dimmed with its reason', () => {
    const entries = [
      note(),
      note({ key: 'note:lighthouse', name: 'Lighthouse', keys: [], content: 'The old lighthouse burnt down years ago, the keeper with it, and nobody rebuilt it.', retired: { reason: 'rebuilt' } }),
    ];
    const rows: MemoryRow[] = entries.map((e, i) => ({
      ref: `C${i + 1}`,
      key: e.key,
      type: 'note',
      name: e.name,
      aliases: [],
      tagline: '',
      origin: 'session',
      ...(e.retired ? { retired: e.retired } : {}),
      size: e.content!.length,
    }));
    const byKey = (k: string): CEntry | undefined => entries.find((e) => e.key === k);
    expect(renderMemoryList(rows, { retired: true }, plain, byKey).split('\n')).toEqual([
      'The Compendium of this path: 1 live, 1 retired · /memory show <ref> prints one',
      'Notes (2)',
      "  C1 Brother — Mira's brother Yan sails the north road. · keys: Yan, brother [40]",
      '  C2 Lighthouse — The old lighthouse burnt down years ago, the keeper with it… · keys: Lighthouse [retired: rebuilt] [83]',
    ]);
    expect(renderMemoryList(rows, { retired: true }, ansi, byKey).split('\n')[3]!.startsWith('\x1b[2m')).toBe(true);
    // Without --retired the retired note is only counted.
    expect(renderMemoryList(rows, {}, plain, byKey).split('\n')).toEqual([
      'The Compendium of this path: 1 live, 1 retired (/memory list --retired shows them) · /memory show <ref> prints one',
      'Notes (1)',
      "  C1 Brother — Mira's brother Yan sails the north road. · keys: Yan, brother [40]",
    ]);
    expect(renderMemoryList([], {}, plain)).toBe(
      'nothing in the Compendium on this path yet: /memory new <type> [name] files an entry, /memory add <title> | <keys> | <text> writes a note',
    );
    expect(renderMemoryList([], { type: 'note' }, plain)).toBe('no notes on this path');
  });

  test('the card: key, keys, provenance, and the text as a turn sends it', () => {
    expect(renderNoteCard('C1', note({ prov: { created: null, lastSeq: 9, appended: {}, createdSeq: 4 } })).split('\n')).toEqual([
      'C1 Brother · note:brother',
      '  keys: Yan, brother',
      '  written by you at journal row 4; last changed at row 9',
      '  sent when one of its keys comes up in the last 4 messages, as:',
      '    [Memory: Brother]',
      "    Mira's brother Yan sails the north road.",
    ]);
    const retired = renderNoteCard('C2', note({ retired: { reason: '' } }));
    expect(retired).toContain('  retired (it does not fire; /memory restore C2 brings it back)');
    expect(retired).not.toContain('last changed');
  });

  test('/search: the hits as the tool gives them, then the next page', () => {
    const hits = {
      hits: [
        { n: 40, id: 'a', role: 'assistant' as const, speaker: 'Mira', snippet: '…the caravan left at dawn…', inContext: true },
        { n: 12, id: 'b', role: 'user' as const, speaker: 'Levi', snippet: 'Where did the caravan go?', inContext: false },
      ],
      nextBefore: 12,
    };
    expect(renderSearch('caravan', hits, undefined, plain).split('\n')).toEqual([
      '#40 Mira: …the caravan left at dawn… (in context)',
      '#12 Levi: Where did the caravan go?',
      '(older matches: /search caravan before=12)',
    ]);
    expect(renderSearch('caravan', { ...hits, nextBefore: null }, undefined, plain)).not.toContain('older matches');
    expect(renderSearch('caravan', { hits: [], nextBefore: null }, undefined, plain)).toBe('no messages match');
    expect(renderSearch('caravan', { hits: [], nextBefore: null }, 12, plain)).toBe('no messages before #12 match');
  });
});

describe('send text mode', () => {
  test('tool calls go to stderr, one line each; stdout stays the answer; a call mid-line starts a fresh line', () => {
    const out = memoryChannel();
    const err = memoryChannel();
    const r = createTextRenderer({ out, err }, { debug: false });
    r.push(ev(tool({ phase: 'start' })));
    r.push(ev(tool({ args: { query: 'map' }, summary: '1 hit' })));
    r.push(ev(text('She frowns.')));
    r.push(ev(tool({ name: 'read_history', args: { from: 3 }, summary: '#3–#5' })));
    r.push(ev(text('\nThen she nods.')));
    r.push(ev({ type: 'done', turnId: T, message: msg() }));
    r.finish();
    expect(out.text()).toBe('She frowns.\nThen she nods.\n');
    expect(err.text()).toBe('rp-core: ⋯ search_history "map" → 1 hit\n\nrp-core: ⋯ read_history from=3 → #3–#5\n');
    expect(stripAnsi(err.text())).toBe(err.text());
  });
});
