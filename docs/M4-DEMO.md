# M4 demo — the Story Director

Milestone M4 ("Story Director", ARCHITECTURE.md §15) ends with a demo of five claims: after 30 turns
`/director show` holds chapters, arcs with their next beat, seeds and hidden arcs; a swipe reuses the
plan and `/regen <direction>` plans again; a rollback brings back the earlier state; a broken plan on
a small model gives `director: failed (undecodable)` and the answer still arrives; a scripted
300-turn run keeps the state under its cap. This is that demo: four deterministic demos (five tests) on
the scripted model (§1), then two live runs on the user's own Ollama on 2026-10-27 (§2, §3).

**Result in one line: all five claims pass in the deterministic demos; live, Mag-Mell 12B planned
every Director turn of the second run on the first try, reused the plan on a swipe and planned again
on `/regen`, but made no arcs in 4 turns and let one answer drift into English.** The first live run
found two faults, fixed as D-119 and D-120 (§4).

The deterministic demos run the real engine: `runDirector`, the plan reader, the reducer,
`fitState`, the journal and the fold. Only the model's answers are scripted. The live runs used the
same Mag-Mell model as narrator and Director; only the second ran with the fixes.

Environment: Bun 1.3.14 (`0d9b296a`), Linux 7.0.0-38-generic (x86_64), Ollama 0.34.2 on
http://127.0.0.1:11434, NVIDIA RTX 4070 Ti SUPER (16 GiB). After the fixes: `bun test` 4254 pass,
3 skip (the live tests), 0 fail, 199 files; `bunx tsc --noEmit -p .` clean. The M4 test folders
(`test/director`, `test/structured`, `test/engine-m4`, `test/demo-m4`, `test/cli-m4`,
`test/repl/m4-*`) hold 920 of those tests in 34 files.

## What the demo shows

| §15 demo point | Deterministic (§1) | Live, Mag-Mell 12B (§2, §3) |
|---|---|---|
| After 30 turns: chapters, arcs with their next beat, seeds, hidden arcs | `thirty-turns.test.ts`: 2 chapters (1 completed), 4 arcs (3 with a pending next beat, 1 complete), 4 seeds (1 paid off), 2 hidden arcs with 3 and 1 clues | 4 turns only: chapter 1, one seed, two intentions a turn; no arcs; no hidden arcs (lite does not ask for them) |
| A swipe reuses the plan; `/regen <direction>` plans again | `swipes.test.ts`: `reused`, no Director call, the same directive sent; `/regen` plans from the state before the answer, with the direction in the prompt | Run 2: `/r` → `reused — no changes`, no Director call; `/regen …` → a new plan with new intentions |
| A rollback brings back the earlier state | `swipes.test.ts`: back on the `/regen` answer, the state is that answer's; the next plan grows from it, and the hidden arc of the other branch is gone | Both runs: `/rewind 5` → `/director show` shows turn 2's state again |
| A broken plan on a small model: `failed (undecodable)`, the answer arrives | `swipes.test.ts`: lite on an 8 192 window, two cut-off plans → `failed (undecodable)`; the answer arrives with the contract and no directive | Run 1 (before D-119): 4 of 6 plans `failed (undecodable)`, cut at 300 tokens; every answer arrived |
| A scripted 300-turn run keeps the state under the cap | `three-hundred.test.ts`: two verbose Russian planners, largest state 20 081 and 32 552 bytes, none over 32 768 | not live |

## 1. The deterministic demos (`bun test test/demo-m4`)

All four run on the scripted provider with a Russian card (Марфа, the innkeeper) and persona
(Елисей). Each Director call is one scripted answer with a `<plan>{…}</plan>` block (tagged), each
narrator call one short reply. They print what they did; the excerpts below are their real output
(`bun test test/demo-m4`: 5 pass, 0 fail, 687 `expect()` calls, 6.43 s).

### 30 turns (`thirty-turns.test.ts`)

Thirty user messages, thirty plans, thirty answers. The scripted model has an 8 192-token window, so
`auto` runs lite. The plans carry hidden-arc updates anyway, and the reader keeps what it is sent.
The planner starts chapter 1 on turn 1 and chapter 2 on turn 15, adds arcs on turns 1, 3, 6 and 12,
moves them on with a new stage and a new next beat, completes one on turn 20, plants seeds on turns
2, 7, 14 and 25, reinforces them, pays one off on turn 18, and adds two hidden arcs with clues.

The test asserts:

- every turn ends `done` and every Director line says `planned`; the script is used up;
- the record at the head is `ok` and is turn 30;
- the chapters are `[1, "Трактир на перекрёстке", complete]` and `[2, "Дорога к мельнице",
  concluding]`, and the current one is `chapter-2`;
- the four arcs by title; «Пропавший брат» is `climax` with the pending next beat «Голос Тихона
  из-за двери подвала.» and the stages «Марфа видела Тихона», «След у брода», «Нож Тихона»,
  «Лодочник»; «Чужаки на тракте» is `complete`; at least 3 arcs have a pending next beat;
- «Ржавый ключ под половицей» is paid off on turn 18 with 2 reinforcements; «Ворон на коньке крыши»
  was planted on turn 25 and is still waiting; 3 seeds wait;
- «Гильдия перевозчиков» is `approaching_player` with clues from turns 10, 17 and 26; «Староста ведёт
  двойную игру» has one clue;
- the stored state is at most 32 768 bytes (UTF-8).

The event lines (as the chat prints them) and the state at the head, in the order `/director show`
lists it (the test's own dump, `test/demo-m4/kit.ts`):

```
 1 ⋯ director: planned — arcs +1 · chapter 1
 2 ⋯ director: planned — seeds +1
 3 ⋯ director: planned — arcs +1
 4 ⋯ director: planned — arcs ~1 · hidden +1
 5 ⋯ director: planned — seeds ~1
 …
15 ⋯ director: planned — arcs ~1 · chapter 2
 …
18 ⋯ director: planned — seeds -1
 …
20 ⋯ director: planned — arcs ~1 · seeds ~1
 …
27 ⋯ director: planned — no changes
 …
30 ⋯ director: planned — seeds ~1

Director turn 30 · last result: planned
Chapter: 2. Дорога к мельнице (concluding) · completed: 1
Arcs:
  [arc-1] Пропавший брат — climax, active, long, age 29
      next beat (pending): Голос Тихона из-за двери подвала.
  [arc-3] Долг трактирщицы — building, background, medium, age 27
      next beat (pending): Марфа отдаёт Елисею фонарь мужа.
  [arc-5] Чужаки на тракте — complete, active, short, age 24
      next beat (delivered): Один из всадников узнаёт нож.
  [arc-7] Тайна старой мельницы — climax, active, medium, age 18
      next beat (pending): Жернова останавливаются, когда входит Елисей.
Seeds:
  [seed-2] Ржавый ключ под половицей — age 28, reinforced 2, paid off
  [seed-6] Песня, которую никто не помнит — age 23, reinforced 1
  [seed-9] Сломанная печать на письме — age 16, reinforced 1
  [seed-10] Ворон на коньке крыши — age 5, reinforced 1
Hidden arcs:
  [hidden-4] Гильдия перевозчиков — approaching_player; clues: На лодке у брода — клеймо гильдии. | Лодочник отводит глаза при слове «мельница». | Ночью у мельницы причаливает лодка без фонаря.
  [hidden-8] Староста ведёт двойную игру — seeding; clues: Староста знает о ноже раньше, чем ему сказали.
Intentions: [should] Постепенно раскрыть, где Тихон
```

Turn 27 only moved the chapter to `concluding`, which the summary does not count, so it reads
`no changes`. The REPL's own `/director show` is tested in `test/repl/m4-render.test.ts` and
`m4-flows.test.ts` on hand-written records, and was run live (§2, §3).

### Swipe, `/regen` and rollback (`swipes.test.ts`, first test)

One question, a swipe, a guided swipe (`/regen` with «Пусть Марфа будет помягче.»), a second
question, then the head goes back to the `/regen` answer (the engine's `select`, which `/rewind`
uses) and a third question. The test asserts:

- **Swipe:** the line says `⋯ director: reused`; the swipe's record has `reusedFrom` = the first
  answer, no attempts, the same directive and state; the narrator got the same directive message.
- **`/regen`:** a new plan, not a reuse: its directive's mood is «тихий», it is turn 1 again (planned
  from the state before the answer), and its arc has the stage «Чай и разговор». 4 Director requests
  in all (the swipe made none), and the `/regen` request holds the direction text.
- **The second answer** grew from the `/regen` version: turn 2, the hidden arc «Гильдия
  перевозчиков», the stages «Чай и разговор», «Слух о мельнице».
- **Rollback:** after `select`, the state at the head equals the `/regen` record's state. The next
  plan is turn 2 again, has no hidden arcs, and its arcs are «Пропавший брат» and «Ночные гости».

```
reply              ⋯ director: planned — arcs +1 · seeds +1 · chapter 1
swipe              ⋯ director: reused — arcs +1 · seeds +1 · chapter 1
/regen помягче     ⋯ director: planned — arcs +1 · chapter 1
reply              ⋯ director: planned — arcs ~1 · hidden +1
reply after rollback ⋯ director: planned — arcs +1

at the second answer:
Director turn 2 · last result: planned
Chapter: 1. The Story Begins (active) · completed: 0
Arcs:
  [arc-1] Пропавший брат — building, background, medium, age 1
      next beat (pending): Ночью скрипят жернова.
Seeds:
Hidden arcs:
  [hidden-2] Гильдия перевозчиков — seeding; clues: —
Intentions: —

after the rollback:
Director turn 2 · last result: none
Chapter: 1. The Story Begins (active) · completed: 0
Arcs:
  [arc-1] Пропавший брат — seeding, background, medium, age 1
      next beat (pending): Марфа сама заговорит о Тихоне.
  [arc-2] Ночные гости — seeding, background, medium, age 0
Seeds:
Hidden arcs:
Intentions: —
```

The summaries compare each plan with the state it started from: the swipe and the `/regen` both
start from the empty state before the first answer, so they count the arc and the chapter as new.

### A broken plan on a small model (`swipes.test.ts`, second test)

The scripted model has an 8 192-token window, so `auto` runs lite. Its script
(`test/fixtures/scripts/director-broken.jsonl`) answers the Director twice with a `<plan>` cut off
at `finish: length`, then gives the narrator's reply. The test asserts:

- the only line is `⋯ director: failed (undecodable)`;
- the record is `{ok: false, code: 'undecodable', profile: 'lite', transport: 'tagged', turn: 1}`;
- the first Director request asks for 1 500 tokens; the correction asks for fewer, by as much as its
  prompt grew (prompt + `max_tokens` is not larger than the first request's), D-121;
- the Director's prompt has no "Shadow World" section (lite);
- the answer arrives («The lamp gutters, and the reply still arrives.»); the narrator got the
  contract (`core:director`) and no directive.

```
reply              ⋯ director: failed (undecodable)
```

### 300 verbose Russian turns (`three-hundred.test.ts`)

A 300-turn run on a 32 768-token window, run twice. The planner writes every text close to its
300-character limit in Cyrillic (2 bytes a character), adds two arcs and two seeds every turn and a
hidden arc every other turn, moves older ones on, and sends ten intentions. The `max` planner also fills every
directive list to its limit; the `usual` one sends a directive of an ordinary size. The test asserts
that no turn failed, that all 300 records read back and are `ok`, that the last is turn 300, and
that the largest stored state is at most 32 768 bytes. It prints:

```
300 verbose Russian turns (directive max): state bytes median 19946, max 20081, over 32768: 0, within the typical 16384: 4; the last record: 8 arcs, 10 seeds, 4 hidden arcs; fit steps used: fit:descriptions ×300, fit:texts ×300, fit:last-directive ×300, fit:completed-0 ×295; self-audits kept: 0

300 verbose Russian turns (directive usual): state bytes median 23784, max 32552, over 32768: 0, within the typical 16384: 0; the last record: 8 arcs, 10 seeds, 4 hidden arcs; fit steps used: fit:descriptions ×297, fit:completed-0 ×295, fit:texts ×153; self-audits kept: 300
```

With the `max` directive, the authored directive alone is over the cap, so `fitState`'s last step
drops it every turn, and the next turn has no self-audit. With the `usual` one every record keeps its
last directive, so the self-audit can run. Both runs end with the working sets cut to 8 arcs, 10
seeds and 4 hidden arcs (D-116). Hardly any state fits the 16 KB "typical" size: 4 of 300 with the
`max` directive, none with the `usual` one.

## 2. Live run 1: before the fixes

Setup (both runs): a scratch home with this `config.toml` (`magmell-16k:latest` is the user's
Modelfile alias of Mag-Mell R1 12B with `num_ctx 16384`), so the Director follows the narrator:

```toml
[connections.ollama]
base_url = "http://127.0.0.1:11434"

[caps."ollama:magmell-16k:latest"]
context_length = 16384
tools = "prompted"

[roles]
narrator = "ollama:magmell-16k:latest"

[director]
enabled = true
```

The session came from the M3 innkeeper fixture's card and persona, with a 300-token reply limit:
`rp-core new --card test/fixtures/ru/innkeeper-200/card.json --persona
test/fixtures/ru/innkeeper-200/persona.json --model ollama:magmell-16k:latest --max-tokens 300`
(greeting only). A script was piped into `rp-core chat`: four Russian messages (a room for the night;
the bridge at Горелая балка; who comes here, the hunter stares; pour me something hot), `/director
show`, `/r`, `/director show`, `/regen пусть охотник сам подойдёт к столу и заговорит первым`,
`/director show`, `/trace`, `/rewind 5`, `/director show`, `/quit`. The window is 16 384, below
24 576, so `auto` ran lite; nothing confirmed structured output for this model, so it ran tagged.
Nothing was pulled, created or deleted on the server.

The log (ANSI codes stripped, answers cut):

```
session s_ff83d154 · Марфа · narrator ollama:magmell-16k:latest (tools: prompted) · director ollama:magmell-16k:latest (auto) · ctx 16384
…
you   › Добрый вечер. Найдётся ли у вас комната на ночь? Я землемер, иду в Велеград.
  ⋯ director: planned — seeds +1 · chapter 1
…
  [swipe 1/1 · 300 tok · 125.0s · length]   /r swipe  /c continue  /e edit
you   › А что за шум был на дороге? Говорят, мост в Горелой балке совсем плох.
  ⋯ director: planned — no changes
Марфа › Марфа расставила миски с ароматным куриным бульоном и горячим хлебом перед Елисеем. "О, это верно, — said she, her brow furrowing slightly. …
…
you   › Расскажите, кто у вас тут бывает. Кажется, вон тот охотник на меня косится.
  ⋯ director: failed (undecodable)
…
you   › /director show
director on · ollama:magmell-16k:latest (the narrator's model) · profile auto · style the-balanced
turn 4 · failed (undecodable) on 917cfcf0 · tagged · lite · ollama:magmell-16k:latest
chapter 1 "The Story Begins" · active · 3 turns
arcs: none
seeds: 1 waiting
  seed-1 "The Goose's Whispered Secret" · medium · age 3/5 · 0 reinforcements
hidden arcs: none
last directive (turn 2) mood "warm and inviting" · goal "Show Marfa taking care of Елиsey's imme…" · setting "The common room of 'Sleeping …" · tension 2/10 · 1 character beat · hook "The aroma of hot, freshly baked bread f…"
…
you   › /trace
trace of 7d721e3b · ollama:magmell-16k:latest
  window 16384 · reserve 300 · prompt ~3330 tok (server: 3517) · 15 messages sent
  …
  calls: director ollama:magmell-16k:latest 6.4s, director ollama:magmell-16k:latest 5.6s, narrator ollama:magmell-16k:latest 4.8s
you   › /rewind 5
…
you   › /director show
director on · ollama:magmell-16k:latest (the narrator's model) · profile auto · style the-balanced
turn 2 · planned on 0c6f3ee8 · tagged · lite · ollama:magmell-16k:latest · 1 skipped
chapter 1 "The Story Begins" · active · 1 turn
…
```

The `last directive` line above is the one-line summary `/director show` printed on that day. Today
it prints intentions and next beats uncut, and the whole `[DIRECTOR CONSTRAINTS - BINDING THIS TURN]` … `[/DIRECTOR CONSTRAINTS]` block, as
the narrator got it (D-139; README, [/director show](../README.md#director-show)). Run on this
session's journal today, the first `/director show` above heads it `last directive (turn 2, as sent
on 0c6f3ee8; turn 4 sent none):` and prints turn 2's block below.

What the session journal recorded for each answer (Director attempts: outcome, seconds, finish,
output tokens):

| Answer | Director | Attempts | Narrator call |
|---|---|---|---|
| 1 | planned | ok, 117.6 s (model loading), end, 177 | 6.8 s |
| 2 | planned | undecodable, 6.5 s, length, 300 → ok, 4.2 s, end, 218 | 6.0 s |
| 3 | failed (undecodable) | undecodable, 6.6 s, length, 300 → undecodable, 5.7 s, length, 300 | 5.9 s |
| 4 | failed (undecodable) | undecodable, 6.5 s, length, 300 → undecodable, 5.5 s, length, 300 | 6.2 s |
| `/r` | failed (undecodable) | undecodable, 5.8 s, length, 300 → undecodable, 5.7 s, length, 300 | 5.8 s |
| `/regen …` | failed (undecodable) | undecodable, 6.4 s, length, 300 → undecodable, 5.6 s, length, 300 | 4.8 s |

17 model calls in all: 11 for the Director, 6 for the narrator. What it showed:

- **Every plan that failed was cut at exactly 300 tokens**, on both attempts. 300 is the narrator's
  reply limit (`--max-tokens 300`), and the Director took it because it followed the narrator's
  binding whole. → D-119.
- **The answers arrived every time**, without a directive when the plan failed.
- **The failed turns still counted:** after the failures, `/director show` showed the turn-2 plan
  (its last directive is turn 2's) with the Director at turn 4 (the seed's age 3/5).
- **The swipe did not reuse** a plan, because the replaced answer's plan had failed; it planned again
  and failed again (D-104).
- **Rollback works:** after `/rewind 5`, `/director show` showed turn 2's state.
- **`/trace`** listed the calls per agent.
- **Language drift:** three of the six answers (the 2nd, the 4th and the `/regen`) mixed whole
  English sentences into the Russian story; the first was all Russian. The directive and the contract
  are in English, and the contract is sent even when a plan fails. → D-120.

## 3. Live run 2: after the fixes

The same config, a new scratch home, the same `rp-core new` command and the same piped script, after
the review fixes (§4). Session `s_0d042d8c`.

```
session s_0d042d8c · Марфа · narrator ollama:magmell-16k:latest (tools: prompted) · director ollama:magmell-16k:latest (auto) · ctx 16384
…
you   › Добрый вечер. Найдётся ли у вас комната на ночь? Я землемер, иду в Велеград.
  ⋯ director: planned — seeds +1 · chapter 1
Марфа › Марфа кивнула, слушая ответ Елисея, и ее лицо смягчилось в дружелюбной улыбке. …
  [swipe 1/1 · 300 tok · 116.6s · length]   /r swipe  /c continue  /e edit
you   › А что за шум был на дороге? Говорят, мост в Горелой балке совсем плох.
  ⋯ director: planned — no changes
…
  [swipe 1/1 · 300 tok · 13.3s · length]   /r swipe  /c continue  /e edit
…
you   › /r
  ⋯ director: reused — no changes
…
  [swipe 2/2 · 300 tok · 5.1s · length]   /r swipe  /c continue  /e edit
you   › /director show
director on · ollama:magmell-16k:latest (the narrator's model) · profile auto · style the-balanced
turn 4 · reused (the plan of 6af484fb) on ec1d83c4 · tagged · lite · ollama:magmell-16k:latest
chapter 1 "A Warm Welcome" · active · 3 turns
arcs: none
seeds: 1 waiting
  seed-1 "The old map" · long · age 3/10 · 0 reinforcements
hidden arcs: none
intentions:
  must · next: Demonstrate Marfa's hospitality and care for Elisey's wellbeing by offering a safe, alternative pat…
  should · eventually: Plant the idea of a hidden, potentially secret route that could factor into Elisey's journey, hinti…
last directive (turn 4, as sent) mood "warm and inviting" · goal "Establish Marfa as a knowledgeable and …" · setting "A cozy, dimly-lit inn room wi…" · tension 3/10 · 1 arc direction · 1 character beat · hook "Marfa leans in closer, her voice barely…"
you   › /regen пусть охотник сам подойдёт к столу и заговорит первым
  ⋯ director: planned — no changes
Марфа › … Тот не стал отказываться, и soon the three of them were settled around the table, …
  [swipe 3/3 · 300 tok · 13.2s · length]   /r swipe  /c continue  /e edit
you   › /director show
…
intentions:
  must · next: Establish Marfa as a knowledgeable and caring host
  should · soon: Introduce the idea of a secret route
…
you   › /trace
trace of 8652b34e · ollama:magmell-16k:latest
  window 16384 · reserve 300 · prompt ~3584 tok (server: 3810) · 15 messages sent
  trimmed: nothing · prefill: none
  unknown macros: none
  lore: nothing fired · budget 4021 tok
  calls: director ollama:magmell-16k:latest 7.6s, narrator ollama:magmell-16k:latest 5.6s
you   › /rewind 5
…
you   › /director show
director on · ollama:magmell-16k:latest (the narrator's model) · profile auto · style the-balanced
turn 2 · planned on cc5f387c · tagged · lite · ollama:magmell-16k:latest
chapter 1 "A Warm Welcome" · active · 1 turn
arcs: none
seeds: 1 waiting
  seed-1 "The old map" · long · age 1/10 · 0 reinforcements
…
```

As in run 1, the `last directive` line is that day's summary. Today's `/director show` prints the
whole block there, under `last directive (turn 4, reused from 6af484fb, as sent):`; the README's
[/director show](../README.md#director-show) shows the same block, printed from this run's journal.

From the session journal:

| Answer | Director | Attempt (seconds, finish, output tokens) | Narrator call | Status line |
|---|---|---|---|---|
| 1 | planned — seeds +1 · chapter 1 | 110.0 s (model loading), end, 415 | 6.1 s | 116.6 s |
| 2 | planned — no changes | 7.9 s, end, 425 | 5.4 s | 13.3 s |
| 3 | planned — no changes | 8.2 s, end, 434 | 5.4 s | 13.6 s |
| 4 | planned — no changes | 8.8 s, end, 460 | 5.5 s | 14.3 s |
| `/r` | reused — no changes | no call | 5.1 s | 5.1 s |
| `/regen …` | planned — no changes | 7.6 s, end, 404 | 5.6 s | 13.2 s |

11 model calls in all: 5 for the Director, 6 for the narrator. What it showed:

- **Every plan was read on the first attempt**, with no correction pass. The plans were 404–460
  tokens long, under the lite limit of 1 500.
- **The Director adds about 8 s per answer** once the model is loaded: 7.6–8.8 s here, on top of a
  narrator call of 5.1–6.1 s.
- **Swipe reuse:** `/r` made no Director call. Its record has `reusedFrom` = the replaced answer
  `6af484fb`, and `/director show` says `reused (the plan of 6af484fb)`.
- **`/regen`** planned again (a swipe with a direction never reuses). Its intentions changed.
- **Rollback:** after `/rewind 5`, `/director show` showed turn 2's state (chapter age 1, seed age
  1/10).
- **What the model planned:** chapter 1 "A Warm Welcome", one seed ("The old map", horizon long), two
  intentions a turn, and a directive with mood "warm and inviting", a setting, tension 2–3 of 10 and
  an ending hook; one character beat from turn 2 on, one arc direction only on turn 4 and the
  `/regen`. It created **no arcs** in 4 turns; the arc direction of turn 4 named an arc that is not
  in its state («Marfa's Concern for Travelers»). No hidden arcs: lite does not ask for them.
- **`no changes`:** turns 2–4 changed only the intentions and the directive, which the summary does
  not count.
- **Language:** 5 of 6 answers stayed in Russian. The `/regen` answer switched to English in the
  middle («…и soon the three of them were settled around the table…») and stayed there. D-120
  helps; it does not cure a 12B model.

## 4. What was found and fixed

**D-119: "follows the narrator" means the same connection and model, nothing else.** In run 1 the
Director took the narrator's whole binding, so `--max-tokens 300` capped every plan at 300 tokens.
A lite plan of Mag-Mell is 400–460 tokens (run 2), so 4 of 6 plans were cut and failed
`undecodable`. Now a Director that follows the narrator gets only its `conn` and `model`: not its
reply limit, samplers, reasoning or fallback. An explicit `roles.director` binding keeps all its
fields. In run 2 every plan was read on the first attempt. The test: `test/engine-m4/window.test.ts`,
"a narrator capped at 300 tokens: the lite Director still asks for its own 1 500, at its own
temperature".

**D-120: the narrator keeps the story's language.** The contract gained one line, after the persona
line: "Write the story in the language it is already written in; these constraints are in English
only for you." In run 1 three of six answers had whole English sentences; in run 2, with the line,
one of six (the `/regen` answer). The test:
`test/director/render.test.ts`, "D-120: the language line is the exact text of the note, the last
line, right after the persona line".

**The review.** A code review confirmed 16 findings, all fixed before run 2 (decisions D-121 to
D-124, ARCHITECTURE.md rev. 14):

- **D-121:** the Director's request always fits its window. A lite prompt shrinks (no history, then
  shorter lists); below 600 tokens of room nothing is sent (`no_room`); the correction pass lowers
  its `max_tokens` by as much as its prompt grew; the Director's calls get the narrator's
  server-truncation check. An explicit `profile = "full"` that does not fit runs lite.
- **D-122:** `transport_unsupported` only for a structured attempt refused with HTTP 400 before any
  output.
- **D-123:** fixes in the pure core: a seed's `relatedArcId` and turn numbers that made a stored
  state unreadable, selectors that echo an arc id (`[arc-1] …`), an empty `<plan></plan>` that hid
  the real plan, a self-audit that read a hidden answer, and summaries that missed reinforced seeds
  and new clues.
- **D-124:** `rp-core compact` re-checks the lock and the file before it replaces the journal, keeps
  rows whose removal would change what the reader accepts, keeps the file's mode and modification
  time, and stops when recovery just saved a draft.
- A missing provenance row for `src/agents/director/types.ts`.

## 5. Not run live

- **30 live turns** (about 60 model calls). The deterministic `thirty-turns` demo covers the §15
  claim; live, the four turns made a chapter and a seed but no arcs.
- **The structured transport.** No local model here has a confirmed `json_schema`; it is tested on
  the scripted provider (`test/engine-m4/turn.test.ts`, `test/structured/`).
- **A hosted model.**
- **The full profile.** It needs a window of 24 576 tokens or more (or `profile = "full"` with a
  prompt that fits); it is tested on the scripted provider with a 32 768 window.
- **`no_room` and `timeout`** on a real server (both are tested on the scripted provider), and
  `/usage` with Director rows.
- **`rp-core compact`** was not part of the live runs. On a copy of run 2's home afterwards it printed
  `compacted s_0d042d8c: 89571 → 52056 bytes (36 lines removed)`.

## How to rerun

The deterministic demos:

```bash
bun test test/demo-m4
```

The live run, against your own Ollama (a model with a 16 384 window; see the README on the window):

```bash
alias rp-core='bun src/cli/main.ts'
H=$(mktemp -d)
cat > $H/config.toml <<'TOML'
[connections.ollama]
base_url = "http://127.0.0.1:11434"

[caps."ollama:magmell-16k:latest"]
context_length = 16384
tools = "prompted"

[roles]
narrator = "ollama:magmell-16k:latest"

[director]
enabled = true
TOML
id=$(rp-core --home $H new --card test/fixtures/ru/innkeeper-200/card.json \
  --persona test/fixtures/ru/innkeeper-200/persona.json \
  --model ollama:magmell-16k:latest --max-tokens 300 --no-chat)
cat > $H/script.txt <<'EOF'
Добрый вечер. Найдётся ли у вас комната на ночь? Я землемер, иду в Велеград.
А что за шум был на дороге? Говорят, мост в Горелой балке совсем плох.
Расскажите, кто у вас тут бывает. Кажется, вон тот охотник на меня косится.
Ладно. Налейте мне чего-нибудь горячего, и я послушаю, что скажет охотник.
/director show
/r
/director show
/regen пусть охотник сам подойдёт к столу и заговорит первым
/director show
/trace
/rewind 5
/director show
/quit
EOF
rp-core --home $H chat $id < $H/script.txt 2>&1 | tee $H/run.log
rp-core --home $H compact $id      # afterwards: drop the checkpoints of the finished turns
```

A piped chat sends each line after the previous answer ends. Here the first answer took about two
minutes while Ollama loaded the model. To give the Director another model, add `director =
"ollama:<model>"` under `[roles]` before `rp-core new`; to try the full profile, use a model with a
window of 24 576 or more (and its `context_length`).
