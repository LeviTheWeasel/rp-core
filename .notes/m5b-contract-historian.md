# M5b contract — unit `historian` (historian + `{{recap}}` slot, pure)

Decisions: D-176 (historian), D-177 (library arcs in the slot), D-178 (the slot). Files (new):
`src/agents/compendium/historian.ts`, `src/agents/compendium/recap.ts`. Tests: `test/historian-m5b/`
(83 tests: window 28, prompt 14, answer 14, ops 12, recap 15). Nothing else touched; `test/purity.test.ts`
passes; `bunx tsc --noEmit -p .` clean.

## Exported API

`agents/compendium/historian.ts`
```ts
export const WINDOW_TOKENS = 12_000, WINDOW_SHARE = 0.35, OVERLAP_SHARE = 1 / 3;
export const SUMMARY_CHARS = 1_500, HISTORIAN_TEMPERATURE = 0.3, MAX_DEPTH = 6;
export interface HistorianLimits { items; itemChars; overlap; overviewChars; digestPlots; maxTokens }
export const HISTORIAN_LIMITS: Record<CompendiumProfile, HistorianLimits>;
//   full {items 12, itemChars 6000, overlap 10, overviewChars 6000, digestPlots ∞, maxTokens 4096}
//   lite {items 6,  itemChars 3000, overlap 6,  overviewChars 1200, digestPlots 6, maxTokens 1500}

export interface HistMessage { id: string; role: 'user' | 'assistant'; text: string; hidden?: boolean }
export interface WindowMessage { pos: number; id: string; role: 'user' | 'assistant'; text: string }
export interface HistorianConfig { interval: number; recapAfter: number; overlap?: number }  // = ResolvedCompendiumConfig.historian
export interface WindowInput {
  path: readonly HistMessage[];   // root → the last accepted answer, EVERY message, hidden flagged; pos = index + 1
  profile: CompendiumProfile;     // compendiumProfile(cfg.profile, recorder window)
  window: number;                 // the recorder's request window (tokens)
  count: (text: string) => number;
  cfg?: { overlap?: number };
}
export interface HistorianDueInput extends WindowInput {
  tasks: ReadonlyMap<string, TaskState>;          // view.compendium.tasks of that path
  trimmed: { from: string; to: string } | null;   // trace.trimmed of the newest committed answer's last request
  cfg: HistorianConfig;
}
export interface HistorianWindow {
  fromId; newFromId; toId: string;               // first shown (overlap incl.), first new, last new
  start; newStart; end: number;                  // their 1-based path positions, end inclusive
  messages: WindowMessage[];                     // visible only, overlap first
  tokens: number;
}
export interface HistorianDue extends HistorianWindow { watermark: number; turns: number; trimmed: number; trigger: 'interval' | 'trimmed' }

export function historianRanges(tasks): [string, string][];           // hist:* keys, applied or reverted (not stale, not reverted+stale)
export function historianWatermark(path, tasks): number;              // end of the covered prefix (0: none)
export const windowCap: (window: number) => number;                   // min(12 000, floor(35 % window))
export function historianDue(input: HistorianDueInput): HistorianDue | null;
export function historianWindowAt(input: WindowInput, range: readonly [string, string]): HistorianWindow | null;
export const historianKey: (w: { newFromId; toId }) => string;        // 'hist:<newFromId>-<toId>'

export function historianDigest(view: { entries }, profile): string;
export interface HistorianPromptInput { start; newStart; end; messages: {pos, role, text}[]; digest; guidance; language; profile }
export function historianPrompt(i: HistorianPromptInput): { system: string; user: string };
export function historianSchema(profile): JSONSchema;
export interface HistorianRequestInput { window: {start, newStart, end, messages}; view: { entries }; profile; guidance: string; language: string }
export interface HistorianRequest { system; user: string; maxTokens: number; temperature: number; schema: { name: 'historian'; schema } }
export function historianRequest(input: HistorianRequestInput): HistorianRequest;

export interface HistorianItem { at: string; data: Rec }              // at = skip path prefix, e.g. 'filings[2]'
export interface HistorianArc { at: string; plot: string; overview: string }
export interface HistorianAnswer { summaries: HistorianItem[]; plots: HistorianItem[]; arcs: HistorianArc[]; skipped: Skip[] }
export function readHistorianAnswer(raw: unknown, profile?: CompendiumProfile /* 'full' */): ReadResult<HistorianAnswer>;

export interface HistorianOps { ops: MemOp[]; skipped: Skip[] }
export function historianOps(answer: HistorianAnswer, window: { newStart; end }, view: { entries }, profile): HistorianOps;
```

`agents/compendium/recap.ts`
```ts
export const RECAP_SRC = 'recap', RECAP_SHARE = 0.1, RECAP_ARC_SHARE = 0.5, RECAP_LITE_ARCS = 2, RECAP_LITE_ARC_CHARS = 1_200;
export const recapArcText: (plot, overview) => string;        // '[Arc] <plot>\n<overview>'
export const recapSummaryText: (title, summary) => string;    // '[Summary: <title>]\n<summary>'
export interface RecapTrace { ids: string[]; arcs: { key: string; rev: number }[]; boundary: string | null }  // = Trace['recap']
export interface RecapInput {
  view: { entries };              // the request's fold (seed included)
  path: readonly string[];        // active path ids root → leaf
  trimmed: { from; to } | null;   // THIS request's cut
  boundary: string | null;        // first history message sent after the cut (first history message when nothing is cut)
  previous: RecapTrace | null;    // nearest ancestor reply's trace.recap
  budgetTok: number;              // ≤ 10 % of the window
  profile: CompendiumProfile;     // narrator window
  count: (text: string) => number;
  revisionText?: (key: string, rev: number) => string | null;
}
export interface RecapSlot { text: string; tok: number; ids: string[]; arcs: { key; rev }[]; boundary: string | null; keys: string[] }
export function recapSlot(input: RecapInput): RecapSlot | null;
export function arcRevisionText(rows: readonly MemEntry[], key: string, rev: number): string | null;
```

## Choices the note left open (made here)

Historian
- **Input path = every message** root → last accepted answer, hidden flagged; positions are index + 1. (The
  lead's sketch said "visible messages with positions"; hidden ones are needed to resolve range ends and to
  keep numbering exact.) A range whose `to` is not on the given path (past the last accepted answer) covers
  to the path's end; one whose `from` is not on it is ignored (the fold already makes such rows stale).
- **`trimmed` is trace.trimmed `{from, to}`** (not a list of ids). Counted: visible messages after the
  watermark whose position is in [pos(from), pos(to)]; an end not on the path → 1 / the path's end.
- **Watermark** = position of the last visible message of the covered prefix; hidden messages are never
  holes. `turns` = visible user messages after it (up to the last accepted answer). Both triggers count
  "after the watermark", covered later segments included (literal D-176).
- **Window** = the oldest uncovered segment: from the first uncovered visible message forward while
  uncovered (stops before the next covered visible message), within the cap, ≥ 1 new message. The overlap
  is the nearest ≤ `overlap` visible messages before it whose tokens stay ≤ ⌊cap / 3⌋ (added nearest first,
  stops at the first that does not fit). Tokens = `count(text.trim())` per message (Bunraku counted the
  text, not the rendered line). A window may end on a user message (Bunraku does).
- `cfg.overlap`: absent → by profile; an explicit 0 → no overlap (resolveCompendium never yields 0).
- **Prompt numbers**: `messages S through E (E − S + 1 messages)` — the span, hidden positions included
  (Bunraku's arithmetic; hidden lines are not shown). OVERLAP/NEW lines only when start < newStart.
- **Digest**: "non-resolved" read literally: status ≠ 'resolved' (failed/abandoned stay). Recaps matched by
  any name of the plot (entryNames), last 3 in view order. Lite activity = max prov.lastSeq of the plot, its
  arc and its summaries; the 6 picked are shown in view order. Library plots are included.
- **Reader** (`ok:false` → corrective pass only when the root is neither object nor list, or it holds no
  item list and no arcs key): envelopes `filings|entries|items` (+ `summaries|recaps` typed summary,
  `plots|storylines` typed plot), a bare list, a lone `{type, entry}`; item forms `{type, entry}`,
  `{type, data}`, flat `{type, …}`, `{summary: {…}}`, type-less summary inference (parent_plot, or
  title + summary); type words folded (Summary, recap, сюжет, story line…). Fields: camelCase → snake
  when known; service fields stripped silently; kinds coerced (s ← number/bool/list of scalars joined
  ', '; a ← one value; n/b from strings); enums folded (lower, spaces/hyphens → '_'); a bad field →
  `skipped` with `must be <kind>`, item kept. Summary: title (else its `name`), summary text, plot
  (`parent_plot`, else `create_plot.name`, which also becomes a plot item at `….create_plot`); plot: name
  (else `title`). Item cap counts positions across all lists (Bunraku); arcs capped by the same number.
  Skip `why` texts: `over_limit` (D-175 code) and plain phrases (Bunraku's
  `every summary must belong to a plot (parent_plot)` kept verbatim).
- **Ops**: made plots are those neither live in the view (any origin, any name) nor in the answer (name or
  alias). An answer plot that `mergeData` says changes nothing → dropped. `messages_covered` =
  end − newStart + 1 (export's formula) is stamped into the summary's data. Cuts use director/state.ts
  `clipText` (word boundary, '…' counts) and are reported in `skipped` (`cut to N chars`). Arcs: last per
  normalized plot wins (earlier ones skipped), dropped when the live session arc already has that text.
  Classic-name plots are not pre-checked (the fold records `classic_conflict`).

Slot
- **Eligible summary**: live, has `range`, pos(range[0]) ≤ pos(trimmed.to) ("touches or precedes"). Human
  and library summaries (no range) never are. Order: range start, then end, then view order.
- **Session arcs**: live arcs of origin session whose normalized plot is a picked summary's `parent_plot` or
  any name of the plot entry it resolves to (findMatch); ordered prov.lastSeq desc. **Library arcs**: every
  live arc of origin library, `order` desc, then view order. First-fit within ⌊budget/2⌋.
- **Budget arithmetic** (as place.ts): tok = Σ count(item) + count('\n\n') per separator; `tok` excludes the
  message overhead — subtract MESSAGE_OVERHEAD_TOKENS from the budget if you want it inside.
- **Summaries**: newest first while they fit, stop at the first that does not (contiguous newest suffix),
  shown oldest first. Text = `data.summary` (not renderContent); title = `data.title` else name.
- **Stability**: used only when `previous.boundary !== null && previous.boundary === boundary` (so pre-M5b
  traces, which hold `boundary: null`, never pin an empty slot). Then: previous arcs in order — current text
  when `prov.lastSeq === rev`, else `revisionText(key, rev)`, else (null) the current text with the current
  rev; previous ids in order; dead entries dropped; nothing added. If that render exceeds `budgetTok` → fresh.
  An all-dead previous → null.
- `arcRevisionText`: the row with seq = rev (binary search, falls back to a scan); last `arc` op whose
  normalized plot equals the key's (`arc:<plot>[#n]`), or last `edit` with `ref === key` and
  `set.content ?? set.overview`. null otherwise (e.g. an edit that only set `featured`).

## What the wave-2 lane / request builder must know

- **Calling the historian**: after the filing task of an accepted answer A (or alone), build `path` =
  PathView.path up to A mapped to `{id, role, text: messageText(m), hidden}`; `tasks` = the head view's
  `compendium.tasks` (or the fold at A); `trimmed` = the newest committed answer's last request's
  `trace.trimmed` (its continue edit's if any); `profile = compendiumProfile(cfg.profile, recorderWindow)`;
  `window` = the recorder's window; `count` = the session counter. `historianDue(...)` null → nothing.
- **The call**: `historianRequest({window: w, view, profile, guidance: cfg.guidance, language: cfg.language})`
  → structuredCall `{agent:'historian', tag: null, repair: true, schema: r.schema, system: r.system,
  user: [r.user], samplers: {temperature: r.temperature}, maxTokens: r.maxTokens, read: (raw) =>
  readHistorianAnswer(raw, profile), callKeyPrefix: '<jobId>:historian'}`; timeout = `filing.timeoutSec`.
- **The row**: `const {ops, skipped} = historianOps(result.value, w, viewAtStart, profile)`; write
  `mem{key: historianKey(w), on: w.toId, by: 'historian', range: [w.newFromId, w.toId], ops, skipped, gen}`
  (`skipped` already holds the reader's skips; cap it like the Director's capSkipped, ≤ 20, if wanted). An
  empty `ops` row is still written (closes the key).
- **Refile / retry / recovered begin** of `hist:<a>-<b>`: rebuild with `historianWindowAt(input, [a, b])`
  (no due check, no cap on the new part). null → the range is gone from the path (treat as done/stale).
- **The slot**: compute the trim, then `recapSlot({view, path: ids, trimmed, boundary, previous:
  ancestorReply.trace.recap ?? null, budgetTok, profile, count, revisionText: (k, r) =>
  arcRevisionText(memRows, k, r)})`. Always write `trace.recap = slot ? {ids, arcs, boundary} : {ids: [],
  arcs: [], boundary}` — the boundary must be recorded even for an empty slot, or stability breaks. Feed
  `slot.keys` into `CompendiumBlockInput.inPrompt`. Pass `previous: null` to force a fresh choice when the
  readable books or the Compendium config changed since the previous request (else a book attached
  mid-session would not show its arcs until the boundary moves — and with no trim it never moves).
- The circularity (slot size ↔ trim) is the builder's: recapSlot is pure for a given cut.

## Open questions for the lead

1. **Enable moment for the historian**: D-171 limits filing to answers after the enable moment; D-176 is
   silent. As built, a long chat that turns the Compendium on is summarized from position 1, one window per
   accepted answer until caught up. A floor (positions before the enable moment count as covered) would be
   a small `WindowInput` addition.
2. Lite text literally «under 1 200 characters» (space-grouped, as the note writes it). Say if the model
   should see «1,200» or «1200» instead.
3. Digest "non-resolved": I excluded only `resolved`; D-174's snapshot also drops failed/abandoned.
4. `create_plot` honoured (RoleCall) rather than dropped (Bunraku) — a listed deviation if kept.

## Fixes after the review (fix-agents; the lead's ruling I, D-183)

Files: `src/agents/compendium/historian.ts`, `src/agents/compendium/recap.ts`. Tests:
`test/historian-m5b/review.test.ts` (new, 16), `test/recap-m5b/revision.test.ts` (new, 14);
`prompt.test.ts` (the golden texts list D-183's line), `answer.test.ts` (`offered: 0`), `ops.test.ts` (the
arc keyed by the canonical name), `recap.test.ts` and `test/recap-m5b/assemble.test.ts` (an overview over
the arcs' half is cut, no longer left out).

Historian (`historian.ts`):
- **D-183**: a blank `compendium.language` ends the system prompt with «Write every field value in the
  language the story is written in.» (full and lite; after the guidance).
- **Too large a message** (historian#3, breaker#4): `WindowInput.budget?: number` — the most tokens the
  window's texts may take (overlap included), never above `windowCap(window)`; absent = the cap. In
  `historianDue` and `historianWindowAt` alike, new texts over what the overlap leaves are cut head+tail
  (filing's `cutMiddle`, its `[... N characters cut from the middle ...]` note) to a fair share (the
  largest share L with Σ min(t, L) ≤ room; texts under L stay whole); `tokens` is the cut total. The due
  window still starts at the first uncovered message and its key is unchanged, so the watermark moves
  past a giant paste. The same messages give the same cut from either function. The lane (fix-lane)
  passes `budget` when the prompt around the messages leaves less than the cap.
- **Refused summaries** (historian#10): `HistorianAnswer.offered?: number` (the reader counts every item
  read or refused as a summary, every item without a readable type or not an object, every item past the
  limit; not plots, not items of another named type); `HistorianOps` gains `offered` (answer.offered ??
  summaries.length) and `applied` (the summary ops). The lane fails `offered > 0 && applied === 0`.
- **Aliases** (historian#5): `historianOps` resolves each summary's `parent_plot` and each arc's plot to the
  plot's canonical name — `findMatch(view, 'plot', …)` (names and aliases, session first), else a plot of
  this answer by its name or aliases, else the name as written. `named`, the "later arc wins" map and the
  no-op check use the canonical name, and the arc op is written under it (`arc:<canonical>`). A summary's
  `parent_plot` stays as written. Made plots are unchanged.
- **Prototype keys** (breaker#8): `typeWord` and the enum synonyms use `Object.hasOwn`.
- **Nothing** (ruling I): a list key (filings, entries, items, summaries, recaps, plots, storylines, arcs,
  arc, overviews, plot_overviews) holding null, '' or "none" is nothing; `{"filings": 3}` stays invalid.

Slot (`recap.ts`):
- **Revision** (historian#6): an arc's revision is the seq of the last applied op that set its text — an
  `arc` op, or an `edit` whose row sets `content`/`overview` (read through `revisionText`) — taken from
  `view.effects` (RecapInput.view is now `Pick<CompendiumView,'entries'> & Partial<Pick<…,'effects'>>`);
  `prov.lastSeq` when the view has no effects for the arc (hand-built views), 0 when no row set it.
- **Pin dropped** (historian#4, #7): a pinned rev renders its old text only while an applied op of that seq
  sets the arc's text (not undone, not stale, and — after a fork renumbered the seqs — a row that really
  holds an op for the arc); otherwise the current text and revision.
- **Profile and caps** (historian#8): `RecapTrace.profile?` / `RecapSlot.profile`; a pin is chosen afresh
  under another recorded profile, or when it holds more arcs than the profile allows (lite 2).
- **Cut to fit** (historian#9): an overview over what is left of the arcs' half is cut head-first
  (`clipText`: the head kept, '…') to the longest that fits; under `RECAP_ARC_FLOOR_CHARS` (200) it is
  left out. New optional `RecapInput.shareTok`: the slot's whole share; the half is ⌊share/2⌋ (capped by
  `budgetTok`), and with it a pinned slot's arcs are cut by the same rule (the same text again). Without
  it the half is of `budgetTok` (as before) and a pin keeps its arcs whole.

For the slot / assemble owner (not done here, files not mine):
1. Pass `shareTok: share − overhead` in both `slotAt` calls of `assemble.ts`. Today the second call's
   budget is about the first slot's size, so the arcs' half shrinks there: arcs larger than that half are
   cut (now) or dropped (before) in the final slot, and a cut can vary with the history's slack.
2. `chooseRecap`'s second call should keep the effects: `view: { ...input.view, entries: kept }`
   (else revisions fall back to prov.lastSeq on that path).
3. `recapTraceOf` / `readRecapTrace` / `Trace['recap']` should carry `profile` (RecapSlot has it) so a
   lite→full switch is chosen afresh too (full→lite is already caught by the lite arc cap).

## After the final check (fix2-agents; the lead's ruling K) — recap.ts

Files: `src/agents/compendium/recap.ts`. Tests: `test/recap-m5b/ruling-k.test.ts`. historian.ts and
filing.ts are unchanged this round (the historian's cut-off answer is told by structuredCall's `cutOff`,
see the sched note; the lane fixer fails it).

- `RecapTrace.share?`, `RecapInput.share?`, `RecapSlot.share?`: the slot's share (⌊10 % × window⌋) a pin
  was chosen under; `again()` chooses afresh when the recorded profile or share differs from this
  request's (either absent: not compared).
- **The pinned revision is the arc-text op of that arc in the row with that seq**: the view's effect on
  the arc's key at that seq that sets its text (an `arc` op; an `edit` that sets content/overview), and
  that very op is read back: `revisionText(key, rev, op?)` gets the effect's op index, and
  `arcRevisionText(rows, key, rev, op?)` reads exactly `row.ops[op]` when given (an arc op whatever plot
  name it wrote — after ruling K's "arcs follow renamed plots" a renamed plot's later arc ops name the new
  name but apply to the old arc key). Without `op`: the old reading (an arc op of the plot the key names,
  or an edit of the key). An arc with no effects in the view (hand-built views) keeps the legacy reading.
- **Not fixed (agents-cli recap.ts:185, forks)**: after a fork renumbers the rows, a pinned rev that lands
  on ANOTHER arc-text row of the same arc (the source's REV-B@10 pin reads the fork's REV-C@10) still
  passes every check the trace allows: the trace holds only `{key, rev}` and the copied rows keep no
  trace of their source seq. It needs either `planFork` remapping `trace.recap.arcs[].rev` (old seq → new
  seq) of the copied messages, or `previousRecap` ignoring arc pins of a trace copied from the fork's
  source (header `fork`, the message's seq ≤ the copied part). Neither file is mine.
