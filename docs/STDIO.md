# JSON-RPC over stdio (M6, in progress)

`rp-core --stdio` lets another program control the engine through UTF-8 JSON-RPC 2.0. Send one JSON object per line to stdin. Read one JSON object per line from stdout. Diagnostics go to stderr.

Requests run concurrently. Responses can arrive in a different order from requests, so match them by `id`. Event notifications have no `id`.

The [example client](../tools/stdio-demo.py) starts a story from a character already in the library and prints one streamed reply:

```bash
python3 tools/stdio-demo.py <character-id> "Hello" --home ~/.rp-core
```

Start with `initialize` using protocol version 1:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"client":{"name":"my-ui","version":"0.1"}}}
```

The response contains `protocol`, `core.version`, and `features`. Then list or open sessions:

```json
{"jsonrpc":"2.0","id":2,"method":"session/list"}
{"jsonrpc":"2.0","id":3,"method":"session/open","params":{"sessionId":"SESSION_ID"}}
```

`session/open` returns a snapshot with the session config, version, active path, tails and current turns. To start a new story, call `session/new` with `character` set to a library ID (the filename without `.json`) or native character object. `persona` may likewise be a library ID or native persona object. New sessions use the defaults from `config.toml`; an optional `config` patch overrides them. The response contains `sessionId` and `snapshot`.

To send text and generate a reply in one call, use `turn/submit` with `sessionId`, `text`, and the snapshot's `version` as `expectedVersion`. The immediate response contains `turnId` and `messageId`. Generation continues asynchronously: stdout emits `{"jsonrpc":"2.0","method":"event","params":{...}}` notifications. `done`, `stopped`, `failed`, or `conflict` ends the turn. `turn/stop` can be sent while generation is running. Use `session/open` to refresh the snapshot after a turn or a concurrent change.

While a turn runs, `message/edit`, `message/hide`, and `history/select` can change the history. If the version changes, the complete answer is durably held and the turn ends with `conflict{turnId,draft}`. `session/open` reports it in `openTurns` even after a restart. The client must call `turn/commitAnyway` or `turn/discard` before starting another turn. An answer committed after the head moved may become a side branch; a continued answer whose target text changed is discarded.

Implemented methods: `initialize`, `session/list`, `session/new`, `session/open`, `session/close`, `session/configure`, `session/fork`, `session/preview`, `message/send`, `message/edit`, `message/hide`, `history/select`, `history/tails`, `history/search`, `turn/run`, `turn/submit`, `turn/stop`, `turn/commitAnyway`, `turn/discard`, `lore/test`, `director/show`, `models/list`, `caps/get`, `caps/probe`, `memory/list`, `memory/get`, `memory/tree`, `memory/status`, `memory/wait`, `memory/recall`, `memory/file`, `memory/add`, `memory/edit`, `memory/retire`, `memory/restore`, `memory/undo`, `memory/refile`, `memory/retry`, `memory/export`, and `shutdown`. `models/list` and `caps/probe` contact the configured server; `caps/get` reads the locally resolved capabilities. `caps/probe` accepts `active:true` to call the model for capability checks. `memory/list`, `memory/get`, and `memory/tree` accept `at:<messageId>` to read the Compendium on a historical branch without moving the session's head. Closing stdin stops running turns and shuts the engine down cleanly. SIGINT stops running turns without closing the host; a second SIGINT exits immediately. SIGTERM stops turns, closes sessions, and exits with code 143. A protocol error has JSON-RPC's `error` object; engine refusals use code `-32000` and `error.data.code`.

The [JSON Schema](../src/protocol/protocol.schema.json) for commands, responses, and events is generated from TypeScript types with `bun run schema`; `bun run schema:check` verifies that the checked-in copy is current. It allows extra fields for forward compatibility.

`session/open` is the reconnection point: it returns the current snapshot and replays recovery notices for turns interrupted by a crash. Past live events are not replayed; refresh the snapshot after reconnecting. The planned contract is in [ARCHITECTURE.md](ARCHITECTURE.md#122-формат-провода-m6).
