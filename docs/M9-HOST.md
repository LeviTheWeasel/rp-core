# Host API

A program that embeds rp-core (a UI such as Bunraku, or any TypeScript host on Bun) can open the engine in-process, add its own steps to each turn, review requests before they are sent, and keep sessions in its own storage. A program in another language should use [`--stdio`](STDIO.md) instead; the gates and drafts below are available there too.

The package is marked private and is not on npm: depend on the git repository. It has two entry points:

- `rp-core`: `Engine`, `Refusal`, `HostHookError`, the session stores (`FileSessionStore`, `MemorySessionStore`, `FileRecordStore`, `MemoryRecordStore`), the event and entry types, and the scripted provider.
- `rp-core/testing`: the scripted provider helpers, `MemoryRecordStore`, `FileRecordStore` and `checkRecordStoreConformance`.

`Engine.open` resolves to an `EngineHandle`. It accepts a synchronous `SessionStore` for its journal; without one it uses the filesystem journal under `home/sessions`. `Engine.openWithRecordStore` connects an asynchronous `RecordStore` to the turn lifecycle and returns an asynchronous facade.

## Hooks

Pass `hooks` to `Engine.open`. Each hook receives a context with `sessionId`, `turnId`, `kind` and the turn's abort `signal`.

- `beforeAssemble(ctx)` returns depth inserts (`{ depth, role, text, src: 'host' }`) that go into the prompt beside the Director's and the Compendium's. An error or an invalid result emits `host_before_assemble_failed` and the turn continues without them.
- `transformRequest({ messages }, ctx)` receives a copy of the shaped messages and returns `{ edits: [{ index, text }] }`. Each index may appear once; an edited message becomes a single text block.
- `transformReply(text, ctx)` returns `{ text, note? }` with the replacement text, or `{ veto }`.

The two transforms fail the turn closed: an error, an invalid result or a timeout ends it with `host_transform_failed`, a veto with `host_veto`. Every hook result is recorded in the answer's trace. `hookTimeoutMs` sets a deadline per hook and gate; with no deadline, a hook waits until it settles or the turn is stopped.

```ts
import { Engine } from 'rp-core';

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

`session.runTurn({ kind: 'reply', expectedVersion, inspect: true })` emits a `gate` event of kind `review` before the model call. Its `payload.messages` is the shaped request. Reply with `session.answerGate(turnId, gateId, { action: 'send', edits? })`; it returns `false` if no matching gate waits. `cancel`, or the hook deadline passing, stops the turn with no message.

`transformGate: true` (on `runTurn` or `submit`) asks for a `transform` gate instead of, or before, a review. Cancellation or timeout fails the turn with `host_transform_failed` before the provider sees a request.

`consumerSignal` tells the engine when the UI leaves. It does not stop a model call already underway, but a gate waiting for that UI is cancelled; an unanswered transform gate then fails closed.

In stdio, declare `capabilities.gates: ['review', 'transform']` at `initialize`. The server sends a JSON-RPC `gate/request` using `gateId` as its request id. Reply with `{ action: 'send' | 'cancel', edits?: [{ index, text }] }` as the result, or call `turn/answerGate` with `sessionId`, `turnId`, `gateId` and `answer`. `inspect` is refused with `gate_unsupported` if the client has not declared `review`. A client that declared `transform` gets a transform gate on every turn.

## One-shot generation

`session.draft({ kind: 'quiet', prompt })` and `session.draft({ kind: 'impersonate' })` return `{ text, usage? }` from the narrator model without writing entries or changing the session version. A draft is limited to 1024 tokens and is refused with `session_busy` while a turn runs. In stdio use `session/draft`; in the REPL use `/impersonate`.

## Record storage

A host can keep sessions in its own storage in two ways.

**Synchronous `SessionStore`.** It has `create`, `open`, `fork` and `list`; each opened `SessionLog` appends entries synchronously and durably before the operation continues. `MemorySessionStore` is the in-memory reference implementation and supports a full turn, fork and reopening through the engine:

```ts
import { Engine, MemorySessionStore } from 'rp-core';

const sessionStore = new MemorySessionStore();
const engine = await Engine.open({ home, connections, sessionStore });
```

**Asynchronous `RecordStore`.** The port transports the session header and ordered `Entry` rows: `create(header, initial?)`, `acquire(session)` for an exclusive `Lease` (with `renew` and `release`), `read`, `append(lease, rows, durable)` and `list`. `create` must publish the header and first rows atomically. `FileRecordStore` wraps the existing durable JSONL journal; `MemoryRecordStore` clones rows at its boundary. `checkRecordStoreConformance(make, header, entries, reopen?)` from `rp-core/testing` checks ordering, sequence monotonicity, gapless batches, lease exclusivity, and optionally reopening durable rows; run it against your adapter.

Use `Engine.openWithRecordStore` and await session operations:

```ts
const engine = await Engine.openWithRecordStore({ home, connections, recordStore });
const session = await engine.createSession({ character });
const sent = await session.send({ text: 'Hello', expectedVersion: await session.version() });
const turn = await session.runTurn({ kind: 'reply', expectedVersion: sent.version });
for await (const event of turn.events) { /* render event */ }
await turn.result;
await engine.close();
```

The facade keeps an in-memory fold of each open session and queues writes to the supplied `RecordStore`. It waits for the `turn` row before any agent call, for `prep` before the narrator call, and for the committed answer before announcing it. Public session operations resolve after their writes. A failed durable write prevents the provider call, and the lease is released when the engine closes.
