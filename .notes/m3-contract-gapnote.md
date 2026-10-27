# M3 contract notes — agent `gapnote` (D-96: the gap note and the tool reminder)

Files: src/prompt/assemble/gap.ts (new), src/prompt/assemble.ts; tests: test/prompt-m3/gap-note.test.ts
(new, 27 tests), test/prompt-m3/budget.test.ts (4 tests updated for the reservation),
test/demo-m3/innkeeper.test.ts (2 tests updated, 2 added). Not touched: engine/request.ts,
engine/narrate.ts, tools/prompted.ts, shape.ts, session.ts (none needed a change).

## What it does

- `gap.ts`: GAP_SRC 'core:gap', REMIND_SRC 'core:remind', HISTORY_TOOL_NAMES, REMIND_TEXT, gapText(a, b)
  (range with U+2013, singular when a = b), gapMsg, remindMsg (role system, placement 'inline', like a
  depth insert), offersHistoryTools(tools), widestGapMsgs(pathLength) (both forms with both numbers
  all nines, as many digits as the path length). Texts are byte-equal to the decisions note (checked
  against .notes/m3-decisions.md D-96).
- `assemble`: `gapping` = tools survive D-28 (core block exists) AND they hold both history tools. Then
  the fixed part gains max(widest range note, widest single note) + the reminder (scaled with the rest
  by the EMA factor; named inside "the tool instructions N" of a refusal). After the cut, the left-out
  run is chat.msgs[from, keepFrom) with from = head (greeting kept) or 0 (greeting dropped / no
  greeting); its ends map to path positions (view.path index + 1: the history tools' numbering). After
  injectAtDepth the note is spliced in right before the message object chat.msgs[keepFrom], and the
  reminder is appended to the chat part (after every depth-0 insert; before `displaced`, which never
  coexists with tools). Nothing else changes: `kept`, `toolRoom`, trace.trimmed, the tool list.
- Verified: o200k encodes every 1–3 digit chunk (leading zeros included) as one token, so a note's
  size depends only on its numbers' digit counts; with the chars counter the length decides. So the
  widest note bounds every real one on that path (unit test over both counters).

## Readings (implemented; confirm or overrule)

1. **"History tools offered" = both names present** (search_history AND read_history, by spec name,
   after D-28). Both texts name search_history and the note names read_history, so a list with only one
   of them gets neither message. D-92 always offers them together; the toolSets test seam with other
   names gets neither (so engine-m3 tests with custom tools did not change).
2. **The note sits right before the first sent message after the run, also when the greeting is
   dropped.** D-96.1's parenthetical says "at the very start of the chat part" for that case; that is
   the same place unless a depth insert is clamped in front of the first message (e.g. the card's
   depth-2 prompt with one chat message left): then the note comes AFTER that insert, right before the
   message (D-96.1's own "before the first message object that follows the gap"). Pinned in
   gap-note.test.ts ('the greeting dropped …': `card_depth, core:gap, history, core:remind`). One rule
   for both cases; a one-line change in withGapNotes if the lead prefers the chat part's start.
3. **The reminder follows depth-0 semantics.** It is the last message of the chat part (after the
   author's note / director / guidance at depth 0). Preset blocks after {{history}} (post-history
   instructions, `bottom` blocks, bottom lore) still come after it, as after every depth-0 insert; so
   "the last message before the reply" holds when the preset has nothing after the history (the
   builtin preset with a card without post_history_instructions: the demo). Pinned with RICH:
   `history, guidance, core:remind, jailbreak, tail`. If it must be truly last, append remindMsg() to
   `messages` instead of the chat part (it would then sit after post-history text).
4. **Edges of the run.** A = position of the first trimmed CHAT message, B = of the last one. Hidden or
   blank path messages inside stay inside; one right before or after the run is outside it (e.g. u17
   hidden right after a run ending at a16: note "#2–#33", next sent message #35). Tested.
5. **The reservation is taken whenever the history tools are offered**, before knowing whether a run
   will be left out. When the history then fits whole, neither message is sent (the request is a few
   dozen tokens under budget). When the reservation itself pushes the cut over a chunk, there IS a run
   and both are sent. In the tight case where the room shrinks to what is left (D-93 note 3 of
   m3-contract-prompt), the room is computed with the reserved (widest) width: at most a couple of
   tokens smaller than with the real note — the safe side.
6. **Demo numbers.** The deterministic demo (test/demo-m3/innkeeper.test.ts: prompted, 16k window,
   reserve 2048, o200k) leaves out #2–#169, the same cut as before D-96 (checked on a scratch copy with
   the notes disabled: 32 chat messages either way; the live run in docs/M3-DEMO.md had its own
   settings and showed #2–#161). The test pins `[Messages #2–#169 …]` right after the greeting and before #170, and
   the reminder last after the question.

## For other agents / the lead

- **preview --turn (session.ts sentChanged):** 'core:gap' and 'core:remind' are classed as block rows
  (not inserts, not history), like 'core:tools'. A rebuild with another cut already reports "which old
  messages the budget leaves out"; no change made.
- **docs:** ARCHITECTURE.md §8.3 / §11 / §12.4 could name the two srcs and the reservation;
  docs/M3-DEMO.md §6's proposal is now implemented as D-96 (not in renderCoreBlock: the core block is
  unchanged, so the cached head stays the same).
- **Live rerun** of the demo is the real test of D-96 (test/live/m3-ollama.test.ts, RP_CORE_LIVE=1).
