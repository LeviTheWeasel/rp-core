# Provenance

rp-core is AGPL-3.0-or-later (ARCHITECTURE.md §2, D-11). Code ported from RoleCall (VAUDEVILLE) or
Bunraku keeps its original copyright in the file header and gets a row here (§2 rules 2–3).

Sources:
- **RoleCall** — `~/ST/VAUDEVILLE`, app `apps/rc`, branch `dev/Levi` @ `fb8dc623e6beb24083f5105c828462e89fc66ce3`.
  Note: everything that predates VAUDEVILLE entered it in import commit `660a7d67a` (Coneja-Chibi,
  2026-04-12), so git attributes those lines to Chi only; pre-import authors come from the team (D-34).
- **Bunraku** — `~/Documents/AI/Bunraku` @ `702d81201120a6b90eb29a783a77c60ffdebc374`,
  AGPL-3.0-or-later, Copyright (C) 2026 Coneja-Chibi.
- **SillyTavern / SillyBunny** — AGPL-3.0; behaviour reference, attributed where facts or code are taken.

Header for ported files:

```ts
// Ported from <repo>:<path>@<commit>.
// Copyright (C) 2026 <original authors>; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
```

## Ported files

| Core file | Source | Commit | Verdict | What changed |
|---|---|---|---|---|
| `src/engine/recover.ts` | Bunraku:src/studio/scene-turn-resume.ts (`resumeScene`) | 702d8120 | adapt | Open turns found from the journal (no closing msg/edit/end); `held` left open; chk text committed `interrupted` with prep's dir/recall/vars and a partial trace; conflicts follow the core's unconditional-commit rule (commit.ts: reply/swipe under the original U, tail + head entry when the head moved, `dropped` when U is hidden; continue on a changed/hidden target → `abandoned`) instead of Bunraku's unguarded commit at the end of the take; empty → `end{abandoned}`; `recovered` events; no module `running` set |
| `src/engine/route.ts` | Bunraku:src/studio/scene-turn-fallback.ts (`isFallbackWorthy`) | 702d8120 | adapt | Keyed on rp-core ProviderError {code, status, afterOutput} with §6.6's status set (adds 524/529); "before any output" folded into the predicate; status-less failures never retried; retry-after delay with cap and injected jitter; `conn:model` parsing |
| `src/engine/turn.ts` | Bunraku:src/studio/scene-turn.ts (`runTurn`, `commit`) | 702d8120 | adapt | Turn rules mapped onto log lines: beginTurn → `turn`, first saveCheckpoint → `prep`, saveCheckpoint → `chk` (400 chars / 1 s, timer-driven, plus fdatasync cadence), commitTurn(guard) → `msg`/`edit` with `base`, dropTurn → `end`. Kept: Stop keeps what arrived, failure drops and returns the draft, an answer in hand is never thrown away (`commit_deferred`), fallback only before output and never after Stop, nothing_to_add. Removed: variables written before the send (D-30: vars ride the commit), module `running`, `full` events, unguarded commit of a failed reply, DOMException('stopped'), recall/trackers/regex/Final Cut/Inspector/meter. Added: one same-model retry before the fallback, typed Refusals in admit.ts, onError 'keep' (D-22), reasoning-only rule (D-31), host-hook call points |
| `src/formats/card.ts` | RoleCall:apps/rc/src/lib/import/png-parser.ts | fb8dc623e | adapt | Chunk walk kept, on `Uint8Array`/`DataView` instead of `Buffer`. Added zTXt and iTXt (compressed and not) via `node:zlib` `inflateSync` with a 64 MB output cap. Returns every text chunk in order instead of the first match. Truncated files keep what was read instead of throwing; CRCs not checked; console logging dropped. |
| `src/formats/card.ts` | Bunraku:src/formats/_shared/png.ts | 702d8120 | adapt | Only the ccv3-over-chara rule (~30 lines). npm `png-chunk*` libs replaced by the own walk (no iTXt crash). Keyword match case-insensitive like ST; an undecodable ccv3 falls back to chara with a warning. Writer side not ported. |
| `src/formats/card.ts` | Bunraku:src/formats/sillytavern/index.ts | 702d8120 | adapt | `detectCard` and the cross-kind firewall (~45 lines). Rejection now carries a reason (`whyNotCard`). Canonical model, escrow, adapter registry and exporters not ported. |
| `src/formats/card.ts` | Bunraku:src/formats/_shared/tavern-fields.ts | 702d8120 | adapt | Field rules of `dataToBody`/`readDepthPrompt`: empty depth_prompt = none, numbers written as strings coerced. Role default `system` applied at import (core type requires a role). Empty strings map to absent so no empty override is fabricated. Greetings drop empty first_mes. V3-only fields to `extras`, warnings for nickname/group_only_greetings/assets/world/regex_scripts. |
| `src/formats/card.ts` | Bunraku:src/formats/_shared/character-book-decode.ts | 702d8120 | adapt | `findCharacterBook` homes (data.character_book, data.extensions.character_book, envelope top level); now all found books merge into one `book`, identical copies collapse. |
| `src/formats/import.ts` | Bunraku:src/formats/_shared/repair-json.ts, kind-markers.ts (via kind-markers.ts) | 702d8120 | adapt | Fixed D-72 detection order instead of the 29-adapter scoring registry. |
| `src/formats/kind-markers.ts` | Bunraku:src/formats/_shared/kind-markers.ts | 702d8120 | port | `isExportEnvelope`, `looksLikeSettingsExport` as-is (guards inlined). Added `looksLikeWorldInfo` (from `sillytavern/lorebook.ts` `readBook`), `looksLikeCharacterBook` (from `character-book-decode.ts` `isStandaloneCharacterBook`) and a `lorebook_v3` unwrap. |
| `src/formats/kind-markers.ts` | Bunraku:src/formats/_shared/repair-json.ts | 702d8120 | port | `unwrapDoubleEncoded`, `readingsOf`; `unwrapExportEnvelope` folded into `readingsOf`. |
| `src/formats/native.ts` (`canonicalId` only) | Bunraku:src/core/canonical.ts | 702d8120 | adapt | Cap 64 code points (was 120), fallback `untitled` (was `character`), combining marks `\p{M}` kept, NFKC re-applied after lower-casing. Windows device-name guard kept. Header note sits above the function (file header is the architect's). |
| `src/formats/st-worldinfo.ts` | Bunraku:src/formats/_shared/character-book-decode.ts | 702d8120 | adapt | Entry field map reading both homes (extensions first, `case_sensitive` top first). NOT ported: 2/3 → examples position map, scanDepth 100, depth 4 / priority 100 / weight 1 stamped defaults, "Entry N" titles, insertion_order → sortOrder/priority renames. Position through the real ST enum; `group` split on commas; leftovers → `extras` with folded warnings. |
| `src/formats/st-worldinfo.ts` | Bunraku:src/formats/_shared/lore-enums.ts | 702d8120 | adapt | selectiveLogic and role enums; `ensureUniqueEntryIds` → `wire.uniqueIds` (`-2`, `-3` suffixes). |
| `src/formats/st-worldinfo.ts` | Bunraku:src/formats/sillytavern/lorebook.ts | 702d8120 | adapt | WI file shape and ST field names. Position enum fixed (3 → note_after, 5–7 real slots); missing fields follow ST's entry template (selective true, position 0). |
| `src/formats/st-worldinfo.ts` | SillyBunny:public/scripts/world-info.js, public/scripts/world-info-character-book.js | 3021edcae | reference | Facts only: position enum 0–7, `normalizeWorldInfoPosition` aliases, `convertCharacterBook` field homes and defaults, `newWorldInfoEntryDefinition`. |
| `src/formats/wire.ts` | Bunraku:src/core/guards.ts | 702d8120 | adapt | `isRecord`, `deepEq`, present-or-absent readers; `optNum` accepts numeric strings; `WarningSink` folds per-entry warnings. |
| `src/prompt/assemble.ts` | Bunraku:src/core/assembly/assemble.ts, preset.ts, note.ts | 702d8120 | reference | No code copied. Taken: step order, splitting the history block's text around its marker, one trace row per sent message, loud preset errors. Not taken (§19.3 "Не переносить"): several macro passes, stripping unknown macros, macro expansion of history, RoleCall depth, the unsent character-prompt reserve, the 60 % pre-trim, the `[Author's Note: …]` wrapper. |
| `src/prompt/assemble/guidance.ts` | Bunraku:src/core/assembly/guided-swipe.ts (`buildGuidedSwipeDirective`, `REJECTED_DRAFT_LABEL`; wording originally RoleCall:apps/rc/src/lib/ai/guided-swipe.ts @ fb8dc623e) | 702d8120 | adapt | Directive wording kept; the rejected draft is no longer a separate assistant message followed by a system message (invalid mid-dialogue at Anthropic, §8.5) but sits inside the one system block at depth 0, under the label, fenced with a backtick fence longer than any run in it, clipped to 2 000 code points [D-41]; a draft-less variant drops the references to the draft; direction clipped to 10 000. Attempt-record machinery not ported. |
| `src/prompt/budget.ts` | Bunraku:src/core/tokens/trim.ts (trimHistory) + src/core/assembly/budget-app.ts (fitHistory) | 702d8120 | adapt | Merged into one pass over {id,tok}: chunk grid anchored at the oldest droppable message, walk newest→oldest with early stop; protectedHead added; off-grid cut only at the start of the protected tail; returns keepFrom/trimmed ids/fits. contextWindow/replyReserve written to §11/D-89 (Bunraku request.ts presetWindow not ported). Behaviour reference only (no code): RoleCall apps/rc/src/lib/ai/prompt-assembly.ts finalPassBudgetTrim @ fb8dc623e; its chars/4 measure and one-message-at-a-time drop not ported. |
| `src/prompt/depth.ts` | Bunraku:src/core/assembly/conversation.ts (injectAtDepth) | 702d8120 | adapt | RC depth (0 = before current user msg) replaced by ST depth computed directly (slot = count − depth, clamped); one sort by (slot, deeper-first for overflow, order asc default 100, source rank, input index); inserts become separate PromptMsg {placement:'inline', src 'source[:srcId]'}, never merged [D-47]; blank inserts skipped (ST behaviour). |
| `src/prompt/macros.ts` | Bunraku:src/core/macros/{evaluate,process,limits,registry}.ts | 702d8120 | adapt | Kept depth-first trimmed args, immediate side effects, depth 100 + output/step caps, trim-marker post-pass. Unknown macros stay literal as authored with args unevaluated (RoleCall stripped them); only card fields/{{original}} re-expand (not every result containing `{{`), with a per-field cycle guard; RNG = one subRng('macro:'+source) per block source instead of a run-wide seeded stream; variables go to a run overlay → VarsDiff instead of a store; dropped interceptors, volatility/cache flags, segments, error list, \n{3,} squash |
| `src/prompt/macros/lex.ts` | Bunraku:src/core/macros/parse.ts, normalize.ts | 702d8120 | adapt | Kept brace pair-scan, depth-0 `::` split (never-floored depth), window parsing with absolute offsets, unsplit comment body, escape sentinels, <USER>/<BOT>/<CHAR>. Dropped block forms (if/else, block setvar/trim), dot/dollar shorthand, offset map. Unclosed `{{` is now literal with scanning resumed after it. ST space/single-colon forms are read from the call head instead of regex rewrites (nested macros in the arg survive; colons after the first stay in the item). Parse depth capped at 102 |
| `src/prompt/macros/table.ts` | Bunraku:src/core/macros/handlers/{identity,text,random,time,variables}.ts | 702d8120 | adapt | Closed table of §10.4 only. random = ST list pick only (no RoleCall numeric range, D-43); pick = ST getPickReplaceMacro hash seed instead of RoleCall `_pick_` chat variable; roll = droll grammar, digits-only → 1dN, invalid → ''; card fields + {{original}} return templates (D-42); vars are string/number, addvar/incvar/decvar follow ST addLocalVariable; time/date/weekday from env.now + env.timeZone, en-US (unknown zone → UTC, U+202F → space) |
| `src/prompt/rng.ts` | Bunraku:src/core/lore/rng.ts | 702d8120 | port | mulberry32 verbatim (stream identical, checked over 1000 draws × 5 seeds); cryptoUnit/freshSeed dropped (entropy belongs to engine/system.ts); added splitmix32, FNV-1a hashString over UTF-8, subSeed/subRng for labelled sub-streams (D-44) |
| `src/prompt/shape.ts` | Bunraku:src/core/assembly/continuation.ts (continuationPrefill, continuationAddition) | 702d8120 | port | continuationResult = continuationAddition plus echo of a long (≥20 chars, word-boundary) suffix of the base, whitespace-only addition → '', cue mode joins with exactly one blank line; returns {addition, full}. Prefill/cue decision by caps.prefill (not a model-id regex as in RoleCall prefill-injection.ts); cue text is the core's own. |
| `src/protocol/coalesce.ts` | Bunraku:src/ui/server-chats-turn.ts (`coalesceTurnEvents`, lines 43–104) | 702d8120 | port | No `full` variant; batches keyed by (sessionId, turnId, type), several open at once; only exactly contiguous offsets merge; a text↔reasoning switch within a turn flushes first; timers and the 40 ms / 768-char thresholds injectable; `close()` added |
| `src/protocol/events.ts` (`applyDelta` only) | RoleCall:apps/rc/src/lib/ai/streaming/stream-delta.ts (`missingStreamSuffix`, `applyContentStreamEvent`) | fb8dc623e | adapt | One `offset` instead of start/end offsets; no `full` replace; a gap throws RangeError (client resyncs from `done`); an overlap overwrites the range it covers and keeps text past it |
| `test/fixtures/cards/Seraphina.png` | Bunraku:samples/sillytavern/characters/Seraphina.png | 702d8120 | copy | Unchanged. SillyTavern's default card (by OtisAlejandro), AGPL-3.0 as part of SillyTavern. |
| `test/fixtures/cards/v3-full.json` | Bunraku:samples/sillytavern/characters/v3-full.json | 702d8120 | copy | Unchanged. Bunraku sample. |
| `test/formats/png.test.ts` | Bunraku:src/formats/_shared/png.test.ts | 702d8120 | adapt | Chunk-order regression cases; carrier built with `test/formats/png-writer.ts` (own CRC32) instead of npm libs; iTXt/zTXt cases added. |
| `test/infra/events.test.ts` | RoleCall:apps/rc/src/lib/ai/streaming/__tests__/stream-delta.test.ts | fb8dc623e | adapt | "drops fully replayed" and "slices partial overlaps" cases rewritten for offset-only `applyDelta`; the `full` and `withStreamOffsets` cases dropped |

Commits: `702d8120` = Bunraku `702d81201120a6b90eb29a783a77c60ffdebc374`, `fb8dc623e` = RoleCall
`fb8dc623e6beb24083f5105c828462e89fc66ce3`, `3021edcae` = SillyBunny (facts only). Verdicts follow §19:
*port* (code kept nearly as is), *adapt* (code carried over and reshaped), *reference* (behaviour or
facts only, no code copied: no port header), *copy* (a fixture file, unchanged).

Every *port*/*adapt* source file above carries the port header; a file ported from several sources
names them all. `src/formats/native.ts` and `src/protocol/events.ts` hold one ported function each
(`canonicalId`, `applyDelta`); their headers say so.

### Fresh code (no rows)

Written for rp-core, with at most the *idea* of a source (as §19 marks them): `src/session/*`,
`src/protocol/jsonl.ts` (§19.2 says adapt from Bunraku `readLines`, but D-36 asked for a byte-level
LF splitter with torn-tail spans, so nothing was copied), `src/engine/{engine,session,admit,commit,
checkpoint,bus,context,hooks,narrate,abort,sched,system}.ts`, `src/providers/{types,scripted}.ts`,
`src/formats/library.ts`, `src/prompt/tokens.ts`, `src/prompt/assemble/{slots,chat,hash}.ts`,
`src/cli/*` (Kintsu K4 used only as a spec; Bunraku `cli-io.ts` only as the style of strict flag
parsing) and `src/index.ts`, `src/testing/index.ts`. Test scenarios that follow a Bunraku test's idea
without its code (e.g. `test/infra/coalesce.test.ts`, "a thousand tiny chunks") have no row.
