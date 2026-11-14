# M5d decisions: latency on local servers

The lead, 2026-11-14. M5d is the part of M5c that needed live hardware (D-196): llama.cpp slot
pinning, what the engine learns about a local server, warnings about server setups that reload or
swap the model, the prompt counts per call in the trace, and `rp-core bench ttft`. These become
D-209…D-218 in ARCHITECTURE.md rev 19, which also takes M5c's D-196…D-208.

Research digests (in the session scratchpad, not tracked): the code map, llama.cpp at upstream
4f2187e7 (2026-11-14), Ollama v0.40.12 and LM Studio 0.4.26, Bunraku and RoleCall. The facts this
file leans on are repeated where they are used.

## A. Decisions

**D-209. Scope, and one change to the plan.** M5d builds:
1. a server-info reader for local servers (D-210);
2. llama.cpp slot pinning (D-211);
3. four notices (D-212);
4. the prompt counts and call timing in the trace (D-213);
5. `rp-core bench ttft` (D-214).

The change: ARCHITECTURE planned `id_slot` "at `max_in_flight = 2`" (§7.4.7, D-84). It is now sent
whatever `max_in_flight` is. On a local origin a background task never runs beside the narrator or
the Director (sched.ts `preempt` and `backgroundReady`). So pinning is not about doing two things
at once. It keeps each slot's cache for one kind of prompt, which helps a `-np 2` server just as
much at `max_in_flight = 1`. Not in M5d:
- koboldcpp `--smartcache`;
- the Ollama `NUM_PARALLEL` rows of the old demo matrix;
- turn-level first-token time across the Director and recall. The trace's per-call offsets
  (D-213) cover what a user needs.

**D-210. The server-info reader.** It lives in a new `src/providers/server-info.ts` and shares
helpers with probe.ts rather than copying them.
- **What it reads.** Only for local connections of the `openai-chat` dialect, with a short deadline
  (1.5 s per request, 3 s in all). The order:
  1. `GET <root>/props`. It is llama.cpp when the answer has `default_generation_settings` or
     `total_slots`. Read `total_slots`, `build_info` (`b<N>-<commit>`; N = 0 or a missing field
     means unknown) and `endpoint_slots`.
  2. Else Ollama's `GET <root>/api/version`, then `GET /api/ps`.
  3. Else LM Studio's `GET <root>/api/v1/models`: per model key, whether it has
     `loaded_instances`.
  4. Else kind `unknown`.
- **Ollama models.** `ollamaModel(name)` posts `/api/show` and returns the blob (the `FROM` path in
  `modelfile`) and the runner options from `parameters`: `num_ctx`, `num_batch`, `num_gpu`,
  `main_gpu`, `use_mmap`, `num_thread`. These are the options Ollama's `needsReload` compares
  (server/sched.go:1423-1474 at v0.40.12). It never compares samplers or `keep_alive`.
- **No failure.** Every failure gives kind `unknown` with a reason. Nothing is written to
  caps-cache.json or the journal.
- **When the engine reads it.** Once per origin per engine process, memoised. The read starts when
  a session opens, for the local origins its roles use, and does not block the open. The first
  model call on such an origin waits for it until the 3 s deadline, then goes on with or without it.
- **When it never runs.** For `script:`, `record:` and `replay:` providers, or for remote origins.
  It is also off under `EngineOptions.serverInfo: 'off'` or `RP_CORE_SERVER_INFO=off`. The test
  preload sets that variable, as with RP_CORE_LANE and RP_CORE_RECALL, and the M5d tests opt in.
- **`rp-core probe <conn>`** prints the same facts, plus the pinning verdict for that connection's
  models.

**D-211. Slot pinning.**
- **The caps key.** `ModelCaps.slotPin?: { narrator: number; agents: number }` goes into PATCHABLE.
  The user sets it in config with `[caps."conn:model"] slot_pin = true | false`. `true` pins to 0
  and 1 without asking the server; `false` never pins.
- **What the adapter does.** openai-chat `buildChatRequest`, when `req.caps.slotPin` is set, adds
  `id_slot` by `req.agent`: `narrator` (drafts included) gets `narrator`, any other agent gets
  `agents`. It is added before the connection's own `extra_body` and `exclude_body`, so those still
  win (D-53).
- **When the engine pins without `slot_pin` in config.** All three must hold:
  - the server is llama.cpp;
  - `total_slots ≥ 2`;
  - the build is 11552 or later (llama.cpp PR #30295: before it, pinning a busy slot could load
    another prompt into it while it generated), **or** the origin's capacity is 1, so rp-core never
    sends to a busy slot.

  The engine sets it on the call's caps where every call starts (narrate.ts `streamCall`), so the
  Director, recall, filing and the historian are all covered. `--preview --wire` shows it.
- **Why every agent shares slot 1.** With two places, the Director and a sync recall may both go to
  slot 1. llama.cpp then queues the second one and never refuses it
  (server-context.cpp:3058-3063). That is the trade: letting one of them take slot 0 would empty the
  narrator's cache.
- **Ids wrap.** llama.cpp takes `id_slot` modulo the slot count, so `id_slot: 1` on a one-slot
  server lands on slot 0. That is why D-211 asks for two slots.

**D-212. Notices.** Each is told once per session, by code and subject. They are told when the
session opens and the server info arrives, and again after `/model` or `session/configure` changes
the roles. They do not depend on the Compendium being on.

The roles that count:
- the narrator;
- the Director, when it is enabled;
- the recorder, when the Compendium is on;
- recall, when its mode is neither `lexical` nor `off`.

| Code | Level | When | Says |
|---|---|---|---|
| `slots_pinned` | info | D-211 pins | the server has N slots; the narrator keeps slot 0 and the agents use slot 1; the narrator's cache stays in VRAM only with `-np 2 --no-kv-unified` (with the default `-np auto` the KV is unified and an idle slot is moved to host RAM whenever another task starts) |
| `slots_detected` | info | llama.cpp with ≥ 2 slots and no pinning (old build at capacity 2, or `slot_pin = false`) | why it does not pin, and how to (`slot_pin = true`, a newer build, or `max_in_flight = 1`) |
| `ollama_reload_risk` | warn | two roles on one Ollama origin name different models with the same blob and different runner options (for example a 16k and a 32k variant of one model) | every switch between them reloads the model; bind both roles to one name |
| `lmstudio_autoevict` | warn | roles on one LM Studio origin name two or more models and at least one is not loaded | a JIT load with Auto-Evict on (LM Studio's default) unloads the other model each time; load both with `lms load`, or bind the agents to the narrator's model |

Different Ollama blobs on one origin are not warned about. Whether both stay loaded depends on VRAM
and `OLLAMA_MAX_LOADED_MODELS`, which the API does not show.

**D-213. Prompt counts and call timing in the trace.**
- **`CallResult.prompt?: { processed?: number; cached?: number }`.**
  - From the OpenAI usage: `prompt_tokens_details.cached_tokens` is `cached`, and `processed` is
    `prompt_tokens − cached`. This works for llama.cpp and Ollama `/v1`.
  - Else from llama.cpp `timings`, only when they have `cache_n`: `processed = prompt_n`,
    `cached = cache_n`.
  - Adapted from Bunraku `src/core/tokens/usage.ts` `readTokenReport` (Coneja-Chibi `e95d90db`,
    `4cd5b724`; 702d8120): `timings` without `cache_n` never give the prompt total. The same rule
    fixes `usageOfTimings`, which today reads `prompt_n` as the total when `cache_n` is missing.
    Ollama's `timings.prompt_n` is the whole prompt and it sends no `cache_n`, so it is never read
    as `processed`.
- **`Trace.calls` rows gain three optional fields:**
  - `at`: ms from the turn's start to the call's start;
  - `ttftMs`: the call's first token, from its own start, queue wait included as today;
  - `prompt`.

  The entries guard accepts them, and older rows read as before.
- **`/trace`** prints one line per call. For example:
  `narrator  +2.1 s  first token 0.4 s  1.8 s  prompt 3 412 cached, 96 new`.

**D-214. `rp-core bench ttft`.** It lives in `src/cli/bench.ts`, with one entry in main.ts
COMMANDS; `bench` takes positional `ttft`.
- **Usage:** `rp-core bench ttft [conn:model] [--rounds N] [--prompt-tokens N] [--tail-tokens N]
  [--agent-tokens N] [--pin auto|on|off] [--json]`.
  - The model defaults to the narrator role.
  - The defaults are rounds 3, prompt 4000, tail 200, agent 1500, pin auto (auto = D-211's rule).
- **The prompts.** They are synthetic and deterministic, from a seeded word generator. No fixture or
  story text goes in.
- **One round, three calls**, each with stream, temperature 0 and at most 16 output tokens:
  1. the narrator prompt P;
  2. an agent prompt A, unrelated to P, sent as agent `filing`, so the pinning rule applies;
  3. P plus a new tail T.
- **Per call it measures:** the client's first-token time, the total time, and `prompt` (D-213).
  Call 3 also gives `ratio = processed / tail`. Its count of T's tokens is the server's
  `prompt_tokens` of call 3 minus that of call 1.
- **It prints:**
  - the server info and the pinning verdict;
  - a table per round;
  - the median, and PASS when `ratio ≤ 1.5` (ARCHITECTURE §15's acceptance).

  When `processed` is unknown (LM Studio), it prints only the timings and says why.
- **Before anything else** it prints how many real calls it will make. It never touches a session.
  The server setups of the matrix (`-np 1` with `--cache-ram` and with `--cache-ram 0`;
  `-np 2 --no-kv-unified`) are runs the user starts; the help names them.
- **Exit codes:** 0 when every round passed or the ratio is unknown, 1 on a FAIL, and the usual
  codes on errors.

**D-215. Tests and fakes.**
- Engine and adapter behaviour is tested against `Bun.serve` fakes:
  - llama.cpp: `/props`, `/slots`, chat with `timings`, and a record of each body's `id_slot`;
  - Ollama: `/api/version`, `/api/ps`, `/api/show`, `/v1` usage with `cached_tokens`;
  - LM Studio: `/api/v1/models`.
- New test folders: `test/serverinfo-m5d`, `test/pin-m5d`, `test/trace-m5d`, `test/bench-m5d`, and
  `test/demo-m5d` with a scripted walkthrough in docs/M5D-DEMO.md.
- Only tests that opt in see the reader (D-210).

**D-216. Docs.** The user guide gets a section "Local servers: speed and caching":
- the server setups, among them llama.cpp `-np 2 --no-kv-unified`, one Ollama model name per
  blob, and `lms load` for LM Studio;
- the four notices;
- `slot_pin`;
- the trace's prompt counts;
- `bench ttft`.

Also: the status tables lose the M5d row; PROVENANCE gets the usage.ts adaptation; and
docs/M5D-DEMO.md is written.

**D-217. Live checks.** They need the user's go-ahead each time, and few calls.
- `bench ttft` against Ollama with `magmell-16k` (9 calls).
- The bundled `/usr/local/lib/ollama/llama-server` on Ollama's existing magmell blob, started with
  `-np 2 --no-kv-unified`, to see pinning and the ratio. This needs no download, but it starts a
  GPU process, so it is asked for separately.
- LM Studio has no models on this machine. Its notice is tested only against fakes.

**D-218. Compatibility.** The new fields are optional everywhere: caps, trace rows and the probe
output. Bunraku's rp-core adapter (`src/studio/core-ollama-provider.ts`) never sees `id_slot`,
because it is an Ollama transport and D-211 never pins on Ollama.

## B. Rulings after the review (the lead)

**D-210 amended: a failure that may pass is read again.** The review found that a read which
failed was kept for the engine's whole life. That covers a server still loading (503), one started
after the session opened, and a key that missed its share of the deadline (401). Each of these
cost pinning and the notices until a restart.

What changes:
- **Kept for the engine's life:** a definite answer, meaning a known kind or "no known server"
  built from 404s or 200s.
- **Read again:** a passing failure, meaning nothing answered, a deadline, "timed out", HTTP 5xx,
  401 or 403. The next `start` re-reads it at most once per `SERVER_INFO_RETRY_MS` (30 s).

The session runs its server check when a turn begins (as well as at open and configure), so a
server that comes up later gets its pin and its notices from the next turn. The first call after a
retry waits under the same 3 s bound.

Tests: test/serverinfo-m5d/serverinfo.test.ts "a passing failure is read again".

The other review findings were fixed as filed (see the fixer's report in the session).
