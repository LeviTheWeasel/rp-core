# M4 review fixes — unit `call` (D-119, D-121 items 1–3 and 5, D-123 self-audit)

Files touched: `src/agents/director/call.ts`, `src/agents/director/prompt.ts` (one additive input),
`src/engine/admit.ts`; tests: new `test/engine-m4/window.test.ts` (15), `test/director/prompt.test.ts` (+4),
`test/demo-m4/swipes.test.ts` (one assertion). No change was needed in turn.ts, request.ts or session.ts.
Every fix test fails on the pre-fix code (checked in a scratch copy with the fixes undone: 11 of 11).

## Changes

- **D-119** `resolveDirector` (admit.ts): `roles.director` unset / `'narrator'` → binding `{conn, model}` of the
  narrator only (its admitted route); no maxTokens, samplers, reasoning or fallback. An explicit binding is
  passed whole (D-101 for its fields).
- **D-121.1–2** (call.ts `runDirector`): reasoning is resolved first (the lite reserve depends on it). Profile:
  full is a candidate for an explicit `'full'` (window ≥ 16 384) or for `'auto'` (window ≥ 24 576); it is used
  only when `tokensOf(full) + 4 096 ≤ window`, else lite; an explicit `'full'` says `director_lite` once (two
  messages: window below 16 384 / "its full prompt and 4096 tokens for the plan (N) do not fit"). Lite is built
  in the order `as is → history 0 → history 0 + LITE_SHOW_LIMITS` and the first that leaves its reserve
  (1 500, +1 024 when the call thinks) is sent; else the last (most shrunk) one goes to step 3.
  History 0 = the conversation section holds one line, "[The conversation history is left out: your context
  window is too small for it this turn.]" ('' when there was no history).
- **D-121.3**: `room = window − promptTokens`; `room < DIRECTOR_OUTPUT_FLOOR` (600, = structured.ts
  `AGENT_OUTPUT_FLOOR`) → no request, `failure('no_room', {profile, model})` (event `failed{reason:'no_room'}`,
  no `planning` event, `attempts: []`, no transport), `notice{director_no_room}` (warn) once per session.
  Else `maxTokens = min(full 16 384 | lite reserve, room, caps.maxOutput, binding.maxTokens ?? samplers.max_tokens)`.
- **D-121 item 4 (pass only)**: structuredCall gets `count` (the session's counter through `estimateTokens`).
- **D-121.5**: after structuredCall, every TraceCall row's `usage.inputTotal` is checked with
  `truncatedByServer(promptTokens, …)` (engine/ema.ts); a hit → `notice{context_truncated_by_server}` under the
  narrator's once-per-session key, message names "Director prompt", `[caps."conn:model"]` and `rp-core probe`.
- **D-123**: the self-audit runs only when U's parent is a visible (not hidden) assistant reply.
- prompt.ts (additive): `export interface ShowLimits {arcs, seeds, hidden, arcStages}`,
  `export const LITE_SHOW_LIMITS = {arcs 8, seeds 10, hidden 0, arcStages 2}`, `UserPromptInput.limits?`.
  With limits: Current Story State and Active Story Arcs keep the arcs with the newest `lastProgressTurn ??
  createdAtTurn`; Pending Seeds keep the newest by `max(plantedAtTurn, reinforcement turns)` (still shown most
  overdue first); hidden keeps the player-planted ones; "(+N more arcs/active arcs/pending seeds/hidden arcs not
  shown)". Without `limits` the text is byte-identical to before.
- call.ts additive export: `DIRECTOR_OUTPUT_FLOOR`.

## Deviations from section H (with reasons)

1. **The 600 floor is checked on the window's room only** (`window − promptTokens`), not on the min that also
   holds `caps.maxOutput` and an explicit `binding.maxTokens`. Those two still cap max_tokens. Reason: the
   no_room notice says the WINDOW is too small; an explicit director binding of e.g. 300 is the user's own
   choice (D-119 keeps it) and refusing every call with a window message would be wrong. If the lead wants
   the literal rule, it is one `Math.min` in call.ts plus a second notice text.
2. "Oldest-progress items left out" applies to the shrunk lists only. The normal PROMPT_LIMITS lists keep their
   old order (stalest arcs first), so prompts without `limits` do not change.
3. The lite shrink test uses the literal reserve (1 500 / 2 524), not min(reserve, caps.maxOutput, binding).

## Measured (test/engine-m4/window.test.ts, Russian planner of review/verify-turn grow.test.ts, Director following
the narrator, narrator maxTokens 300)

- 8 192, o200k: every one of 40 turns plans; history left out from turn 16; prompt ≤ 6 800, max_tokens ≥ 1 392.
- 8 192, chars counter (overcounts Cyrillic): plans turns 1–15, then alternates with no_room (a planned turn adds
  the self-audit, ~2 400 chars, to the next prompt), no_room from turn 33. Never over the window.
- 4 096, o200k: turn 1 plans (prompt 3 158, max_tokens 938), then no_room; the tagged lite system prompt alone is
  ~2.5k tokens there.

## For the lead (not done, outside this unit or section H)

- Small windows: the next lever would be the self-audit prose (2 400 chars) and the duplicated arc descriptions
  of "Current Story State" vs "Active Story Arcs" in the lite user prompt; D-121 does not list them.
- ARCHITECTURE.md rev 14: `no_room`, `director_no_room` (warn), the second `director_lite` reason, the
  Director's use of `context_truncated_by_server`, D-119's binding rule; §7.3's "≈ 9–10k" full prompt figure.
- cli `repl-journal.ts directorBinding` doc comment still says "the narrator's whole binding" (it already
  returns conn+model only).
