# M3 demo — tools and search, live on Ollama

Milestone M3 ("tools and search", ARCHITECTURE.md §15) ends with a demo: a 200-message Russian chat
whose answer lies far outside the context window; at message 200 the user asks
**«как, по словам трактирщицы, звали её брата?»**, and a local model in prompted mode is meant to
search «брат», find «братом» in #5 and answer **Тихон**; then a `/memory add` note keyed «брат» must
fire on «брата». This is that demo, run on 2026-10-26 against the user's own Ollama in a throwaway
home (`$H` below), after the M3 integration.

**Result in one line: the plumbing works end to end (catalog, prompted stop, search, notes, /search,
/trace, the active probe), but neither local model called a tool on the demo question.** Mag-Mell
(prompted) answered three times without a call — once "the name is not mentioned", twice with a
wrong name taken from the visible chat; gemma4:26b (native tools, the one extra try the task allowed)
thought it over and answered "not mentioned". The deterministic version of the demo, where a scripted
model does call the tool, passes (`test/demo-m3/innkeeper.test.ts`); the gated live test
(`test/live/m3-ollama.test.ts`) asserts the demo claim and would fail on Mag-Mell today. §6 says why
the models do not reach for the tool, and what to change.

**The §15 demo claim (a `search_history` call, then «Тихон») is met by the deterministic demos
(`test/demo-m3/innkeeper.test.ts`, `review-fixes.test.ts`, `live-fixes.test.ts`), not by the local
models tried.** The reruns after D-96 (the gap note and the reminder) and D-97 (an offered tool's name
used as a tag is a call), §8, changed that for neither model: Mag-Mell made no call in runs A3 and B
(6 tries), gemma4:26b (native, 4096 window) none in its 2 tries.

Environment: Bun 1.3.14 (`0d9b296a`), Linux 7.0.0-38-generic (x86_64), Ollama 0.34.2 on
http://127.0.0.1:11434, NVIDIA RTX 4070 Ti SUPER (16 GiB). Models (nothing was pulled, created or
deleted):
- `magmell-16k:latest` — the user's Modelfile alias of Mag-Mell R1 12B (Q5_K_M) with `num_ctx 16384`;
  `/api/show` capabilities `["completion"]`, so tools run **prompted**. `/api/ps` during the run:
  `context_length 16384`, and the server counted 10 377 prompt tokens for a 9 869-token estimate: the
  Modelfile's num_ctx applies on `/v1` and the prompt was read whole.
- `gemma4:26b` (25.8B, Q4_K_M) — capabilities `["completion","vision","tools","thinking"]`, so
  **native** tools. No num_ctx in its Modelfile: `/api/ps` showed `context_length 4096` (the server
  default on this GPU), which the config told rp-core beforehand.

Every call had `max_tokens` 300 (the seeded binding's `maxTokens`), `narrator.maxRounds` 2, no
samplers (the builtin preset sets none, so Ollama's defaults). **Model calls in total: 7** — 3 turns
on Mag-Mell, 1 on gemma4, 3 by the active probe. Everything else (seeding, previews, `/search`,
`/memory`, `/lore test`) made none.

The REPL was driven as in M1b/M2: a small Bun script wrote one line at a time into the stdin pipe of
`rp-core chat <id>`, waited for the answer's status line (or 0.7 s of quiet after a command), and kept
a timestamped log of every stdout chunk.

## What the demo shows

| §15 / task demo point | Where | Result |
|---|---|---|
| `config.toml`: `[connections.ollama]`, `[caps."ollama:magmell-16k:latest"] context_length = 16384`, `tools = "prompted"` | §1 | as below (plus a gemma4 row for the extra try) |
| the innkeeper chat seeded (199 messages, through the engine API, no model) | §1 | `s_3d3b4ada` in 0.86 s |
| banner `(tools: prompted)`; request 0 with the core block and catalog, history trimmed, the prompted stop | §1, §2 | `#7 system · core:tools · 774 tok`; `tools: read_history, search_history (prompted)`; `trimmed` #2–#161 of 200 |
| the question → a `search_history` call → «Тихон» | §2 | **no call** in 3 tries (the question and two `/r`); answers: "not mentioned", «Гордей», «Гордей» |
| `/trace`: rounds, the search call, its result size | §2 | `rounds: 1 · prompted tools · ended: answer · tool room 0 of 4021 tok used` (no tool rows: nothing was called) |
| one try of gemma4:26b with native tools (Mag-Mell never called the tool) | §3 | **no call**; 841 characters of thinking, then "the brother's name is not mentioned" |
| `/search брат` | §2 | #5 found (snippet «…с младшим братом — его зовут Тихон…»), not in context; also #200 (the question, in context) and #201 (the wrong answer) |
| `/memory add Брат трактирщицы \| брат \| Её младшего брата зовут Тихон.`, `/memory` | §2 | note C1 `note:брат трактирщицы` |
| `/lore test А где сейчас её брата искать?` | §2 | the note fires on «брата» (`key`, keys: брат), 22 tok |
| `rp-core probe ollama:magmell-16k:latest --active` (no `--write`) | §4 | 3 calls: stream ok, tools refused (HTTP 400, "no tools in the template"), json_schema enforced; facts `tools prompted`, `structured json_schema` |
| reruns after D-96 and D-97 (27.10.2026) | §8 | **no call**: Mag-Mell (prompted) in 6 tries, gemma4:26b (native, 4096 window) in 2 |
| the same demo with a scripted model | "The same demo without a model" | `test/demo-m3/innkeeper.test.ts`: the call, the snippet, the answer, paired blocks, the note at depth 4, /search |

## 1. Config, seeding, the request

```
$ cat $H/config.toml
# rp-core M3 demo home
[connections.ollama]
base_url = "http://127.0.0.1:11434"

[caps."ollama:magmell-16k:latest"]
context_length = 16384
tools = "prompted"

# The fallback try of the demo: Ollama's /api/show lists "tools" for gemma4:26b. Its Modelfile sets
# no num_ctx, so /v1 runs it at the server's default window (assumed 4096 here).
[caps."ollama:gemma4:26b"]
context_length = 4096
tools = "native"

[caps."ollama:gemma4:26b".reasoning]
output = "reasoning"
```

No engine verb inserts assistant messages, so the chat is seeded through the public API by the
fixture's helper (`test/fixtures/ru/innkeeper-200/load.ts`, `seedInnkeeperHome`): a session from the
card (Марфа, «Сонный гусь») and the persona (Елисей), then 99 `submit`s answered in-process with the
fixture's text. The binding left on the session is the live model:

```ts
// seed.ts (run with bun from the repo; prints the session id)
import { seedInnkeeperHome } from './test/fixtures/ru/innkeeper-200/load.ts';
const id = await seedInnkeeperHome(process.argv[2]!, {
  config: { narrator: { maxRounds: 2 } },
  narrator: { conn: 'ollama', model: 'magmell-16k:latest', maxTokens: 300 },
});
console.log(id);
```

```
$ bun seed.ts $H
s_3d3b4ada
(0.86 s)

$ rp-core --home $H preview s_3d3b4ada --draft "как, по словам трактирщицы, звали её брата?"
preview of a reply to your draft · ollama:magmell-16k:latest
  window 16384 · reserve 300 · prompt ~9869 tok (o200k) · 47 messages · nothing was sent

#1 system · main · 44 tok
Write Марфа's next reply in a fictional roleplay chat between Марфа and Елисей. Stay in character, write vivid prose, and never speak, act or decide for Елисей.
…
#7 system · core:tools · 774 tok
## Looking things up

You have tools that look up details which are not in front of you. Use them quietly:
- When your reply depends on an earlier detail (a name, a number, a place, a promise, who said what) and you are not sure of it, look it up first, then write.
- Never guess names, numbers or quotes. If a search finds nothing, keep the detail vague instead of inventing it.
- Search by word roots and short forms, in the story's own language: one or two key words find more than a whole phrase.
- Never mention tools, searches or results in the story. The reader sees only the story.

## How to call a tool

Write each call as one block on a line of its own:
<tool_call>{"name": "tool_name", "args": {"argument": "value"}}</tool_call>
…
### `search_history`

Search the earlier messages of this chat, newest first. Use it when your reply needs a detail you cannot see in the messages in front of you: a name, a place, an object, something said long ago. A message matches when it holds every word of the query. Nouns, names and adjectives match their other forms, so search by word roots and short forms: брат finds брата and братом. One or two key words find more than a sentence. …

#8 assistant · history · 298 tok
Дверь «Сонного гуся» с натугой подалась, впустив в общую залу порыв сырого ветра, …
…
#47 user · history · 19 tok
как, по словам трактирщицы, звали её брата?

prefill: none · max tokens 300 · samplers: none
tools: read_history, search_history (prompted)
  lore: nothing fired · budget 4021 tok
(0.49 s)
```

Only the history tools are offered (D-92: the history was trimmed; the card has no lorebook and there
are no notes yet). The core block sits in the cached head, right after the last leading system
message; the tool room is round(0.25 × (16384 − 300)) = 4021 tokens. The history kept is the greeting
and #162–#200: #5, the only message naming the brother, is far outside. The `search_history`
description is quoted as it reads now (`src/tools/builtin/history.ts`); the run sent an earlier
wording («Words match their other forms, …»), changed in the review fixes.

## 2. The REPL on Mag-Mell (`rp-core chat s_3d3b4ada`, lines piped one at a time)

Long lines are cut here with ` …`; nothing else is edited. Three separate `chat` runs (the driver
quits after each step, so the next could be decided on what came back).

```
session s_3d3b4ada · Сонный гусь · narrator ollama:magmell-16k:latest (tools: prompted) · ctx 16384
Марфа › Марфа отложила вязание и посмотрела на него долгим, тёплым взглядом. «Не за что, землемер. …
  [swipe 1/1 · 8.0s · end]   /r swipe  /c continue  /e edit
you   › как, по словам трактирщицы, звали её брата?
Марфа › Имя брата Марфы не упоминается в диалоге.
  [swipe 1/1 · 15 tok · 7.5s · end]   /r swipe  /c continue  /e edit
you   › /trace
trace of ba71143c · ollama:magmell-16k:latest
  window 16384 · reserve 300 · prompt ~9869 tok (server: 10377) · 47 messages sent
  trimmed: 9d814a28 … cf29ee8e · prefill: none
  unknown macros: none
  lore: nothing fired · budget 4021 tok
  calls: narrator ollama:magmell-16k:latest 7.1s
  rounds: 1 · prompted tools · ended: answer · tool room 0 of 4021 tok used
you   › /quit
```

```
you   › /r
Марфа › По словам Марфы, её брата звали Гордей..FLAG{tool_call}{
  [swipe 2/2 · 19 tok · 1.0s · end]   /r swipe  /c continue  /e edit
you   › /trace
trace of 839db64f · ollama:magmell-16k:latest
  window 16384 · reserve 300 · prompt ~9869 tok (server: 10377) · 47 messages sent
  trimmed: 9d814a28 … cf29ee8e · prefill: none
  unknown macros: none
  lore: nothing fired · budget 4021 tok
  calls: narrator ollama:magmell-16k:latest 0.6s
  rounds: 1 · prompted tools · ended: answer · tool room 0 of 4021 tok used
you   › /quit
```

The last try ran under `--provider record:` so its raw stream could be read afterwards:

```
you   › /r
Марфа › Название: Марфа
По словам трактирщицы в рассказе её брата звали Гордей./cm: "Свёкор мой Гордей". ( Marpha's story )
  [swipe 3/3 · 41 tok · 1.4s · end]   /r swipe  /c continue  /e edit
you   › /trace
trace of adb4aac7 · ollama:magmell-16k:latest
  window 16384 · reserve 300 · prompt ~9869 tok (server: 10377) · 47 messages sent
  trimmed: 9d814a28 … cf29ee8e · prefill: none
  unknown macros: none
  lore: nothing fired · budget 4021 tok
  calls: narrator ollama:magmell-16k:latest 1.0s
  rounds: 1 · prompted tools · ended: answer · tool room 0 of 4021 tok used
you   › /quit
```

`trimmed: 9d814a28 … cf29ee8e` is #2–#161. Гордей is Марфа's late husband, named in the card's
description and in the visible chat: the model took the one name it could see. The recording shows
the raw text exactly as stored (no tool markup was held back by the stripper, nothing reached
`<tool_result`): the model never opened a `<tool_call>`. «FLAG{tool_call}{» in swipe 2 is the closest
it came, and it is not a call in any dialect rp-core reads.

Then the search and the note, with no model call:

```
you   › /search брат
#201 Марфа: Название: Марфа По словам трактирщицы в рассказе её брата звали Гордей./cm: "Свёкор мой Гордей". ( Marpha's story )
#200 Елисей: как, по словам трактирщицы, звали её брата? (in context)
#5 Марфа: …рфа фыркнула и поставила перед гостем миску дымящихся щей. «Одна? Куда там. Трактир я держу на пару с младшим братом — его зовут Тихон, да только он уже третью неделю торгует на ярмарке в Велеграде, и когда воротится, одному б…
you   › /memory add Брат трактирщицы | брат | Её младшего брата зовут Тихон.
note C1 "Брат трактирщицы" added (note:брат трактирщицы): from the next turn it is sent when брат comes up
you   › /memory
notes on this path: 1 live (/memory show <ref> prints one)
  C1  Брат трактирщицы — Её младшего брата зовут Тихон. · keys: брат
you   › /lore test А где сейчас её брата искать?
lore test: a reply to your text (nothing is sent)
  ✓ "Брат трактирщицы" @notes:note:брат трактирщицы · key · keys: брат · 22 tok
1 of 1 fired · 22 tok of lore · 25 of 4021 budget tok (counts ×1.12 for this model)
you   › /search брат before=5
no messages before #5 match
you   › /search "младшим братом"
#5 Марфа: Марфа фыркнула и поставила перед гостем миску дымящихся щей. «Одна? Куда там. Трактир я держу на пару с младшим братом — его зовут Тихон, да только он уже третью неделю торгует на ярмарке в Велеграде, и когда воротится, одному б…
you   › /quit
```

The search the model would have run finds #5 by stem («брат» → «братом»), marks it as outside the
context, and the snippet holds the name. The note fires on «брата» (stem match, depth 4, src
`compendium`; the depth placement is asserted in the deterministic test). `×1.12` is the EMA
correction learned from Ollama's counts (10 377 tokens for a 9 869-token estimate; it starts at ×1.15).

## 3. The one try of gemma4:26b (native tools)

A second session seeded the same way, bound to `ollama:gemma4:26b` (`s_9d814a28`). With the server's
4096 window the request holds the system run, the core block (142 tok: native transport, so the
protocol only), the greeting and the question; the two tool declarations go natively (`tools`,
`tool_choice: "auto"` in the body).

```
session s_9d814a28 · Сонный гусь · narrator ollama:gemma4:26b (tools: native) · ctx 4096
Марфа › Марфа отложила вязание и посмотрела на него долгим, тёплым взглядом. …
  [swipe 1/1 · 8.0s · end]   /r swipe  /c continue  /e edit
you   › как, по словам трактирщицы, звали её брата?
  ⋯ thinking (841 chars)
Марфа › В предоставленном тексте не упоминается имя брата Марфы. Упоминается только её покойный муж — Гордей.
  [swipe 1/1 · 260 tok · 210.1s · end]   /r swipe  /c continue  /e edit
you   › /trace
trace of 6ab71e15 · ollama:gemma4:26b
  window 4096 · reserve 300 · prompt ~2173 tok (server: 2152) · 9 messages sent
  trimmed: c08647f1 … d73365a3 · prefill: none
  unknown macros: none
  lore: nothing fired · budget 949 tok
  calls: narrator ollama:gemma4:26b 209.7s
  rounds: 1 · native tools · ended: answer · tool room 0 of 949 tok used
you   › /quit
```

Its thinking (recorded; Ollama streams it as `delta.reasoning`, stored as a raw reasoning block)
lists what the card and the visible messages say about Марфа's family and concludes "The text does
not mention a brother for Marfa"; it never weighs the tools. At least it did not invent a name.
`trimmed` is #2–#199: the whole chat but the greeting and the question.

## 4. `rp-core probe ollama:magmell-16k:latest --active`

```
ollama  http://127.0.0.1:11434  server: ollama
  models (25):
    chargen2:latest                                    ctx ?
    …
    magmell-16k:latest                                 ctx 16384
    …
  active probes (3 calls):
    stream       ok      answered (finish stop); no reasoning seen; usage in the stream (stream_options sent) (86907 ms)
    tools        not ok  refused: the server refused the request (HTTP 400) (372 ms)
    json_schema  ok      the schema was enforced (486 ms)
    note: this model's template has no tools (ollama show <model> lists its capabilities)
  probe facts: tools prompted · structured json_schema (confirmed by probe)
  to keep them in config.toml instead (the user wins over any probe):
    [caps."ollama:magmell-16k:latest"]
    tools = "prompted"
    structured_output = "json_schema"
  caps of ollama:magmell-16k:latest (with this probe stored):
    context 16384 · max output ? · in flight 1
    tools prompted · tool_choice auto/none · structured json_schema
    prefill assistant-last · mid-system as-user · alternation strict · usage stream_options
    reasoning tags <think> <thinking> <thought> [THINK] ◁think▷ <|begin_of_thought|>
    samplers temperature top_p frequency_penalty presence_penalty seed stop max_tokens
    source host → catalog → probe → user
  not stored: --write keeps this catalog and the probe facts for new turns
(exit 0, 88.8 s)
```

The probe agrees with the config: Ollama refuses native tools for a template without them (HTTP 400
before any output → `tools prompted`), and its `json_schema` grammar is enforced. The stream probe's
86.9 s is a cold reload: gemma4 had evicted Mag-Mell. The tools probe stopped after one call (a refusal
needs no second round), so 3 calls of the allowed 6.

## 5. Timings

TTFT is `gen.ttftMs` from the journal (request sent → first text event).

| step | model | TTFT | total | in tok (cache read) | out tok | finish |
|---|---|---|---|---|---|---|
| the question (model not loaded before) | magmell-16k | 6 837 ms | 7.5 s | 10 377 (0) | 15 | end |
| `/r` | magmell-16k | 234 ms | 1.0 s | 10 377 (10 376) | 19 | end |
| `/r` (recorded) | magmell-16k | 223 ms | 1.4 s | 10 377 (10 376) | 41 | end |
| the question, cold load, 10.8 of 18.5 GB in VRAM | gemma4:26b | 202 372 ms | 210.1 s | 2 152 (0) | 260 (841 chars of thinking) | end |
| probe: stream (cold reload) / tools / json_schema | magmell-16k | — | 86.9 s / 0.37 s / 0.49 s (88.8 s in all) | — | — | — |

- Seeding the 199 messages: 0.86 s (process included). `rp-core preview` one-shot: 0.49 s.
- `/trace`, `/search`, `/memory`, `/lore test` each answered within the driver's 0.7 s quiet window;
  the whole no-model run (seven lines, process start and the quiet waits included) took 5.8 s.
- Mag-Mell loaded and read 10 377 prompt tokens in under 7 s; the swipes reused the whole prefix
  (10 376 cached). gemma4:26b does not fit the 16 GiB card at Q4_K_M and ran partly on the CPU.

## 6. Why no tool was called, and what to change

Both models answered from what they could see, as if the visible chat were all of it:

1. **Nothing in the request says the chat is longer than what is shown.** History tools are offered
   exactly when the history was trimmed (D-92), but the model is not told that #2–#161 exist and are
   hidden. "Search the earlier messages of this chat … a detail you cannot see" reads, to a model that
   believes it sees the whole chat, as nothing to do. gemma4's thinking says it outright: "The text
   does not mention a brother."
2. **The only guidance is in the head**, 9 000 tokens before the question on Mag-Mell, and a 12B
   roleplay finetune follows the character and the last turn far more than a system block that
   early. The core block is there on purpose (it is part of the cached prefix, D-92/C2).
3. The question is out of character ("according to the innkeeper, what was her brother's name?"), so
   Mag-Mell twice answered as a narrator and grabbed the one male name in view (Гордей).

Proposed (recorded for the lead in `.notes/m3-contract-integrate.md`, **not implemented**: it is a
model-facing text and changes `renderCoreBlock`'s contract): when the history tools are offered, the
core block names the hidden range ("Only the end of this chat is shown to you: messages #2–#161 are
not. Anything said there can be found with search_history."), and prompted mode gets a one-line
reminder near the end of the request. Both are deterministic for the same inputs; the range changes
only when the trimming does, which already changes the prefix from the history on. A rerun of this
demo (three tries again) is the test of it. `test/live/m3-ollama.test.ts` still fails on
Mag-Mell by design: it asserts the §15 claim, not today's behaviour. Its plumbing was checked against
a local mock of Ollama's `/v1` (a scripted prompted call, then an answer): it passes there.

Implemented after this run in another form as D-96 (`.notes/m3-decisions.md` K: a gap note right
before the first message sent after the left-out run, and a reminder at depth 0; the core block is
unchanged), then amended for prompted tools (section L). §8 has the reruns.

## 7. Odd things and findings

1. **A snippet can start mid-word.** `/search брат` shows «…рфа фыркнула» (from «Марфа»): the ±110
   window is cut by characters, as RoleCall's was. The phrase search, whose match starts earlier, shows
   the same message from its start. Cosmetic; a word-boundary cut would read better.
2. **`/search` lists the model's own wrong answer** (#201 «…звали Гордей») above #5: it is a message on
   the path like any other. In a chat where a model has hallucinated, a later search finds the
   hallucination first (newest first).
3. **gemma4:26b runs at 4096 on `/v1`** (no num_ctx in its Modelfile; `/api/ps` confirmed the
   default), so the config's `context_length = 4096` was needed; without it rp-core would have
   assumed a larger window and the server would have cut the prompt silently, keeping its newest
   tokens.
4. **Thinking eats the reply budget.** gemma4 spent most of its 260 output tokens thinking; with
   max_tokens 300 a tool call after a longer thought would have been cut. A thinking model in a tool
   loop needs a larger cap (or thinking off, which Ollama's `/v1` offers only through
   `reasoning_effort`, not configured here). The active probe, which then capped every call at 96
   tokens, now gives each call its own cap (`probeMaxTokens` in `src/providers/probe-active.ts`: 96
   for the stream pings, 1 024 for the tool call, 512 for the round with the tool's result and for
   json_schema), lowered to the caps' maxOutput and to the window minus 512 prompt tokens (at least
   16), so a thinking model has room to think before it calls (not exercised here: Mag-Mell does not
   think).
5. **Native declarations now count in the estimate** (an integration fix): `prompt ~2173 tok
   (server: 2152)` on gemma4 includes the two tool declarations (≈ 500 o200k tokens); before the fix
   the estimate would have been about 1 670 and the EMA would have read the declarations as tokenizer
   drift.
6. **`tool_choice: "auto"` goes to Ollama** although its docs list tool_choice as unsupported: the
   caps keep the pessimistic `toolChoice [auto, none]` with `toolChoiceHonored: false`. Ollama ignores
   the field; harmless, but the probe's caps line "tool_choice auto/none" reads as a claim.
7. **«Название: Марфа»** and «/cm: …» in Mag-Mell's third answer are the model's own glitches in
   Russian; stored as is.
8. `gen.reasoningMs` is never written (gemma4's answer had thinking but no reasoningMs) — a gap since
   M1, not M3's.

## 8. Reruns after D-96 and D-97 (27.10.2026)

Every run is the gated live test, `test/live/m3-ollama.test.ts`: the innkeeper-200 chat, the §15
question, `narrator.maxRounds` 2, Ollama 0.34.2 on the same machine. Nothing was pulled, created or
deleted; about 17 model calls in all. The decisions the runs led to are in `.notes/m3-decisions.md`
(L: D-96 amended, D-97; D-96 itself, from the first run, is in K).

### Run A: after D-96 and the review fixes (magmell-16k, prompted, window 16384, max_tokens 300)

- **A1** (cold model): the first try ended `failed` after 61 s. Ollama's journal: model load 54 s
  (02:18:42 → 02:19:36), then `200 | 1m1s POST /v1/chat/completions`, prompt 10 478 tokens. The test
  did not log the turn's failure code then (it now logs the outcome, the notices and the streamed
  text of a failed try); it was not seen again. The core's first-byte limit on a local origin is
  600 s (`FIRST_BYTE_LOCAL_MS`), so it was not a timeout.
- **A2:** the test's new D-96 check expected a message with src `core:gap`; for this model shape
  merges both notes into neighbouring chat messages (`core:gap+history`, `history+core:remind`, shown
  as `[System note] …` inside the user message). The check was wrong, not the core; it now accepts
  merged src.
- **A3:** 3 tries, no tool call:
  1. `<search_history>\nранее в диалоге не упоминалось имени брата Марфы.\n</search_history>\n\nМарфа
     не mentioning her brother's name in the conversation so far. The story doesn't provide this
     detail.` — the tool's name as a tag, a made-up result inside, then prose. rp-core did not read
     that form as a call then, so it was stored as text. → D-97.
  2. «…брат Марфы звался Гордей.» — wrong (Гордей is her late husband, named in the card).
  3. A long answer without a name, drifting into English mid-sentence.

### The raw check: the same first request by hand (3 calls)

The first request of A3, sent to Ollama by hand with the reminder replaced by a prompted variant that
shows the call:

1. `<tool_call>{"name": "search_history", "args": {"query": "брат Марфы, имя"}}` (unclosed, then EOS):
   a well-formed call.
2. «Его звали Гордей.» — no call, wrong.
3. No call; drifted into Italian.

With the D-96 text: 0 calls of 3 (A3). → D-96 amended: the prompted reminder shows the call.

### Run B: after the D-96 amendment and D-97 (magmell-16k, prompted, window 16384, max_tokens 300)

3 tries, no tool call, no markup in the stored text, every invariant held:

1. «Сергей. брат Марфы звали Серёжкой.» (9.0 s, cold start)
2. «Марфа рассказывала про своего брата, которого звали Гордей. …» (1.1 s)
3. «Гордей» (0.2 s)

The request (captured offline against a local mock with the same config) carried the gap note
`[Messages #2–#161 of this chat are not shown here. …]`, merged into the first kept history message,
and the prompted reminder with the `<tool_call>` line, merged into the question as
`[System note] (…)`; the greeting (#1) and #162–#199 were sent, then the question.

### Run C: gemma4:26b, native tools (window 4096, max_tokens 1024)

`RP_CORE_OLLAMA_M3_MODEL=gemma4:26b RP_CORE_OLLAMA_CTX=4096 RP_CORE_OLLAMA_TOOLS=native
RP_CORE_OLLAMA_MAX_TOKENS=1024`. 4096 is Ollama's `/v1` default for this model (no Modelfile alias
exists, and none was created).

The request (captured offline against a local mock with the same config): the system part, 4 016
chars (preset, card, core block); the greeting; one user message = `[System note] [Messages #2–#199
of this chat are not shown here. …]` + the question + `[System note] (Part of this chat is hidden …)`;
`tools: [read_history, search_history]`, `tool_choice: auto`, `max_tokens: 1024`. Estimated 2 270
o200k tokens.

1. 204 s (cold load of the 26B model plus 1 024 tokens): thinking (stored as a reasoning block), then
   «В предоставленном тексте … не упоминается имя брата Марфы. В тексте говорится лишь о её покойном
   муже Гордее.» — no call. Its reasoning quotes the gap note and says: "Is it a test of the
   `search_history` tool? I don't have access to any history other than what's presented in the
   prompt … But I have no history to search."
2. `failed`, code `reasoning_only` (D-31): the thinking used all 1 024 tokens; the test stops at a
   failed try.

The direct check (1 call): gemma4:26b with a 97-token prompt (system "You can look things up in the
earlier chat with the search_history tool.", user "Earlier in this chat I told you my sister's name.
What was it? Look it up.") and one tool → `finish_reason: tool_calls`, `search_history
{"query":"sister"}`. Native tool calls work through Ollama's `/v1` for this model; in the full
roleplay prompt it decides not to look.

### What this shows

- The core sends what the design says: the gap note with the right range, the reminder (with the call
  line on prompted tools), the schemas natively, `tool_choice: auto`. The deterministic demos
  (`test/demo-m3/innkeeper.test.ts`, `review-fixes.test.ts`, `live-fixes.test.ts`) prove the loop end
  to end, including the live model's own tag output over the real openai-chat wire.
- The §15 demo claim (a `search_history` call and «Тихон») is **not met** on the two local models
  tried: a 12B roleplay finetune without tool training (Mag-Mell, prompted) and a 26B thinking model
  (gemma4, native, 4096 window). Both answer from the visible part, and often invent a name.
- Not tried: a cloud model with tool training (DeepSeek, OpenRouter). It costs money and needs the
  user's go-ahead.
- The path that does not depend on the model's judgment is recall before the answer (M5, D-1, D-78:
  prefetch on a local origin). Thinking models on Ollama also need a larger reply reserve, or a way
  to turn thinking off.

## The same demo without a model

`test/demo-m3/innkeeper.test.ts` runs §15 deterministically on a scripted connection with the same
caps (prompted tools, 16 384 window): request 0 has the core block with the history tools and the
prompted stop, the early chat trimmed (#5 included); round 0 writes
`<tool_call>{"name": "search_history", "args": {"query": "брат"}}</tool_call>`; request 1 carries the
round and ONE results message whose #5 line holds «братом» and «Тихон» (not in context); round 1
names Тихон; the stored message is `tool_call, tool_result, text` with `gen.transport 'prompted'`,
`gen.rounds 2`, `trace.tools` and `trace.rounds`; then `memoryAdd` and a preview of «А где сейчас её
брата искать?» fire the note at depth 4 (src `compendium:@notes:note:брат трактирщицы`), and
`SessionHandle.search('брат')` finds #5. `test/demo-m3/fixture.test.ts` checks the chat itself (one
mention, sizes, the generator, the seeding).

## How to rerun

```bash
alias rp-core='bun src/cli/main.ts'
H=$(mktemp -d)
printf '[connections.ollama]\nbase_url = "http://127.0.0.1:11434"\n\n[caps."ollama:magmell-16k:latest"]\ncontext_length = 16384\ntools = "prompted"\n' > $H/config.toml
bun tools/fixtures/seed-innkeeper.ts --home $H --model ollama:magmell-16k:latest --max-tokens 300 --max-rounds 2   # as §1; prints the session id
id=s_…                        # the id it printed
printf 'как, по словам трактирщицы, звали её брата?\n/trace\n/search брат\n/memory add Брат трактирщицы | брат | Её младшего брата зовут Тихон.\n/memory\n/lore test А где сейчас её брата искать?\n/quit\n' | rp-core --home $H chat $id
rp-core --home $H probe ollama:magmell-16k:latest --active
# the gated live test (up to 3 tries × 3 calls):
RP_CORE_LIVE=1 bun test test/live/m3-ollama.test.ts
# the same on gemma4:26b with native tools (§8, run C):
RP_CORE_LIVE=1 RP_CORE_OLLAMA_M3_MODEL=gemma4:26b RP_CORE_OLLAMA_CTX=4096 RP_CORE_OLLAMA_TOOLS=native \
  RP_CORE_OLLAMA_MAX_TOKENS=1024 bun test test/live/m3-ollama.test.ts
```

### On a hosted model

No hosted model has been tried yet. Both ways below run the same chat and question; they differ in
what you see. The key stays in your shell: `config.toml` and the test only name the variable.

**The test** (one command; a verdict and a JSON transcript with the answers, the lookups and the
usage, with the cost when the API reports it):

```bash
export OPENROUTER_API_KEY=…   # or DEEPSEEK_API_KEY for api.deepseek.com
RP_CORE_LIVE=1 RP_CORE_CLOUD_URL=https://openrouter.ai/api RP_CORE_CLOUD_MODEL=<model id> \
  RP_CORE_CLOUD_KEY_ENV=OPENROUTER_API_KEY bun test test/live/m3-cloud.test.ts
```

- **First, the model list** (a free GET), as `rp-core probe --write` reads it: OpenRouter's facts
  about the model (tools, `tool_choice`, reasoning) are used, a refused key stops the run before any
  paid call, and an id the list lacks is reported with close ones.
- **What it costs:** at most 9 answered calls (3 tries × 3 rounds; it stops at the first try that
  searched and named Тихон). Each prompt stays under the window minus the reply reserve: 12 288
  tokens with the defaults (window 16 384, reserve 4 096). A request the server refuses with 429 or
  5xx is retried once; refused requests are usually not billed.
- **Thinking models:** the reserve (`RP_CORE_CLOUD_MAX_TOKENS`, default 4096) holds the thinking
  too; a try whose thinking uses all of it fails `reasoning_only` and stops the test. The test as a
  whole has 30 minutes (`RP_CORE_CLOUD_TIMEOUT_MS`); each try is logged as it ends.
- **DeepSeek's own API:** `RP_CORE_CLOUD_URL=https://api.deepseek.com/beta`,
  `RP_CORE_CLOUD_KEY_ENV=DEEPSEEK_API_KEY`, a model id from its list. There (not through
  OpenRouter) a thinking model with tools gets every earlier answer back with a one-space
  placeholder for the reasoning it never had (D-94); this is that rule's first live check.

**By hand in the chat** (what the narrator looks up, as it happens):

```bash
H=~/rp-m3-cloud; mkdir -p $H
cat > $H/config.toml <<'TOML'
[connections.openrouter]
base_url = "https://openrouter.ai/api"
key_env = "OPENROUTER_API_KEY"

# The catalog (probe --write below) gives the model's own window, which holds the whole
# 40k-token chat: nothing would be trimmed and no history tools offered. 16384 keeps the demo
# a search, as the test runs it; this table wins over the catalog.
[caps."openrouter:<model id>"]
context_length = 16384
TOML
rp-core --home $H probe openrouter --write     # free: the model list, with tools and tool_choice
bun tools/fixtures/seed-innkeeper.ts --home $H --model openrouter:<model id> --max-tokens 4096
rp-core --home $H preview <session> --draft "как, по словам трактирщицы, звали её брата?"   # free: the request, not sent
rp-core --home $H chat <session>
```

The banner should say `(tools: native)`. Without `probe --write` rp-core knows nothing of the model's
tools on OpenRouter and offers them prompted (add `tools = "native"` to the table instead), and it
assumes that OpenRouter ignores `tool_choice`, so a final round goes without the tool schemas; an
Anthropic model behind OpenRouter may refuse that. In the chat, ask «как, по словам трактирщицы,
звали её брата?». A lookup shows as `⋯ search_history "брат" → 2 hits` (#5 and your own question),
`/trace` lists the rounds and the tokens, and `/r` asks again.
`rp-core --home $H probe openrouter:<model id> --active` (at most 6 short calls) says first whether
the model calls tools at all.
