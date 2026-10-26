# M1b contract notes — transport (http.ts, sse.ts, wire.ts, reasoning-tags.ts)

No signature was changed. Behaviour that the adapter, caps, config and engine agents should know,
and the places where the implementation deliberately reads or departs from a doc comment:

## http.ts

1. **Other 5xx → `overloaded` (deviation).** The comment says "anything else bad_request". A 501,
   Cloudflare 520-523/525-527/530 etc. are server failures, so they map to `overloaded` (category
   server). Consequence: engine/route.ts counts `overloaded` as transient, so such a status gets the
   one retry if it carries a status (it always does). 1xx/3xx/other 4xx stay `bad_request`.
2. **retryAfterSec on any status** that carries a valid `Retry-After` (or OpenAI `retry-after-ms`),
   not only 429 — a 503 with Retry-After is honoured too.
3. **`bodyBytes` wraps non-abort read failures** (reset connection, Bun's own timer) in ProviderError
   `truncated_stream` (category network, `afterOutput:false`). The adapter knows whether output was
   already emitted and should re-create the error with the right `afterOutput`. An abort still throws
   `signal.reason` unchanged.
4. **First-byte / idle timeouts are NOT in http.ts** (the contract says the engine owns them). Bun's
   own idle timer is disabled with `timeout:false`; on Bun 1.3.14 a numeric `timeout` is ignored, so
   timers must abort the signal (details: .notes/m1b-bun-fetch.md).
5. **Same origin is strict**: scheme+host+port. http→https upgrades are refused too (they change the
   origin). The initial URL is checked against `allowedOrigin` before any request; `allowedOrigin`
   may be given as a full base URL (it is canonicalised with `originOf`).
6. `guardedFetch` calls `opts.fetch(url, init)` (string URL, not a Request), so a host fetch wrapper or
   a test fake sees plain arguments. A network failure is `unreachable`; a fetch that throws
   `TimeoutError` (a host fetch with its own timer) is `timeout`.
7. `classifyHttpFailure` has no signal parameter; a stalled error body ends when the request's
   signal aborts (Bun errors the body stream; verified by test).
8. `isLocalOrigin` is a documented superset of the comment's list: also 0.0.0.0, 169.254/16,
   100.64/10 (Tailscale/CGNAT home servers), IPv6 ULA/link-local/unspecified, IPv4-mapped IPv6,
   `*.lan`, `*.home.arpa`, `*.internal` (host.docker.internal). It decides local timeouts and the
   default `max_in_flight` 1, so a Tailscale llama.cpp box is treated as local.

## sse.ts

9. Follows the WHATWG field rules; `id` persists across events (spec). A lone CR ends a line. An
   event left open at EOF is dispatched (contract), so the parser must still decide truncation from
   the absence of `[DONE]`/finish.

## wire.ts

10. **validateToolProtocol block rules**: `tool_call` only in assistant messages; `tool_result` only
    in `tool` or `user` messages (OpenAI one tool message per result; Anthropic one user turn with
    all results). Results must answer the open batch **in call order** ("in order" in the contract);
    a message without results while a batch is open fails; a batch open at the end fails. Safe id =
    `[A-Za-z0-9_.:-]{1,128}` (Kimi `functions.x:0` passes); safe name = `[A-Za-z_][A-Za-z0-9_-]{0,63}`;
    `args` '' or whitespace counts as `{}`.
11. **remapToolIds('mistral9')** keeps ids already of the shape, derives the rest deterministically
    (FNV-1a → base62, salted on collision), so the same id maps identically on every request of a
    tool loop. No format → a deep-ish copy, ids untouched.
12. **mergeAdjacent** merges only all-text messages: any tool_call/tool_result **or reasoning** block,
    or a non-empty `replay`, blocks merging (reasoning: DeepSeek echo / signed parts, D-52). Equal
    `placement` required (absent ≠ 'head'). Merged text blocks become one block; blank parts add no
    gap; `src` becomes "a+b"; the first message's other fields win.
13. **normalizeFinish**: unknown/absent → `'end'` (the adapter keeps `raw`; OpenRouter
    `finish_reason:"error"` must be raised by the adapter before calling it). `refusal` → `refusal`;
    Anthropic `model_context_window_exceeded` → `length`; `pause_turn` → `end` (re-send is the
    adapter's job).
14. **applyOverrides**: order exclude → deep-merge `extraBody` → headers. `excludeBody` names are
    top-level keys only (no dotted paths). Deep merge: objects recurse; arrays/scalars/null replace
    (null is sent as JSON null — to remove a key use `exclude_body`). Protected keys are only checked
    at the top level of the body (nested `provider.model` is allowed). `ignored` entries look like
    `exclude_body.model`, `extra_body.tools`, `headers.Authorization`. `__proto__`/`constructor`/
    `prototype` keys are dropped silently. Inputs are never mutated; output body is a deep copy.
    The same function can apply `caps.extraBody` (D-54) with protected keys guaranteed.
15. **PROTECTED_HEADERS widened** (value, not signature): the architect's four plus Bunraku's
    `proxy-authorization`, `api-key`, `x-goog-api-key`, `host`, `content-length`, `cookie`. Config
    validation that reuses the constant gets the wider set.

## reasoning-tags.ts

16. Markers are exact and **case-sensitive** (`<Think>`/`<THINK>` are text unless listed in
    `caps.reasoning.tags`).
17. Inside a block only the opening pair's closer ends it (no nesting); with `startInside`, any
    configured closer ends the template-opened block.
18. A **stray closer outside reasoning is dropped** (not shown as text). Text before it has already
    gone out as text — pass `startInside` when the template opens `<think>` in the prompt.
19. **Lossless whitespace**: only marker characters are removed; the usual `"\n\n"` after `</think>`
    reaches the text stream. Trimming, if wanted, is the adapter's/engine's display policy.
20. Added export `closingFor(open)` (the ported table) for callers that need a single closer.
21. The splitter only emits `text`/`reasoning` pieces; the adapter detects block ends (for
    `reasoning_end`) from the kind switching. An empty block (`<think></think>`) yields no piece.
