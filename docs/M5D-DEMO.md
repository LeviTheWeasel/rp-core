# M5d demo — local servers: slot pinning, server notices, prompt counts, `bench ttft`

Milestone M5d ("latency", `.notes/m5d-decisions.md` D-209…D-218) is the part of M5c that needed a
local server to talk to. The engine now asks a local openai-chat server what it is (D-210): llama.cpp's
slot count and build, Ollama's models, LM Studio's loaded ones. On a llama.cpp server with two slots it
pins the narrator to slot 0 and every agent to slot 1 (D-211), so an agent's prompt never pushes the
narrator's prompt out of its cache. It tells the person about the server setups that cost a reload or
an eviction (D-212). Every call in `/trace` now shows when it started, its first token and what the
server did with its prompt (D-213). `rp-core bench ttft` measures that cache from the outside (D-214).

This is that demo: one deterministic run of the real CLI against fakes of llama.cpp, Ollama and LM
Studio (§1, §2), what the run can and cannot say about time and caching (§3), a live run on real
servers on this machine (§4), what is still unmeasured (§5), and what the integration review found
(§6).

**Result in one line: the eleven claims below pass through the real CLI against Bun.serve fakes
(`bun test test/demo-m5d`: 10 pass, about 9.6 s). The integration review found one wording fault in
`slots_pinned`, now fixed (§6), and no seam bug between the reader, the pin, the adapter, the notices
and the trace. On a real llama-server with two slots, pinning kept the narrator's cache in every
round; unpinned, it was lost in every round without the host cache and in one of three with it
(§4).**

The demo runs the real CLI (`bun src/cli/main.ts`) as separate processes in one isolated home:
`probe`, `new`, `chat`, `bench ttft` and `--stdio`. The server-info reader, the pinning rule, the
openai-chat adapter, the notices, the REPL, `/trace`, the bench and the JSON-RPC host run for real.
Only the servers are fakes, and so are their answers.

Environment: Bun 1.3.14 (`0d9b296a`), Linux 7.0.0-42-generic (x86_64). `bun test test/demo-m5d`:
10 pass, 0 fail, 67 `expect()` calls.

## What the demo shows

| Claim | Step | What the test asserts |
|---|---|---|
| `probe` prints the server info and the verdict a session would get | 1 | `server info: llama.cpp b11901, 2 slots` and `slot pinning: on — narrator 0, agents 1 (2 slots, build b11901)` |
| `slots_pinned` is told once, in `rp-core chat` | 1 | One `! … (slots_pinned)` line, after the first answer (the fake's `/props` answers after 300 ms, so the first call waits for it) |
| The narrator sends `id_slot` 0 and the Director 1 | 1 | The fake's record, in order: director 1, narrator 0, director 1, narrator 0 |
| `/trace` shows each call's start, first token and prompt counts, as the server reported them | 1 | Two rows, `director  +0.0 s  first token …  prompt 5 087 cached, 836 new` and `narrator  +0.1 s  …  prompt 452 cached, 151 new`; both pairs equal the fake's own counts for those calls |
| Pinned, the narrator's second prompt is mostly cached | 1 | cached > 2 × processed: slot 0 still holds the first prompt up to where the first turn's directive sat |
| `slot_pin = false` never pins, and `slots_detected` says why and how | 2 | One `! … (slots_detected)` line naming the setting and `slot_pin = true under [caps."local:m"]`; no `id_slot` in any body |
| Unpinned, the Director's prompt takes the narrator's slot | 2 | The same narrator prompt (603 tokens) is processed again: 602 new against 151 pinned (> 3×, and > 90 % of the prompt) |
| `bench ttft` PASSes when pinned | 3 | Exit 0; `id_slot` 0, 1, 0 per round; `ratio 1.00` in both rounds; `PASS` |
| `bench ttft --pin off` FAILs when the agent's prompt evicts P | 3 | Exit 1; no `id_slot`; call 3 processes > 70 % of its prompt (only A's shared start, P's own, survives in the slot); `ratio 6.98 (370 processed / 53 new)`, `7.14 (364 processed / 51 new)`; `FAIL` and the hint |
| `ollama_reload_risk`: two names on one model file with other runner options | 5 | One `! … (ollama_reload_risk)` line naming `num_ctx 16384 vs 32768`; the narrator finds 0 tokens cached in both turns; `/trace` shows `prompt 0 cached` and the Director's own model |
| `lmstudio_autoevict`: the Director's model is not loaded | 6 | One `! … (lmstudio_autoevict)` line; `/trace` rows have timings and no prompt counts (LM Studio reports none) |
| (a JSON-RPC client gets the notice) | 4 | `rp-core --stdio`: after `session/open`, an `event` frame `{type: 'notice', level: 'info', code: 'slots_pinned'}` |

## 1. The setup (`test/demo-m5d/`)

| File | What it is |
|---|---|
| `servers.test.ts` | The demo: every CLI run in one home (`beforeAll`), one test per claim, and one that prints the transcript under `RP_CORE_DEMO_PRINT=1` |
| `fakes.ts` | The three servers (below) |
| `card.json`, `persona.json` | A synthetic narrator card (the canal town Lowmere, the midnight ferry) and the persona Pell, the night clerk |

The person types the same four lines in every chat: two messages, `/trace` and `/quit`. Each chat
starts a new session (`rp-core new … --no-chat`), so every server starts cold. `config.toml` is
rewritten before each part and shown in the transcript. The Director is on and the Compendium is off,
so each turn makes two calls, the Director's and then the narrator's.

**The reader seam.** The test preload sets `RP_CORE_SERVER_INFO=off`, so older tests' mock servers see
only the requests they saw before. The demo removes the variable from the children's environment, so
every run reads the server info as a person's would.

**The fakes** (`fakes.ts`). Each is a `Bun.serve` on 127.0.0.1 with a random port. The transcript
shows the usual ports instead (8080, 11434, 1234). The Director's request is told from the narrator's
by its prompt (`## YOUR PLAN`), and the answers are fixed: the Director's plan and three lines of story.

- **llama.cpp**, 2 slots, build `b11901-5320c87f`: `/props` (answered after 300 ms), `/slots`,
  `/v1/models`, and a streaming chat. Each slot holds the prompt it last processed. A call reuses the
  longest common prefix with its slot and processes the rest. Its last chunk carries llama.cpp's
  `timings` (`cache_n` reused, `prompt_n` processed) and a `usage` without `cached_tokens`, so the
  counts in `/trace` come from the timings (D-213). `id_slot` picks the slot, modulo the slot count as
  in llama.cpp. **Without `id_slot` every call lands on slot 0.** That is the case pinning rules out,
  not what a real server always does (§3).
- **Ollama** 0.40.12: `/api/version`, `/api/ps`, `/api/show`, and `/v1` chat whose `usage` has
  `prompt_tokens_details.cached_tokens`. Two names, `lumen-16k` and `lumen-32k`, share one blob and
  differ in `num_ctx` (16384 and 32768). One model is loaded at a time, and a call for the other name
  reloads it, which empties the cache.
- **LM Studio**: `/api/v1/models` with `lumen-7b` loaded and `lumen-3b` not, and a chat whose `usage`
  has totals only.

**Tokens and times in the fakes.** A fake's "token" is one word, plus one per message role. So the
server's counts (`server: 603`) differ from rp-core's o200k estimate (`~825 tok`), as a real server's
would. The first token waits 0.1 ms per processed token, so a cold prompt is a little slower. The
times in the transcript are wall-clock times of that model and differ from run to run. Nothing in the
tests asserts a time.

## 2. The run

The transcript is the test's own output (`RP_CORE_DEMO_PRINT=1 bun test test/demo-m5d`), with no
colour (`NO_COLOR=1`). The home is `<home>`, and `< typed.txt` stands for the four typed lines.
Session and turn ids and the times differ from run to run. The token counts are the same on every
run.

### 1. llama.cpp with two slots: probe, then a chat

```
$ cat <home>/config.toml
[connections.local]
base_url = "http://127.0.0.1:8080"

[caps."local:m"]
context_length = 32768

[roles]
narrator = "local:m"

[director]
enabled = true

[compendium]
enabled = false

$ rp-core probe local
local  http://127.0.0.1:8080  server: llama.cpp
  models (1):
    m  ctx 32768
  slots: 2 reported (advice only; capacity stays at the connection's max_in_flight)
  server info: llama.cpp b11901, 2 slots
  slot pinning: on — narrator 0, agents 1 (2 slots, build b11901)
  notes:
    - llama.cpp: 2 slots reported; capacity stays at the connection's max_in_flight (default 1 locally): parallel slots may share one KV pool, and overflowing it fails every request in flight [D-84]
  caps of local:m (with this probe stored):
    context 32768 · max output ? · in flight 1
    tools prompted · tool_choice auto/none · structured none
    prefill assistant-last · mid-system native · alternation free · usage timings
    reasoning tags <think> <thinking> <thought> [THINK] ◁think▷ <|begin_of_thought|>
    samplers temperature top_p top_k min_p typical_p repetition_penalty frequency_penalty presence_penalty seed stop max_tokens
    source host → catalog → user
  not stored: --write keeps this catalog for new turns
$ rp-core new --card ./test/demo-m5d/card.json --persona ./test/demo-m5d/persona.json --no-chat
rp-core: created session s_3554db8e "Narrator" with 1 greeting (card imported as library character narrator)
s_3554db8e
$ rp-core chat s_3554db8e < typed.txt
session s_3554db8e · Narrator · narrator local:m (tools: prompted) · director local:m (auto) · ctx 32768
Narrator › The last ferry is late. Pell waits behind the ticket window while rain runs down the glass.
  [greeting 1/1]
you      › I slide the ticket window open.
  ⋯ director: planned — arcs +1 · chapter 1
Narrator › Rain needles the canal. The night ferry noses up to the landing, its lamp swinging, and a man in a dry grey coat steps off before the gangway is down.
  [swipe 1/1 · 30 tok · 1.0s · end]   /r swipe  /c continue  /e edit
! The llama.cpp server at http://127.0.0.1:8080 (2 slots, build b11901) is pinned: the narrator keeps slot 0 and the agents use slot 1. The narrator's cache stays in VRAM only with -np 2 --no-kv-unified: with the default -np auto the KV is unified and an idle slot is moved to host RAM whenever another task starts. (slots_pinned)
you      › I ask the man in grey for his ticket.
  ⋯ director: planned — no changes
Narrator › The man in grey slides a coin under the glass, not a ticket. "One more crossing," he says, and his voice carries no water in it at all.
  [swipe 1/1 · 28 tok · 0.1s · end]   /r swipe  /c continue  /e edit
you      › /trace
trace of 9caedae3 · local:m
  window 32768 · reserve 8192 · prompt ~825 tok (server: 603) · 10 messages sent
  trimmed: nothing · prefill: none
  unknown macros: none
  lore: nothing fired · budget 6144 tok
  calls:
    director  +0.0 s  first token 0.1 s  0.1 s  prompt 5 087 cached, 836 new
    narrator  +0.1 s  first token 0.0 s  0.0 s  prompt 452 cached, 151 new
you      › /quit
```

`probe` reads `/props` twice (the test counts them): once for the catalog, as before M5d, and once
through the new reader, which gives the two new lines. The chat's first call waits for the reader (the fake answers
after 300 ms; the reader's deadline is 3 s), then goes out pinned. The notice comes after the first
answer because the REPL shows what arrives on the bus during a turn when the turn has ended.

In `/trace` the Director's row comes first (`+0.0 s`), then the narrator's (`+0.1 s` into the turn).
The narrator's second prompt has 603 tokens. 452 of them were still in slot 0 from the first turn,
and 151 are new. The Director's directive sits at depth 1, just before the player's last message, so
the two prompts part where the first turn's directive sat. The
Director's own 5 923-token prompt reuses 5 087 tokens of its first one in slot 1.

### 2. The same server with `slot_pin = false`

```
$ cat <home>/config.toml
[connections.local]
base_url = "http://127.0.0.1:8080"

[caps."local:m"]
context_length = 32768
slot_pin = false

[roles]
narrator = "local:m"

[director]
enabled = true

[compendium]
enabled = false

$ rp-core new --card ./test/demo-m5d/card.json --persona ./test/demo-m5d/persona.json --no-chat
rp-core: created session s_f7a48dd9 "Narrator" with 1 greeting (card imported as library character narrator)
s_f7a48dd9
$ rp-core chat s_f7a48dd9 < typed.txt
session s_f7a48dd9 · Narrator · narrator local:m (tools: prompted) · director local:m (auto) · ctx 32768
Narrator › The last ferry is late. Pell waits behind the ticket window while rain runs down the glass.
  [greeting 1/1]
you      › I slide the ticket window open.
  ⋯ director: planned — arcs +1 · chapter 1
Narrator › Rain needles the canal. The night ferry noses up to the landing, its lamp swinging, and a man in a dry grey coat steps off before the gangway is down.
  [swipe 1/1 · 30 tok · 1.0s · end]   /r swipe  /c continue  /e edit
! The llama.cpp server at http://127.0.0.1:8080 has 2 slots, build b11901, but rp-core does not pin it for the narrator and the Director: slot_pin = false in config; to pin, set slot_pin = true under [caps."local:m"]. (slots_detected)
you      › I ask the man in grey for his ticket.
  ⋯ director: planned — no changes
Narrator › The man in grey slides a coin under the glass, not a ticket. "One more crossing," he says, and his voice carries no water in it at all.
  [swipe 1/1 · 28 tok · 0.7s · end]   /r swipe  /c continue  /e edit
you      › /trace
trace of b3cf6a06 · local:m
  window 32768 · reserve 8192 · prompt ~825 tok (server: 603) · 10 messages sent
  trimmed: nothing · prefill: none
  unknown macros: none
  lore: nothing fired · budget 6144 tok
  calls:
    director  +0.0 s  first token 0.6 s  0.6 s  prompt 1 cached, 5 922 new
    narrator  +0.6 s  first token 0.1 s  0.1 s  prompt 1 cached, 602 new
you      › /quit
```

With `slot_pin = false` the engine never pins, and `slots_detected` says why and how to change it.
Every call goes out without `id_slot`, so the fake puts all of them on slot 0. Each turn's Director
prompt replaces the narrator's, and the narrator's second prompt is processed again: 602 of 603 tokens
(the 1 cached is the first role marker). The Director's prompt is processed again too (5 922 new),
since the narrator's prompt held its slot in between. The texts are the same as in part 1 (the fake's
answers are fixed), so the two `/trace`s compare like for like.

### 3. `bench ttft`

```
$ cat <home>/config.toml
[connections.local]
base_url = "http://127.0.0.1:8080"

[caps."local:m"]
context_length = 32768

[roles]
narrator = "local:m"

[director]
enabled = true

[compendium]
enabled = false

$ rp-core bench ttft --rounds 2 --prompt-tokens 1200 --tail-tokens 120 --agent-tokens 600
bench ttft: 6 real calls to local:m (2 rounds of narrator P, filing A, narrator P+T; at most 16 output tokens each)
server info: llama.cpp b11901, 2 slots
slot pinning: on — narrator 0, agents 1 (2 slots, build b11901)
prompts: P 1 200 tokens, A 600 (50 % of it P's start), T 120 (o200k estimate; synthetic words, seeded)
round 1
  #  agent     prompt  first token   total  prompt tok  processed  cached
  1  narrator  P            0.05 s  0.06 s         419        419       0
  2  filing    A            0.03 s  0.03 s         199        199       0
  3  narrator  P+T          0.01 s  0.01 s         472         53     419
  ratio 1.00 (53 processed / 53 new): PASS
round 2
  #  agent     prompt  first token   total  prompt tok  processed  cached
  1  narrator  P            0.04 s  0.04 s         414        413       1
  2  filing    A            0.02 s  0.02 s         206        205       1
  3  narrator  P+T          0.01 s  0.01 s         465         51     414
  ratio 1.00 (51 processed / 51 new): PASS

median first token: P 0.05 s · A 0.02 s · P+T 0.01 s
median total:       P 0.05 s · A 0.02 s · P+T 0.01 s
median ratio 1.00 (limit 1.5)
PASS: call 3 processed at most 1.5× its new tokens in every round
$ rp-core bench ttft --rounds 2 --prompt-tokens 1200 --tail-tokens 120 --agent-tokens 600 --pin off
bench ttft: 6 real calls to local:m (2 rounds of narrator P, filing A, narrator P+T; at most 16 output tokens each)
server info: llama.cpp b11901, 2 slots
slot pinning: off — --pin off
prompts: P 1 200 tokens, A 600 (50 % of it P's start), T 120 (o200k estimate; synthetic words, seeded)
round 1
  #  agent     prompt  first token   total  prompt tok  processed  cached
  1  narrator  P            0.05 s  0.05 s         419        419       0
  2  filing    A            0.01 s  0.01 s         199         97     102
  3  narrator  P+T          0.04 s  0.04 s         472        370     102
  ratio 6.98 (370 processed / 53 new): FAIL
round 2
  #  agent     prompt  first token   total  prompt tok  processed  cached
  1  narrator  P            0.04 s  0.04 s         414        413       1
  2  filing    A            0.01 s  0.01 s         206        105     101
  3  narrator  P+T          0.04 s  0.04 s         465        364     101
  ratio 7.14 (364 processed / 51 new): FAIL

median first token: P 0.05 s · A 0.01 s · P+T 0.04 s
median total:       P 0.05 s · A 0.01 s · P+T 0.04 s
median ratio 7.06 (limit 1.5)
FAIL: call 3 reprocessed more than 1.5× its new tokens (round 1 6.98, round 2 7.14): the narrator's cache did not survive the agent call
try: llama-server -np 2 --no-kv-unified with slot pinning, or -np 1 with --cache-ram
(exit 1)
```

The bench prints its call count before it sends anything, then the server info and the verdict. P,
A and T are sized with the o200k estimate (1 200, 600, 120). The fake counts words, so its
`prompt tok` column shows 419, 199 and 472. A starts with P's own start (`--agent-shared`, 50 % by
default), as a Director's or filing prompt shares the system prompt and the card. The ratio uses only
the server's numbers: call 3's processed tokens over its prompt minus call 1's. Each round has its
own seeds, so round 2's P starts cold (1 cached: the role marker).

A real run puts a random salt before P, so a rerun is measured cold and the `prompts:` line ends
`seeded, salted per run`. The tests set `RP_CORE_BENCH_SALT=''`, so the output above is the same on
every run.

Pinned, call 2 goes to slot 1, and call 3 finds P in slot 0: ratio 1.00, PASS, exit 0. With
`--pin off` the fake puts call 2 on slot 0. A reuses P's start there (102 tokens in round 1) and
replaces the rest, so call 3 finds only those 102 and processes 370 of its 472: ratio 6.98 and 7.14,
FAIL, exit 1, with the hint.

### 4. `--stdio`: the notice reaches a JSON-RPC client

```
$ rp-core new --card ./test/demo-m5d/card.json --persona ./test/demo-m5d/persona.json --no-chat
rp-core: created session s_b387041b "Narrator" with 1 greeting (card imported as library character narrator)
s_b387041b
$ rp-core --stdio  (initialize, session/open s_b387041b, then every frame until the notice)
{"jsonrpc":"2.0","id":1,"result":{"protocol":1,"core":{"version":"0.1.0"},"features":["swipes","events","models","memory","conflicts","draft","review-gate"]}}
{"jsonrpc":"2.0","id":2,"result":"…"}
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_b387041b","ts":"2026-11-14T14:53:06.493Z","type":"notice","level":"info","code":"slots_pinned","message":"The llama.cpp server at http://127.0.0.1:8080 (2 slots, build b11901) is pinned: the narrator keeps slot 0 and the agents use slot 1. The narrator's cache stays in VRAM only with -np 2 --no-kv-unified: with the default -np auto the KV is unified and an idle slot is moved to host RAM whenever another task starts."}}
```

The test sends `initialize` and `session/open`, then reads frames until a notice arrives (5 s at
most) and sends `shutdown`. The `session/open` result (the session's snapshot) is cut to `"…"`. The
notice is an `event` frame like any other bus event. It comes after the `session/open` result: the read
starts at the open and does not block it, and the fake answers `/props` after 300 ms.

### 5. Ollama: two names on one model file

```
$ cat <home>/config.toml
[connections.ollama]
base_url = "http://127.0.0.1:11434"

[caps."ollama:lumen-16k"]
context_length = 16384

[caps."ollama:lumen-32k"]
context_length = 32768

[roles]
narrator = "ollama:lumen-16k"
director = "ollama:lumen-32k"

[director]
enabled = true

[compendium]
enabled = false

$ rp-core new --card ./test/demo-m5d/card.json --persona ./test/demo-m5d/persona.json --no-chat
rp-core: created session s_f2bfe72c "Narrator" with 1 greeting (card imported as library character narrator)
s_f2bfe72c
$ rp-core chat s_f2bfe72c < typed.txt
session s_f2bfe72c · Narrator · narrator ollama:lumen-16k (tools: prompted) · director ollama:lumen-32k (auto) · ctx 16384
Narrator › The last ferry is late. Pell waits behind the ticket window while rain runs down the glass.
  [greeting 1/1]
you      › I slide the ticket window open.
  ⋯ director: planned — arcs +1 · chapter 1
Narrator › Rain needles the canal. The night ferry noses up to the landing, its lamp swinging, and a man in a dry grey coat steps off before the gangway is down.
  [swipe 1/1 · 30 tok · 1.0s · end]   /r swipe  /c continue  /e edit
! On the Ollama server at http://127.0.0.1:11434, the narrator on lumen-16k and the Director on lumen-32k share one model file with different runner options (num_ctx 16384 vs 32768), so every switch between them reloads the model. Bind both roles to one name. (ollama_reload_risk)
you      › I ask the man in grey for his ticket.
  ⋯ director: planned — no changes
Narrator › The man in grey slides a coin under the glass, not a ticket. "One more crossing," he says, and his voice carries no water in it at all.
  [swipe 1/1 · 28 tok · 0.7s · end]   /r swipe  /c continue  /e edit
you      › /trace
trace of 9ff3117f · ollama:lumen-16k
  window 16384 · reserve 2048 · prompt ~825 tok (server: 603) · 10 messages sent
  trimmed: nothing · prefill: none
  unknown macros: none
  lore: nothing fired · budget 3584 tok
  calls:
    director  +0.0 s  first token 0.6 s  0.6 s  prompt 0 cached, 5 923 new  ollama:lumen-32k
    narrator  +0.6 s  first token 0.1 s  0.1 s  prompt 0 cached, 603 new
you      › /quit
```

The reader sees Ollama (`/props` 404, then `/api/version` and `/api/ps`). Two names on one origin, so
the session asks `/api/show` for both, once each; the test checks that exact list of requests. Same blob, other `num_ctx`: `ollama_reload_risk`. The
fake reloads on every switch, so in `/trace` the Director and the narrator both start from an empty
cache in every turn (`prompt 0 cached`). The Director's row names its model because it is not the
answer's. Nothing is pinned: D-211 never pins on Ollama.

### 6. LM Studio: one model not loaded

```
$ cat <home>/config.toml
[connections.lmstudio]
base_url = "http://127.0.0.1:1234"

[caps."lmstudio:lumen-7b"]
context_length = 16384

[caps."lmstudio:lumen-3b"]
context_length = 16384

[roles]
narrator = "lmstudio:lumen-7b"
director = "lmstudio:lumen-3b"

[director]
enabled = true

[compendium]
enabled = false

$ rp-core new --card ./test/demo-m5d/card.json --persona ./test/demo-m5d/persona.json --no-chat
rp-core: created session s_706c44e4 "Narrator" with 1 greeting (card imported as library character narrator)
s_706c44e4
$ rp-core chat s_706c44e4 < typed.txt
session s_706c44e4 · Narrator · narrator lmstudio:lumen-7b (tools: prompted) · director lmstudio:lumen-3b (auto) · ctx 16384
Narrator › The last ferry is late. Pell waits behind the ticket window while rain runs down the glass.
  [greeting 1/1]
you      › I slide the ticket window open.
  ⋯ director: planned — arcs +1 · chapter 1
Narrator › Rain needles the canal. The night ferry noses up to the landing, its lamp swinging, and a man in a dry grey coat steps off before the gangway is down.
  [swipe 1/1 · 30 tok · 0.4s · end]   /r swipe  /c continue  /e edit
! The roles on the LM Studio server at http://127.0.0.1:1234 name 2 models (lumen-7b, lumen-3b) and lumen-3b is not loaded: a JIT load with Auto-Evict on (LM Studio's default) unloads the other model each time. Load both with `lms load`, or bind the agents to the narrator's model. (lmstudio_autoevict)
you      › I ask the man in grey for his ticket.
  ⋯ director: planned — no changes
Narrator › The man in grey slides a coin under the glass, not a ticket. "One more crossing," he says, and his voice carries no water in it at all.
  [swipe 1/1 · 28 tok · 0.0s · end]   /r swipe  /c continue  /e edit
you      › /trace
trace of 60e886a0 · lmstudio:lumen-7b
  window 16384 · reserve 2048 · prompt ~825 tok (server: 603) · 10 messages sent
  trimmed: nothing · prefill: none
  unknown macros: none
  lore: nothing fired · budget 3584 tok
  calls:
    director  +0.0 s  first token 0.0 s  0.0 s  lmstudio:lumen-3b
    narrator  +0.0 s  first token 0.0 s  0.0 s
you      › /quit
```

The reader sees LM Studio through `/api/v1/models` (`lumen-3b` has no `loaded_instances`), and
`lmstudio_autoevict` is told. LM Studio reports no prompt counts, so the `/trace` rows have timings
and no `prompt`.

## 3. What the run says about time and caching

The run shows **what rp-core sends and reads**: the slot each call asks for, the counts the server
reports, where they appear, and which notices the person gets. These are exact and asserted.

It does **not** measure a real server. The fakes stand for these points:

- **Slot choice without `id_slot`.** The fake puts every unpinned call on slot 0. A real llama.cpp
  picks an idle slot by prompt similarity (`--slot-prompt-similarity`) and then by least recent use.
  An agent prompt that shares the narrator's start is drawn to the narrator's slot by that similarity,
  and the live run (§4) shows it happen. Pinning rules that out, and part 2 shows the case. With the
  default `-np auto` the KV cache is unified, and llama.cpp moves an idle slot to host RAM when
  another task starts. The `slots_pinned` notice says so, and the fake does not model it.
- **What a cache costs.** The fake's 0.1 ms per token is not a GPU's prompt rate. The ratio of
  processed to new tokens is what carries over, and that is what `bench ttft` judges (≤ 1.5, ARCHITECTURE
  §15's acceptance).
- **Ollama reloads.** The fake empties its one cache on every switch of name. A real Ollama reloads the
  runner when `needsReload` sees other runner options (server/sched.go at v0.40.12), which costs the
  load as well as the prompt. Whether two different blobs stay loaded together depends on VRAM and
  `OLLAMA_MAX_LOADED_MODELS`, so rp-core does not warn about them (D-212).

The engine tests that hold the rest, against their own fakes:

- **The pin in every call path** (the Director, sync recall, a draft, the preview's wire, an old build at
  capacity 1 and 2, `extra_body` winning, `local = false`, a `script:` override, `record:`):
  `test/pin-m5d/engine.test.ts`; the adapter's `id_slot` per agent and `slot_pin` in config:
  `test/pin-m5d/adapter.test.ts`.
- **The reader** (deadlines, a hanging path, refused origins and dialects, the key) and the verdict
  table: `test/serverinfo-m5d/serverinfo.test.ts`, `pin.test.ts`; `probe`: `probe-cli.test.ts`.
- **The notices** (each code and its wording, once per session, after a `/model`, with the
  Compendium on and off): `test/serverinfo-m5d/notices.test.ts`.
- **The prompt counts** (llama.cpp timings with and without `cache_n`, OpenAI `cached_tokens`, Ollama's
  timings never read as processed) and the trace rows: `test/trace-m5d/`.
- **`bench ttft`** (one slot, an old build, Ollama- and LM Studio-shaped servers, `--json`, a failed
  call, bad arguments): `test/bench-m5d/bench.test.ts`.

## 4. Live run on this machine

D-217's live checks, run on 2026-11-14 with the user's go-ahead. The machine has an RTX 4070 Ti SUPER
with 16 GB. The model is Mag-Mell R1 12B (Ollama's `magmell-16k` blob), a full-attention llama
model. The outputs below are the commands' own, except that the model path llama-server prints is
shown as `<blob>`.

### Ollama: one slot, and it passes

Ollama 0.40.12, `magmell-16k`, one slot (`OLLAMA_NUM_PARALLEL` at its default). The bench ran twice:

- With the first bench version (A unrelated to P, prompts not salted): PASS, ratio 1.00 in all three
  rounds. The first call's first token took 121.62 s, which was the model loading from disk.
- With the final bench (A shares 50 % of P's start, salted per run): PASS again.

```
bench ttft: 9 real calls to ollama:magmell-16k (3 rounds of narrator P, filing A, narrator P+T; at most 16 output tokens each)
server info: ollama 0.40.12, nothing loaded
slot pinning: off — Ollama has no slots to pin
prompts: P 4 000 tokens, A 1 500 (50 % of it P's start), T 200 (o200k estimate; synthetic words, seeded, salted per run)
round 1
  #  agent     prompt  first token   total  prompt tok  processed  cached
  1  narrator  P            4.21 s  4.46 s       4 205      4 205       0
  2  filing    A            0.43 s  0.68 s       1 582        801     781
  3  narrator  P+T          0.27 s  0.53 s       4 452        247   4 205
  ratio 1.00 (247 processed / 247 new): PASS
round 2
  #  agent     prompt  first token   total  prompt tok  processed  cached
  1  narrator  P            1.31 s  1.56 s       4 193      4 179      14
  2  filing    A            0.43 s  0.68 s       1 594        805     789
  3  narrator  P+T          0.26 s  0.52 s       4 437        244   4 193
  ratio 1.00 (244 processed / 244 new): PASS
round 3
  #  agent     prompt  first token   total  prompt tok  processed  cached
  1  narrator  P            1.32 s  1.58 s       4 211      4 197      14
  2  filing    A            0.40 s  0.66 s       1 602        796     806
  3  narrator  P+T          0.25 s  0.50 s       4 451        240   4 211
  ratio 1.00 (240 processed / 240 new): PASS

median first token: P 1.32 s · A 0.43 s · P+T 0.26 s
median total:       P 1.58 s · A 0.68 s · P+T 0.52 s
median ratio 1.00 (limit 1.5)
PASS: call 3 processed at most 1.5× its new tokens in every round
```

One slot passes because Ollama starts its llama-server runner with the default `--cache-ram 8192`.
While A runs in the only slot, the narrator's prompt waits in the host-RAM prompt cache, and call 3
gets it back. So the row of ARCHITECTURE §7.4.7 that counts Ollama among the one-slot servers without
a host cache is wrong for this version. The counts come from Ollama's `/v1` `cached_tokens` (Ollama
sends no `cache_n`, D-213).

### The llama-server bundled with Ollama

Ollama ships its own `llama-server`. It ran on the same blob with `-np 2 --no-kv-unified -c 32768`
(16k per slot). It reports build `b1-5320c87ff`, which rp-core shows as `b1`. That is older than
b11552, but the connection's capacity is 1 (`max_in_flight = 1`), so D-211 pins:

```
server info: llama.cpp b1, 2 slots
slot pinning: on — narrator 0, agents 1 (2 slots, capacity 1 (build b1))
```

The server's log showed `selected slot by id (0)` for the narrator's calls and `selected slot by id
(1)` for the agent's.

**Make sure the server uses the GPU.** The first start ran on the CPU: this build keeps its CUDA
backend in a subfolder, and the server did not find it. Started with its working folder and library
path set to that folder, it used the GPU. A server on the CPU still answers, so check its start-up
log for the GPU before you measure anything.

**An invalid first unpinned run, and two bench fixes.** With the first bench version, the pinned run
passed (ratio 1.00 in every round). The unpinned run right after it sent the same seeded prompts, so
the server already had all of them cached, and its PASS means nothing:

```
slot pinning: off — --pin off
prompts: P 4 000 tokens, A 1 500, T 200 (o200k estimate; synthetic words, seeded)
round 1
  #  agent     prompt  first token   total  prompt tok  processed  cached
  1  narrator  P            0.53 s  0.81 s       4 206          1   4 205
  2  filing    A            0.41 s  0.68 s       1 610          1   1 609
  3  narrator  P+T          0.23 s  0.48 s       4 455        249   4 206
  ratio 1.00 (249 processed / 249 new): PASS
```

That led to two changes in the bench:

- A random salt per run goes before P, so a rerun is measured cold. `RP_CORE_BENCH_SALT` replaces it
  (the tests set it to '').
- `--agent-shared` (default 50 %): A starts with P's start, as a Director's or filing prompt shares
  the system prompt and the card. An unrelated A lets llama.cpp's similarity choice put it in the free
  slot, so an unpinned run passed where a real agent's prompt can take the narrator's slot.

### The `-np 2 --no-kv-unified` matrix

The final bench at its defaults (3 rounds; P 4 000 tokens, A 1 500 with 50 % shared, T 200), pinned
by the rule and with `--pin off`, on the default `--cache-ram` and on `--cache-ram 0`:

| Setup | Pin | Ratio, rounds 1–3 | Median first token, P+T |
|---|---|---|---|
| `-np 2 --no-kv-unified`, default `--cache-ram` | on | 1.00, 1.00, 1.00: PASS | 0.23 s |
| `-np 2 --no-kv-unified`, default `--cache-ram` | off | 1.00, 1.00, 15.07: FAIL | 0.37 s |
| `-np 2 --no-kv-unified --cache-ram 0` | on | 1.00, 1.00, 1.00: PASS | 0.09 s |
| `-np 2 --no-kv-unified --cache-ram 0` | off | 14.75, 14.84, 15.07: FAIL | 0.97 s |

(A first `--cache-ram 0` attempt could not bind the port because the old server still ran. Its
results were discarded.)

Unpinned without the host cache, every round fails:

```
bench ttft: 9 real calls to llamacpp:<blob> (3 rounds of narrator P, filing A, narrator P+T; at most 16 output tokens each)
server info: llama.cpp b1, 2 slots
slot pinning: off — --pin off
prompts: P 4 000 tokens, A 1 500 (50 % of it P's start), T 200 (o200k estimate; synthetic words, seeded, salted per run)
round 1
  #  agent     prompt  first token   total  prompt tok  processed  cached
  1  narrator  P            1.09 s  1.35 s       4 215      4 198      17
  2  filing    A            0.22 s  0.47 s       1 592        801     791
  3  narrator  P+T          0.97 s  1.24 s       4 464      3 673     791
  ratio 14.75 (3 673 processed / 249 new): FAIL
round 2
  #  agent     prompt  first token   total  prompt tok  processed  cached
  1  narrator  P            1.09 s  1.35 s       4 203      4 186      17
  2  filing    A            0.23 s  0.47 s       1 604        805     799
  3  narrator  P+T          0.97 s  1.23 s       4 449      3 650     799
  ratio 14.84 (3 650 processed / 246 new): FAIL
round 3
  #  agent     prompt  first token   total  prompt tok  processed  cached
  1  narrator  P            1.10 s  1.36 s       4 221      4 197      24
  2  filing    A            0.21 s  0.46 s       1 612        796     816
  3  narrator  P+T          0.97 s  1.23 s       4 463      3 647     816
  ratio 15.07 (3 647 processed / 242 new): FAIL

median first token: P 1.09 s · A 0.22 s · P+T 0.97 s
median total:       P 1.35 s · A 0.47 s · P+T 1.23 s
median ratio 14.84 (limit 1.5)
FAIL: call 3 reprocessed more than 1.5× its new tokens (round 1 14.75, round 2 14.84, round 3 15.07): the narrator's cache did not survive the agent call
try: llama-server -np 2 --no-kv-unified with slot pinning, or -np 1 with --cache-ram
```

A shares about 800 tokens with P, so llama.cpp gives it the narrator's slot. Call 3 then finds only
that shared start and processes the rest of P again (3 673 of 4 464 tokens in round 1).

Unpinned with the host cache, call 3 found all of P in rounds 1 and 2. In round 3 llama.cpp put A in
the narrator's slot:

```
round 3
  #  agent     prompt  first token   total  prompt tok  processed  cached
  1  narrator  P            1.44 s  1.70 s       4 223      4 197      26
  2  filing    A            0.58 s  0.83 s       1 614        796     818
  3  narrator  P+T          0.96 s  1.22 s       4 465      3 647     818
  ratio 15.07 (3 647 processed / 242 new): FAIL
```

**What the matrix shows.** Pinned, call 3 processed only its new tokens in every round of both
setups. Pinning matters most without the host cache: there every unpinned round lost the narrator's
cache, and call 3's first token went from 0.09 s to 0.97 s. With the host cache, an unpinned narrator
loses its cache only sometimes (one round in three here).

### A chat on the real server

A real session on the same llama-server (`-np 2 --no-kv-unified`, default `--cache-ram`), with the
Director on, two turns and `/trace`. The lines below are the session's own. The greeting is left
out, and `…` marks the narrator's two answers, left out too.

```
session s_67a45708 · Narrator · narrator llamacpp:<blob> (tools: prompted) · ctx ?
you      › /director on
director on: it plans every reply with llamacpp:<blob> (the narrator's model), from the next turn (/director shows its plan; /model director <connection:model> picks another model)
you      › I step off the barge and look for somewhere warm to eat.
  ⋯ director: planned — seeds +1 · chapter 1
…
  [swipe 1/1 · 207 tok · 8.9s · end]   /r swipe  /c continue  /e edit
! The llama.cpp server at http://127.0.0.1:8090 (2 slots, build b1) is pinned: the narrator keeps slot 0 and the agents use slot 1 (2 slots, capacity 1 (build b1)). The narrator's cache stays in VRAM only with -np 2 --no-kv-unified: with the default -np auto the KV is unified and an idle slot is moved to host RAM whenever another task starts. (slots_pinned)
you      › I ask the cook what the town is known for.
  ⋯ director: failed (undecodable)
…
  [swipe 1/1 · 339 tok · 21.6s · end]   /r swipe  /c continue  /e edit
you      › /trace
trace of 591664b0 · llamacpp:<blob>
  window 8192 · reserve 2048 · prompt ~822 tok (server: 843) · 9 messages sent
  trimmed: nothing · prefill: none
  unknown macros: none
  lore: nothing fired · budget 1536 tok
  calls:
    director  +0.0 s  first token 0.4 s  8.1 s  prompt 2 595 cached, 1 071 new
    director  +8.1 s  first token 0.1 s  7.6 s  prompt 3 937 cached, 62 new
    narrator  +15.7 s  first token 0.5 s  5.9 s  prompt 595 cached, 248 new
you      › /quit
```

`slots_pinned` is told after the first answer, as in part 1. In turn 2 the Director made two calls
in slot 1, and the second found 3 937 tokens cached and processed 62. The narrator's 843-token prompt
found 595 tokens cached in slot 0: the Director's calls between its two turns went to slot 1. The
Director's turn-2 plan failed (`undecodable`). That is the known weakness of an RP-tuned 12B as the
Director, not an M5d fault.

## 5. What is still unmeasured

Each needs the user's go-ahead (D-217):

- **An SWA or hybrid model.** The live run used a full-attention model only, and §15's matrix asks for
  both kinds.
- **LM Studio.** It has no models on this machine, so its reader and `lmstudio_autoevict` are shown
  only against fakes.
- **`-np auto` with its unified KV.** The run used `-np 2 --no-kv-unified` only, so the move of an idle
  slot to host RAM that `slots_pinned` warns about is not measured. Nor is a plain `-np 1 --cache-ram
  0` llama-server (Ollama covered one slot with the host cache).
- **A real Compendium lane run.** The chat ran the Director only. Filing and the historian on slot 1
  beside a real narrator are tested only against fakes.

Also still not measured: §15's 60-turn run on llama.cpp and its "no recall call before the first
token in ≥ 90 % of turns", and the time a real Ollama reload between two names costs (the 121.62 s
above was the first load from disk).

## 6. Findings

The integration review read every M5d change for the seams between its parts:

- **`slotPin`'s meaning agrees everywhere.** An object pins, `null` is the user's `slot_pin = false`
  and never pins, and absent leaves it to D-211's rule. That holds in config (`parseCaps`), the
  adapter (`if (caps.slotPin)`), `streamCall` (waits for the reader only when absent), `callCaps`, the
  notices (`slotPinOf`), the preview's wire, `probe` (`slotPinOverride`) and the bench (it always sets
  an object or `null`, so the engine's rule cannot add a slot it left out).
- **The notices reach the front ends that read the bus.** They go on the engine's bus. `rp-core chat` shows
  them between turns, and `--stdio` forwards them as events (§2, parts 1 and 4). `serverCheck` runs
  after every `configure`, so a `/model` is judged again.
- **The trace's counts come from the real adapter**, from llama.cpp timings and from Ollama's
  `cached_tokens` (§2, parts 1 and 5).

One fault, fixed: **`slots_pinned` said its reason twice.** The message put the verdict's reason in
parentheses after the slot count and build, and the plain rule's reason *is* the slot count and build:
`(2 slots, build b11901) is pinned: … slot 1 (2 slots, build b11901).` It now gives the reason only
when it adds something (capacity 1 on an old build, or `slot_pin = true` in config).
(`src/engine/server-notices.ts`.)

A second review then fixed, without changing any output above:
- `slots_pinned` named the narrator's slot even when only the agents were pinned (the narrator on
  its own model with `slot_pin = false`). It now names the pinned roles only.
- An `id_slot` in a model's own `extra_body` was replaced by the pin; it now wins, as the
  connection's does, and `slots_detected` says the user set it.
- `probe` judged a `local = false` connection on a loopback port as a session would not, and judged
  capacity per connection; it now uses the engine's gate and notes when another connection at the
  same origin would give a session a different verdict.
- The server-info read's 3 s deadline now covers resolving the connection's key.
- This demo's tests now assert the ratios, the hint, both PASS rounds, the `/trace` counts, the
  notice's place and the LM Studio rows that the table above lists.

Left as they are, for a later decision:

- **`rp-core send` prints no server notices.** A one-shot prints its turn's events only, and the
  notices are on the bus, like the lane's (`slots_shared`). `--stdio` and the chats show them.
- **Recordings drop the prompt counts.** `src/providers/record.ts` stores a usage event as `{t, u}`, so
  a `replay:` run's `/trace` has timings and no `prompt`. A `record:` run reads no server info (the CLI
  turns the reader off), so its calls are never pinned by the rule.
- **A `local = true` connection on a public host name** (a tunnel) is not read: the reader asks only
  origins that `isLocalOrigin` accepts (loopback, private and CGNAT ranges, `.local`, `.lan` and the
  like), so a slip never reaches a paid API. Such a connection pins only with `slot_pin = true`.
