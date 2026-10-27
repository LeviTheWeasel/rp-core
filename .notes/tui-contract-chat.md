# TUI Phase 2 "chat": contract

Unit `chat` (TUI decisions T-7, T-10). Files: `src/cli/tui/{sanitize,sgr,transcript,turn-view}.ts`; tests
`test/tui/{sanitize,sgr,transcript,stream}.test.ts` (49 tests) + the helper `test/tui/chat-kit.ts` (not a
test file: a headless renderer with a minimal Ui, `msg()`, `ev()`, `textEvents()`, `rows()`).
`sgr.ts`, `transcript.ts`, `turn-view.ts` import `@opentui/core` at run time: load them only from the
`tui` path (run.ts already does `import('./transcript.ts')`). `sanitize.ts` is pure, no OpenTUI.

## Exports

```ts
// sanitize.ts
export interface SanitizeOptions { warp: boolean }
export function sanitize(text: string, o: SanitizeOptions): string;
export interface Sanitizer { push(delta: string): string; end(): string }
export function createSanitizer(o: SanitizeOptions): Sanitizer;         // push()s + end() == sanitize(whole), any split
export function walk(s, warp, text: (t) => void, seq?: (raw) => void): number;  // the scanner sgr.ts shares
export function sequenceEnd(s: string, i: number): number;

// sgr.ts
export function sgrToChunks(s: string, theme: Theme, o?: { warp?: boolean }): TextChunk[];
export function createSgrReader(theme: Theme, o?: { warp?: boolean }): { push(s: string): TextChunk[] };
export function chunk(text: string, theme: Theme, st?: { bold?; dim?; italic?; fg?: string }): TextChunk;
export function appendChunks(into: TextChunk[], more: readonly TextChunk[]): void;  // merges same-style neighbours
export function rgba(hex: string): RGBA;  export function colour(theme, hex?): RGBA | undefined;

// transcript.ts
export const ARCHIVE_BLOCK = 50;
export interface TranscriptOptions { warp: boolean; showReasoning?: () => boolean }
export function createTranscript(ui: Ui, theme: Theme, o: TranscriptOptions): TranscriptApi;

// turn-view.ts
export function createTurnView(host: TurnHost, o: TurnOptions & { names: Names; onEvent?: (ev: Event) => void }): TurnView;
export interface Entry; export interface TurnHost;   // the transcript implements TurnHost
export function messageChunks(m: MessageView, label: string, look: CardLook): TextChunk[];
export function headerChunks(label, role, theme); proseChunks(text, theme, warp); reasoningChunks(text, show, theme, warp);
```

## Behaviour
- Sanitiser (T-10): whole sequences go (CSI, OSC to BEL/ST, DCS/SOS/PM/APC to ST, nF/Fp/Fe/Fs ESC
  sequences, 8-bit C1 CSI/OSC/DCS…), not only the ESC; other C0/C1 and DEL go; `\t` → 2 spaces; `\r`
  goes; lone surrogates go. Warp: U+200D, U+FE0F, U+1F3FB–1F3FF. A sequence not finished within 256
  chars loses only its introducer. A stream holds an unfinished sequence / high surrogate for the next delta.
- SGR: 0/empty reset, 1, 2, 3, 22, 23, 31, 33, 39 (and `;` lists); `38/48;5;n|2;r;g;b` skipped whole;
  every other sequence dropped; text between them sanitised. Colours: red/yellow from the theme; dim
  text gets `theme.dim`, bold `theme.bold ?? theme.text`, plain `theme.text` (undefined = terminal).
  MONO_THEME: attributes only.
- Every transcript entry is ONE TextRenderable with one StyledText (wrap word). Cards: `[reasoning
  lines]` then `Name › [markers] text` (markers() minus `[reasoning]`, dim). Cards and echoes get a
  blank line before them (marginTop 1, never at the very top); system/status rows none.
- `status(sgr)`: replaces the newest card's status row when it has one (a continue in place, a repeat),
  else appends a row and links it to that card.
- Archive (T-7): when `LAYOUT.liveCards + ARCHIVE_BLOCK` entries are mounted, the oldest 50 (never one a
  turn still writes) fold into one archive TextRenderable after the earlier ones. `showPath` builds
  the old part straight into archive blocks. Counted per ENTRY (cards and rows), not per card. 2 000
  cards + 1 000 status rows: ~207 renderables, a streaming delta + frame ≈ 0.7 ms at 120×40.
- Turn (mirrors TurnPrinter): the card is created on `start` showing `Mira › …`; reasoning folds to
  `⋯ thinking (N chars)` live (N counted through applyDelta, so re-deliveries do not inflate it);
  side lines (sideLine()) in the card, dim, indented; D-55 leading `\n` dropped after a side line;
  `notice` → `o.notice`; `stopped` dim `[stopped]` row, `failed` red row (+ dim kept note when `kept`),
  `conflict` yellow row + dim `  draft: …` (only when the card did not already show that text).
  `done`/`stopped(message)`: the streamed card stays when its text equals the committed one, else it is
  repainted from the message (gap in offsets, a rewrite by re-delivery, hooks, nothing streamed, a cue
  continue) and the turn's continuation rows are removed. `finish()` removes a card that never got
  output (no empty `Mira › …` stays). `interject()`: later output goes to a continuation row under the
  Repl's row (indented like the REPL); an empty card is moved below the row instead.
- Continue: the existing card grows in place when `lastCardId() === start.messageId` and it is still
  mounted; else a new card `Mira › …<lastWords(continueFrom)>` + the addition.
- `scroll`: pageUp/pageDown by `viewport.height − 2` (min 1), top = scrollTo(0), bottom =
  scrollTo(scrollHeight) (re-engages sticky).

## Deviations from tui-decisions.md / types.ts
- `createTranscript`'s options add an optional `showReasoning` (finished cards' reasoning blocks shown
  instead of folded). types.ts is unchanged; run.ts passes `{ warp }` only, which folds them always.
- `sgrToChunks` takes an optional third `{ warp }` (the transcript passes it for system rows).
- Side lines stay in the streamed card (as in the REPL) unless the card is repainted from `done`.
- Archive limit counts entries (cards + rows); the decisions say "cards".

## For the integrator
- Optional: pass `showReasoning: () => <the Repl's /think state>` to createTranscript (e.g. remember
  the last `TurnOptions.showReasoning`), otherwise finished cards always fold reasoning.
- The view should call `transcript.status()` right after the card/turn it belongs to (it already does).
- Nothing in these files writes to stdout/stderr; errors propagate to the caller (view.ts guards them).
