# Contract notes — agent `fix` (M1a review fixes)

Every change below is a widening (new optional field, new export, new optional parameter) unless
marked otherwise. No exported name or required signature was removed.

## On-disk format

- `session/entries.ts` `MsgEntry.tail?: true` (+ parse guard). A reply/swipe committed as a tail
  (§6.6: the head moved during its turn) is now ONE `msg` line with `tail: true`; `buildTree` does
  not move the head onto such a msg. Replaces the old two-line commit (`msg` + `head` back), which a
  crash could split (§5.3 "Атомарный коммит — одна строка"). `planFork` drops the flag on copied
  messages (on a fork the path is the main line). Old journals with `msg` + `head` still read the
  same. ARCHITECTURE.md §5.3/§6.6 updated with one line each.

## Events

- `protocol/events.ts` and `engine/recover.ts` `RecoveryEvent`: `recovered.outcome` gains
  `'dropped'` (U hidden, §6.6 applied by §6.7) and an optional `draft` (the checkpointed text when it
  was not committed: dropped, or a continue whose target changed). §6.7/§12.2 of the doc updated.
- `failed{category:'conflict', code:'session_locked', draft}`: a turn whose log lost its lock
  (another process stole it and wrote) fails with the full answer as the draft instead of claiming
  `done` (or `commit_deferred`). Verbs then refuse with `Refusal('session_locked')`.
- New notice code `stream_tail_failed` (the stream failed after its finish; the answer is kept).
- A live tail commit no longer emits a second `changed{change:'head'}` (the head does not move).

## Module surfaces

- `session/log.ts`: new exports `createSessionLogWith(home, header, initial, opts?)` and
  `publishNewJournal(home, id, bytes)` (temp file + fsync + link + dir fsync; used by create and by
  `forkSession`). `createSessionLog` keeps its signature (delegates). `append` now checks ownership
  first: same inode and size as our own writes left, and a lock re-check when the renew timer is
  overdue; `renewLock` treats a missing lock as lost when the journal changed meanwhile.
- `session/fold.ts`: new `foldViewAt(header, idx, leaf)` (the view at a turn's starting state).
- `engine/admit.ts`: new `checkOnError(v)`, shared by `admitTurn` and `submit`.
- `engine/narrate.ts`: `CallResult.tailError?`; new `providerFinish()` (provider finishes outside
  `end|length|content_filter|refusal` are recorded as `end`, raw kept).
- `engine/turn.ts`: new `replyLimits(binding, presetSamplers)`; `max_tokens` is resolved as
  binding.maxTokens ?? binding/preset `samplers.max_tokens`, drives the reserve and
  `ModelRequest.maxTokens`, and is removed from the forwarded samplers (one limit per request).
- `prompt/assemble.ts`: new `traceForSent(trace, messages)`; the engine stores the trace of the
  shaped messages in `prep` and in the commit (§5.7 "1:1"). Behaviour: on a continue in prefill mode
  depth inserts are computed without the target; on a continue the U that A answers is protected.
- `prompt/budget.ts` `trimHistory` opts gain `maxKept?` (preset.context.maxMessages); a limit
  smaller than a chunk shrinks the chunk to `maxKept - protected + 1`.
- `prompt/assemble/chat.ts` `chatArea` lost its 4th `maxMessages` parameter (helper, not a contract
  file; its only caller is assemble).
- `prompt/assemble/slots.ts`: `protectSlots/fillSlots/splitAtHistory` take an optional `scope`; new
  `slotScope(blockId)`. Sentinels are numbered per block in the block's own scope.
- `prompt/macros/lex.ts`: new `braceMatches()`; `parseRange` takes an optional brace map (linear
  parse). `prompt/macros/table.ts` `CallCx.takeOriginal()`.
- `formats/card.ts`: new `pngCardChunkKeywords()`. `formats/kind-markers.ts`: new
  `looksLikeVnProject`, `looksLikeAgnaiExport`, `foreignKindReason`.

## Known limits left as they are

- Assembly follows the primary connection's caps. If a fallback's `caps.prefill` differs from the
  primary's, a continue re-shaped for the fallback keeps the primary's depth counting (prefill vs
  cue), i.e. inserts may sit one message off on that fallback attempt only.
- A crash during session creation before the link leaves a hidden `.s_<id>.<pid>.new.tmp` in
  `sessions/`; nothing lists or reads it, nothing sweeps it either.
- A lock is still stolen from a live same-host pid after the TTL (a suspended process); the thief
  is safe because the victim now detects the theft and refuses every write.
