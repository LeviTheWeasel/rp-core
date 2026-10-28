# M5c contract — demo (wave 3: §15 M5c's deterministic demo, docs/M5C-DEMO.md)

The deterministic M5c demo, run through the real CLI on scripted models (research: the lead's
`m5c/understand/demo.md` §2–§9 and `demo-draft/story.json`), and its transcript. No source file
changed: the run found no integration bug that needed code (one design cost, below). Nothing ported
(no provenance note).

## Files

| file | what |
|---|---|
| `test/demo-m5c/lantern.test.ts` | new: 14 tests over one recorded run of six CLI processes (`import`, `new`, `chat` ×4 in one home); the last prints the transcript |
| `test/demo-m5c/script1.txt`, `chat1.jsonl` | chat 1: the story to U7, mode lexical; M5b's A1–A7 (its `chat.jsonl` lines 2, 3, 7, 10, 13, 15, 17, copied) + H1–H3 |
| `test/demo-m5c/script2.txt`, `chat2.jsonl` | chat 2: remote origin, `maxInFlight: 2`; `/memory mode auto|profile`, `/model`, Director ∥ recall (U8), `/preview`, `/r`, timeout (U9), H4 |
| `test/demo-m5c/script3.txt`, `chat3.jsonl` | chat 3: `"local": true`; `/memory mode`, `/memory wait 1`, a missed prefetch (U10), an adopted one (U11), lane order, `/memory status`, `/usage` |
| `test/demo-m5c/script4.txt`, `chat4.jsonl` | chat 4: reopened remote; `/r` and `/c` reuse the stored record; narrator lines only |
| `docs/M5C-DEMO.md` | new: intro, claims table, setup, the transcript (home as `<home>`), the timing claims' engine tests, what needs live hardware (M5d), findings |

Every call line is agent-tagged (`{"agent": …, "steps": […]}`). Children run with `RP_CORE_RECALL`
removed from the environment (the session's config decides) and `RP_CORE_LANE=auto`, `NO_COLOR=1`.
config.toml: `idle_delay_sec 0`, recall `mode "lexical"`, `grace_sec 1`, `timeout_sec 4`, filing off,
`historian.interval 2`. ≈ 11.5 s for the six processes; `bun test test/demo-m5c` 14 pass, ≈ 12 s.

## Claims (each a test)

1. Story without recall: three historian passes; A6/A7 trim #2–#9; A7's slot = the `[Arc]` only
   (`trace.recap.ids = []`); `history_crowded` once; no recall request.
2. U8 names no entry; the kept index holds H1 (e13) and H2 (e12), not H3 (fresh-hidden); R1 (fence, a
   repeat, `e99`) → picks [H1, Фонарный ряд], `unknown 1, repeated 1`; `/trace` `(model)` first; the
   narrator's block has `[Lore: Переправа к маяку]` and the salt boat is in no other sent message;
   `/preview` (lexical) lacks it. Director ∥ recall: both calls ≥ 1.2 s, `gen.ms` < their sum.
   Swipe: `reused`, 0 calls, `reusedFrom`. U9: R2 sleeps 10 s → `failed/timeout`, `source lexical`, the
   answer comes.
3. Local: `/memory wait 1` → the prefetch after #19 runs; U10 waits 1 s → `prefetch_missed` (record
   exact), turn ≥ 1 s and < 4 s, no recall call; P2 (two names) adopted at U11: `source prefetch`,
   `basis A10`, `calls: narrator`; the prefetch request ends with `PREFETCH_LINE` and holds no U11;
   `/usage` `recall 2 calls · in 1204 tok · out 12 tok`.
4. Reopened remote: `/r` and `/c` reuse (`reusedFrom` A11 / A11′); chat 4 sent two narrator requests.
Plus: 26 kept requests (14/1/6/5), every recall request `maxTokens` 200, `p_`/`t_` names.

## Deviations from the research plan

- `/memory recall test` and `Trace.calls` start offsets are not built (cli Q3): "the selector alone"
  is `/preview` of the swipe (previews never call recall); "beside the Director" is the calls' `ms`
  against the turn's `gen.ms` (D 1.2 s, R 1.2 s, turn ≈ 1.6 s), the order on one place is left to
  `test/recall-engine-m5c` / `test/sched-m5c`.
- The slot at A7 holds only the arc (its budget is what the history leaves), not H2 as the research
  estimated: both H1 and H2 are "trimmed and not in the slot"; the slot exclusion itself stays in
  `test/recall-engine-m5c/reuse.test.ts`.
- The Director is turned off before U9: at 4 096 its lite prompt no longer fits there
  (`director_no_room`, D-121; checked by a variant run). The timeout claim does not need it.
- `timeout_sec = 4` (not 1): it applies to prefetches too, and the slow prefetch of chat 3 must still
  be running when U10's grace ends (≈ 2 s after the open; margin ≈ 2 s).
- P3 names typed entries (e3, e13) instead of the book's untyped «Песня фонарщиков» (D-196: untyped
  entries are no candidates).
- `/memory wait` follows U10 and U11 directly (before `/trace`), so a 200 ms prefetch never prints under
  another command.

## Finding (pinned by test 3c; not changed)

**A lane pass right after a prefetch makes the lane prefetch again.** The basis carries the Compendium
rev (D-202); the lane runs prerecall before file/hist (§6.2); the historian's row moves the rev, so
the held prefetch for A11 stops matching and a second, byte-identical request is sent (the new
summary is fresh-hidden), kept as `p_<A11>_recall_0-2.json`. With filing on (the default) on a local
origin this is likely two prefetch calls per answer, the first wasted, the second holding the slot
after the pass. Options for the lead: a basis from what the request reads (candidate keys + revs after
freshness, or a hash of the request), or the answer's due file/hist before its prerecall.

## Open questions

- Q1 The finding above: keep (documented), or change the basis / the order? The test pins today's
  behaviour (3c expects three lane lines and the `-2` file), so a change shows up there.
- Q2 (cli Q1) `/memory wait` waits for the prefetch only in the REPL; the demo needs no more. An API
  client's `memoryWait` still returns while a prefetch runs.

## Tests run

`TMPDIR=… bun test test/demo-m5c test/demo-m5b test/demo-m5a test/recall-engine-m5c`: 66 pass,
0 fail (demo-m5c 14, three runs in a row plus one with demo-m5a/m5b running in parallel: all pass).
`bunx tsc --noEmit -p .` clean.
