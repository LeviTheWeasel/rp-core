# M5b contract — unit `demo` (wave 3)

The §15 M5b demo end to end on the scripted model through the real CLI with the lane in auto mode, its
transcript (`docs/M5B-DEMO.md`), the seed tool's `--compendium` (D-182), the M5a demo brought to the
current output, and two integration fixes the demo found. Decisions: D-171, D-172, D-176, D-178,
D-180, D-182, rulings G and H. Nothing ported (no provenance note).

## Files

| file | what |
|---|---|
| `test/demo-m5b/lantern.test.ts` | new: the demo (11 tests over one recorded run of six CLI processes; the last prints the transcript) |
| `test/demo-m5b/script.txt`, `chat.jsonl` | new: the 36 typed lines; the scripted model (caps `contextLength: 4096`, then 19 calls: 9 narrator, 8 filing, 2 historian; lane answers carry a `{"delay": 200}` step) |
| `test/demo-m5b/crash.txt`, `crash.jsonl`, `recover.txt`, `recover.jsonl`, `again.txt`, `again.jsonl` | new: the killed chat (a 60 s filing call), the reopen (the rerun's answer), a third open (no calls) |
| `test/demo-m5b/turn-first.test.ts` | new: 2 tests for fix 1 (the first fails without it) |
| `test/demo-m5b/seed.test.ts` | new: 3 tests, the seed tool spawned (`--compendium` off by default, on, a bad value) |
| `tools/fixtures/seed-innkeeper.ts` | `--compendium off\|on` (default off): the session's `compendium.enabled`; the seeding engine opens with `lane: 'manual'`; one more stdout line says which |
| `test/demo-m5a/lantern.test.ts` | step c: the `{{recap}}` slot (the book's `[Arc]`) right after the greeting, ahead of the depth-1 block and directive; `/trace` `recap:` line; `lore: nothing fired` |
| `docs/M5A-DEMO.md` | the transcript and the claim table to the current output (C16 = the book's `[Arc]`, Мира C17, the slot in `/preview`, `/trace`'s recap line), one note line on it |
| `docs/M5B-DEMO.md` | new: intro, claims, setup, the transcript a–h with notes, the timing claims, the live recipe, the fixes |
| `src/engine/lane.ts`, `src/engine/session.ts` | fix 1 |
| `src/prompt/assemble.ts` | fix 2 |

## How the demo runs

`beforeAll` spawns `bun src/cli/main.ts` six times in one `tmpHome`: `import lantern.compendium.json`;
`config.toml` = `[compendium] idle_delay_sec = 0` + `[compendium.historian] interval = 3`; `new --card
test/demo-m5a/card.json --persona … --lore lantern --no-chat`; `chat --keep-requests --provider
script:chat.jsonl < script.txt` with `RP_CORE_LANE=auto`, `EDITOR=`, `VISUAL=`, `NO_COLOR=1`; a second
chat (`spawnCli`) killed with SIGKILL once its `job{begin}` is in the journal and `/memory wait` is
echoed; a reopen; a third open. Every line that gives the lane work is followed by `/memory wait`, so
the scripted lines are taken in a fixed order; a lane pass's line is read together with the wait after
it (`withWait`), so no claim hangs on which side of the echo it printed. The run is the same on every
run except the session and message ids. ≈ 4.5 s for the six processes; `bun test test/demo-m5b` 16 pass,
≈ 6.5 s.

Steps: a. filing after accepted answers (job row, mem row, range, overlay by alias); b. a swipe takes the
answer's entries off the path, `/[` brings them back (no job row, no request); c. `/e 3` → stale → a
second row for the key, staged from the new text; d. `/memory undo 5` (the human revert row, nothing on
wait) and `/memory refile 5` (a third row); e. lenient reading (fence, dropped memory, `items` envelope,
Russian types, camelCase, a bad enum, `{"filings": []}`); f. the historian twice (#1–#7, then #8–#13
after an overlap #4–#7), the book's plot reused, the session arc C21; g. U7's request trims U1…A4, the
slot = H1's arc revision + H1's summary at boundary U5; `/preview` after H2 and the swipe A7′ keep it;
h. kill -9 → the reopen re-runs the begin (attempt 1 again), one mem row for the key, no failed row,
a third open idle. Plus: 19 kept requests (9/8/2), the historian's numbered positions and its
OVERLAP/NEW lines.

## Integration fixes

1. **The lane started a pass between a message and its turn** (`src/engine/session.ts`,
   `src/engine/lane.ts`). Cause: `submit` = `send` + `runTurn`; `send` pokes the lane, and in auto mode
   it began the accepted answer's pass before the turn was registered. On a one-place origin the filing
   call took the place, then the narrator preempted it: on the scripted model the filing call ate the
   narrator's line (the narrator answered with filing JSON); on a local server a wasted call per message
   and a cold cache. Fix: `LaneHost.busy()` (SessionImpl's); `Lane.pump()` starts nothing while a turn
   of the session runs; `submit` appends the message through a private `sendLine` (no poke), registers
   the turn, then pokes (try/finally). The turn's `turnSettled` poke starts the pass. `send` alone and
   `memoryWait` behave as before; a running pass is preempted as before.
2. **The `{{recap}}` slot landed below the depth-1 inserts** (`src/prompt/assemble.ts`). Cause: the slot
   was spliced right before the first chat message kept after the cut; when that message is the
   current one (greeting + first message), the block and the directive (depth 1) share the gap and the
   slot went between them and the message (M5a demo step c failed). Fix: the slot goes right after the
   kept greeting (index 0 of the chat part without one), ahead of the depth inserts and the gap note in
   that gap (§10 layout: greeting → `{{recap}}` → … → current message). `test/recap-m5b` unchanged.

## Tests run

`test/demo-m5a` 9, `test/demo-m5b` 16, `test/demo-m3`, `test/demo-m4`: 70 pass together. To check the
two fixes: `test/lane-m5b`, `test/recap-m5b`, `test/engine-m5a`, `test/repl-m5b`,
`test/tui/lane-m5b.test.ts`, `test/cli/lane-m5b.test.ts`: 173 pass. `bunx tsc --noEmit -p .` clean.

## For the lead (docs not mine)

- README: the seed tool's row (≈ :1984) gains `[--compendium off|on]`; a test-table row for
  `bun test test/demo-m5b`; `docs/M5B-DEMO.md` in the demo list. docs/M3-DEMO.md's seed commands work
  unchanged (off is the default).
- ARCHITECTURE rev 17: the lane starts nothing while a turn of its session runs (fix 1; refines D-172's
  "remote origins run background alongside": a pass already running still does); the slot's place is
  right after the greeting, ahead of depth inserts (fix 2).

## Open questions

1. `send` alone followed by a separate `runTurn` (an API client) can still begin a pass in between; only
   `submit` is covered. Guard `runTurn` too (abort a pass begun since the send), or leave it?
2. `/memory status` in a chat whose narrator has no connection lists the file tasks but not the
   historian check (no recorder window); an engine with the connection lists both. Fine as it is?

## After the review (fix-lane)

Open question 1 is settled by the lead's ruling I: the lane holds back while the head is a user message
younger than max(idleDelaySec, 2 s), so a `send` followed by `runTurn` begins nothing in between.
`test/demo-m5b/turn-first.test.ts`'s second test now checks that hold (fake timers, a still clock):
nothing at the send, nothing at 1 999 ms, the filing at 2 s.

## After the review (fix-cli)

`docs/M5B-DEMO.md` section d: the undo line now reads `(/memory refile #5 file runs it again)` (cli#3: the
way back names the kind of pass undone), and the paragraph under it says why. The rest of the transcript
was compared line by line with the test's printed run: unchanged (ids, timings and the elided `…`
lines aside). `test/demo-m5b/lantern.test.ts` pins the new line.
