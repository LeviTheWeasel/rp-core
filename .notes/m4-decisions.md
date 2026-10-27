# M4 decisions (the lead's design note; authoritative for the M4 build)

M4 = "Story Director" (ARCHITECTURE.md §15, §7.2, §7.3, §5.9, §19.6). The spec is the base; where it
is silent, contradicts itself or was overtaken by an accepted decision, THIS note decides. Every
"D-9x/D-1xx" below becomes a numbered decision in ARCHITECTURE.md rev 14 after the build (question
22: confirm as a batch). Research the decisions rest on — read the parts your task names:
`<session scratchpad>/m4/understand/`
- `design.md` — the doc's M4 requirements, module by module, with line refs, and 39 gaps;
- `bunraku.md` — every Bunraku Director file: API, constants, algorithm, tests (§3), infra map (§5);
- `rolecall.md` — RoleCall tolerance matrix (§1.2), tag probes (§5.4), arc matching (§6), title
  sanitizer (§7), seed aging (§8), DirectiveBuilder (§9), authors (§14);
- `rpcore.md` — where M4 plugs into rp-core (turn flow, assemble, scripted tests, CLI);
- `personalities.md` — the 10 personalities, rename list, text fixes, authors.

Sources (port from these exact commits; record them in headers and PROVENANCE.md):
- Bunraku `~/Documents/AI/Bunraku` @ `702d81201120a6b90eb29a783a77c60ffdebc374`
  (HEAD c267aaf1 has identical Director files). Copyright (C) 2026 Coneja-Chibi.
- RoleCall `~/ST/VAUDEVILLE` apps/rc @ `fb8dc623e6beb24083f5105c828462e89fc66ce3`.
The core copies code, never imports either repo. Header for a ported file (as src/tools/prompted.ts):
```
// Ported from <Repo>:<path>@<commit> (<authors and what>).
// Copyright (C) 2026 <original authors>; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
```
Fresh files keep the usual `// SPDX… // Copyright (C) 2026 the rp-core authors` header.

## A. Superseded or clarified spec text

1. §19.6 "tag spans for `<plan>` and `<memory>`": only `<plan>`; Compendium agents are `tag:null`
   (D-85). And no second port of RoleCall's span finder: M3 already ported it (src/tools/prompted.ts,
   D-97 name-tag branch). The Director reuses `parsePromptedCalls` / `findNameTagCalls` (D-99).
2. §19.6 "turnsActive (7 places) → age": only the 3 shadow-arc uses are ages. `ForcedArcAction.turnsActive`
   is "turns without progress" and is renamed `turnsSinceProgress` = `turn − (lastProgressTurn ??
   createdAtTurn)` (bunraku.md §4.1).
3. §19.6 rename count: 15 `commit_planning_round.X` → `X` (11 in user-prompt.ts, 4 in momentum.ts,
   one of them `invisibleArcUpdates`) plus the bare "in commit_planning_round" → "in your plan";
   fix "a" → "an" where the new word needs it (personalities.md lists the lines).
4. `DIRECTOR_HEADER` is `[DIRECTOR CONSTRAINTS - BINDING THIS TURN]` with a hyphen (doc, Bunraku);
   one constant for contract and directive.
5. The persona filter's word boundary is NOT a `\p{…}` lookbehind (Bun bug on surrogate pairs, rev 12):
   use the char-wise boundary of `text/normalize.ts` (`isLoreWordChar`-style check of the code point
   before and after).
6. The 32 KB snapshot cap is in UTF-8 BYTES of `JSON.stringify(state)` (Bunraku counted UTF-16 chars).
7. `runDirector`'s signature in §19.6 is too narrow; D-105 gives the real input.
8. §5.11 `PathView.directorAt(msgId)`: PathView stays plain data (M6 serialises it). The fold is a pure
   function `directorAt(tree, fromId)` in `agents/director/state.ts` (D-103). Deviation, recorded.

## B. structuredCall (src/agents/structured.ts) — D-98, D-99, D-100

**D-98 Contract.**
```ts
type ReadResult<T> = { ok: true; value: T; skipped: Skip[] }
                   | { ok: false; code: 'invalid' | 'missing_directive'; message: string };
interface StructuredInput<T> {
  agent: 'director' | 'recall' | 'filing' | 'historian';
  schema: { name: string; schema: JSONSchema };      // sent as responseSchema on the structured transport
  read(raw: unknown): ReadResult<T>;                  // raw = the decoded JSON value (root already checked: object)
  system: string;                                     // tagged: the caller already put the schema + "How to answer" in it
  user: string[];                                     // one or more user messages, in order (Director: prompt, pressures)
  tag: 'plan' | null;
  route: { conn: Connection; model: string; caps: ModelCaps };
  transport: 'structured' | 'tagged';                 // chosen by the caller with chooseTransport(caps), fixed for the turn
  samplers: Partial<Samplers>; reasoning?: ModelRequest['reasoning']; maxTokens: number;
  repair: boolean;                                    // false = no correction pass (recall lite, M5)
  callKeyPrefix: string;                              // e.g. `${turnId}:director` → `${prefix}:${n}`, n = 0,1,2…
  budgetMs: number;                                   // the agent's whole time budget (D-101)
  turnSignal: AbortSignal;                            // the agent's child signal of the turn
  env: AgentCallEnv;                                  // sched, fetch, timeouts, timers, clock, random, retryMaxDelayMs, emit
}
type StructuredResult<T> =
  | { ok: true; value: T; transport; skipped: Skip[]; attempts: Attempt[]; calls: TraceCall[]; fromReasoning?: true }
  | { ok: false; code: StructuredFailCode; message?: string; attempts: Attempt[]; calls: TraceCall[] };
type StructuredFailCode = 'transport_unsupported' | 'provider_error' | 'no_output' | 'undecodable'
                        | 'invalid' | 'missing_directive' | 'timeout' | 'aborted';
interface Attempt { transport: 'structured' | 'tagged'; outcome: AttemptOutcome; ms: number;
                    status?: number; finish?: string; tokens?: number /* output tokens */ }
type AttemptOutcome = 'ok' | 'ok_reasoning' | 'retried' | 'no_output' | 'undecodable' | 'invalid'
                    | 'missing_directive' | 'provider_error' | 'transport_unsupported' | 'timeout' | 'aborted';
```
- `chooseTransport(caps)` = `'structured'` iff `caps.structuredOutput.mode === 'json_schema'` and
  `confirmedBy` is set; else `'tagged'`. Only openai-chat exists in M4 (M7/M8 add theirs).
- One call = one `streamCall` (narrate.ts) with `agent`, `responseSchema` (structured only), no tools,
  no prefill, stop = samplers' stop. Text and reasoning are collected silently (no `text` events).
- **Reading** one call's output: (1) the visible text, after `splitReasoning`-style think tags are
  stripped (the adapter already separates `reasoning`); if `caps.reasoning.answerInReasoning`, the
  reasoning is the text (narrator rule, turn.ts). (2) Find the JSON: `tag:'plan'` → D-99; `tag:null`
  → a ```json fence, else the first balanced `{…}` (`firstObject`, built on `balancedEnd`). (3) Decode
  with `looseJson` (tools/args.ts; the only jsonrepair entry). Root not an object → `undecodable`.
  (4) `read(value)`. (5) If (1)–(2) found nothing in the visible text and the reasoning text is not
  empty, search the reasoning the same way (D-60); success there is outcome `ok_reasoning` and
  `fromReasoning: true`.
- Failure codes of a read: nothing found → `no_output`; found but not decodable (incl. a span the
  scanner reports cut off, `finish:'length'` without a whole object) → `undecodable`; `read()` fails →
  its own code.
- **Correction pass** (when `repair`): once, after `no_output | undecodable | invalid |
  missing_directive`; never after provider errors, timeout, abort, transport_unsupported. Messages =
  the first request's messages + assistant (the visible text, else the reasoning, cut to its first
  1 000 chars; "(no text)" when both empty) + user (correction text, D-99). The final result is the
  LAST attempt's outcome.
- **Provider errors**: the shared policy only (§6.6): before any output, one retry on
  `isRetryable` (engine/route.ts) after `retryDelayMs` (≤ 8 s, jitter), event `retry` with this
  call's callKey. Both count as attempts (`retried`, then the retry's own outcome). No own resend,
  no fallback model for agents in v1 (deviation from §6.6's "or in the role binding"; recorded).
- **transport_unsupported**: a structured attempt answered with HTTP 400 (`bad_request`) — the server
  refused `response_format`. No silent switch to tagged (D-60: fixed per turn); the engine sends
  `notice{caps.suggest}` once per session: "the Director's model refused structured output: set
  structured_output = \"none\" under [caps.\"conn:model\"] or run rp-core probe <conn:model> --active
  --write". Tagged never returns it.
- `TraceCall` rows = `{callKey, agent, model: 'conn:model', ms, usage?}` (Trace.calls), one per call
  incl. retried ones. `usage` events carry the agent.
- Timeout and abort: the caller's budget aborts the agent signal with reason `budget:director`;
  structuredCall maps an abort to `timeout` when `reasonOf(signal)` is `budget:*`, else `aborted`.
  An http `timeout:first_byte|idle` ProviderError also maps to `timeout` ("did not answer in time").

**D-99 The `<plan>` tag.** Tagged Director answers are found with `parsePromptedCalls(text,
[{name:'plan'}, {name:'commit_planning_round'}])` (src/tools/prompted.ts, D-97 name tags + `<tool_call>`):
- take the FIRST block without an error whose name is `plan` or `commit_planning_round`; a
  `{"name": "commit_planning_round" | "plan", "arguments"|"args": {…}}` envelope inside `<plan>` is
  unwrapped (one level); later blocks are ignored (a `skipped` entry `{path:'plan', why:'extra block'}`);
- blocks with errors before it (a `<plan>` mention in prose) are ignored; if no good block exists:
  a block cut off → `undecodable`, else a block with an error → `undecodable`;
- no tag at all: a fenced JSON object, else the first balanced object, ACCEPTED ONLY if its root has
  the key `directive` (RoleCall's text path); otherwise `no_output`.
- The scanner is used as is (contract file); if it needs a new export, add it, change no signature.
- Correction texts (own, English): tagged — "Your answer had no usable plan (<reason>). Answer again
  with exactly one <plan>…</plan> block that holds one JSON object following the schema above, with a
  directive that sets at least one field. Write nothing else." structured — "Your answer was not a
  usable plan (<reason>). Answer again with one JSON object following the schema, with a directive
  that sets at least one field." `<reason>` is a short fixed phrase per code ("no plan block was
  found", "the JSON could not be read", "the directive was empty", or read()'s message cut to 200).

**D-100 Filing draft.** The "draft filing-answer reader" of M4b = a test that drives structuredCall with
`tag:null` and a filing-envelope schema `{filings:[{type, entry}]}` through a test-local `read()`
(fence, bare object, broken JSON repaired, no correction when `repair:false`). No src filing code (M5b).

## C. The Director call — D-101 … D-106

**D-101 Call parameters.**
- Binding: `roles.director ?? 'narrator'`; `'narrator'` = the narrator's binding (whole, incl. model).
  Resolved in the turn body, never at admission; a missing connection or a caps error →
  `DirectorRecord{ok:false, code:'no_connection'}`, never a Refusal. `providerOverride` (CLI
  `--provider`) applies to the Director as to every role. `binding.fallback` is not used (D-98).
- Temperature: `binding.samplers.temperature ?? 0.7` (§7.3; §5.1's "binding samplers only" means the
  PRESET's samplers are not inherited). Other samplers: the binding's only. The adapter drops what the
  caps do not accept.
- Reasoning: `binding.reasoning` if set; else `'none'` when `caps.reasoning.canDisable`, else `'low'`
  when the caps take an effort, else unset. `ModelRequest.reasoning` keeps its type ('minimal' is not
  added in M4).
- Window: `contextWindow({caps: dirCaps, local: conn.local, configWindow: config.window})`
  (prompt/budget.ts); `preset.maxContext` is the narrator's, not the Director's.
- maxTokens: full `min(16_384, window − promptTokens, caps.maxOutput ?? ∞, binding.maxTokens ?? ∞)`;
  lite `1_500`, `+1_024` when the call cannot turn reasoning off (`caps.reasoning.output !== 'none'`
  and not `canDisable`), then capped by `binding.maxTokens` and `caps.maxOutput`.
- Budget: `director.timeoutSec ?? firstByteMs/1000 + 60` (timeoutsFor(conn, ctx.timeouts)) → 660 s
  local / 180 s remote. It starts when the first call got its semaphore slot: `streamCall` gets an
  optional `onSlot?(): void` (narrate.ts contract amendment) and structuredCall arms the budget timer
  on the first `onSlot`. The correction pass and a retry share the budget.
- Call ceiling: Director calls (≤ 4: call, retry, correction, retry) are added to the narrator's
  `callsBefore`, so `CALL_CEILING` (12) counts the whole turn.
- callKey `${turnId}:director:${n}`.
- Accounting: Director calls go to `trace.calls` (agent 'director', model 'conn:model') and to
  `trace.agents.director = {status, code?, transport?}`; `gen.usage` stays the narrator's.
  `/usage` (cli `pathUsage`) adds every `trace.calls` row whose agent is not 'narrator', priced by
  that row's own model.

**D-102 Profile (lite/full).** In `runDirector`, before the call: `profile = 'lite'` when
`director.profile = 'lite'`; when `'full'` and window < 16 384 → lite + `notice{director_lite}` once
per session; when `'auto'` → lite if window < 24 576 (`SMALL_WINDOW`) or the full prompt (system +
user with history at 25 % + pressures, counted with `estimateTokens` and the session's counter, no EMA)
+ 4 096 > window. Lite: the new condensed system text (≈ 60 lines, written in M4), personality
digest, `PLAN_SCHEMA_LITE`, history 10 %, no Shadow World section and no hidden-arc pressures.

**D-103 State on the path.** `directorAt(tree, fromId)`: walk `parent` links from `fromId` (inclusive)
and return the `dir.state` of the first ASSISTANT message whose `dir` passes `checkState` and has
`reducer === 1` (ok or failed both carry a state). Hidden replies count (hiding removes text, not the
plan's history). An invalid `dir` is skipped (next ancestor) and the engine sends
`notice{director_state_invalid}` once per session. No such reply → `emptyState()` (Bunraku values:
`turn 0, nextId 1, currentMood 'ambient'`, rhythm 0/0). Callers: the turn passes U (the user message
the answer replies to; for a swipe, U = the replaced reply's parent; for a draft, the head); `/director
show` passes the head. Turns are Director turns: they freeze while the Director is off (intended).

**D-104 Records on the path.** `prep.dir` and the commit body's `dir` carry the record; a stopped
commit with partial text carries it too (the directive shaped that text; Bunraku parity); a failed
turn commits nothing. Continue writes no `dir` (its `edit` row) — the target keeps its own.
Swipe reuse [D-29]: when `kind === 'swipe'`, `onSwipe === 'reuse'`, no guidance, and the replaced
reply's `dir.ok === true` → no call; the record is a copy with `attempts: []`, `skipped: []`,
`reusedFrom: replaced.dir.reusedFrom ?? replacedId`, the persona filter re-run on the copied
directive with the current names; event `director{status:'reused'}`; `trace.agents.director.status
'reused'`. Otherwise (no dir, failed plan, guidance, `replan`) → a new plan from `directorAt(U)`.
Guided re-roll: the guidance is shown to the Director as one more line in section 6 of the user
prompt ("The player asked for a new version of the last answer: <guidance>").

**D-105 runDirector input.**
```ts
runDirector(input: {
  tree: TreeIndex; view: PathView; upTo: string;           // U
  kind: 'reply' | 'swipe'; replaced?: string; guidance?: string;
  config: SessionConfig; persona?: { name: string; description?: string; aliases?: string[] };
  charName: string;
  route: Route | null;                                      // null = no_connection
  binding: Binding; counter; window: number;
  turnId: string; turnSignal: AbortSignal; env: AgentCallEnv;
  worldSnapshot?: (view: PathView, budget: WorldBudget) => string;   // M5a; default () => ''
  emit(ev: DirectorEvent): void; notice(code, message): void;
}): Promise<DirectorRecord>
```
Pipeline: (reuse check) → state = directorAt(tree, U) → turn = state.turn + 1 → momentum → profile →
prompts → structuredCall → readPlan (inside `read`) → applyPlan (authored directive stored as
`state.lastDirective`) → enrichFromMomentum → persona filter → fitState → record. Failure: no
directive, `state = {...prev, turn}` (fitState applied), `ok:false, code`. Events: `planning` when
the call starts, then `planned{summary}` / `failed{reason: code}` / `reused{summary}`.
`summary` (English, short): `arcs +1 ~2 · seeds +1 -1 · hidden +1 · chapter 2` (only the non-zero parts;
`chapter N` when a chapter started). Provider error text is never stored (category + status only).

**D-106 Delivery.**
- Directive: `{depth:1, role:'system', src:'director', text: renderDirective(directive)}` in
  `placements`; empty directive renders '' (dropped by injectAtDepth). `{{slot::director}}` stays ''
  in v1 (a preset cannot move the directive yet).
- Contract: while `director.enabled`, the core block holds the contract (`NARRATOR_AUTHORITY` +
  "never act, speak or decide for <persona name>") on EVERY kind (reply, swipe, continue, failed
  plans) — the head stays cache-stable. `AssembleInput.contract?: string`; the core block = contract
  + tools protocol/catalog; its src is `core:tools` when tools are offered (with or without the
  contract), `core:director` when only the contract. Every `core !== null` check in assemble.ts that
  means "tools are offered" becomes `tools.length > 0` (tool room, gap note, schemas, `result.tools`).
  With the Director off, requests stay byte-identical to M3 (golden, parity, hashes).
- Continue: no Director call; the request re-renders the TARGET reply's stored `dir.directive` at
  depth 1 (as recall repeats its picks), if it has one.
- Preview: the next reply shows the contract and, at depth 1, a stub
  `[DIRECTOR CONSTRAINTS - BINDING THIS TURN]\n(the Director plans this when the turn runs)\n[/DIRECTOR CONSTRAINTS]`;
  a next swipe that would reuse shows the reused directive; `preview({turn})` re-renders that reply's
  stored `dir.directive` (so `/trace` and `/preview --turn` match what was sent).

## D. The pure core — D-107 … D-112

**D-107 Reading the plan** (`readPlan`, D-62 + rolecall.md §13): enum values are case-fixed silently;
`horizon` `X-term` → `X`; enum aliases and unknown values → field dropped, `skipped`; unknown keys →
`skipped`; `null` = absent; a section sent as a string → `looseJson`, else `skipped`; `analysis` string →
`whatHappened` (a JSON string is decoded first); missing `chapterUpdate` → `{action:'none', title:''}`;
a seed without a valid `action` → `skipped` (not 'reinforce'); `arcUpdate` key = `arcId ?? id ?? title`,
empty → `skipped`; arcDirection with a missing/invalid urgency → `'moderate'`; `tension_level` string →
number, clamped 0..10, else dropped; `targetTurn` numeric string → number, else dropped; one bad element
of a list → that element `skipped`, never the whole directive. Directive content (D-62): any non-empty of
mood, narrativeGoal, arcDirections, characterBeats, callbacks, include (a non-empty list in it),
dialogueGuidance, endingHook, avoid (a non-empty list in it), sceneGuidance (a set field in it), and
`pacing` when the model sent a valid value other than 'medium'. No content → `missing_directive`.
Limits: ≤ 40 entries per section, ≤ 12 items per directive list (lite: 3 arcDirections, 3
characterBeats, 2 callbacks), ≤ 10 intentions read (5 stored, lite 3), text ≤ 300 per field, arc title
≤ 80 (`cleanTitle`). `skipped` ≤ 20 entries, then one `{path:'skipped', why:'+N more'}`. The plan is
never searched for in the reasoning by readPlan itself (structuredCall does that, D-98).
Intention defaults (Bunraku readAnalysis): port its defaults.

**D-108 Arc matching and titles** (rolecall.md §6.3, §7): (1) exact id; (2) equal match keys; (3) ≥ 2
shared significant tokens covering ≥ half of the shorter title's significant tokens. Tokens =
`wordsOf(title)` stems, minus `DIRECTOR_STOP` (the D-46 STOP_WORDS plus a Director-only list of
English and Russian function words; STOP_WORDS itself is not changed), length > 2; an empty key never
matches. All 19 vvs-264 vectors keep their expected results. `cleanTitle`: Bunraku's steps + stutter
removal + strip an `arc-N` echo; no hex-slug rules (they cut "Dead", "Cafe"). Stage dedup against the
LAST stage only, compared after `foldText`. Seeds match by id or folded `hint`; hidden arcs by id or
match key; clues dedup case-insensitively.

**D-109 Rhythm words.** Mood → rhythm by words (`wordsOf` stems, D-63): action = {action, fight,
chase, battle, combat, бой, драка, погоня, схватка, битва, сражение}; quiet = {calm, quiet,
reflective, intimate, aftermath, peaceful, спокойствие/спокойный, тихий, тишина, размышление,
близость}; climax = {climax, кульминация}; tense = {tense, tension, напряжение/напряжённый, тревога,
тревожный}. Lead-owned `src/agents/director/mood.ts` (`MOOD_WORDS`, `moodKinds(mood)`), used by
reduce (rhythm counters) and momentum (rhythm signals). Thresholds unchanged (8 / 12 / 4).

**D-110 Prompt inputs.** History = the path's visible (not hidden) messages BEFORE U, text blocks
only (D-16), the greeting included, newest 30 within 25 % (lite 10 %) of the Director's window, the
oldest one that does not fit cut in the middle (history.ts). U itself appears only in section 6.
Self-audit runs when `state.lastDirective?.turn === state.turn` (the previous Director turn planned)
and U's parent is an assistant reply; prose = that reply's effective text, 2 400 chars head+tail.
Macros: `{{user}}` → persona name (no persona → "the player", and the persona block is left out);
`{{char}}` → the card's name; nothing else is expanded; `director.instructions` go in verbatim. A
name-only persona still gets the persona rules (Bunraku needed a description; fixed).
The tool DESCRIPTION rules of plan-round.ts (`:14-23`) move into the system prompt for both transports
(tagged adds the schema + "How to answer"; structured sends the schema in the request).
The tagged schema description = the plan JSON Schema as compact JSON (full or lite).

**D-111 Personalities.** Port the Bunraku copy (12 files) as is, plus named text fixes: weaver STAGE 9
and oracle line 291 point at `invisibleArcUpdates` with `surfaceCondition` instead of
characterSecrets/worldState/coreMemories/revealCondition; architect's orphan line 315 removed. Example
keys outside the schema stay (they land in `skipped`; an alias map waits for Chi). Default and unknown
id → `the-balanced` (Sage).

**D-112 Persona filter.** `sanitizeForPlayerCharacter(directive, names)`: names = persona name +
aliases; Unicode boundaries (A.5); removes beats/dialogue of the persona, the persona from
`include.characters` (an emptied list removes the key), arcDirections/callbacks/beats that assert the
persona's inner state (English list from Bunraku + a new Russian verb list); `endingHook` and
`narrativeGoal` are not filtered. Every removal → `skipped {why:'persona'}`. Russian fixtures required.

## E. CLI and journal — D-113 … D-115

**D-113 REPL.** `/director` (= `show`), `/director show`, `/director on`, `/director off`
(`configure({director:{enabled}})`). `show` prints, for the state at the head: turn and last result
(planned / reused / failed (code)), chapter (current + completed count), arcs (title, status,
priority, horizon, age, next beat), seeds (hint, age, reinforcements, ripe/OVERDUE), hidden arcs (title,
status, clues), intentions, last directive summary. Empty state: "The Director has not planned yet."
Help lists it; the M3 help test's "Later: /director (M4)" line changes. One-shot `send` (text mode)
prints `⋯ director: planned — <summary>` / `failed (<code>)` / `reused` on stderr like tool lines.
The banner shows `director <conn:model> (<profile>)` when enabled.

**D-114 `rp-core compact <session> [--json]`.** Opens the session through the engine (recovery runs),
takes the lock, refuses with an open or held turn (exit 5, `turn_open`), then rewrites the journal
without the `chk` and `prep` rows of closed turns (temp file → fsync → rename → fsync dir; seq numbers
kept, so versions do not change). Prints `compacted <id>: <before> → <after> bytes`. `msg.dir`
snapshots stay (risk 11: checkpoint snapshots later).

**D-115 Notices.** `director_lite` (forced full on a small window), `director_state_invalid`,
`caps.suggest` (structured refused) — once per session each, via the session's notice gate.

## G. After wave 1 (the lead's calls on the units' open questions) — D-116 … D-118

**D-116 The snapshot cap holds for every script.** §7.3's "step 5 always fits" is false for Cyrillic
(2 bytes/char) and CJK (3): a verbose Russian planner over 300 turns kept 287/300 states over 32 KB.
fitState gets two more steps, run only while still over the cap: (6) every model text (descriptions,
payoff, hint, nextBeat, clue, premise, goal, intentions) → 120 chars, clues → 1, chapters → the
current one only, working sets → 8 arcs / 10 seeds / 4 hidden arcs; (7) drop `lastDirective` (the
next turn skips the self-audit). `fit:over-cap` remains for a state still over after step 7 (byUser
items only, not in v1). `checkState` no longer bounds the whole JSON at 2× the cap: each string ≤
2 000 chars and the whole ≤ 4 × hardBytes, so the core never refuses a state it wrote itself.

**D-117 Loose ends of the pure core.**
- Momentum: `turnsSinceProgress = turn − (lastProgressTurn ?? createdAtTurn)` (A.2 stands).
- enrichFromMomentum: a name counts as directed only by a whole-word (stem-run) match or by id; the
  raw substring compare goes ("Art" is not directed by "The Party").
- structuredCall: a `{name: 'plan'|'commit_planning_round', arguments|args: {…}}` envelope is unwrapped
  on BOTH transports before `read`; a nameless `<tool_call>` whose body is an object with `directive`
  is a plan; when every tag block has an error, a fenced/bare object with `directive` is still taken.
- The Director maps structuredCall's `invalid` to `undecodable`.
- The record's `skipped` = reader + reducer + filter + fitState, in that order, capped once at
  READ_LIMITS.skipped then `{path:'skipped', why:'+N more'}`.
- Schema: `responseSchema.name = 'director_plan'`; the tagged schema text is compact JSON of
  PLAN_SCHEMA (full) or PLAN_SCHEMA_LITE WITHOUT `description` keys (lite: ≈ 1.8k → well under 1k
  tokens); the structured transport sends the schema with descriptions.
- `entries.ts` `DirectorRecord` becomes a type re-export of `agents/director/types.ts`; the line
  guard stays `anyObj`; every read of a `dir` goes through `checkRecord`.

**D-118 Accepted unit deviations** (recorded in their contract notes): state — working sets keep list
order, `lastPlantTurn` filled on eviction, unknown keys dropped by checkState; plan — arcType in the
full arc-update schema, unstored hidden fields left out of the schema, text cuts recorded in
`skipped`; reduce — `start_new` refused only while the current chapter is `active` and young, "Chapter
N" for an untitled later chapter, same mood = same stem set, climax also sets lastActionSequence;
momentum — Bunraku's rhythm guards (`> 0`) kept, planting from max(lastPlantTurn, newest seed);
prompt — `rhythm` input from `report.rhythm`, arcs sorted by `lastProgressTurn ?? createdAtTurn`;
render — Russian inner-state rule by case (nominative for verbs, dative for «кажется»-type words),
up to three filler words; structured — think tags stripped before reading, strict alternation joins
the user messages.

## H. After the review and the first live run — D-119 … D-124

**D-119 "Follows the narrator" = the same connection and model, nothing else.** `roles.director`
unset or `'narrator'` gives the Director the narrator binding's `conn` and `model` only: NOT its
`maxTokens`, `samplers`, `reasoning` or `fallback` (those are the narrator's reply settings). Live run
27.10: `rp-core new --max-tokens 300` capped every Director plan at 300 tokens → `finish:'length'` →
`undecodable` on 4 of 6 plans. An explicit director binding keeps all its fields (D-101 for them).
Overrides D-101's "binding.maxTokens caps" for the following case.

**D-120 The narrator keeps the story's language.** The contract gains one line after the persona
line: "Write the story in the language it is already written in; these constraints are in English
only for you." Live run: Mag-Mell 12B started mixing English into a Russian story from the first
English directive on.

**D-121 The Director's request always fits its window.** Lite and full alike:
1. Output reserve R = full: 4 096 (the D-102 test value); lite: 1 500 (+1 024 when reasoning cannot
   be turned off). Room for the prompt = window − R.
2. If the built prompt is over the room: shrink the LITE user prompt in this order and rebuild —
   history to 0; then the shown state with lite limits {arcs 8, seeds 10, hidden 0, stages 2 per arc}
   (oldest-progress items left out with "(+N more…)"). Full first falls back to lite (D-102, also for
   an explicit `profile = 'full'` whose prompt + 4 096 does not fit; notice `director_lite`).
3. maxTokens = min(wanted, window − promptTokens, caps.maxOutput, explicit binding.maxTokens). If
   that is below a floor of 600, nothing is sent: `DirectorRecord{ok:false, code:'no_room'}` (new
   DirectorFailCode; types.ts) and `notice{director_no_room}` once per session ("the Director's model
   window (N tokens) is too small for its prompt; give it a bigger window or a model with one").
4. The corrective pass lowers maxTokens by what its echo + correction text add (StructuredInput.count,
   lead-added); below the floor it is skipped (the first attempt's code stands).
5. Director calls get the narrator's server-truncation check (estimate vs usage.inputTotal):
   `notice{context_truncated_by_server}` once per session, as for the narrator.

**D-122 transport_unsupported is narrow.** Only a structured attempt refused with HTTP 400
`bad_request` BEFORE any output; every other 400 is `provider_error`.

**D-123 Review fixes in the pure core.** checkState reads a seed's `relatedArcId` leniently (keep a
1..2 000-char string, else drop; never refuse the state); applyPlan resolves `relatedArcId` through the
arc matcher to the arc's id (unknown → dropped + skipped) and every stored text passes the length caps,
so `checkState(fitState(applyPlan(…)))` is always a state (property test over fuzzed plans). Selectors
that echo an id (`[arc-1] The Lighthouse`, `arc-1: Маяк`, `hidden-2 …`) match that id when it exists,
else the cleaned title; new hidden titles are cleaned too. Turn numbers must be safe integers (plan
reader drops others; state reader drops a bad `targetTurn` instead of refusing). An empty
`<plan></plan>` / argument-less plan call is not a "good block": the search goes on. The self-audit
skips a HIDDEN parent reply. `summaryOf` also counts reinforced seeds (`seeds ~N`) and hidden arcs with
a new clue, stage or status (`hidden ~N`), so a plan that only did those does not read "no changes".

**D-124 compact hardening.** Before the rename, compact re-checks that it still owns the lock and that
the journal is the same file (dev/ino) with the same size as when read; else it drops its temp file
and refuses (`session_locked`). It verifies that the rewritten file is accepted line-for-line by the
reader as the original minus the dropped rows (an un-skipped line → keep those rows / refuse). The
temp file is created 0600 and given the journal's mode; the journal's mtime is kept. When recovery in
step 1 dropped a draft (a `recovered` event with a draft), compact stops before rewriting and says so
(the draft is shown first); with --json, recovery events go to stderr as JSON lines.

## F. Build units (file ownership — touch only your files; list anything else in your contract note)

Wave 1 (parallel, pure; all build against `src/agents/director/types.ts`, which the lead wrote and
only the lead changes):
- **state** — `src/agents/director/state.ts` (emptyState, limits, fitState, checkState, directorAt),
  tests `test/director/state*.test.ts`, `test/director/fold.test.ts`.
- **plan** — `src/agents/director/plan.ts` (PLAN_SCHEMA, PLAN_SCHEMA_LITE, readPlan,
  hasDirectiveContent), tests `test/director/plan*.test.ts`.
- **reduce** — `src/agents/director/reduce.ts` (applyPlan, matching, cleanTitle, rhythm), tests
  `test/director/reduce*.test.ts`.
- **momentum** — `src/agents/director/momentum.ts` (computeMomentum, momentumReport,
  planningPressures, enrichFromMomentum), tests `test/director/momentum*.test.ts`.
- **prompt** — `src/agents/director/prompt.ts`, `src/agents/director/personalities/*`, tests
  `test/director/prompt*.test.ts`, `test/director/personalities.test.ts`.
- **render** — `src/agents/director/render.ts` (DIRECTOR_HEADER, contractText, renderDirective,
  sanitizeForPlayerCharacter, summaryOf), tests `test/director/render*.test.ts`.
- **structured** — `src/agents/structured.ts`, the narrate.ts amendment (agent, responseSchema,
  onSlot in CallInput/RequestFields/modelRequest; nothing else), tests `test/structured/`.
Seams between wave-1 units (so no unit imports another unit's unfinished file):
- `types.ts` holds every shared type (state, plan, directive, record, MomentumReport, ReadResult, Skip)
  and constant; `mood.ts` holds the mood words. Both are the lead's.
- prompt.ts never imports plan.ts or momentum.ts: `systemPrompt` takes `schemaText` (the caller passes
  the compact JSON of PLAN_SCHEMA / PLAN_SCHEMA_LITE, tagged only) and `userPrompt` takes
  `momentumText` (formatMomentumReport) as strings; the Bunraku DESCRIPTION rules are prompt text and
  live in prompt.ts (`PLAN_RULES`).
- plan.ts exports `readPlan(raw, {lite})` with the `ReadResult<PlanningRound>` of types.ts; the
  integrate unit wraps it as structuredCall's `read`.
- state.ts `fitState` first applies the structural limits (completed per kind, chapters, per-item
  lists, text lengths) and then the §7.3 size steps; reduce.ts only refuses NEW live items beyond the
  live caps (`skipped`), it does not call fitState.
- render.ts `summaryOf(prev, next)` builds the event summary from two states.
- structured.ts defines `AgentCallEnv` and `TraceCall`-shaped rows; it imports `ReadResult` from types.ts.

Wave 2 (after wave 1):
- **integrate** — `src/agents/director/call.ts`, engine (turn.ts, request.ts, session.ts preview,
  admit role resolution), prompt/assemble.ts contract, trace/usage, notices; tests `test/engine-m4/`,
  `test/demo-m4/`.
- **cli** — REPL `/director`, one-shot line, banner, `/usage` agent rows, `rp-core compact`
  (cli/main.ts, session/log.ts); tests `test/cli-m4/`, `test/repl/m4-*.test.ts`.

Rules for every unit: no new runtime dependency; no `Math.random`/`Date.now` in src; Bun test; tsc
clean; English code and comments; every ported file gets a header and a PROVENANCE.md row (append
your rows to `.notes/m4-provenance-<unit>.md`; the lead merges them); ported tests keep their test
names where they still apply and say which assertion changed and why; write `.notes/m4-contract-<unit>.md`
with (1) changes needed in files you do not own, (2) deviations from this note, (3) additive API.
Run the FULL suite before you finish (`bun test`), not only your tests.
