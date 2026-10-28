# M5c demo — recall: the entries the narrator needs, picked by a model before the reply

Milestone M5c ("recall", ARCHITECTURE.md §15; `.notes/m5c-decisions.md` D-196…D-208) puts a model in
front of the Compendium's selector: before a reply, recall reads an index of the Compendium and the
last messages and picks the entries the narrator will need (tier 1 of the M5a selector). On a remote
server it runs beside the Director; on a local one it runs in the background after each answer, while
the player types, and the reply adopts what it prepared. A swipe or a continue reuses the answer's
record; a slow or failed recall falls back to the selector alone (lexical).

This is that demo: one deterministic run of the real CLI on scripted models (§1, §2), the timing
claims as engine tests (§3), and what needs hardware this machine does not have (§4). The live run on
Ollama comes next and is recorded separately.

**Result in one line: the nine claims below pass on scripted models through the real CLI
(`bun test test/demo-m5c`: 14 pass, about 12 s; the four chats take about 11.5 s). The run found no
integration bug that needed code. It did find one design cost, since changed: the lane prefetched
twice when a historian pass ended after the prefetch (§5).**

The demo runs the real CLI (`bun src/cli/main.ts`) as separate processes in one isolated home:
`import`, `new`, then `chat` four times. The recall index, prompts and reader run for real, and so do
the turn's recall step, the lane's prefetch, the scheduler and the selector's tier 1. So do the
journal, `/trace`, `/memory recall|profile|mode` and the Director. Only the models' answers are
scripted.

Environment: Bun 1.3.14 (`0d9b296a`), Linux 7.0.0-38-generic (x86_64). `bun test test/demo-m5c`:
14 pass, 0 fail, 142 `expect()` calls.

## What the demo shows

| Claim | Step | What the test asserts |
|---|---|---|
| Recall picks an entry that no message names: an old summary trimmed out of the history and not in the `{{recap}}` slot, found by meaning | 2b, 2c | U8 («кто-то видел, как его увозили той ночью?») names no entry. The kept recall request indexes H1 «Переправа к маяку» (#1–#5, trimmed at A7's request; A7's slot held only the `[Arc]`) and leaves out H3 (#10–#13, still in the history: hidden by freshness). R1 picks it. `/trace`: `C17 "Переправа к маяку" (model)` first. The narrator's request has `[Lore: Переправа к маяку]`, the only place the salt boat is mentioned. `/preview` (the selector alone) does not pick it |
| Sync recall beside the Director on a remote origin | 2c, 2d | A remote scripted origin with two places: `/memory mode auto` says "sync". The Director and recall each took 1.2 s (`calls: director 1.2s, recall 1.2s, narrator`), and the turn took less than their sum (1.6 s) |
| A swipe reuses the record with 0 calls | 2e, 4 | `/r`: `⋯ recall: reused (2)`; the record is `{source: 'reused', reusedFrom: <A8>, calls: 0}` with A8's picks; `calls: narrator` only; no recall request kept. After a restart too (process 4, a script with narrator lines only), for the swipe and the continue |
| A timeout falls back to lexical, and the answer comes | 2f | R2 sleeps 10 s; `timeout_sec = 4`: `⋯ recall: fallback [timeout]`, the answer arrives; the record is `{status: 'failed', code: 'timeout', calls: 1}`; `/trace`: `sync · failed [timeout] → lexical · 1 call 4.0s` |
| A prefetch miss after `grace_sec` → lexical | 3a | A local origin (`"local": true`): `auto` = prefetch. The prefetch after A9 sleeps 10 s; U10 waits `grace_sec` (1 s): `prefetch_missed` once, `⋯ recall: fallback [prefetch_missed]`, the record `{status: 'skipped', source: 'lexical', code: 'prefetch_missed', basis: <A9>}`. The turn took ≥ 1 s and < 4 s, and made no recall call |
| A local-origin prefetch adopted with no recall call in the turn | 3b | `⋯ recall: prefetched after #21 → 2: …` while the person "types"; U11: `⋯ recall: adopted (2)`, `/trace`: `0 calls in this turn (the prefetch: 1 call 0.2s)`, `calls: narrator` only. The prefetch's request ends with the prefetch line and holds no U11 |
| `/memory recall` | 2c, 2f, 3a, 3b, 4 | The card for a sync recall (picks in recall's order, `read: 1 unknown, 1 repeated`, calls, time, tokens), a timeout, a missed prefetch, an adopted one (`1 call in the background, without the player's message`), a reuse (`0 calls: the picks of …`) |
| `/memory profile` | 2a | block, recall, filing and historian rows: lite on a 4 096 window, recall following the recorder (D-85), `not running` for filing |
| `/memory mode` | 2a, 3a | Setting `auto` (a remote origin: "sync … beside the Director"), and the bare command on a local origin ("prefetch … waits for it at most 1 s, then … lexical") |
| (the lane prefetches before the historian) | 3c | After U11 the prefetch line prints before the historian's |
| (D-205 `history_crowded`) | 1, 2c | Told once per open session: at U6 (`Only 3 of the 11 earlier messages fit`) and, reopened, at U8 |
| (`/usage` counts an adopted prefetch) | 3b | `recall 2 calls · in 1204 tok · out 12 tok`: U9's timed-out call and the adopted prefetch's, through its record |

## 1. The setup (`test/demo-m5c/`)

| File | What it is |
|---|---|
| `lantern.test.ts` | The demo: the six CLI runs in one home (`beforeAll`), one test per claim, one for the kept requests, one that prints the transcript |
| `script1.txt`, `chat1.jsonl` | Chat 1, the story to U7 without recall: M5b's narrator answers A1–A7 (`test/demo-m5b/chat.jsonl` lines 2, 3, 7, 10, 13, 15, 17, copied) and three historian answers H1–H3 |
| `script2.txt`, `chat2.jsonl` | Chat 2, a remote origin with two places (`maxInFlight: 2`): the Director's plan, R1, A8, A8′, R2 (sleeps 10 s), A9, H4 |
| `script3.txt`, `chat3.jsonl` | Chat 3, a local origin (`"local": true`): the prefetch after A9 (sleeps 10 s), A10, the prefetch after A10 (two names), A11, the prefetch after A11 (prose), H5 |
| `script4.txt`, `chat4.jsonl` | Chat 4, reopened on a remote origin: two narrator lines (the swipe and the continue), and no recall line |

The world is the M5a and M5b demos' (docs/M5A-DEMO.md, docs/M5B-DEMO.md): the narrator card
«Рассказчик» and the persona Ян (`test/demo-m5a/`), the RoleCall book `lantern`
(`test/fixtures/ru/lantern/`). The story goes on from M5b's U7: Ян and Мира look for a witness to
the night the lantern was taken. All new texts (U8–U11, A8–A11′, H1–H5, the Director's plan, the
recall answers) are in the chat files.

`config.toml`, written before `rp-core new`, so the session starts from it (the REPL has no command
for these settings, so they hold for all four chats):

- `[compendium] idle_delay_sec = 0`: the lane starts as soon as a turn has settled.
- `[compendium.recall] mode = "lexical"`: chat 1 builds the story without recall; chat 2 says
  `/memory mode auto`, and the session keeps it.
- `grace_sec = 1`: a reply waits at most 1 s for a prefetch still running (default 4).
- `timeout_sec = 4`: every recall call gets 4 s from its grant (default 30 s local, 20 s remote,
  60 s for a prefetch). This makes R2 time out, and it is long enough that the slow prefetch of
  chat 3 is still running when the grace runs out.
- `[compendium.filing] enabled = false`: the scripted calls are the narrator's, the Director's,
  recall's and the historian's (M5b showed filing).
- `[compendium.historian] interval = 2`: a historian pass after every two accepted player turns.
- The scripted caps' 4 096-token window: every profile is lite (`/memory profile`), and the history
  is trimmed from U6 on.

**How the scripted calls stay in order.** Every call line in the chat files is tagged with its agent
(`{"agent": "recall", "steps": […]}`, D-207): a request takes the first unused line tagged with its own
agent. So the Director and recall can ask at once, each gets its own answer, and a lane pass cannot
take a turn's line. Every line that gives the lane work is followed by `/memory wait`, so each lane
line prints in a fixed place. The test reads a line and the wait after it together, so no claim
depends on which side of the echo a lane line printed. The lane's answers take 200 ms.

**Local and remote.** A script file's first line may say `"local": true` (D-207 as built): then the
scheduler treats the script's origin as a local server, and `auto` prefetches. Without it the origin
is remote, and `auto` is sync. Chat 3 has the line; chats 1, 2 and 4 do not.

**The recall seam.** The test preload sets `RP_CORE_RECALL=lexical` (pre-M5c tests make no recall
calls). The demo removes it from the children's environment, so the session's config decides the
mode. `RP_CORE_LANE=auto` runs the lane as for a person (the preload makes it `manual`).

Message numbers on the path (`#n`, as `/show` numbers them): #1 the greeting, #2 U1, #3 A1, …,
#14 U7, #15 A7, #16 U8, #17 A8 (A8′ after the swipe), #18 U9, #19 A9, #20 U10, #21 A10, #22 U11,
#23 A11 (A11′ after chat 4's swipe).

## 2. The run

The transcript is the test's own output (`bun test test/demo-m5c/lantern.test.ts`). Long parts are
cut (`…`): the narrator's answers after their first sentence, and `/preview`. The home is `<home>`.
Session and message ids, and times in tenths of a second, differ from run to run; everything else is
the same on every run.

### Setup

```
$ cat <home>/config.toml
[compendium]
idle_delay_sec = 0

[compendium.recall]
mode = "lexical"
grace_sec = 1
timeout_sec = 4

[compendium.filing]
enabled = false

[compendium.historian]
interval = 2
$ rp-core --home <home> import test/fixtures/ru/lantern/lantern.compendium.json
lantern
rp-core: warning: RoleCall's stored tree and node constraints are dropped: rp-core derives the tree from the entries (tree)
rp-core: imported lorebook "Lantern" as <home>/library/lorebooks/lantern.json
rp-core: hint: /lore add lantern in the chat, or rp-core new --lore lantern
$ rp-core --home <home> new --card test/demo-m5a/card.json --persona test/demo-m5a/persona.json --lore lantern --no-chat
s_eb63a0ec
rp-core: created session s_eb63a0ec "Рассказчик" with 1 greeting (card imported as library character рассказчик; lorebooks lantern)
```

### 1. The story without recall

```
$ rp-core --home <home> chat s_eb63a0ec --keep-requests --provider script:test/demo-m5c/chat1.jsonl < test/demo-m5c/script1.txt
session s_eb63a0ec · Рассказчик · narrator script:default (tools: off) · ctx 4096
Рассказчик › Ночь опускается на портовый город. Ян стоит у причала с тяжёлым свёртком в руках: внутри что-то звякает, будто стекло о латунь. …
  [greeting 1/1]
you        › — Отвезёшь меня к Серому маяку? Мне нужно отдать этот свёрток Мире.
Рассказчик › Лодочник, сухой старик с седой косицей, кивает на корму. …
  [swipe 1/1 · 0.3s · end]   /r swipe  /c continue  /e edit
you        › — А кто, по-твоему, мог снять фонарь?
Рассказчик › Фрол долго гребёт молча, и туман смыкается за кормой. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › — Значит, Соляной суд. Мира должна это услышать. Греби быстрее!
Рассказчик › Лодка ткнулась в камни под маяком. Наверху, в фонарной башне, мигнул слабый огонёк, будто кто-то прикрыл лампу ладонью. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ memory: historian #1–#5 → +2: C17 "Переправа к маяку", C18 [Arc] "Украденный свет"
the background lane is idle
you        › — Поднимемся наверх. Там кто-то есть, я видел свет.
Рассказчик › Лестница в фонарную башню скрипит под ногами, и с каждым витком сильнее пахнет копотью и солью. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › — Кто это был? Ты видела их лица?
Рассказчик › Ульяна качает головой и плотнее кутается в парус. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ memory: historian #6–#9 → +2: C19 "Стекло и смотрительница", C18 [Arc] "Украденный свет"
the background lane is idle
you        › — Тогда к Арсению, в Фонарный ряд. Фрол ещё ждёт у камней?
! Only 3 of the 11 earlier messages fit in the request: the fixed part of the prompt (everything but the chat history) takes about 796 of the 2048 tokens a request may use (window 4096 - reply reserve 2048). A narrator with a larger window (/model) or a lighter preset (/preset builtin) leaves the history more room; /preview shows the parts. (history_crowded)
Рассказчик › Фрол ждёт у камней, кутаясь в плащ, и молча помогает спустить Ульяну. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › — Арсений! Фонарь держат в подвалах Соляного суда!
Рассказчик › Арсений Кеттер выходит на крыльцо мастерской в одной рубахе, с лампой в руке, и слушает, не перебивая. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ memory: historian #10–#13 → +2: C20 "Хромой стражник", C18 [Arc] "Украденный свет"
the background lane is idle
you        › /trace
trace of b805d908 · script:default
  window 4096 · reserve 2048 · prompt ~1151 tok · 13 messages sent
  trimmed: 5040e076 … 7ae86796 · prefill: none
  unknown macros: none
  lore: nothing fired · budget 307 tok
  lore not fired (recomputed from its seed):
    ✗ 1 entry: no-key-match 1
  ! Since this answer was written, the Compendium changed: the preview is built with today's. (preview_inputs_changed)
  recall: lexical (no recall call; the selector picked alone)
  compendium: lite · picked 9: C1 "Арсений Кеттер" (mention), C3 "Ульяна" (window), C5 "Фонарный ряд" (window), C14 "Фонарь погас" (window), C15 "Туманник" (window), C2 "Селина Бранд" (window), C6 "Серый маяк" (window), C9 "Гильдия фонарщиков" (window), C12 "Чёрный прилив" (window) · injected 5: … · block 472 tok
  recap: 1 arc: C18 "Украденный свет" rev 30 · boundary d64d56ad
  calls: narrator script:default 0.0s
you        › /memory list summary
Summary entries on this path: 4 live · /memory show <ref> prints one
Narrative (4)
  C14 Фонарь погас — Ночь, когда маяк ослеп. [lib: lantern] [524]
  C17 Переправа к маяку — Фрол везёт Яна к тёмному маяку. [513]
  C19 Стекло и смотрительница — Стекло фонаря цело, Ульяна нашлась. [1.0k]
  C20 Хромой стражник — Фонарь держат в подвалах суда. [459]
you        › /quit
```

This chat sets up the case recall is for. H1 «Переправа к маяку» (#1–#5) holds the fact that matters
later: on the night of the theft Фрол saw a boat loaded with salt at the Old Pier. A2 tells it and H1
sums it up; H1's arc overview had it too, but H2 and H3 rewrote the arc. A6's and A7's requests trim
#2–#9 (U1 … A4), so A2 is no longer sent.
The `{{recap}}` slot has room for the `[Arc]` only: its budget is what the history leaves, at most
10 % of the window. The summaries H1 and H2 precede the cut but do not fit (the test pins
`trace.recap.ids = []`). Filing is off, so Фрол has no entry of his own. The selector reads names, and
nothing in the messages it sees leads to H1.

### 2. A remote origin: sync recall beside the Director, a swipe, a timeout

```
$ rp-core --home <home> chat s_eb63a0ec --keep-requests --provider script:test/demo-m5c/chat2.jsonl < test/demo-m5c/script2.txt
session s_eb63a0ec · Рассказчик · narrator script:default (tools: off) · ctx 4096
Рассказчик › Арсений Кеттер выходит на крыльцо мастерской в одной рубахе, с лампой в руке, и слушает, не перебивая. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory mode auto
recall mode: auto (set for this session, from the next reply)
  here: sync (the recall model's server is not local): recall (script:default) picks the entries the narrator needs beside the Director, before each reply
you        › /model
  narrator script:default
  director narrator (follows)
  recorder narrator (follows)
  recall   recorder (follows)
you        › /memory profile
Compendium profiles (compendium.profile auto: lite below a 24576-token window, full from it):
  block     lite: the narrator's window 4096 < 24576 · script:default
  recall    lite: the recall model's window 4096 < 24576 · script:default (follows the recorder, which follows the narrator) · up to 4 picks, reading the last 6 messages
  filing    lite: the recorder's window 4096 < 24576 · script:default (follows the narrator) · not running: compendium.filing.enabled is false
  historian lite: the recorder's window 4096 < 24576 · script:default (follows the narrator)
you        › /director on
director on: it plans every reply with script:default (the narrator's model), from the next turn (/director shows its plan; /model director <connection:model> picks another model)
you        › — Но ведь кто-то видел, как его увозили той ночью?
  ⋯ director: planned — chapter 1
  ⋯ recall: recalled (2)
! Only 1 of the 15 earlier messages fits in the request: the fixed part of the prompt (everything but the chat history) takes about 1581 of the 2048 tokens a request may use (window 4096 - reply reserve 2048). A narrator with a larger window (/model) or a lighter preset (/preset builtin) leaves the history more room; /preview shows the parts. (history_crowded)
Рассказчик › Мира поднимает голову от стекла. — Видели, — говорит она тихо. …
  [swipe 1/1 · 1.6s · end]   /r swipe  /c continue  /e edit
you        › /trace
trace of c159ea56 · script:default
  window 4096 · reserve 2048 · prompt ~1450 tok · 11 messages sent
  trimmed: 5040e076 … b805d908 · prefill: none
  unknown macros: none
  lore: nothing fired · budget 307 tok
  lore not fired (recomputed from its seed):
    ✗ 1 entry: no-key-match 1
  recall: sync · 2 picked: C17 "Переправа к маяку", C5 "Фонарный ряд" · 1 call 1.2s
  compendium: lite · picked 8: C17 "Переправа к маяку" (model), C5 "Фонарный ряд" (model), C1 "Арсений Кеттер" (window), C3 "Ульяна" (window), C6 "Серый маяк" (window), C12 "Чёрный прилив" (window), C14 "Фонарь погас" (window), C15 "Туманник" (window) · injected 5: C17 "Переправа к маяку" brief 149 tok, C5 "Фонарный ряд" brief 57 tok, C1 "Арсений Кеттер" brief 150 tok, C3 "Ульяна" brief 86 tok, C6 "Серый маяк" brief 57 tok · cut by the budget 3: C12 "Чёрный прилив" 83 tok, C14 "Фонарь погас" 112 tok, C15 "Туманник" 61 tok · 1 hidden by freshness · block 505 tok
  recap: 1 arc: C18 "Украденный свет" rev 42 · 1 summary: C20 "Хромой стражник" · boundary a057be5e
  calls: director script:default 1.2s, recall script:default 1.2s, narrator script:default 0.0s
you        › /memory recall
recall for #17: sync · recalled 2 · lite · script:default · tagged
  picks, in recall's order:
    1. C17 "Переправа к маяку"
    2. C5 "Фонарный ряд"
  read: 1 unknown, 1 repeated
  1 call · 1.3s · 1162 in / 31 out tokens
you        › /preview
preview of a swipe (a new answer to a057be5e) · script:default
  window 4096 · reserve 2048 · prompt ~1441 tok (o200k) · 11 messages · nothing was sent
…
#8 system · recap · 167 tok
[Arc] Украденный свет
Латунный фонарь держат в подвалах Соляного суда, пока Гильдия не отдаст ключи от огней. Стекло у Миры, Ульяна спасена; герои везут весть Арсению.

[Summary: Хромой стражник]
Ульяна вспомнила, что старший из людей в масках хромал и пах дёгтем солеварен, …

#9 system · compendium:block · 432 tok
[Retrieved World Knowledge]
[Lore: Арсений Кеттер]
…
[Lore: Ульяна]
…
[Lore: Серый маяк]
…
[Lore: Чёрный прилив]
…
[Lore: Фонарь погас]
…
#11 user · history · 19 tok
— Но ведь кто-то видел, как его увозили той ночью?
…
you        › /r
  ⋯ recall: reused (2)
  ⋯ director: reused — chapter 1
Рассказчик › Арсений долго молчит, вертя в пальцах старый ключ. …
  [swipe 2/2 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /trace
trace of 7b79b5db · script:default
  …
  recall: reused from c159ea56 (another version of #17) · 2 picked: C17 "Переправа к маяку", C5 "Фонарный ряд" · 0 calls
  compendium: lite · picked 8: C17 "Переправа к маяку" (model), C5 "Фонарный ряд" (model), C1 "Арсений Кеттер" (window), … · block 505 tok
  recap: 1 arc: C18 "Украденный свет" rev 42 · 1 summary: C20 "Хромой стражник" · boundary a057be5e
  calls: narrator script:default 0.0s
you        › /director off
director off (from the next turn); its plan is kept: /director on resumes it
you        › — Где мне искать Фрола в такой час?
  ⋯ recall: fallback [timeout]
Рассказчик › — У перевоза, в сторожке за Старой пристанью, — говорит Мира и накидывает на плечи гильдейский плащ. …
  [swipe 1/1 · 4.0s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ memory: historian #14–#17 → +1: C21 "Свидетель той ночи"
the background lane is idle
you        › /trace
trace of e3f22766 · script:default
  window 4096 · reserve 2048 · prompt ~1507 tok · 17 messages sent
  trimmed: 5040e076 … 7ae86796 · prefill: none
  unknown macros: none
  lore: nothing fired · budget 307 tok
  lore not fired (recomputed from its seed):
    ✗ 1 entry: no-key-match 1
  ! Since this answer was written, the Compendium changed: the preview is built with today's. (preview_inputs_changed)
  recall: sync · failed [timeout] → lexical · 1 call 4.0s
  compendium: lite · picked 5: C1 "Арсений Кеттер" (window), C6 "Серый маяк" (window), C14 "Фонарь погас" (window), C3 "Ульяна" (window), C12 "Чёрный прилив" (window) · injected 5: … · block 494 tok
  recap: 1 arc: C18 "Украденный свет" rev 42 · boundary d64d56ad
  calls: recall script:default 4.0s, narrator script:default 0.0s
you        › /memory recall
recall for #19: sync · failed [timeout] · lite · script:default · tagged
  recall did not answer within its deadline: the selector picked alone (lexical)
  1 call · 4.0s
you        › /quit
```

**By meaning (2b, 2c).** U8 asks whether anyone saw the lantern being taken away, and names no entry.
Its recall request (kept as `t_<turn>_recall_0.json`) holds the lite index, which lists every candidate
with its tagline (17 here):

```
## Knowledge Index

[e1] Арсений Кеттер (aka Старшина, Арсений) - Старшина Гильдии фонарщиков, сорок лет зажигает огни Вельмара.
…
[e6] Фонарный ряд - Квартал Гильдии фонарщиков: мастерские, склады масла и колокольня, по которой…
…
[e11] Стекло и смотрительница - Стекло фонаря цело, Ульяна нашлась.
[e12] Переправа к маяку - Фрол везёт Яна к тёмному маяку.
…
[e17] Негасимый свет - Огонь, который не гаснет ни от воды, ни от ветра.

## Recent Conversation (last 6 messages)
…
[user]: — Но ведь кто-то видел, как его увозили той ночью?

Answer with one JSON object and nothing else: {"entry_ids": ["e1"]}. Use only the [eN] handles shown in the index. Select at most 4 entries; an empty list is fine.
```

H1 and H2 are in the index: A7's request trimmed both, and A7's slot held neither. H3 «Хромой
стражник» (#10–#13) is not: those messages were still sent, so freshness hides it (D-197). The arcs
are no candidates. The scripted answer R1 is a ```` ```json ```` fence with `e12`, `e6`, `e12` again
and `e99`, which is not in the index. The reader keeps two picks and counts `1 repeated` and
`1 unknown` (`/memory recall`'s `read:` line). The picks go first in the block as tier 1, in recall's
order (`(model)`). The narrator's kept request has `[Lore: Переправа к маяку]` with H1's text, and no
message it was sent mentions the salt boat. `/preview` shows what the selector picks alone (previews
never call recall, ruling H): five `(window)` entries, without «Переправа к маяку» or «Фонарный
ряд».

**Beside the Director (2d).** On this remote origin with two places, the Director and recall are
asked at once (D-203). Each scripted answer waits 1.2 s, and `/trace` shows both calls taking 1.2 s.
The whole turn took 1.6 s, less than the 2.4 s the two calls would take one after the other (the
test checks `gen.ms` < the two calls' `ms` added up). On one place the Director goes first and recall
after it; that order is an engine test (§3). `/trace` has no start times for calls yet (§4), so the
overlap is shown by times rather than drawn.

**The swipe (2e).** `/r` reuses A8's record (`source: 'reused'`, `reusedFrom: <A8>`, `calls: 0`), and
the Director's plan is reused too. The swipe makes one call, the narrator's.

**The timeout (2f).** The Director is turned off for U9 because at a 4 096 window its lite prompt no
longer fits once the history grows (`director_no_room`, M4's D-121). The timeout claim does not need
it (D-121: a Director prompt that leaves less than 600 tokens to answer is not sent). R2 sleeps 10 s. At 4 s from its grant the deadline cancels the call, the record is
`{status: 'failed', source: 'lexical', code: 'timeout', calls: 1}`, and the selector picks alone. The
answer comes, and the historian's pass for #14–#17 runs after it.

### 3. A local origin: the prefetch, missed and adopted

```
$ rp-core --home <home> chat s_eb63a0ec --keep-requests --provider script:test/demo-m5c/chat3.jsonl < test/demo-m5c/script3.txt
session s_eb63a0ec · Рассказчик · narrator script:default (tools: off) · ctx 4096
Рассказчик › — У перевоза, в сторожке за Старой пристанью, — говорит Мира и накидывает на плечи гильдейский плащ. …
  [swipe 1/1 · 4.0s · end]   /r swipe  /c continue  /e edit
you        › /memory mode
recall mode: auto (this session's compendium.recall.mode)
  here: prefetch (the recall model's server is local): recall (script:default) picks in the background after each answer, while you type; a reply waits for it at most 1 s, then the selector picks alone (lexical)
you        › /memory wait 1
still working after 1 s: the recall prefetch after #19 runs (/memory status)
you        › — Я пойду к пристани сейчас, пока не рассвело.
! The recall prefetched while the player typed was still running when the turn needed it (the turn waited 1 s for it), so it went on without it. A longer compendium.recall.grace_sec, or a second slot on the server, gives the prefetch time. (prefetch_missed)
  ⋯ recall: fallback [prefetch_missed]
Рассказчик › Фонарный ряд остаётся позади, и туман смыкается за спиной. …
  [swipe 1/1 · 1.1s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ recall: prefetched after #21 → 2: C17 "Переправа к маяку", C6 "Серый маяк"
the background lane is idle
you        › /trace
trace of b85bfb25 · script:default
  window 4096 · reserve 2048 · prompt ~1549 tok · 19 messages sent
  trimmed: 5040e076 … 7ae86796 · prefill: none
  unknown macros: none
  lore: nothing fired · budget 307 tok
  lore not fired (recomputed from its seed):
    ✗ 1 entry: no-key-match 1
  recall: prefetch after #19 · missed [prefetch_missed] → lexical · 0 calls
  compendium: lite · picked 4: C1 "Арсений Кеттер" (window), C14 "Фонарь погас" (window), C15 "Туманник" (window), C6 "Серый маяк" (window) · injected 4: … · 2 hidden by freshness · block 386 tok
  recap: 1 arc: C18 "Украденный свет" rev 42 · boundary d64d56ad
  calls: narrator script:default 0.0s
you        › /memory recall
recall for #21: prefetch after #19 · missed [prefetch_missed] · lite
  the prefetch was not ready when the reply started: the selector picked alone (lexical)
  0 calls
you        › — Фрол! Просыпайся, это Ян. Нужна твоя помощь.
  ⋯ recall: adopted (2)
Рассказчик › Дверь сторожки скрипит, и на пороге появляется Фрол в накинутом на плечи тулупе, с топориком в руке. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ recall: prefetched after #23 → 2: C17 "Переправа к маяку", C1 "Арсений Кеттер"
⋯ memory: historian #18–#21 → +1: C22 "Ночь у Старой пристани"
the background lane is idle
you        › /trace
trace of 2b0f6720 · script:default
  window 4096 · reserve 2048 · prompt ~1197 tok · 13 messages sent
  trimmed: 5040e076 … 7b79b5db · prefill: none
  unknown macros: none
  lore: nothing fired · budget 307 tok
  lore not fired (recomputed from its seed):
    ✗ 1 entry: no-key-match 1
  ! Since this answer was written, the Compendium changed: the preview is built with today's. (preview_inputs_changed)
  recall: prefetch after #21 · 2 picked: C17 "Переправа к маяку", C6 "Серый маяк" · 0 calls in this turn (the prefetch: 1 call 0.2s)
  compendium: lite · picked 6: C17 "Переправа к маяку" (model), C6 "Серый маяк" (model), C5 "Фонарный ряд" (window), C15 "Туманник" (window), C1 "Арсений Кеттер" (window), C14 "Фонарь погас" (window) · injected 5: … · block 480 tok
  recap: 1 arc: C18 "Украденный свет" rev 42 · 2 summaries: C20 "Хромой стражник", C21 "Свидетель той ночи" · boundary c14baaee
  calls: narrator script:default 0.0s
you        › /memory recall
recall for #23: prefetch after #21 · recalled 2 · lite · script:default · tagged
  picks, in recall's order:
    1. C17 "Переправа к маяку"
    2. C6 "Серый маяк"
  read: 2 by name
  1 call in the background, without the player's message · 0.2s · 1204 in / 12 out tokens
you        › /memory status
the Compendium's background lane is idle: nothing queued, nothing parked
  recall: prefetched after #23, ready for the next reply: 2 picked: C17 "Переправа к маяку", C1 "Арсений Кеттер"
you        › /usage
usage on this path:
  narrator   11 generations · cost unknown
  recall     2 calls · in 1204 tok · out 12 tok · cost unknown
  historian  5 calls · cost unknown
  total      in 1204 tok · out 12 tok · cost unknown
  (11 narrator generation(s) without usage from the server; 1 recall call(s) without usage from the server; 1 recall call(s) without a price ([prices."conn:model"] in config.toml); 5 historian call(s) without usage from the server)
you        › /quit
```

**The miss (3a).** The chat opens on A9, an answer, so the lane begins the prefetch after it at once
(`idle_delay_sec = 0`). Its scripted answer takes 10 s. `/memory wait 1` gives up after 1 s and says
the prefetch is running. U10's turn then waits `grace_sec` (1 s) for it, promoted to interactive
priority (D-203). It is still not done, so the turn cancels it and goes on with the selector alone.
This is a local origin, so `on_miss = auto` means lexical. The record is
`{status: 'skipped', source: 'lexical', code: 'prefetch_missed', basis: <A9>, calls: 0}`, and
`prefetch_missed` is told once. The turn took about 1.1 s, and the narrator was the only call in it.
The cancelled prefetch's request was sent and kept (`p_<A9>_recall_0.json`), but its call is not in
`/usage`: a prefetch never adopted is not journaled (D-204).

**Adopted (3b).** After A10 the lane prefetches again; P2 answers with a bare array of two names
(`read: 2 by name`). When U11 arrives the prefetch is ready, and its basis (A10, the path's edits and
hides, the setup) still matches. The turn adopts it: the record is `{source: 'prefetch',
basis: <A10>, calls: 1}`, no recall call is made in the turn (`calls: narrator`), and the picks lead
the block. The prefetch's request (`p_<A10>_recall_0.json`) ends with the prefetch line «The player
has not answered yet; pick what the narrator will most likely need for the next reply.». Its
conversation stops at A10. The sync request of chat 2 has no such line. `/usage` counts the adopted
call and its tokens through the record.

**The lane's order (3c).** After U11 two things are due: the prefetch after A11 and a historian pass
(U10 and U11 accepted A9 and A10). The prefetch runs first (P3 is prose; the reader salvages `e8` and
`e7` from it, «Переправа к маяку» and «Арсений Кеттер» in that prefetch's index). Then the historian writes «Ночь у Старой пристани». That row moves the Compendium's
revision, but a prefetch's basis does not hold the revision (D-202 as amended after this demo's first
run: picks are entry keys and the block reads their current text), so the held prefetch still matches
A11 and the lane does not prefetch again: one request per answer.

### 4. Reopened on a remote origin: reuse after a restart

```
$ rp-core --home <home> chat s_eb63a0ec --keep-requests --provider script:test/demo-m5c/chat4.jsonl < test/demo-m5c/script4.txt
session s_eb63a0ec · Рассказчик · narrator script:default (tools: off) · ctx 4096
Рассказчик › Дверь сторожки скрипит, и на пороге появляется Фрол в накинутом на плечи тулупе, с топориком в руке. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /r
  ⋯ recall: reused (2)
Рассказчик › Фрол открывает не сразу: сначала за дверью звякает засов, потом в щель выглядывает седая косица. …
  [swipe 2/2 · 0.4s · end]   /r swipe  /c continue  /e edit
you        › /trace
trace of 797ba42a · script:default
  …
  recall: reused from 2b0f6720 (another version of #23) · 2 picked: C17 "Переправа к маяку", C6 "Серый маяк" · 0 calls
  compendium: lite · picked 6: C17 "Переправа к маяку" (model), C6 "Серый маяк" (model), C5 "Фонарный ряд" (window), … · block 480 tok
  recap: 1 arc: C18 "Украденный свет" rev 42 · 2 summaries: C20 "Хромой стражник", C21 "Свидетель той ночи" · boundary c14baaee
  calls: narrator script:default 0.0s
you        › /memory recall
recall for #23: reused from 2b0f6720 (another version of #23) · recalled 2 · lite · script:default · tagged
  picks, in recall's order:
    1. C17 "Переправа к маяку"
    2. C6 "Серый маяк"
  read: 2 by name
  0 calls: the picks of 2b0f6720 (another version of #23)
you        › /c
  ⋯ recall: reused (2)
Рассказчик › … — Но я ту лодку видел. Пойду и скажу. Он задувает огонёк в печке и снимает с гвоздя старый фонарь.
  [swipe 2/2 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /trace
trace of 797ba42a (its last continue) · script:default
  …
  recall: reused from #23 · 2 picked: C17 "Переправа к маяку", C6 "Серый маяк" · 0 calls
  …
  calls: narrator script:default 0.0s
you        › /memory recall
recall for #23: reused from #23 · recalled 2 · lite · script:default · tagged
  picks, in recall's order:
    1. C17 "Переправа к маяку"
    2. C6 "Серый маяк"
  read: 2 by name
  0 calls: the picks of #23
you        › /quit
```

The prefetch held at the end of chat 3 lived in memory and is gone. This origin is remote, so `auto`
is sync, and a reply would call recall. The swipe does not. It reuses A11's stored record (written in
`prep` and in the commit), and the continue reuses A11′'s, an `edit` row with `reusedFrom: <A11′>`. The
script has narrator lines only, so a recall call would end in `script_exhausted`. The test also
checks that chat 4 sent exactly two narrator requests.

### The kept requests

All four chats ran with `--keep-requests`: 25 requests, one per scripted call. They are 14 narrator,
1 Director, 5 recall and 5 historian. Every recall request is lite (`max_tokens` 200; the scripted
model does not reason, so there is no +1 024). Sync recalls are kept under their turn
(`t_<turn>_recall_0.json`), prefetches under the answer they follow (`p_<answer>_recall_0.json`). The
scripted model is on the tagged transport and takes an assistant prefill, so every recall request
opens its answer with `{"entry_ids": [` and every historian request with `{"filings": [` (D-208,
after the live run on Ollama). The scripted answers are whole (an object, a fence, a list) or prose,
and the reader reads them alone (R1, P2) or after the opening (P3's salvaged handles). The
historian's row after A11 moves the Compendium's revision, but the prefetch stays valid (its basis does
not hold the revision: picks are entry keys and the block reads their current text), so there is one
prefetch per answer.

## 3. The timing claims

The deterministic run shows each behaviour once, at times a piped script can hold. The cases that
depend on exact time are engine tests with scripted pauses and fake timers:

- **Beside the Director, one place or two**: `test/recall-engine-m5c/sync.test.ts` ("two places: both
  are asked before either answers"; "one place on one origin: the Director is served first, recall
  after its call"), `test/sched-m5c/order.test.ts` (`ordered()`: Director-first on one place, both at
  once on two, a local origin's filing pass preempted).
- **The grace wait**: `test/recall-engine-m5c/prefetch.test.ts`. In flight and ready within
  `graceSec`: promoted and adopted, and the narrator asks after it. Late: superseded and missed
  (lexical locally, with the record and the notice). On a remote origin the Director plans during
  the wait, and a late prefetch means a sync recall. A Stop ends the wait, and the prefetch runs on
  for the next reply to the same message.
- **Promotion in the scheduler**: `test/sched-m5c/boost.test.ts` (a promoted prefetch is not preempted;
  on a local origin it keeps other background work off; it passes the idle gate).
- **`recall_slow`** after three sync recalls slower than 8 s: `test/recall-engine-m5c/sync.test.ts`.
- **Reuse, recovery, the slot left out of the index**: `test/recall-engine-m5c/reuse.test.ts`. A
  failed record is not reused, and a guided re-roll recalls again. A crash after `prep` recovers the
  record. The index leaves out the predicted `{{recap}}` slot. The demo's slot holds no summary, so
  only the engine test shows that exclusion.
- **`history_crowded`** once per open session: `test/crowded-m5c/engine.test.ts`.

## 4. What needs live hardware (M5d), and what the demo does not show

This machine has no llama.cpp, koboldcpp or LM Studio. Ollama is reached through `/v1`, which cannot
set runner options. So D-196 moved these to **M5d (latency)**, and nothing here measures them:

- §15's 60-turn run on llama.cpp (`-c 16384 -np 1`, qwen3-14b, Director lite, 30 s pauses), and its
  claim that recall adds no call before the first token in ≥ 90 % of turns;
- `rp-core bench ttft` and its matrix (llama.cpp with and without `--cache-ram`, `-np 2` with
  `id_slot`, koboldcpp, Ollama `NUM_PARALLEL` 1 and 2), `id_slot` pinning and the `/slots` probe
  (`slots_detected`);
- Ollama runner-option mirroring (`ollama_options_mismatch`), `lmstudio_autoevict`;
- the acceptance criteria: a prefetch's picks ≥ 0.8 × the agreement of two sync runs over ≥ 60 turns
  (the quality harness), and re-processing ≤ 1.5 × the new tail with `--cache-ram` or `-np 2` +
  `id_slot`.

Also not shown here:

- **A real model's picks, and time to first token on a real server.** The live run on Ollama (one
  local slot: sync, prefetch with and without pauses, lexical) is next, and is recorded on its own.
  A turn-relative first-token time and call start offsets on `Trace.calls` are not built yet
  (cli Q3), so that run reads times from `gen.ms` and the calls' `ms`.
- **The full profile.** At 4 096 tokens every agent is lite. The full prompt (Bunraku's text), the
  top-up and the corrective pass have their own tests (`test/recall-m5c/`).
- **`/memory recall test <text>`** (asked for in the demo research, not in D-206) is not built, so the
  demo shows "what the selector picks alone" through `/preview`, which never calls recall.
- **Untyped book entries as picks** (deferred by D-196). The draft's third prefetch named the book's
  untyped «Песня фонарщиков». That entry is not a candidate, so the answer names typed entries.
- **A 300-message recall** of something about 200 messages back (§15's betrayal): the demo shows the
  same thing at a small scale, a summary of #1–#5 recalled at #16.

## 5. Findings

No integration bug needed a fix. The demo's first run found one cost of the design, now changed:
**a historian (or filing) pass right after a prefetch made the lane prefetch again.** The prefetch's
basis then held the Compendium's revision; the lane runs a due prefetch before the file and historian
tasks of the same pause (prerecall → file → hist), and any row those tasks wrote moved the revision.
The second request was byte for byte the first, and with filing on (the default) a local server would
have paid two prefetch calls per answer. The basis no longer holds the revision (D-202 amended): the
picks are entry keys, the block reads their current text, and an entry the lane files after the
prefetch is still reachable by name (tiers 0 and 2) and by search.
