# M5b demo — the Compendium's agents: filing, the historian and the `{{recap}}` slot

Milestone M5b ("Compendium agents", ARCHITECTURE.md §15) ends with a demo of six claims: on a local
server the Compendium fills in the background, `send` does not wait for filing, and a preempted pass
goes back to the queue without counting as an attempt; a swipe in the first seconds after an answer
does not wake the background (`idleDelaySec`); a swipe removes its answer's entries, and an edit of an
old answer makes its pass stale so the lane writes it again; `/memory undo <msg>` takes a pass back
and the lane does not repeat it, `/memory refile <msg>` writes it again; once trimming starts, the
`{{recap}}` slot shows the `[Arc]` overview and the summaries, and the slot does not change until the
boundary moves; `kill -9` during filing leaves exactly one effective row per key after reopening.

This is that demo: one deterministic run of the real CLI on a scripted model with the background lane
in auto mode (§1, §2), where the two timing claims are checked instead (§3), and three live runs on
Ollama with how to run the scripted story live (§4).

**Result in one line: the four behaviour claims pass on the scripted model, together with filing after
accepted answers, lenient reading and two historian passes (`bun test test/demo-m5b`: 16 pass, about
7 s; the demo itself is 11 of them, about 4.5 s). The two timing claims are engine tests. The demo found
two integration bugs, both fixed (§5). Live on a local 12B (§4) filing ran after accepted answers, the
historian reused the book's plot, and `/memory undo` and `/memory refile` worked; the historian wrote
English summaries of a Russian story until the lane named the story's language (D-183, §4).**

The demo runs the real CLI (`bun src/cli/main.ts`) as separate processes in one isolated home:
`import`, `new`, then `chat` four times. Everything between the keyboard and the model is the real
code: the lane and its derived work, the scheduler, the filing and historian prompts and readers, the
fold, the slot, the journal and its recovery. Only the model's answers are scripted (`chat.jsonl` and
three short files for the crash).

Environment: Bun 1.3.14 (`0d9b296a`), Linux 7.0.0-38-generic (x86_64). `bun test test/demo-m5b`:
16 pass, 0 fail, 183 `expect()` calls.

## What the demo shows

| §15 demo point | Step | What the test asserts |
|---|---|---|
| (filing runs after accepted answers) | a | Nothing after U1 (`filing.wait = 1`: an answer is accepted once the player answers it); after U2 one pass for A1: `job{begin}`, then `mem{key: file:<A1>, range: [U1, A1]}`; «маяк» is the lighthouse's alias, so the book's entry is edited in this session (`[lib: lantern, edited]`), not duplicated |
| A swipe removes its answer's entries | b | After `/rewind 2` and `/r`, Фрол is gone from `/memory list character`; `/memory wait` has nothing to do (A1′ is not accepted); `/[` brings A1 back and Фрол with it, with no job row and no model call |
| An edit of an old answer makes its pass stale; the lane writes it again | c | `/e 3` writes an `edit` row; a second `mem` row for `file:<A1>` follows it; `/memory show Фрол` shows the new description and a relationship from the edited text, filed "from #3" at that row |
| `/memory undo <msg>` takes a pass back and the lane does not repeat it; `/memory refile <msg>` writes it again | d | The person's `revert` row, then nothing on `/memory wait`; `/memory refile 5` queues it, and a third row for `file:<A2>` brings Фрол's memory and the event back |
| (lenient reading) | e | A ```` ```json ```` fence; a memory with no `changed_*` dropped (`· 1 skipped`) while the item stays; `{"items": […]}` with flat items, «персонаж»/«место», `parentLocation` → `parent_location`, `role: "злодей"` skipped as a field; `{"filings": []}` closes its key |
| (the historian) | f | After three player turns: a summary and an `[Arc]` overview for the book's plot «Украденный свет» (no new plot); three turns later a second window from U4, the arc rewritten |
| When trimming starts, `{{recap}}` shows the `[Arc]` overview and the summaries; the slot does not change until the boundary moves | g | U7's request trims U1…A4; `/trace` prints the slot: the arc at H1's revision, H1's summary, boundary U5; `/preview` (after H2 rewrote the arc) shows one `recap` message right after the greeting with H1's text; the swipe A7′ was sent with the same slot |
| `kill -9` during filing → after reopening, exactly one effective row per key | h | A 60 s filing call is killed after its `job{begin}`; the next open queues it again (the same attempt: a kill is no failure) and it runs once; the journal has one `mem` row for the key and no `failed` row; a third open finds nothing to do |
| 300 messages on a local server, preemption without an attempt; a quick swipe does not wake the background | §3 | Engine tests with a one-place origin and fake timers; the live recipe in §4 |

## 1. The setup (`test/demo-m5b/`)

| File | What it is |
|---|---|
| `lantern.test.ts` | The demo: the six CLI runs in one home (`beforeAll`), one test per step (a–h), one for the kept requests, one that prints the transcript |
| `script.txt` | The 36 lines typed into the first `rp-core chat` |
| `chat.jsonl` | The scripted model for it: a caps line (`contextLength: 4096`), then 19 calls in the order they are asked for: 9 narrator answers, 8 filing passes, 2 historian passes |
| `crash.txt`, `crash.jsonl` | The second chat: one more message; its answer, then a filing call that sleeps 60 s (`{"delay": 60000}`) |
| `recover.txt`, `recover.jsonl` | The third chat: `/memory wait`, `/memory show Арсений Кеттер`; the filing answer of the rerun |
| `again.txt`, `again.jsonl` | The fourth chat: `/memory wait`, `/memory status`; a script with no calls (any call would fail) |
| `turn-first.test.ts` | The lane starts nothing while a turn runs (fix 1, §5) |
| `seed.test.ts` | `tools/fixtures/seed-innkeeper.ts --compendium off\|on` (D-182) |

The world is M5a's (docs/M5A-DEMO.md): the narrator card «Рассказчик» and the persona Ян
(`test/demo-m5a/card.json`, `persona.json`), and the RoleCall book `lantern`
(`test/fixtures/ru/lantern/lantern.compendium.json`: 15 live typed entries, the `[Arc]` overview of
«Украденный свет», a summary with a foreign `turn_range`). The story continues M5a's: Ян takes the
glass of the stolen lantern to the lighthouse.

`config.toml` (written before `rp-core new`, so the session starts from it):

- `[compendium] idle_delay_sec = 0`: the lane starts as soon as a turn has settled. The default (8 s)
  is for a person at a keyboard; a piped script would wait it out on every line.
- `[compendium.historian] interval = 3`: a historian pass after every three player turns.
- The scripted caps' 4 096-token window: `profile = "auto"` runs lite, the reply reserve is 2 048,
  and the history no longer fits from the 7th exchange on, so the slot has a cut to stand at.

Everything else is the default: `filing.wait = 1`, `every_n = 1`, the recorder is the narrator's
connection (one place: the scripted connection serves one call at a time), the Director is off.

**How the scripted calls stay in order.** The scripted provider hands out its lines in order, whoever
asks. In auto mode the lane starts a pass the moment a turn settles, so the order is fixed when no
two calls race: every line that gives the lane work (a message from U2 on, `/e`, `/memory refile`) is
followed by `/memory wait`, which waits until the lane is idle. The filing and historian answers take
200 ms (a `{"delay": 200}` step), so a pass ends while the REPL waits on `/memory wait`, and its line
prints there; the test reads a line and the wait after it together, so the claims do not depend on
that timing. The test sets `RP_CORE_LANE=auto` for the chats because its preload makes `manual` the
default for tests; for a person `auto` is the default. `EDITOR=` and `VISUAL=` make `/e 3` edit in
place and take the next piped line as the new text.

Message numbers on the path (`#n`, as `/show` numbers them): #1 the greeting, #2 U1, #3 A1, #4 U2,
#5 A2, #6 U3, #7 A3, #8 U4, #9 A4, #10 U5, #11 A5, #12 U6, #13 A6, #14 U7, #15 A7 (A7′ after the
swipe), #16 U8, #17 A8.

## 2. The run

The transcript is the test's own output (`bun test test/demo-m5b/lantern.test.ts`), cut where long
(`…`; the narrator's answers after their first sentence). The home is `<home>`. Session and message
ids, and journal row numbers that depend on them, differ from run to run; everything else is the same
on every run.

### Setup

```
$ cat <home>/config.toml
[compendium]
idle_delay_sec = 0

[compendium.historian]
interval = 3
$ rp-core --home <home> import test/fixtures/ru/lantern/lantern.compendium.json
lantern
rp-core: warning: RoleCall's stored tree and node constraints are dropped: rp-core derives the tree from the entries (tree)
rp-core: imported lorebook "Lantern" as <home>/library/lorebooks/lantern.json
rp-core: hint: /lore add lantern in the chat, or rp-core new --lore lantern
$ rp-core --home <home> new --card test/demo-m5a/card.json --persona test/demo-m5a/persona.json --lore lantern --no-chat
s_c29423b5
rp-core: created session s_c29423b5 "Рассказчик" with 1 greeting (card imported as library character рассказчик; lorebooks lantern)
```

### a. Filing after accepted answers

```
$ EDITOR= VISUAL= rp-core --home <home> chat s_c29423b5 --keep-requests --provider script:test/demo-m5b/chat.jsonl < test/demo-m5b/script.txt
session s_c29423b5 · Рассказчик · narrator script:default (tools: off) · ctx 4096
Рассказчик › Ночь опускается на портовый город. Ян стоит у причала с тяжёлым свёртком в руках: внутри что-то звякает, будто стекло о латунь. …
  [greeting 1/1]
you        › /memory list
The Compendium of this path: 16 live · /memory show <ref> prints one
Cast (3)
  C1  Арсений Кеттер (aka Старшина, Арсений) — Старшина Гильдии фонарщиков, сорок лет зажигает огни Вельмара. [lib: lantern] [featured] [1.6k]
…
  C15 Туманник — Тень в тумане, которая боится огня. [lib: lantern] [355]
Arcs (1)
  C16 [Arc] Украденный свет — Маяк погас, фонарь пропал вместе со смотрительницей. Гильди… [lib: lantern] [148]
you        › — Отвезёшь меня к Серому маяку? Мне нужно отдать этот свёрток Мире.
Рассказчик › Лодочник, сухой старик с седой косицей, кивает на корму. — Садись. …
  [swipe 1/1 · 0.4s · end]   /r swipe  /c continue  /e edit
you        › — А кто, по-твоему, мог снять фонарь?
Рассказчик › Фрол долго гребёт молча, и туман смыкается за кормой. — Гильдия грешит на Соляной суд, — говорит он наконец. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ memory: filing #3 → +2: C17 "Фрол", C6 "Серый маяк"
the background lane is idle
you        › /memory list character
Character entries on this path: 4 live · /memory show <ref> prints one
Cast (4)
  C1  Арсений Кеттер (aka Старшина, Арсений) — Старшина Гильдии фонарщиков, сорок лет зажигает огни Вельмара. [lib: lantern] [featured] [1.6k]
  C2  Селина Бранд — Хочет, чтобы свет принадлежал городу. [lib: lantern] [406]
  C3  Ульяна (aka Смотрительница) — Смотрительница Серого маяка, тридцать зим не пропустившая ни одной ночи. [lib: lantern] [338]
  C17 Фрол (aka лодочник) — Старый лодочник Вельмара с седой косицей; сорок лет возит людей через гавань. [249]
```

What it shows:

- **The work is derived, not queued by hand** (D-171). The lane looks at the path after every change.
  After U1 nothing is due: A1 is accepted only once the player answers it (`filing.wait = 1`), and the
  greeting is card material, never filed. Sending U2 accepts A1. The lane starts nothing while the
  turn runs (§5, fix 1), and starts the pass when the turn has settled.
- **One pass, one key.** The journal gets `job{begin, attempt: 1}`, then one `mem` row with key
  `file:<A1>`, `on` A1 and `range` [U1, A1], written by `filing`, with its `gen` (`profile: lite`,
  `transport: tagged`: the scripted model has no structured output, so the JSON is read from text).
- **Overlays, not duplicates.** The pass filed a location named «маяк». That is the alias of the
  book's «Серый маяк» (C6), so the entry gets this session's additions as an overlay; `/memory list`
  later marks it `[lib: lantern, edited]`. Фрол is new: C17, after the book's sixteen.
- The lane's line names the pass by its message (`filing #3`) and each entry it changed, once.

### b. A swipe takes the answer's entries off the path; `/[` brings them back

```
you        › /rewind 2
you        › — Отвезёшь меня к Серому маяку? Мне нужно отдать этот свёрток Мире.
rewound to your message 2: /r asks for a new answer to it; a line you type now follows it as another message of yours (/rewind 1 to replace it instead); the rest stays as a branch (/tails)
you        › /r
Рассказчик › Лодку держит у причала не старик, а широкоплечая женщина в мокром плаще. …
  [swipe 2/2 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory list character
Character entries on this path: 3 live · /memory show <ref> prints one
Cast (3)
  C1 Арсений Кеттер (aka Старшина, Арсений) — Старшина Гильдии фонарщиков, сорок лет зажигает огни Вельмара. [lib: lantern] [featured] [1.6k]
  C2 Селина Бранд — Хочет, чтобы свет принадлежал городу. [lib: lantern] [406]
  C3 Ульяна (aka Смотрительница) — Смотрительница Серого маяка, тридцать зим не пропустившая ни одной ночи. [lib: lantern] [338]
you        › /memory wait
the background lane is idle: nothing to do
you        › /[
Рассказчик › Лодочник, сухой старик с седой косицей, кивает на корму. — Садись. …
  [swipe 1/2 · 0.4s · end]   /r swipe  /c continue  /e edit
  ⋯ 1 more message on this branch (/show) ⋯
Рассказчик › Фрол долго гребёт молча, и туман смыкается за кормой. — Гильдия грешит на Соляной суд, — говорит он наконец. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory list character
Character entries on this path: 4 live · /memory show <ref> prints one
Cast (4)
  C1  Арсений Кеттер (aka Старшина, Арсений) — Старшина Гильдии фонарщиков, сорок лет зажигает огни Вельмара. [lib: lantern] [featured] [1.6k]
  C2  Селина Бранд — Хочет, чтобы свет принадлежал городу. [lib: lantern] [406]
  C3  Ульяна (aka Смотрительница) — Смотрительница Серого маяка, тридцать зим не пропустившая ни одной ночи. [lib: lantern] [338]
  C17 Фрол (aka лодочник) — Старый лодочник Вельмара с седой косицей; сорок лет возит людей через гавань. [249]
```

The pass's row is bound to A1 (`on`), and the Compendium is folded from the rows on the active path.
The swipe made a new answer A1′ (Агафья instead of Фрол) on a new branch: the row of A1 is off the
path, so Фрол and the overlay of the lighthouse are too. A1′ has no message after it, so it is not
accepted, and `/memory wait` finds nothing to do: a swipe before acceptance costs no call. `/[` goes
back to A1 and the branch below it (head A2): the row is on the path again, and so is Фрол. The test
checks the journal: no job row and no request between the swipe and `/[`.

### c. An edit makes the pass stale; the lane files it again

```
you        › /e 3
editing in place: Enter saves · Ctrl+C cancels · ⏎ is a line break · set $EDITOR to use an editor
edited message 3
Рассказчик › Лодочник, сухой старик с седой косицей, кивает на корму. — Садись. …
you        › /memory wait
⋯ memory: filing #3 → +2: C17 "Фрол", C6 "Серый маяк"
the background lane is idle
you        › /memory show Фрол
C17 Фрол · character · character:фрол
  aka: лодочник
  origin: this session, filed by the filing agent from #3 (file:f66d4559) at journal row 22

  # Фрол

  Лодочник Вельмара с седой косицей; двадцать лет был смотрителем Серого маяка, пока ключи не приняла Ульяна.

  ## Role
  ally

  ## Current state
  Location: гавань Вельмара
  Status: alive

  ## Relationships
  - Nature: ally; Notes: передал ей ключи от маяка; Status: past; With: Ульяна
```

The person rewrote A1 (Фрол was the lighthouse keeper for twenty years before Ульяна). The `edit`
row touches A1 after the pass's row, so the pass is stale (D-74), and the key is debt again: the lane
ran it at once with the new text. The new row (journal row 22) has the same key and replaces the old
one; the pass was staged against the Compendium without the key's own rows, so the new description
and the relationship with Ульяна are its own (the lead's ruling H).

### d. `/memory undo`, then `/memory refile`

```
you        › — Значит, Соляной суд. Мира должна это услышать. Греби быстрее!
Рассказчик › Лодка ткнулась в камни под маяком. Наверху, в фонарной башне, мигнул слабый огонёк, будто кто-то прикрыл лампу ладонью. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ memory: filing #5 → +2: C17 "Фрол", C18 "Лодка с солью"
the background lane is idle
you        › /memory undo 5
undone: filing #5; what it wrote leaves the Compendium from the next turn (/memory refile #5 file runs it again)
⋯ memory: undo → −2: C17 "Фрол", event "Лодка с солью"
you        › /memory list event
Event entries on this path: 1 live · /memory show <ref> prints one
Events (1)
  C10 Погасший маяк — Серый маяк погас без ветра и дождя; утром фонаря на крюке не было. [lib: lantern] [365]
you        › /memory wait
the background lane is idle: nothing to do
you        › /memory refile 5
filing #5 queued again (/memory wait waits for it)
you        › /memory wait
⋯ memory: filing #5 → +2: C17 "Фрол", C18 "Лодка с солью"
the background lane is idle
```

The pass of A2 came in a ```` ```json ```` fence and gave Фрол a memory (the salt boat he saw on the
night of the theft) and a new event. `/memory undo 5` wrote one human row: `mem{key: null, on: A2,
by: user, ops: [{op: revert, key: file:<A2>}]}`; the event and Фрол's memory left the Compendium. A
reverted key counts as done, so `/memory wait` has nothing to do: the lane does not repeat an undone
pass (D-74, D-180). The undo line's way back names the kind of pass it took back (`file`): a bare
`/memory refile 5` runs every pass bound to the message, a historian's too once one covers it. Here
only the filing pass is bound, so `/memory refile 5` queues the same key by name (not journaled: it
lasts while the session is open); its new row is newer than the revert, so the entries are back.

### e, f. Lenient reading; the historian

```
you        › — Поднимемся наверх. Там кто-то есть, я видел свет.
Рассказчик › Лестница в фонарную башню скрипит под ногами, и с каждым витком сильнее пахнет копотью и солью. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ memory: filing #7 → +2: C19 "Мира", C7 "Латунный фонарь"
⋯ memory: historian #1–#7 → +2: C20 "Переправа к маяку", C21 [Arc] "Украденный свет"
the background lane is idle
you        › /memory list
The Compendium of this path: 21 live · /memory show <ref> prints one
Cast (5)
  C1  Арсений Кеттер (aka Старшина, Арсений) — Старшина Гильдии фонарщиков, сорок лет зажигает огни Вельмара. [lib: lantern] [featured] [1.6k]
  C2  Селина Бранд — Хочет, чтобы свет принадлежал городу. [lib: lantern] [406]
  C3  Ульяна (aka Смотрительница) — Смотрительница Серого маяка, тридцать зим не пропустившая ни одной ночи. [lib: lantern] [338]
  C17 Фрол (aka лодочник) — Лодочник Вельмара с седой косицей; двадцать лет был смотрителем Серого маяка… [503]
  C19 Мира (aka младшая фонарщица) — Младшая фонарщица Гильдии, ученица Арсения Кеттера. [275]
…
  C18 Лодка с солью — В ночь, когда погас маяк, у Старой пристани стояла чужая лодка, гружённая… [253]
Plots (1)
  C11 Украденный свет — Кто снял Латунный фонарь с Серого маяка и зачем. [lib: lantern] [featured] [370]
…
Narrative (2)
  C14 Фонарь погас — Ночь, когда маяк ослеп. [lib: lantern] [524]
  C20 Переправа к маяку — Фрол везёт Яна к тёмному маяку. [487]
Bestiary (1)
  C15 Туманник — Тень в тумане, которая боится огня. [lib: lantern] [355]
Arcs (2)
  C16 [Arc] Украденный свет — Маяк погас, фонарь пропал вместе со смотрительницей. Гильди… [lib: lantern] [148]
  C21 [Arc] Украденный свет — Маяк погас, Латунный фонарь сняли. Ян привёз Мире стекло фо… [160]
you        › — Кто это был? Ты видела их лица?
Рассказчик › Ульяна качает головой и плотнее кутается в парус. — Лиц не видела, все были в масках. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ memory: filing #9 → +1: C3 "Ульяна" · 1 skipped
the background lane is idle
you        › — Тогда к Арсению, в Фонарный ряд. Фрол ещё ждёт у камней?
Рассказчик › Фрол ждёт у камней, кутаясь в плащ, и молча помогает спустить Ульяну. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ memory: filing #11 → +2: C22 "Хромой стражник", C23 "Подвалы Соляного суда" · 1 skipped
the background lane is idle
you        › — Арсений! Фонарь держат в подвалах Соляного суда!
Рассказчик › Арсений Кеттер выходит на крыльцо мастерской в одной рубахе, с лампой в руке, и слушает, не перебивая. …
  [swipe 1/1 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ memory: filing #13 → nothing to file
⋯ memory: historian #8–#13 → +2: C24 "Ульяна в фонарной башне", C21 [Arc] "Украденный свет"
the background lane is idle
```

What the scripted answers exercise, and what the test checks in the journal and the fold:

- **#7**: a character the book does not have (Мира, C19) and an overlay of the book's item (the lantern's
  `condition`).
- **#9**: the item is filed under «Смотрительница», Ульяна's alias, so it becomes her overlay (C3). Of
  its two memories the second has neither `changed_belief` nor `changed_behavior`: that memory is
  dropped and the item kept, with one `skipped` line in the row (`memory_rule: …`, D-175).
- **#11**: `{"items": [...]}` with flat items, Russian type names («персонаж», «место»), camelCase
  `parentLocation` (read as `parent_location`) and `role: "злодей"`, which is no role: that one field is
  skipped (`bad_enum: …`), the character is filed without it.
- **#13**: `{"filings": []}`: nothing to file still writes a row (`ops: []`), so the key is done.
- **The historian** (D-176). Three player turns past an empty watermark make it due when A3 is
  accepted: the window is #1–#7, from the greeting (the book's summary «Фонарь погас» with its foreign
  `turn_range` does not move the watermark). It wrote a summary under the book's plot «Украденный свет»
  (its digest says to reuse plot names: no new plot) and an overview of that plot, the session arc
  C21. The book's own `[Arc]` (C16) stays in the list; in the slot the session arc replaces it (the
  lead's ruling G). Three turns later (U4, U5, U6) the second window is #8–#13, after an overlap of
  #4–#7 that the prompt marks as already summarised (lite: up to six messages back, within a third of
  the window's token cap); its key and range start at U4. It rewrote the arc whole: C21's text is now
  the second overview.

### g. The `{{recap}}` slot once trimming starts

```
you        › /trace
trace of 9aa78435 · script:default
  window 4096 · reserve 2048 · prompt ~1269 tok · 13 messages sent
  trimmed: 5a964bfb … 67f5a779 · prefill: none
  unknown macros: none
  lore: nothing fired · budget 307 tok
  lore not fired (recomputed from its seed):
    ✗ 1 entry: no-key-match 1
  ! Since this answer was written, the Compendium changed: the preview is built with today's. (preview_inputs_changed)
  compendium: lite · picked 12: C23 "Подвалы Соляного суда" (mention), C1 "Арсений Кеттер" (mention), C3 "Ульяна" (window), … · injected 5: C23 "Подвалы Соляного суда" brief 50 tok, C1 "Арсений Кеттер" brief 150 tok, C3 "Ульяна" brief 124 tok, C19 "Мира" brief 61 tok, C17 "Фрол" brief 114 tok · cut by the budget 7: … · 1 hidden by freshness · block 505 tok
  recap: 1 arc: C21 "Украденный свет" rev 41 · 1 summary: C20 "Переправа к маяку" · boundary 1f6b8745
  calls: narrator script:default 0.0s
you        › /preview
preview of a swipe (a new answer to 327ff300) · script:default
  window 4096 · reserve 2048 · prompt ~1269 tok (o200k) · 13 messages · nothing was sent

#1 system · main · 42 tok
…
#6 assistant · history · 57 tok
Ночь опускается на портовый город. Ян стоит у причала с тяжёлым свёртком в руках: внутри что-то звякает, будто стекло о латунь. Старый лодочник уже отвязывает лодку.

#7 system · recap · 156 tok
[Arc] Украденный свет
Маяк погас, Латунный фонарь сняли. Ян привёз Мире стекло фонаря, а лодочник Фрол видел в ночь кражи лодку с солью у Старой пристани: след ведёт к Соляному суду.

[Summary: Переправа к маяку]
Лодочник Фрол перевёз Яна через гавань к Серому маяку и рассказал, что в ночь кражи у Старой пристани стояла лодка с солью, а один мешок звенел. У маяка Мира развернула свёрток Яна: в нём было целое стекло Латунного фонаря.

#8 user · history · 15 tok
— Кто это был? Ты видела их лица?
…
#12 system · compendium:block · 443 tok
[Retrieved World Knowledge]
[Lore: Подвалы Соляного суда]
…
#13 user · history · 23 tok
— Арсений! Фонарь держат в подвалах Соляного суда!
…
you        › /r
Рассказчик › Арсений молча выслушивает Ульяну, потом долго смотрит на стекло в руках Миры, и в его глазах отражается огонёк лампы. …
  [swipe 2/2 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /trace
trace of 4fbcdd15 · script:default
  window 4096 · reserve 2048 · prompt ~1269 tok · 13 messages sent
  trimmed: 5a964bfb … 67f5a779 · prefill: none
…
  recap: 1 arc: C21 "Украденный свет" rev 41 · 1 summary: C20 "Переправа к маяку" · boundary 1f6b8745
  calls: narrator script:default 0.0s
you        › /quit
```

- **Trimming starts at U7.** In the 4 096 window U7's request no longer holds the whole history:
  U1…A4 (#2–#9) are trimmed, U5 (#10) is the first message kept, the greeting stays. Now the slot has
  a cut to stand at (D-178): one system message right after the greeting, with the arc overview
  first and the summaries whose range touches the trimmed part. The 4 096 window gives it at most
  409 tokens (10 %); it takes 156.
- **`/trace` names the slot**: the arc C21 at revision 41 (the journal row of H1, which wrote it), the
  summary C20, and the boundary (U5).
- **The slot does not change while the boundary holds.** H2 ran after U7's turn and rewrote the arc,
  and its summary covers #8–#13, which reach into the trimmed part. Yet `/preview` (the next request:
  a swipe of A7) shows the arc as H1 wrote it, and only H1's summary: the boundary is still U5, so the
  slot renders the same ids and the same arc revision as the request before it (D-178; an older
  revision's text is read back from the row that wrote it). The swipe A7′ was sent with that slot:
  its `/trace` prints the same `recap:` line. The slot moves on when the cut does. The test also
  checks that the slot is the only `recap` message and sits right after the greeting.
- The `!` line is `/trace` saying that it recomputes the lore it did not fire with today's Compendium,
  which changed after the answer (H2).

### h. `kill -9` during a filing call

```
$ rp-core --home <home> chat s_c29423b5 --provider script:test/demo-m5b/crash.jsonl < test/demo-m5b/crash.txt    # kill -9 once the job row is written
session s_c29423b5 · Рассказчик · narrator script:default (tools: off) · ctx 4096
Рассказчик › Арсений молча выслушивает Ульяну, потом долго смотрит на стекло в руках Миры, и в его глазах отражается огонёк лампы. …
  [swipe 2/2 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › — Я пойду с вами. Что мне нести?
Рассказчик › Ночь в Фонарном ряду проходит без сна. Мира чистит стекло мягкой тряпицей, Ульяна греется у печи и понемногу рассказывает про ту ночь, Фрол дремлет на лавке, не выпуская весла. …
  [swipe 1/1 · 0.4s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
$ rp-core --home <home> chat s_c29423b5 --provider script:test/demo-m5b/recover.jsonl < test/demo-m5b/recover.txt
session s_c29423b5 · Рассказчик · narrator script:default (tools: off) · ctx 4096
Рассказчик › Ночь в Фонарном ряду проходит без сна. Мира чистит стекло мягкой тряпицей, Ульяна греется у печи и понемногу рассказывает про ту ночь, Фрол дремлет на лавке, не выпуская весла. …
  [swipe 1/1 · 0.4s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
⋯ memory: filing #15 → +1: C1 "Арсений Кеттер"
the background lane is idle
you        › /memory show Арсений Кеттер
C1 Арсений Кеттер · character · lib:lantern:00000000-0000-4000-8000-000000000e01
  aka: Старшина, Арсений
  origin: the library book lantern, entry 00000000-0000-4000-8000-000000000e01; changed in this session (an overlay: the book file stays as it is)
  last changed at journal row 76 by the filing agent from #15 (file:4fbcdd15)
…
  ## Current state
  Condition: собирает старших фонарщиков, чтобы идти в суд с огнём
  Location: Фонарный ряд
  Status: alive
…
  ## Memories
…
  - Changed behavior: ведёт Гильдию в суд открыто, с зажжёнными лампами; What happened: Узнал, что Латунный фонарь держат в подвалах Соляного суда
…
you        › /quit
$ rp-core --home <home> chat s_c29423b5 --provider script:test/demo-m5b/again.jsonl < test/demo-m5b/again.txt
session s_c29423b5 · Рассказчик · narrator script:default (tools: off) · ctx 4096
Рассказчик › Ночь в Фонарном ряду проходит без сна. Мира чистит стекло мягкой тряпицей, Ульяна греется у печи и понемногу рассказывает про ту ночь, Фрол дремлет на лавке, не выпуская весла. …
  [swipe 1/1 · 0.4s · end]   /r swipe  /c continue  /e edit
you        › /memory wait
the background lane is idle: nothing to do
you        › /memory status
the Compendium's background lane is idle: nothing queued, nothing parked
you        › /quit
```

- **The kill.** U8 accepts A7′, and when the turn has settled the lane begins its pass: `job{begin,
  attempt: 1}` is written (durably) before the call, and the scripted call sleeps 60 s. The test waits
  for that row and for the `/memory wait` echo, then sends SIGKILL. Nothing else is written: no `mem`
  row, no `failed` row.
- **Reopened** (D-171 recovery, rule 1): a `job{begin}` with no row of its key after it is queued again
  by name. A kill is not a failed attempt, so the rerun is attempt 1 again. The stale lock of the killed
  process is taken over. The pass runs with the next scripted answer and overlays the book's Арсений
  Кеттер (a memory with `changed_behavior`).
- **Once.** The journal has two `job{begin}` rows for `file:<A7′>`, both attempt 1, and exactly one
  `mem` row for it; no `failed` row anywhere. Opened a third time on a script with no calls, the lane
  finds nothing to do; `/memory status` is idle. The test also checks every key the lane wrote: one
  row after its newest begin.

### The kept requests

The first chat ran with `--keep-requests`, which keeps lane calls too: 19 files in all, 9 narrator
requests (`t_<turn>_narrator_0.json`), 8 filing and 2 historian requests (`j_<job>_filing_0.json`,
`j_<job>_historian_0.json`). The historian's requests number the path positions from 1 (`[1]
assistant: Ночь опускается на портовый город. …`, D-176); the second one says «Messages 4 to 7 are
OVERLAP from the previous window (already summarized; …)» and «Messages 8 to 13 are NEW and need
summarizing.»

## 3. The timing claims

The first two §15 claims are about time on a local server: what a pass does while the player types,
and what it does to the narrator's cache. A piped script never races a turn (every line waits for
the one before), and the demo sets `idle_delay_sec = 0`, so they are checked where time can be
controlled:

- **Preemption without an attempt**: `test/lane-m5b/lane.test.ts`, "a turn on a capacity-1 origin
  preempts the filing call": a filing call held open, a turn on the same one-place connection; the
  pass is preempted, queued again, and its next `job{begin}` has the same attempt; no `failed` row.
  The scheduler's rules (an interactive request preempts background, a local origin keeps background
  off while interactive work is about): `test/sched-m5b/`.
- **`idleDelaySec`**: `test/lane-m5b/lane.test.ts`, "a local origin: the task waits idleDelaySec after
  the last activity, then runs by itself": with fake timers, nothing is sent at 7 999 ms, the filing
  request at 8 000 ms.
- **A turn first** (fix 1, §5): `test/demo-m5b/turn-first.test.ts`.

The 300-message run on a local server and the warm cache are left to a live run by hand (§4,
"Running the lantern script live").

## 4. Live runs on Ollama

M5b ran three times on a local model: Mag-Mell 12B (`magmell-16k:latest`) on Ollama, with a
16 384-token window, so `profile = "auto"` runs lite for the Compendium and the Director. The story is
M5a's live one (docs/M5A-DEMO.md §3): Марфа's inn, the persona Елисей and the RoleCall book
`innkeeper`. Run 1 was made before the review fixes, runs 2 and 3 after them; between runs 2 and 3
D-183 was amended to name the story's language. Everything below is the real output: ANSI codes
stripped, long answers cut with `…`, the home written `<home>`.

### Setup

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

[compendium]
idle_delay_sec = 2

[compendium.historian]
interval = 3
TOML
rp-core --home $H import test/fixtures/ru/innkeeper-compendium/innkeeper.compendium.json
id=$(rp-core --home $H new --card test/fixtures/ru/innkeeper-200/card.json \
  --persona test/fixtures/ru/innkeeper-200/persona.json --lore innkeeper \
  --model ollama:magmell-16k:latest --max-tokens 300 --no-chat)
rp-core --home $H chat $id --keep-requests < $H/script.txt 2>&1 | tee $H/run.log
```

The recorder (filing and the historian) follows the narrator: the same connection and model (D-85).
`idle_delay_sec = 2` instead of the default 8 s only shortens each wait; the piped script waits for
the lane anyway. The script of runs 1 and 2:

```
Добрый вечер. Найдётся ли у вас комната на ночь? Я землемер, иду в Велеград.
А что за шум был на дороге? Говорят, мост в Горелой балке совсем плох.
/memory wait 300
Расскажите, кто у вас тут бывает. Кажется, вон тот охотник на меня косится.
/memory wait 300
Говорят, на гати за бором шалит какой-то Сыч?
/memory wait 300
/memory status
/memory
Это фонарь вашего мужа, Гордея? Он висит у двери.
/memory wait 300
/memory undo 9
/memory refile 9
/memory wait 300
/memory status
/memory
/trace
/quit
```

Run 3 is the short one: `interval = 2`, the first three messages with their waits, then
`/memory list summary` and `/memory list arc`.

Message numbers on the path: #1 the greeting, #2 U1, #3 A1, #4 U2, #5 A2, #6 U3, #7 A3, #8 U4, #9 A4,
#10 U5, #11 A5.

### Run 1: the lane on a real model

```
session s_3f4a8c4d · Марфа · narrator ollama:magmell-16k:latest (tools: prompted) · director ollama:magmell-16k:latest (auto) · ctx 16384
Марфа › Дверь «Сонного гуся» с натугой подалась, впустив в общую залу порыв сырого ветра, горсть мокрых листьев и запах раскисшей дороги. …
  [greeting 1/1]
you   › Добрый вечер. Найдётся ли у вас комната на ночь? Я землемер, иду в Велеград.
  ⋯ director: planned — seeds +1 · chapter 1
Марфа › Марфа кивнула, позвав Митяя присмотреть за конём путника. …
  [swipe 1/1 · 300 tok · 16.2s · length]   /r swipe  /c continue  /e edit
you   › А что за шум был на дороге? Говорят, мост в Горелой балке совсем плох.
  ⋯ director: planned — no changes
Марфа › Марфа кивнула с тревогой в глазах. …
  [swipe 1/1 · 300 tok · 15.5s · length]   /r swipe  /c continue  /e edit
you   › /memory wait 300
⋯ memory: filing #3 → +3: C11 "Марфа", C12 "Елисей", C13 "Шайка Сыча"
the background lane is idle
you   › Расскажите, кто у вас тут бывает. Кажется, вон тот охотник на меня косится.
  ⋯ director: planned — seeds ~1
Марфа › Марфа обернулась и glances towards the old map on the shelf, her gaze lingering on it for a moment before replying. …
  [swipe 1/1 · 300 tok · 17.1s · length]   /r swipe  /c continue  /e edit
you   › /memory wait 300
⋯ memory: filing #5 → +1: C11 "Марфа"
the background lane is idle
you   › Говорят, на гати за бором шалит какой-то Сыч?
  ⋯ director: planned — no changes
Марфа › Марфа испуганно перекрестилась и шепотом начала свой story: " Months ago, a merchant, Vitaly his name, he stopped here, needing shelter for the night, like thee. …
  [swipe 1/1 · 300 tok · 14.7s · length]   /r swipe  /c continue  /e edit
you   › /memory wait 300
⋯ memory: filing #7 → +1: C11 "Марфа"
⋯ memory: historian #1–#7 → +2: C14 "The Waylaid Traveler", C15 [Arc] "Пропавший обоз"
the background lane is idle
you   › /memory status
the Compendium's background lane is idle: nothing queued, nothing parked
you   › /memory
The Compendium of this path: 15 live · /memory show <ref> prints one
Cast (5)
  C1  Глеб (aka охотник) — Охотник из Соснового бора: угрюмый бородач в волчьей шапке, говорит мало, лес… [lib: innkeeper] [558]
  C2  Сыч (aka атаман) — Атаман лихих людей со старой гати за Сосновым бором. [lib: innkeeper] [402]
  C3  Савелий Рогов (aka Рогов) — Купец из Лисьего Брода, крепкий и обстоятельный; каждую осень ведёт на север… [lib: innkeeper] [399]
  C11 Марфа — Хозяйка постоялого двора у Соснового бора, внимательная и заботливая женщина… [1.5k]
  C12 Елисей (aka землемер) — Путник, идущий в Велеград, который остановился на постоялом дворе у Соснового… [249]
Places (3)
  C4  Горелая балка — Овраг на тракте к Лисьему Броду; через него — старый мост на сваях. [lib: innkeeper] [238]
  C5  Велеград — Большой торговый город на севере, куда ведёт Старый тракт; осенью там шумит… [lib: innkeeper] [166]
  C6  Старая мельница — Заброшенная мельница у Чёртова омута: крыша провалилась, колесо стоит. [lib: innkeeper] [299]
Items (1)
  C8  Фонарь Гордея (aka фонарь мужа) — Медный фонарь со слюдяными оконцами, с которым покойный Гордей ходил на перевоз. [lib: innkeeper] [309]
Organizations (1)
  C7  Ватага Сыча (aka лихие люди) — Пятеро-шестеро лихих людей на старой гати за бором. [lib: innkeeper] [264]
Events (1)
  C10 Гибель Гордея — Муж Марфы простыл, помогая Лукьяну удержать паром, когда лопнул канат, и умер… [lib: innkeeper] [293]
Plots (1)
  C9  Пропавший обоз (aka обоз Рогова) — Обоз Савелия Рогова из Лисьего Брода запаздывает пятый день. [lib: innkeeper] [396]
Threats (1)
  C13 Шайка Сыча — Банда лихих людей, активная на дороге в Велеград, представляющая угрозу для… [281]
Narrative (1)
  C14 The Waylaid Traveler — A weary traveler, Eлисей, arrives at the 'Sleeping Goose' inn on a rainy… [681]
Arcs (1)
  C15 [Arc] Пропавший обоз — A weary traveler, Eлисей, arrives at the 'Sleeping Goose' i… [458]
you   › Это фонарь вашего мужа, Гордея? Он висит у двери.
  ⋯ director: planned — no changes
Марфа › Marfa's eyes followed Eлисей gaze to the old lantern hanging by the door, and her face softened with a touch of nostalgia and sadness. …
  [swipe 1/1 · 290 tok · 14.8s · end]   /r swipe  /c continue  /e edit
you   › /memory wait 300
⋯ memory: filing #9 → +1: C11 "Марфа"
the background lane is idle
you   › /memory undo 9
undone: filing #9; what it wrote leaves the Compendium from the next turn (/memory refile #9 files it again)
⋯ memory: undo → −1: C11 "Марфа"
you   › /memory refile 9
filing #9 queued again (/memory wait waits for it)
you   › /memory wait 300
⋯ memory: filing #9 → +1: C11 "Марфа"
the background lane is idle
you   › /memory status
the Compendium's background lane is idle: nothing queued, nothing parked
you   › /memory
The Compendium of this path: 15 live · /memory show <ref> prints one
Cast (5)
…
  C11 Марфа — Хозяйка постоялого двора у Соснового бора, внимательная и заботливая женщина… [2.0k]
…
you   › /trace
trace of fdcf46a6 · ollama:magmell-16k:latest
  window 16384 · reserve 300 · prompt ~4475 tok (server: 4711) · 17 messages sent
  trimmed: nothing · prefill: none
  unknown macros: none
  lore: nothing fired · budget 2412 tok
  ! Since this answer was written, the Compendium changed: the preview is built with today's. (preview_inputs_changed)
  compendium: lite · picked 7: C8 "Фонарь Гордея" (mention), C5 "Велеград" (window), C2 "Сыч" (window), C13 "Шайка Сыча" (window), C1 "Глеб" (window), C11 "Марфа" (window), C12 "Елисей" (window) · injected 6: C8 "Фонарь Гордея" brief 71 tok, C5 "Велеград" brief 52 tok, C2 "Сыч" brief 70 tok, C13 "Шайка Сыча" brief 103 tok, C1 "Глеб" brief 96 tok, C11 "Марфа" brief 47 tok · over the entry limit (lite: 6) 1: C12 "Елисей" 73 tok · 5 hidden by freshness · block 445 tok
  calls: director ollama:magmell-16k:latest 8.9s, narrator ollama:magmell-16k:latest 5.9s
  rounds: 1 · prompted tools · ended: answer · tool room 0 of 4021 tok used
you   › /quit
```

The lane's rows in the journal (`<home>/sessions/s_3f4a8c4d.jsonl`), each after its `job{begin,
attempt: 1}`:

| Row | Pass | Range | What it wrote | Call |
|---|---|---|---|---|
| 22 | filing #3 | #2–#3 | Марфа with a memory; Елисей (aka «землемер»); the threat «Шайка Сыча» | 11.2 s |
| 34 | filing #5 | #4–#5 | a memory of Марфа | 5.3 s |
| 46 | filing #7 | #6–#7 | a memory of Марфа | 5.7 s |
| 48 | historian | #1–#7 | the summary «The Waylaid Traveler» under «Пропавший обоз»; the arc of «Пропавший обоз» | 6.9 s |
| 60 | filing #9 | #8–#9 | a memory of Марфа | 5.8 s |
| 61 | `/memory undo 9` | — | `mem{key: null, on: A4, by: user, ops: [{op: revert, key: file:b3b0cf3f}]}` | — |
| 63 | filing #9 again | #8–#9 | the memory, worded anew | 2.7 s |

What it shows:

- **Filing follows acceptance.** Each `/memory wait` finds the pass of the answer that the message
  before it accepted: A1 is filed once U2 accepts it (`filing.wait = 1`), and so on. The greeting is
  never filed, and A5 (#11) is not, since nothing answers it. Every pass ran between turns, and every
  answer was read on the first call (`gen: {profile: lite, transport: tagged, calls: 1}`): no
  corrective pass, nothing skipped, nothing parked.
- **What the lite prompt sends.** The request of filing #3
  (`<home>/sessions/s_3f4a8c4d.requests/j_a9076c63_filing_0.json`) has the roster with the book's
  entries marked, and the two entries the exchange names as brief JSON:

  ```
  COMPENDIUM SNAPSHOT:
  - Сыч (aka: атаман) [character] (library)
  - Велеград [location] (library)
  - Глеб (aka: охотник) [character] (library)
  - Савелий Рогов (aka: Рогов) [character] (library)
  - Горелая балка [location] (library)
  - Старая мельница [location] (library)
  - Ватага Сыча (aka: лихие люди) [organization] (library)
  - Фонарь Гордея (aka: фонарь мужа) [item] (library)
  - Пропавший обоз (aka: обоз Рогова) [plot] (library)
  - Гибель Гордея [event] (library)

  ENTRIES NAMED IN THIS EXCHANGE, AS THEY STAND (send only what is new):
  {"name":"Сыч","aliases":["атаман"],"description":"Атаман лихих людей со старой гати за Сосновым бором.", …}
  {"name":"Велеград","description":"Большой торговый город на севере, куда ведёт Старый тракт; осенью там шумит ярмарка.", …}
  ```

- **What a 12B files.** The card's character and the persona became session entries (C11 Марфа,
  C12 Елисей): nothing in the prompt says to skip them. The selector puts them last in their tier
  (COMPENDIUM-DEVIATIONS C6): the last `/trace` lists them last, and Елисей is over the lite limit of
  six entries. The narrator's «шайка Сыча» became a new threat, C13 «Шайка Сыча», beside the book's
  organization «Ватага Сыча» (aka «лихие люди»), although the roster lists it: a new name of another
  type matches nothing, so the Compendium holds two entries for one gang. No book entry was overlaid
  in this run; in runs 2 and 3 filing edited the book's «Горелая балка», and in run 2 «Сыч»
  (`[lib: innkeeper, edited]`).
- **The historian** was due when U4 accepted A3: three player turns past an empty watermark, so the
  window is #1–#7, from the greeting. It reused the book's plot «Пропавший обоз» (the digest says
  "Existing plots (REUSE these names in parent_plot)") and wrote the session arc C15 for it, but the
  summary and the arc are in English: the summary C14 begins «A weary traveler, Eлисей, arrives at
  the 'Sleeping Goose' inn on a rainy evening. …» (the arc says «stormy»), both with a Latin «E» in
  «Eлисей» and «Goryachaya Balka» for «Горелая балка». The next section follows this up.
- **Undo and refile.** `/memory undo 9` wrote one human row (61), and Марфа lost the memory it had
  added. `/memory refile 9` queued the key again, and the new call (temperature 0.3) worded the memory
  differently. The first said the gang left «метку в виде сокола на двери» (a falcon); the second «знак
  в виде совы» (an owl), as the narrator had it («a owl's talon»). Марфа's entry ends at 2.0k.
  Since the review the undo line names the kind of pass: run 2 prints «(/memory refile #9 file runs it
  again)».
- **No slot.** At 16 384 tokens and 300-token answers nothing is trimmed in five exchanges
  (`trimmed: nothing`), so the `{{recap}}` slot is empty, nothing is reserved and `/trace` has no
  `recap:` line. The scripted run (§2 g) shows the slot.

### The historian's language: runs 1–3

| Run | Code | The prompts' language line | The historian wrote |
|---|---|---|---|
| 1 | before the review | none: `compendium.language` is blank, and Bunraku adds nothing then | «The Waylaid Traveler» |
| 2 | after the review (D-183) | "Write every field value in the language the story is written in." | «The Traveler's Arrival», «The Innkeeper's Tale», a new plot «The Sleeping Goose's History» |
| 3 | D-183 amended (J) | "Write every field value in Russian.", also the user message's last line | «Прибытие землемера в трактир», «Размещение в трактире», «Разговор о дороге в Велеград» |

Filing wrote Russian values in all three runs, even for run 1's English answer #9 (row 60: «Марфа
рассказала Елисею историю о торговце Витале…»). Only the historian answered in English.

Run 1's window held the English and Spanish of A3. Run 2's window #1–#7 was mostly Russian, but its
A3 (#7) opened with an English paragraph («Marfa smiled warmly at Elisey …»), and its historian
request ended with the generic line:

```
… At most 6 filings. Keep each overview under 1200 characters.

Write every field value in the language the story is written in.
```

It still answered in English, and it filed one summary under the book's plot and made a new plot,
named in English, for the other:

```
you   › /memory wait 300
⋯ memory: filing #7 → +1: C11 "Марфа"
⋯ memory: historian #1–#7 → +4: C15 "The Sleeping Goose's History", C16 "The Traveler's Arrival", C17 "The Innkeeper's Tale", C18 [Arc] "The Sleeping Goose's History"
the background lane is idle
…
Plots (2)
  C9  Пропавший обоз (aka обоз Рогова) — Обоз Савелия Рогова из Лисьего Брода запаздывает пятый день. [lib: innkeeper] [396]
  C15 The Sleeping Goose's History [57]
Narrative (2)
  C16 The Traveler's Arrival — A weary traveler named Eлисей arrives at the 'Sleeping Goose' inn on a rainy… [587]
  C17 The Innkeeper's Tale — Marfa begins to share stories about the inn's past and a mysterious hidden… [510]
Arcs (1)
  C18 [Arc] The Sleeping Goose's History — Marfa, the innkeeper of the 'Sleeping Goose', shares tales … [391]
```

So D-183 was amended (the lead's section J): with `compendium.language` blank the lane names the
language from the script of the texts it sends (`agents/compendium/language.ts`), and a named
language is written twice, at the end of the rules and as the last line of the user message. Run 3's
historian request (`<home>/sessions/s_19ab7473.requests/j_8b2fcecd_historian_0.json`) ends:

```
… At most 6 filings. Keep each overview under 1200 characters.

Write every field value in Russian.
```

and its user message:

```
Messages 1 to 5:

[1] assistant: Дверь «Сонного гуся» с натугой подалась, …
…
Summarize the new events.

Write every field value in Russian.
```

Run 3, `interval = 2`:

```
you   › /memory wait 300
⋯ memory: filing #5 → +1: C4 "Горелая балка"
⋯ memory: historian #1–#5 → +4: C12 "Прибытие землемера в трактир", C13 "Размещение в трактире", C14 "Разговор о дороге в Велеград", C15 [Arc] "Пропавший обоз"
the background lane is idle
you   › /memory list summary
Summary entries on this path: 3 live · /memory show <ref> prints one
Narrative (3)
  C12 Прибытие землемера в трактир — В трактир «Сонный гусь» заходит уставший землемер Елисей, направляющийся в… [441]
  C13 Размещение в трактире — Марфа предлагает Елисею комнату на ночь и угощает его ужином. [398]
  C14 Разговор о дороге в Велеград — Елисей спрашивает Марфу о шуме на дороге и узнаёт, что мост в Горелой балке в… [410]
you   › /memory list arc
Arcs on this path: 1 live · /memory show <ref> prints one
Arcs (1)
  C15 [Arc] Пропавший обоз — Елисей, землемер, направляющийся в Велеград, останавливаетс… [286]
you   › /quit
```

All three summaries name the book's plot «Пропавший обоз» as `parent_plot`, and the arc overview
(row 34) reads: «Елисей, землемер, направляющийся в Велеград, останавливается на ночь в трактире
«Сонный гусь». Он беседует с хозяйкой Марфой о цели своей поездки и узнаёт о плохом состоянии моста
в Горелой балке, что может осложнить его путь. Марфа советует быть осторожным и не застревать там на
ночь.» Run 3's window was Russian throughout (one garbled word aside); run 2's was mostly Russian,
with one English paragraph in A3. So the windows were not identical, and this is one run each at
temperature 0.3, not a measurement. The test is `test/language-m5b/`.

### The narrator's English is M4's, not M5b's

In run 1 the narrator slipped into English (and Spanish) in the middle of turn 3 and wrote turns 4
and 5 in English; run 2 slipped an English word into turn 1, and turns 3, 4 and 5 open with an
English paragraph before Russian dialogue (turn 4 also mixes English words into the dialogue); run
3's three turns stayed Russian but for one garbled word. This is the weakness docs/M4-DEMO.md
describes: the Director's contract and its `[DIRECTOR CONSTRAINTS - BINDING THIS TURN]` block are in
English, and D-120's line ("Write the story in the language it is already written in; these
constraints are in English only for you.") helps a 12B but does not cure it. M5b adds nothing
English to the narrator's request while nothing is trimmed: the slot is empty, and the entries
filing put in the block are Russian. The drift began before the historian's first pass, and the
English summary never reached the narrator: nothing was trimmed for the slot to show, and the block
hides a summary while its last message is visible (COMPENDIUM-DEVIATIONS B16).

### What the live runs do not show

- **The slot**: nothing is trimmed in five exchanges at 16 384 tokens. §2 g shows it on the
  scripted model.
- **The timing claims**: the piped script waits on `/memory wait`, so no pass met a turn. §3 checks
  preemption and the idle gate with fake timers; the recipe below says how to see them live.
- **Reading under stress**: every lane answer was read on its first call. Only run 2's filing #9 had
  a field skipped (`filings[1].entry.outcome`: «wrong_kind: outcome must be text»), and its item was
  kept.

### Running the lantern script live

The commands below are a recipe, not a record: they run this document's lantern script (§2) on a
live model, and what a model answers is its own. `magmell-16k:latest` stands for any local model;
use yours, with its `context_length`.

```bash
alias rp-core='bun src/cli/main.ts'
H=$(mktemp -d)
cat > $H/config.toml <<'TOML'
[connections.ollama]
base_url = "http://127.0.0.1:11434"

[caps."ollama:magmell-16k:latest"]
context_length = 16384

[roles]
narrator = "ollama:magmell-16k:latest"     # the recorder (filing, historian) follows the narrator

[compendium.historian]
interval = 3
TOML
rp-core --home $H import test/fixtures/ru/lantern/lantern.compendium.json
id=$(rp-core --home $H new --card test/demo-m5a/card.json --persona test/demo-m5a/persona.json \
  --lore lantern --model ollama:magmell-16k:latest --max-tokens 300 --no-chat)
EDITOR= VISUAL= rp-core --home $H chat $id --keep-requests < test/demo-m5b/script.txt 2>&1 | tee $H/run.log
```

`idle_delay_sec` keeps its default (8 s), and `/memory wait` lines keep the passes between turns.
What to look for:

- **Each pass and what it read.** `⋯ memory:` lines after each `/memory wait`; the filing and
  historian requests in `$H/sessions/$id.requests/j_*`: the lite prompt, the roster with `(library)`
  marks, the historian's numbered positions.
- **Reading a real model's JSON.** `· n skipped` on a lane line, and the `skipped` paths in the `mem`
  rows of the journal (`grep '"t":"mem"' $H/sessions/$id.jsonl`): Russian enum values, a memory with
  no `changed_*`, a fence or prose around the JSON.
- **Overlays.** «маяк», «Смотрительница» and the like should edit the book's entries
  (`[lib: lantern, edited]`), not add new ones.
- **The edit and the undo.** `/e 3` replaces A1 with the scripted edit; `/memory undo 5` and
  `/memory refile 5` act on whatever A2 filed (a second call at temperature 0.3 may file it a little
  differently).
- **The slot.** At 16 384 tokens and 300-token answers nothing is trimmed in 7 exchanges, so `/trace`
  has no `recap:` line. Set `context_length = 4096` in the caps above to see the slot as in §2 (the
  model then sees a 4 096-token window).
- **The timing claims.** Type the lines by hand instead, without the `/memory wait` lines. On a local
  server a pass's call waits until 8 s have passed since the last activity (an answer, a swipe, an
  edit), so a `/r` right after an answer is served before any pass; a message sent while a pass runs
  makes it give way (`filing #n gave way to a turn; it runs again at the next pause`), and its next
  run is the same attempt. `/trace` gives each call's time. `rp-core tui` shows the passes in the
  agents pane.
- **A long chat.** `bun tools/fixtures/seed-innkeeper.ts --home $H --model ollama:magmell-16k:latest
  --max-tokens 300` seeds the 199-message innkeeper chat with the Compendium off (D-182): `/memory on`
  in the chat files only what comes after it. `--compendium on` keeps it on, and the chat opens with
  98 answers to file (`/memory status`; a `memory_backlog` notice).

## 5. Fixes found by the demo

1. **The lane started a pass between a message and its turn** (`src/engine/session.ts`,
   `src/engine/lane.ts`). `submit` is `send`, then the turn. `send` accepts the answer before the
   message and pokes the lane, which in auto mode began that answer's pass at once: on a one-place
   origin its call took the place, and the narrator's call preempted it a moment later. On a scripted
   model the filing call ate the narrator's line (the narrator then answered with the filing JSON); on
   a local server it is a wasted call that refills the server's cache with the filing prompt, every
   message. Fix: in auto mode the lane starts nothing while a turn of its session runs (`LaneHost.busy`),
   and `submit` gives the lane its look once the turn is registered (it starts the pass when the turn
   settles, as it did after every other turn). `memoryWait` still drives the lane at any time; a running
   pass is still preempted as before. Test: `test/demo-m5b/turn-first.test.ts` (it fails without the
   fix).
2. **The `{{recap}}` slot went below the depth-1 inserts** (`src/prompt/assemble.ts`). The slot was put
   right before the first message kept after the cut. When that message is the current one (a short
   chat: the greeting, then the player's first message), the Compendium block and the Director's
   directive (depth 1) are in that same gap, and the slot landed between them and the message, so they
   were no longer right above it (the M5a demo's step c failed). Fix: the slot goes right after the
   greeting (§10's layout: greeting → `{{recap}}` → … → the current message; first in the chat area
   without a greeting), ahead of the depth inserts and the gap note in that gap. Test: the M5a demo,
   step c (`test/demo-m5a/lantern.test.ts`); `test/recap-m5b/` is unchanged and passes.

Also in this unit: `tools/fixtures/seed-innkeeper.ts --compendium off|on` (D-182, default off;
`test/demo-m5b/seed.test.ts`), and docs/M5A-DEMO.md brought to the current output (the book's `[Arc]`
overview is the Compendium's C16 and goes to the slot, so Мира is C17).

The live runs (§4) found one more: **the historian's language** (D-183, `src/agents/compendium/
language.ts`, `src/engine/lane.ts`). With `compendium.language` blank, Bunraku's prompts say nothing
about language, and the 12B historian wrote English summaries of a Russian story (run 1). A generic
line, "Write every field value in the language the story is written in.", did not change that
(run 2). Naming the language, at the end of the rules and as the user message's last line, did
(run 3). Test: `test/language-m5b/`; the prompt tests in `test/filing-m5b/` and
`test/historian-m5b/` pin both lines.
