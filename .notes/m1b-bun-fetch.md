# Bun fetch on long pauses (M1b, transport)

§8.8 left open: "Поведение Bun fetch на длинных паузах не проверено; проверка — на M1." Checked on
**Bun 1.3.14** (`0d9b296a`), Linux, 2026-10-26, against local `Bun.serve` mock servers only.

## What Bun does

- **Bun's fetch has a socket idle timer.** Default 5 min, set process-wide by the env var
  `BUN_CONFIG_HTTP_IDLE_TIMEOUT` (in **seconds**). It fires on silence before the first byte *and*
  between body chunks, and rejects with `TimeoutError` ("The operation timed out."). The timer is
  coarse: with `BUN_CONFIG_HTTP_IDLE_TIMEOUT=2` both a first-byte pause and a mid-body pause died at
  ~4011 ms (about twice the setting).
- **Per-request option `timeout` (Bun extension of RequestInit).** `bun-types` 1.4.4 documents
  `timeout?: number | boolean` (number = idle deadline in ms; `0`/`false` = disabled; `true`/absent =
  default). On **1.3.14 only `false` and `0` do anything**: they disable the idle timer for that
  request. A positive number is NOT honoured as a deadline — `timeout: 1000` survived a 9 s pause, and
  `timeout: 30000` under `BUN_CONFIG_HTTP_IDLE_TIMEOUT=2` still died at ~4 s. So the engine cannot hand
  its timeouts to Bun; it must run its own timers and abort the signal (which is the §8.8 design).
- **`redirect: 'manual'`** returns the 3xx response with its `Location` header (verified with a real
  307 from `Bun.serve`).
- **Abort** ends things promptly: aborting the signal while waiting for the first byte rejects the
  fetch with the signal's reason (measured 0.34 ms after `abort()`); aborting mid-body ends the
  `bodyBytes` read with the reason (measured 0.59 ms). After the headers, an abort also errors the
  body stream itself, so a stalled error body read by `classifyHttpFailure` (which has no signal of its
  own) ends too.
- **Mock servers:** `Bun.serve` has its own `idleTimeout`, default **10 s**, which closes a socket
  that is silent mid-body from the *server* side (seen as `ECONNRESET` in the client after ~1 s with
  `idleTimeout: 2`). A first-byte pause is not affected (the handler is still running). Every mock that
  pauses must set `idleTimeout: 0`. Real backends (llama.cpp, Ollama, ...) are unaffected.

## What rp-core does

`guardedFetch` (src/providers/http.ts) always passes `timeout: false` (plus `redirect: 'manual'` and the
caller's signal). First-byte (600 s local / 120 s remote) and idle (120 s) timeouts belong to the engine
(§8.8): it aborts the signal, and the transport turns that into a rejection with the signal's reason.
A host-supplied `fetch` (Bunraku's egress lock) may ignore the option; then the host's own timers apply.

## Evidence (tests in test/transport/)

| Test | Result |
|---|---|
| `http-long-pause.test.ts` — 20 s before the first byte and 20 s mid-body, in parallel, no abort | both complete: `data: late`, `data: one … two`; ~20 s each, the file ~26 s |
| `http-long-pause.test.ts` — child process with `BUN_CONFIG_HTTP_IDLE_TIMEOUT=2`, 6 s pauses (`fixtures/idle-probe.ts`) | plain `fetch`: `TimeoutError` at 4011 ms (first byte and mid-body); `guardedFetch`: ok at 6013 ms both |
| `http.test.ts` — abort 100 ms into a 5 s first-byte wait | rejects with the reason, < 1.5 s |
| `http.test.ts` — abort 50 ms after the first SSE chunk of a stalled body | `bodyBytes` throws the reason, < 1.5 s |
| `http.test.ts` — stalled 503 error body, abort after 100 ms | `classifyHttpFailure` returns `overloaded`/503, < 1.5 s |

Manual probe output (the fixture run by hand):

```
BUN_CONFIG_HTTP_IDLE_TIMEOUT=2, pause 6000:
{"bun":"1.3.14","idleEnv":"2","pauseMs":6000,"plainFirst":"error TimeoutError 4011","plainMid":"error TimeoutError 4011","guardedFirst":"ok 6013 late","guardedMid":"ok 6013 ab"}
default env, pause 3000:
{"bun":"1.3.14","pauseMs":3000,"plainFirst":"ok 3014","plainMid":"ok 3014","guardedFirst":"ok 3015 late","guardedMid":"ok 3014 ab"}
```

The long-pause file is marked `[slow]`; `RP_CORE_SKIP_SLOW=1` skips it.

Re-check when Bun is upgraded: if a later Bun honours a numeric `timeout`, nothing breaks (`false`
still disables the timer), but the 5-minute default would then only matter for hosts' own fetches.
