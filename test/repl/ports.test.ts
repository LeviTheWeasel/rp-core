// The REPL's two ports (TUI decisions T-3): a host's own view (ReplOptions.view) gets the banner, the
// echoes, the messages, every event of a turn, the status line and idle() as structure, and command
// output as lines; a host's own line source and Ctrl+C source (ReplOptions.source) replace readline
// and deps.input / deps.onInterrupt: an inline source gets the /e prefill, and its presses drive the
// Ctrl+C rules. The line REPL's own bytes are what every other test/repl file asserts (LineView).
// Also the pieces runChat is built from (chat.ts), which a full-screen host reuses.
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle, SessionHandle } from '../../src/engine/api.ts';
import { chatDeps, endChat, onChatTerm, TERMINATED_LINE } from '../../src/cli/chat.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { loadRuntime } from '../../src/cli/runtime.ts';
import type { SignalSource } from '../../src/cli/signals.ts';
import { helpText } from '../../src/cli/repl-commands.ts';
import { runReplWith, type InterruptSource, type LineSource, type ReplDeps, type ReplOptions } from '../../src/cli/repl.ts';
import type { BannerInfo, ReplView, ReplViewContext, TurnOptions } from '../../src/cli/repl-view.ts';
import { messageText } from '../../src/cli/render.ts';
import type { Event } from '../../src/protocol/events.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall, type ScriptedProvider } from '../../src/providers/scripted.ts';
import type { ModelCaps } from '../../src/providers/types.ts';
import type { DeepPartial, SessionConfig, Trace } from '../../src/session/entries.ts';
import type { MessageView } from '../../src/session/view.ts';
import { dirCall, dirConfig, fullCaps, planOf } from '../engine-m4/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { calls, CONFIG, LEVI, MIRA, typedInput } from './kit.ts';

// ---- a view that records what the Repl hands it ----------------------------------------------------

type Call =
  | { k: 'banner'; info: BannerInfo }
  | { k: 'line'; text: string }
  | { k: 'echo'; line: string }
  | { k: 'message'; m: MessageView; withStatus: boolean }
  | { k: 'turn'; o: TurnOptions }
  | { k: 'push'; ev: Event }
  | { k: 'interject' }
  | { k: 'finish' }
  | { k: 'status'; m: MessageView; trace: Trace | undefined }
  | { k: 'idle'; info: BannerInfo };

function recordingView(): { log: Call[]; factory: (ctx: ReplViewContext) => ReplView; ctx: () => ReplViewContext } {
  const log: Call[] = [];
  let ctx: ReplViewContext | null = null;
  const factory = (c: ReplViewContext): ReplView => {
    ctx = c;
    return {
      line: (text) => void log.push({ k: 'line', text }),
      echo: (line) => void log.push({ k: 'echo', line }),
      message: (m, withStatus) => void log.push({ k: 'message', m, withStatus }),
      banner: (info) => void log.push({ k: 'banner', info }),
      turn(o) {
        log.push({ k: 'turn', o });
        let kept = false;
        return {
          push(ev) {
            log.push({ k: 'push', ev });
            if (ev.type === 'changed' && (ev.change === 'msg' || ev.change === 'edit')) kept = true;
          },
          finish: () => void log.push({ k: 'finish' }),
          interject: () => void log.push({ k: 'interject' }),
          get kept() {
            return kept;
          },
        };
      },
      status: (m, trace) => void log.push({ k: 'status', m, trace }),
      // What a TUI does here: re-read the banner's facts (configure() publishes no event).
      idle: () => void log.push({ k: 'idle', info: c.bannerInfo() }),
    };
  };
  return { log, factory, ctx: () => ctx! };
}

// ---- a host's own line source and Ctrl+C source ----------------------------------------------------

interface FakeSource {
  source: LineSource;
  interrupts: InterruptSource;
  /** Enter: send the line (the typed text is gone from the input). */
  submit(line: string): void;
  /** Keys typed and not sent yet. */
  typeAhead(text: string): void;
  /** Ctrl+C. */
  press(): void;
  end(): void;
  prompts: string[];
  /** The mode each prompt() call carried ('line' | 'edit'). */
  modes: (string | undefined)[];
  prefills: string[];
  mutes: boolean[];
  cleared: number;
  subscribed(): boolean;
}

function fakeSource(o: { inline?: boolean; multiline?: boolean } = {}): FakeSource {
  const lines: string[] = [];
  let ended = false;
  let waiter: (() => void) | null = null;
  let typed = '';
  let muted = false;
  let handler: (() => void) | null = null;
  const wake = (): void => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  const f: FakeSource = {
    source: {
      async next(): Promise<IteratorResult<string>> {
        while (lines.length === 0 && !ended) await new Promise<void>((r) => (waiter = r));
        if (lines.length > 0) return { done: false, value: lines.shift()! };
        return { done: true, value: undefined };
      },
      interactive: true,
      echoes: false,
      inline: o.inline ?? true,
      ...(o.multiline !== undefined ? { multiline: o.multiline } : {}),
      prompt: (text, mode) => {
        f.prompts.push(text);
        f.modes.push(mode);
      },
      mute(on) {
        muted = on;
        f.mutes.push(on);
      },
      get muted() {
        return muted;
      },
      pending: () => typed,
      clearPending() {
        f.cleared++;
        typed = '';
      },
      prefill(text) {
        f.prefills.push(text);
        typed = text;
      },
      suspend: () => () => {},
      close() {
        ended = true;
        wake();
      },
    },
    interrupts: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    submit(line) {
      typed = '';
      lines.push(line);
      wake();
    },
    typeAhead(text) {
      typed = text;
    },
    press: () => handler?.(),
    end() {
      ended = true;
      wake();
    },
    prompts: [],
    modes: [],
    prefills: [],
    mutes: [],
    cleared: 0,
    subscribed: () => handler !== null,
  };
  return f;
}

// ---- the rig ---------------------------------------------------------------------------------------

interface PortRig {
  home: string;
  engine: EngineHandle;
  session: SessionHandle;
  provider: ScriptedProvider;
  log: Call[];
  ctx: () => ReplViewContext;
  /** What reached io.out (the default view's channel): nothing when a view is given. */
  out(): string;
  /** Type a line into the injected deps.input (no `source` given). */
  type(...lines: string[]): void;
  end(): void;
  done: Promise<number>;
  /** Wait until `pred` holds over the log. */
  until(pred: (log: Call[]) => boolean, what: string): Promise<void>;
}

const open: PortRig[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) {
    r.end();
    await r.done;
    await r.engine.close();
  }
});

async function rig(
  script: ScriptCall[],
  o: { config?: DeepPartial<SessionConfig>; caps?: ModelCaps; source?: FakeSource; deps?: Partial<ReplDeps>; before?: (s: SessionHandle) => void } = {},
): Promise<PortRig> {
  const home = tmpHome('rp-core-ports-');
  const provider = createScriptedProvider(script);
  const caps = o.caps ?? SCRIPT_CAPS;
  const conn: Connection = { id: 'script', provider, caps, origin: 'script:script', local: true };
  const engine = await Engine.open({
    home,
    connections: { script: conn, alt: { ...conn, id: 'alt', origin: 'script:alt' } },
    clock: fakeClock(),
    random: fakeRandom(7),
    timeZone: 'UTC',
    checkpoint: { chars: 8, ms: 5, datasyncMs: 5 },
    retryMaxDelayMs: 5,
  });
  const session = engine.createSession({ character: MIRA, persona: LEVI, ...(o.config ? { config: o.config } : {}) });
  o.before?.(session);
  const out = memoryChannel();
  const err = memoryChannel();
  const typed = typedInput();
  const view = recordingView();
  const deps: ReplDeps = {
    engine,
    session,
    config: CONFIG,
    home,
    io: { out, err },
    color: false,
    capsOf: (c) => (c === 'script' || c === 'alt' ? caps : null),
    ...(o.source ? {} : { input: typed.input, onInterrupt: () => () => {} }),
    ...o.deps,
  };
  // No $VISUAL / $EDITOR: /e edits in place.
  const opts: ReplOptions = { view: view.factory, env: {}, ...(o.source ? { source: { source: o.source.source, interrupts: o.source.interrupts } } : {}) };
  const done = runReplWith(deps, opts);
  const r: PortRig = {
    home,
    engine,
    session,
    provider,
    log: view.log,
    ctx: view.ctx,
    out: () => out.text(),
    type: typed.type,
    end: () => {
      typed.end();
      o.source?.end();
    },
    done,
    async until(pred, what) {
      for (let waited = 0; !pred(view.log); waited += 2) {
        if (waited > 5000) throw new Error(`timed out waiting for ${what}; log:\n${kinds(view.log).join(' ')}`);
        await new Promise((res) => setTimeout(res, 2));
      }
    },
  };
  open.push(r);
  return r;
}

const kinds = (log: Call[]): string[] => log.map((c) => (c.k === 'push' ? `push:${c.ev.type}` : c.k));
const count = (log: Call[], k: Call['k']): number => log.filter((c) => c.k === k).length;
const of = <K extends Call['k']>(log: Call[], k: K): Extract<Call, { k: K }>[] => log.filter((c): c is Extract<Call, { k: K }> => c.k === k);
const pushes = (log: Call[]): Event[] => of(log, 'push').map((c) => c.ev);
const lines = (log: Call[]): string[] => of(log, 'line').map((c) => c.text);

/** A session whose history cannot fit its small window, so a turn offers search_history (as m3-flows). */
function longHistory(s: SessionHandle, n = 40): void {
  for (let i = 1; i <= n; i++) {
    const filler = ' The road goes on through the dunes and the wind keeps blowing sand into every pack and every boot.'.repeat(3);
    s.send({ text: `Day ${i}: ${i === 3 ? 'the caravan moves on.' : 'we walk on.'}${filler}`, expectedVersion: s.version() });
  }
}
const SMALL_WINDOW = { window: 3000, roles: { narrator: { conn: 'script', model: 'default', maxTokens: 64 } } } as const;

// ---- the output port -------------------------------------------------------------------------------

describe('ReplView: what the Repl hands a host view', () => {
  test('banner on greet, the greeting as a message, idle; echo, a turn, its status; command output as lines; nothing on io.out', async () => {
    const r = await rig(calls([{ text: 'The lamp gutters.' }, { usage: { inputTotal: 40, outputTotal: 4 } }]));
    await r.until((l) => count(l, 'idle') === 1, 'the first idle');
    expect(kinds(r.log)).toEqual(['banner', 'message', 'idle']);
    const banner = of(r.log, 'banner')[0]!.info;
    expect(banner.session.id).toBe(r.session.id);
    expect(banner.header.cast.character.name).toBe('Mira');
    expect(banner.names).toEqual({ char: 'Mira', user: 'you ', width: 4 });
    expect(banner.narrator).toMatchObject({ conn: 'script', model: 'default' });
    expect(banner.window).toBeNull();
    expect(banner.tools).toBe('none');
    expect(banner.director).toBeNull();
    expect(banner.override).toBeUndefined();
    expect(banner.journal.header.id).toBe(r.session.id);
    const greeting = of(r.log, 'message')[0]!;
    expect(greeting.m.gen?.kind).toBe('greeting');
    expect(greeting.withStatus).toBe(true);

    r.type('  Hello there.  ');
    await r.until((l) => count(l, 'idle') === 2, 'the idle after the turn');
    const turn = r.log.slice(3);
    // The player's line (trimmed), then the turn: every event in order, from start to the terminal one.
    expect(turn[0]).toEqual({ k: 'echo', line: 'Hello there.' });
    const t = turn[1] as Extract<Call, { k: 'turn' }>;
    expect(t.k).toBe('turn');
    expect(t.o.label).toBe('Mira');
    expect(t.o.continueFrom).toBeUndefined();
    expect(t.o.showReasoning()).toBe(false);
    const evs = pushes(r.log);
    expect(evs[0]!.type).toBe('start');
    expect(evs.at(-1)!.type).toBe('done');
    const types = evs.map((e) => e.type);
    expect(types).toContain('text');
    expect(types).toContain('usage');
    expect(types.indexOf('usage')).toBeLessThan(types.indexOf('done'));
    expect(evs.filter((e) => e.type === 'text').map((e) => (e as Extract<Event, { type: 'text' }>).delta).join('')).toBe('The lamp gutters.');
    // finish, then the status of the committed answer (with its trace), then idle.
    expect(kinds(r.log).slice(-3)).toEqual(['finish', 'status', 'idle']);
    const status = of(r.log, 'status')[0]!;
    const done = evs.at(-1) as Extract<Event, { type: 'done' }>;
    expect(status.m.id).toBe(done.message.id);
    expect(messageText(status.m)).toBe('The lamp gutters.');
    expect(status.trace).toBeDefined();

    // A command: the echo, then its report as a line.
    r.type('/help');
    await r.until((l) => count(l, 'idle') === 3, 'the idle after /help');
    expect(kinds(r.log).slice(-3)).toEqual(['echo', 'line', 'idle']);
    expect(lines(r.log).at(-1)).toBe(helpText());

    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toBe('');
  });

  test("a Director turn: planning and planned reach the turn view before the narrator's text", async () => {
    const r = await rig(calls(dirCall(planOf(), [{ usage: { inputTotal: 900, outputTotal: 120 } }]), [{ text: 'The lamp gutters.' }]), { config: dirConfig(), caps: fullCaps() });
    await r.until((l) => count(l, 'idle') === 1, 'the first idle');
    const banner = of(r.log, 'banner')[0]!.info;
    expect(banner.director).toEqual({ conn: 'script', model: 'default', follows: true, profile: 'auto' });
    r.type('I look around.');
    await r.until((l) => count(l, 'idle') === 2, 'the idle after the turn');
    const evs = pushes(r.log);
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe('start');
    const dir = evs.filter((e): e is Extract<Event, { type: 'director' }> => e.type === 'director').map((e) => e.status);
    expect(dir).toEqual(['planning', 'planned']);
    expect(types.lastIndexOf('director')).toBeLessThan(types.indexOf('text'));
    // The Director's call reports its usage on the turn too.
    expect(evs.some((e) => e.type === 'usage' && e.agent === 'director')).toBe(true);
    expect(types.at(-1)).toBe('done');
    expect(kinds(r.log).slice(-3)).toEqual(['finish', 'status', 'idle']);
  });

  test('a tool round: the tool events reach the turn view between start and the answer', async () => {
    const r = await rig(calls([{ tool: { name: 'search_history', args: { query: 'caravan' } } }], [{ text: 'The caravan left at dawn.' }]), {
      caps: { ...SCRIPT_CAPS, tools: 'native' },
      config: SMALL_WINDOW,
      before: (s) => longHistory(s),
    });
    await r.until((l) => count(l, 'idle') === 1, 'the first idle');
    // The head is the player's unanswered line: the answer before it with its status, the line without.
    expect(of(r.log, 'message').map((c) => [c.m.role, c.withStatus])).toEqual([['user', false]]);
    expect(lines(r.log)).toEqual(['(your message has no answer yet: /r asks for one, or type more)']);
    r.type('Where did the caravan go?');
    await r.until((l) => count(l, 'idle') === 2, 'the idle after the turn');
    const evs = pushes(r.log);
    const tools = evs.filter((e): e is Extract<Event, { type: 'tool' }> => e.type === 'tool');
    expect(tools.map((e) => [e.name, e.phase])).toEqual([
      ['search_history', 'start'],
      ['search_history', 'done'],
    ]);
    const types = evs.map((e) => e.type);
    expect(types.indexOf('start')).toBe(0);
    expect(types.lastIndexOf('tool')).toBeLessThan(types.indexOf('text'));
    expect(types.at(-1)).toBe('done');
  });

  test('bannerInfo() on idle sees what configure() changed; /fork gives a banner of the new session', async () => {
    const r = await rig(calls());
    await r.until((l) => count(l, 'idle') === 1, 'the first idle');
    r.type('/director on');
    await r.until((l) => count(l, 'idle') === 2, 'the idle after /director on');
    expect(of(r.log, 'idle')[1]!.info.director).toEqual({ conn: 'script', model: 'default', follows: true, profile: 'auto' });
    r.type('/model narrator alt:big');
    await r.until((l) => count(l, 'idle') === 3, 'the idle after /model');
    expect(of(r.log, 'idle')[2]!.info.narrator).toMatchObject({ conn: 'alt', model: 'big' });
    expect(r.ctx().bannerInfo().config.director.enabled).toBe(true);
    // Only the greeting banner so far: configure() does not re-greet.
    expect(count(r.log, 'banner')).toBe(1);

    r.type('/fork');
    await r.until((l) => count(l, 'idle') === 4, 'the idle after /fork');
    const banners = of(r.log, 'banner');
    expect(banners).toHaveLength(2);
    const forked = banners[1]!.info.session.id;
    expect(forked).not.toBe(r.session.id);
    expect(lines(r.log)).toContain(`forked into ${forked} (messages 1–1)`);
    expect(of(r.log, 'idle')[3]!.info.session.id).toBe(forked);
    r.end();
    expect(await r.done).toBe(0);
  });
});

// ---- the input port --------------------------------------------------------------------------------

describe('LineSource / InterruptSource: a host input', () => {
  test('ReplOptions.source replaces deps.input and deps.onInterrupt; prompt() labels the inline input', async () => {
    let depsSubscribed = false;
    const f = fakeSource();
    const unused = typedInput();
    const r = await rig(calls([{ text: 'The lamp gutters.' }]), {
      source: f,
      deps: {
        input: unused.input,
        onInterrupt: () => {
          depsSubscribed = true;
          return () => {};
        },
      },
    });
    await r.until((l) => count(l, 'idle') === 1, 'the first idle');
    expect(f.subscribed()).toBe(true);
    expect(depsSubscribed).toBe(false);
    expect(f.prompts).toEqual(['you  › ']);
    f.submit('Hello.');
    await r.until((l) => count(l, 'idle') === 2, 'the idle after the turn');
    // The source does not echo: the Repl echoes through the view. It mutes the source while the turn streams.
    expect(of(r.log, 'echo').map((c) => c.line)).toEqual(['Hello.']);
    expect(f.mutes).toEqual([true, false]);
    expect(f.prompts).toEqual(['you  › ', 'you  › ']);
    r.end();
    expect(await r.done).toBe(0);
  });

  test('inline /e: the message is prefilled into an inline source under "edit › "; the line sent back is saved, real line breaks too', async () => {
    const f = fakeSource();
    const r = await rig(calls(), { source: f });
    await r.until((l) => count(l, 'idle') === 1, 'the first idle');
    const greeting = r.session.view().path[0]!;
    f.submit('/e');
    await r.until(() => f.prefills.length === 1, 'the prefill');
    expect(f.prefills).toEqual([messageText(greeting)]);
    expect(f.prompts).toEqual(['you  › ', 'edit › ']);
    expect(lines(r.log).at(-1)).toContain('editing in place: Enter saves · Ctrl+C cancels');
    f.submit('First line.\nSecond line.');
    await r.until((l) => count(l, 'idle') === 2, 'the idle after the edit');
    const now = r.session.view().path[0]!;
    expect(now.id).toBe(greeting.id);
    expect(messageText(now)).toBe('First line.\nSecond line.');
    expect(lines(r.log)).toContain('edited message 1');
    const edited = of(r.log, 'message').at(-1)!;
    expect(edited.m.id).toBe(greeting.id);
    expect(edited.withStatus).toBe(false);
    // Back at the prompt: the label is the player's again.
    expect(f.prompts).toEqual(['you  › ', 'edit › ', 'you  › ']);

    // Ctrl+C while editing in place cancels: the input is cleared, the message stays.
    f.submit('/e');
    await r.until(() => f.prefills.length === 2, 'the second prefill');
    expect(f.prefills[1]).toBe('First line.⏎Second line.');
    f.press();
    await r.until((l) => count(l, 'idle') === 3, 'the idle after the cancel');
    expect(f.cleared).toBe(1);
    expect(lines(r.log)).toContain('edit cancelled');
    expect(messageText(r.session.view().path[0]!)).toBe('First line.\nSecond line.');
    r.end();
    expect(await r.done).toBe(0);
  });

  test('prompt() says whether an in-place edit is open: line, edit, line', async () => {
    const f = fakeSource();
    const r = await rig(calls(), { source: f });
    await r.until((l) => count(l, 'idle') === 1, 'the first idle');
    f.submit('/e');
    await r.until(() => f.prefills.length === 1, 'the prefill');
    expect(f.modes).toEqual(['line', 'edit']);
    f.press();
    await r.until((l) => count(l, 'idle') === 2, 'the idle after the cancel');
    expect(f.modes).toEqual(['line', 'edit', 'line']);
    r.end();
    expect(await r.done).toBe(0);
  });

  test('a multiline source: /e prefills real line breaks, saves the line as sent, and edits a message holding ⏎', async () => {
    const f = fakeSource({ multiline: true });
    const r = await rig(calls(), { source: f });
    await r.until((l) => count(l, 'idle') === 1, 'the first idle');
    f.submit('/e');
    await r.until(() => f.prefills.length === 1, 'the prefill');
    expect(lines(r.log).at(-1)).toBe('editing in place: Enter saves · Esc or Ctrl+C cancels');
    f.submit('One ⏎ arrow stays.\nSecond line.');
    await r.until((l) => count(l, 'idle') === 2, 'the idle after the edit');
    expect(messageText(r.session.view().path[0]!)).toBe('One ⏎ arrow stays.\nSecond line.');
    // The message now holds ⏎ itself: a multiline source still edits it, prefilled as is.
    f.submit('/e');
    await r.until(() => f.prefills.length === 2, 'the second prefill');
    expect(f.prefills[1]).toBe('One ⏎ arrow stays.\nSecond line.');
    expect(lines(r.log).some((x) => x.includes('set $EDITOR to edit it'))).toBe(false);
    f.press();
    await r.until((l) => count(l, 'idle') === 3, 'the idle after the cancel');
    r.end();
    expect(await r.done).toBe(0);
  });

  test('a source without an input line (inline false, no echo) gets no prefill: the next line is the new text', async () => {
    const f = fakeSource({ inline: false });
    const r = await rig(calls(), { source: f });
    await r.until((l) => count(l, 'idle') === 1, 'the first idle');
    expect(f.prompts).toEqual([]);
    f.submit('/e');
    await r.until((l) => lines(l).some((x) => x.startsWith('editing in place')), 'the edit hint');
    f.submit('Plain.');
    await r.until((l) => count(l, 'idle') === 2, 'the idle after the edit');
    expect(f.prefills).toEqual([]);
    expect(messageText(r.session.view().path[0]!)).toBe('Plain.');
  });

  test('Ctrl+C at the prompt: typed text is cleared first; then a hint; a second press quits', async () => {
    const f = fakeSource();
    const r = await rig(calls(), { source: f });
    await r.until((l) => count(l, 'idle') === 1, 'the first idle');
    f.typeAhead('half a thought');
    f.press();
    expect(f.cleared).toBe(1);
    expect(lines(r.log)).toEqual([]);
    f.press();
    expect(lines(r.log)).toEqual(['(press Ctrl+C again to quit, or type /quit)']);
    f.press();
    expect(await r.done).toBe(0);
    expect(f.subscribed()).toBe(false);
  });

  test('Ctrl+C during a turn stops it (the stopped event reaches the turn view, the partial answer gets its status); text typed meanwhile is held', async () => {
    const f = fakeSource();
    const r = await rig(calls([{ text: 'Once upon' }, { pause: 'p' }, { text: ' a time.' }], [{ text: 'Held answer.' }]), { source: f });
    await r.until((l) => count(l, 'idle') === 1, 'the first idle');
    f.submit('Tell me a story.');
    await r.until((l) => pushes(l).some((e) => e.type === 'text'), 'the first text');
    // A line sent mid-turn is held (said through the view, with the turn interjected first).
    f.submit('And then?');
    await r.until((l) => lines(l).includes('(held: sent when this answer ends)'), 'the held note');
    const held = r.log.findIndex((c) => c.k === 'line' && c.text === '(held: sent when this answer ends)');
    expect(r.log[held - 1]).toEqual({ k: 'interject' });
    // An editing command mid-turn is refused.
    f.submit('/hide 1');
    await r.until((l) => lines(l).some((x) => x.startsWith('refused [session_busy]: /hide')), 'the refusal');
    f.press();
    await r.until((l) => pushes(l).some((e) => e.type === 'stopped'), 'the stopped event');
    // The held line runs once the stopped turn settled: a second turn answers it.
    await r.until((l) => count(l, 'turn') === 2 && count(l, 'idle') === 2, 'the held turn');
    const statuses = of(r.log, 'status');
    expect(statuses).toHaveLength(2);
    expect(messageText(statuses[0]!.m)).toBe('Once upon');
    expect(statuses[0]!.m.gen?.finish).toBe('stopped');
    expect(messageText(statuses[1]!.m)).toBe('Held answer.');
    expect(of(r.log, 'echo').map((c) => c.line)).toEqual(['Tell me a story.', '/hide 1', 'And then?']);
    r.end();
    expect(await r.done).toBe(0);
  });
});

// ---- the chat host pieces (chat.ts) ----------------------------------------------------------------

describe('chatDeps / onChatTerm / endChat', () => {
  test('chatDeps: the deps runChat gives the REPL; the --debug tap swaps rt.debug while the REPL runs', async () => {
    const home = tmpHome('rp-core-ports-');
    const plain = (_line: string): void => {};
    const rt = loadRuntime(home, {}, { debug: plain });
    const engine = await Engine.open({ home, connections: {}, clock: fakeClock(), random: fakeRandom(7), timeZone: 'UTC' });
    try {
      const session = engine.createSession({ character: MIRA, persona: LEVI });
      const io = { out: memoryChannel(), err: memoryChannel() };
      const deps = chatDeps(engine, session, { rt, io });
      expect(deps.engine).toBe(engine);
      expect(deps.session).toBe(session);
      expect(deps.io).toBe(io);
      expect(deps.home).toBe(home);
      expect(deps.config).toBe(rt.config);
      expect(typeof deps.openSession).toBe('function');
      expect(typeof deps.windowOf).toBe('function');
      expect(typeof deps.capsOf).toBe('function');
      expect(typeof deps.redact).toBe('function');
      expect(typeof deps.probe).toBe('function');
      expect(deps.connectionProblem?.('nowhere')).toContain('nowhere');
      expect(deps.failExit).toBeUndefined();
      expect(deps.override).toBeUndefined();
      const print = (_line: string): void => {};
      const untap = deps.debugTap!(print);
      expect(rt.debug).toBe(print);
      untap();
      expect(rt.debug).toBe(plain);

      // Under --provider script: every turn plays the script: failExit and the override, no connection check.
      const provider: Connection = { id: 'script', provider: createScriptedProvider(calls()), caps: SCRIPT_CAPS, origin: 'script:/tmp/x.jsonl', local: true };
      const scripted = chatDeps(engine, session, { rt: { ...loadRuntime(home, {}), provider }, io });
      expect(scripted.failExit).toBe(true);
      expect(scripted.override).toMatchObject({ conn: 'script', plays: 'script' });
      expect(scripted.connectionProblem).toBeUndefined();
      expect(scripted.debugTap).toBeUndefined();
    } finally {
      await engine.close();
    }
  });

  test('onChatTerm: the line and the exit go through the injected functions; the engine closes first; a second SIGTERM leaves at once', async () => {
    const signals = new EventEmitter();
    let closing: (() => void) | null = null;
    let closes = 0;
    const engine = {
      close: () => {
        closes++;
        return new Promise<void>((r) => (closing = r));
      },
    } as unknown as EngineHandle;
    const said: string[] = [];
    const exits: number[] = [];
    const off = onChatTerm(engine, { signals: signals as unknown as SignalSource, say: (l) => void said.push(l), exitNow: (c) => void exits.push(c) });
    signals.emit('SIGTERM');
    expect(said).toEqual([TERMINATED_LINE]);
    expect(closes).toBe(1);
    expect(exits).toEqual([]);
    closing!();
    await new Promise((r) => setTimeout(r, 0));
    expect(exits).toEqual([143]);
    signals.emit('SIGTERM');
    expect(exits).toEqual([143, 143]);
    expect(said).toHaveLength(1);
    off();
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  test('endChat: 0 after the engine closed; 130 without waiting for it', async () => {
    let closes = 0;
    const never = { close: () => (closes++, new Promise<void>(() => {})) } as unknown as EngineHandle;
    expect(await endChat(never, 130)).toBe(130);
    expect(closes).toBe(1);
    const fine = { close: () => Promise.resolve() } as unknown as EngineHandle;
    expect(await endChat(fine, 0)).toBe(0);
    expect(await endChat(fine, 3)).toBe(3);
  });
});
