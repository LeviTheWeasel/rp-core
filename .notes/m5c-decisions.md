# M5c decisions (the lead's design note; authoritative for the M5c build)

M5c = "recall": before a reply, a model picks the Compendium entries the narrator will need (tier 1 of
the M5a selector), synchronously next to the Director or as a background prefetch while the player types
(ARCHITECTURE.md §7.4.2, §7.4.6, §7.4.7, §15 M5c, §19.7; D-78, D-79, D-84, D-85; M5a D-140…D-169, M5b
D-170…D-184, the import D-185…D-195). These become D-196…D-212 in ARCHITECTURE.md rev 19 (question 27).
Research (the lead gives the absolute path): `<session scratchpad>/m5c/understand/` — `design.md` (spec
digest; 28 gaps in §7), `bunraku.md` (+ `bunraku-probe/`: Bunraku's recall, prompts verbatim, tests),
`rolecall.md` (+ `rc-recall-vectors.ts`), `rpcore.md` (insertion points), `demo.md` (+ `demo-draft/`).
Sources: Bunraku @ 702d8120 (Coneja-Chibi); RoleCall @ fb8dc623e (the prompt and tree lines carry the
660a7d67a caveat). Public-repo rules as always (no e-mails, the author only as Levi, no absolute paths);
agents run only their own tests, remove temp dirs, no file over 5 MB, never call a model.

**D-196 Scope.** M5c ships the recall agent (index full/lite, prompts, lenient read, top-up), the typed
`RecallRecord`, modes `auto|sync|prefetch|lexical|off` with `onMiss` and `graceSec`, the `prerecall` lane
task, scheduler promotion for the grace wait and Director-first ordering on one place, tier 1 into the
selector, the trace, reuse on swipe/continue, `/memory recall|profile|mode`, the `/trace` recall line,
the TUI agents pane, `history_crowded` (D-89), notices `recall_slow`, `prefetch_missed`,
`recall_index_truncated`. Moved to a later milestone **M5d (latency)**, because none of it can be checked
on this machine (no llama.cpp, koboldcpp or LM Studio; Ollama is reached through `/v1`, which cannot set
runner options): `id_slot` pinning and the `/slots` probe (`slots_detected`), Ollama runner-option
mirroring and `ollama_options_mismatch`, `lmstudio_autoevict`, `bench ttft`, the prefetch-quality
acceptance harness. Untyped book entries as recall picks (D-76's extension) are also deferred: M5c recall
picks typed Compendium entries only (listed deviation).

**D-197 The index.** Candidates = live typed entries of the view (session and readable books), fresh
(D-152 `visibleCopy`, boundary of the nearest ancestor reply), not in the `{{recap}}` slot (the nearest
ancestor's `trace.recap.ids`), not retired. Notes and arcs are not candidates. Handles `e1…eN` in print
order, per request. Full: the derived tree (`deriveTree`, D-165) to depth 2, lines
`[eN] Name (aka a, b) - tagline`, under one `World Knowledge` heading with bucket/group headings, budget
≤ min(20 000, 25 % of the recall window) tokens; Lite: a shortlist of ≤ 40 — first the entries named in
U or the last 4 messages (mention.ts), then by `lexScore` against the last 6 messages (docs: name,
aliases, tagline), lines the same, no tree headings, budget ≤ min(2 000, 15 %). Overflow: lines stop,
`(+N more entries not shown)`, `notice{recall_index_truncated}` once per session. Empty index → no call
(record `skipped`).

**D-198 Prompts.** Full = Bunraku's `RECALL_SYSTEM`, HARD REQUIREMENT, guidance block, user layout and
answer shape verbatim, plus edits (listed): the prefetch line («The player has not answered yet; pick what
the narrator will most likely need for the next reply.») as the user message's last line in prefetch
runs; the conversation is the last `contextMessages` visible messages (full 20 / lite 6) capped at
min(8 000, 20 % of the window) tokens, long messages cut head+tail; the language rule of D-183 does not
apply (recall answers handles). Lite = a new short text (~90 tokens; no WILD CARD). The repair is
structuredCall's corrective pass (one mechanism, as M5b); the top-up («fewer than minEntries») is a second
call within the same deadline, full only, and replaces the first answer only if it parses and has more
picks. temperature 0.3; maxTokens 2 000 full / 200 lite (+1 024 when reasoning cannot be turned off);
`AGENT_OUTPUT_FLOOR` does not apply to lite recall.

**D-199 Reading.** structuredCall passes the raw answer text to the reader for `tag: null` agents (new
`rawRead` hook). The recall reader accepts: `{picks:[...]}` / `{entries:[...]}` / a bare array; items as
handles (`e12`, `[e12]`), names (exact normalizeName of name or alias, unique), or objects
`{id|handle|name, reason?}`; handles salvaged from prose when nothing parses (counted `salvaged`); unknown,
repeated and over-`maxEntries` picks counted (`unknown`, `repeated`, `trimmed`). An answer whose only JSON
sits in reasoning is not read (§7.4.2 incident rule). Structured transport: the schema has `picks` and an
optional `reasons` object.

**D-200 RecallRecord.** The spec's shape (ARCH §7.4.2) with `picks` as entry KEYS, plus `source: 'off'`
not written (off writes no record). Written in `prep` and the commit only when recall ran or a prefetch
was missed: `status: 'recalled' | 'empty' | 'skipped' | 'failed'`, `source: 'sync' | 'prefetch' |
'lexical' | 'reused'` (lexical = a miss or failure fell back; then `code` says why). Typed and guarded in
`session/entries.ts`; a bad stored record reads as absent.

**D-201 Modes.** `auto` = prefetch when the recall binding's origin is local (scheduler's locality), sync
otherwise; `sync` = recall next to the Director; `prefetch` = only adopt a prefetch (wait ≤ `graceSec`),
`onMiss` decides (`auto`: lexical on local, sync on remote); `lexical` = no recall, the selector's tiers
0/2/3 (no `lexScore` substitute for tier 1); `off` = no recall and no block tier 1. With the lane in
`manual` mode or a one-shot command, prefetch never runs: `auto` on a local origin behaves as `onMiss`.
Recall needs Compendium on and a non-empty index; else nothing runs.

**D-202 Prerecall in the lane.** Derived work (D-171): when the head is an assistant reply (committed) and
the mode wants a prefetch, the lane derives `prerecall:<head id>`; it runs before file/hist tasks, writes
no job rows, is never journaled or recovered (a miss), is preempted by any interactive request and
restarts after the idle gate; its result is kept in memory keyed by its basis. The basis is (head id,
compendium rev, recall model, profile, a hash of the recall settings); the turn adopts a prefetch whose
basis matches U's parent and current settings, and writes it into `prep` as `source:'prefetch'`.

**D-203 The turn.** Order: the D-195 fit pre-check (no recall call when the turn cannot fit), then recall
and the Director: sync recall runs alongside the Director (`Promise.allSettled`); on one place the
Director acquires first. The grace wait: a prefetch in flight for the right basis is promoted to
interactive priority and awaited ≤ `graceSec`; the Director runs meanwhile on a remote origin, after it on
a local one. Miss → `onMiss`; a Stop ends the wait (the prefetch keeps running for next time). Picks go to
the selector as tier 1 in recall's own order (D-153 amended: tier 1 keeps the model's ranking). A swipe or
continue reuses the answered message's record (`source:'reused'`, `reusedFrom`) when it is `recalled` or
`empty`; a failed or absent one runs per mode; a guided re-roll (`/regen <guidance>`) recalls again.
`trace.compendium.source` = the record's source (or `lexical`/`off` without one); `trace.agents.recall`
gets status/code/transport.

**D-204 Timeouts and notices.** Deadline from the grant: sync 30 s local / 20 s remote, prefetch 60 s;
`recall.timeoutSec` overrides all three. `recall_slow` once per session after 3 sync recalls slower than
8 s (advice: prefetch, a cheaper `recall` model); `prefetch_missed` once per session (advice: a longer
`grace_sec`, a second slot); `recall_index_truncated` (D-197). Usage of adopted prefetches and sync calls
counts in `/usage` through the record's `calls`/`model`; prefetch calls never adopted are not journaled
(like superseded lane runs, documented).

**D-205 history_crowded (D-89).** After assembly, when the history sent holds fewer than 4 messages
before U although the path has more, `notice{history_crowded}` once per session, naming the fixed part's
size and advising a larger window or a lighter preset (the imported RoleCall story case).

**D-206 Commands.** `/memory recall [--turn <id>]`: the record of the head answer (or that turn): source,
status, picks with names and C<n>, reasons, counts, calls, ms; `/memory profile`: the resolved profile per
agent (block, recall, filing, historian) and why; `/memory mode <auto|sync|prefetch|lexical|off>` sets
`compendium.recall.mode` for the session; `/trace` gets a `recall:` line; the TUI agents pane shows recall
blocks (sync and prefetch); `MEMORY_LATER` becomes empty.

**D-207 Test and demo seams.** `RP_CORE_RECALL=lexical|off` (read once in createEngine like
`RP_CORE_LANE`) overrides the recall mode default; `test/preload.ts` sets `lexical`, so pre-M5c scripted
tests and spawned CLIs make no recall calls; M5c tests opt in. The scheduler takes locality from the
connection's `local` flag when set (so a `script:` connection can act as a local origin in tests), else
`isLocalOrigin`. The scripted provider matches a line tagged with an `agent` to calls of that agent, so a
Director and a recall running concurrently consume their own lines deterministically.

## G. Rulings after wave 1 (the lead)

- The answer field is `entry_ids` (Bunraku's verbatim prompt asks for it); the reader also accepts `picks`.
- A lite answer that cannot be read is `status:'failed'` (code `undecodable`), like full: not reused on a
  swipe, the turn falls back per `onMiss`.
- A request that cannot fit the recall window writes a `skipped` record with code `no_room` (the contract
  type has it) and the turn goes lexical.
- `RP_CORE_RECALL` overrides only the default mode; an explicit config or `/memory mode` wins.
- A prefetch still queued when the player's message arrives is promoted like one in flight.
- Locality (D-207 as built): a configured connection uses its `local` flag (else the URL's guess); an
  in-process connection is local only when its provider says so (`localOrigin`, a scripted file can ask
  for it); otherwise `isLocalOrigin`; mixed flags on one origin → local.
- `history_crowded` lives in the request builder (assemble's results are pinned by older tests).

## H. Rulings after wave 2 (the lead)

- The greeting is a prefetch basis (else the first reply of a local `auto` session always misses).
- The prefetch basis also includes the newest edit/hide on the path and the hidden count.
- The prefetch is a lane slot, not a `LaneTask`; `MemoryStatus` gains an optional `prefetch?: {basis,
  state}` field for `/memory status`; `idle{background}` counts it.
- A prefetch arriving after `graceSec` is cancelled (superseded); a Stop during the wait lets it run on at
  background priority. An adopted prefetch's calls are counted through its record (/usage), not the
  turn's `trace.calls` or CALL_CEILING.
- Previews of the next turn stay lexical (no recall call from a preview); `/preview --turn` rebuilds tier
  1 from the answer's record.

## I. After wave 3 (the lead)

- **D-202 amended.** The prefetch basis is (head id, the path's newest touch and hidden count up to the
  head, the recall setup's fingerprint) — not the Compendium's rev. The demo showed every lane row filed
  after a prefetch (filing on is the default) wasting it: a second, byte-identical prefetch per answer.
  Picks are entry keys and the block reads their current text; an entry filed after the prefetch stays
  reachable by name and search.
- `memoryWait` (engine) waits for a queued or running prefetch too (the REPL did it on its own).
- `/memory recall test <text>` and call start offsets in the trace are not built (not in D-206).

## J. The live run on Ollama (the lead)

Setup: the innkeeper story and book, magmell-16k (16 384 → lite), Director off, filing and historian off,
idle_delay_sec 2. Results: the first turn's prefetch (after the greeting, while the model loaded) missed
→ lexical; the prefetch after #3 was adopted with no recall call in the turn (2.6 s in the background) but
could not know the player's next question (the merchant, by description) — sync mode exists for that;
the next prefetch and a sync recall both failed: the RP-tuned 12B model answered the recall prompt IN
CHARACTER (270 tokens of Marfa's prose, no handles). Replayed with an assistant prefill `{"entry_ids": [`
the same model answered `e1]}` — valid, though a weak pick.

**D-208 JSON prefill for the JSON agents.** For `tag: null` agents on the tagged transport, when the
model's caps allow an assistant prefill, structuredCall prefills the answer's opening
(`{"entry_ids": [` recall; `{"filings": [` filing and historian) and the reader reads prefill + answer.
Off for the structured transport and for models whose caps say no prefill. Listed deviation (Bunraku and
RoleCall send no prefill).
**Words.** An answer with text but no readable selection is `undecodable` («the model did not answer with
a selection»), never `no_output` («empty») — `no_output` only for an empty answer.
**Advice in the docs.** Bind `recall` (and `recorder`) to an instruction-following model when the narrator
is an RP fine-tune; `/memory profile` shows the binding.

## K. Rulings after the review (the lead)

- At most two recall calls: the top-up runs only when the first structuredCall made one model call (no
  repair) — Bunraku's `calls < 2` (core#1).
- The reader keeps scanning after an opener that never closes; a later whole value of the recall shape
  wins over a cut or a jsonrepair of the rest; the prompt's own example echoed before the answer never
  wins (core#2, #7). `{"e1": "reason"}` items read as handles; several handles in one item all count
  (core#6, #9). Same-named entries never duplicate index lines (core#4). minEntries is capped at the
  index size (core#8). The lite shortlist's lexScore query drops stop words and splits CJK (core#5). Any
  edit to Bunraku's verbatim full prompt is listed (core#10) or removed.
- `memoryWait` (engine) waits for a queued or running prefetch (engine#1, breaker#4).
- `prefetch_missed` (notice and record) only when the turn really waited for a prefetch that existed;
  a failed prefetch is a fallback with its own code and no notice; the wording says what happened
  (engine#3, #5, #7, cli#5, breaker#3).
- A guided re-roll and `onSwipe: rerun` recall again (sync) and never adopt the prefetch the first
  version used (cli#4, breaker#1). The basis' head is the newest ASSISTANT reply before U, skipping user
  messages (breaker#2).
- The grace wait holds the Director back only when both share the recall origin's single place; a
  miss→sync recall is ordered behind the Director on one place; `ordered()` only on a one-place origin
  (sched#3, #5, #7). `RecallRecord.ms` and `recall_slow` count recall's own time, not a wait for the
  Director (engine#6).
- `/preview --turn` and `/trace` of a continued answer use the record of the request they show
  (engine#4, breaker#5, #6).
- Scripted connections: recall is off for a script with no `recall`-tagged line (old untagged demo
  scripts keep working without RP_CORE_RECALL); replay origins take locality from the recording when it
  says so (sched#2, #4). Error texts name the real script line (sched#8, #9).
- CLI words: manual lane / one-shot never claims a prefetch; lines after a swipe or regen say what happens;
  'the answer was not a selection' for prose; status after a skipped prefetch says what the next reply
  does (cli#3, #6, #8, #9, #10).
- D-208 (JSON prefill) is in this round.
