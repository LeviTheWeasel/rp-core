# TUI unit `host`: contract

Unit `host` (TUI decisions T-1, T-3, T-4, T-6, T-9, T-10). Files: `src/cli/tui/{app,source,keys,io,view,run,index}.ts`,
`src/cli/main.ts` (the `tui` command and `new --tui` only), tests `test/tui/{host,keys,lifecycle}.test.ts` +
`test/tui/kit.ts` (tuiRig, cloned from test/repl/kit.ts replRig; drives runTui with a headless renderer).
`bunx tsc --noEmit -p .` clean; test/tui host+keys+lifecycle: 50 tests.

## Exports

```ts
// app.ts
export function rendererConfig(useMouse = false): CliRendererConfig;
//   exitOnCtrlC false; exitSignals SIGTERM,SIGQUIT,SIGABRT,SIGHUP,SIGPIPE,SIGBUS (no SIGINT); targetFps 30, maxFps 60;
//   autoFocus false; openConsoleOnError false; useMouse (F3, default off); no backgroundColor.
export interface HostUi extends Ui {
  inputRow: BoxRenderable;            // [label][input] row under the status line
  label: TextRenderable;              // `you  › ` / `edit › ` (yellow while editing)
  setLabel(text: string): void;
  setStatus(text: string, tone?: 'dim' | 'yellow' | 'red' | 'plain'): void;
  fitInput(): void;                   // 1..LAYOUT.inputMaxRows rows; registered on renderer 'frame'
}
export function createUi(renderer: CliRenderer, theme: Theme): HostUi;        // ids: models, chat, agents, transcript, status, input-row, label, input
export function applyWidth(ui: Pick<Ui,'left'|'right'>, width: number, manualHidden: boolean): void;

// keys.ts
export type KeyLike = Pick<KeyEvent,'name'|'ctrl'|'meta'|'shift'> & { baseCode?: number };
export function matchHotkey(k: KeyLike, list?: readonly Hotkey[]): { hotkey: Hotkey; which: number } | null;
export function actionOf(hotkey: Hotkey, which: number): HotkeyAction;   // pair rule: Alt+→ '/]', PgDn, Ctrl+End
export function hotkeyAction(k: KeyLike): HotkeyAction | null;
export function isInterruptKey(k: KeyLike): boolean;                      // ctrl+c, or ctrl+с with baseCode 99
export function newlineKey(kitty: boolean): string;                       // 'Shift+Enter' | 'Alt+Enter / Ctrl+J'

// source.ts
export interface InputBox { readonly plainText: string; setText(t: string): void; gotoBufferEnd?(): void }
export class TextareaSource implements LineSource {   // interactive, !echoes, inline, multiline
  constructor(box: InputBox, setLabel: (label: string) => void);
  get promptMode(): 'line' | 'edit';
  submit(): void;            // Enter: box text → a line, box cleared, an edit ends
  inject(line: string): void; // a hotkey's command line (the box keeps what was typed)
}
export interface InterruptHub { interrupts: InterruptSource; fire(): void; dispose(): void }
export function interruptHub(signals?: Pick<SignalSource,'on'|'removeListener'>, orphan?: () => void): InterruptHub;

// io.ts
export interface FileLog { readonly path: string; line(text: string): void; error(e: unknown, where?: string): void }
export function tuiLogPath(home: string): string;                 // <home>/logs/tui.log
export function fileLog(path: string, clock?: () => Date): FileLog;  // SGR stripped, timestamped
export interface TuiIo extends Io { attach(show: (text: string) => void): void; detach(to: Io): void }
export function tuiIo(log: FileLog): TuiIo;

// view.ts
export class TuiView implements ReplView {
  constructor(d: { ctx: ReplViewContext; transcript: TranscriptApi; models: ModelsPaneApi; agents: AgentsPaneApi;
                   prices: PriceTable; extra(): { newlineKey: string; mouse: boolean };
                   status(text: string, tone?): void; log(text: string): void; live?(): boolean });
  get sessionId(): string | null;  get turning(): boolean;
  refresh(): void;   // bannerInfo() → models.update + agents.refresh (idle, F3, 'capabilities')
}

// run.ts (index.ts re-exports cmdTui, runTui, NEEDS_TERMINAL, TuiArgs)
export const NEEDS_TERMINAL = 'rp-core tui needs a terminal; use rp-core chat';
export interface TuiParts { transcript(ui, theme, {warp}): TranscriptApi; models(ui, theme): ModelsPaneApi; agents(ui, theme, clock): AgentsPaneApi }
export interface TuiArgs extends ChatArgs { env?; createRenderer?: () => Promise<CliRenderer>; parts?: Partial<TuiParts>; exitWindowMs?: number }
export async function cmdTui(a: TuiArgs & { sessionId: string; tty?: boolean }): Promise<number>;  // 64 / 5 / runTui
export async function runTui(engine: EngineHandle, session: SessionHandle, a: TuiArgs): Promise<number>;
export function mountTui(o: MountOptions): MountedTui;   // the frame + keys + Repl on a given renderer
```

## Behaviour
- Order: TTY check (64) → Engine.open + session (refusal → reportRefusal, 5, no renderer) → error/SIGINT/SIGTERM
  handlers → parts (lazy `import()` of transcript/models-pane/agents-pane) → renderer → Ui → Repl
  (`{...chatDeps(engine, session, {rt, io: tuiIo}), color: true}`, source+interrupts, TuiView, env without
  VISUAL/EDITOR). Teardown: dispose listeners + close the source → `destroy()` → `await closed` → Io back to
  `a.io` → `a.io.out.write('\x1b[?2027l')` → `endChat(engine, code)`.
- Hotkeys: command → `source.inject(line)`; prefill (Ctrl+G) → `/regen ` + what was typed, cursor at end;
  editLast → inject `/e`; Esc → in 'edit' `hub.fire()` (the Repl cancels), else clear the input. While the
  prompt mode is 'edit', command / prefill / editLast are ignored (scroll, F2, F3 still work).
- Ctrl+C key (any layout) and SIGINT → `hub.fire()`; with no Repl subscribed (startup/teardown) → leave 130.
- SIGTERM: `onChatTerm(engine, {say: → io.err (transcript row + log), exitNow: restore → a.exitNow(143)})`.
- Status row: `ready · Enter sends · F1 help` (idle), `answering… · Ctrl+C stops …` (turn), yellow
  `editing in place …` (edit label), red `error …` (uncaught / a pane that threw).
- Session-level `memory` / `changed` from `engine.events()` go to `agents.event` for the current session id,
  only while no turn streams (turn events already reach the pane through the turn view).

## Deviations from tui-decisions.md / the brief
1. The input sits in a row box with a label Text (the Repl's prompt label); `middle` holds transcript,
   status, inputRow. `Ui.input` is still the Textarea. `HostUi` adds label/setStatus/fitInput.
2. Where-you-are dedupe: after a banner that switched the session, every id `showPath` drew is skipped
   until the first echo / turn / idle (where-you-are can print TWO messages: answer + unanswered line),
   not only `lastCardId()`.
3. runTui RETURNS the code (main's entry flushes and exits, and keeps the --sandbox cleanup); only SIGTERM
   and an orphan SIGINT call `a.exitNow`. `\x1b[?2027l` goes to `a.io.out` (main's processIo).
4. `new --tui` with `--json`/`--no-chat` is a usage error; without a TTY it exits 64 before a session is made.
   The TUI module is imported before cmdNew creates the session (a failed load leaves no lock).

## For the integrator
- cmdNew still prints "`rp-core chat <id>` reopens it" under `new --tui` (commands.ts, not mine).
- ARCHITECTURE/README/PROVENANCE lines (OpenTUI MIT, pinned 0.7.0 — package.json and bun.lock already pin it).
- The uncaught-error test emits `uncaughtException` on the test process: bun prints the error, the test passes.
