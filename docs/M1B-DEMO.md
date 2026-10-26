# M1b demo — local RP in the terminal, live on Ollama

Milestone M1b ("local RP in the terminal", ARCHITECTURE.md §15) ends with a demo against a real local
model. This is that demo, run on 2026-10-26 against the user's own Ollama in a throwaway home (`$H`
below), plus the Bun fetch long-pause check that §8.8 left for M1.

Environment: Bun 1.3.14 (`0d9b296a`), Linux 7.0.0-38-generic (x86_64), Ollama 0.34.2 on
http://127.0.0.1:11434, NVIDIA RTX 4070 Ti SUPER (16 GiB). Models (both already installed; nothing was
pulled, created or deleted): `hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M` (no `num_ctx` in its
Modelfile) and, for `/model`, `magmell-usersim-stock:latest` (the same Mag-Mell weights, Modelfile
`num_ctx 16384`). Card: `test/fixtures/cards/Seraphina.png`. Every call had `max_tokens` 200 (the
session was created with `--max-tokens 200`; it survives `/model`, which only changes `conn`/`model`).
Model calls in total: **7** (5 in the REPL, 2 one-shot sends that were killed), plus 2 short ones in §8 after the review fixes.

The REPL was driven non-interactively: a small Bun script wrote one line at a time into the stdin
pipe of `rp-core chat <id>` and waited for the answer's status line before the next one, timestamping
every stdout chunk (that is the "driver" TTFT below). `$EDITOR` was a two-line script that appends a
line to the file it is given. (Since this run `$EDITOR` also works as a shell snippet, as in git:
`EDITOR='sh -c "echo edited >> \$1" sh'` — see "Odd things" 6.)

## What the demo shows

| §15 / task demo point | Where | Result |
|---|---|---|
| `config.toml` with an `[connections.ollama]` entry | §1 | three lines; `rp-core init` writes a commented starter instead |
| `rp-core probe ollama:<model>` | §1 | server kind `ollama`, 24 models, the trained window (1 024 000) *not* claimed, a note on how to set the real one, the caps the model gets; `--write` stores the row; 0.10 s, no generation |
| `new --card Seraphina.png --model ollama:<model> --no-chat` | §2 | session `s_2b8cccd8`; two import warnings on stderr |
| streaming RP in the REPL, a Russian player line | §3 | 200 tokens streamed; the model answers in English (the card is English) |
| `/r` swipe | §3 | `swipe 2/2`, prompt cache hit (989 of 990 input tokens) |
| `/c` continue | §3 | glued mid-word (`reassuring` + `ly, taking your hand…`), finish `end` after 37 tokens |
| `/e` via `$EDITOR` | §3 | `edited message 3`, the appended line is in the message |
| `/rewind 2` then a new message → a tail | §3 | head on message 2; the new line and its answer form a new branch; `/tails` lists the two old answers |
| `/model` to a second, already pulled model | §3 | `narrator → ollama:magmell-usersim-stock:latest`; the next answer names it; banner and trace show its window 16384 |
| `/usage`, `/trace` | §3 | 2 generations on the path, 2237 in / 400 out, cost unknown (no `[prices]` row for a local model); trace: window 16384, reserve 200, ~1630 estimated vs 1228 reported |
| `kill -9` mid-answer via `rp-core send`, reopen → recovered + `[interrupted]` | §5 | first kill before any checkpoint → `recovered … nothing worth keeping` (`end{abandoned}`); second kill after a checkpoint → `recovered … marked [interrupted]`, 273 chars kept |

## 1. Config and probe

```
$ cat $H/config.toml
# rp-core M1b demo home
[connections.ollama]
base_url = "http://127.0.0.1:11434"

$ rp-core probe ollama:hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M --write
ollama  http://127.0.0.1:11434  server: ollama
  models (24):
    chargen2:latest                                    ctx ?
    … (22 more, every one ctx ? — the window of a model that is not loaded is only known from its Modelfile)
    hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M     ctx ?
  notes:
    - ollama: hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M: window unknown (trained 1024000 tokens, but /v1 runs at the server's num_ctx, which /api/show does not report for this model); set PARAMETER num_ctx in a Modelfile or context_length under [caps."<connection>:hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M"] in config.toml
  caps of ollama:hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M:
    context ? (engine default: 8192 local, 32768 remote) · max output ? · in flight 1
    tools prompted · tool_choice auto/none · structured json_schema
    prefill assistant-last · mid-system as-user · alternation strict · usage stream_options
    reasoning tags <think> <thinking> <thought> [THINK] ◁think▷ <|begin_of_thought|>
    samplers temperature top_p frequency_penalty presence_penalty seed stop max_tokens
    source host
  stored in $H/caps-cache.json
(0.10 s, exit 0)

$ rp-core probe ollama:magmell-usersim-stock:latest --write      # (abridged)
    magmell-usersim-stock:latest                       ctx 16384
  caps of ollama:magmell-usersim-stock:latest:
    context 16384 · max output ? · in flight 1
    …
    source host → probe

$ rp-core models ollama | head -3
chargen2:latest
chargen3-beta:latest
chargen3:latest
```

`caps-cache.json` then holds `ollama:hf.co/…Mag-Mell…` (`server: ollama`, no caps: nothing the catalog
could confirm) and `ollama:magmell-usersim-stock:latest` (`contextLength: 16384`, from `PARAMETER
num_ctx`), both `as_of` 2026-10-26.

## 2. A session

```
$ rp-core new --card test/fixtures/cards/Seraphina.png --model ollama:hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M --max-tokens 200 --no-chat
rp-core: warning: use_regex is not honoured: keys are literal unless written /re/flags (4 entries) (data.character_book.entries[*].use_regex)
rp-core: warning: linked world book "Eldoria" is not part of the card; import it separately (data.extensions.world)
s_2b8cccd8
rp-core: created session s_2b8cccd8 "Seraphina" with 1 greeting (card imported as library character seraphina)
exit=0
```

## 3. The REPL (`rp-core chat s_2b8cccd8`, lines piped one at a time)

```
session s_2b8cccd8 · Seraphina · narrator ollama:hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M (tools: off) · ctx ?
Seraphina › *You wake with a start, recalling the events that led you deep into the forest and the beasts that assailed you. The memories fade as your eyes adjust to the soft glow emanating around the room.* "Ah, you're awake at last. I was so worried, I found you bloodied and unconscious." *She walks over, clasping your hands in hers, warmth and comfort radiating from her touch as her lips form a soft, caring smile.* "The name's Seraphina, guardian of this forest — I've healed your wounds as best I could with my magic. How are you feeling? I hope the tea helps restore your strength." *Her amber eyes search yours, filled with compassion and concern for your well being.* "Please, rest. You're safe here. I'll look after you, but you need to rest. My magic can only do so much to heal you."
  [greeting 1/1]
you       › Я осторожно сажусь и спрашиваю: «Где я? Кто ты такая?»
Seraphina › *Seraphina looks at you with gentle eyes, softening seeing your confusion and vulnerability in this unfamiliar setting. She speaks in a soothing, melodic voice, its cadence reminiscent to rustling leaves and a babbling brook.* "You are in my secluded glade, a sanctuary deep within the heart of the Eldoria Forest. I am Seraphina, the guardian and protector of this magical realm." *Her slender, ethereal fingers gently tuck a stray strand of her shimmering pink hair behind her ear as her gaze remains affixed upon you.* "You were badly injured, attacked by creatures that lurk in the darker recesses of the woods not far from here. The poor darling, you were on the brink of collapse when I chanced upon you and brought you back here to tend to your wounds." *She gently squeezes your hands reassuringly as she observes you with warm, amber eyes aglow with compassion.* "Don
  [swipe 1/1 · 200 tok · 9.2s · length]   /r swipe  /c continue  /e edit
you       › /r
Seraphina › *Seraphina gently helps you sit up, plumping thesoft pillows behind your back. Her touch is warm and soothing, her expression concerned yet caring.* "You are in my glade, deep within the heart of the Eldorian Forest," *she explains softly, her melodious voice like a gentle breeze.* "I am Seraphina, guardians of this magical realm. I found you wounded and alone, attacked by the forest's more aggressive inhabitants."

*She brushes a strand of pink hair from your face, her fingertips lingering on your cheek.* "I brought you here to safety and tended to your injuries with my healing magic," *Seraphina continues.* "Please, do not exert yourself. You have been through quite an ordeal. Rest now, regain your strength." *Her amber eyes shine with empathy and a hint of worry.* "I will watch over you, as I do all those in need within my forest." *Seraphina smiles reassuring
  [swipe 2/2 · 200 tok · 3.2s · length]   /r swipe  /c continue  /e edit
you       › /c
Seraphina › … forest." *Seraphina smiles reassuringly, taking your hand in hers.* "Tell me, what is your name, dear traveler? And how came you to be in the midst of such peril?"
  [swipe 2/2 · 37 tok · 0.7s · end]   /r swipe  /c continue  /e edit
you       › /e
edited message 3
Seraphina › *Seraphina gently helps you sit up, plumping thesoft pillows behind your back. Her touch is warm and soothing, her expression concerned yet caring.* "You are in my glade, deep within the heart of the Eldorian Forest," *she explains softly, her melodious voice like a gentle breeze.* "I am Seraphina, guardians of this magical realm. I found you wounded and alone, attacked by the forest's more aggressive inhabitants."

*She brushes a strand of pink hair from your face, her fingertips lingering on your cheek.* "I brought you here to safety and tended to your injuries with my healing magic," *Seraphina continues.* "Please, do not exert yourself. You have been through quite an ordeal. Rest now, regain your strength." *Her amber eyes shine with empathy and a hint of worry.* "I will watch over you, as I do all those in need within my forest." *Seraphina smiles reassuringly, taking your hand in hers.* "Tell me, what is your name, dear traveler? And how came you to be in the midst of such peril?"

(Правка из демо: дописано через $EDITOR.)
you       › /rewind 2
you       › Я осторожно сажусь и спрашиваю: «Где я? Кто ты такая?»
rewound to message 2: what you send next starts a new branch; the rest stays as a branch (/tails)
you       › Я молча киваю и пытаюсь встать, опираясь на её руку.
Seraphina › *Seraphina gently assists you as you sit up, placing a reassuring hand on your shoulder.* "Shh, slow down, dear traveler. You're in my glade, hidden deep within the heart of Eldoria's magical forest. I am Seraphina, the guardian of this enchanted place," *she explains softly, her melodic voice soothing any anxieties.* "I discovered you wounded and unconscious, sets by wild beasts. I brought you here so I could tend to your injuries." *Her delicate fingers trace the remnants of healed wounds on your arm, a testament to her restorative powers.*

*Seraphina pours you more tea, the fragrant steam curling hypnotically as she hands you the mug.* "Please, drink more. It will aid your recovery and soothe any lingering pain. And remember, you are safe now under my watch. The beasts of the forest will not bother you again." *A fierce, protective glow kindles in
  [swipe 1/1 · 200 tok · 3.2s · length]   /r swipe  /c continue  /e edit
you       › /model ollama:magmell-usersim-stock:latest
narrator → ollama:magmell-usersim-stock:latest (from the next turn)
you       › Спасибо. Что это за лес?
Seraphina › *Seraphina listens attentively to your question, a warm smile softening her features. She gazes out at the lush greenery surrounding her glade before turning back to you.* "Ah, Eldoria is an ancient, enchanted forest, steeped in magic and wonder - but also fraught with danger if one is unprepared, as you discovered." *Her brow furrows slightly with concern before brightening again.* "For generations, my family has guarded and nurtured this woodland realm, maintaining a delicate balance with the creatures that call it home."

*Leaning back, Seraphina's expression turns wistful.* "Eldoria is a place of untamed beauty - crystal streams that sing with ancient melodies, groves where fruits grow of their own accord, and glades where dancing lights emerge at dusk." *She chuckles softly.* "But it's also home to beasts both wondrous and perilous. Some are drawn to the magic
  [swipe 1/1 · 200 tok · 8.0s · length]   /r swipe  /c continue  /e edit
you       › /usage
2 generations on this path · in 2237 tok · out 400 tok · cost unknown
  (2 without a price ([prices."conn:model"] in config.toml))
you       › /trace
trace of 1a9e5177 · ollama:magmell-usersim-stock:latest
  window 16384 · reserve 200 · prompt ~1630 tok (server: 1228) · 6 messages sent
  trimmed: nothing · prefill: none
  unknown macros: none
  calls: narrator ollama:magmell-usersim-stock:latest 8.0s
you       › /tails
2 branches off this path (/goto <id> switches):
  d5dde80f  #3 Seraphina: "*Seraphina looks at you with gentle eyes, softening seeing…"
  58646c5d  #3 Seraphina: "*Seraphina gently helps you sit up, plumping thesoft…"
you       › /quit
```

Exit 0; no lock left behind. `/rewind 2` first prints message 2 (the player's line) and then says
where the head is; message numbers count from the greeting (1).

## 4. Timings

TTFT "engine" is `gen.ttftMs` from the journal (request sent → first text event); "driver" is the
line written into the pipe → the first stdout chunk of the answer.

| step | model | TTFT engine | TTFT driver | total | out tok | in tok (cache read) | finish |
|---|---|---|---|---|---|---|---|
| Russian player line (cold: model load) | Mag-Mell | 5 986 ms | 6 032 ms | 9.2 s | 200 | 990 (0) | length |
| `/r` | Mag-Mell | 30 ms | 33 ms | 3.2 s | 200 | 990 (989) | length |
| `/c` | Mag-Mell | 77 ms | 80 ms | 0.7 s | 37 | 1191 (1002) | end |
| new line after `/rewind 2` | Mag-Mell | 46 ms | 48 ms | 3.2 s | 200 | 1009 (983) | length |
| line after `/model` (cold: second model load) | usersim-stock | 4 757 ms | 4 768 ms | 8.0 s | 200 | 1228 (0) | length |
| `send` killed early | usersim-stock | — | 149 ms* | killed at 551 ms | — | — | — |
| `send` killed after a checkpoint | usersim-stock | — | 142 ms* | killed at 1939 ms | — | — | — |

\* process start → first answer byte on stdout: Bun start, engine open (lock, fold), assembly and the
call, all included.

Warm decoding runs at ~64 tokens/s (200 tokens in ~3.1 s). Both cold TTFTs are model loads: the second
model evicted the first (two 8.7 GiB instances do not fit in 16 GiB; `/api/ps` afterwards lists only
`magmell-usersim-stock:latest`, `context_length` 16384). With the model warm, Ollama's prompt cache
reuses the prefix (989 of 990 tokens on the swipe), so TTFT is 30–80 ms.

## 5. `kill -9` mid-answer, then reopen

The narrator is now `magmell-usersim-stock` (after `/model`). A script ran
`rp-core send s_2b8cccd8 "Расскажи мне про тварей, которые на меня напали."` and sent SIGKILL as soon
as N characters of the answer were on stdout.

**First kill, N = 120: before the first checkpoint.** Killed at 551 ms with
125 chars printed; the journal had `turn` and `prep` but no `chk` yet
(checkpoints come every 400 chars or 1 s, §6.2 step 8), so there was nothing to keep:

```
$ rp-core show s_2b8cccd8          # no lock, no recovery
…
rp-core: hint: 1 interrupted turn (0 chars of partial text) not shown yet: the next `rp-core send` on this session recovers them, keeping partial text marked [interrupted]

$ printf '/rewind 6\n/quit\n' | rp-core chat s_2b8cccd8
session s_2b8cccd8 · Seraphina · narrator ollama:magmell-usersim-stock:latest (tools: off) · ctx 16384
! recovered an interrupted turn (t_1a231b3b): nothing worth keeping, it was closed
…
```

The turn closed as `end{abandoned}`; the unanswered player line stayed (the REPL says "your message
has no answer yet: /r asks for one"), and `/rewind 6` moved the head back to the last answer so the
second attempt starts clean (the unanswered line became a tail).

**Second kill, N = 480: after a checkpoint.** Killed at 1939 ms with
486 chars printed; the last `chk` line held 273 of them.

```
$ rp-core show s_2b8cccd8
…
rp-core: hint: 1 interrupted turn (273 chars of partial text) not shown yet: the next `rp-core send` on this session recovers them, keeping partial text marked [interrupted]

$ printf '/quit\n' | rp-core chat s_2b8cccd8
session s_2b8cccd8 · Seraphina · narrator ollama:magmell-usersim-stock:latest (tools: off) · ctx 16384
! recovered an interrupted turn (t_ee40f75e): its partial answer was saved, marked [interrupted]
Seraphina › *Seraphina's expression darkens at the memory of your attack. She takes a deep breath, amber eyes clouding with concern.* "The creatures that assaulted you are known as Shadow Claws, twisted beasts that prowl the darker recesses of Eldoria when the moon is waning." *She sh
  [swipe 1/1 · interrupted]   /r swipe  /c continue  /e edit
you       › /quit
```

The stale `.lock` of the killed process (dead pid on this host) was taken over on reopen; `show`
afterwards lists the answer as `assistant · e129079b · swipe 1/1 · [interrupted]`, its `gen` naming
`ollama` / `magmell-usersim-stock:latest` and `finish: interrupted`.

## 6. Odd things and findings

1. **Mag-Mell's real window is unknown.** Its Modelfile has no `num_ctx`, `/api/show` reports only the
   trained 1 024 000, and the model was not loaded when probed, so `/api/ps` could not say either. The
   engine therefore assumed its local default of 8192 (banner `ctx ?`). Ollama in fact runs it at 4096
   (a later `/api/ps`), so a long story would be cut by Ollama. Not an issue at ~1 000 prompt tokens;
   the probe note says how to fix it (`[caps."ollama:<model>"] context_length = …` or `PARAMETER num_ctx`).
   The second model shows the good case: `num_ctx 16384` → the probe, banner and trace all say 16384.
   Since the review fixes the cut is no longer silent: see §8.
2. **Token estimate runs high:** the trace says ~1630 estimated vs 1228 reported by the server (×1.33)
   for an English card with a Russian line. The EMA factor (D-50) corrects this per model after a few
   answers on the path; until then budgets err on the safe side.
3. **`/rewind 2` lands on a user message.** The next line then becomes a second player message under
   the first (the wire merges the two under strict alternation), and the old answer becomes a tail.
   That is the §5.5 semantics (the head goes to message n); a player who wants to *replace* line 2
   should `/rewind 1` (the greeting) instead. Since this run the REPL says so when n is a player
   message ("rewound to your message 2: /r asks for a new answer to it; … (/rewind 1 to replace it
   instead)").
4. **A kill before the first checkpoint keeps nothing** (first kill: 125 chars shown, 0 saved), and
   one after it keeps only the last checkpoint (second kill: 486 shown, 273 saved). This is the
   designed bound (≤ 400 chars or 1 s); for a fast local model 1 s is ~250 chars.
5. **The model answers Russian input in English.** The card and the built-in preset are English and
   nothing asks for Russian; not an rp-core issue.
6. **`$EDITOR` with arguments in quotes.** The REPL first split `$EDITOR` on whitespace, so the
   suggested `EDITOR='sh -c "echo edited >> \$1" sh'` could not work (the demo used a script path).
   Fixed after the run: the editor now runs as `sh -c '<editor> "$@"' sh <file>` on POSIX (git's
   rule), an empty `$VISUAL` falls through to `$EDITOR`; covered by `test/cli/m1b.test.ts`.
7. Not odd, but visible: a 200-token cap ends most answers mid-sentence (`finish: length`); `/c`
   continues them cleanly.

## 7. Bun fetch on long pauses (§8.8, checked for M1)

From `.notes/m1b-bun-fetch.md` (transport agent, Bun 1.3.14, local `Bun.serve` mocks only):

- Bun's `fetch` has its own socket idle timer: 5 minutes by default, set process-wide by
  `BUN_CONFIG_HTTP_IDLE_TIMEOUT` (seconds). It fires on silence before the first byte **and** between
  body chunks and rejects with `TimeoutError`. It is coarse: with the variable at 2 s, both pauses died
  at ~4011 ms.
- The per-request `timeout` option: on 1.3.14 only `false` / `0` do anything (they disable the idle
  timer). A positive number is **not** honoured (`timeout: 1000` survived a 9 s pause; `timeout: 30000`
  under the 2 s variable still died at ~4 s). So the engine cannot hand its timeouts to Bun.
- What rp-core does: `guardedFetch` always passes `timeout: false` (plus `redirect: 'manual'` and the
  caller's signal); the first-byte (600 s local / 120 s remote) and idle (120 s) timeouts belong to
  the engine, which aborts the signal. Aborts end things promptly: 0.34 ms before the first byte,
  0.59 ms mid-body, and a stalled error body ends too.
- Evidence: `test/transport/http-long-pause.test.ts` ([slow]; `RP_CORE_SKIP_SLOW=1` skips it): 20 s
  before the first byte and 20 s mid-body both complete; in a child with
  `BUN_CONFIG_HTTP_IDLE_TIMEOUT=2` and 6 s pauses, plain `fetch` fails at 4011 ms while `guardedFetch`
  succeeds at 6013 ms (both pauses).
- Mock servers: `Bun.serve` has its own `idleTimeout` (default 10 s) that closes a socket silent
  mid-body from the server side; every pausing mock must set `idleTimeout: 0`. Real backends are not
  affected. Re-check when Bun is upgraded: if a later Bun honours a numeric `timeout`, nothing breaks.

## 8. Re-run after the review fixes (2026-10-26)

Two reviewers' findings were fixed after this demo (finish delivered with its `finish_reason` chunk,
timeouts on bytes, fixed error messages, max_tokens = the reserve, a truncation notice, the REPL's
terminal handling, …). Nothing in §§1–5 changes: those turns had no keep-alives, no failures, prompts
of ~1 000 tokens and `max_tokens` 200. Two more live calls (same Ollama, Mag-Mell, nothing pulled)
checked what does change on the wire:

- **The event order of a real stream** (`RP_CORE_LIVE=1 bun test test/adapter/live-ollama.test.ts`,
  max_tokens 64): 29 text events, then `finish` (`end`, raw `stop`, the served model) with the chunk
  that carried `finish_reason`, then the usage of Ollama's `choices: []` chunk (47 in / 30 out). 4.2 s.
- **A prompt the server cut.** A throwaway home whose `[caps."ollama:<Mag-Mell>"] context_length = 16384`
  was wrong on purpose (Ollama ran the model at 4096), `--max-tokens 8`, one 32 009-char player line:

  ```
  usage   {"inputTotal": 2051, "inputCacheRead": 4, "outputTotal": 8}
  notice  warn context_truncated_by_server: The server reported 2051 prompt tokens for a prompt of
          about 11952: it probably cut the prompt to fit a context window smaller than the 16384 tokens
          assumed for ollama:<Mag-Mell>, dropping older messages unseen. Set context_length under
          [caps."ollama:<Mag-Mell>"] in config.toml (`rp-core probe ollama:<Mag-Mell>` reads what the
          server reports), or give the model a larger window on the server.
  done    finish length, "It seems like you might be trying to"
  ```

  0.8 s. The notice comes once per session, and the call is not an EMA sample (before the fix it
  would have dragged the token factor to 0.8). `rp-core probe ollama:<Mag-Mell>` (no generation) now
  lists the loaded model as `ctx 4096` from `/api/ps`; the wrong `[caps]` override still wins until it
  is corrected, as overrides do.

The terminal fixes (keys typed while an answer streams no longer land in it; Ctrl+C stops the turn
even with text typed) cannot be shown through a pipe; `test/repl/tty.test.ts` drives the real
readline on a fake TTY for them.

## How to rerun

```bash
alias rp-core='bun src/cli/main.ts'
H=$(mktemp -d)
printf '[connections.ollama]\nbase_url = "http://127.0.0.1:11434"\n' > $H/config.toml
rp-core --home $H probe ollama:<model> --write
id=$(rp-core --home $H new --card test/fixtures/cards/Seraphina.png --model ollama:<model> --max-tokens 200 --no-chat)
rp-core --home $H chat $id            # or pipe lines: printf 'Привет\n/r\n/c\n/usage\n/quit\n' | …
```

The process tests in `test/cli/m1b.test.ts` cover the same wiring without a model (an openai-chat
mock server, a mock Ollama for `probe`/`models`); `RP_CORE_LIVE=1 bun test test/adapter/live-ollama.test.ts`
streams one short reply from the real Ollama.
