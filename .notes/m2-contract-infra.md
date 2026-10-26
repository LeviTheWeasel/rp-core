# Contract notes — infra agent (M2: record/replay, wire())

Files: src/providers/record.ts (bodies), src/providers/openai-chat.ts (wire() only),
src/providers/scripted.ts (one export), test/record/.

## Additions to contracts (all additive)

1. **`RecordedCall.aborted?: true`** (record.ts). Set when the call ended in an abort (the request
   signal aborted before the inner stream finished: Stop, first-byte/idle timeout). Replay of such a
   call yields the recorded events and then holds, like a silent server, until the replay's own
   signal aborts (so Stop / timeouts reproduce). A consumer that merely stops iterating without an
   abort (the engine breaks after an error event) is NOT marked aborted.
2. **New exports in record.ts:** `RAW_CAP_BYTES` (4 MiB), `RAW_TRUNCATED_MARK` (an SSE comment
   appended to a cut raw body), `toRecordedEv(ev)`, `fromRecordedEv(ev)` (the ProviderError ↔
   RecordedEv mapping; `detail` is never recorded).
3. **scripted.ts:** `canonicalJson` is now exported (used by requestDiff); behaviour unchanged.
4. **openai-chat.ts:** `wire(req)` = `{url, body}` from `buildChatRequest(req, opts, null)`, body
   parsed from the JSON string; no headers are returned at all (so neither the key nor a D-53 header
   value can reach a preview). Throws what buildChatRequest throws (tool_protocol_invalid, bad base
   URL). The recording provider passes `wire()` through; the replay provider has none.

## Behaviour decided here

- `sink(line)` gets the JSON text WITHOUT a trailing newline: the CLI should
  `appendFileSync(file, line + '\n')`. A sink that throws fails a call that went well; when the call
  itself failed, the call's own error wins.
- The recorder starts the inner call at `stream()` time (as without the recorder; the scripted
  provider consumes its call then) and snapshots the request then. A call whose iterable is never
  iterated writes no line.
- Scrubbing is wider than the contract comment: the call's own `env.key` is always scrubbed (even if
  `secrets()` does not list it), and every string of the line is scrubbed (request, events, error
  messages, finish.model, raw). Text / reasoning / tool_args deltas are scrubbed per channel, so a
  secret split across two deltas is redacted in both pieces (piece count kept). raw is also scrubbed
  for the JSON-escaped spellings of each secret (`\"`, `\\`, `\/`), and a raw cut at 4 MiB loses a
  trailing secret prefix of >= 6 chars. Known limit: a server that splits a secret across two SSE
  events (or encodes it) leaves the pieces in raw; the events are clean.
- Raw: env.fetch is wrapped; each response body goes through a pull-based pass-through stream
  (highWaterMark 0, no read-ahead; cancel reaches the server), decoded with one streaming
  TextDecoder per call. raw is the body as the consumer READ it (the adapter stops at [DONE], so a
  trailing byte after it may be missing). Redirect bodies are cancelled unread, so raw is the final
  response's body. raw is absent when the inner provider never fetched.
- Replay: hash from `hashRequest`; calls are consumed at `stream()` time (a mismatching one too,
  like scripted). Mismatch → yielded error event, code `replay_mismatch`, category `request`,
  afterOutput false, message = `"<fixed message> (recorded call N of M)\n" + requestDiff(...)`; when
  the recording's own request does not hash to its requestHash (hand edit) a `note:` line says so.
  Exhausted → `script_exhausted`, message `"<fixed message>: request N has no recorded call left
  (the recording has M)"`. Aborts are honoured before every event (signal reason thrown).
- requestDiff labels the sides `recorded` / `actual`, names messages 0-based (`messages[3] (user)`),
  shows ±60 chars around the first differing char with a caret line (control chars escaped as \n,
  \t, \uXXXX), then counts (messages, tools added/removed/changed), prefill, maxTokens, samplers;
  capped at 40 lines; identical requests → `no difference in what the model sees`.
- parseRecording: physical 1-based line numbers (`recording line N: ...`), BOM/CRLF/blank lines
  tolerated; a line without `"v": 1` is rejected (with a hint when it looks like a script); unknown
  top-level and event fields are rejected; blocks are only checked to be `{k, ...}` objects.

## For the integrate / cli owner (not done here: src/cli/provider.ts still refuses record:/replay:)

- `record:<file>`: wrap each role's Connection provider with
  `createRecordingProvider(conn.provider, line => appendFileSync(file, line + '\n'),
  { connection: conn.id, secrets: () => rt.secrets.known() })`, keeping the connection's caps and
  origin (the requests must be shaped by the real caps).
- `replay:<file>`: `createReplayProvider(parseRecording(readFileSync(file, 'utf8')))`. Open
  question: which caps the replay connection carries. The recording stores no caps, and the request
  is shaped by caps (prefill, tools, midSystem), so replaying under SCRIPT_CAPS would mismatch a
  recording made against a real connection. Suggest: replay keeps each role's configured connection
  (caps, origin, id) and only swaps the provider, so the same config replays byte-identically.
- The replay_mismatch message is multi-line and quotes the user's own prompt (local display only;
  §13 keeps only {category, code, status} in the session log). REPL / one-shot printing should
  print it as is; --stdio carries it in the error event message.
