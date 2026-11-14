# JSON-RPC over stdio

`rp-core --stdio` lets another program control the engine through UTF-8 JSON-RPC 2.0. Send one JSON object per line to stdin. Read one JSON object per line from stdout. Diagnostics go to stderr.

Requests run concurrently. Responses can arrive in a different order from requests, so match them by `id`. Event notifications have no `id`.

The [example client](../tools/stdio-demo.py) starts a story from a character already in the library and prints one streamed reply:

```bash
python3 tools/stdio-demo.py <character-id> "Hello" --home ~/.rp-core
```

## Handshake

Start with `initialize` using protocol version 1:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"client":{"name":"my-ui","version":"0.1"}}}
```

The response contains `protocol`, `core.version`, and `features` (`swipes`, `events`, `models`, `memory`, `conflicts`, `draft`, `review-gate`). Any other method before `initialize`, or a second `initialize`, is an invalid-params error. To receive gate requests, add `capabilities: {"gates": ["review", "transform"]}` (either or both; see [Gates](#gates-and-drafts)).

## Sessions and turns

List or open sessions:

```json
{"jsonrpc":"2.0","id":2,"method":"session/list"}
{"jsonrpc":"2.0","id":3,"method":"session/open","params":{"sessionId":"SESSION_ID"}}
```

`session/open` returns a snapshot with the session config, version, head, active path, tails, open turns, background backlog, and Director and Compendium counts. To start a new story, call `session/new` with `character` set to a library ID (the filename without `.json`) or a native character object. `persona` may likewise be a library ID or a native persona object. New sessions use the defaults from `config.toml`; an optional `config` patch overrides them. The response contains `sessionId` and `snapshot`.

To send text and generate a reply in one call, use `turn/submit` with `sessionId`, `text`, and the snapshot's `version` as `expectedVersion`. `message/send` followed by `turn/run` does the same in two steps; `turn/run` also takes `kind: "swipe"` or `"continue"`, and optional `guidance`, `fallback`, `onError` and `emptyReply`. The immediate response contains `turnId` and `messageId`. Generation continues asynchronously, and `turn/stop` can be sent while it runs. Use `session/open` to refresh the snapshot after a turn or a concurrent change.

## Events

Events arrive as `{"jsonrpc":"2.0","method":"event","params":{...}}`. Each carries `sessionId`, `ts` and `type`:

| Type | Meaning |
|---|---|
| `start` | A turn began: `turnId`, `kind`, `messageId`, `parentId` |
| `text`, `reasoning` | Streamed deltas with an `offset`; merged into one frame every 40 ms or 768 characters |
| `prefill`, `director`, `tool` | The prefill sent, the Director's status, a tool call starting or finishing |
| `done`, `stopped`, `failed`, `conflict` | The end of a turn; `done` and `stopped` carry the authoritative message |
| `gate` | A turn waits for a host answer (see below) |
| `agent`, `memory` | Recall, filing, historian and host-hook work; changes to the Compendium |
| `usage`, `retry` | Tokens and cost of a model call; a retry after an error |
| `recovered` | A turn interrupted by a crash, found on open |
| `changed` | The session version moved (`msg`, `edit`, `hide`, `head`, `persona`) |
| `notice`, `idle` | A warning or info line; the count of pending background jobs changed (`background`) |

`text` and `reasoning` deltas are not authoritative: the final text, including any host transform, comes in `done`. Clients should ignore event types they do not know.

## Conflicts

While a turn runs, `message/edit`, `message/hide`, and `history/select` can change the history. If the version changes, the complete answer is durably held and the turn ends with `conflict{turnId,draft}`. `session/open` reports it in `openTurns` even after a restart. The client must call `turn/commitAnyway` or `turn/discard` before starting another turn. An answer committed after the head moved may become a side branch; a continued answer whose target text changed is discarded.

## Gates and drafts

`turn/run` with `inspect: true` pauses before the model call. If the client declared `review` at `initialize`, rp-core sends it a JSON-RPC request `gate/request` with `{turnId, gateId, kind, payload: {messages}}`, using `gateId` as the request id. Reply with a result `{"action":"send"}` or `{"action":"cancel"}`, optionally with `edits: [{index, text}]`; an error reply or malformed edits cancel. `turn/answerGate` with `sessionId`, `turnId`, `gateId` and `answer` does the same as a normal method. Without the `review` capability, `inspect` is refused with `gate_unsupported`.

A client that declared `transform` gets a `transform` gate on every `turn/run` and `turn/submit`. Cancelling it fails the turn with `host_transform_failed` before the provider sees a request.

`session/draft` with `kind: "impersonate"`, or `kind: "quiet"` and a `prompt`, returns `{text, usage?}` without writing to the session. See [M9-HOST.md](M9-HOST.md) for the engine side.

## Methods

| Group | Methods |
|---|---|
| Lifecycle | `initialize`, `shutdown` |
| Sessions | `session/list`, `session/new`, `session/open`, `session/close`, `session/configure`, `session/fork`, `session/preview`, `session/draft` |
| Messages and history | `message/send`, `message/edit`, `message/hide`, `history/select`, `history/tails`, `history/search` |
| Turns | `turn/run`, `turn/submit`, `turn/stop`, `turn/commitAnyway`, `turn/discard`, `turn/answerGate` |
| Compendium | `memory/list`, `memory/get`, `memory/tree`, `memory/status`, `memory/wait`, `memory/recall`, `memory/file`, `memory/add`, `memory/edit`, `memory/retire`, `memory/restore`, `memory/undo`, `memory/refile`, `memory/retry`, `memory/export` |
| Lore and Director | `lore/test`, `director/show` |
| Models | `models/list`, `caps/get`, `caps/probe` |

`models/list` and `caps/probe` contact the configured server; `caps/get` reads the locally resolved capabilities. `caps/probe` accepts `active:true` to call the model for capability checks. `memory/list`, `memory/get`, and `memory/tree` accept `at:<messageId>` to read the Compendium on a historical branch without moving the session's head. `memory/recall` returns the recall record and Compendium trace of the latest answer, or of the answer of `turnId`.

## Errors

| Code | When |
|---|---|
| `-32700` | The line is not JSON |
| `-32600` | The object is not a JSON-RPC request, or the line is longer than 16 MiB (`error.data.code` is `line_too_long`, `id` is `null`; the rest of that line is skipped up to its newline) |
| `-32601` | Unknown method |
| `-32602` | Invalid params, or a call before `initialize` |
| `-32603` | Internal error |
| `-32000` | The engine refused or the provider failed; `error.data.code` names the reason, such as `stale_version`, `session_busy`, `held_pending` or `not_found` |

Notifications (requests without `id`) never get a response, even on error.

## Shutdown and signals

`shutdown` or closing stdin stops running turns and shuts the engine down cleanly. SIGINT stops running turns without closing the host; a second SIGINT exits immediately. SIGTERM stops turns, closes sessions, and exits with code 143.

`session/open` is also the reconnection point: it returns the current snapshot and replays recovery notices for turns interrupted by a crash. Past live events are not replayed; refresh the snapshot after reconnecting.

## Schema

The [JSON Schema](../src/protocol/protocol.schema.json) for commands, responses, and events is generated from TypeScript types with `bun run schema`; `bun run schema:check` verifies that the checked-in copy is current. It allows extra fields for forward compatibility. Not yet in the schema: `session/draft`, `turn/answerGate`, `turn/run`'s `inspect`, and the `gate/request` call. The `approvals` capability is accepted but does nothing yet. The design notes are in [ARCHITECTURE.md](ARCHITECTURE.md#122-формат-провода-m6).
