# RoleCall import — review fixes, engine and REPL (fix-engine)

Items: ux#2 (D-195's engine half) and ux#11. Files: `src/engine/turn.ts`, `src/engine/request.ts`,
`src/cli/repl.ts`; tests `test/engine-fit/fit.test.ts`, `test/repl/preview-imported.test.ts`.

## ux#2 — a request that cannot fit is refused before the Director's model calls

- `TurnRun.body`: when the Director would plan this turn (`plans()`: director on, kind not continue),
  `cannotFit(hooked)` runs right after the beforeAssemble hook and before `direct()`. A refusal ends the
  turn through the same path as before (`keyedNotices` + `failEarly('request', code, message)`: `end
  {failed}`, no `prep`, no `dir`, empty draft). No Director event, no Director or narrator request.
- `cannotFit` builds the request WITHOUT the directive (the directive only adds to the never-trimmed
  part, so a request that cannot be built without it cannot be built with it), in two steps:
  1. `buildRequest({...input, fitCheck: 'bound'})` — cheap: pass A only, no lore run (session books,
     notes book, the card's and persona's own books stripped), no Compendium block, no `{{recap}}`
     input, and the whole lore share (`loreBudget(window, reserve)`) added to the reserve in their
     place. ok ⇒ the request fits (lore ≤ its run budget ≤ the share; the block takes what the lore left
     of the share) ⇒ no further check.
  2. Only when the bound does not fit: `fitCheck: 'exact'` — pass A of the request itself. Its
     refusal is returned (so the message is the request's own: same code, category and words as
     before; its numbers leave out the directive that was never planned, i.e. what a turn whose plan
     failed always showed). ok ⇒ go on (a bound never refuses on its own).
- The view the Director plans from (`startView` at upTo) is folded once in body() before the check
  and reused by `direct()` (`this.dirView ??= …`) and the request; `requestInput(placements)` is the
  shared RequestInput builder (body, the check, `narrate` / `fallbackLeg` unchanged).
- `RequestInput.fitCheck?: 'bound' | 'exact'` (request.ts): both stop after pass A (the tool passes
  fall back to pass A and never refuse, so pass A decides ok/!ok). Without it buildRequest is
  byte-for-byte as before. Helper `withoutBooks(cast)`.
- Cost for turns that fit: the bound only. Measured on a story with large books: the plain "pass A
  without the directive" check cost ≈ 1.2 s per Director turn (the lore run is most of an assemble);
  the bound costs ≈ 0.07–0.09 s warm per turn (the first turn's ≈ 0.4 s is tokenization the request
  then finds in the memo); two-turn A/B ≈ +0.1 s per turn. Refused turns pay bound + exact (≈ 1.2–1.7
  s there) instead of the Director's calls. Director off or a continue: no check at all.
- Residual (documented in request.ts): lore can still tip a request over by what the share does not
  bound (ignoreBudget entries, message overheads, a variable lore sets for a block): then the bound
  fits and the turn is refused after the plan, exactly as before D-195. A swipe that reuses the plan
  (no call) also runs the bound.
- Tests (`test/engine-fit/fit.test.ts`, 6): the Director following a 16k narrator → no request at all,
  `request/context_length_exceeded`, the message's shape, `end{failed}`, no prep, a second attempt the
  same; the Director on its own connection → that connection not called either; lore that tips the
  request over (description at available − share/2, a constant top entry of 0.8 × share) → refused
  before the Director, the message counts the fired lore; the false-alarm guard (same card, small book:
  the bound is over, the request is not) → Director plans, reply arrives; 32k fits → director then
  narrator, the sent request equals `preview({turn})`; Director off → same refusal, no contract part.
  Before the fix the first three failed (a Director request was made); without the lore share in the
  bound the lore test fails; refusing on the bound alone fails the guard and the lore test's message.
- Checked against the real export (counts only): 16k/32k/48k narrators → 0 kept Director requests (2
  per turn before), the same refusal code; 64k/128k → director, director, narrator per turn as before.

## ux#11 — `/preview n` on an imported answer

- `Repl.previewTarget`: after the "is yours" and "is a greeting" cases, an answer whose msg entry is
  not `gen.kind 'model'` with a trace (what Session.preview refuses with `invalid_params`) is refused
  in words: imported session (`header.imported`) → "/preview: message N was imported from RoleCall;
  rp-core did not build its request, so there is none to rebuild (/preview alone shows the next
  request)"; otherwise "… has no trace; its request was not kept, so there is none to rebuild …".
  Same for `/preview <id>`. Plain `/preview` is unchanged (works on an imported session).
- Tests (`test/repl/preview-imported.test.ts`, 2): a journal copied as an imported one (header
  `imported`, an untraced model answer) → both forms refused in words, no `invalid_params`, `/preview`
  alone previews a swipe, nothing sent; an untraced answer in a non-imported session → "has no trace".
  Both failed before (the raw `preview refused [invalid_params]` line).

## For the lead

- `rp-core preview --turn <id>` (src/cli/preview.ts) and `/trace`'s dim fallback still show the
  engine's raw refusal for an imported answer (outside these files).
