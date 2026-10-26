# M2 demo — SillyTavern presets and lorebooks, live on Ollama

Milestone M2 ("presets and lorebooks", ARCHITECTURE.md §15) ends with a demo: import a preset and a
world book from SillyTavern, see what fired and why, test the lore without a turn, print the exact
request, and record / replay model calls. This is that demo, run on 2026-10-26 against the user's
own Ollama in a throwaway home (`$H` below), after the M2 integration fixes.

Environment: Bun 1.3.14 (`0d9b296a`), Linux 7.0.0-38-generic (x86_64), Ollama 0.34.2 on
http://127.0.0.1:11434, NVIDIA RTX 4070 Ti SUPER (16 GiB). Model: `magmell-16k` (the user's Modelfile
alias of Mag-Mell R1 12B with `num_ctx 16384`; nothing was pulled, created or deleted). Card:
`test/fixtures/cards/Seraphina.png`. Sources, read in place and copied into `$H/library` by
`rp-core import`: SillyBunny's `default/content/presets/openai/Default.json`, `Geechan - Universal
Roleplay (Chat Completions) (v5.2).json` from the same folder, and `data/default-user/worlds/Eldoria.json`.
Every call had `max_tokens` 200 (the session was created with `--max-tokens 200`, which wins over the
presets' 300 and 10000). **Model calls in total: 3** (2 in the REPL, 1 recorded with `send`); the
replay and the mismatch made none.

The REPL was driven like in M1b: a small Bun script wrote one line at a time into the stdin pipe of
`rp-core chat <id>`, waited for the answer's status line (or 0.7 s of silence after a command), and
timestamped every stdout chunk.

## What the demo shows

| §15 / task demo point | Where | Result |
|---|---|---|
| `config.toml` with `[connections.ollama]` and `[caps."ollama:magmell-16k"] context_length = 16384` | §1 | five lines |
| `rp-core import` of an ST preset (Default), a second one (Geechan v5.2) and a world book (Eldoria) | §1 | ids `default`, `geechan-universal-roleplay-chat-completions-v5-2`, `eldoria`; warnings name what is not honoured; ~70 ms each |
| `new --card Seraphina.png --model ollama:magmell-16k --preset default --lore eldoria --no-chat` | §1 | session `s_fa30c196`; banner `ctx 4095` (Default's own context size) |
| a player line naming two Eldoria keys | §2 | `Shadowfangs` / `glade` → answer 1 (200 tok, cold model load) |
| `/trace`: lore fired, with why | §2 | `eldoria`, `shadowfang`, `glade` fired (`key`); `power` cut by the 974-token budget |
| `/lore test <text naming other keys>` | §2 | `magic` / `Eldoria`: every entry with its reason, budget numbers, nothing sent |
| `/preview`: the lore where the preset puts it | §2 | `#2 system · worldInfoBefore`, right after `main`, as Default.json orders it |
| `/preset <Geechan>` then a message | §2 | window 16384, budget 4046, all four entries fire; Geechan's SillyBunny-only macros reported as unknown |
| `/lore rm eldoria`, then `/lore test` | §2 | the session book is gone; the **card's own** Eldoria (Seraphina embeds it) takes its place, so entries still fire (see "Odd things" 1) |
| `/usage` | §2 | 2 generations, 4931 in / 400 out, cost unknown |
| `send … --provider record:<file>` | §3 | one call recorded (71 KB line: request, events, raw SSE), 3.8 s |
| replay the same turn on a fork with `--provider replay:<file>` | §3 | identical answer in 0.42 s, inside `unshare -rn` (no network at all, not even loopback) |
| change the preset, replay again → `replay_mismatch` with a readable diff | §3 | exit 3, first differing message with a caret, counts, samplers |

## 1. Config, imports, session

```
$ cat $H/config.toml
# rp-core M2 demo home
[connections.ollama]
base_url = "http://127.0.0.1:11434"

[caps."ollama:magmell-16k"]
context_length = 16384

$ rp-core import "$HOME/ST/SillyBunny/default/content/presets/openai/Default.json"
rp-core: warning: not honoured: the continue nudge (rp-core's continue follows §6.4); kept in extras (continue_nudge_prompt)
rp-core: warning: not honoured: media inlining; kept in extras (media_inlining)
default
rp-core: imported preset "Default" as $H/library/presets/default.json
rp-core: hint: /preset default in the chat, or rp-core new --preset default
(exit 0, 75 ms)

$ rp-core import "$HOME/ST/SillyBunny/default/content/presets/openai/Geechan - Universal Roleplay (Chat Completions) (v5.2).json"
rp-core: warning: not honoured: the continue nudge (rp-core's continue follows §6.4); kept in extras (continue_nudge_prompt)
rp-core: warning: not honoured: the provider system-prompt switch (use_sysprompt); kept in extras (use_sysprompt)
rp-core: warning: not honoured: the continue postfix; kept in extras (continue_postfix)
rp-core: warning: not honoured: function calling (tools follow the narrator config); kept in extras (function_calling)
rp-core: warning: not honoured: requesting model thoughts (show_thoughts); kept in extras (show_thoughts)
rp-core: warning: not honoured: reasoning effort (set per connection in config.toml); kept in extras (reasoning_effort)
geechan-universal-roleplay-chat-completions-v5-2
rp-core: imported preset "Geechan - Universal Roleplay (Chat Completions) (v5.2)" as $H/library/presets/geechan-universal-roleplay-chat-completions-v5-2.json
rp-core: hint: /preset geechan-universal-roleplay-chat-completions-v5-2 in the chat, or rp-core new --preset geechan-universal-roleplay-chat-completions-v5-2
(exit 0, 76 ms)

$ rp-core import "$HOME/ST/SillyBunny/data/default-user/worlds/Eldoria.json"
eldoria
rp-core: imported lorebook "Eldoria" as $H/library/lorebooks/eldoria.json
rp-core: hint: /lore add eldoria in the chat, or rp-core new --lore eldoria
(exit 0, 67 ms)

$ rp-core new --card test/fixtures/cards/Seraphina.png --model ollama:magmell-16k --preset default --lore eldoria --max-tokens 200 --no-chat
rp-core: warning: use_regex is not honoured: keys are literal unless written /re/flags (4 entries) (data.character_book.entries[*].use_regex)
s_fa30c196
rp-core: created session s_fa30c196 "Seraphina" with 1 greeting (card imported as library character seraphina; preset default; lorebooks eldoria)
(exit 0, 82 ms)
```

Eldoria has four entries, all `before` (ST position 0), order 100, probability 100: `eldoria`
(keys eldoria, wood, forest, magical forest), `shadowfang` (shadowfang, beast, monster, monsters,
beasts), `glade` (glade, safe haven, refuge), `power` (power, magic, ability). Seraphina's card embeds
the same book as its `character_book` (also named "Eldoria"); since the integration fix the session's
`eldoria` stands in for it, as in SillyTavern (`/lore` says `@card … not read: eldoria has the same
name`).

## 2. The REPL (`rp-core chat s_fa30c196`, lines piped one at a time)

Long lines are cut here with ` …`; nothing else is edited.

```
session s_fa30c196 · Seraphina · narrator ollama:magmell-16k (tools: off) · ctx 4095
Seraphina › *You wake with a start, recalling the events that led you deep into the forest and the beasts that assailed you. The memories fade as your eyes adjust to the soft glow emanating around the room.* "Ah, you're awake at last. I was so worried, I found you bloodied and unconscious." *She wal …
  [greeting 1/1]
you       › I sit up slowly. Were those beasts Shadowfangs? And is this glade truly safe from them?
Seraphina › *Seraphina nods solemnly at your question, her brow furrowing.* "Yes, those were indeed Shadowfang beasts. They are wicked creatures that lurk in the darker parts of Eldoria, feeding on the suffering of unwary travelers." *She pauses, giving your hand a reassuring squeeze.* "As for this  …
  [swipe 1/1 · 200 tok · 76.9s · length]   /r swipe  /c continue  /e edit
you       › /trace
trace of b583f52e · ollama:magmell-16k
  window 4095 · reserve 200 · prompt ~1728 tok (server: 1773) · 6 messages sent
  trimmed: nothing · prefill: none
  unknown macros: none
  lore fired: 3 · budget 974 tok
    ✓ "eldoria" eldoria:0 (key)
    ✓ "shadowfang" eldoria:1 (key)
    ✓ "glade" eldoria:2 (key)
  lore cut by the budget: "power" eldoria:3
  calls: narrator ollama:magmell-16k 76.6s
you       › /lore test Tell me about your magic, and about the history of Eldoria.
lore test: a reply to your text (nothing is sent)
  ✓ "eldoria" eldoria:0 · key · keys: eldoria · 413 tok
  ✓ "shadowfang" eldoria:1 · key · keys: shadowfang, beasts · 229 tok
  ✓ "glade" eldoria:2 · key · keys: glade · 242 tok
  ✗ "power" eldoria:3 · budget-cut · keys: magic · costs 176 tok, 91 left · 176 tok
3 of 4 fired · 1 cut by the budget · 884 tok of lore · budget 974 tok
you       › /preview
preview of a swipe (a new answer to 0a06d078) · ollama:magmell-16k
  window 4095 · reserve 200 · prompt ~1728 tok (o200k) · 6 messages · nothing was sent

#1 system · main · 22 tok
Write Seraphina's next reply in a fictional chat between Seraphina and User.

#2 system · worldInfoBefore · 797 tok
User: "What is Eldoria?"
Seraphina: *Seraphina turns, her gown shimmering in the soft light as she offers you a kind smile.* "Eldoria is here, all of the woods. This is my forest glade, a sanctuary of peace within it."  *She gestures at the space around you.* "I am its guardian, tasked with protecting all who seek refuge he …
User: "What happened to Eldoria?"
Seraphina: *Letting out a sigh, Seraphina gazes out at the forest beyond her glade.* "Long ago, Eldoria was a place of wonder. Rolling meadows, a vast lake, mountains that touched the sky."  *Her eyes grow distant, longing for days now lost.* "But the Shadowfangs came and darkness reigns where once  …
User: "What are Shadowfangs?"
Seraphina: *Seraphina's eyes darken, brow furrowing with sorrow at the memory.* "The Shadowfangs are beasts of darkness, corrupted creatures that feast on suffering. When they came, the forest turned perilous — filled with monsters that stalk the night." *She squeezes your hand gently, willing her m …
User: "What is the glade?"
Seraphina: *Seraphina smiles softly, her eyes sparkling with warmth as she nods.* "This is my forest glade, a haven of safety I've warded with ancient magic. No foul beast may enter, nor any with ill intent." *She gestures around at the twisted forest surrounding them.* "Eldoria was once a place of  …

#3 system · charDescription · 689 tok
[Seraphina's Personality= "caring", "protective", "compassionate", "healing", "nurturing", "magical", "watchful", "apologetic", "gentle", "worried", "dedicated", "warm", "attentive", "resilient", "kind-hearted", "serene", "graceful", "empathetic", "devoted", "strong", "perceptive", "graceful"]
[Seraphina's body= "pink hair", "long hair", "amber eyes", "white teeth", "pink lips", "white skin", "soft skin", "black sundress"]
<START>
User: "Describe your traits?"
Seraphina: *Seraphina's gentle smile widens as she takes a moment to consider the question, her eyes sparkling with a mixture of introspection and pride. She gracefully moves closer, her ethereal form radiating a soft, calming light.* "Traits, you say? Well, I suppose there are a few that define me, …
User: "Describe your body and features."
Seraphina: *Seraphina chuckles softly, a melodious sound that dances through the air, as she meets your coy gaze with a playful glimmer in her rose eyes.* "Ah, my physical form? Well, I suppose that's a fair question." *Letting out a soft smile, she gracefully twirls, the soft fabric of her flowing  …
[Genre: fantasy; Tags: adventure, Magic; Scenario: You were attacked by beasts while wandering the magical forest of Eldoria. Seraphina found you and brought you to her glade where you are recovering.]

#4 system · new_chat · 10 tok
[Start a new Chat]

#5 assistant · history · 184 tok
*You wake with a start, recalling the events that led you deep into the forest and the beasts that assailed you. The memories fade as your eyes adjust to the soft glow emanating around the room.* "Ah, you're awake at last. I was so worried, I found you bloodied and unconscious." *She walks over, cla …

#6 user · history · 26 tok
I sit up slowly. Were those beasts Shadowfangs? And is this glade truly safe from them?

prefill: none · max tokens 200 · samplers: temperature 1, top_p 1, top_k 0, min_p 0, top_a 0, frequency_penalty 0, presence_penalty 0, repetition_penalty 1
tools: none
  lore fired: 3 · budget 974 tok
    ✓ "eldoria" eldoria:0 (key)
    ✓ "shadowfang" eldoria:1 (key)
    ✓ "glade" eldoria:2 (key)
  lore cut by the budget: "power" eldoria:3
you       › /preset geechan-universal-roleplay-chat-completions-v5-2
preset → geechan-universal-roleplay-chat-completions-v5-2 "Geechan - Universal Roleplay (Chat Completions) (v5.2)" (from the next turn)
you       › Thank you. Is the forest beyond the glade still dangerous at night?
Seraphina › *Seraphina nods wistfully, a hint of sorrow flickering across her features.* "I'm afraid so. When the sun sets, Eldoria changes. The shadows grow long and menacing, and the creatures that dwell there... They become more aggressive, more dangerous." *She gazes out at the encroaching darkn …
  [swipe 1/1 · 200 tok · 4.6s · length]   /r swipe  /c continue  /e edit
you       › /trace
trace of 23c17004 · ollama:magmell-16k
  window 16384 · reserve 200 · prompt ~3088 tok (server: 3158) · 9 messages sent
  trimmed: nothing · prefill: none
  unknown macros: #if, /if
  lore fired: 4 · budget 4046 tok
    ✓ "eldoria" eldoria:0 (key)
    ✓ "shadowfang" eldoria:1 (key)
    ✓ "glade" eldoria:2 (key)
    ✓ "power" eldoria:3 (key)
  calls: narrator ollama:magmell-16k 4.5s
you       › /lore rm eldoria
lorebook eldoria removed (from the next turn; it stays in the library)
you       › /lore
lorebooks, in the order a turn scans them:
  @card  the card's own book "Eldoria" · 4 entries
in the library, not in this session: eldoria (/lore add <id>)
you       › /lore test Tell me about your magic, and about the history of Eldoria.
lore test: a reply to your text (nothing is sent)
  ✓ "eldoria" @card:0 · key · keys: eldoria, forest · 403 tok
  ✓ "shadowfang" @card:1 · key · keys: shadowfang, beasts · 223 tok
  ✓ "glade" @card:2 · key · keys: glade · 236 tok
  ✓ "power" @card:3 · key · keys: magic · 172 tok
4 of 4 fired · 1034 tok of lore · budget 4046 tok
you       › /usage
2 generations on this path · in 4931 tok · out 400 tok · cost unknown
  (2 without a price ([prices."conn:model"] in config.toml))
you       › /fork
forked into s_8e42a635 (messages 1–5)
session s_8e42a635 · Seraphina · narrator ollama:magmell-16k (tools: off) · ctx 16384
Seraphina › *Seraphina nods wistfully, a hint of sorrow flickering across her features.* "I'm afraid so. When the sun sets, Eldoria changes. The shadows grow long and menacing, and the creatures that dwell there... They become more aggressive, more dangerous." *She gazes out at the encroaching darkn …
  [swipe 1/1 · 200 tok · 4.6s · length]   /r swipe  /c continue  /e edit
you       › /fork
forked into s_efa6f631 (messages 1–5)
session s_efa6f631 · Seraphina · narrator ollama:magmell-16k (tools: off) · ctx 16384
Seraphina › *Seraphina nods wistfully, a hint of sorrow flickering across her features.* "I'm afraid so. When the sun sets, Eldoria changes. The shadows grow long and menacing, and the creatures that dwell there... They become more aggressive, more dangerous." *She gazes out at the encroaching darkn …
  [swipe 1/1 · 200 tok · 4.6s · length]   /r swipe  /c continue  /e edit
you       › /quit
```

Exit 0. What it shows:

- **Why each entry fired.** Scan depth 2 (ST's default) reads the player's line and the greeting:
  `shadowfang` on "Shadowfangs"/"beasts", `glade` on "glade", `eldoria` on "forest" (in the greeting).
  `power` matched too ("magic" is in the greeting) but did not fit: Default.json's own context size,
  4095, gives a window of 4095 and a lore budget of round(0.25 × (4095 − 200)) = 974 tokens, and the
  first three entries took 913 of them. ST's budget rule, exactly.
- **`/lore test`** reads the draft plus the last message (the model's answer, which says
  "Shadowfang"), so `shadowfang` fires on text the player never typed; `power` is cut again by the
  same budget (91 tokens left, 176 needed). Each line says which keys matched.
- **`/preview`** puts the lore in `#2 system · worldInfoBefore`, right after `main`, which is where
  Default.json's prompt order has the `worldInfoBefore` marker (then persona — none here — and the
  description). `charPersonality`, `scenario` and `dialogueExamples` are empty for Seraphina, so not
  sent. Under Geechan the lore again lands right after its `main` ("# Story Context"):
  `rp-core preview s_8e42a635 --draft …` lists `#1 0dc06d25…`, `#2 main`, `#3 worldInfoBefore`,
  `#4 charDescription`, `#5 new_chat`, then the chat.
- **`/preset`** takes effect at the next turn: window 16384 (Geechan says 65536; the model's 16384
  wins), budget 4046, all four entries fit. The trace names `#if` and `/if` as unknown macros (see
  "Odd things" 2).
- **Token counts:** o200k estimates 1728 / 3088 tokens where Ollama reported 1773 / 3158 (−2.5 %,
  −2.2 %): Mag-Mell's Mistral-Nemo tokenizer is close to o200k on English; the EMA (D-50) corrects
  the rest per model.

## 3. Record, replay on a fork, and a mismatch

`/fork` twice at the end of §2 made two copies of the story at the same point: `s_8e42a635` (B) and
`s_efa6f631` (C). The same player line then went to all three sessions.

```
$ rp-core send s_fa30c196 "I glance toward the window. Will you teach me a little of your magic?" --provider record:$H/calls.jsonl
*Seraphina's eyes light up at your request, a warm smile spreading across her face.* "Of course, I'd be delighted to share some of my magic with you," *she says, her voice gentle yet enthusiastic.* "Magic is like the heartbeat of Eldoria, and as its guardian, I've learned to tap into its essence." … "Imagine a green glow emanating from the tree's roots, slowly traveling up its trunk
(exit 0, 3837 ms)

$ wc -c $H/calls.jsonl
71448 $H/calls.jsonl          # one line: v, requestHash 3b0b4d8f4a08b0c7, request (16 KB), model {ollama, magmell-16k}, events (7 KB), raw SSE (49 KB)

$ unshare -rn rp-core send s_8e42a635 "I glance toward the window. Will you teach me a little of your magic?" --provider replay:$H/calls.jsonl     # no network at all, not even loopback
*Seraphina's eyes light up at your request, a warm smile spreading across her face.* "Of course, I'd be delighted to share some of my magic with you," … slowly traveling up its trunk
(exit 0, 422 ms)

$ printf '/preset default\n/quit\n' | rp-core chat s_efa6f631 | tail -3
you       › /preset default
preset → default "Default" (from the next turn; it caps the window at 4095 of the model's 16384 tokens)
you       › /quit

$ unshare -rn rp-core send s_efa6f631 "I glance toward the window. Will you teach me a little of your magic?" --provider replay:$H/calls.jsonl
rp-core: the answer failed (request/replay_mismatch): the request differs from the recorded one (recorded call 1 of 1)
messages: 11 recorded, 10 actual
first difference: messages[0] (system)
  at char 0 (recorded 57 chars, actual 76)
  recorded: {{.player-instructions =\n\n}}\n\n{{.player-posthistory =\n\n}}
  actual:   Write Seraphina's next reply in a fictional chat between Ser…
            ^
9 more of the 10 shared messages differ
samplers.top_p: 0.99 recorded, 1 actual
(exit 3, 409 ms)
```

- **Replay needs no network.** `unshare -rn` runs the command in an empty network namespace (curl to
  127.0.0.1:11434 fails there with exit 7). The replayed answer is byte-identical; its journal entry
  says `gen.connection: "replay"`, `ttftMs 1`, `ms 326`, with the recorded usage (3383 in, 3357 from
  Ollama's cache, 200 out). The request matched because the fork carries the same path and config;
  the replay connection shapes it with the caps of the connection it was recorded on (`ollama`).
- **The mismatch is loud and readable**: exit 3 (`failed`), what differs first (the system message,
  with both texts and a caret), how many other messages differ, and the sampler that changed. The
  player line stays on C unanswered, as after any failed turn.

## 4. Timings

TTFT "engine" is `gen.ttftMs` from the journal (request sent → first text event); "driver" is the line
written into the pipe → the first stdout chunk of the answer.

| step | preset | TTFT engine | TTFT driver | total | out tok | in tok (cache read) | finish |
|---|---|---|---|---|---|---|---|
| player line (cold: model load) | Default | 73 306 ms | 73 630 ms | 76.9 s | 200 | 1773 (0) | length |
| player line after `/preset` | Geechan | 1 220 ms | 1 252 ms | 4.6 s | 200 | 3158 (4) | length |
| `send --provider record:` | Geechan | 99 ms | — | 3.7 s (process 3.84 s) | 200 | 3383 (3357) | length |
| `send --provider replay:` (no network) | Geechan | 1 ms | — | 0.33 s (process 0.42 s) | 200 | 3383 (3357), recorded | length |
| `send --provider replay:` after `/preset default` | Default | — | — | process 0.41 s, exit 3 | — | — | replay_mismatch |

- Commands: `/trace`, `/lore …`, `/preview`, `/preset`, `/usage`, `/fork` each answered within the
  driver's 0.7 s quiet window. One-shot `rp-core preview <id> [--wire]` runs in ~0.39 s, process start,
  o200k load (~0.3 s, lazy) and assembly included; `rp-core import` 67–76 ms; `new` 82 ms.
- Warm decoding ~55–60 tokens/s (200 tokens in 3.3–3.6 s). The second REPL turn had no cache to reuse (the
  preset changed the whole system prompt: 4 of 3158 cached); the recorded `send` right after it
  reused 3357 of 3383 tokens, TTFT 99 ms.
- **The cold load took 73 s**, against 6 s in the M1b demo with the same weights. It is Ollama's
  (`/api/ps` afterwards: `magmell-16k:latest`, `context_length 16384`, 9.8 GB in VRAM); the engine's
  first-byte timeout for a local server is 600 s, so nothing tripped.

## 5. Odd things and findings

1. **`/lore rm eldoria` does not make the lore stop firing, by design.** Seraphina's card embeds
   Eldoria (`character_book.name: "Eldoria"`, the same four entries), and a card's own book cannot be
   removed from a session. While the session had `eldoria`, the card's copy was not read (fixed during
   this integration: before, both copies were scanned — the duplicates were budget-cut under
   Default's 4095 window and would have been sent twice under a larger one). After `/lore rm` the
   card's copy is read again, so `/lore test` still fires all four entries, now as `@card:*`. With a
   card that has no book (checked afterwards with a one-line JSON card, no model call) the same
   `/lore rm eldoria` + `/lore test` ends in "no lore entries to test: /lore add <id|file> adds a
   book". SillyTavern behaves the same way (a character's world is skipped only while the same world
   is active globally).
2. **Geechan v5.2 relies on SillyBunny's macro engine.** Its first block is
   `{{.player-instructions = …}}` / `{{.player-posthistory = …}}` and its `main` wraps a section in
   `{{#if .player-instructions}}…{{/if}}`. rp-core has no block forms and no dot-variable shorthand
   (D-43; §19.3 "без block-if, dot/$"), so these go to the model as literal text (the mismatch diff in
   §3 quotes one). `/trace` now lists them as unknown macros (`#if`, `/if`, and `.player-instructions`
   etc. — the reporting was widened during integration; before, only `/if` showed). Since the M2 fix
   the import says so too: one `unknown_macro` warning per name, with the number of blocks.
3. **SillyTavern's Default.json caps the window at 4095.** Its `openai_max_context` is honoured
   (§10.2: a preset may only shrink the window), so a 16k model ran with a 4095 window and a 974-token
   lore budget. The banner said `ctx 16384` before the integration fix; it now says `ctx 4095`, and
   `/preset default` says "it caps the window at 4095 of the model's 16384 tokens".
4. **The card's linked-world warning was wrong for Seraphina** ("linked world book "Eldoria" is not
   part of the card; import it separately"): the embedded book is that world. Fixed: no warning when
   the names match. Following the old advice is exactly what produced item 1's double read.
5. **`/preview` on a story whose last message is an answer previews a swipe** (`preview of a swipe (a
   new answer to 0a06d078)`): the next turn without new input is a re-roll. `rp-core preview --draft`
   previews a reply instead.
6. **Imported sampler zeros reach the preview, not the wire.** Default.json's `top_k 0`, `min_p 0`,
   `top_a 0`, `repetition_penalty 1` are listed by `/preview`; `/preview --wire` shows only
   `temperature`, `top_p`, `frequency_penalty`, `presence_penalty` and `max_tokens`, because Ollama's
   caps accept no others. Correct, but the two views can surprise. Changed by the M2 fix: the
   samplers line of `/preview` now lists what the connection sends, and the rest on a line of its
   own (`not sent by this connection: top_k, min_p, top_a, repetition_penalty`).
7. Not odd, but visible: 200-token answers end mid-sentence (`finish: length`).

### Changed by the M2 fix (after this run)

The transcript above is what ran on 2026-10-26. A review of the milestone changed some of what the
same commands print or send; nothing above was rerun.

- **Lore that fired into a slot the preset does not send** is marked in `/trace` and `/lore test`
  ("not sent: the preset has no enabled {{lore::before}}"), with a notice. `/lore test` also names
  a book it skipped (missing from the library).
- **A `budget-cut` line** says what the entry would have added (its separator included) and the
  most that was still left, so "power" here reads as not fitting.
- **Several session books with one name** are read once: a changed copy of Eldoria added with
  `/lore add` replaces `eldoria` instead of being scanned next to it.
- **A piped chat under `--provider replay:`** exits 3 when an answer fails (§3's mismatch through
  `send` already did), and stops at the first `replay_mismatch`.
- **The greeting** is left out of the request, with a notice, before a turn is refused for the
  window; the refusal names the parts it counted.
- **The import warning about the continue nudge** says it in words: "the continue nudge (rp-core's
  /c continues the last answer its own way)", not a section number of the design doc.
- **`/lore test` counts** each entry as `/preview` does (raw o200k), and the last line measures the
  budget in budget tokens: `<used> of 974 budget tok`, followed by `(counts ×<factor> for this
  model)`. The correction starts at ×1.15 and then follows the server's counts (here after the first
  answer: Ollama reported 1773 tokens for an estimate of 1728). An entry skipped after the budget
  overflowed says so ("skipped: an earlier entry had already used up the budget"). The `budget-cut` line reads `costs 176 budget tok, 91 left`,
  without the bare `· 176 tok` after it.
- **`/trace`** adds the entries that did not fire, recomputed from the answer's seed: one line for
  each with a reason of its own, one count line for the no-key-match and disabled ones, and the
  notice when the preset, a book or the history changed since. Both traces above read the same:
  every Eldoria entry either fired or is on the stored cut line.
- **`/preview --verdicts`** prints the lore test under the request in the chat too; `/preview
  --wire` keeps the notices after the body.
- **Geechan's reply length.** Its `openai_max_tokens` is 10000. Here `--max-tokens 200` overrode it
  (reserve 200, lore budget 4046); without it, 8192 of the 16384 tokens would be kept for the reply
  and the lore budget would be round(0.25 × 8192) = 2048. The README now says so.
- **An `ignoreBudget` entry's text counts** against the entries after it, as in SillyTavern (none of
  Eldoria's entries has the flag).
- **Hidden messages** no longer count for sticky, cooldown and delay, as SillyTavern leaves them out
  of its chat (nothing was hidden in this run).
- **A piped `--provider script:` chat that runs out of calls** says "the script ran out of calls",
  a replay "the recording ran out of calls"; "no longer matches" is kept for `replay_mismatch`.

## How to rerun

```bash
alias rp-core='bun src/cli/main.ts'
H=$(mktemp -d)
printf '[connections.ollama]\nbase_url = "http://127.0.0.1:11434"\n\n[caps."ollama:magmell-16k"]\ncontext_length = 16384\n' > $H/config.toml
SB=$HOME/ST/SillyBunny
rp-core --home $H import "$SB/default/content/presets/openai/Default.json"
rp-core --home $H import "$SB/default/content/presets/openai/Geechan - Universal Roleplay (Chat Completions) (v5.2).json"
rp-core --home $H import "$SB/data/default-user/worlds/Eldoria.json"
id=$(rp-core --home $H new --card test/fixtures/cards/Seraphina.png --model ollama:magmell-16k --preset default --lore eldoria --max-tokens 200 --no-chat)
printf 'Were those beasts Shadowfangs? Is this glade safe?\n/trace\n/lore test Tell me about your magic.\n/preview\n/quit\n' | rp-core --home $H chat $id
rp-core --home $H send $id "Teach me some magic." --provider record:$H/calls.jsonl
```

No model needed for the same wiring: `test/cli/m2.test.ts` (record → replay round trip on an
openai-chat mock, mismatch diff), `test/repl/m2-flows.test.ts` (`/preset`, `/lore`, `/preview`,
`/trace` on a scripted provider), and `test/golden/st-golden.test.ts` (seven SillyBunny captures,
equal to rp-core's requests apart from four named deviations).
