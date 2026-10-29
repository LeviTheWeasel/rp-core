# M9 host API (in progress)

This branch adds the host-facing pieces of M9. `Engine.open` accepts a synchronous `SessionStore` for its journal; without one it uses the filesystem journal under `home/sessions`. `Engine.openWithRecordStore` connects the asynchronous `RecordStore` port to the turn lifecycle and returns an asynchronous facade.

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

For the synchronous `SessionHandle` API, a host can supply `SessionStore`. It has `create`, `open`, `fork` and `list`; each opened `SessionLog` appends entries synchronously and durably before the operation continues. The in-memory reference implementation supports a full turn, fork and reopening through the engine:

```ts
const sessionStore = new MemorySessionStore();
const engine = await Engine.open({ home, connections, sessionStore });
```

For an asynchronous store, use `Engine.openWithRecordStore` and await session operations:

```ts
const engine = await Engine.openWithRecordStore({ home, connections, recordStore });
const session = await engine.createSession({ character });
const sent = await session.send({ text: 'Hello', expectedVersion: await session.version() });
const turn = await session.runTurn({ kind: 'reply', expectedVersion: sent.version });
for await (const event of turn.events) { /* render event */ }
await turn.result;
await engine.close();
```

The facade keeps an in-memory fold of each open session and queues writes to the supplied `RecordStore`. It waits for the `turn` row before any agent call, for `prep` before the narrator call, and for the committed answer before announcing it. Public session operations resolve after their writes. A failed durable write prevents the provider call and releases the lease when the engine closes. `create(header, initial)` must publish the header and first rows atomically; adapters must implement that part of the port.
