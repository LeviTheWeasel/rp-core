# TUI Phase 2 "panes": contract

Unit `panes` (TUI decisions T-5, T-6, T-8). Files: `src/cli/tui/agents.ts` (pure, no OpenTUI),
`src/cli/tui/agents-pane.ts`, `src/cli/tui/models-pane.ts` (both import `@opentui/core` statically: load
them only from the `tui` path, as run.ts does with `await import`); tests `test/tui/agents.test.ts` (19),
`test/tui/panes.test.ts` (12). types.ts unchanged. `bunx tsc` clean; full `bun test`: 4398 pass, 0 fail.

## Exports

```ts
// models-pane.ts
export function createModelsPane(ui: Ui, theme: Theme): ModelsPaneApi;   // adds Text 'models-body' to ui.left
export interface ModelsExtra { record?: DirectorRecord; newlineKey: string; mouse: boolean }  // = the API's `extra`
export function modelsLines(b: BannerInfo, extra: ModelsExtra, width: number): Line[];       // pure rows
export function windowText(window: number | null, cap?: number): string;                    // 16384 → 16k, ≤4k, ?

// agents-pane.ts
export function createAgentsPane(ui: Ui, theme: Theme, clock: () => Date): AgentsPaneApi;    // Texts 'agents-body' + 'agents-usage' in ui.right
export function agentsLines(s: AgentsState, width: number): Line[];                           // Narrator, Director, M5 agents
export function usageLines(s: AgentsState, width: number): Line[];                            // the bottom block
export type Tone = 'text'|'bold'|'dim'|'yellow'|'red'|'accent'|'user'|'char';
export interface Seg { text: string; tone: Tone; bold?: boolean }  export type Line = Seg[];
export function fitLine(line: Line, width: number): Line;          // cut by terminal columns (Bun.stringWidth), '…', control chars → space
export function fitWithSuffix(main: Line, suffix: Line, width: number): Line;
export function paneText(lines: readonly Line[], theme: Theme): StyledText;   // NO_COLOR: dim→dim, red/bold→bold, yellow→italic
export const linesText: (lines: readonly Line[]) => string;
export const textWidth: (s: string) => number;
export const PANE_TEXT_WIDTH = { left: LAYOUT.left - 4, right: LAYOUT.right - 4 };  // 24 / 32

// agents.ts (pure)
export function initialAgents(): AgentsState;
export function reduceAgents(s: AgentsState, ev: Event, now: Date): AgentsState;   // returns `s` itself when nothing changed
export function storedFacts(j: Journal, head: string | null, config: SessionConfig, prices: PriceTable): StoredFacts;
export function withStored(s: AgentsState, f: StoredFacts): AgentsState;
export function recordAt(j: Journal, head: string | null): DirectorRecord | undefined;  // directorAt(...).record
export function directorFacts(r: DirectorRecord): DirectorFacts;
export function statsOf(id, gen, trace?): AnswerStats | null;  export function pathIds(j, head): string[];
export function usageTotal(s: AgentsState): UsageTotals;       export const zeroUsage: () => UsageTotals;
// types: AgentsState, NarratorPhase, ToolCall, AnswerStats, DirectorLive, DirectorFacts, AgentBlock, UsageTotals, StoredFacts
```

## Behaviour
- Reducer: `start` → waiting; `reasoning` → thinking (offset+delta chars); `text` → writing; `tool` start/done
  paired by (turnId, callId), `toolLine` text, ms from the events' `ts`, newest first, capped at
  LAYOUT.toolCalls across turns; `retry` routed by the callKey's agent (narrator / director / M5);
  `director` planning → planned|reused (summary, ms) | failed (reason ?? 'unknown') | skipped; `agent` one
  block per agent (status, count, code, source, reason, job ms); `memory` by filing/historian → that block;
  `usage` adds to live totals; done → idle + stats from `message.gen`; stopped/failed/conflict → their phase,
  running tool rows → cancelled. `now` only replaces an unreadable `ts`.
- `storedFacts`: last answer = the newest assistant on the path (effectiveMessage gen; rounds/transport
  fall back to the trace), the Director record at the head (turn, ok/code, profile, transport, model,
  attempts, chapter, live arcs, seeds at or past SURFACE_TURNS), usage = pathUsage narrator + every agent.
  `head` null → the journal's own head. `withStored` replaces those and resets live usage to 0.
- `reset(id)`: fresh state, and from then on events of another session id are ignored.
- Widths: the panes read their Text's laid-out width after each frame (`renderer.on('frame')`) and redraw
  when it changes; before the first frame PANE_TEXT_WIDTH (border + paddingX 1, what app.ts builds).
  Every row is cut, never wrapped (`wrapMode: 'none'`); the agents body is clipped at the bottom, usage stays.

## Deviations from tui-decisions.md
- Narrator has one more state, `waiting…` (after start / between tool rounds, before any delta).
- A continue's `start` sets the Director to `skipped` (no event exists for it; the trace says skipped).
- Keys: Enter / newline / Ctrl+C come first, then HOTKEYS. A key whose description does not fit beside the
  label (7-column label column) gets it on the next row, indented one column (24 columns at paddingX 1).
  F3's row reads `mouse wheel: on|off` instead of its description. An untitled session shows its id.
- Usage: `N calls · usage not reported` when no call reported tokens; `+ N unpriced` when some lack a price.
- Director off: one row `Director · off` in both panes (the stored plan is not shown while off).

## What the integrator wires (view.ts / run.ts already do this)
- banner(b): `agents.reset(b.session.id)` on a session switch; `models.update(b, {...extra, record: recordAt(b.journal, head)})`.
- idle() and F3: `models.update(...)` again; `agents.refresh(b.journal, b.session.view().head, b.config, rt.config.prices)`.
- Every turn event → `agents.event(ev)`; from `engine.events()` only session-level `memory`/`changed`
  outside turns (forwarding turn events twice would count live usage twice).
- Side boxes: `flexDirection: 'column'`, `paddingX: 1`; add nothing after the agents pane's Texts.
