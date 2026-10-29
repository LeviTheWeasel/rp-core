# JSON-RPC over stdio (M6, in progress)

`rp-core --stdio` lets another program control the engine through UTF-8 JSON-RPC 2.0. Send one JSON object per line to stdin. Read one JSON object per line from stdout. Diagnostics go to stderr.

Start with `initialize` using protocol version 1:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"client":{"name":"my-ui","version":"0.1"}}}
```

The response contains `protocol`, `core.version`, and `features`. Then list or open sessions:

```json
{"jsonrpc":"2.0","id":2,"method":"session/list"}
{"jsonrpc":"2.0","id":3,"method":"session/open","params":{"sessionId":"SESSION_ID"}}
```

`session/open` returns a snapshot with the session config, version, active path, tails and current turns. To start a new story, call `session/new` with `character` set to a library ID or native character object. `persona` may likewise be a library ID or native persona object. The response contains `sessionId` and `snapshot`.

To send text and generate a reply in one call, use `turn/submit` with `sessionId`, `text`, and the snapshot's `version` as `expectedVersion`. The immediate response contains `turnId` and `messageId`. Generation continues asynchronously: stdout emits `{"jsonrpc":"2.0","method":"event","params":{...}}` notifications. `done`, `stopped`, or `failed` ends the turn. `turn/stop` can be sent while generation is running. Use `session/open` to refresh the snapshot after a turn or a concurrent change.

Implemented methods in this first slice: `initialize`, `session/list`, `session/new`, `session/open`, `session/close`, `session/configure`, `session/fork`, `session/preview`, `message/send`, `message/edit`, `message/hide`, `history/select`, `history/tails`, `history/search`, `turn/run`, `turn/submit`, `turn/stop`, and `shutdown`. Closing stdin also shuts the engine down cleanly. A protocol error has JSON-RPC's `error` object; engine refusals use code `-32000` and `error.data.code`.

The protocol is **not frozen yet**. M6 still needs conflict resolution for changes made during a turn, the remaining memory, lore, director and model methods, JSON Schema, and full signal and reconnection behavior. The planned complete contract is in [ARCHITECTURE.md](ARCHITECTURE.md#122-формат-провода-m6).
