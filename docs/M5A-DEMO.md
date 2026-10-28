# M5a demo — the Compendium: data and manual memory

Milestone M5a ("Compendium: data and manual memory", ARCHITECTURE.md §15) ends with a demo of six
claims: a RoleCall Compendium export imports, and `/memory tree` shows Cast, Places, Narrative… from
the derived tree; `/memory new character Мира` in `$EDITOR`, then a message that names her puts her
brief entry into `[Retrieved World Knowledge]` at depth 1, above the Director's directive; `/memory
edit` of a library entry leaves the book file as it is, and `/memory show` shows the overlay; a swipe
and a rewind leave the person's edits alone, and a fork keeps the entry keys; `/memory export lantern2
--format compendium` and a re-import give the same entries; with the Director on, `--keep-requests`
shows `[COMPENDIUM CONTEXT]` with Мира in the Director's request. This is that demo: one
deterministic run of the real CLI on a scripted model (§1, §2), a live run on Ollama with the
innkeeper story and a small book (§3), and how to run the lantern script live (§4).

**Result in one line: all six claims pass on the scripted model (`bun test test/demo-m5a`: 9 pass, about
1 s). Live on Ollama (Mag-Mell 12B), the selector picked every entry the player named, and after the
D-169 fix «Это фонарь вашего мужа, Гордея?» brings «Фонарь Гордея» into the block; the answer uses
its facts. Three fixes went in with the demo (§5): two engine rulings it needed, and one help text
it found.**

*Since M5b the book's `[Arc]` overview is no longer plain lore: it is the Compendium entry C16 and goes
to the `{{recap}}` slot right after the greeting (D-177, D-178), so Мира is C17; the transcript below is
the current output.*

The demo runs the real CLI (`bun src/cli/main.ts`) as separate processes in one isolated home:
`import`, `new`, `chat` with the typed lines piped in, and `import` again. Everything between the
keyboard and the model is the real code: the codec, the library seed, the fold with its overlays, the
tree, the selector, the block, the Director's world snapshot, the export. Only the model's answers
(`chat.jsonl`) and the editor (`editor.ts`) are scripted.

Environment: Bun 1.3.14 (`0d9b296a`), Linux 7.0.0-38-generic (x86_64). `bun test test/demo-m5a`:
9 pass, 0 fail, 107 `expect()` calls; the four CLI runs take 0.85–0.95 s.

## What the demo shows

| §15 demo point | Step | What the test asserts |
|---|---|---|
| `rp-core import lantern.compendium.json`, `/lore add lantern`, `/memory tree` shows Cast, Places, Narrative… | a, b | The book is saved as `lantern` (18 entries: 16 typed, 1 `[Arc]`); the tree lists the session's part, then the book's with `Cast · 3`, `Places · 3` (Вельмар with two sub-places), `Narrative · 2`…; `/memory list` gives the book's 15 live typed entries and its `[Arc]` overview the handles C1…C16 |
| `/memory new character Мира` in `$EDITOR`; «…отдай это Миру…» → `/preview` shows her brief in `[Retrieved World Knowledge]` at depth 1, above the directive | c | One human row (`key:null`, `on:null`) with the editor's JSON; C17; `/trace` picks Мира by mention, as a brief; in `/preview` the block and the directive are the two messages right above the last user message, the block first (the `{{recap}}` slot with the `[Arc]` overview above them, right after the greeting); the block starts `[Lore: Мира]` and holds her brief, not the full render |
| `/memory edit` of a library entry: the book file does not change, `/memory show` shows the overlay | d | The book file is byte-identical; the edit row targets `lib:lantern:…e03`; `/memory show` says "an overlay" and prints the new state |
| A swipe and a rewind leave the person's edits alone; a fork keeps the entry keys | e | `/memory list character` prints the same four rows after the swipe, after the rewind and in the fork; the fork's journal has the same human rows; the engine folds both sessions to the same handles and keys |
| `/memory export lantern2 --format compendium`, re-import → the same entries | f | The file is `compendium-v1.0.0` with `tree: null`; it imports as `lantern2`; type, name, aliases and data of each entry equal the session's (Мира and the Ульяна overlay) |
| Director on, `--keep-requests` shows `[COMPENDIUM CONTEXT]` with Мира in its request | g | Three files: the reply's Director and narrator requests and the swipe's narrator request (the swipe reused the plan); the Director's holds `[COMPENDIUM CONTEXT]` with Мира first, the narrator's the block |

## 1. The setup (`test/demo-m5a/`)

| File | What it is |
|---|---|
| `lantern.test.ts` | The demo: the four CLI runs in one home (`beforeAll`), then one test per step and one that prints the transcript |
| `card.json` | A narrator card, «Рассказчик» (CCv2). Its greeting names none of the book's entries, so the block shows only what the message names |
| `persona.json` | The persona Ян (`core.persona/1`) |
| `script.txt` | The 20 lines typed into `rp-core chat` |
| `chat.jsonl` | The scripted model, three calls: the Director's plan (tagged), the answer, the swipe's answer |
| `editor.ts` | The `$EDITOR`: on the empty character template named «Мира» it saves `test/fixtures/ru/lantern/mira.character.json`; on «Ульяна» it rewrites her `current_state`; anything else fails (nothing written) |

The world is `test/fixtures/ru/lantern/lantern.compendium.json` (D-167): a synthetic RoleCall export of
18 rows, 16 typed entries of all 11 types (one disabled), an `[Arc]` row and a classic entry. Мира is
not in the book: the demo creates her.

The scripted connection has an 8 192-token window, so `profile = "auto"` runs lite: at most 6
entries, and always the brief (§15's «краткую запись»; in the full profile a small entry renders
whole, D-154). Tools are off on it, so a brief has no `(more: read_lore C17)` tail.

## 2. The run

The transcript is the test's own output (`bun test test/demo-m5a`), cut where long (`…`). The home
is `<home>`; for each command the test prints its stdout, then its stderr. Session and message ids
and the times differ from run to run.

### a. Import RoleCall's export

```
$ rp-core --home <home> import test/fixtures/ru/lantern/lantern.compendium.json
lantern
rp-core: warning: RoleCall's stored tree and node constraints are dropped: rp-core derives the tree from the entries (tree)
rp-core: imported lorebook "Lantern" as <home>/library/lorebooks/lantern.json
rp-core: hint: /lore add lantern in the chat, or rp-core new --lore lantern
$ rp-core --home <home> new --card test/demo-m5a/card.json --persona test/demo-m5a/persona.json --no-chat
s_82a556a3
rp-core: created session s_82a556a3 "Рассказчик" with 1 greeting (card imported as library character рассказчик)
```

The file is recognised as a Compendium export (D-162) and named after its `lorebook.name`, so its
library id is `lantern`. Typed rows keep their type, data and aliases in `meta`; the `[Arc]` row
becomes `meta.arc`; RoleCall's stored tree is dropped with one warning.

### b. `/lore add lantern`, `/memory tree`, `/memory list`

The chat: `EDITOR="bun test/demo-m5a/editor.ts" rp-core --home <home> chat s_82a556a3 --keep-requests
--provider script:test/demo-m5a/chat.jsonl < test/demo-m5a/script.txt`.

```
session s_82a556a3 · Рассказчик · narrator script:default (tools: off) · ctx 8192
Рассказчик › Ночь опускается на портовый город. Ян стоит у причала с тяжёлым свёртком в руках: внутри что-то звякает, будто стекло о латунь. Старый лодочник уже отвязывает лодку.
  [greeting 1/1]
you        › /lore add lantern
lorebook lantern "Lantern" added: 18 entries (from the next turn); its 16 Compendium entries join /memory now
you        › /memory tree
World Knowledge (this session) · 0
Lantern (lib: lantern) · 16
  Cast · 3
    Гильдия фонарщиков · 1: C1 Арсений Кеттер
    Соляной суд · 1: C2 Селина Бранд
    Unaffiliated · 1: C3 Ульяна
  Places · 3
    C4 Вельмар · 3
      C5 Фонарный ряд
      C6 Серый маяк
  Items · 1: C7 Латунный фонарь
  Powers · 1: C8 Негасимый свет
  Organizations · 1: C9 Гильдия фонарщиков
  Events · 1
    Украденный свет · 1: C10 Погасший маяк
  Plots · 1: C11 Украденный свет
  Threats · 1
    Notable · 1: C12 Чёрный прилив
  Worldbuilding · 1
    Закон · 1: C13 Право огня
  Narrative · 2
    Украденный свет · 2: C16 [Arc] Украденный свет, C14 Фонарь погас
  Bestiary · 1
    Дух · 1: C15 Туманник
you        › /memory list
The Compendium of this path: 16 live · /memory show <ref> prints one
Cast (3)
  C1  Арсений Кеттер (aka Старшина, Арсений) — Старшина Гильдии фонарщиков, сорок лет зажигает огни Вельмара. [lib: lantern] [featured] [1.6k]
  C2  Селина Бранд — Хочет, чтобы свет принадлежал городу. [lib: lantern] [406]
  C3  Ульяна (aka Смотрительница) — Смотрительница Серого маяка, тридцать зим не пропустившая ни одной ночи. [lib: lantern] [338]
Places (3)
  C4  Вельмар — Портовый город на Сером мысу; ночью его улицы держат только фонари. [lib: lantern] [256]
  C5  Фонарный ряд — Квартал Гильдии фонарщиков: мастерские, склады масла и колокольня, по которой… [lib: lantern] [244]
  C6  Серый маяк (aka маяк) — Каменная башня на краю мыса; на её крюке висел Латунный фонарь. [lib: lantern] [featured] [217]
…
Narrative (1)
  C14 Фонарь погас — Ночь, когда маяк ослеп. [lib: lantern] [524]
Bestiary (1)
  C15 Туманник — Тень в тумане, которая боится огня. [lib: lantern] [355]
Arcs (1)
  C16 [Arc] Украденный свет — Маяк погас, фонарь пропал вместе со смотрительницей. Гильди… [lib: lantern] [148]
```

What it shows:

- **The library seed.** The book's 15 live typed entries are in the Compendium with handles C1–C15,
  numbered before any session entry (D-150). The disabled «Старая пристань» is left out. The
  classic «Песня фонарщиков» stays ordinary lore (D-141), so it is in neither the tree nor the list;
  the `[Arc]` row was ordinary lore in M5a too, and since M5b it is the arc entry C16 (D-177).
- **The derived tree** (D-165): Cast, Places, Items… Narrative, Bestiary, with Bunraku's grouping:
  characters by affiliation (Арсений's `{org}` counts, A.7), places nested under their parent, events
  by plot, threats by severity (the legacy `"moderate"` shows as Notable), worldbuilding and
  creatures by category, with a capital first letter. The session's own tree comes first; it is empty
  here.

### c. Мира: `/memory new` in the editor, then a message that names her

```
you        › /memory new character Мира
character C17 "Мира" filed (from the next turn)
you        › /memory show Мира
C17 Мира · character · character:мира
  aka: Фонарщица
  origin: this session, written by you at journal row 3

  # Мира

  Младшая фонарщица Вельмара и ученица Арсения Кеттера. Хранит последний огонь гильдии и ищет пропавший Латунный фонарь.

  ## Role
  protagonist

  ## Current state
  Condition: не спала две ночи
  Location: Фонарный ряд
  Status: alive
…
you        › /director on
director on: it plans every reply with script:default (the narrator's model), from the next turn (/director shows its plan; /model director <connection:model> picks another model)
you        › — Отдай это Мире, — говорю я лодочнику. — Она ждёт у маяка.
  ⋯ director: planned — arcs +1 · chapter 1
Рассказчик › Лодочник взвешивает свёрток на ладони и долго молчит. — Мире, говоришь? — наконец бурчит он. — Отнесу. К маяку сейчас мало кто ходит.
  [swipe 1/1 · 0.4s · end]   /r swipe  /c continue  /e edit
you        › /trace
trace of 89aa7272 · script:default
  window 8192 · reserve 2048 · prompt ~1226 tok · 11 messages sent
  trimmed: nothing · prefill: none
  unknown macros: none
  lore: nothing fired · budget 921 tok
  lore not fired (recomputed from its seed):
    ✗ 1 entry: no-key-match 1
  compendium: lite · picked 3: C17 "Мира" (mention), C6 "Серый маяк" (mention), C14 "Фонарь погас" (mention) · injected 3: C17 "Мира" brief 115 tok, C6 "Серый маяк" brief 57 tok, C14 "Фонарь погас" brief 112 tok · block 290 tok
  recap: 1 arc: C16 "Украденный свет" rev 0 · boundary ff940e38
  calls: director script:default 0.0s, narrator script:default 0.0s
you        › /preview
preview of a swipe (a new answer to f0f0aa47) · script:default
  window 8192 · reserve 2048 · prompt ~1226 tok (o200k) · 11 messages · nothing was sent

#1 system · main · 42 tok
Write Рассказчик's next reply in a fictional roleplay chat between Рассказчик and Ян. Stay in character, write vivid prose, and never speak, act or decide for Ян.
…
#5 system · persona · 36 tok
Ян — мальчишка с пристани, посыльный Гильдии фонарщиков. Быстро бегает и всё запоминает.

#6 system · core:director · 444 tok
## Story Director Authority - CONTRACTUAL
…

#7 assistant · history · 57 tok
Ночь опускается на портовый город. Ян стоит у причала с тяжёлым свёртком в руках: внутри что-то звякает, будто стекло о латунь. Старый лодочник уже отвязывает лодку.

#8 system · recap · 61 tok
[Arc] Украденный свет
Маяк погас, фонарь пропал вместе со смотрительницей. Гильдия ищет его в городе, Соляной суд требует отдать огни городу, а с моря идёт Чёрный прилив.

#9 system · compendium:block · 256 tok
[Retrieved World Knowledge]
[Lore: Мира]
# Мира
Младшая фонарщица Вельмара и ученица Арсения Кеттера.
Role: protagonist
State: не спала две ночи, at Фонарный ряд
Relationships: Селина Бранд (rival, strained); Арсений Кеттер (mentor)
Memories: Нашла соль на камнях у Серого маяка. — Фонарь унесли люди, а не туман.

[Lore: Серый маяк]
# Серый маяк
Каменная башня на краю мыса; на её крюке висел Латунный фонарь.
Type: building
Parent location: Вельмар

[Lore: Фонарь погас]
# Фонарь погас
Ночь, когда маяк ослеп.
Significance: major
Summary: Серый маяк погас в тихую ночь. Арсений поднялся на башню и нашёл пустой крюк, а смотрительница Ульяна пропала. Утром на камнях у подножия нашли соль, и Мира поклялась вернуть фонарь до прилива.

#10 system · director · 198 tok
[DIRECTOR CONSTRAINTS - BINDING THIS TURN]
…
Mood: тревожное ожидание
Pacing: Take your time. Let moments breathe. Descriptive, contemplative.

Narrative Goal: Лодочник берёт свёрток и обещает доставить его Мире к Серому маяку.

Character Beats:
  - Лодочник: медлит, услышав имя Миры

[Ending: На маяке на миг вспыхивает свет.]
[/DIRECTOR CONSTRAINTS]

#11 user · history · 27 tok
— Отдай это Мире, — говорю я лодочнику. — Она ждёт у маяка.

prefill: none · max tokens 2048 · samplers: none
tools: none
  lore: nothing fired · budget 921 tok
```

What it shows:

- **`/memory new` in the editor** (D-160). The REPL opened the editor on a JSON template with the
  name filled in; `editor.ts` saved `mira.character.json`. One human row went to the journal
  (`by: user`, `key: null`, `on: null`), and Мира became C17, after the book's entries.
- **Мира fires by her name in another case.** The message says «Мире» (§15 writes «Миру»; both forms
  stem to `мир`), and the selector picks her by mention (tier 0, D-153). The same message picks
  «Серый маяк» by its alias «маяк», and the book's summary «Фонарь погас» by its RoleCall trigger
  «Мира»: a library entry's plain lore keys match too.
- **The brief at depth 1, above the directive.** In `/preview` the block (#9) and the directive
  (#10) are both depth-1 inserts, right above the last user message, the block first (D-155). The
  block carries briefs (`Role:`, `State:`, `Relationships:` lines), not the full render that
  `/memory show` prints, because the 8 192 window runs lite. `/preview` here is the next turn, a
  swipe of the answer; its user message is the same one.
- `/trace` names every pick and how much it cost. It counts in budget tokens: o200k scaled by the
  model's correction factor, 1.15 before any usage arrives (D-50). `/preview` counts the message in
  plain o200k tokens, so the block is 290 there and 256 here.
- The `[Arc]` row fired as ordinary constant lore (`lore_after`) in M5a; since M5b it is the
  `{{recap}}` slot (#8, right after the greeting, ahead of the depth-1 inserts), and `/trace` names it
  on its `recap:` line.

### d. `/memory edit` of a library entry: an overlay

```
you        › /memory edit Ульяна
character C3 "Ульяна" changed: set current_state (from the next turn; the book file stays as it is)
you        › /memory show Ульяна
C3 Ульяна · character · lib:lantern:00000000-0000-4000-8000-000000000e03
  aka: Смотрительница
  origin: the library book lantern, entry 00000000-0000-4000-8000-000000000e03; changed in this session (an overlay: the book file stays as it is)
  last changed at journal row 10
  keys: Ульяна

  # Ульяна

  Смотрительница Серого маяка, тридцать зим не пропустившая ни одной ночи.

  ## Role
  neutral

  ## Current state
  Condition: нашлась: три ночи пряталась в фонарной башне
  Location: Серый маяк
  Status: alive

  ## Relationships
  - Nature: family; Status: past; With: Арсений Кеттер
you        › /memory tree
World Knowledge (this session) · 1
  General · 1: C17 Мира
Lantern (lib: lantern) · 16
  Cast · 3
    Гильдия фонарщиков · 1: C1 Арсений Кеттер
    Соляной суд · 1: C2 Селина Бранд
    Unaffiliated · 1: C3 Ульяна
…
```

The editor opened on Ульяна's data; `editor.ts` changed her `current_state` (the book says
`missing`), and the diff became one `edit` row with `set: {current_state}` on the key
`lib:lantern:…e03` (D-146). The test reads `<home>/library/lorebooks/lantern.json` before the chat and
after it: the bytes are the same. The entry keeps its handle C3 and its key; `/memory list` marks it
`[lib: lantern, edited]`.

The session's own tree now holds Мира. Under five entries Bunraku's tree is one `General` group
(its rule, ported unchanged), so she is not under Cast yet.

### e. Swipe, rewind, fork

```
you        › /r
  ⋯ director: reused — arcs +1 · chapter 1
Рассказчик › Старик прячет свёрток под скамью. — Мира ждёт третью ночь, — говорит он. — Довезу до рассвета, если туман не помешает.
  [swipe 2/2 · 0.0s · end]   /r swipe  /c continue  /e edit
you        › /memory list character
Character entries on this path: 4 live · /memory show <ref> prints one
Cast (4)
  C1  Арсений Кеттер (aka Старшина, Арсений) — Старшина Гильдии фонарщиков, сорок лет зажигает огни Вельмара. [lib: lantern] [featured] [1.6k]
  C2  Селина Бранд — Хочет, чтобы свет принадлежал городу. [lib: lantern] [406]
  C3  Ульяна (aka Смотрительница) — Смотрительница Серого маяка, тридцать зим не пропустившая ни одной ночи. [lib: lantern, edited] [348]
  C17 Мира (aka Фонарщица) — Младшая фонарщица Вельмара и ученица Арсения Кеттера. [698]
you        › /rewind 2
you        › — Отдай это Мире, — говорю я лодочнику. — Она ждёт у маяка.
rewound to your message 2: /r asks for a new answer to it; a line you type now follows it as another message of yours (/rewind 1 to replace it instead); the rest stays as a branch (/tails)
you        › /memory list character
Character entries on this path: 4 live · /memory show <ref> prints one
Cast (4)
  …the same four lines…
you        › /fork
forked into s_44fe4092 (messages 1–2)
session s_44fe4092 · Рассказчик · narrator script:default (tools: off) · director script:default (auto) · ctx 8192
…
you        › /memory list character
Character entries on this path: 4 live · /memory show <ref> prints one
Cast (4)
  …the same four lines…
```

The person's rows are not tied to a message (`on: null`), so they apply on every path. The swipe
made a new answer, the rewind moved the head back to the user message, and the fork (`/fork` at
message 2) copied the human rows into a new session. Each time `/memory list character` printed the
same four lines: Ульяна still edited, Мира still C17. The test also opens both sessions with the
engine after the CLI exits: `memoryList()` gives the same handles and keys in both
(`C17 character:мира`, `C3 lib:lantern:…e03`), and the fork's overlay holds the new state. The swipe
reused the Director's plan (`reused`, no Director call, D-104).

### f. Export as a Compendium file, import it again

```
you        › /memory export lantern2 --format compendium
exported 2 entries as a RoleCall Compendium file (compendium-v1.0.0): <home>/exports/lantern2.compendium.json
you        › /quit
$ rp-core --home <home> import <home>/exports/lantern2.compendium.json
lantern2
rp-core: imported lorebook "lantern2" as <home>/library/lorebooks/lantern2.json
rp-core: hint: /lore add lantern2 in the chat, or rp-core new --lore lantern2
# exports/lantern2.compendium.json: compendium-v1.0.0 · rolecall-compendium · lorebook "lantern2" · tree null
  character Ульяна (aka Смотрительница)
  character Мира (aka Фонарщица)
# library/lorebooks/lantern2.json: "lantern2"
  character Ульяна (aka Смотрительница) · data 348 chars
  character Мира (aka Фонарщица) · data 698 chars
```

The export holds what this session added to the world (D-163): its own entries (Мира) and its
overlays, as whole entries (Ульяна with her new state). The book's untouched entries are already in
the library and are not exported. The file is written to `<home>/exports/` in RoleCall's format
(`tree: null`, `nodeConstraints: []`), and `rp-core import` reads it back as the book `lantern2`. The
test compares each imported entry with the session's: type, name, aliases and data are equal, and
Мира's data is exactly `mira.character.json`.

### g. `--keep-requests`: the Director's request

```
$ ls <home>/sessions/s_82a556a3.requests
t_23b987fd_director_0.json
t_23b987fd_narrator_0.json
t_92ff0d6b_narrator_0.json
# the [COMPENDIUM CONTEXT] section of t_23b987fd_director_0.json:
[COMPENDIUM CONTEXT]
Characters:
  - Мира: Младшая фонарщица Вельмара и ученица Арсения Кеттера. Хранит последний огонь гильдии и ищет пропавший Латунный фонарь. (protagonist). не спала две ночи. At: Фонарный ряд
    Relationships: Арсений Кеттер (mentor), Селина Бранд (rival, strained)
  - Арсений Кеттер: Старшина Гильдии фонарщиков, сорок лет зажигает огни Вельмара. Ворчит на всех, кроме своей ученицы. (ally). не спит третью ночь. At: Фонарный ряд
    Relationships: Мира (mentor), Селина Бранд (rival, strained)
  - Селина Бранд: Судья Соляного суда. Считает, что огни Вельмара должны принадлежать городу, а не гильдии. (rival). At: Вельмар
    Relationships: Арсений Кеттер (rival, strained), Мира (unknown)
  - Ульяна: Смотрительница Серого маяка, тридцать зим не пропустившая ни одной ночи. (neutral). Status: missing. пропала в ночь, когда погас маяк. At: Серый маяк
    Relationships: Арсений Кеттер (family, past)

Unresolved Tensions:
  Tension: Мира / Селина Бранд: rival relationship (strained): Селина требует сдать ключи гильдии суду
  Tension: Арсений Кеттер / Селина Бранд: rival relationship (strained): спорят о праве огня

Key Locations:
  - Фонарный ряд: Квартал Гильдии фонарщиков: мастерские, склады масла и колокольня, по которой зажигают огни.
  - Серый маяк: Каменная башня на краю мыса; на её крюке висел Латунный фонарь.
```

With `--keep-requests` (D-164) every provider request of a turn is kept as JSON under
`<home>/sessions/<session>.requests/`, named by its call key: the reply's Director and narrator
requests (`t_23b987fd_…`), and the swipe's narrator request (`t_92ff0d6b_…`; the swipe reused the
plan, so it has no Director request). The Director got the Compendium's world snapshot (D-157):
Мира first, because the message names her, then the characters she is tied to; the tensions
between them; the places that matter (Мира's location, and the lighthouse the message names by its
alias). Ульяна is still `missing` here: her overlay was written after this turn. Both narrator
requests hold the block with Мира.

## 3. Live run on Ollama

The scripted run proves the mechanics. The live run shows the block with a real model in a real
story: the M3/M4 innkeeper chat (Марфа and Елисей) with a small book attached. Two runs were made
with the same setup and script: run 1 before the review fixes, run 2 after them. The log below is
run 2.

Environment: Bun 1.3.14 (`0d9b296a`), Linux 7.0.0-38-generic (x86_64), Ollama 0.34.2.
`magmell-16k:latest` is a Modelfile variant of Mag-Mell R1 12B with `num_ctx 16384` (README,
"The context window"). It is both the narrator and the Director.

### Setup

The book is `test/fixtures/ru/innkeeper-compendium/innkeeper.compendium.json`: a RoleCall export of
10 typed entries (three characters, three places, an organization, an item, a plot, an event). They
add facts the card does not have, such as Гордей's copper lantern. There are no entries for Марфа or
Елисей (they would sit in the block every turn).

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
rp-core --home $H import test/fixtures/ru/innkeeper-compendium/innkeeper.compendium.json
id=$(rp-core --home $H new --card test/fixtures/ru/innkeeper-200/card.json \
  --persona test/fixtures/ru/innkeeper-200/persona.json --lore innkeeper \
  --model ollama:magmell-16k:latest --max-tokens 300 --no-chat)
cat > $H/script.txt <<'EOF'
/memory list
Добрый вечер. Найдётся ли у вас комната на ночь? Я землемер, иду в Велеград.
А что за шум был на дороге? Говорят, мост в Горелой балке совсем плох.
Расскажите, кто у вас тут бывает. Кажется, вон тот охотник на меня косится.
/trace
Говорят, на гати за бором шалит какой-то Сыч?
/trace
Это фонарь вашего мужа, Гордея? Он висит у двери.
/trace
/director show
/r
/trace
/quit
EOF
rp-core --home $H chat $id --keep-requests < $H/script.txt 2>&1 | tee $H/run.log
```

The book is imported as `innkeeper` (its `lorebook.name` is "Innkeeper"). The window is 16 384,
below 24 576, so `auto` runs lite: at most 6 entries, always the brief, and the Director's smaller
`WORLD_LITE` snapshot. `tools = "prompted"` offers `search_lore` and `read_lore`, so a brief that
leaves something out ends with `(more: read_lore C<n>)`.

### The log (run 2)

ANSI codes stripped; the answers are cut (`…`). Every answer stopped at the 300-token limit
(`length`). The model sometimes slips into English words («Marfa», «tears», «webdriver»); that is
the model, not the block.

```
session s_cf1945ad · Марфа · narrator ollama:magmell-16k:latest (tools: prompted) · director ollama:magmell-16k:latest (auto) · ctx 16384
Марфа › Дверь «Сонного гуся» с натугой подалась, впустив в общую залу порыв сырого ветра, горсть мокрых листьев и запах раскисшей дороги. …
  [greeting 1/1]
you   › /memory list
The Compendium of this path: 10 live · /memory show <ref> prints one
Cast (3)
  C1  Глеб (aka охотник) — Охотник из Соснового бора: угрюмый бородач в волчьей шапке, говорит мало, лес… [lib: innkeeper] [558]
  C2  Сыч (aka атаман) — Атаман лихих людей со старой гати за Сосновым бором. [lib: innkeeper] [402]
  C3  Савелий Рогов (aka Рогов) — Купец из Лисьего Брода, крепкий и обстоятельный; каждую осень ведёт на север… [lib: innkeeper] [399]
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
you   › Добрый вечер. Найдётся ли у вас комната на ночь? Я землемер, иду в Велеград.
  ⋯ director: planned — seeds +1 · chapter 1
Марфа › Марфа окинула путника внимательным взглядом, от прически до мокрых сапог, и кивнула, соглашаясь. …
  [swipe 1/1 · 300 tok · 21.1s · length]   /r swipe  /c continue  /e edit
you   › А что за шум был на дороге? Говорят, мост в Горелой балке совсем плох.
  ⋯ director: planned — no changes
Марфа › Marfa кивнула с понимающим видом и присела на соседнем стуле, ближе к Елисею. "Айда, да в Горелой балке мост и правда уже на последнем издыхании. …
  [swipe 1/1 · 300 tok · 15.5s · length]   /r swipe  /c continue  /e edit
you   › Расскажите, кто у вас тут бывает. Кажется, вон тот охотник на меня косится.
  ⋯ director: planned — no changes
Марфа › Marfa бросила взгляд на угрюмого бородача в волчьей шапке, греющегося у огня. "Аа, это Глеб, охотник из Соснового бора. …
  [swipe 1/1 · 300 tok · 16.2s · length]   /r swipe  /c continue  /e edit
you   › /trace
trace of fd737417 · ollama:magmell-16k:latest
  window 16384 · reserve 300 · prompt ~3625 tok (server: 3825) · 13 messages sent
  trimmed: nothing · prefill: none
  unknown macros: none
  lore: nothing fired · budget 2412 tok
  compendium: lite · picked 3: C1 "Глеб" (mention), C4 "Горелая балка" (window), C5 "Велеград" (window) · injected 3: C1 "Глеб" brief 98 tok, C4 "Горелая балка" brief 83 tok, C5 "Велеград" brief 53 tok · block 240 tok
  calls: director ollama:magmell-16k:latest 9.8s, narrator ollama:magmell-16k:latest 6.4s
  rounds: 1 · prompted tools · ended: answer · tool room 0 of 4021 tok used
you   › Говорят, на гати за бором шалит какой-то Сыч?
  ⋯ director: planned — no changes
Марфа › Марфа нахмурилась и махнула рукой, как бы отгоняя назойливую муху. "И не говори webdriver, Елисей. Это верно, есть там такой Сыч, атаман лихой шайки. Обитает на старой гати, что за Сосновым бором, и всех, кто по этой дороге едет, прижимает сильно". …
  [swipe 1/1 · 300 tok · 70.0s · length]   /r swipe  /c continue  /e edit
you   › /trace
trace of 66f40f55 · ollama:magmell-16k:latest
  window 16384 · reserve 300 · prompt ~3973 tok (server: 4195) · 15 messages sent
  …
  compendium: lite · picked 3: C2 "Сыч" (mention), C1 "Глеб" (window), C4 "Горелая балка" (window) · injected 3: C2 "Сыч" brief 71 tok, C1 "Глеб" brief 97 tok, C4 "Горелая балка" brief 82 tok · block 256 tok
  calls: director ollama:magmell-16k:latest 63.5s, narrator ollama:magmell-16k:latest 6.5s
  …
you   › Это фонарь вашего мужа, Гордея? Он висит у двери.
  ⋯ director: planned — no changes
Марфа › Marfa бросила взгляд на медный фонарь, висящий на крюке у двери, и её глаза на миг заблестели от невыплаченных tears. "Верно, это был Гордей. Он брал его с собой на перевоз, а когда возвращался поздно ночью, то вешал на это самое место. Фонарь этот — одна из немногих вещей, что остались у меня от него." …
  [swipe 1/1 · 300 tok · 15.7s · length]   /r swipe  /c continue  /e edit
you   › /trace
trace of 7189c7af · ollama:magmell-16k:latest
  window 16384 · reserve 300 · prompt ~4260 tok (server: 4504) · 17 messages sent
  …
  compendium: lite · picked 3: C8 "Фонарь Гордея" (mention), C1 "Глеб" (window), C2 "Сыч" (window) · injected 3: C8 "Фонарь Гордея" brief 72 tok, C1 "Глеб" brief 96 tok, C2 "Сыч" brief 70 tok · block 244 tok
  calls: director ollama:magmell-16k:latest 9.8s, narrator ollama:magmell-16k:latest 5.8s
  …
you   › /director show
director on · ollama:magmell-16k:latest (the narrator's model) · profile auto · style the-balanced
turn 5 · planned on 7189c7af · tagged · lite · ollama:magmell-16k:latest
…
you   › /r
  ⋯ director: reused — no changes
Марфа › Марфа бросила взгляд на фонарь у двери и кивнула с грустью в голосе. "Да, это Гордеев фонарь. С ним он каждый вечер шел на перевоз, дабы помочь кому-то переправиться через Ольшанку. …
  [swipe 2/2 · 300 tok · 5.5s · length]   /r swipe  /c continue  /e edit
you   › /trace
trace of 6a741cb0 · ollama:magmell-16k:latest
  …
  compendium: lite · picked 3: C8 "Фонарь Гордея" (mention), C1 "Глеб" (window), C2 "Сыч" (window) · injected 3: C8 "Фонарь Гордея" brief 72 tok, C1 "Глеб" brief 96 tok, C2 "Сыч" brief 70 tok · block 244 tok
  calls: narrator ollama:magmell-16k:latest 5.5s
  …
you   › /quit
```

### What the selector picked

`/trace` was not typed after the first two turns; their picks come from the same trace in the
session journal (`trace.compendium`).

| Turn | The player's message | Picked (tier) | Block |
|---|---|---|---|
| 1 | «…иду в Велеград.» | C5 Велеград (mention) | 62 tok |
| 2 | «…мост в Горелой балке совсем плох.» | C4 Горелая балка (mention), C5 (window) | 144 tok |
| 3 | «…вон тот охотник на меня косится.» | C1 Глеб (mention, by his alias «охотник»), C4, C5 (window) | 240 tok |
| 4 | «…шалит какой-то Сыч?» | C2 Сыч (mention), C1, C4 (window) | 256 tok |
| 5 | «Это фонарь вашего мужа, Гордея?…» | C8 Фонарь Гордея (mention), C1, C2 (window) | 244 tok |
| 5, `/r` | the same | the same three; the Director's plan reused | 244 tok |

- **Every entry the player named was picked, inflected or not**: «Велеград», «в Горелой балке»,
  «охотник» (Глеб's alias), «Сыч». Tier 2 kept what the last four messages named; Велеград dropped out
  once the message that named it was more than four messages back.
- **All ten entries are typed**, so the lore engine fires nothing (`lore: nothing fired`); the book
  reaches the narrator only through the block. Every pick went in as a brief, and nothing was cut.
- **The narrator used the briefs.** In turn 3 it describes Глеб as «угрюмого бородача в волчьей
  шапке», which is in his entry and not in the card.
- **Tools were offered but not used** (`tool room 0 of 4021 tok used`).

### The lantern

«Это фонарь вашего мужа, Гордея?» names «Фонарь Гордея» although its two words are apart and in the
other order: a name matches when every significant word is in the message, in any order (D-169).
This is the block the narrator got that turn, from the kept request
`<home>/sessions/s_cf1945ad.requests/t_89099cd6_narrator_0.json`. This model's caps send in-chat
system text as part of the user message, so the block and the directive arrive as a `[System note]`
at the head of the last user message:

```
[System note] [Retrieved World Knowledge]
[Lore: Фонарь Гордея]
# Фонарь Гордея
Медный фонарь со слюдяными оконцами, с которым покойный Гордей ходил на перевоз.
Type: mundane
Current owner: Марфа
Condition: good
(more: read_lore C8)

[Lore: Глеб]
# Глеб
Охотник из Соснового бора: угрюмый бородач в волчьей шапке, говорит мало, лес…
Role: ally
State: греется у печи после ночи в лесу, at Сонный гусь
Relationships: Сыч (enemy); Марфа (ally)
(more: read_lore C1)

[Lore: Сыч]
# Сыч
Атаман лихих людей со старой гати за Сосновым бором.
Role: antagonist
State: at старая гать за Сосновым бором
Relationships: Глеб (enemy)
(more: read_lore C2)

[DIRECTOR CONSTRAINTS - BINDING THIS TURN]
…
[/DIRECTOR CONSTRAINTS]

Это фонарь вашего мужа, Гордея? Он висит у двери.
```

The card says Гордей died six years ago and nothing about a lantern. Both answers took the entry's
facts: «медный фонарь», «Он брал его с собой на перевоз», and in the swipe «С ним он каждый вечер шел
на перевоз».

Run 1, before the fixes, missed it: a name then had to be a contiguous run of stems, and the message
splits «Фонарь Гордея». Its `/trace` read `picked 3: C2 "Сыч" (window), C3 "Савелий Рогов" (window),
C1 "Глеб" (window)`, and its answer called the lantern «темно-коричневый». §7.4.1 asks for every
significant word of the name, not a run; D-169 made matching follow it, and run 2 picks the lantern.
Turns 1–4 picked the same entries in both runs.

### The Director's `[COMPENDIUM CONTEXT]`

`--keep-requests` kept 11 requests: a Director and a narrator request for each of the five turns,
and the narrator's for the swipe (it reused the plan).

```
$ ls <home>/sessions/s_cf1945ad.requests
t_56a8ee96_director_0.json
t_56a8ee96_narrator_0.json
t_58d7a008_narrator_0.json
t_6090c9be_director_0.json
t_6090c9be_narrator_0.json
t_6a899dcf_director_0.json
t_6a899dcf_narrator_0.json
t_89099cd6_director_0.json
t_89099cd6_narrator_0.json
t_8d61fc6b_director_0.json
t_8d61fc6b_narrator_0.json
# the [COMPENDIUM CONTEXT] section of t_89099cd6_director_0.json (the lantern turn):
[COMPENDIUM CONTEXT]
Characters:
  - Глеб: Охотник из Соснового бора: угрюмый бородач в волчьей шапке, говорит мало, лес знает как свою избу. (ally). греется у печи после ночи в лесу. At: Сонный гусь
    Relationships: Марфа (ally), Сыч (enemy)
  - Сыч: Атаман лихих людей со старой гати за Сосновым бором. (antagonist). At: старая гать за Сосновым бором
    Relationships: Глеб (enemy)
  - Савелий Рогов: Купец из Лисьего Брода, крепкий и обстоятельный; каждую осень ведёт на север обоз с солью, сукном и железом. (neutral). Status: missing. обоз из шести подвод запаздывает пятый день
    Relationships: Марфа (ally)

Unresolved Tensions:
  Tension: Глеб / Сыч: enemy relationship (active): не раз уводил возы в обход старой гати

Key Locations:
  - Горелая балка: Овраг на тракте к Лисьему Броду; через него — старый мост на сваях.
  - Велеград: Большой торговый город на севере, куда ведёт Старый тракт; осенью там шумит ярмарка.
```

The Director got the book's world in the lite snapshot (D-157): all three characters with their
relationships (lite shows up to six), the Глеб/Сыч tension once, and two places, the lite limit.
The snapshot holds characters and places only, so the lantern is not in it. Every Director request
of the run holds this section; in turn 1's, Велеград, the place that message named, comes first.

## 4. Running the lantern script live

The lantern script of §2 also runs against your own model. It was not run live for this document
(§3 is the live run): what the model writes, and whether the Director plans on the first try
(docs/M4-DEMO.md §2, §3), depends on your model. The commands that read the Compendium (`/memory
tree`, `list`, `show`, `export`) print what §2 shows, apart from the ids.

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
TOML
rp-core --home $H import test/fixtures/ru/lantern/lantern.compendium.json
id=$(rp-core --home $H new --card test/demo-m5a/card.json --persona test/demo-m5a/persona.json \
  --model ollama:magmell-16k:latest --max-tokens 300 --no-chat)
EDITOR="bun test/demo-m5a/editor.ts" rp-core --home $H chat $id --keep-requests \
  < test/demo-m5a/script.txt 2>&1 | tee $H/run.log
rp-core --home $H import $H/exports/lantern2.compendium.json
grep -l 'COMPENDIUM CONTEXT' $H/sessions/$id.requests/*director*
```

`magmell-16k:latest` stands for any local model with a 16 384-token window; use yours, with its
`context_length`. What to look for:

- **The block.** A window below 24 576 runs lite, as here: `/preview` shows Мира's brief. With a
  bigger window `auto` runs the full profile, and a small entry is sent whole; add
  `[compendium]` / `profile = "lite"` to `config.toml` before `rp-core new` to see the brief there.
- **Tools.** With `tools = "prompted"` the narrator is offered `search_lore` and `read_lore` (the
  book has entries the block did not send, D-156). A brief that leaves part of its entry out then
  ends with `(more: read_lore C17)`, and the model may look an entry up.
- **The Director.** `/director on` in the script makes it follow the narrator's model. If a plan
  fails, the answer still arrives and the request is still kept; a correction attempt is a second
  file (`…_director_1.json`).
- **Your own editor.** Run without `EDITOR=…` and the REPL opens `$VISUAL` / `$EDITOR` (or edits in
  place); paste `test/fixtures/ru/lantern/mira.character.json` for Мира. Type the session's lines
  by hand instead of piping `script.txt`.

## 5. What changed with the demo

- **`--keep-requests` overwrote a repeated call key** (an open question of the engine unit; the
  lead's ruling). A retry of the narrator's round 0 and a fallback's attempt are sent under the same
  call key, and each one replaced the file of the one before. Now each request is created
  exclusively, and a taken name moves on to `-2`, `-3`… (`t_…_narrator_0.json`,
  `t_…_narrator_0-2.json`, `t_…_narrator_0-3.json`, in the order sent).
  `src/engine/turn.ts`; test: `test/engine-m5a/keep.test.ts`, "a call key that comes again (a retry,
  then a fallback) never overwrites".
- **`MemoryRow.size` of notes and arcs** (the lead's ruling). It was the JSON of their `data`, which
  is `{}` (2). It is now the length of their text (the note's content, the arc's overview), as
  `/memory list` already showed it.
  `src/engine/session.ts`; test: `test/engine-m5a/verbs.test.ts`.
- **`rp-core help import`** (found by the demo) did not list the RoleCall Compendium export among
  the formats it detects. It now names it, in its place (after the SillyTavern preset, before world info).
  `src/cli/main.ts`.

## How to rerun

```bash
bun test test/demo-m5a
```

It prints the whole transcript of §2 (with `<home>` for the temporary home).
