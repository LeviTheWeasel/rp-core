// cli/repl-render.ts: prose styling, the line-aware screen, the turn printer, status and reports (§12.4 "Вывод").
import { describe, expect, test } from 'bun:test';
import {
  bannerLine,
  createProseStyler,
  formatMessage,
  formatUsd,
  labels,
  lastWords,
  makeStyle,
  noticeText,
  refusalText,
  renderBindings,
  renderNote,
  renderNumberedPath,
  renderSessionList,
  renderTails,
  renderTrace,
  renderUsage,
  Screen,
  SGR,
  sideLine,
  statusLine,
  stripAnsi,
  TurnPrinter,
} from '../../src/cli/repl-render.ts';
import type { Event, EventBody } from '../../src/protocol/events.ts';
import type { Trace } from '../../src/session/entries.ts';
import type { MessageView, PathView } from '../../src/session/view.ts';
import { EMPTY_COMPENDIUM } from '../../src/agents/compendium/types.ts';

const plain = makeStyle(false);
const ansi = makeStyle(true);
const I = SGR.italicOn;
const i = SGR.italicOff;

const ev = (body: EventBody): Event => ({ sessionId: 's_1', ts: '2026-10-26T12:00:00.000Z', ...body }) as Event;

function msg(over: Partial<MessageView> & { text?: string } = {}): MessageView {
  const { text, ...rest } = over;
  return {
    id: 'a1b2c3d4',
    parent: 'u1',
    role: 'assistant',
    blocks: [{ k: 'text', text: text ?? 'She nods.' }],
    hidden: false,
    edited: false,
    swipe: { index: 0, count: 1 },
    gen: { kind: 'model', connection: 'script', model: 'default', finish: 'end', ms: 7900, usage: { outputTotal: 386 } },
    ...rest,
  };
}

describe('createProseStyler', () => {
  test('without colour it is the identity', () => {
    const s = createProseStyler(false);
    expect(s.push('*waves* "hi"')).toBe('*waves* "hi"');
    expect(s.end()).toBe('');
  });

  test('*actions* are italic, asterisks kept; dialogue stays plain', () => {
    const s = createProseStyler(true);
    expect(s.push('*She waves.* "Hi."')).toBe(`${I}*She waves.*${i} "Hi."`);
  });

  test('state carries across deltas, even a split asterisk span', () => {
    const s = createProseStyler(true);
    expect(s.push('*She ')).toBe(`${I}*She `);
    expect(s.push('turns.* Then')).toBe(`turns.*${i} Then`);
  });

  test('speech inside an action is plain, the action resumes after it', () => {
    const s = createProseStyler(true);
    expect(s.push('*She says "no" and leaves.*')).toBe(`${I}*She says ${i}"no"${I} and leaves.*${i}`);
    const curly = createProseStyler(true);
    expect(curly.push('*Он шепчет «тише» и уходит*')).toBe(`${I}*Он шепчет ${i}«тише»${I} и уходит*${i}`);
  });

  test('an asterisk inside speech does not start an action', () => {
    const s = createProseStyler(true);
    expect(s.push('"I *really* mean it."')).toBe('"I *really* mean it."');
  });

  test('a newline closes a stray asterisk, so it cannot italicise the rest', () => {
    const s = createProseStyler(true);
    expect(s.push('*unclosed\nnext line')).toBe(`${I}*unclosed${i}\nnext line`);
  });

  test('end() closes an open action', () => {
    const s = createProseStyler(true);
    s.push('*half');
    expect(s.end()).toBe(i);
    expect(s.end()).toBe('');
  });
});

describe('Screen', () => {
  test('newline() only when the cursor is mid-line; ANSI does not count as text', () => {
    let out = '';
    const sc = new Screen((s) => (out += s));
    sc.newline();
    expect(out).toBe('');
    sc.write('abc');
    sc.newline();
    sc.line('x');
    sc.write(`done\n${SGR.fgOff}`);
    sc.newline();
    expect(out).toBe(`abc\nx\ndone\n${SGR.fgOff}`);
    expect(sc.fresh).toBe(true);
  });
});

describe('labels and messages', () => {
  test('labels line up the arrows', () => {
    expect(labels('Mira')).toEqual({ char: 'Mira', user: 'you ', width: 4 });
    expect(labels('Al')).toEqual({ char: 'Al ', user: 'you', width: 3 });
    expect(labels('A very long character name').char).toHaveLength(16);
    expect(labels('  ').char).toBe('them');
  });

  test('formatMessage: prefix, styled text, (no text)', () => {
    const names = labels('Mira');
    expect(formatMessage(msg({ text: '*nods*' }), names, plain)).toBe('Mira › *nods*');
    expect(formatMessage(msg({ role: 'user', text: 'hi' }), names, plain)).toBe('you  › hi');
    expect(formatMessage(msg({ text: '  ' }), names, plain)).toBe('Mira › (no text)');
    expect(formatMessage(msg({ text: '*nods*' }), names, ansi)).toBe(`${SGR.boldOn}Mira${SGR.intensityOff} › ${I}*nods*${i}`);
  });

  test('statusLine: swipe, tokens, seconds, finish, hints', () => {
    expect(statusLine(msg({ swipe: { index: 1, count: 3 } }), plain)).toBe('  [swipe 2/3 · 386 tok · 7.9s · end]   /r swipe  /c continue  /e edit');
    const bare = msg({ gen: { kind: 'model', finish: 'stopped' } });
    expect(statusLine(bare, plain)).toBe('  [swipe 1/1 · stopped]   /r swipe  /c continue  /e edit');
    expect(statusLine(msg({ edited: true, hidden: true, gen: { kind: 'model' } }), plain)).toContain('swipe 1/1 · edited · hidden]');
    expect(statusLine(msg({ gen: { kind: 'greeting' }, swipe: { index: 0, count: 2 } }), plain)).toBe('  [greeting 1/2]   /r next greeting  /[ /] browse');
    expect(statusLine(msg({ gen: { kind: 'greeting' } }), plain)).toBe('  [greeting 1/1]');
    expect(statusLine(msg(), ansi).startsWith(SGR.dimOn)).toBe(true);
  });

  test('lastWords keeps the tail of a long text', () => {
    expect(lastWords('short')).toBe('short');
    const long = 'one two three four five six seven eight nine ten eleven twelve';
    const tail = lastWords(long, 20);
    expect(long.endsWith(tail.trim())).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(20);
  });
});

describe('sideLine and notices', () => {
  test('tools, director, agents, memory, retries: one line each; starts are silent', () => {
    expect(sideLine(ev({ type: 'tool', turnId: 't', callId: 'c', name: 'search_history', phase: 'start' }))).toBeNull();
    expect(sideLine(ev({ type: 'tool', turnId: 't', callId: 'c', name: 'search_history', phase: 'done', args: 'караван', summary: '2 hits' }))).toBe(
      '⋯ search_history караван → 2 hits',
    );
    expect(sideLine(ev({ type: 'tool', turnId: 't', callId: 'c', name: 'roll', phase: 'done', ok: false }))).toBe('⋯ roll → failed');
    expect(sideLine(ev({ type: 'director', turnId: 't', status: 'planning' }))).toBeNull();
    expect(sideLine(ev({ type: 'director', turnId: 't', status: 'planned' }))).toBe('⋯ director: planned');
    expect(sideLine(ev({ type: 'agent', agent: 'recall', status: 'recalled', count: 2 }))).toBe('⋯ recall: recalled (2)');
    expect(sideLine(ev({ type: 'agent', agent: 'filing', status: 'queued' }))).toBeNull();
    // M5a: the kind and the name first, then what happened (and who did it, unless you).
    expect(sideLine(ev({ type: 'memory', change: 'created', ref: 'r', kind: 'npc', name: 'Old Tom', by: 'filing' }))).toBe('⋯ memory: npc "Old Tom" created by filing');
    expect(sideLine(ev({ type: 'memory', change: 'note', ref: 'note:lamp', kind: 'note', name: 'Lamp', by: 'user' }))).toBe('⋯ memory: note "Lamp" added');
    expect(sideLine(ev({ type: 'memory', change: 'arc', ref: 'arc:x', kind: 'arc', name: 'Last fire', by: 'historian' }))).toBe('⋯ memory: arc "Last fire" overview written by historian');
    expect(sideLine(ev({ type: 'retry', callKey: 'k', attempt: 1, delayMs: 1500, code: 'rate_limited', status: 429 }))).toBe(
      '⋯ retrying in 1.5 s (rate_limited, HTTP 429)',
    );
    expect(sideLine(ev({ type: 'idle', background: 0 }))).toBeNull();
  });

  test('noticeText', () => {
    expect(noticeText({ level: 'warn', code: 'prefill_dropped', message: 'The prefill was dropped.' })).toBe('! The prefill was dropped. (prefill_dropped)');
  });
});

/** Print a sequence of events through a TurnPrinter (plain), return the screen text. */
function printTurn(events: EventBody[], o: { show?: boolean; continueFrom?: string } = {}): { out: string; notices: string[]; kept: boolean } {
  let out = '';
  const notices: string[] = [];
  const p = new TurnPrinter({
    screen: new Screen((s) => (out += s)),
    style: plain,
    label: 'Mira',
    showReasoning: () => o.show ?? false,
    notice: (n) => void notices.push(n.code),
    ...(o.continueFrom !== undefined ? { continueFrom: o.continueFrom } : {}),
  });
  for (const b of events) p.push(ev(b));
  p.finish();
  return { out, notices, kept: p.kept };
}

const T = 't_1';
const start: EventBody = { type: 'start', turnId: T, kind: 'reply', messageId: 'm1', parentId: 'u1' };
const text = (delta: string, offset = 0): EventBody => ({ type: 'text', turnId: T, delta, offset });
const reasoning = (delta: string, offset = 0): EventBody => ({ type: 'reasoning', turnId: T, delta, offset });

describe('TurnPrinter', () => {
  test('streams text after the prefix and ends the line', () => {
    const r = printTurn([start, text('*Она '), text('ставит бокал.*'), { type: 'done', turnId: T, message: msg() }]);
    expect(r.out).toBe('Mira › *Она ставит бокал.*\n');
  });

  test('folded reasoning: one line with its length, before the answer', () => {
    const r = printTurn([start, reasoning('Let me '), reasoning('think.'), text('Hi.'), { type: 'done', turnId: T, message: msg() }]);
    expect(r.out).toBe('  ⋯ thinking (13 chars)\nMira › Hi.\n');
  });

  test('/think show: reasoning printed (indented), then the answer', () => {
    const r = printTurn([start, reasoning('a\nb'), text('Hi.')], { show: true });
    expect(r.out).toBe('  ⋯ a\n    b\nMira › Hi.\n');
  });

  test('side lines and notices interrupt the text; the text resumes indented', () => {
    const r = printTurn([
      start,
      text('Before'),
      { type: 'tool', turnId: T, callId: 'c', name: 'roll', phase: 'done', summary: '17' },
      { type: 'notice', turnId: T, level: 'warn', code: 'x', message: 'm' } as unknown as EventBody,
      text(' after.'),
    ]);
    expect(r.out).toBe('Mira › Before\n  ⋯ roll → 17\n        after.\n');
    expect(r.notices).toEqual(['x']);
  });

  test('done with nothing streamed prints the committed text', () => {
    const r = printTurn([start, { type: 'done', turnId: T, message: msg({ text: 'Whole.' }) }]);
    expect(r.out).toBe('Mira › Whole.\n');
  });

  test('continue shows the last words of the answer before the addition', () => {
    const r = printTurn([{ ...start, kind: 'continue' } as EventBody, text(' More.')], { continueFrom: 'She nods slowly.' });
    expect(r.out).toBe('Mira › …She nods slowly. More.\n');
  });

  test('stopped: [stopped] after the partial text, or the empty variant', () => {
    expect(printTurn([start, text('Part'), { type: 'stopped', turnId: T, message: msg() }]).out).toBe('Mira › Part\n[stopped]\n');
    expect(printTurn([start, { type: 'stopped', turnId: T, message: null }]).out).toBe('[stopped] nothing had arrived; nothing was kept\n');
  });

  test('failed: the reason, and whether the partial answer was kept', () => {
    const lost = printTurn([start, { type: 'failed', turnId: T, category: 'network', code: 'unreachable', message: 'down', draft: '' }]);
    expect(lost.out).toBe('✗ the answer failed (network/unreachable): down\n');
    expect(lost.kept).toBe(false);
    const kept = printTurn([
      start,
      text('Half'),
      { type: 'changed', version: 9, change: 'msg', id: 'm1' },
      { type: 'failed', turnId: T, category: 'network', code: 'truncated_stream', message: 'cut', draft: 'Half' },
    ]);
    expect(kept.out).toBe('Mira › Half\n✗ the answer failed (network/truncated_stream): cut\n  the partial answer was kept, marked [interrupted]\n');
    expect(kept.kept).toBe(true);
  });

  test('conflict gets a line', () => {
    expect(printTurn([start, { type: 'conflict', turnId: T, draft: 'x' }]).out).toContain('the session changed during the turn');
  });

  test('with colour every style is closed by the end of the answer', () => {
    let out = '';
    const p = new TurnPrinter({ screen: new Screen((s) => (out += s)), style: ansi, label: 'Mira', showReasoning: () => false, notice: () => {} });
    p.push(ev(start));
    p.push(ev(text('*unclosed action')));
    p.finish();
    expect(out.endsWith(`${i}\n`)).toBe(true);
    expect(stripAnsi(out)).toBe('Mira › *unclosed action\n');
  });

  test('interject() closes the open line for a REPL message mid-answer', () => {
    let out = '';
    const sc = new Screen((s) => (out += s));
    const p = new TurnPrinter({ screen: sc, style: plain, label: 'Mira', showReasoning: () => false, notice: () => {} });
    p.push(ev(start));
    p.push(ev(reasoning('hmm')));
    p.interject();
    sc.line('(held)');
    p.push(ev(text('Hi.')));
    p.finish();
    expect(out).toBe('  ⋯ thinking (3 chars)\n(held)\nMira › Hi.\n');
  });
});

describe('reports', () => {
  const names = labels('Mira');

  test('bannerLine', () => {
    expect(bannerLine({ id: 's_4fa2', title: 'Mira' }, { conn: 'local', model: 'qwen3-14b' }, 16384, plain)).toBe(
      'session s_4fa2 · Mira · narrator local:qwen3-14b (tools: off) · ctx 16384',
    );
    expect(bannerLine({ id: 's_1' }, { conn: 'a', model: 'b' }, null, plain)).toContain('(untitled)');
    expect(bannerLine({ id: 's_1' }, { conn: 'a', model: 'b' }, null, plain)).toContain('ctx ?');
    // The model's window unknown but a preset (or the session) caps it: the bound is still news.
    expect(bannerLine({ id: 's_1' }, { conn: 'a', model: 'b' }, null, plain, 4095)).toEndWith('· ctx ≤4095');
    expect(bannerLine({ id: 's_1' }, { conn: 'a', model: 'b' }, 4095, plain, 4095)).toEndWith('· ctx 4095');
  });

  test('renderNumberedPath numbers the path from 1 and marks hidden/edited', () => {
    const view: PathView = {
      session: 's_1',
      head: 'a2',
      version: 7,
      path: [
        msg({ id: 'g0', parent: null, gen: { kind: 'greeting' }, swipe: { index: 0, count: 2 }, text: 'Hello.' }),
        msg({ id: 'u1', parent: 'g0', role: 'user', text: 'Hi.\nTwo lines.', hidden: true }),
        msg({ id: 'a2', parent: 'u1', swipe: { index: 1, count: 2 }, edited: true, blocks: [{ k: 'reasoning', text: 'r' }, { k: 'text', text: 'Yes.' }] }),
      ],
      pathSet: new Set(['g0', 'u1', 'a2']),
      tails: ['x'],
      vars: {},
      fires: [],
      castNames: [],
      compendium: EMPTY_COMPENDIUM,
    };
    expect(renderNumberedPath(view, { id: 's_1', title: 'Mira' }, names, plain)).toBe(
      [
        'Mira · s_1 · version 7',
        '1. Mira · g0 · greeting 1/2',
        '   Hello.',
        '2. you · u1 · [hidden]',
        '   Hi.',
        '   Two lines.',
        '3. Mira · a2 · swipe 2/2 · [edited]',
        '   Yes.',
        '(1 other branch off this path: /tails)',
      ].join('\n'),
    );
    expect(renderNumberedPath({ ...view, path: [], tails: [] }, { id: 's_1' }, names, plain)).toContain('(no messages yet)');
  });

  test('renderTails', () => {
    expect(renderTails([], names)).toContain('no other branches');
    expect(renderTails([{ id: 'abcd1234', role: 'assistant', depth: 3, words: 'The lamp…' }], names)).toBe(
      '1 branch off this path (/goto <id> switches):\n  abcd1234  #3 Mira: "The lamp…"',
    );
  });

  test('renderBindings and renderNote', () => {
    const roles = { narrator: { conn: 'a', model: 'm', fallback: { conn: 'b', model: 'n' } }, director: 'narrator' as const, recall: { conn: 'c', model: 'r' } };
    expect(renderBindings(roles)).toBe(
      '  narrator a:m (fallback b:n)\n  director narrator (follows)\n  recorder narrator (follows)\n  recall   c:r',
    );
    expect(renderBindings(roles, 'recall')).toBe('  recall   c:r');
    expect(renderNote({})).toContain("no author's note");
    expect(renderNote({ authorNote: { text: 'Rain.', depth: 2, role: 'system' } })).toBe("author's note @2 (system): Rain.");
  });

  test('renderUsage and formatUsd', () => {
    expect(renderUsage({ calls: 0, inputTokens: 0, outputTokens: 0, noUsage: 0, costUsd: null, unpriced: 0 })).toContain('no model answers');
    expect(renderUsage({ calls: 3, inputTokens: 900, outputTokens: 120, noUsage: 1, costUsd: 0.5, unpriced: 1 })).toBe(
      '3 generations on this path · in 900 tok · out 120 tok · cost $0.50\n  (1 without usage from the server; 1 without a price ([prices."conn:model"] in config.toml))',
    );
    expect(renderUsage({ calls: 1, inputTokens: 0, outputTokens: 0, noUsage: 1, costUsd: null, unpriced: 0 })).toBe(
      '1 generation on this path · cost unknown\n  (1 without usage from the server)',
    );
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.00012)).toBe('$0.0001');
    expect(formatUsd(1.234)).toBe('$1.23');
  });

  test('renderTrace', () => {
    const trace: Trace = {
      seed: 1,
      now: '2026-10-26T12:00:00.000Z',
      window: 8192,
      reserve: 1024,
      tokens: { estimated: 2400, reported: 2512 },
      blocks: [
        { src: 'main', role: 'system', tok: 10 },
        { src: 'chat', role: 'user', tok: 5 },
      ],
      lore: { fired: [], cut: [], budget: 0 },
      recap: { ids: [], arcs: [], boundary: null },
      prefill: 'sent',
      macros: { unknown: ['{{foo}}'] },
      trimmed: { from: 'aa', to: 'bb' },
      calls: [{ callKey: 'k', agent: 'narrator', model: 'local:q', ms: 1234 }],
      agents: {},
      presetHash: 'h',
      loreHashes: {},
    };
    expect(renderTrace('a1', { trace, gen: { kind: 'model', connection: 'local', model: 'q' }, continued: false })).toBe(
      [
        'trace of a1 · local:q',
        '  window 8192 · reserve 1024 · prompt ~2400 tok (server: 2512) · 2 messages sent',
        '  trimmed: aa … bb · prefill: sent',
        '  unknown macros: {{foo}}',
        '  calls: narrator local:q 1.2s',
      ].join('\n'),
    );
  });

  test('renderSessionList marks the open session', () => {
    expect(renderSessionList([], 's_1')).toBe('no sessions');
    expect(renderSessionList([{ id: 's_1', title: 'Mira', updated: 'u1' }, { id: 's_2', updated: 'u2' }], 's_1')).toBe('* s_1  u1  Mira\n  s_2  u2');
  });

  test('refusalText: code and a human message, the engine detail when it adds something', () => {
    expect(refusalText('nothing_to_swipe', 'nothing_to_swipe')).toBe('refused [nothing_to_swipe]: there is no answer to swipe');
    expect(refusalText('session_busy', 'a turn is running')).toBe('refused [session_busy]: an answer is being written; wait for it or press Ctrl+C (a turn is running)');
  });
});
