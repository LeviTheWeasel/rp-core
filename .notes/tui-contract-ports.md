# TUI Phase 1 "ports": contract

Unit `ports` (TUI decisions T-3; repl-map §2.2 A–D). Files: `src/cli/repl.ts`, `src/cli/repl-view.ts` (new),
`src/cli/chat.ts`; tests `test/repl/ports.test.ts` (new, 12 tests). No OpenTUI, no new dependency.
The line REPL's output is byte-identical: test/repl, test/cli, test/cli-m4, test/demo-m3 and test/demo-m4
pass unchanged (450 tests before; 450 + the 12 new ones after). No existing test file changed.

## A. Input port (`src/cli/repl.ts`)

```ts
export interface LineSource {
  next(): Promise<IteratorResult<string>>;
  readonly interactive: boolean;   // lines may arrive mid-turn: held / refused / queued (§12.4)
  readonly echoes: boolean;        // the source draws the prompt and typed keys itself (readline on a TTY)
  readonly inline?: boolean;       // NEW: it has an input line the Repl labels (prompt) and prefills (/e)
  prompt(text: string): void;      // "you › " or "edit › " (prefix(label, style): bold SGR when colour is on)
  mute(on: boolean): void;         // true while a turn streams, false after
  readonly muted: boolean;
  pending(): string;               // typed, not sent ('' if none): Ctrl+C at the prompt clears it first
  clearPending(): void;
  prefill(text: string): void;     // /e: line breaks arrive as INLINE_BREAK '⏎'
  suspend(): () => void;           // only for $VISUAL/$EDITOR (editorRunner)
  close(): void;
}
export type InterruptSource = (handler: () => void) => () => void;  // one call of handler = one Ctrl+C

interface ReplOptions {
  // …interactive, exitWindowMs, terminal, env as before
  source?: { source: LineSource; interrupts: InterruptSource };       // NEW
  view?: (ctx: ReplViewContext) => ReplView;                          // NEW (B)
}
```

- `opts.source` wins over `deps.input`, `deps.onInterrupt` and readline: the pair is used as given and
  those three are not touched. `opts.interactive` and `opts.terminal` are ignored then (the source says
  whether it is interactive).
- readline: `inline: tty`; `injectedInput` (deps.input): `inline: false`. Both behave as before.
- `inlineEdit` prefills when `echoes || inline`. The saved line is `line.split('⏎').join('\n')`, so a
  multi-line input may send real `\n` (tested). A message that itself contains `⏎` is still refused.
- **Deviation from §2.2 A:** `prompt()` also runs for `inline` sources (was `echoes` only). Without it a
  non-echoing TUI source would never get `you › ` back after `edit › `. For readline and deps.input
  nothing changes (`inline === echoes` there).

### What the TUI's `TextareaSource` must do
- `interactive: true`, `echoes: false` (the Repl echoes every line through `view.echo`), `inline: true`.
- `prompt(label)`: set the input label (strip SGR; `you  › ` is padded to the character label's width).
  It is called each time the queue empties, after a Ctrl+C hint, and with `edit › ` for /e.
- `prefill(t)`: `setText(t.replaceAll('⏎', '\n'))`; `pending()`: the input's text; `clearPending()`: clear.
- `/e` routing: while an edit is open, the next `next()` line is the new text (Enter saves), a Ctrl+C
  press cancels (the Repl calls `clearPending()` itself, then says `edit cancelled`). Esc can simply
  call the interrupt handler, or clear + submit nothing; it must not submit the old text.
- `$VISUAL`/`$EDITOR` (T-9): the Repl spawns the editor whenever `env` names one and `deps.editText` is
  absent. **The TUI must pass `ReplOptions.env` with `VISUAL` and `EDITOR` removed** (keep `HOME` and the
  rest: `/preset ~/…` and `/lore add ~/…` read it), so /e stays inline.
- Hotkeys that map to commands submit the command line through this source (held / refused rules apply).

## B. Output port (`src/cli/repl-view.ts`)

```ts
export interface TurnView {
  push(ev: Event): void;   // EVERY redacted event of the turn in order: start … done|stopped|failed|conflict
  finish(): void;          // after the stream (also after an error)
  interject(): void;       // the Repl is about to output something mid-turn
  readonly kept: boolean;  // a `changed` msg|edit arrived (failed turn: the kept partial gets a status)
}
export interface TurnOptions {
  label: string;                        // the character's padded label
  showReasoning: () => boolean;         // /think, read when reasoning starts
  notice: (n: Notice) => void;          // call for each `notice` event: the Repl dedupes + says it via line()
  continueFrom?: string;                // /c: the answer's text before the turn
}
export interface BannerInfo {
  session: SessionHandle; header: SessionHeader;
  names: { char: string; user: string; width: number };
  config: SessionConfig;   journal: Journal;           // journal: reuse for directorAt / pathUsage / latestTrace
  narrator: Binding;       window: number | null;  cap?: number;
  tools: ModelCaps['tools'] | null;                    // toolsWord() → native | prompted | off
  director: { conn: string; model: string; follows: boolean; profile: 'auto' | 'full' | 'lite' } | null;
  override?: NonNullable<ReplDeps['override']>;        // --provider: { conn, plays: 'script'|'recording', … }
}
export interface LineCursor { newline(): void; write(s: string): void; markLineStart(): void }
export interface ReplView {
  line(text: string): void;                          // every say(): styled report text, may hold \n
  echo(line: string): void;                          // the player's line, trimmed
  message(m: MessageView, withStatus: boolean): void; // + status line for an assistant when withStatus
  banner(b: BannerInfo): void;                       // open and every /open, /fork switch
  turn(o: TurnOptions): TurnView;
  status(m: MessageView, trace?: Trace): void;       // after a turn's answer
  idle?(): void;                                     // queue empty, input awaited
  readonly cursor?: LineCursor;                      // line terminal only; the TUI leaves it out
}
export interface ReplViewContext { style: Style; bannerInfo(): BannerInfo }
export class LineView implements ReplView { constructor(sink: (s: string) => void, style: Style) }
```

- `LineView` = today's code moved: `Screen` over `io.out`, `turn()` returns a `TurnPrinter`. Screen and
  TurnPrinter stay in repl-render.ts (not owned by this unit; their tests import them from there).
- Call order the Repl guarantees: `banner` first (then the open events as yellow lines, then where you
  are: `message(…)` and/or a dim line), then per processed line `echo` → `line`s / `message`s / `turn` →
  `push…` → `finish` → `status`, and `idle` whenever the queue is empty before waiting. Before any output
  while a turn streams the Repl calls `turnView.interject()` itself.
- Where each message comes from: `message(m, true)` for the greeting/answer head, `showSelected` (/[ /]
  /goto), /rewind; `message(m, false)` for the player's unanswered head and for the message after /e.
  The status line of `message(…, true)` has no trace (as before); `status(m, trace)` has it.
- The 118 `say()` sites are unchanged: all command reports, refusals, held/queued notes, notices, open
  events, errors and the Ctrl+C hints arrive via `line()`, styled with `ctx.style` (with `color: true`
  the closed SGR set of repl-render.ts `SGR`: 1/2/22 bold-dim, 3/23 italic, 33/31/39 fg).
- Names: the view takes the speaker labels from `banner(b).names`; the Repl passes `label` to `turn()`.

## C. `bannerInfo()`

`private bannerInfo(): BannerInfo` holds what `greet()` computed (config, window, cap, tools, Director
binding + configured profile, names, override). `greet()` = `bannerInfo()` → set names/showReasoning →
`view.banner(info)` → open events → where you are. It is side-effect free.

**Decision (refresh after `configure()`):** the view factory's context carries `bannerInfo()`; `idle()`
takes no argument. The TUI calls `ctx.bannerInfo()` inside `idle()` (and has it pushed on `banner()`).
Reason: it reads the journal from disk, so only a view that needs it pays; the TUI can also call it at
any other moment (e.g. after its own F-key). Do not call it inside the factory (the view is still being
built) or per frame. The current session id = `bannerInfo().session.id` (changes on /open and /fork,
which call `banner()`): re-filter `engine.events()` there.
Not in BannerInfo (by design): the last plan's profile/transport (`directorAt(info.journal.tree,
info.session.view().head).record`), usage totals (`pathUsage(info.journal, ids, rt.config.prices)`).

## D. `src/cli/chat.ts`

```ts
export function chatDeps(engine: EngineHandle, session: SessionHandle, a: Pick<ChatArgs, 'rt' | 'io' | 'fetch' | 'clock'>): ReplDeps;
export const TERMINATED_LINE = 'rp-core: terminated: closing the session (the partial answer is kept)';
export interface ChatTermOptions { signals?: SignalSource; say: (line: string) => void; exitNow: (code: number) => void }
export function onChatTerm(engine: EngineHandle, o: ChatTermOptions): () => void;  // returns "remove handler"
export async function endChat(engine: EngineHandle, code: number): Promise<number>; // 130: close not awaited; 0 → EXIT.done
export async function runChat(engine, session, a: ChatArgs): Promise<number>;      // unchanged behaviour
```

- `runChat` = `onChatTerm(engine, {signals: a.signals, say: l => a.io.err.write(`\n${l}\n`), exitNow: a.exitNow})`
  → `runRepl(chatDeps(engine, session, a))` (on throw: remove handler, `await engine.close()`, rethrow)
  → remove handler → `endChat(engine, code)`.
- `chatDeps` sets no `color`, `input`, `onInterrupt`, `editText`: the TUI adds `color: true` (or false
  under NO_COLOR, T-4) and passes its ports via ReplOptions. `deps.io` = `a.io` (the TUI's `tuiIo`;
  the Repl only flushes `io.out` at the end when a view is given). `debugTap` swaps `rt.debug` while
  the REPL runs, so --debug lines become dim `debug: …` lines through `view.line`.
- A runTui sketch: `const off = onChatTerm(engine, {signals, say: toLog, exitNow: destroyThenExit});
  code = await runReplWith({...chatDeps(engine, session, {...a, io: tuiIo}), color}, {source, view, env});
  off(); return endChat(engine, code);` (plus the same catch as runChat).

## Other deviations from repl-map §2.2
- `TurnView.kept` is `readonly` in the interface; TurnPrinter's mutable field satisfies it.
- `BannerInfo.narrator` is the whole `Binding` (fallback, maxTokens, … for the left pane), and
  `BannerInfo.journal` is added (the panes reuse it instead of re-reading the file). `config.director`
  still carries style/creativity.
- `ReplViewContext` holds `style` and `bannerInfo` only.
- Extra exports from chat.ts beyond `chatDeps`: `onChatTerm`, `TERMINATED_LINE`, `ChatTermOptions`,
  `endChat` (the SIGTERM line and exit are injectable; runChat keeps its io.err / exitNow defaults).
