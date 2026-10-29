# M9 host API (in progress)

This branch adds the host-facing pieces of M9. `Engine.open` accepts a synchronous `SessionStore` for its journal; without one it uses the filesystem journal under `home/sessions`.

## Hooks

Pass `hooks` to `Engine.open`. `beforeAssemble` may return depth inserts (`src: 'host'`); an error emits `host_before_assemble_failed` and leaves the turn running. `transformRequest` receives a copy of shaped messages and returns text edits by index. `transformReply` returns replacement text or a veto. These two transforms fail the turn closed (`host_transform_failed` or `host_veto`). `hookTimeoutMs` sets a deadline per hook and gate; with no deadline, a hook waits until it settles or the turn is stopped.

```ts
const engine = await Engine.open({
  home,
  connections,
  hookTimeoutMs: 5000,
  hooks: {
    transformRequest: async ({ messages }) => ({
      edits: [{ index: messages.length - 1, text: 'Host-approved prompt' }],
    }),
    transformReply: async (text) => ({ text }),
  },
});
```

## Gates

`session.runTurn({ kind: 'reply', expectedVersion, inspect: true })` emits a `gate` event before the model call. Reply with `session.answerGate(turnId, gateId, { action: 'send', edits? })`; it returns `false` if no matching gate waits. `cancel` stops the inspected turn. `transformGate: true` asks for a `transform` gate; cancellation or timeout fails with `host_transform_failed` before the provider sees a request.

`consumerSignal` records when the UI leaves. It does not stop a model call already underway; a gate waiting for that UI is cancelled. An unanswered transform gate then fails closed.

In stdio, declare `capabilities.gates: ['review', 'transform']` at `initialize`. The server sends a JSON-RPC `gate/request` using `gateId` as its request id. Reply with `{ action: 'send' | 'cancel', edits?: [{ index, text }] }` as the result. `turn/answerGate` is also available. `inspect` is refused if the client has not declared `review`.

## One-shot generation

`session.draft({ kind: 'quiet', prompt })` and `session.draft({ kind: 'impersonate' })` return `{ text, usage? }` without writing entries or changing the session version. In stdio use `session/draft`; in the REPL use `/impersonate`.

## Record storage

`rp-core/testing` exports `MemoryRecordStore`, `FileRecordStore`, and `checkRecordStoreConformance`. The port transports the session header and ordered `Entry` rows, and takes an exclusive `Lease` for appends. The file implementation wraps the existing durable JSONL journal; the memory implementation clones rows at its boundary. The contract checks ordering, sequence monotonicity, exclusivity, and optional reopening of durable rows.

For the current synchronous `SessionHandle` API, a host supplies `SessionStore` instead. It has `create`, `open`, `fork` and `list`; each opened `SessionLog` appends entries synchronously and durably before the operation continues. The in-memory reference implementation supports a full turn, fork and reopening through the engine:

```ts
const sessionStore = new MemorySessionStore();
const engine = await Engine.open({ home, connections, sessionStore });
```

This synchronous boundary matches Bunraku's in-process `bun:sqlite` storage. The asynchronous `RecordStore` contract remains separately available for host adapters and conformance testing. Bridging a genuinely asynchronous store into `SessionHandle` would require asynchronous journal writes throughout the engine; a write-behind adapter would break the turn durability rules.
