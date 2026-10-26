# Contract notes: agent `m1b-fix` (fixes from the M1b review)

Every change below widens the contract: a new optional field, a new export, or a new optional
parameter. No exported name or required signature was removed. Behaviour changes are marked
**behaviour**.

## providers/types.ts

- `PROVIDER_ERROR_MESSAGE: Record<ProviderErrorCode, string>` and `providerMessage(code, status?)`
  give one fixed sentence per code (§13).
- `ProviderError.detail?: string` holds the raw server or transport text, for `--debug` only. The
  constructor takes `detail?`. `withAfterOutput(b)` returns a copy that keeps `detail`.
- **behaviour**: `message` is now the fixed sentence plus status or origin, everywhere:
  - `classifyHttpFailure`: `"the server refused the API key (HTTP 401)"`.
  - In-stream errors: `"… inside the stream"`.
  - `guardedFetch` network errors: `"could not reach <origin>"`.
  - `bodyBytes`: `"the response body broke off"`.
  - narrate.ts: `"the connection failed"`.

  The server's words, fetch's own words and `metadata.raw` moved to `detail`.
- `ProviderEnv.onActivity?(): void` is called on every body chunk, SSE comments included (§8.8).
- `EngineOptions.onProviderError?({sessionId, turnId, callKey, model, error})` is a debug tap for raw
  failures, including retried and tail failures. Events never carry `detail`.
- `EngineOptions.timeouts`: the doc now says the timeouts count bytes, not events.

## providers/openai-chat.ts, sse.ts, http.ts

- **behaviour**: `createChatReader` emits `finish` together with the chunk that carries
  `finish_reason`. That finish follows the settle steps (splitter, `tool_end`, `reasoning_end`) and
  the usage known so far. Usage that arrives later goes out at `[DONE]` or EOF, and only when it
  changed. The first `finish_reason` wins. Text after a finish is still emitted. An error after the
  finish comes after it, so narrate records it as a tail error.
- **behaviour**: `sseEvents` dispatches buffered data early when it is already a whole JSON value or
  `[DONE]` and another `data:` line arrives. A lone `[DONE]` is dispatched at once. Streams without
  blank lines are read line by line. True multi-line events are still joined.
- `isModerationError(err)` is exported from http.ts. A 403 whose body carries
  `metadata.reasons` / `flagged_input`, or `/moderation|flagged|content_policy|content_filter/i`,
  maps to `content_filter` (category content). This applies to HTTP and in-stream errors alike.

## engine

- **behaviour** (narrate.ts `ActivityWatch`): before any byte arrives, the deadline is `firstByteMs`.
  After that, `idleMs` counts from the last byte or event. Before the first event, the call fails
  only when both deadlines have passed. The abort reason is `timeout:idle` once an event arrived,
  otherwise `timeout:first_byte`.
- **behaviour** (narrate.ts): a Stop after the finish no longer produces a `tailError`. The answer
  commits with the provider finish and no `stream_tail_failed` notice.
- **behaviour** (turn.ts): `ModelRequest.maxTokens` is the reserve, capped by the route's
  `caps.maxOutput`. The reserve is now `replyReserve(window, min(binding max_tokens, caps.maxOutput))`.
  A new once-per-session notice `max_tokens_reduced` reports when the user's `max_tokens` was cut.
- New notice `context_truncated_by_server` (warn, once per session). It fires when the reported
  prompt tokens are less than 0.5 × the estimate, and the estimate is at least 256.
- `engine/ema.ts`: new `truncatedByServer(estimated, reported)` and `TRUNCATION_MIN_ESTIMATE`.
- `prompt/tokens.ts`: new `EMA_DISCARD_BELOW = 0.5`. **behaviour**: `emaFactor` skips samples below
  it instead of clamping them up to 0.8. The threshold is not `EMA_MIN`: with a chars/3 estimate,
  ordinary English sits at about 0.75.

## session

- `session/tree.ts`: new `swipeSiblings(idx, id)`: siblings of the same role and the same kind
  (greeting or generated).
- **behaviour** (`fold.ts`): `MessageView.swipe {index, count}` counts `swipeSiblings`, not every
  child of the parent. `show` and the REPL status line therefore agree with `/[` and `/]`.

## config

- `config/secrets.ts`: new `isHeaderSafeKey` (0x21–0x7E) and `isHeaderSafeValue`.
  **behaviour**: a key from `key_env` or `key_cmd` containing other characters raises
  `key_unavailable` with a fixed message. `spawnRunner` spawns `detached` (its own process group).
  On timeout, or when rp-core exits, it SIGKILLs the whole group.
- `config/config.ts`, **behaviour**: a D-53 header variable that is unset, empty, or holds a
  character a header cannot carry no longer throws `ConfigError` from `buildConnections`. That
  connection's `resolveKey` rejects with `key_unavailable`, with a message like
  `"connection 'x': header H: environment variable V is not set"`. The header is then never sent.
- `Fields.missing(k, why)` (internal): a missing required field that has a misspelled sibling
  (for example `base-url`) reports `"<that key>: unknown field; did you mean base_url?"`.

## providers/probe.ts, cli/catalog.ts

- `CatalogInfo.authFailed?: true` is set when the `/models` ladder answers 401 or 403.
- `ProbeResult.notStored?: string`.
- **behaviour**: on an auth failure the result is `ok:false`, the error starts with `auth_failed`,
  exit is 1, and nothing is stored. A row that says nothing (server unknown and no caps) is never
  written. Neither is a named model the server does not list; llama.cpp and koboldcpp are exceptions
  because they serve any name. `written` means rows were actually stored.
- Empty `caps.source` prints as `source engine defaults only`.

## cli

- `Runtime.debug?: (line) => void` is set by `--debug` for every command. `redactor(rt)` and
  `debugLine(info)` are exported from runtime.ts. `engineOptions` wires `onProviderError` and reads
  `rt.debug` at call time.
- `render.ts`: new `redactEvent(ev, redact)` and `hasServerWords({category, code})`. The text
  renderer takes `redact?` and prints a `--debug` hint after a provider failure.
- `ReplDeps`: `redact?`, `debugTap?(print) => detach`, `connectionProblem?(conn)`.
- `ReplOptions.terminal?: {stdin, stdout}` lets tests drive the real readline on a fake TTY.
- **behaviour** (REPL):
  - readline's output is muted while a turn streams.
  - Ctrl+C during a turn always stops it.
  - At the prompt, Ctrl+C with typed text clears the line.
  - The prompt redraws with the held text (`prompt(true)`).
  - `/model` refuses connections the runtime skipped, giving the reason.
  - `--debug` lines are printed through the REPL screen.

## Not done / notes

- The reviewer's `finish_reason then a connection reset` case against `Bun.serve` fails because of
  the mock, not the adapter. Bun.serve drops a chunk that is enqueued right before `controller.error()`,
  so the client never sees the finish (checked: with a 50 ms gap the chunk arrives). The same case
  with a fake fetch passes.
