// Pure parts of the CLI: flag parsing, signal policy, rendering, exit codes.
import { describe, expect, test } from 'bun:test';
import { parseArgs, UsageError, type FlagSpec } from '../../src/cli/args.ts';
import { resolveHome } from '../../src/cli/home.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { EXIT, exitCodeOf } from '../../src/cli/oneshot.ts';
import { parseProviderSpec } from '../../src/cli/provider.ts';
import { createTextRenderer, describeEvent, messageHeading, renderPath, renderSessions } from '../../src/cli/render.ts';
import { EXIT_SIGINT, EXIT_SIGTERM, installTurnSignals, type CliSignal, type SignalSource } from '../../src/cli/signals.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { MessageView, PathView } from '../../src/session/view.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { unclosedTurnsHint } from '../../src/cli/commands.ts';
import { tmpHome } from '../helpers.ts';

const SPEC: FlagSpec = {
  flags: { json: 'bool', kind: 'string', guidance: 'string', home: 'string' },
  short: { h: 'json' },
};

describe('parseArgs', () => {
  test('flags with separate and inline values, positionals in between', () => {
    const p = parseArgs(['s_1', '--kind', 'swipe', 'hello', '--home=/tmp/x', '--json'], SPEC);
    expect(p.positionals).toEqual(['s_1', 'hello']);
    expect(p.flags).toEqual({ kind: 'swipe', home: '/tmp/x', json: true });
  });

  test('-- ends the flags and a lone - is positional', () => {
    const p = parseArgs(['s_1', '-', '--', '--json', '-x'], SPEC);
    expect(p.positionals).toEqual(['s_1', '-', '--json', '-x']);
    expect(p.flags).toEqual({});
  });

  test('a value may start with a dash unless it is a known flag', () => {
    expect(parseArgs(['--guidance', '-be kind-'], SPEC).flags.guidance).toBe('-be kind-');
    expect(() => parseArgs(['--guidance', '--json'], SPEC)).toThrow('--guidance needs a value');
  });

  test.each([
    [['--nope'], 'unknown flag --nope'],
    [['-z'], 'unknown flag -z'],
    [['--json', '--json'], '--json given twice'],
    [['--json=yes'], '--json takes no value'],
    [['--kind'], '--kind needs a value'],
    [['--'], null],
  ] as [string[], string | null][])('strict: %p', (argv, message) => {
    if (message === null) {
      expect(parseArgs(argv, SPEC).positionals).toEqual([]);
      return;
    }
    expect(() => parseArgs(argv, SPEC)).toThrow(UsageError);
    expect(() => parseArgs(argv, SPEC)).toThrow(message);
  });

  test('short aliases map to long names', () => {
    expect(parseArgs(['-h'], SPEC).flags).toEqual({ json: true });
  });

  test('stopAtPositional leaves the command and its arguments untouched', () => {
    const p = parseArgs(['--home', '/h', 'send', '--bogus'], SPEC, { stopAtPositional: true });
    expect(p.flags).toEqual({ home: '/h' });
    expect(p.positionals).toEqual(['send', '--bogus']);
  });

  test('a UsageError remembers its command for the usage line', () => {
    try {
      parseArgs(['--nope'], SPEC, { command: 'send' });
      throw new Error('unreachable');
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      expect((e as UsageError).command).toBe('send');
    }
  });
});

describe('home resolution', () => {
  test('--home beats RP_CORE_HOME beats ~/.rp-core', () => {
    expect(resolveHome({ home: '/a', sandbox: false, env: { RP_CORE_HOME: '/b' } }).dir).toBe('/a');
    expect(resolveHome({ sandbox: false, env: { RP_CORE_HOME: '/b' } }).dir).toBe('/b');
    expect(resolveHome({ sandbox: false, env: {} }).dir.endsWith('.rp-core')).toBe(true);
  });

  test('--sandbox makes a temporary home that dispose removes; with --home it is a usage error', () => {
    const h = resolveHome({ sandbox: true, env: {} });
    expect(h.sandbox).toBe(true);
    expect(existsSync(h.dir)).toBe(true);
    h.dispose();
    h.dispose();
    expect(existsSync(h.dir)).toBe(false);
    expect(() => resolveHome({ home: '/a', sandbox: true, env: {} })).toThrow(UsageError);
  });
});

describe('provider spec', () => {
  test('script:<file> only; record/replay are M2', () => {
    expect(parseProviderSpec('script:a/b.jsonl')).toEqual({ scheme: 'script', file: 'a/b.jsonl' });
    expect(() => parseProviderSpec('record:x')).toThrow('M2');
    expect(() => parseProviderSpec('openai:x')).toThrow(UsageError);
    expect(() => parseProviderSpec('script:')).toThrow(UsageError);
  });
});

describe('exit codes', () => {
  test('§12.3 table', () => {
    const msg = { id: 'm', parent: null, role: 'assistant', blocks: [], hidden: false, edited: false, swipe: { index: 0, count: 1 } } as MessageView;
    expect(exitCodeOf({ type: 'done', message: msg })).toBe(0);
    expect(exitCodeOf({ type: 'stopped', message: null })).toBe(2);
    expect(exitCodeOf({ type: 'failed', category: 'auth', code: 'auth_failed', message: '', draft: '' })).toBe(3);
    expect(exitCodeOf({ type: 'conflict', draft: '' })).toBe(4);
    expect(EXIT.refused).toBe(5);
    expect(EXIT.usage).toBe(64);
  });
});

/** A fake process for the signal policy. */
function fakeSignals(): SignalSource & { fire(s: CliSignal): void; count(): number } {
  const listeners = new Map<CliSignal, Set<() => void>>();
  return {
    on(s, fn) {
      if (!listeners.has(s)) listeners.set(s, new Set());
      listeners.get(s)!.add(fn);
    },
    removeListener(s, fn) {
      listeners.get(s)?.delete(fn);
    },
    fire(s) {
      for (const fn of [...(listeners.get(s) ?? [])]) fn();
    },
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe('signals', () => {
  function rig() {
    const src = fakeSignals();
    const log: string[] = [];
    const sig = installTurnSignals(
      {
        stop: () => log.push('stop'),
        shutdown: () => log.push('shutdown'),
        exitNow: (code) => log.push(`exit ${code}`),
        note: () => log.push('note'),
      },
      src,
    );
    return { src, log, sig };
  }

  test('first SIGINT stops the turn; the second exits 130 at once', () => {
    const { src, log, sig } = rig();
    src.fire('SIGINT');
    expect(log).toEqual(['note', 'stop']);
    expect(sig.exitOverride()).toBeNull();
    src.fire('SIGINT');
    expect(log).toEqual(['note', 'stop', `exit ${EXIT_SIGINT}`]);
  });

  test('SIGTERM shuts down and imposes 143; a second SIGTERM or a SIGINT exits at once', () => {
    const { src, log, sig } = rig();
    src.fire('SIGTERM');
    expect(log).toEqual(['shutdown']);
    expect(sig.exitOverride()).toBe(EXIT_SIGTERM);
    src.fire('SIGINT');
    expect(log).toEqual(['shutdown', `exit ${EXIT_SIGINT}`]);
    src.fire('SIGTERM');
    expect(log).toEqual(['shutdown', `exit ${EXIT_SIGINT}`, `exit ${EXIT_SIGTERM}`]);
  });

  test('SIGTERM after a SIGINT still closes the session and exits 143', () => {
    const { src, log, sig } = rig();
    src.fire('SIGINT');
    src.fire('SIGTERM');
    expect(log).toEqual(['note', 'stop', 'shutdown']);
    expect(sig.exitOverride()).toBe(EXIT_SIGTERM);
  });

  test('dispose removes both handlers', () => {
    const { src, log, sig } = rig();
    expect(src.count()).toBe(2);
    sig.dispose();
    sig.dispose();
    expect(src.count()).toBe(0);
    src.fire('SIGINT');
    expect(log).toEqual([]);
  });
});

const msg = (over: Partial<MessageView>): MessageView => ({
  id: '0000aaaa',
  parent: null,
  role: 'assistant',
  blocks: [{ k: 'text', text: 'Hi.' }],
  hidden: false,
  edited: false,
  swipe: { index: 0, count: 1 },
  ...over,
});

const ev = (body: Record<string, unknown>): Event => ({ sessionId: 's_1', ts: '2026-10-26T12:00:00.000Z', ...body }) as Event;

describe('render', () => {
  test('headings: greeting position, swipe position, finish and state markers', () => {
    expect(messageHeading(msg({ gen: { kind: 'greeting' }, swipe: { index: 0, count: 3 } }))).toBe('assistant · 0000aaaa · greeting 1/3');
    expect(messageHeading(msg({ gen: { kind: 'model', finish: 'interrupted' }, swipe: { index: 1, count: 2 } }))).toBe(
      'assistant · 0000aaaa · swipe 2/2 · [interrupted]',
    );
    expect(messageHeading(msg({ gen: { kind: 'model', finish: 'stopped' }, hidden: true, edited: true }))).toBe(
      'assistant · 0000aaaa · swipe 1/1 · [stopped] · [hidden] · [edited]',
    );
    expect(messageHeading(msg({ role: 'user' }))).toBe('user · 0000aaaa');
  });

  test('renderPath indents text, flags empty text and counts other branches', () => {
    const view = {
      session: 's_1',
      head: 'b',
      version: 4,
      path: [msg({ id: 'a', blocks: [{ k: 'text', text: 'one\ntwo' }] }), msg({ id: 'b', role: 'user', blocks: [] })],
      pathSet: new Set(['a', 'b']),
      tails: ['c'],
      vars: {},
      fires: [],
      castNames: [],
    } satisfies PathView;
    const out = renderPath(view, { id: 's_1', title: 'Mira' });
    expect(out).toBe('Mira · s_1 · version 4\n\nassistant · a · swipe 1/1\n  one\n  two\n\nuser · b\n  (no text)\n\n(1 other branch off this path)\n');
  });

  test('renderSessions', () => {
    expect(renderSessions([])).toBe('');
    expect(renderSessions([{ id: 's_1', title: 'Mira', updated: 'T' }, { id: 's_2', updated: 'U' }])).toBe('s_1  T  Mira\ns_2  U\n');
  });

  test('describeEvent covers recovery, notices, stops and failures', () => {
    expect(describeEvent(ev({ type: 'recovered', turnId: 't', outcome: 'interrupted' }))).toContain('[interrupted]');
    // A dropped recovery hands the partial answer back: the CLI shows it rather than losing it.
    const dropped = describeEvent(ev({ type: 'recovered', turnId: 't', outcome: 'dropped', draft: 'Half an answer' }))!;
    expect(dropped).toContain('the message it answered is hidden');
    expect(dropped).toContain('Half an answer');
    expect(describeEvent(ev({ type: 'recovered', turnId: 't', outcome: 'abandoned' }))).toContain('nothing worth keeping');
    expect(describeEvent(ev({ type: 'notice', level: 'warn', code: 'x', message: 'careful' }))).toBe('warn: careful (x)');
    expect(describeEvent(ev({ type: 'stopped', turnId: 't', message: null }))).toContain('nothing was kept');
    expect(describeEvent(ev({ type: 'failed', turnId: 't', category: 'auth', code: 'auth_failed', message: 'no', draft: '' }))).toBe(
      'the answer failed (auth/auth_failed): no',
    );
    expect(describeEvent(ev({ type: 'text', turnId: 't', delta: 'x', offset: 0 }))).toBeNull();
  });

  test('text renderer: deltas to stdout with one final newline, the rest to stderr', () => {
    const out = memoryChannel();
    const err = memoryChannel();
    const r = createTextRenderer({ out, err }, { debug: false });
    r.push(ev({ type: 'start', turnId: 't', kind: 'reply', messageId: 'm', parentId: 'u' }));
    r.push(ev({ type: 'text', turnId: 't', delta: 'Hello ', offset: 0 }));
    r.push(ev({ type: 'notice', level: 'info', code: 'n', message: 'fyi' }));
    r.push(ev({ type: 'text', turnId: 't', delta: 'there.', offset: 6 }));
    r.push(ev({ type: 'done', turnId: 't', message: msg({ blocks: [{ k: 'text', text: 'Hello there.' }] }) }));
    r.finish();
    expect(out.text()).toBe('Hello there.\n');
    expect(err.text()).toBe('rp-core: info: fyi (n)\n');
  });

  test('text renderer: a done without deltas prints the authoritative text', () => {
    const out = memoryChannel();
    const r = createTextRenderer({ out, err: memoryChannel() }, { debug: false });
    r.push(ev({ type: 'done', turnId: 't', message: msg({ blocks: [{ k: 'text', text: 'Whole.\n' }] }) }));
    r.finish();
    expect(out.text()).toBe('Whole.\n');
  });

  test('text renderer: a kept failure says so; debug adds the raw event', () => {
    const out = memoryChannel();
    const err = memoryChannel();
    const r = createTextRenderer({ out, err }, { debug: true });
    r.push(ev({ type: 'text', turnId: 't', delta: 'Half', offset: 0 }));
    r.push(ev({ type: 'changed', version: 9, change: 'msg', id: 'm' }));
    r.push(ev({ type: 'failed', turnId: 't', category: 'network', code: 'truncated_stream', message: 'reset', draft: 'Half' }));
    expect(out.text()).toBe('Half\n');
    const lines = err.text().trimEnd().split('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'failed', code: 'truncated_stream' });
    expect(lines.slice(1)).toEqual([
      'rp-core: the answer failed (network/truncated_stream): reset',
      'rp-core: the partial answer was kept, marked [interrupted]',
    ]);
  });
});

describe('show: unclosed turns hint', () => {
  const turn = { t: 'turn', seq: 5, ts: 'T', turn: 't_1', kind: 'reply', parent: 'u', msgId: 'm', seed: 1, now: 'T', base: 4 } as const;
  const chk = { t: 'chk', seq: 6, turn: 't_1', text: 'partial' } as const;

  test('no open turns: no hint', () => {
    const home = tmpHome('rp-core-cli-');
    expect(unclosedTurnsHint(home, 's_1', [turn, { t: 'end', seq: 7, ts: 'T', turn: 't_1', outcome: 'failed' }])).toBeNull();
  });

  test('an open turn and no live lock: interrupted, recovered by the next send', () => {
    const home = tmpHome('rp-core-cli-');
    expect(unclosedTurnsHint(home, 's_1', [turn, chk])).toContain('1 interrupted turn (7 chars of partial text)');
  });

  test('an open turn under a live lock: running in another process', () => {
    const home = tmpHome('rp-core-cli-');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    const now = new Date(Date.now()).toISOString();
    writeFileSync(join(home, 'sessions', 's_1.lock'), JSON.stringify({ pid: process.pid, host: hostname(), started: now, renewed: now }));
    expect(unclosedTurnsHint(home, 's_1', [turn, chk])).toContain(`running in process ${process.pid}`);
  });
});
