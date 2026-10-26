# M1b contract notes — integrate

What the integration step changed in contracts (and why), and what became of every item in the
other `m1b-contract-*.md` notes.

## Contract changes made here

1. **`SessionHandle.select` takes `exact?: boolean`** (api.ts, engine/session.ts). With `exact: true`
   the head goes to the message itself; without it, to its newest descendant (unchanged). Why: on a
   straight path the newest descendant of every message is the head, so `/rewind n` (§5.5 "Откат —
   head на более раннее сообщение") was impossible through the API (m1b-contract-repl.md §1, the fix it
   proposed). A non-boolean `exact` is `invalid_params`. Test: test/engine/session.test.ts. The REPL's
   feature probe (`engineHasExactSelect`) and its "old engine" test are gone; the rewind test runs always.
   ARCHITECTURE.md §12.2 `history/select` gained the same optional `exact` (M6 wire).
2. **`ReplDeps.windowOf?(conn, model)`** (additive, optional): the banner's `ctx` before a binding's
   first answer comes from the connection's resolved caps (m1b-contract-repl.md §3 suggested it). The CLI
   passes it (cli/runtime.ts `windowOf`); `null` keeps `ctx ?`.
3. **`probe.ts` `listModels(baseUrl, opts)`** (additive): the /models ladder only, for `rp-core models`.
   `fetchCatalog`'s step 1 moved into the shared `walkModelsLadder` (behaviour unchanged).
4. **`chatCompletionsUrl`: a final `/beta` segment counts as versioned** → `https://api.deepseek.com/beta`
   posts to `/beta/chat/completions` (was `/beta/v1/chat/completions`). Why: DeepSeek prefix completion
   (`prefill: 'prefix-flag'`) only exists under `/beta` (m1b-contract-adapter.md §3, m1b-contract-caps.md).
   The config template's DeepSeek example now uses the `/beta` base.
5. CLI-internal (no library contract): `parseProviderSpec` / `scriptConnection` take the command name for
   usage errors; `reportRefusal(io, r, json, rt?)` names skipped connections on `no_connection`;
   `SendOptions.rt`, `NewArgs.{rt, chat, maxTokens}`; new modules `cli/runtime.ts`, `cli/chat.ts`,
   `cli/catalog.ts`; `repl.ts` exports `editorCommand`.
6. **`rp-core new --max-tokens <n>`** sets the narrator binding's `maxTokens` (Binding.maxTokens already
   existed). Why: §11 says the reply limit comes from the binding or the preset; M1b has no preset other
   than `builtin` and no other way to set a binding's limit from the CLI (needed for small local windows,
   and for the demo's ≤ 200 tokens). `/model` keeps it (configure merges).
7. **`src/index.ts` exports the M1b entry points** (additive): `createOpenAIChatProvider`, `resolveCaps`,
   `fetchCatalog`, `listModels`, `readCapsCache`, `writeCapsCache`, `loadConfig`, `parseConfig`,
   `buildConnections`, `ConfigError`, `CONFIG_TEMPLATE`, `configPath`, `createSecretResolver`, `scrub` and
   their types. Why: package.json `exports` only allows "." and "./testing", so a host (Bunraku, M9) could
   not build an openai-chat Connection at all.
8. REPL `$EDITOR`: run as `sh -c '<editor> "$@"' sh <file>` on POSIX (git's rule), so an editor with
   quoted arguments works; an empty `$VISUAL` falls through to `$EDITOR`; exit 127 → "cannot start the
   editor". `/rewind n` onto a player message now says what a new line and `/r` do there.

## The other notes, item by item

### m1b-contract-adapter.md
1. No replay channel in StreamEv — **open, M3** (tool loops / signed reasoning need it; the parser already
   keeps `replay()`).
2. OpenRouter `session_id` — **open** (needs `ModelRequest.sessionId?` or an engine-level extraBody;
   nothing in M1b depends on it).
3. DeepSeek `/beta` — **resolved** (change 4). A user who keeps `https://api.deepseek.com` still gets
   `prefill: 'prefix-flag'` from the host row; a continue in prefill mode may then be refused by the
   server. Workaround: `[caps."deepseek:<model>"] prefill = "none"`. A path-aware host row would be the
   real fix (caps resolver sees only the origin).
4. `caps.reasoning.startsInside` for templates that open `<think>` in the prompt — **open** (data/caps
   extension; affects Qwen3-Thinking-2507 style templates only).
5. `applyOverrides(...).ignored` lost in the adapter — **moot**: config.ts refuses protected headers and
   body keys at parse time, so nothing reaches applyOverrides to be ignored.
6–16. Behaviour notes — no action. Item 16 (Ollama `cached_tokens`) confirmed live: the demo's swipe
   reported `inputCacheRead` 989 of 990.

### m1b-contract-caps.md
- `/beta` path — resolved (above). `CatalogInfo.server` 'unknown' pass-through, `maxInFlight` only
  lowered by data, `slots` as advice, `writeCapsCache` `as_of` from the caller — all used as described
  by `rp-core probe` (as_of = the injected clock's date; slots printed as advice).
- Ollama trained context not a window — surfaced: the probe prints the note (now naming the config key
  `context_length` instead of the camelCase field) and the banner shows `ctx ?` / the resolved window.

### m1b-contract-config.md
- `buildConnections` may throw `ConfigError` (header env unset) — handled: main maps every ConfigError to
  exit 64 with the file and the key path (`rp-core: config error in <file>: <path>: <message>`).
- `[compendium]` stays snake_case — **open, M5** (map onto `CompendiumConfig` there).
- Azure-style `api-key` header auth not configurable — **open** (whoever adds Azure).
- Rest informational.

### m1b-contract-engine-m1b.md
- 1–4, 6: informational, consistent with the CLI. 5 (EMA bias with a long prefill, errs safe) — **open,
  harmless**; the demo saw the estimator run ×1.33 high before any EMA sample.

### m1b-contract-prompt-m1b.md
1. The two M1a tests pinning `post_processing_m1b` — **deleted** from test/prompt-small/shape.test.ts.
2. `ShapeInput.names` — wired by engine-m1b. 3, 5, 6, 7 — informational. 4 — wired by engine-m1b
   (`tokenFactor`, `stripToolCallLeaks`).

### m1b-contract-repl.md
1. Exact select — **resolved** (change 1).
3. Integration wiring — done as described: `Engine.open` with connections and prices, `runRepl` with
   `openSession` and `windowOf`; no signals.ts handlers while the REPL runs; SIGTERM → `engine.close()`
   then exit 143 (a second SIGTERM leaves at once); exit 130 from the REPL is returned without waiting
   for `engine.close()`. `/probe` text now names `rp-core probe <connection>[:<model>] [--write]`.
   The §12.4 "held answer: keep / discard?" prompt stays M6.
4. Engine behaviour notes — informational.

### m1b-contract-transport.md
- All informational; the Bun fetch finding is recorded in docs/M1B-DEMO.md §7.
