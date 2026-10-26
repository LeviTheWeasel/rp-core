# rp-core — итоговая архитектура

*Документ для Леви, 26.10.2026, ревизия 9.*

*Ревизия 9: вопросы 16–20 закрыты, все решения D-74…D-89 приняты. Открытым остаётся только D-27 — разговор с Chi.*

*Ревизия 8:*
- *вклады — DCO плюс соглашение команды (D-34);*
- *изменения контракта D-35…D-73 приняты, D-43 — с правкой для экспортов RoleCall.*

*Открыты вопросы 16–20 по Compendium (D-74…D-89) и D-27.*

*Ревизия 7 вносит ответы Леви на вопросы 5–12: все рекомендации приняты, `.vnpack` — позже. Открыты вопросы 14, 15 (D-35…D-89 пакетом) и 16–20 (Compendium).*

*Ревизия 5 вносит решения Леви по вопросу 13 и по D-61, D-62, D-71:*
- *память — Compendium целиком;*
- *форма состояния Директора — из Bunraku и RoleCall;*
- *директива читается терпимо;*
- *выключенные маркеры обрабатываются смешанно.*

*Ревизия 6 — проект Compendium в ядре (§5.8, §7.4, §19.7, M5) и §7.3 под D-61…D-65: recall заранее на локальных бэкендах, профиль lite для окна 16k, хранение строками `mem` на пути, планировщик по origin; новые решения D-74…D-89 (§19.10).*

*Ревизия 4 добавляет карту портирования (§19), изменения контракта D-35…D-73 (§19.10) и пересчитанные вехи (§15). Текст §5–§11 она не меняет.*

*Ревизия 3 вносит решения Леви по лицензии, происхождению кода и Kintsu (D-11, D-14, D-26, D-32, новое D-34). Переписан §2, остальные затронутые места помечены «рев. 3». Модули по-прежнему описаны как целевой дизайн. Откуда портировать каждый из них, решит отдельная карта портирования.*

*Ревизия 2. Основа — вариант «minimal-first». Из «bunraku-migration-first» взята машина состояний хода с глаголами Bunraku. Из «agent-capability-first» — общий помощник для структурных вызовов, lite-профиль Директора и правило размещения системных сообщений у Anthropic. Ревизия 2 учитывает два ревью: изменения внесены прямо в текст, а отклонённое и сделанное частично перечислено в «Примечаниях к ревизии» в конце. Решения помечены **[D-n]** и собраны в §16, вопросы к Леви — в §18.*

## TL;DR

- **Что это.** Один пакет на TypeScript/Bun: библиотека `rp-core` и бинарь.
  - REPL — для человека.
  - One-shot `rp-core send [--json]` — с первой вехи.
  - `--stdio` (JSON-RPC 2.0 поверх JSONL) — для любого UI, с M6.
  - Вплоть до M1 включительно у ядра ноль рантайм-зависимостей.
- **Сессия — один append-only JSONL-файл.**
  - Сообщения образуют дерево (`id`, `parent`), голова у сессии одна.
  - Производное состояние прикреплено к сообщению, которому принадлежит: снимок Директора, записи памяти, переменные, срабатывания лора.
  - Поэтому свайп, откат и форк откатывают это состояние сами, без undo-механики.
- **Ход — фиксированный гибрид [D-1]:**
  1. Story Director и recall Compendium (если включены).
  2. Чистая сборка промпта.
  3. Цикл рассказчика с read-only тулами: поиск по истории и по лору.
  4. Коммит одной строкой.

  Когда ответ принят, агенты **Compendium** на фоновой полосе дописывают персонажей, места, события и пересказы.

  *Рев. 5–6:* память — **Compendium целиком**: 11 типов записей, производное дерево, recall перед ответом, filing и historian. Хранится он строками на пути сообщений, поэтому свайп и откат убирают записи сами (§5.8). На локальном бэкенде recall считается заранее, пока игрок пишет, и не добавляет вызовов до первого токена (§7.4).
- **API рассчитан на Scenes в Bunraku, но строится по вехам.**
  - С M1: `send`/`runTurn` с `expectedVersion`, swipe, continue, stop, восстановление после краша, форки.
  - С M6: `conflict` с `commitAnyway`/`discard`.
  - С M9: хуки и гейты хоста (`review`, `transform`, fail-closed), `draft`, порт записей.

  Чего Bunraku не хватит и после M9 и где ядро сознательно ведёт себя иначе — §12.5.
- **Провайдеры подключаются в порядке Леви: OpenAI-совместимый → Anthropic → Gemini.**
  - Поток событий один, нормализованный.
  - Возможности модели описаны записью-данными.
  - Принудительный `tool_choice` не используется нигде.
  - Транспорт тулов и JSON выбирается до вызова и молча не меняется.
- **Лицензия и происхождение кода (решено 25.10, §2).**
  - Ядро выходит под **AGPL-3.0-or-later**, как Bunraku.
  - Это совместный проект команды RoleCall: Chi и Nemo подключатся позже.
  - Из RoleCall берётся всё, что работает, включая Директора, Compendium и Plan C. Из Bunraku — по ситуации.
  - Код **портируется** в форму ядра с сохранением копирайтов и записью в `PROVENANCE.md`, а не импортируется.
- **Вехи по умолчанию [D-8], рев. 4:** M1a ядро хода на скриптовом провайдере → M1b локальная RP в терминале → M2 пресеты и лорбуки → M3 тулы и поиск → M4 Директор → M5 Compendium → M6 `--stdio` → M7 Anthropic → M8 Gemini → M9 стык с Bunraku.
- **Объём и источники (рев. 4, §19).**
  - ≈ 19 тыс. строк кода ядра (рев. 6, с Compendium; в рев. 4 — ≈ 16 тыс.) плюс 3,9 тыс. строк личностей Директора.
  - Источник есть примерно у 65 % логики. Оболочка (журнал-дерево, движок, CLI) пишется с нуля. Провайдеры, Директор, тулы и лор в основном адаптируются из Bunraku и RoleCall.
  - Оценка — ≈ 98–167 рабочих дней одного разработчика с ИИ (§15). С Compendium целиком (рев. 6) — ≈ 120–202.
- **Статус решений (рев. 9, 26.10).** Все вопросы §18 к Леви закрыты: D-1…D-89 приняты, кроме D-27. Что осталось до начала кода:
  - **D-27** — судьба существующих сцен Bunraku при переходе на ядро. Решается с Chi, до M9.
  - **`docs/TEAM-LICENSING.md`** [D-34] — написать и подписать до первого внешнего коммита.
  - **Разговоры с Chi:**
    - предупредить о rp-core и согласовать коды выхода и флаги с Kintsu [D-14];
    - показать список отступлений Compendium до M5b [D-88];
    - предложить ей M4a и M5a.
  - **Первая веха** — M1a: ядро хода на скриптовом провайдере (§15).

---

## 1. Цели и не-цели

### 1.1 Цели: семь способностей из списка Леви

| # | Способность | Механизм в ядре | Веха |
|---|---|---|---|
| 1 | Искать по ранним сообщениям | Тулы `search_history`/`read_history` по активному пути, с нормализацией и лёгким стеммингом кириллицы (§7.5). В REPL — `/search`, в протоколе — `history/search` | M3 |
| 2 | Запоминать главные события и персонажей в лорбук | Compendium: filing и historian после принятого ответа пишут типизированные записи, пересказы и обзоры арок; селектор и recall возвращают их в промпт. В библиотеку — экспортом в обычный лорбук (§7.4) | M5 |
| 3 | Работать с другими агентами | Story Director — проход до ответа; агенты Compendium — recall до ответа, filing и historian после. У каждого своя привязка к модели | M4, M5 |
| 4 | Вызывать тулы | Один цикл рассказчика: транспорт native или prompted, починка аргументов, финальный текстовый раунд | M3 |
| 5 | Работать с пресетом | Нативный `core.preset/1` и импорт chat-completion пресетов SillyTavern | M1–M2 |
| 6 | Работать с лорбуками | Нативный `core.lorebook/1`, движок ключей с семантикой ST, импорт ST world info и `character_book` | M2 |
| 7 | Переключать модели и API | Привязки по ролям (`narrator`, `director`, `recorder`, `recall`) меняются посреди сессии командой `/model`, которая пишет запись `config`. Три адаптера | M1, M7, M8 |

**Сквозные цели.**

- **Два режима.** REPL и headless-режим — тонкие клиенты одного внутреннего API и одного объединения событий.
- **API, рассчитанный на Bunraku Scenes.** Глаголы и вехи их появления — в §6.1; что остаётся на стороне Bunraku — в §12.5.
- **Устойчивость к сбоям** на трёх уровнях (§6.7) и **детерминизм** (§6.9).
- **Простота.**
  - Один пакет, один цикл, один формат сессии, одна функция глубины, один поток событий.
  - Новая механика появляется, только если у неё есть пользователь в v1.
  - Места под «позже» зарезервированы именами, но не реализованы.

### 1.2 Не-цели v1

- **Групповой чат** [D-10]. Поле `speaker` зарезервировано.
- **Другие способы памяти и поиска:** эмбеддинги [D-2], выбор лора моделью [D-7], Lookback [D-24].
- **Именованные ветки внутри файла и параллельные ходы в одной сессии** [D-25]. Альтернативные линии — это хвосты дерева и форки.
- **MCP, подтверждения для пишущих тулов** (§9.3) и ACP-адаптер.
- **Прочие агенты и механики:** трекеры, Character Minds, механики и кубики, Final Cut, regex-скрипты, генерация изображений, TTS. Тип блока `image` зарезервирован.
- **Управление идущим ходом (steering).** Текст, набранный во время хода, REPL держит у себя и отправляет после.
- **Другие API:** OpenAI Responses, Gemini Interactions, text-completion-бэкенды.
- **Шифрование файлов и хранилище ключей** [D-13, D-20].
- **Байт-в-байт совпадение промптов с RoleCall** [D-21].

Не будет никогда: размещённого сервиса и телеметрии.

---

## 2. Лицензия и происхождение кода (рев. 3)

**Решения Леви от 25.10.2026.**

- **Лицензия ядра** — AGPL-3.0-or-later, как у Bunraku [D-11].
- **Это общий проект команды RoleCall.** Chi и Nemo подключатся позже; это с ними обсуждено.
- **Ядро будет встроено в Bunraku.** Bunraku станет open source, и куски RoleCall в него уже портированы без изменений. Поэтому код RoleCall берётся в ядро так же, как в Bunraku [D-32].
- **Plan C** (Character Minds: `extract-excerpts`, `add-tom-belief`, `introduce-npc`, `label-speakers`, `resolve-anticipation`, `update-mood`) — работа Леви, а не часть Compendium.

| Источник | Что можно брать | Условия |
|---|---|---|
| **RoleCall** (`apps/rc` в VAUDEVILLE): Директор (`dm`, `dm-stream`), narrator-engine, prompt-assembly, preset-loader, lorebook-движок, Compendium (`tv-stream`, `lib/compendium`, `lib/summary`), Plan C, `/btw` scene-search, хелперы тулов (prompted-tool-calls, tool-call-repair, dsml, thinking-tags) | Всё, что работает: код, промпты, пороги, схемы, тесты | Портировать в форму ядра (§3–§5), без Supabase, воркера, биллинга и гейтинга. Источник и коммит записываются в шапку файла и в `PROVENANCE.md` |
| **Bunraku** (AGPL-3.0-or-later, © Coneja-Chibi) | По ситуации. Прежде всего то, что уже стало чистым портом RoleCall: `src/core/assembly`, `src/core/director`, `src/core/macros`, `src/core/lore`, `src/stage/provider` (OpenAI-совместимый и Anthropic), tool-loop, тесты паритета и фикстуры `tools/rc-recorder` | Копирайт Chi в файле сохраняется. Ядро копирует код, а не импортирует пакеты Bunraku: зависимость по-прежнему Bunraku → ядро |
| **SillyTavern** и производные от него файлы RoleCall (`providers/definitions.ts`, `samplers/provider-adapter.ts`, `message-formatter.ts`) | Можно, лицензии совместимы (AGPL-3.0) | Атрибуция SillyTavern в шапке и в `PROVENANCE.md` |
| **Зависимости** | `jsonrepair` (ISC), `re2js` (MIT), `gpt-tokenizer` (MIT). Позже MCP-клиент и ACP SDK (Apache-2.0); pi-ai (MIT) [D-19] | Любая лицензия, совместимая с AGPL-3.0 |

**Правила портирования.**

1. **Порт, а не импорт.** Ядро не зависит от пакетов VAUDEVILLE или Bunraku. Код переносится и приводится к типам ядра: `Entry`, `PathView`, `ModelRequest`, `StreamEv`.
2. **Уведомления сохраняются** — этого требует AGPL. Каждый портированный файл получает шапку:
   ```ts
   // Ported from <repo>:<path>@<commit>.
   // Copyright (C) 2026 <исходные авторы>; changes Copyright (C) 2026 <авторы rp-core>.
   // SPDX-License-Identifier: AGPL-3.0-or-later
   ```
3. **`PROVENANCE.md`** — реестр портированных файлов по образцу ledger в `Bunraku/port/`. Колонки: файл ядра, источник, коммит, что изменено и почему.
4. **Простота важнее паритета.**
   - Берётся то, что работает и укладывается в форму ядра.
   - Обвязка, которой RoleCall и Bunraku обросли вокруг, не переносится: Supabase, разделённый первый вызов воркера, ChatStore на 48 правил, параллельные стеки провайдеров.
5. **Известные дефекты не переносятся.** Исследование нашло их в исходниках:
   - разделённый первый вызов рассказчика и два SSE-парсера;
   - синглтон адаптера Anthropic с общим состоянием;
   - двойная вставка контракта Директора;
   - принудительный `tool_choice` в Директоре (400 на свежих Claude, §7.2);
   - ASCII-граница слова `\W` в ключах лорбука;
   - префилл, оставленный перед раундами тулов;
   - `Math.random` в группах включения.
6. **Конвенции сводятся к решениям ядра.** Сборщик Bunraku и RoleCall использует глубину RC (0 = перед текущим сообщением пользователя). Ядро по [D-12] использует глубину ST, и порт сборщика переводит её в одном месте, в `prompt/depth.ts`.
7. **Вклады Chi и Nemo — DCO плюс соглашение команды [D-34], решено 26.10.**
   - Каждый коммит подписан `Signed-off-by` (Developer Certificate of Origin).
   - Отдельный документ `docs/TEAM-LICENSING.md` с подписями Леви, Chi, Nemo и других авторов портированного кода разрешает команде RoleCall использовать rp-core и под отдельной закрытой лицензией. Без него сетевой пункт AGPL не дал бы закрытому сервису RoleCall встроить ядро.
   - Соглашение подписывается до первого внешнего коммита. Оно покрывает и будущие коммиты, и код, портированный из RoleCall и Bunraku. Если RoleCall — компания, текст стоит показать юристу.

**Что это меняет в остальном документе.** Разделы §5–§11 описывают **целевой контракт** ядра: типы, жизненный цикл, правила. «Спроектирован заново» теперь значит «контракт ядра», а не «запрещено портировать». Откуда берётся каждый модуль, решает **карта портирования — §19** (рев. 4). Там, где порт оказался лучше контракта, предложены изменения D-35…D-73 (§19.10). Пока они не подтверждены, действует текст §5–§11.

---

## 3. Общая форма

```
            ┌───────────────────────────── клиенты ──────────────────────────────┐
            │ REPL (cli/repl)   one-shot `rp-core send [--json]`   --stdio (M6)   │
            │ позже: Bunraku в процессе (M9: порт записей + хуки), ACP-адаптер    │
            └──────────────────────────────┬──────────────────────────────────────┘
                     команды ↓             │             ↑ объединение событий Event
┌──────────────────────────────────────────▼───────────────────────────────────────────┐
│ Engine (экземпляр; никаких глобалов модуля)                                          │
│  сессии: lock + журнал; не больше одного хода на сессию                              │
│  sched: семафор на origin, два приоритета (interactive > background),                │
│         вытеснение фоновых запросов на одно-слотовых бэкендах                        │
│                                                                                      │
│  runTurn: admit → begin → [Director ∥ recall] → assemble (чистая) → shape → prep     │
│           → [хуки хоста, M9] → narrate ⇄ tools (read-only) → post-process            │
│           → [transformReply, M9] → commit │ held │ end                               │
│           └────────── дерево AbortSignal хода (типизированные причины) ─────────────┘│
│  полоса сессии (последовательная, фоновая): Compendium prerecall / file / hist       │
└──────────┬──────────────────────────────────┬────────────────────────────────────────┘
           │ session/log (M9: порт записей)    │ Provider (интерфейс)
  ┌────────▼──────────┐            ┌───────────▼─────────────────────────────────┐
  │ <id>.jsonl дерево │            │ openai-chat │ anthropic │ gemini            │
  │ <id>.lock         │            │ script / record / replay                    │
  └───────────────────┘            │ + записи возможностей (данные) + probe      │
                                   └─────────────────────────────────────────────┘
 чистые библиотеки: prompt/{assemble,shape,depth,macros,budget}, lore/engine,
                    text/{normalize,lexscore}, agents/director/{momentum,reduce},
                    session/fold, tools/prompted
```

Зависимости направлены строго в одну сторону: клиенты → Engine → журнал, провайдеры, чистые библиотеки. В чистые библиотеки часы и seed передаются снаружи, ввода-вывода в них нет.

Систему держат простой три правила:

1. **Производное вычисляется, а не хранится отдельно.** Состояние Директора, Compendium, переменные и таймеры лора читаются с активного пути. Откат — это смена пути, а не код отмены.
2. **Один писатель на сессию, один ход на сессию.** Внутри процесса порядок держит полоса записи, между процессами — lock-файл.
3. **Ничего не происходит молча.**
   - Транспорт не переключается сам.
   - Устаревшая директива не используется повторно.
   - Префилл не пропадает без `notice`.
   - `stop` не выдумывается.
   - Ошибка не превращается в пустой ответ.

   Каждый исход — типизированное событие или отказ.

---

## 4. Раскладка модулей

Ядро — один пакет с library-входом и `bin`. Монорепозиторий понадобится позже, для ACP- и MCP-адаптеров.

```
rp-core/
  package.json          # "exports": {".": "./src/index.ts", "./testing": "./src/testing/index.ts"}, "bin": {"rp-core": "./src/cli/main.ts"}
  LICENSE               # [D-11]
  PROVENANCE.md         # реестр портированных файлов: источник, коммит, что изменено (§2)
  src/
    index.ts            # Engine, типы, Event/Command (публичный API)
    engine/
      engine.ts         # сессии, идущие ходы, полосы
      turn.ts           # машина состояний хода; точки хуков (пустые до M9)
      narrate.ts        # цикл тулов поверх провайдера
      recover.ts        # разбор открытых ходов и задач при открытии
      lane.ts           # фоновая очередь сессии: попытки, вытеснение, парковка, задержка фона
      sched.ts          # семафор на origin (scheme://host:port): interactive / background
      abort.ts          # дерево AbortSignal, типизированные причины
      hooks.ts          # M9: гейты review/transform, beforeAssemble, transformReply
    session/
      entries.ts        # объединение Entry (формат на диске)
      log.ts            # append, fsync/fdatasync, чтение по LF, рваные строки, lock, compact
      tree.ts           # родители, путь, сиблинги, спуск к новейшему потомку, хвосты
      fold.ts           # PathView: путь, Директор, Compendium (compendiumAt), заметки, vars, fires
      fork.ts           # копия пути в новый файл-сессию
      port.ts           # M9: порт записей RecordStore + in-memory реализация
    prompt/
      assemble.ts       # чистая assemble(input) → {messages, tools, prefill, trace, varsDiff}
      shape.ts          # приведение под модель по ModelCaps (роли, префилл, кэш-метки)
      depth.ts          # ЕДИНСТВЕННАЯ функция глубины
      macros.ts  budget.ts  tokens.ts  rng.ts
    text/
      normalize.ts      # normalizeTerm: NFKC, регистр, ё→е, лёгкий стемминг
      lexscore.ts       # одно лексическое ранжирование: search_lore, селектор, шорт-лист и ростер Compendium
    lore/      engine.ts  keys.ts  timers.ts
    formats/
      native.ts         # Character, Persona, Preset, LoreBook + валидаторы
      card.ts           # CCv2/V3: JSON, PNG tEXt chara/ccv3, character_book
      st-preset.ts  st-worldinfo.ts
      compendium-v1.ts  # кодек compendium-v1.0.0 (RoleCall, Bunraku): импорт книги и экспорт копии
    providers/
      types.ts  caps.ts  caps-data/{hosts,models}.json  probe.ts
      http.ts           # fetch с замком на хост, таймауты первого байта и простоя
      sse.ts  reasoning-tags.ts
      openai-chat.ts    # M1
      anthropic.ts      # M7
      gemini.ts         # M8
      scripted.ts       # script: / record: / replay:
    tools/     types.ts run.ts args.ts prompted.ts leaks.ts builtin/{history,lore}.ts
    agents/
      structured.ts     # structuredCall: общий транспорт JSON для Директора и агентов Compendium
      director/         # state, plan, momentum, reduce, prompt, render, call, personalities/ [D-61]
      compendium/       # types, merge, render, apply, tree, select, place, world, filing, historian,
                        # recall/{index,prompt,parse,run}, profile, lexical
    protocol/  events.ts commands.ts rpc.ts jsonl.ts coalesce.ts
    config/    config.ts secrets.ts
    testing/   index.ts # M9: script/record/replay, describeRecordStoreConformance
    cli/       main.ts repl.ts render.ts oneshot.ts signals.ts bench.ts   # bench — rp-core bench ttft (M5c)
  test/  fixtures/{sse,assemble,sessions,scripts,cards,presets,lore,ru}
```

**Рантайм-зависимости по вехам:**

| Веха | Добавляется |
|---|---|
| M1 | ничего |
| M2 | `re2js` и `gpt-tokenizer` (загружается лениво) |
| M3 | `jsonrepair` |

Dev-зависимость — пермиссивный генератор JSON Schema из TS-типов; выбирается на M6.

---

## 5. Модель данных

### 5.1 Нативные типы

```ts
interface Character {                    // format: 'core.character/1'
  name: string; description: string; personality?: string; scenario?: string;
  greetings: string[];                   // [0] — first_mes, дальше alternate_greetings
  examples?: string;                     // mes_example как есть
  systemPrompt?: string; postHistory?: string;           // переопределения карточки (§10.2)
  depthPrompt?: { text: string; depth: number; role: 'system' | 'user' | 'assistant' };
  book?: LoreBook; creator?: string; tags?: string[];
  extras?: Record<string, unknown>;      // неизвестные поля карточки — для обратного экспорта
}
interface Persona {                      // format: 'core.persona/1'
  name: string; aliases?: string[];      // алиасы — для фильтра битов Директора
  description: string; book?: LoreBook;
}
interface Samplers {
  temperature?: number; top_p?: number; top_k?: number; min_p?: number; top_a?: number; typical_p?: number;
  repetition_penalty?: number; frequency_penalty?: number; presence_penalty?: number;
  seed?: number; stop?: string[]; max_tokens?: number;
}
interface Binding {
  conn: string; model: string;           // 'local:qwen3-14b' → conn 'local', model 'qwen3-14b'
  fallback?: { conn: string; model: string };
  maxTokens?: number; samplers?: Partial<Samplers>;      // поверх пресета; только для этой роли
  reasoning?: 'auto' | 'none' | 'low' | 'medium' | 'high';
}
type Roles = { narrator: Binding } & Partial<Record<'director' | 'recorder', Binding | 'narrator'>>
           & { recall?: Binding | 'narrator' | 'recorder' };   // recall → recorder → narrator [D-85]
// 'narrator' как значение — ссылка: она разрешается в момент вызова, поэтому /model narrator меняет и её.
// Если роль не задана, она равна 'narrator'.

interface SessionConfig {
  roles: Roles;
  preset: string;                        // имя в library или 'builtin'; читается каждый ход, хеш — в трассе
  lorebooks: string[];
  authorNote?: { text: string; depth: number; role: 'system' | 'user' };
  narrator: { maxRounds: number /* 4, потолок 8 */; prefillVsTools: 'prefill' | 'tools' /* [D-28] */ };
  director: { enabled: boolean; profile: 'auto' | 'full' | 'lite'; instructions: string;
              onSwipe: 'reuse' | 'replan' /* [D-29] */; timeoutSec?: number;
              style: string /* id личности, 'the-balanced' */; creativity: 'subtle' | 'moderate' | 'dramatic' /* [D-64] */ };
  compendium: CompendiumConfig;          // §7.4.9; заменяет memory {enabled, lag, recap, recapAfter, maxAttempts}
  reasoningShown: boolean; swipe: { showRejected: boolean };
  window?: number;                       // оверрайд окна; может только уменьшать
}
```

Если роль `director`, `recorder` или `recall` указывает на `'narrator'` (или `recall` — на `'recorder'`), а пресет задаёт семплеры, то агенты их **не** наследуют. Агенты используют только `Binding.samplers`; иначе у них температура провайдера по умолчанию.

### 5.2 Где что лежит

```
~/.rp-core/                    (переопределяется --home или RP_CORE_HOME)
  config.toml                  соединения, роли, оверрайды возможностей, цены; БЕЗ секретов
  caps-cache.json              результаты probe по connection:model, с датой
  library/{characters,personas,presets,lorebooks}/*.json   нативные форматы
  sessions/<id>.jsonl          журнал сессии — единственное долговечное состояние
  sessions/<id>.lock           {pid, host, started, renewed}
```

- **Файлы.** Хранятся обычные файлы, без базы данных [D-13].
- **`--sandbox`** переводит `--home` во временный каталог, заполняет его из `--seed <file>` и удаляет при выходе.
- **Каст сессии** (карточка и персона) замораживается при создании, поэтому правка библиотеки не меняет идущую историю молча. Перезагрузить каст можно явной командой `/card reload`: она пишет запись `config`.
- **Пресет и лорбуки** читаются из библиотеки на каждом ходу. Их хеши попадают в трассу.

### 5.3 Журнал сессии: append-only JSONL-дерево

Первая строка — заголовок. Каждая следующая строка — запись с монотонным `seq`. Сообщения связаны в дерево через `parent`. Всё остальное либо прикреплено к сообщению или ходу, либо служит управляющей записью.

```ts
type Entry =
  | { t: 'session'; v: 1; id: string; created: string; title?: string;
      fork?: { from: string; at: string };                          // форк: исходная сессия и сообщение
      cast: { character: Character; persona?: Persona }; config: SessionConfig; vars0?: VarsDiff }
  | { t: 'config'; seq: number; ts: string; patch: Partial<SessionConfig> }   // версию НЕ меняет
  | MsgEntry
  | ({ t: 'edit'; seq: number; ts: string; target: string; reason: 'user' | 'continue'; turn?: string }
      & Partial<CommitBody>)                                        // continue несёт gen/trace
  | { t: 'hide'; seq: number; ts: string; target: string; hidden: boolean }
  | { t: 'head'; seq: number; ts: string; leaf: string }           // явный перенос головы
  | { t: 'turn'; seq: number; ts: string; turn: string; kind: TurnKind; parent: string;
      target?: string; msgId: string; seed: number; now: string; base: number }
  | { t: 'prep'; seq: number; turn: string; dir?: DirectorRecord; recall?: RecallRecord; vars?: VarsDiff; trace: Trace } // до отправки
  | { t: 'chk'; seq: number; turn: string; text: string }          // дельта текста
  | { t: 'held'; seq: number; turn: string; body: CommitBody }     // ответ готов, но конфликт (M6)
  | { t: 'end'; seq: number; ts: string; turn: string; code?: string;
      outcome: 'failed' | 'stopped-empty' | 'dropped' | 'discarded' | 'abandoned' }
  | { t: 'job'; seq: number; ts: string; job: string; key: string; task: 'file' | 'hist';
      on: string; state: 'begin' | 'failed'; attempt: number; code?: string }
  | MemEntry;                                                       // строка Compendium, §5.8
// зарезервировано, в v1 не пишется: { t: 'dirEdit' } (правки Директора человеком),
// поле branch в msg/head (именованные ветки; записи без него принадлежат 'main')

interface MsgEntry extends Partial<CommitBody> {
  t: 'msg'; seq: number; ts: string;
  id: string;                  // 8 hex; выдаётся при начале хода, чтобы `start` мог его объявить
  parent: string | null;       // null — корень (приветствия — сиблинги-корни)
  role: 'user' | 'assistant'; speaker?: string /* зарезервировано [D-10] */; turn?: string;
  tail?: true;                 // ответ закоммичен хвостом (§6.6): голову не переносит, коммит остаётся одной строкой
}
interface CommitBody { blocks: Block[]; gen?: Generation; trace?: Trace; dir?: DirectorRecord; recall?: RecallRecord; vars?: VarsDiff }
type VarsDiff = Record<string, string | number | null>;
type TurnKind = 'reply' | 'swipe' | 'continue';
```

**Атомарный коммит — одна строка.**

- Успешный ход записывается одной строкой `msg`, а для continue — одной строкой `edit`. В неё входят `gen`, `trace`, `dir` и `vars`.
- Строка пишется одним `write()`, затем делается `fsync`. Рваная строка при чтении отбрасывается, поэтому ответ и всё, что к нему прикреплено, появляются вместе или не появляются вовсе.

**Долговечность.**

- **Всё, кроме `chk`,** пишется с fsync.
- **Строки `chk`** пишутся без fsync на каждую строку. Пока идёт стрим, таймер раз в 2 с делает `fdatasync`.
- **Падение процесса**, включая `kill -9`, не теряет ничего, что уже было записано.
- **Отключение питания** теряет не больше ~2 с текста.

**Чтение.**

- Байты делятся по LF, каждая строка разбирается отдельно.
- **Последняя строка рваная или невалидная** — она отбрасывается. Её копия уходит в `<id>.torn`, а файл обрезается при следующем взятии lock.
- **Невалидная строка в середине** пропускается и выдаётся как `notice`.
- Разбор никогда не идёт по принципу «всё или ничего». Файл целиком загружается в память вместе с индексом: id → запись, дети, правки по цели.

**Голова и версия.**

- У сессии одна голова — лист активного пути. Новое `msg` переносит голову на себя, кроме `msg` с `tail:true`. Явный перенос (выбор свайпа, откат) — это запись `head`.
- `version(session)` — это `seq` последней записи `msg`, `edit`, `hide` или `head`.
- Записи `config`, `turn`, `prep`, `chk`, `held`, `end`, `job` и `mem` версию **не** меняют. Поэтому `expectedVersion` у UI остаётся годным, пока идёт стриминг, пока пишут агенты Compendium и пока меняются настройки.

**Хвосты.** Листья вне активного пути — это хвосты. Их показывают `/tails` и `history/tails`. На хвост переходят через `history/select`.

**Форк** (`session/fork {at}`) создаёт новый файл.

- В заголовке — `fork` и текущая `config`.
- Копируются записи `msg`, `edit`, `hide` и `mem`, относящиеся к сообщениям пути до `at` включительно, а также `mem` с `on:null`.
- `seq` перенумеровываются, id сообщений сохраняются.
- Задачи полосы Compendium на форке выводятся заново по ключам и покрытию (§6.7).

Так ядро моделирует «дубли» (takes) Bunraku: каждый дубль — отдельная сессия, и в разных сессиях ходы идут параллельно.

**Компактизация.** `rp-core compact` переписывает файл без строк `chk` и `prep` у закрытых ходов. Это единственная операция, которая переписывает журнал: сначала пишется временный файл, затем выполняется rename под lock.

### 5.4 Сообщения и блоки

```ts
type Block =
  | { k: 'text'; text: string }
  | { k: 'reasoning'; text: string; kind?: 'raw' | 'summary' | 'omitted' | 'redacted' }
  | { k: 'tool_call'; id: string; name: string; args: string }   // канонический id; ремап по диалекту
  | { k: 'tool_result'; callId: string; name: string; text: string; error?: boolean };
  // зарезервировано: { k: 'image'; mime: string; path: string }

interface Generation {
  kind: 'model' | 'greeting';
  connection?: string; model?: string; served?: string;   // served — что реально отдал роутер
  finish?: 'end' | 'length' | 'stopped' | 'interrupted' | 'content_filter' | 'refusal' | 'max_rounds';
  usage?: Usage; ms?: number; ttftMs?: number; reasoningMs?: number;
  transport?: 'native' | 'prompted' | 'none'; rounds?: number;
  preset?: { name: string; hash: string }; prefill?: string; guidance?: string;
  route?: { model: string; status: 'ok' | 'retry' | 'error'; code?: string }[];
}
interface MessageView {
  id: string; parent: string | null; role: 'user' | 'assistant'; blocks: Block[];   // действующие блоки
  gen?: Generation; hidden: boolean; edited: boolean; swipe: { index: number; count: number };
}
```

- **Рассуждения** всегда лежат отдельным блоком и никогда не вклеиваются в текст.
- **Дословные полезные нагрузки провайдера в журнал не пишутся.** Это блоки Anthropic с подписями, части Gemini с `thoughtSignature`, `reasoning_details` OpenRouter. Они живут в памяти, пока идёт цикл тулов текущего хода (§8.6). Между ходами повтор рассуждений Anthropic и Gemini не нужен [D-18], а восстановление после краша цикл не продолжает (§6.7).
- **`reasoning_content` DeepSeek** — простой текст. Он берётся из блоков `reasoning` с тем же `gen.model`.
- **Смена модели не требует переписывать историю,** потому что источник правды — блоки.

### 5.5 Свайпы, правки, continue, приветствия

- **Свайп / regenerate** — новое assistant-сообщение с тем же `parent` (сиблинг), голова переходит на него.
  - Номер позиции нигде не хранится: сиблинги упорядочены по `seq` и никогда не удаляются.
  - Для хоста с адресацией `(message, position)` позиция — это индекс сиблинга (`MessageView.swipe`).
- **Выбор старого свайпа** — `head` на самого нового потомка этого свайпа: спуск идёт по новейшему ребёнку. Вместе со свайпом возвращается и выросшее из него продолжение.
- **Откат** — `head` на более раннее сообщение. Следующая отправка создаёт развилку, а старое продолжение становится хвостом.
- **Правка** — запись `edit`. Действующие блоки = исходные + последняя правка. Сырой текст остаётся в журнале.
- **Continue** коммитится как `edit{reason:'continue'}` с полным новым текстом. Его чекпоинт содержит только добавку.
- **Hide** — мягкое скрытие: сообщение исключается из промптов и поиска, но остаётся в дереве. Жёсткого удаления нет.
- **Приветствия.**
  - Все приветствия карточки записываются при создании сессии как сиблинги-корни (`gen.kind:'greeting'`), голова стоит на приветствии 0.
  - До первого сообщения пользователя свайп приветствия — это навигация через `head`, без вызова модели.
  - Хосту, который хранит приветствие лениво (Bunraku), порт даёт `send(..., {greetingIndex})`. Ядро пишет **одну** строку `msg` пользователя с `parent` = приветствие `i`. Эта строка сама переносит голову, отдельная `head` не нужна, так что запись атомарна.

### 5.6 Раунды тулов

Раунды тулов хранятся **внутри** assistant-сообщения как чередование блоков: text, tool_call, tool_result, text. Это нужно для показа, поиска и полной трассы.

В последующих ходах сборка рендерит только текстовые блоки [D-16]. Так делают и RoleCall, и Bunraku, и у этого три плюса:

- префикс стабилен;
- native- и prompted-формы не смешиваются;
- подписанные рассуждения из чужих ходов не попадают в запрос.

Вариант «отдавать тулы и в последующих ходах» — позже, если найдётся потребитель.

### 5.7 Трасса

```ts
interface Trace {
  seed: number; now: string; window: number; reserve: number;
  tokens: { estimated: number; reported?: number };
  blocks: { src: string; role: string; tok: number }[];          // 1:1 с отправленными сообщениями
  lore: { fired: { book: string; id: string; why: string }[]; cut: string[]; budget: number };
  recap: { ids: string[]; arcs: { key: string; rev: number }[]; boundary: string | null };   // что стоит в слоте и где обрезка (§7.4.4)
  compendium?: { rev: string; source: 'sync' | 'prefetch' | 'lexical' | 'reused' | 'off';
                 picks: { ref: string; via: 'mention' | 'model' | 'window' }[];
                 injected: { ref: string; tok: number }[]; cut: { ref: string; tok: number }[];
                 repeated: string[]; hidden: number };                // без текстов записей (§7.4.1)
  prefill: 'sent' | 'tools_off' | 'skipped_for_tools' | 'unsupported' | null;   // [D-28]
  macros: { unknown: string[] };
  trimmed: { from: string; to: string } | null;
  calls: { callKey: string; agent: string; model: string; ms: number; usage?: Usage }[];
  agents: Record<string, { status: 'done' | 'reused' | 'skipped' | 'failed'; code?: string; transport?: string }>;
  tools?: { name: string; ok: boolean; repaired?: string[] }[];
  hooks?: { name: string; ok: boolean; note?: string }[];        // M9
  presetHash: string; loreHashes: Record<string, string>;
  partial?: true;                                               // трасса из `prep` восстановленного хода
}
```

- **Размер.** Трасса компактная, 1–3 КБ. Полные тексты запросов не хранятся.
- **Пересборка.** `/preview --turn <id>` пересобирает запрос детерминированно по `seed`/`now` из записи `turn`. Если хеши пресета или лорбука не совпадают, выдаётся предупреждение.
- **Отладка.** `--keep-requests` пишет полные тексты в `sessions/<id>.requests/`.
- **Чего в трассе нет никогда:** секретов и значений пользовательских заголовков (только имена).

### 5.8 Записи Compendium на пути (рев. 6)

*Рев. 6.* Хроника заменена Compendium целиком [D-26]. Хранение осталось прежним: строки `mem`, привязанные к сообщениям, и свёртка по активному пути. Записи стали типизированными записями Compendium с полями в `data` [D-69, D-74]. Квитанций, undo и записи в книги, как в Bunraku, нет: свайп, откат и форк убирают записи сами. Агенты, которые пишут строки, — §7.4.

**Строка `mem`** (в §5.3 на неё ссылается `| MemEntry`):

```ts
type MemEntry = {
  t: 'mem'; seq: number; ts: string;
  key: string | null;            // ключ задачи (см. таблицу); null — строка человека
  on: string | null;             // сообщение, к которому привязана строка; null — глобальная правка человека
  by: 'filing' | 'historian' | 'user';
  range?: [string, string];      // первое и последнее сообщение пути, которые покрыла задача
  ops: MemOp[];                  // [] — «записывать нечего»; ключ всё равно закрыт [D-68]
  skipped?: { path: string; why: string }[];   // что отброшено и почему, например 'filings[3].entry.severity'
  gen?: { model: string; profile: 'full' | 'lite'; transport: 'structured' | 'tagged'; calls: number; ms: number };
};
type Rec = Record<string, unknown>;
type MemOp =
  | { op: 'file'; type: EntryType; data: Rec }        // создать или дописать запись; какую — решает свёртка по имени
  | { op: 'arc'; plot: string; overview: string }     // обзор сюжета, переписывается целиком (historian)
  | { op: 'note'; title: string; keys: string[]; content: string }   // заметка человека без типа (M3)
  | { op: 'edit'; ref: string; set?: Rec; unset?: string[]; keys?: string[]; featured?: boolean }
  | { op: 'retire'; ref: string; reason: string }
  | { op: 'restore'; ref: string }
  | { op: 'revert'; key: string };                     // забрать проход задачи с этим ключом
```

| Кто пишет | `key` | `on` | `range` | Операции |
|---|---|---|---|---|
| filing | `file:<A.id>`, где A — последний ответ группы | A | от первого сообщения игрока группы до A | `file` любого типа, кроме `summary` |
| historian | `hist:<newFromId>-<toId>`: первое новое сообщение окна и последнее; перекрытие в ключ не входит | `toId` | новые сообщения окна, без перекрытия | `file` типов `summary` и `plot`, `arc` |
| человек | `null` | `null`; у `revert` — `on` забираемой строки | — | все; `file` — ручное добавление |

**Правила.**
- **Модель только добавляет.** Агенты пишут `file` и `arc`. Удалять, списывать и переименовывать записи они не могут (D-67.1, правило R3 Bunraku).
- **Новейшее действие по ключу [D-74].** Для каждого ключа задачи в свёртку входит только последнее по `seq` действие: строка с этим ключом или `revert` этого ключа.
  - `/memory refile` пишет новую строку с тем же ключом, и она заменяет прежнюю.
  - `/memory undo` пишет `revert`. *Рев. 6:* `revert` закрывает ключ и для полосы: диапазон отменённой строки считается покрытым, и водяной знак historian его учитывает. Заново проход пишут только `/memory refile`, устаревание (ниже) и `/memory retry`. В Bunraku отменённый пересказ, наоборот, пишется снова.
  - Повторный запуск задачи после краша поэтому ничего не применяет дважды.
- **Правки человека** с `on:null` действуют на любом пути, где есть их цель. Форк их копирует (§5.3), свайп и откат не трогают. Если цели на пути нет, операция пропускается и попадает в `issues`.
- **Устаревание** — правило D-68.4, распространённое на filing [D-86]. Строка агента устарела, если в её `range` есть `edit` или `hide` с бо́льшим `seq`. Такая строка выпадает из свёртки, её диапазон снова не покрыт, и полоса записывает его заново (§7.4.7). Скрытые сообщения заново не записываются.

**Типы записей** — 11 типов Bunraku и RoleCall, в порядке корзин дерева: character, location, item, power, organization, event, plot, threat, worldbuilding, summary, creature.

```ts
export const ENTRY_TYPES = ['character', 'location', 'item', 'power', 'organization', 'event',
  'plot', 'threat', 'worldbuilding', 'summary', 'creature'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];
```

- **SPEC** портируется дословно из `BR:src/core/compendium/entry-types.ts`. Полей верхнего уровня — 223:

  | character | location | item | power | organization | event | plot | threat | worldbuilding | summary | creature |
  |---|---|---|---|---|---|---|---|---|---|---|
  | 30 | 18 | 19 | 22 | 24 | 15 | 18 | 18 | 11 | 15 | 33 |

- **Обязательные поля.** У девяти типов — `name`; у worldbuilding — `topic`, `category` и `description`; у summary — `title` и `summary`. Имя записи — `name`, иначе `title`, иначе `topic`.
- **Чтение снисходительное.** `parseStructured` сохраняет неизвестные поля и ничего не отклоняет; вложенные формы не проверяет. Отклонять — дело пути записи (§7.4.3).
- **Алиасы.** В SPEC `aliases` есть только у character. Свёртка читает `data.aliases` у любого типа, как `readEntry` Bunraku, поэтому склейка по алиасам работает для всех типов.
- **Tagline.** Поле есть только у summary, creature и power. У остальных он выводится: первое предложение `description`, не длиннее 80 символов. Иначе индекс recall показывал бы голые имена для 8 типов из 11.
- **Служебные поля памяти RoleCall** (`writer_source`, `source_turn`, `source_job_id`) модель не видит. Происхождение хранит свёртка, а экспорт проставляет `source_turn` (§7.4.8).

**Запись** — то, что выдаёт свёртка:

```ts
interface CEntry {
  key: string;                       // постоянный ключ, см. ниже
  type: EntryType | null;            // null — заметка человека или классическая запись книги
  name: string; aliases: string[]; tagline: string;
  data: Rec;                         // типизированные поля; неизвестные сохранены
  keys: string[];                    // ключи лора — только у заметок
  content?: string;                  // только у заметок; текст типизированной записи — всегда renderContent(type, data)
  origin: { kind: 'session' } | { kind: 'library'; book: string; id: string; overlay: boolean };
  retired?: { reason: string }; featured?: boolean;
  order?: number;                    // позиция в библиотечной книге
  range?: [string, string];          // пересказ: покрытые сообщения
  arc?: string;                      // обзор сюжета: имя сюжета
  prov: {
    created: string | null;          // `on` строки, которая создала запись; null — человек или библиотека
    lastSeq: number;                 // последняя строка, которая её изменила
    appended: Record<string, (string | null)[]>;   // массивы верхнего уровня: `on` строки, добавившей каждый элемент
  };
}
interface CompendiumView {
  entries: ReadonlyMap<string, CEntry>;   // живые и списанные; потребители фильтруют сами
  rev: string;                            // хеш применённых строк и хешей книг — для трассы
  lastSeq: number;
  issues: { seq: number; op: number; why: string }[];   // что свёртка пропустила: для /memory и трассы
}
```

**Ключи записей** не зависят от `seq`. Форк перенумеровывает `seq` (§5.3), и прежние id `r<seq>.<i>` после него ломались бы.

| Запись | Ключ |
|---|---|
| типизированная, созданная в сессии | `<type>:<normalizeName(имя при создании)>`; если ключ занят (например, списанной записью) — `#2`, `#3` |
| пересказ | `summary:<toId>.<i>` — i-й пересказ строки historian |
| обзор сюжета | `arc:<normalizeName(сюжет)>` |
| заметка | `note:<normalizeName(title)>`, при совпадении — `#n` |
| библиотечная запись и её оверлей | `lib:<книга>:<id записи>` |

- **`normalizeName`** — порт `BR:relationships.ts:39`: нижний регистр, всё, кроме букв, цифр и пробелов, превращается в пробел. Он учитывает Unicode, так что кириллица сохраняется.
- Ключ не меняется при переименовании записи.
- **Ключ — не хэндл.** Модель видит короткие хэндлы на один ход: `e<n>` в индексе recall, `C<n>` в тулах [D-59]. REPL показывает `C<n>` по порядку создания на пути.

**Свёртка** — `session/fold.ts`, чистая функция:

```ts
compendiumAt(msgId) = fold(
  memRows.filter(r => r.on === null || ancestorsOrSelf(msgId).has(r.on))   // привязка к пути
         .filter(r => !stale(r))                                           // D-68.4
         .filter(newestActionPerKey),                                      // refile и revert
  bySeq, applyMemOp, readableLibraryEntries)                               // затравка — типизированные записи книг
```

`applyMemOp`:
1. **`file`** ищет живую запись того же типа, у которой имя, заголовок или алиас совпадает с именем или алиасами операции после `normalizeName` (`findMatch` Bunraku). Сначала — в сессии, потом в типизированных записях читаемых книг.
   - **Нашлась запись сессии** — слияние (ниже); каноническое имя остаётся.
   - **Нашлась библиотечная запись** — **оверлей** с тем же ключом `lib:…`: `data` — слияние данных книги и операции. Файл книги не меняется [D-3, D-75].
   - **Имя занято записью без типа** — операция пропускается с причиной `classic_conflict`. Bunraku тоже оставляет такую запись «как написано».
   - **Ничего не нашлось** — новая запись, если есть обязательные поля; иначе причина `missing_required`.
   - **Пересказ ни с чем не сливается.** Его тождество — заголовок и диапазон строки. Bunraku слил бы два пересказа с одинаковым заголовком.
   - Обновляется `prov`: `lastSeq`, а для каждого нового элемента массива — `on` строки.
2. **`arc`** заменяет обзор `arc:<plot>` целиком. Если сюжета нет, создаётся `{name, status:'active'}` (`prepareItems` Bunraku).
3. **`note`** создаёт заметку.
4. **`edit`**: `set` заменяет поля верхнего уровня, `unset` удаляет их. Смена имени переименовывает запись, а ключ остаётся. Правка библиотечной записи тоже даёт оверлей.
5. **`retire` / `restore`** ставят и снимают флаг. Списанную запись `findMatch` не находит, поэтому следующая операция с тем же именем создаёт новую запись (`#2`).

Операции адресованы по имени, а не по id. Поэтому строку, которая легла позже по времени, чем следующие за ней по пути (догоняющий historian), свёртка применяет правильно.

**Слияние [D-81]** — `mergeData` Bunraku плюс ключи массивов RoleCall:
- пустое значение ничего не стирает;
- скаляры заменяются, объекты сливаются вглубь, поле имени не заменяется;
- массивы дописываются. У поля с ключевой функцией RoleCall (`ARRAY_KEY_FNS`, `compendium-definitions.ts:105`) элемент с тем же ключом сливается с имеющимся, а не добавляется:
  - `relationships` — по `with` и `nature`;
  - `memories` — по `what_happened` и `when`;
  - `affiliations` — по `with`;
  - списки строк — по нормализованной строке.

  Без этого смена статуса связи с `active` на `strained` дала бы вторую связь. У остальных полей — `deepEq`, как в Bunraku;
- перефразированные короткие факты в списках строк схлопываются (RoleCall, `:200-264`). Дубль — когда все значимые слова меньшего факта есть в большем или их Jaccard ≥ 0,8; значимые — слова от 3 букв без стоп-слов, и у меньшего факта их должно быть не меньше 3. Слова берутся через `normalizeTerm` (§7.5): токенизация RoleCall `[^a-z0-9]` стирает кириллицу.

**Стоимость.** Строки `mem` не меняют `version` (§5.3), поэтому свёртка кэшируется по `(version, lastMemSeq, хеши читаемых книг)`.
- Цель — 5 000 строк и 1 500 записей быстрее 30 мс, в пределах 50 мс на `PathView` (§5.11).
- Если бенчмарк не выдержит, свёртка станет инкрементальной: строки только дописываются, и при том же пути применяются лишь новые.

**Заметки** — записи человека без типа (`note`), бывшая ручная Хроника (M3).
- Свёртка отдаёт их движку лора отдельной книгой `{name:'Заметки', scanDepth:4, match:'stem', wholeWords:false}`.
- Позиция — `{depth:4}`, обёртка — `[Memory: title]`, источник в трассе — `compendium` (§10.1).
- Ключи сравниваются по основам: «Мира» срабатывает и на «Миру», и на «Мирой».
- На M3 свёртка умеет `note`, `edit`, `retire` и `restore` над заметками; остальное — M5a.
- Типизированные записи в движок лора не попадают: их включает Compendium (§7.4.1) [D-76].

**Дерево** — производное и нигде не хранится. Это порт `BR:tree.ts` (213 строк) без изменений:
- типизированный режим — если включённых записей ≥ 5 и типизированных среди них ≥ 50 %; иначе — категории книги и группа General;
- 11 корзин плюс Unsorted;
- подгруппы:
  - Cast — по `affiliations[0].with`;
  - Places — вложенно по `parent_location`, циклы разрываются;
  - Events — по `related_plots[0]`;
  - Threats — по степени угрозы;
  - Worldbuilding — по `category`;
  - Narrative — по `parent_plot`, обзор арки первым;
  - Bestiary — по `classification`.

Дерево читают индекс recall в профиле full (§7.4.2), `/memory tree` и `memory/tree`. Сессия и каждая читаемая книга — отдельные деревья. Построенное моделью дерево Bunraku (Lock, Forbid, пины) не переносится: recall его не читает, это интерфейс авторинга.

**Рендер.**
- **`renderContent(type, data)`** — порт `BR:render.ts` дословно:
  - `# Имя`;
  - абзацы tagline, description и summary;
  - разделы `## Поле` в порядке SPEC, затем неизвестные поля по алфавиту;
  - `preserved_prose` не выводится.

  Текст всегда выводится из данных и никогда не сравнивается с хранимым.
- **`renderBrief(entry, maxChars)`** — новый:
  - строка имени, затем tagline или первое предложение описания;
  - дальше несколько полей по типу. У персонажа: роль, состояние, до 3 связей (сначала `strained`, `rival`, `enemy`), последние 2 памяти (`what_happened` и `changed_belief`);
  - текст режется по границе предложения;
  - если у рассказчика включены тулы, в конце стоит `(ещё: read_lore C12)`.
- Перед рендером в блок данные проходят фильтр свежести (§7.4.1).

**Границы [D-87].** Они заменяют лимит записи в 800 символов из D-67.3.

| Граница | full | lite | Откуда |
|---|---|---|---|
| элементов за проход filing или historian | 12 | 6 | `MAX_ITEMS` Bunraku |
| JSON одного элемента | 6 000 символов, глубина ≤ 6 | 3 000 | `MAX_ITEM_CHARS`, `MAX_DEPTH` |
| операций одной строки `mem` | 24 000 символов JSON; остальное — в `skipped` | то же | вместо `RECEIPT_BUDGET` 48 000 |
| обзор сюжета | 6 000 символов | 1 200 | `historian.ts`; в lite — по слоту (§7.4.4) |
| текст пересказа | 1 500 символов | то же | D-68.2 |
| запись целиком | при записи не ограничена; на 12 000 символов JSON — `notice{compendium_large_entry}` один раз | то же | у Bunraku предела нет |
| текст в промпте | полный рендер ≤ 4 000 символов, иначе краткий | краткий ≤ 700 | §7.4.1 |

Почему у записи нет предела при записи: тогда сломался бы договор upsert — «присылай дельты, удалить ничего нельзя». Предел стоит на рендере и в снимке filing (пометка `[N chars - add to it, do not rewrite]`).

**Библиотечные книги** читаются и не пишутся [D-3, D-75].
- **Типизированная запись книги** — `LoreEntry` с `meta.type` и `meta.data`. Это поле `data` из D-69, теперь настоящее. При импорте `metadata.entry_type` и `metadata.structured_data` RoleCall становятся `meta.type` и `meta.data`.
- **Перечитывание.** Книги перечитываются каждый ход (§5.2), их хеши — в трассе и в `rev`.
- **Оверлей.**
  - Первая операция о сущности из книги создаёт оверлей с тем же ключом; следующие дельты сливаются в него.
  - Если книга поменяла запись посреди сессии, дельты заново накладываются на новую основу, детерминированно по хешу книги.
  - Если запись из книги исчезла, оверлей хранит слитые дельты и помечается `library_entry_missing`.
- **Доступ.** Что Compendium делает с книгой, задаёт `compendium.books[<книга>]`: `read` (по умолчанию) или `off` [D-76].

**Что отменено:**
- id `r<seq>.<i>`;
- `ChronicleMeta`;
- операции `add`, `update` и `recap`;
- лимит 800 символов;
- книга Хроники для записей агентов.

`LoreEntry.meta` становится `CompendiumMeta {type?, data?, aliases?, featured?, arc?}` (§10.2).

### 5.9 Состояние Директора — снимок на каждую версию ответа

```ts
interface DirectorRecord {
  turn: number; ok: boolean; code?: DirectorFailCode;
  transport?: 'structured' | 'tagged'; model?: string;
  directive?: NarratorDirective; analysis?: PlanningAnalysis;   // форма — §7.3 [D-61]
  skipped: { path: string; why: string }[];
  attempts: { transport: string; outcome: string; ms: number; status?: number; finish?: string; tokens?: number }[];
  state: DirectorState;                 // после applyPlan и fitState (или прежнее с turn+1 при сбое)
  reducer: number;                      // версия редьюсера, которым получен снимок
  reusedFrom?: string;                  // id ответа, чей план повторно использован при свайпе [D-29]
}
```

**Как вычисляется состояние на сообщении пользователя U.** Берётся `dir.state` ближайшего предка-ответа, у которого есть `dir`. (Когда появятся правки человека, к нему будут применяться `dirEdit` на пути до U включительно.)

Из этого правила следует:

- **Свайп** планирует от состояния до заменённого ответа.
- **Будущая смена редьюсера** не переписывает уже сохранённые снимки.

**Восстановление.** Строка `prep` хранит `DirectorRecord`, и с fsync. Поэтому ответ, восстановленный после краша, получает свой `dir`: план не теряется, счётчик ходов идёт дальше.

**Размер.** Снимок ограничен лимитами и `fitState` (§7.3): ≤ 16 КБ типично, потолок 32 КБ [D-61].

### 5.10 Переменные и срабатывания лора

- **Переменные** [D-30].
  - Дифф макро-переменных коммитится вместе с ответом, значения — свёртка по пути.
  - Ход, который не закоммитился (сбой, stop без текста), переменных не меняет.
  - Перегенерация сама начинает с переменных «до ответа».
  - Это расходится с Bunraku и RoleCall: там переменные пишутся до отправки и при неудаче откатываются лишь частично.
- **Срабатывания лора** берутся из `trace.lore.fired` на пути. Из них считаются sticky, cooldown и delay.

### 5.11 PathView — единственное производное представление

```ts
interface PathView {
  session: string; head: string; version: number;
  path: MessageView[];                  // корень → голова; hidden помечены
  pathSet: Set<string>; tails: string[];
  directorAt(msgId: string): DirectorState;
  compendium: CompendiumView;           // свёртка на голове (§5.8)
  compendiumAt(msgId: string): CompendiumView;
  notes: LoreBook;                      // заметки человека для движка лора
  castNames: string[];                  // имена и алиасы карточки и персоны: снимок мира, §7.3
  vars: Record<string, string | number>;
  fires: { msgId: string; fired: Trace['lore']['fired'] }[];
}
```

- **Кто читает.** Сборщик, агенты, тулы и снимки протокола читают только `PathView`.
- **Как считается.** `PathView` пересчитывается целиком при смене версии и кэшируется по версии. Цель — < 50 мс на 10k сообщений. Если бенчмарк её не выдержит, тогда появится инкрементальная свёртка.

### 5.12 Порт записей (M9)

На M1–M8 у ядра одна реализация хранения — `session/log.ts` поверх файлов, без абстракции. На M9 из неё выделяется порт **на уровне записей**:

- хост хранит записи `Entry` ядра;
- свёртка (`fold.ts → PathView`), охрана версий и правила коммита остаются в ядре;
- поэтому хосту не нужно заново выводить состояние Директора или Compendium.

```ts
interface RecordStore {
  create(header: Extract<Entry, { t: 'session' }>): Promise<void>;
  acquire(session: string): Promise<Lease>;                   // эксклюзивно; Lease.renew() / release()
  read(session: string): AsyncIterable<Entry>;                // по seq; рваный хвост уже отброшен
  append(lease: Lease, entries: Entry[], durable: boolean): Promise<void>;  // каждая запись атомарна
  list(): Promise<{ id: string; title?: string; updated: string }[]>;
}
```

`describeRecordStoreConformance(make)` проверяет:

- монотонный `seq`;
- атомарность записи;
- что записи с `durable` переживают краш;
- эксклюзивность lease;
- порядок чтения.

Тесты гоняются на файловой реализации и на второй, in-memory, написанной по этой спецификации. Это доказывает, что порт не завязан на файлы.

---

## 6. Жизненный цикл хода

### 6.1 Глаголы

| Глагол | Что пишет | Веха | Примечание |
|---|---|---|---|
| `send(text, expectedVersion, {greetingIndex?})` | одно user-`msg` | M1 | Во время хода — отказ `session_busy`. Очереди в движке нет: REPL держит набранную строку у себя |
| `runTurn(kind, expectedVersion, {guidance?, fallback?, onError?, emptyReply?, inspect?})` | `turn`, `prep`, `chk*`, затем `msg`/`edit`, `held` или `end` | M1 (`inspect` — M9) | `reply` отвечает на голову-сообщение пользователя; `swipe` делает сиблинга головы-ответа; `continue` продолжает его |
| `submit(text, expectedVersion)` | send + reply | M1 | удобство для REPL и простых клиентов |
| `stop(turnId)` | частичный ответ или `end` | M1 | §6.5 |
| `edit` / `hide` / `select` / `fork` | одна запись / новый файл | M1 | Во время хода REPL их отклоняет сам. В `--stdio` движок их принимает, и ход кончается `conflict` |
| `commitAnyway(turnId)` / `discard(turnId)` | `msg`/`edit` / `end{discarded}` | M6 | §6.6 |
| `preview(draft?)` | ничего | M2 | Тот же путь сборки. Вместо директивы — заглушка, Директор не вызывается |
| `answerGate(turnId, gateId, answer)` | — | M9 | гейты `review` и `transform` (§12.5) |
| `draft({kind:'impersonate'} \| {kind:'quiet', prompt})` | ничего | M9 | Разовая генерация без чекпоинта, тулов и записей. `impersonate` пишет реплику за пользователя; `quiet` — ответ на произвольную инструкцию поверх собранного промпта, как quiet prompt в ST |
| `resume` | — | M1 | автоматически при открытии (§6.7) |

**Отказы** происходят **до** записи `turn`. Они возвращаются синхронно как ошибки: в протоколе — JSON-RPC error, в one-shot — код выхода 5. Событием отказ не приходит никогда. Коды:

- `stale_version`, `session_busy`, `session_locked`, `held_pending` (сначала нужно решить судьбу отложенного ответа);
- `no_connection`, `preset_missing`;
- `nothing_to_reply`, `nothing_to_swipe`, `nothing_to_continue`;
- `continue_target_hidden`, `continue_target_blank`;
- `gate_unsupported` (`inspect` без объявленного гейта).

Всё, что происходит после `start`, приходит событиями.

**Параллельность [D-25].** В одной сессии идёт не больше одного хода. Разные сессии, включая форки, генерируют одновременно.

### 6.2 Ответ (reply) по шагам

1. **Допуск** (синхронно).
   - `expectedVersion === version(session)`.
   - Голова — сообщение пользователя.
   - Нет открытого `held`.
   - Привязки ролей и записи возможностей разрешаются, пресет существует.
2. **Начало.**
   - Дописать `turn{turn, kind, parent, msgId, seed, now, base}` и сделать fsync. `seed` берётся из `crypto.getRandomValues`, `now` — из часов Engine.
   - Создать AbortController хода.
   - Отправить событие `start{turnId, kind, messageId, parentId}`.
3. **Предварительные проходы.**
   - Если Директор включён и `kind ≠ continue`, он запускается с дочерним сигналом и своим таймаутом (§7.3).
   - **Recall Compendium** на `reply` (§7.4.2): готовый prefetch, свой sync-вызов или выбор без модели — по режиму. Sync запускается вместе с Директором; если оба на одном origin с одним местом, семафор выполняет их по очереди, Директор первым. Prefetch, который ещё в полёте, ход ждёт не дольше `graceSec`. На свайпе и continue выбор повторяется без вызова.
   - Ни Директор, ни recall не могут провалить ход. Задержать его они могут не дольше своих таймаутов плюс ожидание очереди.
   - На M9 параллельно с ними идёт хук хоста `beforeAssemble`.
4. **Сборка — чистая функция.**
   - Вход: `assemble({view, cast, preset, lorebooks, placements, caps, budget, seed, now, kind})`. `placements` — директива и блок Compendium (§7.4.1); заметки Compendium приходят с `view`.
   - Выход: `{messages, tools, prefill, trace, varsDiff}`.
   - Правило «префилл или тулы» [D-28] применяется здесь.
   - Если не помещается одна только обязательная часть — `failed{code:'context_length_exceeded'}` и `end{failed}`, ничего не отправлено.
5. **Приведение под модель (shape) — чистая функция.** Роли, системные сообщения посреди диалога, префилл или подсказка continue, кэш-метки — всё по `ModelCaps`. Правки хоста задаются по индексу сообщения.
6. **Строка `prep`** с `dir`, `recall`, `vars` и трассой до отправки, с fsync.
7. **Хуки хоста (M9).**
   - `transformRequest` — гейт `transform`, fail-closed.
   - Гейт `review` — только при `inspect`.
   - Ответ `cancel`, Stop или уход потребителя дают `stopped{message:null}` и `end{dropped}`.
8. **Рассказ** — цикл тулов (§7.1).
   - Дельты приходят событиями `text`.
   - `chk{text}` пишется каждые 400 символов или каждую секунду. Пока идёт стрим, раз в 2 с делается `fdatasync`.
9. **Постобработка.**
   - Inline-рассуждения отделяются по тегам, протёкшая разметка тулов вырезается.
   - На M9 здесь же хук `transformReply`: он может переписать ответ или наложить вето (§12.5).
10. **Коммит.** Одна строка `msg` с охраной `base`.
    - Версия совпала — fsync и `done{message}`.
    - Версия устарела (M6) — `held{turn, body}`, fsync и `conflict{turnId, draft}` (§6.6).
11. **После хода.**
    - **При `compendium.filing.wait = 1`** (по умолчанию) задача `file` для **предыдущего** ответа A(n-1) ставится в момент `send` нового сообщения: тогда A(n-1) считается принятым. **При `wait = 0`** — сразу после коммита (§7.4.3).
    - После коммита, если recall работает в режиме `prefetch`, ставится `prerecall:<A(n)>` (§7.4.2).
    - Задачи идут в порядке prerecall → file → hist. На локальном origin фоновая задача стартует, только когда нет интерактивных запросов, и не раньше чем через `compendium.idleDelaySec` (8 с) после конца хода, то есть пока игрок пишет (§7.4.7).
    - Когда полоса пуста и ни один ход не идёт, отправляется `idle{background:0}`.

### 6.3 Свайп и guided re-roll

Свайп проходит те же шаги, с `parent` = родитель головы-ответа.

- **Директор [D-29].** При `director.onSwipe = 'reuse'` (по умолчанию) копируется `dir` заменяемого ответа, если там `ok:true`. Событие — `director{status:'reused'}`, в записи — `reusedFrom`. Это корректно, потому что обе версии ответа выросли из одного состояния на U. Если прошлый план провалился, а также при guided re-roll и при `onSwipe='replan'` Директор планирует заново, от состояния на U (§5.9).
- **Recall [D-78].** При `compendium.recall.onSwipe = 'reuse'` (по умолчанию) копируется `RecallRecord` заменяемого ответа — 0 вызовов, `reusedFrom`. На guided re-roll к нему добавляются записи, упомянутые в тексте указания. При `'rerun'` recall работает заново, по режиму.
- **Seed** берётся новый.
- **Guided re-roll** передаёт `guidance` (до 10 000 символов). Она рендерится системным блоком на глубине 0 с источником `guidance`. В блок входят текст указания и, если `swipe.showRejected = true` (по умолчанию), отвергнутый ответ, обрезанный до 2 000 символов. Указание сохраняется в `gen.guidance`.
- **Почему глубина 0:** она стоит после последнего сообщения — сообщения пользователя U — и последней. Поэтому у Anthropic она валидна как нативный system при любой истории (§8.5).

### 6.4 Continue

На continue нет ни Директора, ни тулов, ни агентов Compendium. Это правило одно для всех агентов. Блок Compendium повторяет выбор цели из её `RecallRecord`, без вызова; тексты записей берутся из текущей свёртки (§7.4.2).

- **Модель принимает префилл** (`caps.prefill = 'assistant-last'`): текущий текст уходит последним assistant-сообщением, добавка приклеивается как есть.
- **Модель префилл не принимает** (Claude ≥ 4.6, deepseek-reasoner, Gemini): старый текст уходит обычным assistant-ходом, за ним — user-подсказка «продолжи с того места, где остановился, не повторяй». Добавка присоединяется через пустую строку.
- **Эхо.** Если добавка начинается с повтора старого текста, повтор срезается.
- **Добавить нечего** — `failed{nothing_to_add}` и `end`.
- **Коммит** — `edit{reason:'continue', turn}` с `gen` и `trace`.

### 6.5 Stop

`stop` прерывает AbortController хода. Сигнал доходит до fetch провайдера, до `ctx.signal` каждого тула, до вызова Директора и до хуков хоста. Ожидающие гейты разрешаются как `cancel`, никогда как одобрение.

- **Текст уже пришёл.** Он коммитится с `finish:'stopped'`, событие — `stopped{message}`. Директива этого хода сохраняется в `dir`, потому что ответ существует.
- **Вызов тула без результата** получает синтетический результат `cancelled`, поэтому в хранилище блоки всегда парные.
- **Текста нет.** Пишется `end{stopped-empty}`, событие — `stopped{message:null}`.
- **Остановленный ход** не повторяется и не переходит на запасную модель.

### 6.6 Сбой, повтор, запасная модель, конфликт

**Повтор.**

- **Условия.** Ещё не пришли текст, рассуждение или результат тула, а ошибка — 408/425/429/500/502/503/504/524/529.
- **Как.** Один повтор с учётом `retry-after` (не дольше 8 с) и джиттером; событие `retry`.
- **Без повтора.** Неоднозначные сетевые ошибки после отправки тела (`fetch failed`) не повторяются: можно заплатить дважды.

**Запасная модель** (`fallback` в вызове или в привязке роли).

- Одна попытка, при тех же условиях и только с **другой** парой connection:model.
- Никогда не используется после Stop.
- Маршрут пишется в `gen.route`.

**Сбой после начала вывода [D-22].**

- **Движок по умолчанию** (`onError:'drop'`, как в Bunraku): чекпоинт сбрасывается (`end{failed, code}`), отправляется `failed{category, code, message, draft}`, черновик есть только в событии.
- **REPL и one-shot** передают `onError:'keep'`: накопленный текст коммитится с `finish:'interrupted'`, и из CLI он не пропадает.
- **`turn/run` в `--stdio`** по умолчанию использует `'drop'`.
- **Ответ пришёл полностью, но упала запись или постобработка** — чекпоинт остаётся, ответ будет закоммичен при следующем открытии.

**Ответ из одних рассуждений [D-31].**

- `emptyReply:'fail'` (по умолчанию) — `failed{code:'reasoning_only', draft: <рассуждение>}`.
- `emptyReply:'keep'` (так будет вызывать Bunraku) — коммит сообщения с пустым текстом и блоком рассуждений.
- Исключение: запись возможностей говорит, что сервер кладёт ответ в поле рассуждений. Тогда это поле — текст ответа.

**Конфликт (M6).** Это ситуация, когда во время хода сессию изменили: правкой, скрытием или переносом головы.

- `held{body}` хранит готовый ответ вместе с трассой и снимком Директора.
- `commitAnyway(turnId)` коммитит по **правилу безусловного коммита** (оно же используется при восстановлении):

| kind | Куда пишется | Голова |
|---|---|---|
| `reply` | ребёнком исходного родителя U | переходит на ответ, если голова всё ещё U |
| `swipe` | ребёнком исходного родителя U, то есть сиблингом заменяемого ответа | переходит на ответ, если голова — ребёнок U |
| `continue` | правка цели A, если A не скрыта и её действующий текст не менялся с начала хода | не меняется |

- **Ответ (`reply` или `swipe`) никогда не вешается под assistant-сообщение.**
  - Если голова ушла, ответ становится хвостом, и приходит `notice{code:'committed_as_tail'}`. Хвост — это одна строка `msg` с `tail:true`: голова остаётся на месте, и краш между «ответом» и «возвратом головы» невозможен.
  - Если U скрыт — `end{dropped}`, черновик приходит в событии.
- **Continue, у которого цель изменилась,** заканчивается `end{discarded}`, черновик приходит в событии. Такой текст никогда не применяется к изменённому тексту без спроса.
- `discard(turnId)` пишет `end{discarded}`.

### 6.7 Краш и восстановление

При открытии, после взятия lock, `recover.ts` находит строки `turn` без закрывающих `msg`, `edit(turn)` или `end` и разбирает каждую:

| Что найдено | Что делаем |
|---|---|
| есть `held` | Ход остаётся открытым. Снимок сессии показывает его клиенту, REPL спрашивает «сохранить / отбросить». Пока он не решён, новые ходы получают отказ `held_pending` |
| есть текст в `chk` | Склеиваются дельты, коммит с `finish:'interrupted'`. `dir`, `recall`, `vars` и трасса (`partial:true`) берутся из `prep`. Охрана — `base`; при конфликте применяется правило безусловного коммита (§6.6), а continue при конфликте получает `end{abandoned}` |
| ничего | `end{abandoned}` |

- О каждом разобранном ходе отправляется `recovered{turnId, outcome, draft?}`. `outcome` — `interrupted`, `abandoned` или `dropped` (U скрыт, §6.6); если текст из `chk` не закоммичен (`dropped` или continue на изменённой цели), он приходит в `draft`.
- **Цикл тулов не продолжается и не повторяется,** поэтому оплаченные вызовы модели не повторяются. Тулы v1 только читают, так что текстового чекпоинта достаточно.
- Раунды тулов упавшего хода не восстанавливаются, восстанавливается только текст. Чекпоинт после каждого раунда тулов появится вместе с пишущими тулами.

**Задачи полосы Compendium** восстанавливаются по ключам `file:` и `hist:` (§7.4.7):

1. `job{begin}` без `mem` с тем же ключом и без более позднего `job{failed}` — задача ставится заново, со следующим номером попытки.
2. Принятые ответы на пути, которые не покрывает `range` ни одной неустаревшей строки filing (отменённые `revert` тоже покрывают), и назревшие окна historian — ставятся задачи, начиная с момента включения Compendium (по `seq` записи `config`). Исключение — ключи, у которых уже `compendium.maxAttempts` (по умолчанию 3) записей `job{failed}`: они **припаркованы**. Задача `prerecall` не восстанавливается: после краша это промах.
3. Припаркованный ключ ставится снова только командой `/memory retry [msgId]` (`memory/retry`).

Вытесненные запросы (`preempted`, §8.8) ничего не пишут и попыткой не считаются. Строка `mem` атомарна и привязана к ключу, поэтому повторный запуск ничего не применяет дважды.

### 6.8 Дерево отмены и типизированные причины

```
turn ─┬─ director ── fetch                     (budget:director — по соединению, §7.3)
      ├─ recall ── fetch | ждёт prefetch       (budget:recall — от гранта; prefetch: superseded после graceSec)
      ├─ host hooks (M9) ── gates              (cancel при Stop / consumer_gone; сбой → fail-closed)
      └─ narrator rounds ─┬─ fetch             (timeout:first_byte, timeout:idle)
                          └─ tools(ctx.signal)
session lane ── prerecall | file | hist         (свои контроллеры; preempted, superseded, shutdown)
```

- **Причины прерывания:** `user_stop`, `timeout:first_byte`, `timeout:idle`, `budget:director`, `budget:recall`, `preempted` (только фоновые), `superseded` (prefetch заменён новым или не дождался хода), `shutdown`, `consumer_gone`.
- Таймаут никогда не выдаётся за Stop.
- **Если уходит потребитель** (`consumerSignal`), ожидающие гейты закрываются как `cancel`, а ход продолжается и коммитится.

### 6.9 Детерминизм

- **Сборка.** `assemble` — чистая функция.
  - Из сохранённого `seed` выводятся подпотоки RNG (splitmix32): вероятность лора, группы включения, `{{random}}`/`{{pick}}`/`{{roll}}`.
  - `now` берётся из записи `turn`.
- **Что из этого следует.**
  - Восстановление берёт трассу из `prep`, а `/preview --turn` воспроизводит лор и макросы хода точно.
  - Свайп тянет новый seed.
- **Запреты.** В `src/` нет `Math.random` и `Date.now`. Это проверяет правило линтера, а часы и энтропию передаёт Engine.

---

## 7. Агенты

Рассказчик работает как **гибрид** [D-1].

- **Фиксированные проходы** выполняются каждый ход, когда включены. Поэтому цена и задержка предсказуемы, а слабым локальным моделям не приходится самим решать, когда планировать и что запоминать.
- **Read-only тулы** доступны рассказчику поверх них, по требованию.
- **Агентов вызывает оркестратор, а не модель.** В RoleCall модели почти не вызывали `spawn_agent`.

| Агент | Когда | Вход | Выход | Вызовы |
|---|---|---|---|---|
| Рассказчик | каждый ход | собранный промпт + тулы | блоки ответа | 1 + раунды тулов (по умолчанию ≤ 4, потолок 8) + финальный текстовый раунд |
| Story Director | до reply и guided re-roll; на обычном свайпе по умолчанию повторно использует план [D-29]; никогда на continue | состояние на U, импульс, свежая история, ход игрока | `PlanningRound` (директива + обновления состояния, §7.3) | 1 (+1 корректирующий) |
| Compendium · recall | перед `reply`: sync, заранее в фоне (prefetch) или без модели; на свайпе и continue — повтор выбора | индекс кандидатов + свежая беседа | `entry_ids` → блок на глубине 1 | sync — 1 (+1); prefetch — 1 в фоне; повтор и lexical — 0 |
| Compendium · filing | фон, когда ответ принят [D-23, D-86] | обмен + снимок Compendium | операции `file` | 1 (+1) |
| Compendium · historian | фон, при принятии ответа (после filing): 20 ходов игрока за водяным знаком или 24 срезанных непокрытых сообщения | самое старое непокрытое окно + дайджест сюжетов | пересказы, сюжеты, обзоры арок | 1 (+1); раз в ~10 ходов на большом окне, раз в 4–5 в lite |
| Поиск по истории и лору | тулы | запрос | сниппеты | 0 |

Типичный ход со всем включённым: на облаке — 3–4 вызова на переднем плане (Директор ∥ recall, рассказчик 1–2) и ≈ 1 в фоне; на локальном бэкенде — 2–3 на переднем плане (Директор lite, рассказчик 1–2) и ≈ 2 в фоне (prerecall, filing; historian — раз в 4–5 ходов). Потолок на ход — 12 вызовов: после него раунды не выдаются, и цикл переходит к финальному текстовому раунду.

### 7.1 Цикл рассказчика

Один цикл владеет **всеми** вызовами хода, включая первый, и каждый раунд стримится. В RoleCall первый вызов и движок были разделены, и это породило большинство его багов.

```ts
async function* narrate(c: NarrateCtx): AsyncGenerator<Event, NarrationResult> {
  let wire = c.messages;                                  // из assemble(); внутри хода не пересобирается
  const tools = c.kind === 'continue' || c.toolsOff ? [] : c.tools;  // toolsOff — правило префилла [D-28]
  const blocks: Block[] = [];
  for (let round = 0; ; round++) {
    const last = !tools.length || round >= c.maxRounds || c.calls >= c.callCeiling || c.noProgress;
    const req: ModelRequest = {
      messages: last && round > 0 ? [...wire, finalCue(c.caps)] : wire,
      tools: tools.length ? tools : undefined,           // на последнем раунде схемы всё равно объявлены
      toolChoice: tools.length ? (last ? 'none' : 'auto') : undefined,
      prefill: tools.length ? undefined : c.prefill,      // префилл только в ходе без тулов
      ...c.sampling, signal: c.signal,
    };
    const r = yield* streamCall(req, c);                 // события text/reasoning + строки chk{text}
    const calls = r.blocks.filter(isToolCall);
    if (!calls.length) return { blocks: [...blocks, ...r.blocks], finish: r.finish };
    if (last) {                                           // модель проигнорировала 'none' (Ollama)
      yield notice('tool_calls_on_final_round');         // вызовы уходят в трассу, не исполняются
      return { blocks: [...blocks, ...withoutCalls(r.blocks)], finish: 'max_rounds' };
    }
    const results = yield* runTools(calls, c);           // чтения параллельно, результаты в порядке вызовов
    blocks.push(...r.blocks, ...results);
    wire = [...wire, assistantMsg(r, r.replay), toolResults(results)];  // только дописываем; replay — в памяти
  }
}
```

**Правило «префилл или тулы» [D-28].** Префилл и раунды тулов в одном ходе не сочетаются: иначе получается пара assistant(prefill) + assistant(tool_calls), которую строгие шаблоны отвергают. Если модель ответит прозой сразу, префилл просто не дошёл бы. Поэтому выбор делается до сборки, один раз на ход:

| Условие | Что происходит | Сигнал |
|---|---|---|
| в пресете есть префилл, `caps.prefill ≠ 'none'`, `narrator.prefillVsTools = 'prefill'` (по умолчанию) | тулы рассказчика в этом ходу выключены, префилл отправляется | `notice{code:'prefill_disables_tools'}` раз за сессию; в строке статуса REPL `tools: off (prefill)`; `trace.prefill = 'tools_off'` |
| то же, но `prefillVsTools = 'tools'` | префилл не отправляется, тулы работают | `notice{code:'prefill_skipped_for_tools'}` раз за сессию; `trace.prefill = 'skipped_for_tools'` |
| префилл есть, но `caps.prefill = 'none'` | префилл не отправляется | `notice{code:'prefill_unsupported'}` раз за сессию; `trace.prefill = 'unsupported'` |

**Правила цикла.**

- **Текст между раундами накапливается [D-16].** Сохраняется всё, что стримилось, поэтому текст в конце хода не «прыгает». Протокол тулов просит модель сначала искать, потом писать.
- **Финальный раунд.**
  - Запрос содержит `tool_choice:'none'`, а схемы тулов остаются объявленными: Gemini отвергает tool-сообщения без схем.
  - Если `caps.toolChoiceHonored = false` (Ollama), `finalCue` добавляет явную просьбу продолжить сцену без тулов.
  - RP-ход всегда заканчивается прозой.
- **Ошибка — это событие, а не пустой ответ.** Раунд без вызовов и без текста — `failed{empty_response}`. Ответ из одних рассуждений обрабатывается по [D-31] (§6.6).
- **Защита от зацикливания.** Если тройка (имя, аргументы, хеш результата) повторяется 3 раза среди последних 8 вызовов, цикл переходит к финальному раунду.

### 7.2 `structuredCall` — общий транспорт для JSON-агентов

Директор и агенты Compendium (recall, filing, historian) получают JSON через один помощник. Правило выбора транспорта записано здесь один раз и одинаково для всех.

```ts
function structuredCall<T>(s: {
  agent: 'director' | 'recall' | 'filing' | 'historian'; schema: JSONSchema; read: (raw: unknown) => ReadResult<T>;
  system: string; user: string; tag: 'plan' | null;      // null — голый JSON-объект, как просят промпты Bunraku (§7.4)
  binding: Binding; caps: ModelCaps; maxTokens: number; signal: AbortSignal;
}): Promise<{ ok: true; value: T; transport: 'structured' | 'tagged'; skipped: { path: string; why: string }[]; attempts: Attempt[] }
          | { ok: false; code: 'transport_unsupported' | 'provider_error' | 'no_output' | 'undecodable' | 'invalid' | 'timeout' | 'aborted';
              attempts: Attempt[] }>;   // no_output — ни тега, ни JSON; undecodable — найден, но не разбирается [D-60]
type Attempt = { transport: string; outcome: string; ms: number; status?: number; finish?: string; tokens?: number };
```

1. **Транспорт выбирается до вызова,** записывается в трассу и до конца хода не меняется.
   - **`structured`** — если `caps.structuredOutput.mode = 'json_schema'` **и** поддержка подтверждена. Для облачных API её подтверждает пресет хоста (Anthropic `output_config.format`, Gemini `responseSchema`). Для локальных серверов (OpenAI-совместимый `response_format`) — проба или пользователь. Утверждение «llama.cpp/Ollama всегда превращают схему в грамматику» не принимается на веру.
   - **`tagged`** — во всех остальных случаях. Описание схемы идёт в system, ответ — один JSON-объект: внутри `<plan>…</plan>` у Директора, без тега у агентов Compendium (так написаны промпты Bunraku). Объект без тега ищется в fence или как первый целый объект — порт `firstObject` из `BR:recall-parse.ts`.
   - **Принудительный выбор тула не используется никогда.** На claude-opus-5-5, claude-sonnet-5-5, claude-fable-5-1 и claude-mythos-5-1 он возвращает 400.
   - Третий транспорт, `tool` (`tool_choice:'auto'` + `strict` + корректирующий проход), зарезервирован. Он появится, если пробы найдут модели, где не работают ни `structured`, ни `tagged`.
2. **Чтение ответа:** найти тег или fence → `JSON.parse` → `jsonrepair` → `read()`. Ядро схемы проверяется строго, отдельные элементы — снисходительно: плохая операция пропускается и записывается в `skipped`.
3. **Корректирующий проход** — один, дописывается в конец: assistant с плохим ответом (обрезанным до 1 000 символов), затем user с текстом ошибки. Вторая неудача — `{ok:false}`.
4. **Ошибки провайдера** обрабатываются по общей политике повтора (§6.6). Сбой транспорта даёт `notice{code:'caps.suggest'}` с советом выполнить `rp-core probe` или поменять настройку.

### 7.3 Story Director (рев. 6, D-61)

Директор — планировщик, который работает до рассказчика. Каждый ход он читает своё состояние на сообщении игрока U, отчёт импульса, свежую историю и снимок мира. Ответ — один JSON: **директива** рассказчику плюс **обновления состояния**. Рассказчик видит только отрендеренную директиву.

Этот раздел — сверка контракта ядра с портом:
- форма плана и состояния — из Bunraku и RoleCall [D-61];
- строгость чтения директивы — [D-62];
- пороги импульса и сопоставление заголовков — [D-63];
- лимиты промпта, личности и `creativity` — [D-64];
- доставка и фильтр персоны — [D-65];
- сбой — [D-17].

Код портируется из `Bunraku/src/core/director` — это живой путь RoleCall в виде чистых функций. Промпты и личности берутся оттуда же и сверяются с RoleCall `dm/`, краевые случаи — по тестам RoleCall. Пофайловая карта — §19.6.

Транспорт — `structuredCall` (§7.2) с тегом `plan`. Принудительный `tool_choice` не используется никогда: принудительный `commit_planning_round` на свежих Claude даёт 400.

**Место в ходе.**

- Директор работает на шаге 3 §6.2, до сборки, с дочерним сигналом хода и своим таймаутом.
- На continue Директора нет (§6.4).
- На обычном свайпе повторно используется план заменяемого ответа [D-29]. На guided re-roll и после проваленного плана Директор планирует заново от состояния на U (§5.9).
- **Recall Compendium (§7.4.2)** от Директора не зависит: Директор не читает выбор recall, recall не читает директиву.
  - Sync-вызов recall — interactive. Он запускается вместе с Директором, как в RoleCall (`jobs/worker.ts:3812`, `Promise.allSettled`) и Bunraku (`studio/scene-turn.ts:175-183`), и сборка ждёт оба. Если оба на одном origin с одним местом (§8.8, [D-84]), семафор выполняет их по очереди, Директор первым.
  - Prefetch — фоновая задача полосы, которую ход ждёт не дольше `graceSec`. На локальном origin это режим по умолчанию, и recall не стоит на критическом пути (§7.4.7).
- Директор не валит ход. Задержать его он может не дольше своего таймаута плюс ожидание очереди.
- На одно-слотовом бэкенде без кэша промптов в памяти хоста вызов Директора вытесняет KV-кэш рассказчика, и промпт рассказчика обрабатывается заново (риски 6 и 18, §7.4.7). Поэтому lite-профиль урезает и промпт, и вывод.

**Состояние** — урезанное `DirectorState` Bunraku (`src/stage/contracts/director-types.ts`). Имена полей и значения перечислений сохраняются дословно: на них завязаны промпты, импульс и личности.

```ts
type Horizon = 'immediate' | 'short' | 'medium' | 'long' | 'epic';
interface DirectorState {
  turn: number;                 // последний ход Директора, включая проваленные; следующий — turn + 1. Хранится, а не выводится из окна
  nextId: number;               // один счётчик для arc-N, seed-N, hidden-N
  chapters: DirectorChapter[]; currentChapterId?: string;
  arcs: DirectorArc[]; seeds: DirectorSeed[]; invisibleArcs: DirectorInvisibleArc[];
  notes: DirectorNote[];        // пишет только человек (dirEdit, позже); в v1 список пуст
  pacing: { currentMood: string; turnsAtCurrentMood: number; rhythm: { lastActionSequence: number; lastQuietMoment: number } };
  nextIntentions: DirectorIntention[];                              // из analysis.intentions, ≤ 5
  lastDirective?: { turn: number; directive: NarratorDirective };  // авторская, до enrich и фильтра; читает только самопроверка
  lastPlantTurn?: number;       // новое: давление посадки не ломается, когда оплаченные семена вытеснены
}
interface DirectorChapter { id: string /* 'chapter-<number>' */; number: number; title: string; premise: string;
  status: 'active' | 'concluding' | 'complete'; themes: string[]; tone: string; majorGoal: string;
  closingMoment?: string; createdAtTurn: number }
interface DirectorArc { id: string /* 'arc-N' */; title: string; description: string; chapterId?: string;
  status: 'seeding' | 'building' | 'climax' | 'resolution' | 'complete' | 'abandoned';
  priority: 'background' | 'active' | 'urgent'; arcType: 'main' | 'side' | 'character' | 'world' | 'mystery';
  horizon: Horizon; lastProgressTurn?: number; stages: { title: string; turn: number }[];
  nextBeat?: { description: string; plannedAtTurn: number; targetTurn?: number;
               status: 'pending' | 'delivered' | 'abandoned'; deliveredAtTurn?: number };
  createdAtTurn: number; byUser?: true }
interface DirectorSeed { id: string /* 'seed-N' */; hint: string; payoff: string; scope: 'world' | 'player';
  plantedAtTurn: number; payoffHorizon: Horizon; payoffDelivered: boolean; payoffTurn?: number;
  relatedArcId?: string; reinforcements: { turn: number }[]; byUser?: true }
interface DirectorInvisibleArc { id: string /* 'hidden-N' */; title: string; description: string;
  arcType: 'faction' | 'npc_agenda' | 'world_event' | 'conspiracy' | 'background'; horizon: Horizon; scope: 'world' | 'player';
  status: 'seeding' | 'building' | 'approaching_player' | 'visible' | 'resolved';
  stages: { title: string; turn: number }[]; surfaceCondition?: string;
  playerClues: { turn: number; clue: string }[]; createdAtTurn: number; userAuthored?: true }
interface DirectorNote { id: string; content: string; createdAtTurn: number }
interface DirectorIntention { type: string; description: string; priority: 'must' | 'should' | 'could';
  targetTurn: 'next' | 'soon' | 'eventually' }
```

**Что из `DirectorState` Bunraku не хранится.**

| Поле Bunraku | Почему | Что вместо |
|---|---|---|
| `activity`, `activityClearedAt`, `edits`, `trackerUpdates`, архив | [D-61] | события и трасса; правки человека — `dirEdit`, позже |
| `removedAt` во всех коллекциях | снимок пишется на каждую версию ответа: удалённое просто не попадает в следующий снимок, а у предков остаётся | — |
| `turnsActive` у арок, семян и скрытых арок; `turnsElapsed` у глав | счётчики дрейфуют: в RoleCall семена упирались в 52 | возраст `turn − createdAtTurn` или `turn − plantedAtTurn`, не меньше 0 (`RC:dm-stream/seed-aging.ts`) |
| `estimatedTurns` у глав | всегда `{20, 50, 100}` (`apply.ts:117`) | константа `CHAPTER_TURNS` |
| `expectedSurfaceTurn` | редьюсер всегда ставит `createdAtTurn + {1, 3, 5, 10, 25}[horizon]` и игнорирует значение модели (`apply.ts:222, 242`) | выводится |
| `arc.scope` | ставится из `arcType` один раз и не меняется | выводится: `main` и `world` → `world`, остальное → `player` |
| `involvedCharacters`, `plannedBeats`, `relatedVisibleArcs`, `foreshadowingSeeds` | не пишутся или не показываются планировщику | — |
| описания этапов и подкреплений | ни один промпт их не читает: показываются заголовки этапов и число подкреплений | — |
| `recentAnalysis`, `suggestedActions` | пишутся, но не читаются ни одним промптом | `DirectorRecord.analysis` |
| `pacing.recentMoodHistory`, `lastEmotionalBeat`, `needsBreather`, `chapterPhase`, `recommendations` | не читаются, константа или выводятся | подсказки ритма считает импульс |
| `lastDirectiveTurn` | — | `lastDirective.turn` |

**План** — весь ответ модели: один JSON из шести секций `PlanningRound` Bunraku. Директива — `NarratorDirective` из RoleCall (`dm-stream/types.ts`).

```ts
interface PlanningRound { directive: NarratorDirective; arcUpdates: PlanningArcUpdate[]; seedUpdates: PlanningSeedUpdate[];
  invisibleArcUpdates: PlanningInvisibleArcUpdate[]; analysis: PlanningAnalysis; chapterUpdate: PlanningChapterUpdate }
interface NarratorDirective {                        // поля focus нет [D-62]
  mood?: string;                                      // может отсутствовать; 'neutral' не подставляется
  pacing: 'slow' | 'medium' | 'fast' | 'breakneck';  // нет или неверно — 'medium'
  include?: { characters?: string[]; themes?: string[]; sensoryDetails?: string[]; foreshadowing?: string[] };
  avoid?: { topics?: string[]; characters?: string[]; revelations?: string[] };
  dialogueGuidance?: { character: string; tone: string; hints?: string[] }[];
  sceneGuidance?: { setting?: string; atmosphere?: string; tension_level?: number };   // 0..10
  endingHook?: string;
  arcDirections?: { arcName: string; instruction: string; urgency: 'subtle' | 'moderate' | 'forceful' }[];
  callbacks?: { reference: string; instruction: string }[];
  characterBeats?: { character: string; beat: string; motivation?: string }[];
  narrativeGoal?: string;
}
interface PlanningArcUpdate { arcId: string; title?: string; description?: string; status?: DirectorArc['status'];
  horizon?: Horizon; priority?: DirectorArc['priority']; arcType?: DirectorArc['arcType'];
  newStageTitle?: string; newStageDescription?: string;          // описание читается, но не хранится
  markNextBeatDelivered?: boolean; nextBeat?: { description: string; targetTurn?: number } }
interface PlanningSeedUpdate { id?: string; title: string; action: 'plant' | 'reinforce' | 'resolve' | 'delete';
  scope?: 'world' | 'player'; relatedArcId?: string; description?: string; payoffHorizon?: Horizon;
  reinforcement?: string; outcome?: string }
interface PlanningInvisibleArcUpdate { title: string; action: 'add' | 'update' | 'surface' | 'resolve' | 'delete'; arcId?: string;
  description?: string; status?: DirectorInvisibleArc['status']; arcType?: DirectorInvisibleArc['arcType'];
  horizon?: Horizon; scope?: 'world' | 'player'; surfaceCondition?: string; newClue?: string;
  newStageTitle?: string; newStageDescription?: string }
interface PlanningAnalysis { whatHappened?: string; summary?: string; seedsPlanted?: string[]; seedsPaidOff?: string[];
  unexpected?: string[]; pacingAnalysis?: string; playerEnergy?: string;
  intentions?: Partial<DirectorIntention>[]; suggestedActions?: string[] }
interface PlanningChapterUpdate { action: 'none' | 'update' | 'start_new'; title: string; description?: string;
  status?: DirectorChapter['status']; themes?: string[]; objectives?: string[]; tone?: string; closingMoment?: string }
```

**Импульс (momentum) [D-63]** — детерминированный проход до вызова, порт `momentum.ts` Bunraku.
- Все числа — один объект данных `MOMENTUM`.
- Возрасты выводятся из `createdAtTurn`, `plantedAtTurn` и `lastProgressTurn`, а не из счётчиков.

| Сигнал | Условие |
|---|---|
| принудительное действие по арке | ходов без прогресса не меньше предела горизонта: immediate 2, short 9, medium 15, long 30, epic 75. Арки в `seeding` исключены, арка без `lastProgressTurn` получает ход отсрочки |
| арка застоялась | 15 ходов без прогресса |
| семя созрело | возраст ≥ 30 и ≥ 2 подкреплений; при возрасте > 60 — OVERDUE |
| давление посадки | 12 / 20 / 35 ходов с `lastPlantTurn` — moderate / high / critical; critical, если семян не было вовсе |
| скрытой арке пора всплыть | ход ≥ `createdAtTurn + {1, 3, 5, 10, 25}[horizon]` или возраст ≥ 2 / 6 / 12 / 25 / 60. Срочность high, если срок прошёл ≥ 10 ходов назад, medium — если ≥ 4 |
| пометки OVERDUE в user-промпте | возраст семени или скрытой арки ≥ `{1, 3, 5, 10, 25}[horizon]` |
| общий темп | ≥ 3 застоявшихся арки или ≥ 2 созревших семени |
| ритм | `needsQuietMoment`: последняя тихая сцена > 8 ходов назад; `needsTension`: последний экшен > 12 ходов назад; `readyForClimax`: ≥ 4 хода в mood «tense» |
| глава | `CHAPTER_TURNS` 20 / 50 / 100: с 0,7 × 50 — «закругляй», с 50 — «ищи `start_new`», с 100 — OVERDUE |
| подсказки по аркам | меньше 2 активных после 5-го хода; одна арка с > 5 этапами; нет character-арки после 8-го хода; нет side-арки после 10-го |

- *Уточнение D-63.* Срок всплытия выводится, поэтому вторая ветка (возраст ≥ 2/6/12/25/60) первой не срабатывает никогда. В `MOMENTUM` она остаётся ради паритета с `momentum.test.ts`.
- **Отчёт** идёт в user-промпт, списки — до 10 элементов.
- **Давления (`planningPressures`)** идут отдельным user-сообщением после него. При `alternation:'strict'` их склеивает `shape.ts` (D-48).
- **После вызова** шаг `enrichFromMomentum` добавляет:
  - forceful `arcDirection` для каждой арки с принудительным сигналом;
  - `callback` для каждого созревшего семени, которого директива ещё не называет (сравнение подстрокой).

  Затем работает фильтр персоны. Порядок — как в RoleCall (`jobs/worker.ts:3973-3983`).
- **Мёртвый код не переносится:** `tensionOf` и `tensionPeaks`. Поле `involvedCharacters`, на котором они стоят, никто не пишет.

**Промпт.**

- **System** стабилен на сессию и кэшируется. Это порт `prompts.ts` Bunraku (RoleCall `buildDMSystemPrompt`). В нём:
  - роль и правила, включая «THE TEST» о персонаже игрока;
  - блок личности `director.style`: одна из 10, по умолчанию `the-balanced` (Sage), неизвестный id тоже даёт Sage. К нему добавляется `SHARED_PERSONALITY_GUIDANCE` [D-64];
  - строка `## Creativity Level` по `director.creativity`: subtle | moderate | dramatic, по умолчанию moderate [D-64];
  - блок персоны: имя и описание; `{{user}}` заменяется именем персоны;
  - в tagged — описание схемы и раздел «How to answer». В structured схема уходит в запрос.

  Размер, замеренный на Bunraku @702d8120:
  - Sage без персоны — 19 531 символ, с персоной — ≈ 23,4 тыс.;
  - самая длинная личность (oracle) — 21 961 без персоны;
  - схема tagged (`PLANNING_TOOL.parameters`) — ещё 13 746.

  Полный tagged-промпт — ≈ 33–40 тыс. символов, ≈ 9–10 тыс. токенов.
- **User** собирается на каждый ход в порядке `user-prompt.ts` Bunraku:
  1. номер хода и сводка состояния: арки, намерения, mood;
  2. отчёт импульса;
  3. снимок мира `[COMPENDIUM CONTEXT]` — с M5a, см. ниже;
  4. самопроверка: `lastDirective` против последнего ответа рассказчика. От прозы берётся 2 400 символов, начало и конец [D-64];
  5. главы с подсказками по `CHAPTER_TURNS`;
  6. ход игрока и постоянные указания `director.instructions` (≤ 2 000 символов [D-64]);
  7. свежая история: новейшие 30 сообщений в пределах 25 % окна Директора, в lite — 10 % [D-64]. Старые рассуждения вырезаны, самое старое не поместившееся сообщение обрезается посередине (`history.ts`);
  8. арки по степени застоя — со следующим битом и последними 6 этапами; ритм; намерения; живые семена с пометкой OVERDUE; Shadow World — скрытые арки и заметки игрока.

  Лимиты показа (`PROMPT_LIMITS`): 25 арок, 40 семян, 25 скрытых арок, 30 заметок, 300 символов на текст. Всё, что не показано, считается строкой «(+N more…)».
- **Правка текста при порте.** 15 упоминаний `commit_planning_round.X` (11 в `user-prompt.ts`, 4 в `momentum.ts`) становятся именами полей `X`. Голое «in commit_planning_round» (`user-prompt.ts:133`) становится «in your plan». В `prompts.ts` упоминаний нет.
- **Параметры вызова.**
  - Температура — 0,7 (`settings.ts` Bunraku).
  - Рассуждения — минимальный уровень из допустимых записью возможностей. `disabled` не отправляется моделям, которые его отвергают.
  - `finish:'length'` без восстановимого JSON — `undecodable`.
  - `maxTokens`: в full — `min(16 384, окно − промпт)` (`PLANNER_MAX_TOKENS` Bunraku), в lite — 1 500. Если запись возможностей не подтверждает, что рассуждения выключаются, или адаптер не смог отправить выключение, к lite добавляется 1 024 на рассуждения (как у recall, §7.4.2).

**Снимок мира — из Compendium (с M5a).** Сам Директор Compendium не читает. Готовый текст ему отдаёт модуль памяти (§7.4.5):

```ts
worldSnapshot(view: PathView, budget: WorldBudget): string   // '' — снимка нет, раздел не отправляется
interface WorldBudget { chars: number; characters: number; relationships: number; tensions: number; locations: number }
const WORLD_FULL: WorldBudget = { chars: 4_000, characters: 15, relationships: 5, tensions: 5, locations: 5 };
const WORLD_LITE: WorldBudget = { chars: 1_500, characters: 6, relationships: 2, tensions: 3, locations: 2 };
```

- **Порт** — `Bunraku/src/core/director/compendium-snapshot.ts` (80 строк, тест — 71). Сам он портирован из RoleCall `dm-stream/compendium-bridge.ts`. Число персонажей, связей, напряжений и мест в `WORLD_FULL` — константы этого файла.
- **Вход:**
  - записи Compendium типов `character` и `location` на пути до U включительно (свёртка `mem`, §5.8);
  - библиотечные книги Compendium, открытые на чтение (§7.4).

  Списанные и выключенные записи не входят.
- **Ранжирование.**
  - Персонажи: в сцене → связан с персонажем сцены (`relationships[].with`) → `featured` → остальные. «В сцене» значит, что имя или алиас встречается в последних 6 сообщениях пути до U либо совпадает с именем карточки или персоны.
  - Места: упомянуто или там находится персонаж сцены (`current_state.location`) → `featured` → остальные.
  - Напряжения — связи выбранных персонажей со `status:'strained'` или `nature` `'rival'` или `'enemy'`.
- **Отличия от Bunraku.**
  - Упоминание ищется по основам `normalizeTerm` (§7.5). В Bunraku — точное совпадение слов через `normalizeName`, и «Миру» не находит «Мира».
  - При равном ранге в сессионной книге выше запись, изменённая позже (по `seq` строки `mem`), в библиотечной — по `order`. Порядок книги в сессии поднимал бы самые старые записи.
  - Тексты обрезаются: описание персонажа — до 200 символов, роль — 60, состояние — 120, заметка связи — 100, описание места — 160. Весь блок — не больше `budget.chars`. В обоих источниках обрезки нет, и 15 длинных описаний дают 10k+ символов. То, что не поместилось, считается строкой «(+N more not shown)».
- **Читаемые поля** — типизированные поля Chi; переименование их ломает:
  - `data.description`, `data.role`;
  - `data.current_state.{status, condition, location}` — `status:'alive'` не печатается;
  - `data.relationships[].{with, nature, status, notes}`;
  - имя, алиасы, `featured`, `order`.
- **Формат** — как в Bunraku: `[COMPENDIUM CONTEXT]`, `Characters:`, `Unresolved Tensions:`, `Key Locations:`. В user-промпте снимок стоит после отчёта импульса и до самопроверки (`user-prompt.ts`).
- **Цена — ноль вызовов.** Снимок детерминирован: тот же путь даёт тот же текст, поэтому `/preview --turn` и replay его воспроизводят.
- **Подробности** — какие книги читаются, имена и алиасы записей — в §7.4. Снимок заменяет прежний «снимок из Хроники: 10 записей по 400 символов через `lexScore`».

**Lite-профиль.** Включается так:
- `director.profile = 'lite'`;
- `auto` (по умолчанию) — *рев. 6:* если окно Директора < 24 576 (тот же порог, что у Compendium [D-79]) или если полный промпт — system, история 25 % окна и остальные разделы user — вместе с 4 096 токенами вывода не помещается в окно. Это считает `prompt/budget.ts`;
- `full` на окне < 16 384 всё равно даёт lite, с `notice{director_lite}`: полный tagged-промпт (≈ 9–10 тыс. токенов) там не помещается вместе с историей.

Окно 16 384 поэтому получает lite и у Директора, и у Compendium. Первые пользователи Директора по порядку сборки — слабые локальные модели.

| Параметр | Full | Lite |
|---|---|---|
| System | `prompts.ts` целиком, с блоком личности | новый сжатый текст правил (≈ 60 строк, ≈ 7 тыс. символов) и дайджест личности из её же полей: name, title, tagline, coreBeliefs, `preferences.pacingRhythm`, `directiveSafety.hintingStyle`. Дайджест — 0,8–1,2 тыс. символов (замерено), новых текстов не нужно |
| Схема | `PLAN_SCHEMA`, шесть секций | `PLAN_SCHEMA_LITE` (состав — ниже) |
| User-промпт | все разделы | без Shadow World и давления скрытых арок. Скрытые арки в состоянии не трогаются |
| История | 30 сообщений, 25 % окна | 10 % окна |
| Снимок мира | `WORLD_FULL`, ≤ 4 000 символов | `WORLD_LITE`, ≤ 1 500 символов |
| Вывод | `min(16 384, остаток окна)` | ≤ 1 500 токенов; + 1 024, если рассуждения не выключаются |
| Транспорт | §7.2 | `structured` предпочтителен, если проба его подтвердила: тогда схема уходит из system |

Состав `PLAN_SCHEMA_LITE`:
- `directive`: mood, pacing, narrativeGoal, sceneGuidance, endingHook; до 3 arcDirections, до 3 characterBeats, до 2 callbacks;
- `arcUpdates`: arcId, title, status, arcType, horizon, newStageTitle, nextBeat, markNextBeatDelivered. *Рев. 6:* без `arcType` и `horizon` новая арка всегда получала бы `side` и `medium` (`apply.ts:163, 166`), подсказка «Consider adding a character arc» (`user-prompt.ts:95`) висела бы невыполнимой в каждом ходе, а горизонты immediate и short были бы недостижимы;
- `seedUpdates`: id, title, action, description, payoffHorizon, outcome;
- `analysis`: whatHappened и до 3 intentions;
- `chapterUpdate`: action, title, description;
- `invisibleArcUpdates` нет.

По оценке исследования, на GPU задержку Директора определяет прежде всего декодирование ответа, а не обработка промпта. Поэтому lite урезает схему, а не только историю. Это проверяется замерами на M5c, вместе с recall.

**Чтение плана [D-62].** Порт `plan-round.ts` Bunraku, политика терпимости — из RoleCall.

- **Директива отклоняется, только если в ней нет ни одного содержательного поля.**
  - Содержательное поле — любое непустое из mood, narrativeGoal, arcDirections, characterBeats, callbacks, sceneGuidance, include, dialogueGuidance, endingHook и avoid, а также `pacing`, если модель явно прислала допустимое значение, отличное от `'medium'`. Отсутствующий или неверный `pacing` содержательным не считается.
  - *Рев. 6:* список D-62 расширен до правила RoleCall `hasDirectiveContent` (`DirectiveBuilder.ts:415-429`). Оно учитывает и dialogueGuidance, endingHook, avoid, и `pacing ≠ medium`. Без этого отклонялась бы директива, в которой есть только концовка или только темп, а корректирующий проход на одном слоте стоит ещё 15–20 с. Проверка VVS-130 в RoleCall (`schemas.ts:180-205`) — отдельное правило: она отвергает объект без единого известного ключа директивы.
  - Отказ — код `missing_directive` и корректирующий проход (§7.2).
- **`pacing`, `mood`, `focus`.**
  - Отсутствующий или неверный `pacing` становится `'medium'`.
  - `mood` может отсутствовать: `'neutral'` не подставляется. RoleCall его подставляет (`schemas.ts:37-39`).
  - Поля `focus` нет.
  - Нейтральная директива не выдумывается никогда.
- **Остальные секции читаются снисходительно:**
  - `null` значит, что поля нет: Gemini шлёт `null` в include, avoid и sceneGuidance;
  - секция, присланная строкой, чинится через `jsonrepair`; `analysis`, присланный строкой, становится `whatHappened`;
  - горизонт `long-term` становится `long`; `targetTurn` в виде строки приводится к числу; `action` семени переводится в нижний регистр;
  - недопустимый `urgency` становится `'moderate'`; `tension_level` зажимается в 0..10;
  - на секцию — до 40 записей, в каждом списке директивы — до 12 элементов (в lite — до 3), намерений — до 10;
  - текст обрезается до 300 символов на поле, заголовок арки — до 80 (`cleanTitle`);
  - у `invisibleArcUpdates` обязательны только `title` и `action`. В схеме Bunraku обязательных полей 11.
- **Всё отброшенное пишется в `skipped`** — `{path, why}` [D-60], до 20 записей, остальное числом. Сюда попадают:
  - семя без `action`. *Рев. 6:* Bunraku подставляет `'reinforce'`, и новое семя молча не сажается;
  - элементы без обязательных полей;
  - ключи вне схемы. Четыре личности (jester, romantic, shadow, thrill-seeker) показывают в примерах ключи вроде `include.sensory`, `avoid.spoilers`, `horrorNote`. Карту алиасов для них решаем с Chi, а пока их видно в `skipped`.

**Редьюсер.** `applyPlan(state, round, {turn}) → {state, skipped}` — чистая функция, порт `apply.ts` Bunraku, без `now`.

- **Id** выдаются из `nextId`: `arc-N`, `seed-N`, `hidden-N`. Глава получает `chapter-<number>`.
- **Главы.**
  - Первая глава создаётся всегда, что бы ни прислала модель.
  - `start_new` отклоняется, пока текущей главе меньше 3 ходов [D-63]; промпт подсказывает не делать этого до 10-го хода. Отказ пишется в `skipped`.
- **Арки** сопоставляются по шагам [D-63], поверх `normalizeTerm` (§7.5) со стоп-словами:
  1. точный id;
  2. нормализованный заголовок;
  3. ≥ 2 общих значимых токена, покрывающих не меньше половины более короткого заголовка.

  Bunraku сравнивает через `[^a-z0-9]` (`apply.ts:24, 26`) и стирает этим кириллицу, поэтому русские арки дублировались бы. Новая арка получает `cleanTitle`: одно предложение, ≤ 80 символов. Новая арка сверх лимита живых отклоняется в `skipped`; Bunraku пропускает её молча.
- **Семена** сопоставляются по id или по нормализованному `hint`. Неизвестный id уходит в `skipped`. `plant` ставит `lastPlantTurn = turn`.
- **Скрытые арки** сопоставляются по id или по нормализованному заголовку. Улики дедуплицируются без учёта регистра.
- **Прогресс.** `lastProgressTurn` двигают только новый этап, смена статуса и доставленный бит. Переписанное описание прогрессом не считается.
- **Этапы.** Этап, повторяющий заголовок предыдущего, не добавляется. `stage.turn = turn`: Bunraku пишет туда счётчик `turnsActive` (`apply.ts:141`), а у новой арки — 0 (`:167`). Это исправляется.
- **Ритм.**
  - Нет mood или mood тот же — `turnsAtCurrentMood + 1`.
  - *Рев. 6:* mood сравнивается по словам после `normalizeTerm`: «tense, watchful» содержит «tense». В источниках сравнение — точное равенство с action, climax, calm и т. д. При свободном mood подсказки ритма там почти не срабатывают.
- **`nextIntentions`** берутся из `analysis.intentions` (≤ 5). **`lastDirective`** — `{turn, авторская директива}`.
- **Лимиты [D-61]:**

| Что | Ядро | Bunraku |
|---|---|---|
| живые арки | 24 | 300 строк (`DIRECTOR_CAPS`) |
| живые скрытые арки | 12; `userAuthored` не вытесняются | 300 строк, 150 живых |
| живые семена | 32 | 400 строк |
| заметки | 16 | 500 строк, 200 живых |
| завершённые элементы каждого вида | 10, старейшие уходят первыми | 20 |
| главы | текущая и 10 завершённых | 200 |
| этапы / подкрепления / улики | 6 / 4 / 6 | 12 / 12 / 12 |
| намерения | 5 | 10 |
| текст на поле | 300, заголовок арки — 80 | 1 200 при чтении |
| снимок | ≤ 16 КБ типично, потолок 32 КБ | 600 000 байт |

  Элементы с `byUser` и `userAuthored` не вытесняются никогда.
- **`fitState`** — последний шаг перед записью. Шаги идут по порядку, пока JSON состояния не уложится в 32 КБ:
  1. завершённых элементов каждого вида — 5, затем 0. `lastPlantTurn` остаётся, поэтому давление посадки не выдаёт ложное «семян не было вовсе»;
  2. этапов — 3, улик — 3, подкреплений — 2;
  3. описания — до 160 символов, этапов — 1, намерений — 3;
  4. завершённых глав — 2;
  5. рабочие наборы — по самому давнему `lastProgressTurn` или `plantedAtTurn`: 12 арок, 16 семян, 6 скрытых арок.

  Каждый сработавший шаг пишется в `skipped` (`{path:'state', why:'fit:<шаг>'}`). В v1 элементов человека нет (`dirEdit` — позже), поэтому шаг 5 всегда укладывает состояние в потолок.

  **Оценка размера** — на синтетическом состоянии в 300 ходов, на живой сессии не замерялась:
  - ≈ 32 КБ в форме Bunraku;
  - ≈ 19 КБ без текстов, которые не читает ни один промпт, и без `lastDirective`;
  - ≈ 16 КБ при ~6 арках, 10 семенах и 2 скрытых арках;
  - при полных лимитах D-61 — ≈ 61 КБ, поэтому `fitState` будет ужимать насыщенные сессии.

  Проверка — скриптовый прогон на 300 ходов на M4.

**Результат** — `DirectorRecord`. Он заменяет тип в §5.9:

```ts
interface DirectorRecord {
  turn: number; ok: boolean; code?: DirectorFailCode;
  transport?: 'structured' | 'tagged'; model?: string;
  directive?: NarratorDirective;              // итоговая, после enrich и фильтра персоны — как отправлена
  analysis?: PlanningAnalysis;                // для /director show и трассы
  skipped: { path: string; why: string }[];   // [D-60]
  attempts: { transport: string; outcome: string; ms: number; status?: number; finish?: string; tokens?: number }[];
  state: DirectorState;                       // после applyPlan и fitState; при сбое — прежнее с turn + 1
  reducer: number;                            // версия редьюсера: 1
  reusedFrom?: string;                        // [D-29]
}
type DirectorFailCode = 'no_connection' | 'transport_unsupported' | 'provider_error' | 'no_output'
                      | 'undecodable' | 'missing_directive' | 'timeout' | 'aborted';
```

- Запись пишется в `prep` с fsync и коммитится в строке ответа (§5.9).
- Операций в записи нет: новое состояние лежит целиком в `state`, авторская директива — в `state.lastDirective`.
- Коды Bunraku переводятся так [D-61]: `no_tool_support` → `transport_unsupported`, `inference_error` → `provider_error`, ни одного вызова → `no_output`.
- Событие `director{status:'planned', summary}`; `summary` — короткая строка вида «арки +1 ~2 · семена +1 · глава 2».

**Таймаут.**

- **По умолчанию** `director.timeoutSec` = таймаут первого байта соединения + 60 с: 660 с для localhost, 180 с для удалённых.
- **Отсчёт** начинается, когда запрос получил место в семафоре. Ожидание очереди в бюджет не входит.
- Корректирующий проход укладывается в тот же бюджет.

**Доставка [D-65].**

- **Контракт.** Пока Директор включён, в блоке ядра в конце ведущего system-прогона стоит `NARRATOR_AUTHORITY`.
  - Это порт текста RoleCall `buildNarratorSystemAddition` (`DirectiveBuilder.ts:582`, 37 строк; в Bunraku — `core/assembly/director.ts:60`).
  - К нему добавляется одна строка ядра: «никогда не действуй, не говори и не решай за `{{user}}`».
  - Заголовок в контракте и в директиве — одна константа `DIRECTOR_HEADER`. В RoleCall в заголовке длинное тире, в Bunraku — дефис; разъехаться они не должны.
  - Контракт стоит **и в ходах без директивы.** Bunraku вставляет его только вместе с отрендеренной директивой (`director.ts:99-110`). Тогда на сбойных ходах меняется голова промпта и ломается кэш.
- **Директива** рендерится портом `renderDirective` из `core/assembly/director.ts`.
  - Обёртка — `[DIRECTOR CONSTRAINTS - BINDING THIS TURN]` … `[/DIRECTOR CONSTRAINTS]`.
  - Порядок разделов — как в Bunraku: Mood и Pacing (при `medium` Pacing опускается), Scene Guidance (`Tension: <слово> (n/10)`), Include, Avoid, Narrative Goal, Story Arc Directions, Callbacks, Character Beats, Dialogue guidance, `[Ending: …]`.
  - Директива ставится на **глубине 1** по конвенции ST, прямо над сообщением игрока. Роль — system, источник — `director`. Ставится после бюджета и не обрезается.
  - При равной глубине `director` идёт последним (§10.1), поэтому директива стоит и ниже блока Compendium на той же глубине (§7.4.1).
  - У Anthropic глубина 1 стоит после assistant-хода, поэтому адаптер сливает директиву в user-ход (§8.5). Пресет может перенести её на глубину 0.
- **Фильтр персоны** — `sanitizeForPlayerCharacter(directive, names)`. `names` — имя и алиасы персоны; границы слов — Unicode, `(?<![\p{L}\p{N}_])`. Фильтр:
  - убирает characterBeats и dialogueGuidance персоны;
  - удаляет персону из `include.characters`;
  - выбрасывает arcDirections, callbacks и биты, которые утверждают что-то о её внутреннем состоянии. Список глаголов — английский; русский список и фикстуры `ru` — на M4.

  `endingHook` и `narrativeGoal` не фильтруются ни в одном источнике: их проверяет сам планировщик по «THE TEST» system-промпта. Всё убранное попадает в `skipped` с `why:'persona'`.
- **Пустая директива** ничего не рендерит, контракт остаётся на месте.

**Сбой [D-17].**

- Директивы в этом ходу нет.
- Прошлая директива не отправляется ни как есть, ни с пометкой — это была ошибка VVS-195 в RoleCall. Нейтральная директива тоже не выдумывается.
- `DirectorRecord{ok:false, code}` содержит прежнее состояние с `turn + 1`, так что счётчик ходов идёт.
- Отправляется событие `director{status:'failed', reason}`. В REPL — `director: failed (<code>)`.
- Коды — `DirectorFailCode` выше.
- Текст ошибок провайдера сводится к категории и HTTP-статусу: в нём может оказаться эхо промпта.
- Ответ рассказчика приходит всё равно.

**Источники порта.** Пофайлово — §19.6.

- **Bunraku `src/core/director`:**
  - `state`, `bounds`, `momentum`;
  - `plan-schema` и `plan-round`, `apply`;
  - `prompts`, `user-prompt`, `self-audit`, `history`;
  - `directive` (enrich и фильтр);
  - `personalities/` — 10 личностей, `index` и `types`, 3 906 строк.

  Кроме того — `core/assembly/director.ts` (рендер и контракт) и скелет `planTurn` из `studio/scene-director-call.ts`. Тестов ≈ 760 строк.
- **RoleCall `apps/rc/src/lib/ai`:**
  - `dm/personalities/` (4 123 строки) — для сверки текстов;
  - `dm-stream/seed-aging.ts` — формула возраста;
  - `find-arc-match.ts` и `arc-title-sanitizer.ts`;
  - `DirectiveBuilder.ts` — алиасы в фильтре, `hasDirectiveContent`, текст контракта;
  - поиск спанов тега — из `prompted-tool-calls`.
- **Краевые случаи — тесты RoleCall:**
  - `arcUpdates-string-tolerance` (134);
  - `cremecafe-glm-thinking-undefined-content` (169);
  - `dm-schema-tolerance-prod-models` (173);
  - `vvs-264-arc-dedup` (197);
  - `vvs-267-arc-title-sanitizer` (301);
  - `seed-aging` (209);
  - `personalities.test.ts` (92);
  - `attribute-open-tag` (164) и `fenced-tool-calls` (124) — переделанные под `<plan>`.
- **Снимок мира** — `core/director/compendium-snapshot.ts` (80 строк) с тестом (71). В ядре он живёт в модуле памяти (`agents/compendium/world.ts`, §7.4.5).
- **Не переносится:**
  - принудительный `tool_choice`;
  - повтор прошлой директивы через `_isFallback`;
  - двойная вставка контракта;
  - счётчики `turnsActive`;
  - ASCII-границы слов;
  - планирование на continue;
  - activity, edits и trackers (`tracker-round.ts`).

**Позже.**

- Правки человека: `dirEdit`, `/director edit` (образец — `edits.ts` Bunraku) и `preview --with-director`.
- Карта алиасов для ключей вне схемы в примерах личностей — вместе с Chi.
- После замеров M5c — две возможности; решение о них принимается в §7.4.2:
  - необязательное поле `recall` в ответе Директора, то есть recall в том же вызове. Плохое поле откатывает только recall, Директор из-за него не падает;
  - выбор recall как часть снимка мира.

### 7.4 Compendium: recall, filing, historian и фоновая полоса (рев. 6)

*Рев. 6 — проход по Compendium [D-26].* Compendium портируется целиком из Bunraku: `src/core/compendium` и studio-обвязка — это переработка Chi вкладки tv-stream RoleCall. Хранение — строки `mem` на пути (§5.8). Здесь описаны агенты, активация, расписание и профиль для малых окон.

Из двух черновиков проекта основой взят «local-first»: на локальном бэкенде Compendium не добавляет вызовов до первого токена. Из «fidelity-first» взяты:
- дословные промпты Bunraku в профиле full;
- обзоры арок в слоте пересказов;
- повторная запись и отмена прохода;
- кодек `compendium-v1.0.0`;
- снимок мира, не зависящий от recall.

**Что получает игрок** — весь Compendium:
- 11 типов записей и производное дерево книг;
- нужные записи попадают в промпт сами — по упоминанию и по выбору модели (recall);
- после принятого ответа filing дописывает персонажей, места, события и память персонажей;
- historian пишет пересказы, сюжеты и обзоры арок;
- Директор видит снимок мира;
- ручное управление, экспорт в библиотеку, импорт книг RoleCall и Bunraku.

**Агенты.**

| Агент | Когда | Вход | Выход | Вызовы |
|---|---|---|---|---|
| селектор | каждый ход, до сборки | свёртка, U, последние 4 сообщения, выбор recall | блок `[Retrieved World Knowledge]` | 0 |
| recall | перед `reply`; на свайпе и continue — повтор выбора | индекс кандидатов, свежая беседа | `entry_ids` | sync — 1 (+1) до первого токена; prefetch — 1 в фоне; повтор и lexical — 0 |
| filing | фон, когда ответ принят | один или N обменов и снимок Compendium | `filings[]` → операции `file` | 1 (+1 ремонт) |
| historian | фон, при принятии ответа, по триггеру | самое старое непокрытое окно и дайджест сюжетов | пересказы, сюжеты, обзоры арок | 1 (+1): раз в ~10 ходов на большом окне, раз в 4–5 ходов в lite (§7.4.4) |
| снимок мира, дерево | по запросу | свёртка | текст | 0 |

**Вызовы на ход** (типично, всё включено).
- **Облако**, профиль full, recall `sync`:
  - до первого токена — Директор и recall вместе (по 1, ремонт — ещё не больше 1), затем рассказчик;
  - в фоне — filing 1, historian ≈ 0,1;
  - на свайпе и continue recall не вызывается.
- **Локальный бэкенд, окно 16k**, профиль lite, recall `prefetch`:
  - до первого токена — только Директор lite (если включён) и рассказчик;
  - в фоне, пока игрок пишет, — prerecall 1, filing 1, historian ≈ 0,2–0,25.

#### 7.4.1 Активация: селектор и блок

Типизированные записи — сессии и библиотечных книг с доступом `read` — попадают в промпт только через Compendium. Движок лора их не видит [D-76]. Нетипизированные записи книг остаются движку лора с семантикой ST; recall тоже может их выбрать.

**Селектор** (`agents/compendium/select.ts`) работает каждый ход, без вызова модели [D-77]. Кандидаты ранжируются по ярусам:

| Ярус | Что | Как сопоставляется |
|---|---|---|
| 0 | упомянуты в U (на guided re-roll — ещё и в тексте указания) | все значимые слова имени или одного из алиасов совпали по основам `normalizeTerm` (§7.5) |
| 1 | выбраны recall | `RecallRecord.picks` этого хода |
| 2 | упомянуты в последних 4 сообщениях перед U | как ярус 0 |

Внутри яруса порядок — `lexScore` (§9.2), затем новейший `prov.lastSeq`. Имена короче двух букв не сопоставляются.

**Свежесть [D-80].** Рассказчик не должен получать пересказ того, что и так видит в истории. Правила RoleCall (`compendium-freshness.ts`) выведены из происхождения в свёртке:

| Запись | Скрыта, пока видно… |
|---|---|
| пересказ | его последнее сообщение (`range.to`) |
| сюжет, событие | сообщение `prov.created`, из которого их создали. RoleCall смотрит на номер хода записи; Bunraku этого поля не пишет, и правило у него не работало |
| элемент массива верхнего уровня у любой записи (память, связь, `recent_developments`, `consequences`…) | сообщение, которое этот элемент добавило; запись рендерится без него. Это обобщение фильтра памятей RoleCall (`:86-101`) |
| остальное, а также заметки, обзоры арок, библиотека и правки человека | целиком не скрывается |

- Это заменяет прежнее правило «не активировать, пока видны **все** источники» — оно было слабее, чем у RoleCall.
- **Окно видимости** — граница обрезки (`trace.trimmed`) ближайшего предка-ответа. Она стабильна кусками по 8. Если обрезки не было, видно всё.
- Одна граница для индекса и для размещения убирает круговую зависимость между размером блока и обрезкой истории.

**Блок** — один системный блок на **глубине 1**, источник `compendium`:

```
[Retrieved World Knowledge]
[Lore: Мира Ванс]
<рендер записи>
```

- **Порядок.** При равной глубине `compendium` стоит после `lore` и перед заметкой карточки, авторской заметкой и директивой (§10.1). Директива остаётся ближе всех к U.
- **Причины выбора** в блок не попадают, только в трассу. RoleCall вставлял их (`jobs/worker.ts:4112`), Bunraku убрал.
- **Повторы.** Пропускаются записи, которые уже стоят в промпте: сработавшие в движке лора и стоящие в слоте `{{recap}}`.
- **Бюджет** — доля лора, 25 % окна (§11). Движок лора идёт первым, по правилам ST. Если у селектора есть кандидаты, лор берёт не больше 60 % доли: пол Compendium — 40 % (`compendium.minShare`).
- **Лимиты.**
  - full — до 12 записей; полный рендер до 4 000 символов, длиннее — краткий;
  - lite — до 6 записей; краткий рендер до 700 символов; весь блок — до 1 600 токенов.
- **Не поместилось** — запись срезается по порядку ярусов и попадает в трассу (`trace.compendium.cut`).
- Блок — вставка агента: финальный проход по бюджету его не обрезает (§11).

**Отличие от Bunraku.** Там типизированная запись срабатывает по ключу в движке лора, а recall добавляет свой блок. Здесь ярусы 0 и 2 повторяют срабатывание по ключу (по основам), и всё приходит одним блоком — с одним бюджетом и одним правилом рендера. На окне 16k от этого зависит, поместится ли персонаж: полный рендер насыщенного персонажа занимает тысячи символов. Книга с `compendium.books.<имя> = 'off'` работает как обычный лорбук.

#### 7.4.2 Recall

Recall — вызов модели, который выбирает записи для следующего ответа: присутствующих персонажей, ожидаемое и обогащающее (категории промпта Bunraku). Он не валит ход и ограничен по времени [D-78].

**Когда работает.**

| Ход | Recall |
|---|---|
| `reply` | по режиму (ниже) |
| `swipe` | при `recall.onSwipe = 'reuse'` (по умолчанию) — `RecallRecord` заменяемого ответа, 0 вызовов, с `reusedFrom`. Обе версии отвечают на одно U, как у Директора [D-29]. На guided re-roll к повтору добавляется ярус 0 по тексту указания |
| `continue` | выбор цели, 0 вызовов; тексты записей берутся из текущей свёртки |
| приветствие, `preview` | только селектор, без вызова |
| `draft` (M9) | выбор головного ответа |

**Режимы** задаёт `compendium.recall.mode`:

| Режим | Что делает |
|---|---|
| `sync` | вызов внутри хода. Запускается вместе с Директором (`Promise.allSettled`, как `jobs/worker.ts:3812` RoleCall и `scene-turn.ts:175-183` Bunraku). Если оба на одном origin с одним местом, семафор выполняет их по очереди, Директор первым |
| `prefetch` | фоновая задача `prerecall:<A(n)>` после коммита ответа: выбор считается, пока игрок пишет. При U(n+1) берутся её picks и ярус 0 по U |
| `lexical` | без модели: только ярусы 0 и 2 |
| `off` | recall нет; селектор всё равно работает |
| `auto` (по умолчанию) | `prefetch`, если origin привязки `recall` локальный (§7.4.7); иначе `sync`. *Рев. 6:* решает локальность, а не число слотов: на одной GPU второй слот хранит KV рассказчика, а не даёт параллельности, и sync recall всё равно стоял бы на критическом пути |

Директор не читает выбор recall, recall не читает директиву (§7.3). Поэтому порядок между ними на результат не влияет.

**Prefetch.**
- **Ставится:**
  - после коммита ответа (`reply`, `swipe`, `continue`);
  - после переноса головы на ответ ассистента (выбор свайпа, откат);
  - при открытии сессии, если голова — ответ ассистента.

  Новая задача заменяет прежнюю (`superseded`). На локальном origin она стартует не раньше `compendium.idleDelaySec` (8 с) после последнего из этих событий (§7.4.7): свайп, continue и листание свайпов сразу после ответа не платят за вытесненный KV рассказчика.
- **Вход** — свёртка и беседа до A(n). В промпт добавляется строка «The player has not answered yet; pick what the narrator will most likely need for the next reply.»
- **Годен** при U(n+1), если выполнено всё:
  - `U.parent` — тот же A(n);
  - после prefetch на пути не было `edit`, `hide` и `head`;
  - не менялись настройки recall и модель.

  Свёртка за это время может измениться (например, лёг filing A(n−1)), и это не промах. В выборе лежат ключи записей, а текст берётся из свёртки на момент сборки; новые записи ловит ярус 0.
- **В полёте**, когда пришло U(n+1): ход ждёт его не дольше `recall.graceSec` (4 с). На это время задача получает интерактивный приоритет и не вытесняется. Не успела — прерывается (`superseded`) и считается промахом.
- **Stop во время ожидания** прерывает ожидание, а не задачу: prefetch возвращается в фоновый приоритет и дорабатывает, и его выбор годен для следующего `reply` на тот же U.
- **Промах** → `recall.onMiss`: `lexical` (по умолчанию для локальных соединений) или `sync` (для удалённых). Игрок, ответивший быстрее `idleDelaySec`, тоже получает промах.
- **Хранится только в памяти.** Краш означает промах.

**Привязка.** Роль `recall` → `recorder` → `narrator` [D-85]. Это повторяет пару классификатора в RoleCall и `compendium.model ?? scene model` в Bunraku. На облаке recall стоит направить на дешёвую модель.

**Вызов.**
- **Транспорт.** `structuredCall({agent:'recall', tag:null})` (§7.2): ответ — один голый JSON-объект, как просит промпт Bunraku. В `structured` схема — `{entry_ids: string[]}`. Если кандидатов ≤ 200, у `items` есть `enum` хэндлов, и грамматика llama.cpp не даст выдумать хэндл.
- **Параметры.** Температура 0,3. Рассуждения — минимум из допустимых записью возможностей, с проверкой на проводе. maxTokens: full — 2 000 (`MAX_OUTPUT_TOKENS` Bunraku), lite — 200. Если запись возможностей не подтверждает, что рассуждения выключаются, или адаптер не смог отправить выключение, добавляется 1 024 на рассуждения: иначе каждый вызов кончался бы `finish:'length'`. `finish:'length'`, когда пришли одни рассуждения, — `undecodable` (инцидент RoleCall 2026-08-07, `pregen-retrieval.ts:43-61`).
- **Дедлайн** `recall.timeoutSec` считается от получения места в семафоре: 30 с для локальных, 20 с для удалённых. Ремонт укладывается в тот же дедлайн; у prefetch — 60 с. У Bunraku 90 с (`RECALL_TIMEOUT_MS`); вместе с таймаутом первого байта 600 с это держало бы ответ минутами.

**Индекс** — кандидаты с короткими хэндлами `e1…eN`, которые ничего не значат вне индекса (`recall-index.ts` Bunraku). Не входят: списанные и выключенные записи, скрытые свежестью, стоящие в слоте `{{recap}}`.

| | full | lite |
|---|---|---|
| форма | производное дерево до глубины 2, строки `[eN] Имя (aka …) - tagline` (Bunraku дословно; tagline выводится) | шорт-лист: 40 лучших по ярусам 0 и 2, затем по `lexScore` к последним 6 сообщениям; только корзины типов |
| бюджет | ≤ min(20 000, 25 % окна) токенов | ≤ min(2 000, 15 % окна) |
| переполнение | считается (`omitted`); `notice{recall_index_truncated}` раз за сессию | то же |

- Bunraku передаёт 20 000 безусловно, хотя комментарий обещает «половину окна, если меньше» (`compendium-recall.ts:30` и `:92`).
- **Замер** на фикстуре Bunraku (239 записей, 233 кандидата, `countText` Bunraku): индекс `names` — 2 535 токенов, `taglines` — 2 545, `preview` — 3 565. Между `names` и `taglines` почти нет разницы, потому что tagline есть только у трёх типов. Выведенный tagline это исправляет.

**Промпт.**
- **full** — `recallMessages` Bunraku дословно:
  - system `RECALL_SYSTEM` с категориями ACTIVE, ANTICIPATORY, ENRICHMENT и WILD CARD;
  - при `minEntries > 0` — `HARD REQUIREMENT`;
  - указания человека (≤ 8 000 символов, «не расширяют доступ»);
  - индекс, беседа, форма ответа `{"entry_ids":[…],"reasons":{…}}`.

  Неизменная часть — 265 токенов. Одно изменение: к пределу Bunraku в 20 сообщений (`contextMessages`, `compendium-recall.ts:90`) добавлен предел min(8 000 токенов, 20 % окна). Новые сообщения сохраняются, длинное режется на начало и конец. У Bunraku предела по токенам нет.
- **lite** — новый короткий system (≈ 90 токенов): выбрать записи ACTIVE (присутствуют, место, что в ходу) и ANTICIPATED (вот-вот понадобятся). WILD CARD нет: он намеренно тратит 1–2 выбора из 4. В user:
  - индекс;
  - последние 6 сообщений, ≤ 1 500 токенов; сообщение длиннее 1 200 символов — начало и конец;
  - форма `{"entry_ids":["e1"]}` с припиской «не больше 4, пустой список — нормально».

**Чтение** — `parseRecall` Bunraku: первый целый JSON-объект, в fence или без; неизвестные, повторные и сверх лимита хэндлы отбрасываются и считаются. Сверх этого принимаются:
- голый массив `["e1","e7"]`;
- точное нормализованное имя кандидата вместо хэндла (`byName`);
- хэндлы `eN`, выловленные из текста, если JSON нет вовсе (`salvaged`).

Причины режутся до 200 символов и идут только в трассу и `/memory recall` — **никогда** рассказчику.

**Второй вызов.**
- Не больше одного, и только в full: ремонт на `no_output` или `undecodable`, либо добор до `minEntries`. Третьего нет (Bunraku).
- Добор RoleCall с принудительным `tool_choice` (`pregen-retrieval.ts:627`) не переносится.
- В lite второго вызова нет: если ничего годного, выбор пуст, а запись — `ok`.

**Сбой.**
- Любой сбой даёт `RecallRecord{status:'failed', code}`, событие `agent{recall, status:'fallback', code}` и лексический выбор.
- Ход recall не валит. Прервать его может только Stop, и таймаут никогда не выдаётся за Stop.
- Вызовы sync считаются в потолок 12 вызовов на ход (§11).
- После двух таймаутов за сессию — `notice{recall_slow}` с советом: `mode = lexical`, кэш хоста или второй слот, отдельное соединение.

**Запись.**

```ts
interface RecallRecord {
  v: 1;
  status: 'recalled' | 'empty' | 'skipped' | 'failed';
  source: 'sync' | 'prefetch' | 'lexical' | 'reused';
  profile: 'full' | 'lite';
  picks: { ref: string; reason?: string }[];   // ключи записей в порядке выбора; reason — только full, ≤ 200 символов
  unknown: number; repeated: number; trimmed: number; omitted: number; byName: number; salvaged: number;
  calls: number; ms?: number; model?: string; transport?: 'structured' | 'tagged';
  code?: 'timeout' | 'provider_error' | 'no_output' | 'undecodable' | 'transport_unsupported'
       | 'aborted' | 'no_connection' | 'prefetch_missed';
  basis?: string;        // prefetch: A(n), после которого он посчитан
  reusedFrom?: string;   // свайп — заменённый ответ; continue — цель
}
```

- Запись идёт в `prep` (с fsync) и в коммит ответа (`CommitBody.recall`). Размер — до ≈ 2,5 КБ. Восстановленный после краша ответ берёт `recall` из `prep` (§6.7).
- Повтор на свайпе и continue переживает перезапуск. Это заменяет LRU-кэши в памяти процесса: 32 записи у Bunraku, 256 у RoleCall.
- Текст записей в ней не хранится. При сборке он всегда берётся из текущей свёртки, поэтому повтор видит поздние правки.
- `/preview --turn` пересобирает блок из `prep.recall` и `trace.compendium.rev`.

**Позже, после замеров M5c** (§7.3 ссылается на это решение):
- поле `recall: {entry_ids}` в ответе Директора — замена sync-вызова при промахе prefetch. Читается отдельно: плохое поле даёт лексический откат и никогда не валит Директора, D-17 не страдает;
- выбор recall как часть снимка мира.

Оба меняют порядок вызовов на одном слоте и вводятся, только если замеры покажут, что промахи prefetch часты и дороги.

#### 7.4.3 Filing

Filing дописывает Compendium после принятого ответа. Модель отвечает одним JSON со списком `filings`, код превращает его в операции `file`.

**Когда [D-86].**
- **`filing.wait`** (0–5, по умолчанию 1) обобщает `lag` из D-23.
  - При `wait ≥ 1` задача ставится, когда игрок отправил новое сообщение: принятым считается ответ, который стоит на пути `wait`-м по новизне.
  - При `wait = 0` — сразу после коммита; тогда каждый свайп стоит лишний вызов.
- **`filing.everyN`** (1–10, по умолчанию 1): одна задача на N принятых ответов, и она покрывает все N обменов. Bunraku в этом режиме пишет только последний ответ (`compendium-hooks.ts`), а промежуточные теряет.
- Ответ, свайпнутый до принятия, ничего не стоит: строка его сиблинга лежит вне пути.
- Continue отдельно не записывается: filing видит итоговый текст.
- **Покрытие** считается по `range` неустаревших строк filing на пути, включая отменённые `revert` (§5.8). Непокрытый принятый ответ — долг полосы; скрытые ответы долгом не считаются.

**Вход в профиле full** — `filingMessages` Bunraku дословно. System при всех 11 типах, пустом снимке и одной книге — 5 209 символов и 1 148 токенов, из них список полей — 620 (замер `countText` Bunraku). Три правки:
1. Список записываемых книг заменяется строкой «You write into this story's Compendium. Entries marked (library) can be added to; your additions apply to this story only.» Поле `book` в ответе читается и игнорируется.
2. К спискам полей добавляются вложенные формы `character.relationships`, `character.memories` и `character.current_state` из RoleCall. Пример памяти — `{"what_happened":"…","changed_belief":"…"}`: у Bunraku там поле `event`, которого нет в схеме RoleCall.
3. Снимок показывает и типизированные записи читаемых книг с пометкой `(library)`, чтобы filing дописывал их оверлеем, а не плодил дубли. Снимок Bunraku видит только записываемые книги.

**Снимок full** — `buildSnapshot` Bunraku:
- по строке на живую типизированную запись, `Имя (aka: …) - tagline [N chars - add to it, do not rewrite]`, сгруппировано по типам;
- решённые, проваленные и брошенные сюжеты не показываются;
- бюджет ≤ min(30 000, 30 % окна).

Фикстура Bunraku (233 записи) даёт 3 741 токен, ≈ 16 на запись. Значит, 30 000 — потолок, а не типичный размер: он наступает около 1 800 записей.

**Вход в профиле lite.**
- Те же абзацы правил дословно: UPSERT, NO-WRITE DEFAULT, DEDUP, WRITE ONLY WHAT MATTERS, RELATIONSHIPS, указания, язык — 527 токенов.
- Вместо списка всех полей — `LITE_FIELDS`: 69 полей верхнего уровня с вложенными формами и значениями enum. Это 431 токен против 620 у списка полей Bunraku (замер); system lite целиком — ≈ 960 токенов против 1 148. Плюс строка «остальные поля типа сохраняются, если ты их пришлёшь».
- Не больше 6 элементов.
- **Снимок lite:**
  - ростер — до 60 имён по `lexScore` к обмену и присутствующим, формат `Имя (aka …) [тип]`;
  - до 4 записей кратким JSON: поле имени, имеющиеся поля `LITE_FIELDS`, последние 3 памяти. Это урок RoleCall «прочитай перед тем, как переписать» (VVS-742).
- Весь запрос — ≤ 45 % окна агента.

**User в обоих профилях:**
- ответ рассказчика: full — до 8 000 символов, lite — до 6 000, начало и конец;
- сообщения игрока группы, каждое до 4 000 символов (`COVERED_CHARS` Bunraku).
- **Если обменов в группе несколько** (`everyN > 1`), ответы и сообщения игрока делят то, что осталось от бюджета запроса после постоянной части, от новых к старым. Каждый текст режется на начало и конец, на ответ — не меньше 1 000 символов. Группа, которая не помещается и так, делится на задачи по последнему ответу каждой части (ключ `file:<A>`, свой `range`).

`LITE_FIELDS` (звёздочка — обязательное поле):

| Тип | Поля |
|---|---|
| character | name*, aliases, description, role (enum), current_state {status, location, condition}, relationships [{with*, nature*, status, notes}], memories [{what_happened*, changed_belief или changed_behavior*, when, emotion}] |
| location | name*, aliases, description, type, parent_location, current_state {status}, connected_to |
| item | name*, aliases, description, current_owner, current_location, condition, abilities |
| power | name*, aliases, description, users, cost, limitations |
| organization | name*, aliases, description, leader, members, goals, allies, enemies |
| event | name*, description, when, where, participants, outcome, significance, consequences |
| plot | name*, description, status, goal, stakes, current_progress, next_steps, central_characters |
| threat | name*, description, severity, status, what_happens_if_unaddressed, who_can_stop_it |
| worldbuilding | topic*, category*, description*, key_facts, rules |
| creature | name*, aliases, description, habitat, disposition, abilities, weaknesses |

`summary` filing не пишет никогда: это работа historian.

**Вызов.**
- `structuredCall({agent:'filing', tag:null})`. В `structured` схема — только конверт `{filings: [{type: enum(11), entry: object}]}`: схема на каждый тип была бы огромным `anyOf`.
- Температура 0,3. maxTokens: full — 4 096 (как в Bunraku), lite — 1 500.
- Фоновый приоритет, вытесняемый (§8.8).
- `compendium.filing.timeoutSec` от гранта: 300 с локально, 120 с удалённо. У Bunraku нет ни таймаута, ни сигнала.
- Один ремонт, и только если ответ не читается целиком (`repairMessages` Bunraku: эхо ответа до 2 000 символов).

**Чтение [D-82]** — `parseFilingAnswer` и `checkItem` Bunraku. Каждый элемент проверяется отдельно и отклоняется по своей позиции:
- тип — один из 11 и разрешён в `allow`;
- `entry` — простой JSON глубиной ≤ 6 и не длиннее лимита;
- поле имени непустое.

Сверх этого чтение терпимо — это аналог D-62 для памяти:
- **конверты:** `filings`, `entries` или `items`, массив верхнего уровня, один элемент; формы `{type, entry}`, плоская `{type, name, …}` и `{"character": {…}}`;
- **синонимы типов (en и ru):**
  - npc, person, персонаж → character;
  - place, место, локация → location;
  - faction, group, организация, фракция → organization;
  - quest, storyline, сюжет, квест → plot;
  - lore, rule, мир, правило → worldbuilding;
  - monster, beast, существо → creature;
  - ability, spell, skill, способность, сила → power;
  - object, предмет → item;
  - danger, угроза → threat;
  - событие → event;
- **поля:**
  - camelCase становится snake_case;
  - строка там, где ждут список, становится `[строка]`;
  - список строк там, где ждут строку, склеивается через «; »;
  - число строкой становится числом;
  - enum приводится к нижнему регистру, пробелы и дефисы — к `_`; синонимы степени угрозы — по RoleCall;
- **`event` → `what_happened`** в памяти, чтобы читались и старые данные Bunraku;
- **на уровне поля:** неверный вид или значение enum выбрасывает **поле** в `skipped`, а элемент сохраняется. Bunraku отклоняет весь элемент из-за одного enum, и слабая модель так теряет большую часть записей;
- **отбрасываются:** память без `changed_belief` и без `changed_behavior` и связь без `with`. Правило памяти — адаптация RoleCall (`compendium-definitions.ts:2786-2805`): там в фазе postgen такая память отклоняет весь вызов, а ядро выбрасывает только её;
- **на уровне элемента** отклоняются: элемент без поля имени, элемент длиннее лимита («file a shorter addition»), тип вне `allow`, тип `summary`.

Неизвестные поля сохраняются.

**Постановка** — чистая функция против свёртки на последнем ответе группы:
1. `findMatch`.
2. Совпадение с записью без типа → `skipped: classic_conflict`. С импортированными книгами ST это частый сюрприз, поэтому о нём говорится, а не молчится.
3. Слияние в рабочую копию: два элемента об одной сущности сливаются.
4. Проверка обязательных полей после слияния.
5. Слияние, которое ничего не меняет, — не запись.

В строку идут проверенные **дельты**, а не слитый результат: сливает свёртка.

**Запись:**
1. `job{begin, attempt}`;
2. вызов;
3. одна строка `mem{key:'file:<A>', on:A, by:'filing', range, ops, skipped, gen}` — или `job{failed, code}`;
4. событие `memory` на каждую изменённую запись и `agent{filing, done, skipped:n}`.

#### 7.4.4 Historian и слот `{{recap}}`

Historian заменяет задачу `recap` [D-33, D-83]. Он пишет пересказы старой истории, сюжеты и обзоры арок.

**Когда.** Historian проверяется в полосе при каждом принятии ответа — после задачи filing, если она поставлена. Дальше последнего принятого ответа (а при filing — ответа, который тот записал) он не читает. Так historian работает и при выключенном filing. Срабатывает он по любому из двух условий:
- после водяного знака на пути прошло ≥ `historian.interval` (20; 0 — выключено) ходов игрока — правило Bunraku;
- ≥ `historian.recapAfter` (24) сообщений пути уже срезаны бюджетом и не покрыты пересказами — правило D-33. На малом окне обрезка начинается рано, и обычно первым срабатывает это условие.

**Водяной знак** — позиция на пути самого нового `range.to` среди неустаревших строк historian на пути, включая отменённые `revert` (§5.8).
- *Рев. 6:* списанный пересказ (`retire`) и отменённый проход водяной знак не сдвигают: заново пересказ пишет только `/memory refile`. Назад водяной знак сдвигает только устаревание (D-68.4).
- В Bunraku (`summaryWatermark`) и RoleCall (`summary-watermark.ts`) знак считается по живым пересказам, и списанный или отменённый пересказ пишется снова. Ядро так не делает: иначе `/memory undo` был бы отложенным `/memory refile`.

**Окно.**
- Берётся самый старый непокрытый отрезок.
- Окно начинается на `historian.overlap` сообщений раньше нового: 10 в full (как в Bunraku), 6 в lite (D-68.1). Перекрытие помечено «already summarized».
- Окно растёт до min(12 000, 35 % окна агента) токенов, перекрытие входит в этот предел (`WINDOW_TOKENS` и `historianWindow` Bunraku).
- Отставание догоняется по одному окну за запуск.
- Сообщения нумеруются позициями на пути `[n]` (D-58), а диапазоны записываются id сообщений (D-68).

**Как часто** — оценка при ≈ 750 токенах на обмен. В устойчивом режиме historian идёт, когда за водяным знаком набирается `interval` ходов, и покрывает одно окно. Поэтому частоту задаёт не `interval`, а размер окна:
- окно 16k: ≈ 5 700 токенов, из них ≈ 2 000–2 500 — перекрытие; запуск раз в 4–5 ходов;
- окно 128k: 12 000 токенов, перекрытие ≈ 4 000; запуск раз в ~10 ходов.

Между последним пересказом и окном истории остаётся щель до `recapAfter` сообщений. Её покрывают записи filing и поиск.

**Промпт** — `historianMessages` Bunraku дословно; system — 294 токена (замер `countText`).
- Дайджест сюжетов — `historianDigest`: статус и 3 последних пересказа на сюжет, с припиской «REUSE these names».
- В lite: не больше 6 сюжетов в дайджесте и 6 элементов в ответе, обзор арки ≤ 1 200 символов (столько показывает слот), maxTokens 1 500. Типичный ответ — 600–900 токенов: пересказ и переписанный обзор.

**Применение** — `parseHistorian` и `prepareItems` Bunraku:
- разрешены типы `summary` и `plot`; пересказ без `parent_plot` отклоняется;
- `range` и `messages_covered` проставляет код, а не модель;
- сюжет, которого нет, создаётся как `{name, status:'active'}`;
- обзор `arc` применяется только к сюжетам, которые назвали пересказы этого же запуска.

Строка — `mem{key:'hist:<newFromId>-<toId>', on: toId, by:'historian', range, ops:[file(plot)…, file(summary)…, arc…]}`. Ответ читается так же терпимо, как у filing.

**Слот `{{recap}}`** стоит в точке обрезки, его доля — 10 % окна (§11):
1. **Сначала обзоры `[Arc] <сюжет>`** для сюжетов, у которых есть пересказ, задевающий срезанную часть. Новейшие по активности идут первыми. Обзоры занимают не больше половины слота; в lite — до 2 обзоров по ≤ 1 200 символов.
2. **Затем пересказы**, задевающие срезанную часть, от старых к новым, в обёртке `[Summary: <title>]`. Правило «задета хоть часть» не оставляет щели между срезанными сообщениями и пересказами.

Свойства слота:
- **Стабильность кэша.** `trace.recap = {ids, arcs: {key, rev}[], boundary}`. Пока граница обрезки та же, рендерятся те же пересказы и те же ревизии обзоров. Поэтому обзор, переписанный historian, не ломает кэшированный префикс до следующего сдвига границы.
- **Выпавшие пересказы.** Пересказы, которые не поместились в слот, остаются кандидатами recall и находятся через `search_lore`. Так возвращается «предательство двухсотого сообщения назад».
- **Не лор.** Обзоры арок — не константные записи лора, как в Bunraku. Там каждый, до 6 000 символов, каждый ход съедал бы долю лора окна 16k.

Smart context Bunraku (`summary-cut.ts`: обрезать историю до покрытия пересказами; в Bunraku выключен по умолчанию) — позже.

#### 7.4.5 Снимок мира для Директора

`worldSnapshot(view, budget)` — функция модуля памяти, которую вызывает Директор (§7.3). Это порт `BR:core/director/compendium-snapshot.ts` (80 строк, тест — 71), а тот сам портирован из RoleCall `dm-stream/compendium-bridge.ts`.

```ts
// agents/compendium/world.ts
worldSnapshot(view: PathView, budget: WorldBudget): string   // '' — снимка нет
interface WorldBudget { chars: number; characters: number; relationships: number; tensions: number; locations: number }
const WORLD_FULL: WorldBudget = { chars: 4_000, characters: 15, relationships: 5, tensions: 5, locations: 5 };
const WORLD_LITE: WorldBudget = { chars: 1_500, characters: 6, relationships: 2, tensions: 3, locations: 2 };
```

- **Вход:**
  - `view.compendium` — свёртка на U — и типизированные записи читаемых книг с оверлеями;
  - только `character` и `location`, без списанных и выключенных;
  - имена карточки и персоны — `view.castNames`.

  Фильтр свежести не применяется: Директор и так видит свежую историю.
- **Ранжирование, формат, читаемые поля и обрезка полей** — как в §7.3. Отличия от Bunraku:
  - упоминание ищется по основам `normalizeTerm`, а не точными словами;
  - при равном ранге в сессии выше запись с бо́льшим `prov.lastSeq`, в книге — по `order`;
  - поля обрезаются, у блока есть потолок.
- **От recall не зависит.** Снимок детерминирован и стоит ноль вызовов, так что промпт Директора не зависит от удачи расписания.

#### 7.4.6 Профили full и lite

`compendium.profile` — `auto`, `full` или `lite` [D-79].
- `auto` выбирает lite, если окно привязки агента меньше 24 576 токенов. У Директора в `auto` тот же порог (§7.3), поэтому окно 16 384 получает lite и у Compendium, и у Директора.
- Профиль меняет то, что видит модель, и лимиты числа и размера элементов (§5.8, D-87). Правила чтения и свёртка от профиля не зависят.

| Параметр | full (Bunraku, бюджеты зажаты окном) | lite |
|---|---|---|
| recall: индекс | дерево глубины 2, ≤ min(20 000, 25 % окна) | шорт-лист из 40, ≤ min(2 000, 15 % окна) |
| recall: беседа | 20 сообщений, ≤ min(8 000, 20 % окна) | 6 сообщений, ≤ 1 500 |
| recall: ответ | ≤ 10 записей с причинами, maxTokens 2 000, ремонт или добор | ≤ 4 без причин, maxTokens 200 (+ 1 024, если рассуждения не выключаются), без второго вызова |
| recall: запрос целиком | — | ≤ min(6 000, 40 % окна) |
| блок | ≤ 12 записей, полный рендер ≤ 4 000 символов, иначе краткий | ≤ 6, краткий ≤ 700, весь блок ≤ 1 600 токенов |
| filing: поля | все 223 + вложенные формы (список полей — 620 токенов, system — 1 148) | `LITE_FIELDS`, 69 полей (431 токен, system ≈ 960) |
| filing: снимок | `buildSnapshot`, ≤ min(30 000, 30 % окна) | ростер из 60 имён + 4 записи |
| filing: элементов / символов / maxTokens | 12 / 6 000 / 4 096 | 6 / 3 000 / 1 500 |
| filing: запрос | бюджеты Bunraku | ≤ 45 % окна |
| historian: окно / перекрытие | ≤ min(12 000, 35 % окна) / 10 | та же формула (≈ 5 700 на 16k) / 6 |
| historian: элементов / обзор / maxTokens | 12 / 6 000 / 4 096 | 6 / 1 200 / 1 500 |
| слот: обзоры арок | ≤ половины слота | 2 по ≤ 1 200 символов |
| снимок мира | `WORLD_FULL` | `WORLD_LITE` |

**Проверка на окне 16 384 (lite).** Правила и списки полей — замер; ростер, записи и тексты — оценка.
- **recall** — запрос ≤ 6 000 токенов плюс 200 на ответ.
- **filing** — ≈ 6 900 токенов, в пределах 45 % окна (7 372), плюс 1 500 на ответ:
  - правила — 527;
  - поля — 431;
  - ростер — ≈ 700;
  - 4 записи — ≈ 1 200;
  - ответ рассказчика — ≤ 2 400;
  - сообщение игрока — ≤ 1 600.
- **historian** — окно ≈ 5 700, промпт ≈ 300, дайджест ≈ 200, ответ 1 500.
- **рассказчик** — резерв ответа 2 048, если `max_tokens` не задан [D-89, §11]; голова пресета, карточка, персона, контракт Директора и каталог тулов — ≈ 3 000 (оценка); директива ≤ 600; лор с блоком Compendium ≤ 4 096 (блок ≤ 1 600); слот пересказов ≤ 1 638. На историю остаётся ≥ 5 000 токенов, ≈ 6–7 обменов. Если на историю остаётся меньше 25 % окна — `notice{history_crowded}` раз за сессию с советом: меньше лора, меньше `max_tokens`, другой пресет.

#### 7.4.7 Фоновая полоса и задержка на локальных бэкендах

**Полоса сессии** — `engine/lane.ts`. Задачи выполняются по одной, с фоновым приоритетом.

```ts
type LaneJob =
  | { task: 'prerecall'; key: `prerecall:${string}`; basis: string }        // в журнал не пишется
  | { task: 'file';      key: `file:${string}`;      on: string; covers: string[] }
  | { task: 'hist';      key: `hist:${string}-${string}`; on: string;
      window: { fromId: string; newFromId: string; toId: string } };
// строка job: task 'file' | 'hist' (было 'record' | 'recap')
```

**Порядок:** `prerecall` → `file` (в порядке пути) → `hist`.
- prerecall идёт первым, чтобы к ответу игрока он был готов. Ждать сначала filing A(n−1) незачем: всё, что он создаст, описывает видимые сообщения и скрыто свежестью, а тексты записей берутся из свёртки при сборке.
- historian проверяется при каждом принятии ответа, после filing (§7.4.4).
- **Голодание.** Вытеснения считаются по ключу задачи. Задача, вытесненная 3 раза подряд, в следующую паузу идёт первой, раньше prerecall, и даёт `notice{memory_starved}` раз за сессию с советом: кэш хоста или второй слот, отдельное соединение для `recorder`, больший `filing.everyN`.

**Восстановление** — по §6.7, ключи `file:` и `hist:`:
- непокрытые принятые ответы и назревшие окна выводятся из пути, а не из курсора; отменённые `revert` проходы считаются покрытыми (§5.8);
- после `maxAttempts` (3) сбоев на ключ задача паркуется до `/memory retry`;
- вытеснение попыткой не считается;
- prerecall не восстанавливается: после краша это промах;
- если долг полосы растёт (больше 3 непокрытых ответов) — `notice{memory_backlog}` раз за сессию с советом: второй слот или отдельное соединение для `recorder`.

**Расписание [D-84].**
- **Семафор — на origin**, то есть на `scheme://host:port` после нормализации URL, а не на имя соединения. Два имени, указывающие на один llama-server, делят его места и больше не выбивают друг другу кэш втихую (`notice{slots_shared}`).
- **Ёмкость:**
  1. явный `max_in_flight` соединения;
  2. иначе 1 для локальных и 4 для удалённых.

  Если соединения одного origin задают разную ёмкость, берётся меньшая.
- **Проба слотов ёмкость не поднимает, а только советует.** У llama-server по умолчанию `-np` = auto (−1): это 4 слота с общим KV на один пул `-c` (README; `server.cpp`: при `n_parallel < 0` — 4 слота и `kv_unified`). Каждый слот показывает в `/slots` полный `n_ctx`, так что такой пул не отличить от раздельного `-np 4 --no-kv-unified`. При переполнении общего пула сервер отдаёт «Context size has been exceeded» всем идущим запросам, включая рассказчика (`server-context.cpp`). Если проба (`GET /slots` или `total_slots` в `/props`) видит ≥ 2 слотов, а `max_in_flight` не задан, — `notice{slots_detected}` раз за сессию с пресетом ниже.
- **Приоритеты:**
  - interactive — рассказчик, Директор, sync recall, prefetch, которого ждёт ход (в пределах `graceSec`), `draft`;
  - background — prerecall, filing, historian.
- **Локальный origin.** Фоновая задача стартует, только когда на origin нет интерактивных запросов — ни в работе, ни в очереди, — и не раньше чем через `compendium.idleDelaySec` (8 с) после конца хода или переноса головы. Новый ход, `head`, `edit`, `hide` и continue сбрасывают таймер. Интерактивный запрос вытесняет фоновую задачу, даже если место свободно. Причина: на одной GPU второй слот хранит KV рассказчика, а не даёт параллельности, а чужая обработка промпта в том же батче тормозит и Директора, и поток рассказчика.
- **Удалённый origin.** Как в §8.8: фон идёт рядом, пока есть место; вытеснение — только когда все места заняты.
- **Вытеснение** — по §8.8: прерванный запрос возвращается в очередь без попытки.

**Порядок хода.**

| Источник | До первого токена |
|---|---|
| облако (≥ 2 места) | Директор ∥ sync recall → сборка → рассказчик. Filing A(n−1) стартует при `send` и идёт рядом, как в Bunraku; recall читает свёртку, зафиксированную в начале хода |
| локальный origin (1 или 2 слота) | prefetch в полёте — ждать ≤ `graceSec` → Директор → sync recall (только при `onMiss = sync` или `mode = sync`) → сборка → рассказчик. Фон — после хода и задержки `idleDelaySec`, пока игрок пишет |

**Закрепление слотов (M5c).** При `max_in_flight = 2` на llama.cpp ядро шлёт `id_slot`: рассказчик — 0, агенты — 1.
- **Зачем.** Без закрепления сервер отдаёт задаче, чей промпт мало похож на слот (`-sps`, по умолчанию 0,10), наименее недавно использованный свободный слот (`get_available_slot`). Prerecall займёт свободный слот, а следующая за ним задача filing — слот рассказчика.
- **Проверка.** В исходниках llama.cpp `id_slot` читается общим обработчиком завершений и доходит через `/v1/chat/completions`, но README документирует его только для `/completion`. Поэтому проба M5c проверяет закрепление по `/slots`. Если сервер его не принимает, `-np 2` советуется только вместе с `--cache-ram`.

**Защита от ловушек бэкендов** — данные адаптеров и документация, без новых механизмов:
- **llama.cpp** — агенты никогда не шлют `cache_prompt:false`.
- **Ollama** — запрос агента к той же модели несёт те же опции раннера, что у рассказчика (`num_ctx` и прочие): любое расхождение перезагружает модель (`needsReload` в `sched.go`). Если в конфиге они расходятся — `notice{ollama_options_mismatch}`.
- **LM Studio** — если роли на одном origin привязаны к разным моделям, `notice{lmstudio_autoevict}`: Auto-Evict по умолчанию держит одну JIT-модель.

**Пресеты** — документация M5c:

| Бэкенд | Что советуем |
|---|---|
| llama.cpp | `-np 1` с `--cache-ram` (включён по умолчанию, 8 192 МиБ, PR #16391): кэш промптов в памяти хоста возвращает префикс рассказчика без полной обработки. Либо `-np 2 --no-kv-unified -c <2 × окно>` и `max_in_flight = 2`: ядро закрепляет слоты через `id_slot`. По умолчанию `-np` = auto, 4 слота с общим KV; простаивающий слот перед очисткой сохраняется в `--cache-ram` (`--cache-idle-slots`, включён по умолчанию) и восстанавливается оттуда. Явный `-np 1` даёт один слот |
| koboldcpp | `--smartcache 2`. Запросы здесь только встают в очередь, а ContextShift и FastForward не помогают при чередовании промптов |
| Ollama | `OLLAMA_NUM_PARALLEL=2`, один `num_ctx` для всех ролей, `keep_alive: -1` |
| LM Studio | загрузить модели вручную или выключить Auto-Evict; Max Concurrent Predictions ≥ 2 |

Поведение бэкендов взято из исследования (README llama.cpp, PR #16391, вики koboldcpp, FAQ и `sched.go` Ollama, документация LM Studio) и сверено с исходниками llama-server; проверяется замерами M5c. Второй контекст в памяти стоит ≈ 160 КиБ на токен при 40 слоях × 8 KV-голов × 128 измерений в f16, то есть +8k токенов ≈ 1,25 ГиБ; в q8_0 — вдвое меньше (расчёт).

**Время до первого токена — оценка.** Модель исследования:
- модель 12–14B Q4 на одной GPU;
- обработка промпта ≈ 1 500 ток/с, генерация ≈ 35 ток/с;
- промпт рассказчика ≈ 12k (окно 16k, резерв 2 048 [D-89]);
- новый хвост за ход ≈ 0,8k без Директора и Compendium, ≈ 2,5k с директивой и блоком на глубине 1: они меняются каждый ход, и кэш расходится выше прошлого U;
- Директор lite ≈ 6–8k на входе и 300–600 на выходе, recall lite ≈ 3k и 60.

Цифры замеряются на M5c.

| Схема | До первого токена |
|---|---|
| без Директора и Compendium, KV тёплый | ≈ 0,5 с |
| порядок Bunraku на одном слоте: Директор full → recall с причинами → повторная обработка промпта рассказчика | ≈ 45 с |
| Директор lite + sync recall lite, 1 слот, без кэша хоста | ≈ 25–34 с |
| Директор lite + prefetch, 1 слот, без кэша хоста (Ollama, koboldcpp без `--smartcache`, llama.cpp с `--cache-ram 0`) | ≈ 21–30 с (Директор ≈ 13–22 + повторная обработка ≈ 8) |
| Директор lite + prefetch, llama.cpp по умолчанию (`--cache-ram`) или `-np 2` с `id_slot` | ≈ 15–24 с |
| без Директора, prefetch, 1 слот, без кэша хоста | ≈ 8 с, если фон успел поработать |
| без Директора, prefetch, кэш хоста или `-np 2` с `id_slot` | ≈ 1,5–2 с (хвост с блоком) |
| свайп через 2 с после ответа, 1 слот, без кэша хоста | ≈ 0,5 с: фон ещё не начался (`idleDelaySec`); без задержки было бы ≈ 8 с |

- На GPU у Директора дольше всего идёт генерация, поэтому lite урезает его вывод.
- На CPU (≈ 300 ток/с обработки) дольше всего идёт повторная обработка промпта рассказчика — ≈ 40 с. Лекарство — кэш хоста или второй слот с `id_slot`. Расписание убирает с критического пути только recall.
- Фон за ход в lite: prerecall ≈ 4 с, filing ≈ 13–15 с, historian ≈ 25–30 с раз в 4–5 ходов (≈ 6 с на ход в среднем). Итого ≈ 25 с на ход после `idleDelaySec`. Если игрок отвечает быстрее, задачи вытесняются и ждут следующей паузы; prerecall тогда даёт промах и лексический выбор.

**Позже, если замеры покажут нужду:**
- прогрев — запрос с префиксом рассказчика и `max_tokens: 1` после фоновых задач, если нет ни второго слота, ни кэша хоста;
- вызовы агентов с общим префиксом рассказчика — приём «Classic» из Summarize SillyTavern.

#### 7.4.8 Ручное управление, экспорт и импорт

**Человек управляет записями** строками `mem` с `by:'user'` (§5.8):
- `/memory new <тип> [имя]` открывает `$EDITOR` с JSON-шаблоном полей `LITE_FIELDS` и пишет `file`;
- `/memory edit <C12 или имя>` открывает данные в `$EDITOR` и пишет `edit`;
- `/memory retire` и `/memory restore`;
- `/memory undo <msg>` пишет `revert` прохода filing или historian, привязанного к сообщению. Полоса этот проход заново не пишет (§5.8);
- `/memory refile <msg>` ставит задачу с тем же ключом заново;
- заметки — `/memory add` (M3).

**Подтверждения нет [D-3].** Записи агентов применяются сразу и живут в пределах пути; о каждой приходит событие `memory{…}`. Режим review — позже.

**Экспорт** — единственный путь в библиотеку [D-3]. `/memory export <имя> [--format core|compendium]` пишет **копию**:
- **`core`** — `library/lorebooks/<canonicalId>.json` в формате `core.lorebook/1`:
  - `content` — `renderContent`, ключи — имя и алиасы, `meta = {type, data, aliases, featured}`;
  - пересказы получают `data.turn_range = {from, to}` в позициях пути и `messages_covered`;
  - памяти получают `source_turn` из `prov.appended`;
  - обзоры становятся константными записями `[Arc] <сюжет>` с `meta.arc`;
  - оверлеи выгружаются целыми записями.
- **`compendium`** — `compendium-v1.0.0` (`format: "rolecall-compendium"`), писатель из `BR:formats/rolecall/compendium.ts`:
  - пишется потоком: заголовок, по чанку на запись, хвост;
  - `tree: null`, ограничений узлов нет;
  - файл читают RoleCall и Bunraku.

**Импорт.** `rp-core import x.compendium.json` и `/lore add x.compendium.json` распознают `compendium-v1.0.0` (по D-72 — после ST-пресета и перед ST world info) и пишут библиотечную книгу с `meta.type` и `meta.data`. Обзоры `[Arc]` (`metadata.source = 'tv_arc_overview'`) получают `meta.arc` и идут в слот, а не в движок лора.

**Переход Bunraku (M9, D-27).** Книги Compendium сцены выгружаются и импортируются библиотечными книгами, а дальше filing дописывает их оверлеями. Параллельной памяти у сцены нет (§19.11).

#### 7.4.9 Команды, события, настройки

**REPL:**
- `/memory` или `/memory list [тип] [--retired]` — записи по корзинам, например `C12 Мира Ванс (aka Фонарщица) — Хранит последний фонарь [2,1k]`;
- `/memory show <ref>` — рендер и происхождение; `/memory tree` — дерево;
- `/memory new|edit|retire|restore|undo|refile|retry|export` — см. выше; `/memory add` для заметок — с M3;
- `/memory recall [--turn id]` — `RecallRecord` с причинами; `/memory recall test <текст>` — выбор селектора без вызова модели;
- `/memory profile auto|full|lite`, `/memory mode auto|sync|prefetch|lexical|off`;
- `/model recall <conn:model>`;
- строка статуса — например, `recall: prefetch · 3 · compendium: +1 Мира`.

**Протокол (M6)** — команды `memory/*` заменяют прежние (§12.2):

```ts
| { method: 'memory/list'; params: { sessionId: string; at?: string; type?: string; includeRetired?: boolean } }
| { method: 'memory/get'; params: { sessionId: string; ref: string; at?: string } }       // → { entry, render, brief }
| { method: 'memory/tree'; params: { sessionId: string; at?: string; book?: string } }
| { method: 'memory/file'; params: { sessionId: string; type: EntryType; data: Record<string, unknown> } }
| { method: 'memory/add'; params: { sessionId: string; title: string; keys: string[]; content: string } }   // заметка (M3)
| { method: 'memory/edit'; params: { sessionId: string; ref: string; set?: Record<string, unknown>; unset?: string[];
      keys?: string[]; featured?: boolean } }
| { method: 'memory/retire' | 'memory/restore'; params: { sessionId: string; ref: string; reason?: string } }
| { method: 'memory/undo' | 'memory/refile'; params: { sessionId: string; messageId: string } }
| { method: 'memory/retry'; params: { sessionId: string; messageId?: string } }
| { method: 'memory/recall'; params: { sessionId: string; turnId?: string; test?: string } }   // → RecallRecord + trace.compendium
| { method: 'memory/export'; params: { sessionId: string; name: string; format: 'core' | 'compendium' } }
```

**События:**

```ts
| { type: 'agent'; agent: 'recall' | 'filing' | 'historian'; turnId?: string; job?: string;
    status: 'queued' | 'started' | 'preempted' | 'adopted' | 'recalled' | 'reused' | 'fallback'
          | 'skipped' | 'done' | 'failed' | 'parked';
    source?: 'sync' | 'prefetch' | 'lexical' | 'reused'; count?: number; skipped?: number; code?: string; reason?: string }
| { type: 'memory'; change: 'created' | 'merged' | 'arc' | 'note' | 'edited' | 'retired' | 'restored' | 'reverted';
    ref: string; kind: EntryType | 'note' | 'arc'; name: string; by: 'filing' | 'historian' | 'user' }
```

**Уведомления:** `recall_slow`, `recall_index_truncated`, `prefetch_missed` (раз за сессию), `memory_backlog`, `memory_starved`, `compendium_large_entry`, `filing_classic_conflict`, `library_entry_missing`, `slots_shared`, `slots_detected`, `ollama_options_mismatch`, `lmstudio_autoevict`, `history_crowded`, `director_lite`.

**Трасса** (§5.7):
- `agents` получает ключ `recall`. Статус filing и historian хранится в строках `job` и `mem` (`gen`, `skipped`), в событиях `agent` и в `/memory`: эти агенты работают после коммита ответа, и в трассу хода попасть не могут;
- `compendium: {rev, source, picks: {ref, via}[], injected: {ref, tok}[], cut: {ref, tok}[], repeated, hidden}` — без текстов записей; `via` — `mention`, `model` или `window`;
- `recap` получает `arcs: {key, rev}[]`.

**Снимок протокола** получает `compendium?: {entries, byType, pending}`.

**Настройки** — `[compendium]` вместо `[memory]` (§13):

```ts
interface CompendiumConfig {
  enabled: boolean;                          // true
  profile: 'auto' | 'full' | 'lite';         // auto: lite при окне агента < 24 576
  language: string;                          // ≤ 80; '' — язык истории
  guidance: string;                          // ≤ 4 000; filing и historian; только сужает [D-66]
  minShare: number;                          // 0,4 — пол блока в доле лора
  maxAttempts: number;                       // 3
  idleDelaySec: number;                      // 8 [0–60]: задержка фона на локальном origin [D-84]
  books: Record<string, 'read' | 'off'>;     // по умолчанию read
  recall: { mode: 'auto' | 'sync' | 'prefetch' | 'lexical' | 'off'; onMiss: 'auto' | 'lexical' | 'sync';
            maxEntries?: number /* по профилю: full 10, lite 4; [1–30] */; minEntries: number /* 0 [0–20] */;
            contextMessages?: number /* по профилю: full 20, lite 6; [5–100] */; graceSec: number /* 4 */;
            timeoutSec?: number /* 30 локально, 20 удалённо */; onSwipe: 'reuse' | 'rerun'; guidance: string /* ≤ 8 000 */ };
  filing: { enabled: boolean; wait: number /* 1 [0–5] */; everyN: number /* 1 [1–10] */;
            allow: EntryType[] /* все, кроме summary */; timeoutSec?: number /* 300 / 120 */ };
  historian: { interval: number /* 20 [0–100] */; recapAfter: number /* 24 */; overlap?: number /* full 10, lite 6 */ };
}
```

Куда переехали прежние поля: `memory.lag` → `filing.wait`; `memory.recap` → `historian.interval > 0`; `memory.recapAfter` → `historian.recapAfter`; `memory.guidance` [D-66] → `compendium.guidance`.

#### 7.4.10 Не в v1

Ни один из этих проходов не меняет того, что рассказчик видит в каждом ходе.

| Что | Строк в Bunraku | Когда |
|---|---|---|
| квитанции, undo, commit, очередь, deps, book-writer, `entry-fields` | ≈ 470 | никогда: их заменяют свёртка, `revert` и «новейшее действие по ключу» |
| Reconcile — зеркальные связи MIRROR/KEEP | 134 | после M5: `/memory reconcile`, без модели |
| Diagnostics — бюджеты, почти-дубли, пересказы без сюжета | 122 | после M5: `/memory diag`, без модели |
| Ingest — импорт старого чата | 266 | вместе с импортом чатов [D-9]: задачи полосы `ingest:<from>-<to>`, привязанные к кускам пути |
| Standardize — классические записи в типизированные | 721 | после M9: копией книги, не на месте [D-3] |
| Refine, построенное моделью дерево и его ограничения | 354 + 571 | нет: это авторинг в UI Bunraku |
| Dashboard, crossrefs, dossiers, storyboards | 167 + 529 | в UI Bunraku, по данным `memory/list` и `memory/tree` |
| тул `explore_lorebook` | 108 | заменён `search_lore`/`read_lore` по Compendium с хэндлами `C<n>` |
| smart context (`summary-cut.ts`) | 30 | позже |
| ярусы графа связей, «залипание» выбора, `recall.every` | — | после замеров M5c |
| консолидация разросшихся записей | — | позже, по уведомлению `compendium_large_entry` |

### 7.5 Поиск по истории

Поиск устроен как тулы рассказчика и одновременно как `/search` в REPL и `history/search` в протоколе.

**`normalizeTerm` (`text/normalize.ts`)** — одна функция для поиска, ключей заметок, селектора Compendium, склейки почти-дублей и снимка мира Директора:

1. NFKC, локаленезависимый lower-case, `ё`→`е`.
2. Слова — это последовательности `[\p{L}\p{N}]+` (флаг `u`).
3. Для кириллического слова длиной ≥ 4 срезается одно самое длинное окончание из собственного списка (≈ 40 падежных, прилагательных и глагольных окончаний), если остаётся ≥ 3 буквы. Для латиницы срезаются `'s`, `-es`, `-s` у слов длиной ≥ 4.
4. Термин совпадает со словом, если совпали их основы.

Список окончаний — свой, без зависимости и без кода Snowball. Фикстуры: «караван/каравана/караваном», «Мира/Миру/Мирой», «трактирщица/трактирщицу», «брат/брата/братом».

- **`search_history {query, before?, limit?}`.**
  - **Область:** активный путь, действующий текст после правок. Скрытые сообщения и сиблинги-свайпы исключены: того, что в них, в этой линии времени не было.
  - **Сопоставление:** все слова запроса должны совпасть по основам (AND). `"фразы в кавычках"` ищутся буквально, с той же нормализацией, но без стемминга. Регулярок, написанных моделью, нет.
  - **Результат:** сначала новые, с номером, ролью, говорящим и сниппетом ±110 символов. До 20 попаданий, курсор `before`. Попадания внутри текущего окна помечены `(in context)`.
  - **Описание тула** просит искать по корням и коротким формам слов.
- **`read_history {from, to?}`** читает страницами по бюджету символов (4 000) и возвращает `next_from`. Описание тула запрещает утверждать, что прочитан диапазон, который не вернулся.
- **Происхождение (рев. 3).** Код портируется из `/btw` scene-search Леви: `btw/scene-search.ts`, `search-scene-messages.ts`, `read-scene-messages.ts`. При порте меняются три вещи:
  - граница слова — на Unicode;
  - добавляется стемминг;
  - область поиска сужается до активного пути.

### 7.6 Чего в v1 нет

В v1 нет следующих агентов и проходов:

- Lookback — детерминированный проход для моделей без тулов [D-24];
- Interpreter;
- Character Minds (Plan C Леви);
- трекеры;
- агент механик;
- Final Cut;
- спасение рассуждений;
- суб-агенты, которых вызывает модель (`delegate`).

Все они планируются как отдельные агенты поверх того же `structuredCall` и той же полосы [D-4].

---

## 8. Провайдеры

### 8.1 Нормализованный запрос и поток

```ts
interface PromptMsg { role: 'system' | 'user' | 'assistant' | 'tool'; blocks: Block[];
                      placement?: 'head' | 'inline'; src: string; replay?: Replay[] }
interface Replay {                       // только в памяти, только внутри текущего цикла тулов
  kind: 'anthropic-blocks' | 'gemini-parts' | 'reasoning_details' | 'tool_extra';
  connection: string; model: string; payload: unknown;
}
interface ModelRequest {
  model: ModelRef; caps: ModelCaps; messages: PromptMsg[];
  tools?: ToolSpec[]; toolChoice?: 'auto' | 'none';
  prefill?: string; maxTokens: number; samplers: Samplers; stop?: string[];
  reasoning?: 'auto' | 'none' | 'low' | 'medium' | 'high';
  responseSchema?: { name: string; schema: JSONSchema };
  signal: AbortSignal; callKey: string; agent: 'narrator' | 'director' | 'recall' | 'filing' | 'historian';
}
type StreamEv =
  | { t: 'text' | 'reasoning'; i: number; d: string }
  | { t: 'reasoning_end'; i: number; signature?: string; redacted?: boolean }
  | { t: 'tool_start'; i: number; id: string; name: string } | { t: 'tool_args'; i: number; d: string }
  | { t: 'tool_end'; i: number } | { t: 'usage'; u: Usage }
  | { t: 'finish'; reason: FinishReason; raw: string }
  | { t: 'error'; err: ProviderError; afterOutput: boolean };
interface Provider { stream(req: ModelRequest, env: { fetch: typeof fetch; key: string | null }): AsyncIterable<StreamEv> }
// complete(req) = aggregate(stream(req)) + проверка терминального состояния: наверх ВСЕГДА стримим
```

**Устройство адаптера.**

- Чистый `build(req) → {url, headers, body}` и фабрика парсера на каждый запрос: `createParser() → {line(raw) → StreamEv[], end() → AssistantResult}`.
- `AssistantResult.replay` хранит дословные нагрузки текущего раунда.
- Совпадение `replay` проверяется только по `connection` + `model`; `kind` говорит адаптеру, как его рендерить.
- Изменяемого состояния на уровне модуля нет: синглтон адаптера Anthropic в RoleCall перемешивал параллельные потоки.
- `fetch` и ключ передаются **на каждый запрос** (`Engine.open({fetch, keys})`), и провайдер между запросами не кэшируется. Это нужно хосту с собственным замком исходящих запросов (Bunraku).

**Общий `sse.ts`.**

- **Чтение.** Один байтовый поток и один `TextDecoder`. Разбиение по LF, CR допускается. `data:` принимается с пробелом и без. Строки-комментарии `:` пропускаются.
- **Когда останавливаться.** Чтение продолжается после `finish` до `[DONE]`, `message_stop` или EOF, потому что usage приходит после finish. EOF без терминального сигнала — это `truncated_stream`, а не придуманный stop. `finish` отдаётся вместе с чанком, где пришёл `finish_reason`, а не на `[DONE]`: обрыв, простой, ошибка или Stop между ними стоят только usage (ответ коммитится с `finish` провайдера, сбой — `stream_tail_failed`).
- **Без пустых строк.** Сервер, который пишет по строке `data:` на событие без пустой строки между ними, читается построчно: накопленные данные, уже являющиеся целым JSON или `[DONE]`, отдаются, когда приходит следующая строка `data:` (так читал Bunraku).
- **Ошибка внутри ответа 200** (включая `finish_reason:'error'` у OpenRouter) — провал.

**Фрагменты вызовов тулов.**

- Копятся по индексу. Имя присваивается, а не склеивается.
- Пропуски индексов игнорируются, вызовы без имени отбрасываются.
- Новый id на занятом индексе открывает новый вызов.
- Неизвестные ключи вызова (`extra_content.google.thought_signature`) сохраняются в `replay`.

**Usage** приводится к `{inputTotal, inputCacheRead, inputCacheWrite, outputTotal, outputReasoning?, cost?}`. Пустой usage означает «неизвестно», а не ноль.

### 8.2 Запись возможностей — данные, а не регулярки по id

```ts
interface ModelCaps {
  dialect: 'openai-chat' | 'anthropic' | 'gemini';        // 'openai-responses' зарезервирован
  contextLength?: number; maxOutput?: number; maxTokensField: 'max_tokens' | 'max_completion_tokens';
  tools: 'native' | 'prompted' | 'none';
  toolChoice: ('auto' | 'none' | 'required')[]; toolChoiceHonored: boolean;   // Ollama: false
  parallelToolCalls: 'send-true' | 'param' | 'never';      // llama.cpp: нужно явно true
  strictTools: boolean; toolIdFormat?: 'mistral9';
  structuredOutput: { mode: 'json_schema' | 'none'; confirmedBy?: 'host' | 'probe' | 'user' };
  midSystem: 'anthropic-native' | 'native' | 'as-user'; alternation: 'free' | 'strict';
  prefill: 'assistant-last' | 'prefix-flag' | 'none';
  reasoning: { output: 'none' | 'reasoning_content' | 'reasoning' | 'reasoning_details' | 'tags'
                      | 'anthropic-blocks' | 'gemini-parts';
               tags?: string[]; control: 'none' | 'effort' | 'budget' | 'adaptive' | 'level' | 'toggle';
               canDisable: boolean; offShape?: unknown /* Sonnet 5.5: between_tools */;
               echo: 'never' | 'tool-turn' | 'all-with-tools'; answerInReasoning?: boolean };
  samplers: { accepted: string[]; fixed?: boolean; wire?: Record<string, string> };
  streamUsage: 'stream_options' | 'always' | 'timings' | 'none';
  caching: 'auto-prefix' | 'anthropic-breakpoints' | 'none';
  maxInFlight: number;                 // ёмкость origin: явный max_in_flight, иначе 1 локально и 4 удалённо; проба слотов только советует [D-84]
  source: ('host' | 'model' | 'catalog' | 'probe' | 'user')[];
}
```

**Порядок источников.** Каждый следующий уточняет предыдущий.

1. **Пресеты хостов** (`hosts.json`): llama.cpp :8080, Ollama :11434, LM Studio :1234, koboldcpp :5001, vLLM, OpenRouter, NanoGPT, DeepSeek, api.anthropic.com, generativelanguage.googleapis.com.
2. **Строки по шаблону модели** (`models.json`). Например, у claude-opus-5-5, claude-sonnet-5-5, claude-fable-5-1 и claude-mythos-5-1 в `toolChoice` нет `'required'`, а также стоят `canDisable:false`, `prefill:'none'` и фиксированные семплеры.
3. **Метаданные каталогов:** OpenRouter `supported_parameters`, Ollama `/api/show`, llama.cpp `/props`, koboldcpp `/api/extra/version`.
4. **Кэш `rp-core probe`:**
   - пинг;
   - проба тулов только с `auto` (native или «протекло текстом»);
   - стрим-проба: поле рассуждений, наличие usage, форма стрима тулов;
   - проба `json_schema`.
5. **Оверрайды** `[caps."conn:model"]` в конфиге.

**Если о модели ничего не известно,** всё, что может дать 400, считается неподдерживаемым:

- неизвестное поле не отправляется;
- тулы — `prompted` [D-15];
- `structuredOutput` — `none`.

**Одно правило для всех агентов.** Транспорт определяется до вызова и **никогда** не переключается посреди хода. Сбой транспорта превращается в типизированный отказ и `notice{code:'caps.suggest'}` с конкретным советом.

Запись возможностей меняется только через пресет, каталог, явную пробу или пользователя. Ядро не делает выводов из текста ошибок и ничего не применяет само.

### 8.3 Транспорты тулов

**native.**

- Тулы уходят в поле провайдера; набор отсортирован и стабилен.
- `tool_choice` — только `auto` или `none`.
- Для llama.cpp `parallel_tool_calls:true` отправляется, если так сказано в записи.

**prompted** (`<tool_call>`).

- Нативные тулы не отправляются.
- **Каталог** — текст протокола плюс по записи на тул, аргументы выводятся из JSON Schema. Он лежит в **блоке ядра**: отдельном system-блоке в конце ведущего прогона, никогда не внутри блока пресета.
- **Формат вызова:** `<tool_call>{"name":…,"args":{…}}</tool_call>`.
- **Терпимый парсер** принимает `arguments`, атрибутную форму `<tool_call name="x">`, незакрытый тег на EOF и fences.
- **Стриминговый вырезатель** с carry-буфером не пускает обрывки тегов в события `text`.
- **`<tool_result`** — стоп-последовательность.
- **Результаты** возвращаются одним user-сообщением из блоков `<tool_result name id>`. Сырой текст вызова внутри хода остаётся в wire-сообщениях: если его вырезать, модель отучится звать тулы.

**Восстановление протечек** (любой диалект, с M3).

- Распознаются известные форматы в прозе: Hermes/Qwen `<tool_call>`, DSML, `[TOOL_REQUEST]`, `[TOOL_CALLS]`, `<function=…>`.
- Если вызов полный и тулы были предложены, он превращается в вызов. Иначе он вырезается до показа и хранения.
- Извлечение JSON-вызовов известных тулов из текста включается, только когда native-раунд вернул ноль вызовов.

**Проверка протокола перед каждой отправкой.**

- id и имена уникальны и безопасны, аргументы — объекты.
- На каждый вызов есть ответ, порядок сохранён, висящих пачек нет.
- id ремапятся под диалект: `functionResponse.id` у Gemini, 9-символьные id у Mistral.

### 8.4 Адаптеры в порядке сборки

**openai-chat (M1).** Покрывает llama.cpp, Ollama, LM Studio, koboldcpp, vLLM, TabbyAPI, OpenRouter, NanoGPT и DeepSeek.

- **URL.** Путь с сегментом `/vN` сохраняется, без него дописывается `/v1/chat/completions`. Вставленные суффиксы `/models` и `/completions` срезаются.
- **Сообщения.**
  - Ведущие system склеиваются в одно.
  - Поздние system отправляются по `midSystem`. Если через роутер идёт Claude, они становятся user, а соседние сообщения одной роли склеиваются.
  - Assistant-сообщение только с вызовами получает `content:null`.
  - Склейка ради строгого чередования — по записи возможностей.
- **Семплеры.** Отправляются только принимаемые, под проводными именами (`repeat_penalty` у llama.cpp, `repetition_penalty` у vLLM). `top_p: 0` не отправляется.
- **Рассуждения.**
  - Читаются все известные поля с дедупликацией: `reasoning_content`, затем `reasoning`, если отличается, затем `reasoning_details`.
  - Inline-теги `<think>` и подобные режет стриминговый сплиттер по `caps.reasoning.tags`.
- **DeepSeek** (`echo:'all-with-tools'`) в режиме thinking с тулами требует `reasoning_content` на всех прошлых ходах, иначе 400.
  - Ядро берёт его из блоков `reasoning` прошлых ответов с тем же `gen.model`.
  - Если хоть у одного прошлого assistant-хода на пути нет рассуждения этой модели (например, после `/model`), запрос отправляется с выключенным thinking, когда `canDisable`. Иначе — без тулов в этом ходу.
  - В обоих случаях приходит `notice{code:'caps.suggest'}`.
- **Usage** берётся из финального чанка с `choices:[]`, из повторного чанка OpenRouter или из `timings` llama.cpp.
- **Дополнительно:**
  - OpenRouter — `provider.allow_fallbacks:false` и `session_id`, без изменчивых метаданных;
  - llama.cpp — `cache_prompt:true`.

**anthropic (M7).**

- **Заголовки.** `x-api-key`. `anthropic-version` закреплён на соединении, по умолчанию `2023-06-01`; в версии 2026-10-21 любой семплер — 400. `max_tokens` обязателен.
- **System.**
  - Ведущий system-прогон становится отдельными блоками верхнего уровня, кэш-метка — на последнем.
  - Поздние system — по правилу из §8.5.
- **Тулы.** Результаты уходят user-ходом из блоков `tool_result`.
- **Thinking** — по записи возможностей.
  - Режим: adaptive или опущен. `enabled` с бюджетом — только на ≤ 4.5.
  - `disabled` не отправляется на моделях, которые его отвергают: Opus 5.5, Sonnet 5.5, Fable, Mythos. У Sonnet 5.5 минимум — `between_tools`.
  - Effort — в `output_config.effort`.
  - Если UI показывает рассуждения, ставится `display:'summarized'`.
- **Семплеры.** На моделях с фиксированными семплерами не отправляется ни один. `temperature` и `top_p` вместе — никогда.
- **Префилл** на ≥ 4.6 не используется.
- **Кэш.** Stateless-метки: последний system-блок, `messages[-2]`, `messages[-1]`, с учётом минимальной кэшируемой длины. TTL по умолчанию 1 час: в RP паузы длинные.
- **Причины остановки.** `pause_turn` → отправить повторно. `refusal` и `model_context_window_exceeded` → типизированные finish.
- **Блоки thinking.** `redacted_thinking` и thinking с пустым текстом возвращаются внутри цикла без изменений.

**gemini (M8).**

- **Запрос.** `:streamGenerateContent?alt=sse`. Ключ — в заголовке `x-goog-api-key`, никогда в URL. Ведущий system-прогон — в `systemInstruction`.
- **Роли.** user и model; одинаковые соседние склеиваются, но подписанная часть никогда ни с чем не склеивается.
- **Тулы.**
  - `functionDeclarations` проходят через санитайзер схем.
  - `functionCall.id` возвращается обратно; `functionResponse` несёт id и имя.
  - Все вызовы идут до всех ответов.
- **Подписи.** `thoughtSignature` остаётся на исходной части, включая пустые текстовые части из стрима.
- **Thinking.** `thinkingLevel` или `thinkingBudget` — по модели, никогда оба сразу.
- **Безопасность.** Для всех настраиваемых категорий явно `safetySettings` OFF. SAFETY, PROHIBITED_CONTENT, MALFORMED_FUNCTION_CALL, MISSING_THOUGHT_SIGNATURE и `promptFeedback` становятся типизированными finish.
- **API** — generateContent, не Interactions.

### 8.5 Системные сообщения посреди диалога у Anthropic

Нативный `role:'system'` после первого хода есть у Opus 5.5, Opus 5, Opus 4.8, Sonnet 5.5, Haiku 5.5, Fable и Mythos 5/5.1. У Sonnet 5 его нет.

**Правило:** такое сообщение должно идти **после user-хода** и при этом либо быть **последним**, либо стоять **перед assistant-ходом**.

Как адаптер его применяет:

1. Сначала соседние поздние system-блоки на одной позиции сливаются в один. Иначе второй блок шёл бы после system, а не после user.
2. Затем правило проверяется для каждого блока:
   - выполняется — блок уходит нативным system;
   - не выполняется — блок оборачивается в `[System note] …` и сливается с ближайшим следующим user-ходом, а если его нет — с предыдущим.

Что это даёт при чередующейся истории (…U, A, U, A, U, где последний U — текущий; глубина — по §10.1):

- **Чётные глубины (0, 2, 4…)** стоят после user и перед assistant (или в самом конце) и потому нативно валидны. Это guidance (0) и заметки Compendium (4).
- **Нечётные глубины (1, 3…)** стоят после assistant и уходят inline. Это директива, блок Compendium и авторская заметка (1).
- **Если чередование нарушено** (скрытые сообщения, два user подряд), решает только проверка адаптера. Список выше — ожидание, а не правило.
- **Внутри цикла тулов** user-ход с `tool_result` допускает нативный system по тому же правилу.

### 8.6 Повтор рассуждений [D-18]

- **Внутри текущего цикла тулов** рассуждения повторяются дословно из `replay` в памяти:
  - блоки Anthropic: thinking и redacted_thinking, включая пустые;
  - части Gemini с подписями;
  - `reasoning_details` OpenRouter (без них Gemini 3 через OpenRouter зависает).
- **Между ходами пользователя рассуждения Anthropic и Gemini отбрасываются.**
  - Причина: RP каждый ход перерисовывает лор, а свайпы и правки меняют префикс. На Fable 5.1, Opus 5.5, Sonnet 5.5 и Haiku 5.5 повтор с изменённым префиксом — 400 для аккаунтов, созданных с 31.08.2026.
  - Отбрасывание целиком снимает блоки с начала цепочки, и API это допускает.
- **Бета `thinking-binding-controls-2026-08-01`** (`prefix_mismatch_behavior:'drop_block'`) не отправляется: при этой политике она избыточна.
- **DeepSeek** — по правилу из §8.4.
- **Рассуждения никогда не уходят** в другой диалект или другую модель.

### 8.7 Раскладка ради кэша

Порядок частей запроса:

1. **Тулы** — стабильные и отсортированные.
2. **Голова:** пресет до истории, карточка, персона, константный лор, блок ядра.
3. **История.**
   - Между ходами она только дописывается.
   - Обрезается кусками по 8 сообщений.
   - Пересказы стоят в точке обрезки и меняются только вместе с ней.
4. **Вставки по глубине:** сработавший лор, заметки и блок Compendium, директива, авторская заметка.
5. **post_history.**
6. **Префилл.**

- **Режим thinking и effort** фиксированы на сессию. Их смена — это запись `config` и ожидаемый промах кэша.
- **Раскладка по умолчанию верна пресету.** Сработавший лор на позициях `before`/`after` меняет голову — это семантика ST. Режим `layout = "cache-friendly"` (позже) переносит сработавший неконстантный лор в хвост.

### 8.8 Параллельность, таймауты, ошибки

**`sched.ts`** — семафор на origin (`scheme://host:port`), а не на имя соединения: два имени на одном сервере делят его места [D-84]. Ёмкость — явный `max_in_flight`; иначе 1 для localhost и 4 для удалённых. Проба `GET /slots` ёмкость не поднимает, а только советует: общий KV llama-server по ней не отличить от раздельного (§7.4.7). Приоритетов два:

- **interactive** — рассказчик, Директор, sync recall, prefetch, которого ждёт ход (в пределах `graceSec`), `draft`;
- **background** — prerecall, filing, historian. На локальном origin фоновая задача стартует, только когда интерактивных запросов нет ни в работе, ни в очереди, и не раньше `compendium.idleDelaySec` после хода; интерактивный запрос вытесняет её, даже если место свободно (§7.4.7).

Правила:

- Интерактивный запрос обгоняет фоновые в очереди.
- **Вытеснение.** Если все места заняты, причём хотя бы одно — фоновым запросом, интерактивный запрос прерывает самый свежий фоновый (`preempted`). Фоновый возвращается в очередь, ничего не записав.
- Директор и рассказчик одного хода не конкурируют: Директор всегда идёт раньше. Sync recall запускается вместе с Директором; на одном месте семафор ставит Директора первым (§7.4.7).
- Агенты не шлют `cache_prompt:false`; запросы агентов к той же модели Ollama несут опции раннера рассказчика, иначе модель перезагружается (§7.4.7).
- Закрепление слотов llama.cpp (`id_slot`: рассказчик — 0, агенты — 1) — на M5c, при `max_in_flight = 2` и если проба подтвердит, что сервер его принимает (§7.4.7). Прогрев префикса — позже, если замеры M5c покажут нужду.
- Что llama.cpp прекращает обработку при разрыве стрима, проверяется фикстурой на M5.

**`http.ts`.**

- **Fetch с замком на хост.** Редиректы проходят вручную: только на тот же хост, без понижения https→http, не больше 5 шагов.
- **Таймауты.** Первый байт — 600 с для localhost (обработка промпта медленная) и 120 с для удалённых. Простой между чанками — 120 с. Считаются байты тела, включая SSE-комментарии keep-alive (`: OPENROUTER PROCESSING`, `: keep-alive` DeepSeek, пинги llama.cpp): адаптер сообщает о каждом чанке через `ProviderEnv.onActivity`. До первого события вызов падает, только когда истекли оба срока.
- Поведение Bun fetch на длинных паузах не проверено; проверка — на M1.

**`ProviderError{category, code, status, retryAfterSec, afterOutput}`.** Коды:

- `auth_failed`, `model_not_found`, `context_length_exceeded`, `bad_request`;
- `rate_limited`, `overloaded`, `unreachable`, `truncated_stream`, `timeout`;
- `content_filter`, `refusal`, `empty_response`, `reasoning_only`;
- `prefill_unsupported`, `forced_tool_unsupported`, `thinking_signature_mismatch`, `tool_protocol_invalid`.

`message` — фиксированная фраза кода (`PROVIDER_ERROR_MESSAGE`) со статусом; слова сервера (могут цитировать промпт или эхом вернуть ключ) — в `detail`, их видит только `--debug` (`EngineOptions.onProviderError`), и то после `scrub`. Хранится только `{category, code, status}`. 403 с признаками модерации (OpenRouter `metadata.reasons` / `flagged_input`) — `content_filter`, а не `auth_failed`.

---

## 9. Тулы и подтверждения

### 9.1 Определение и исполнение

```ts
interface Tool<A = unknown> {
  name: string; description: string; schema: JSONSchema;   // плоский объект, без юнионов в корне
  effect: 'read';                                          // v1: только чтение; 'write' зарезервирован
  when?(ctx: ToolCtx): boolean;                            // предикат показа, раз на ход
  maxOutput?: number;                                      // символов к модели (по умолчанию 4 000)
  run(args: A, ctx: ToolCtx): Promise<{ text: string; summary: string; error?: boolean }>;
}
interface ToolCtx { view: PathView; lore: LoreBook[]; signal: AbortSignal; now: string; rng: Rng }
```

- **Показ.** Набор тулов вычисляется один раз на ход, в одном месте. Отсортированный список одновременно уходит модели и служит таблицей диспетчеризации. Тулов не получают continue, `draft` и ходы, где их выключил префилл [D-28].
- **Исполнение.**
  - Все вызовы в v1 — чтения, поэтому пачка исполняется параллельно, а результаты встают в порядке вызовов.
  - Ошибка одного тула не трогает другие. Неизвестный тул получает результат-ошибку.
- **Аргументы** проходят цепочку: `JSON.parse` → `jsonrepair` → срез шаблонных маркеров → приведение скаляров по схеме → валидация (тип, required, enum, maxLength).
  - При неудаче тул не запускается, а модель получает ошибку до 500 символов («пришли один полный JSON-объект»).
  - Каждая починка пишется в трассу.
  - Недостающие обязательные значения не выдумываются.
  - Вызов, который уходит модели эхом, пересобирается из разобранных аргументов.

### 9.2 Встроенные тулы v1 [D-5]

| Тул | Что делает |
|---|---|
| `search_history {query, before?, limit?}` | §7.5 |
| `read_history {from, to?}` | §7.5 |
| `search_lore {query}` | Ранжированный поиск по активным лорбукам, заметкам и записям Compendium через `lexScore`; списанные записи исключены; топ-10 сниппетов с хэндлами (`L12`, `C7`); у записей Compendium — краткий рендер |
| `read_lore {ids}` | Полные записи, до 8 000 символов |

**`lexScore` (`text/lexscore.ts`)** — одно лексическое ранжирование для `search_lore`, селектора, шорт-листа и ростера Compendium и снимка мира Директора. Термины нормализуются (§7.5), записи сравниваются лексикографически:

1. сколько **разных** терминов запроса совпало с основами в заголовке, ключах или тексте записи — больше лучше;
2. при равенстве — сколько терминов совпало именно с ключом (заголовок считается ключом);
3. затем свежесть (для Compendium — `prov.lastSeq`) или `order` (для лорбуков).

Схема своя. Карта портирования сравнит её на фикстурах `ru` с весами `search_lorebook` из RoleCall: заголовок × 3, ключи × 2, текст × 1.

Позже кандидат — `roll {expr}`: кубики на seed-RNG хода с записью в трассу.

### 9.3 Подтверждения и MCP

В v1 пишущих тулов нет, и протокол подтверждений не нужен. Правила зафиксированы сейчас, чтобы позже их не придумывать:

- в процессе подтверждение идёт событием `gate` и `answerGate`, в stdio — запросом `approval/request` от ядра к клиенту (имя зарезервировано);
- Stop, уход клиента и краш дают `cancelled`;
- таймаут — `reject`;
- неизвестный ответ — `reject`;
- клиент, который не объявил в `initialize` возможность `approvals`, получает `deny`.

**MCP** (позже) подключается отдельным модулем на `@modelcontextprotocol/client`.

- Имена тулов — `mcp__<server>__<tool>`, `effect:'write'`, политика `ask`.
- Каждый сервер доступен только выбранным агентам, по умолчанию — никому.
- Результаты обрезаются по размеру.
- Секреты серверов хранятся ссылками, как ключи (§13).
- Серверы не стартуют при импорте модуля и закрываются в `engine.dispose()`.

---

## 10. Пресеты и лорбуки

### 10.1 Одна функция глубины, конвенция ST [D-12]

**Глубина `d`:** после вставленного блока идут ровно `d` сообщений чата.

- Сообщения чата — это область истории: приветствие, история, текущее сообщение пользователя. Вставленные блоки, пересказы и префилл continue не считаются.
- `d = 0` — после последнего сообщения; `d = 1` — прямо над текущим сообщением пользователя; `d ≥ count` — перед первым.
- **При равной глубине** блоки упорядочены по `order` по возрастанию, затем по источнику: preset < lore < compendium < depth-заметка карточки < авторская заметка < director. Директор оказывается ближе всех к чату.

`prompt/depth.ts` — единственный код, который вычисляет вставки. Им пользуются:

- блоки пресета внутри чата;
- лор `@depth`;
- `depth_prompt` карточки;
- авторская заметка;
- директива и блок Compendium (глубина 1);
- заметки Compendium (глубина 4);
- guidance (глубина 0).

**Импорт.** Глубины ST переносятся 1:1. При импорте пресетов и лорбуков RoleCall (позже) к глубине внутри чата прибавляется 1: у RC глубина 0 означает «перед текущим сообщением пользователя».

**Агенты** попадают в сборку только размеченными вставками (`{src, at: {depth, role} | {slot}}`) с настоящим источником в трассе. В блоки пресета они не вклеиваются никогда.

### 10.2 Нативные форматы

```ts
interface Preset {                 // format: 'core.preset/1'
  name: string;
  blocks: { id: string; name?: string; role: 'system' | 'user' | 'assistant'; enabled: boolean;
            content: string;                                   // макросы разрешены
            at: 'relative' | 'top' | 'bottom' | { depth: number; order?: number };
            override?: 'card_system' | 'card_post_history' }[];
  forbidOverrides?: boolean;
  samplers?: Partial<Samplers>;
  context?: { maxContext?: number /* может только уменьшать окно */; maxMessages?: number };
  prefill?: string; impersonation?: { prompt?: string; prefill?: string };
  postProcessing?: 'none' | 'merge' | 'semi' | 'strict' | 'single';
  extras?: Record<string, unknown>; // чужие поля для обратного экспорта
}
interface LoreBook {               // format: 'core.lorebook/1'
  name: string; scanDepth?: number; recursive?: boolean; caseSensitive?: boolean; wholeWords?: boolean;
  match?: 'literal' | 'stem';       // 'stem' — сравнение по основам (§7.5); у книги заметок Compendium по умолчанию
  entries: LoreEntry[]; extras?: Record<string, unknown>;
}
interface LoreEntry {
  id: string; title?: string; content: string; enabled?: boolean; constant?: boolean;
  keys: string[];                                   // '/re/flags' — регулярка (re2js)
  secondary?: string[]; logic?: 'and_any' | 'and_all' | 'not_any' | 'not_all';
  position: 'before' | 'after' | 'examples_before' | 'examples_after' | 'note_before' | 'note_after'
          | 'top' | 'bottom' | 'recap' | { depth: number; role?: 'system' | 'user' | 'assistant' } | { outlet: string };
  order?: number;                                   // одна ось ST: место в слоте И приоритет в бюджете
  probability?: number; group?: string; groupWeight?: number;
  scanDepth?: number; caseSensitive?: boolean; wholeWords?: boolean;
  preventRecursion?: boolean; excludeRecursion?: boolean; ignoreBudget?: boolean;
  sticky?: number; cooldown?: number; delay?: number;
  meta?: CompendiumMeta;            // {type?, data?, aliases?, featured?, arc?}: типизированная запись Compendium (§5.8)
}
```

**Маркеры** во время выполнения не существуют: конвертер превращает их в **слот-макросы**.

- `{{history}}` — ровно один на пресет. Это проверяется при загрузке; отсутствие — ошибка, а не тихая потеря.
- Слоты лора: `{{lore::before}}`, `{{lore::after}}`, `{{lore::examples_before}}`, `{{lore::examples_after}}`, `{{outlet::name}}`.
- Слоты карточки и истории: `{{recap}}`, `{{examples}}`, `{{persona}}`, `{{description}}`, `{{personality}}`, `{{scenario}}`.
- Слот агента (опциональный): `{{slot::director}}`.

Если пресета нет, используется встроенный пресет по умолчанию в том же формате.

**Раскладка по умолчанию:**

```
[top pins]
main (system)        ← заменяется system_prompt карточки, если пресет не запрещает; доступен {{original}}
{{lore::before}} · description · personality · scenario · {{lore::after}}
persona · {{lore::examples_before}}{{examples}}{{lore::examples_after}}
[блок ядра: контракт Директора + протокол/каталог тулов]   ← конец ведущего system-прогона
{{history}}: приветствие → {{recap}} (на месте обрезки) → … → текущее сообщение; вставки по глубине
post_history (system) ← заменяется post_history_instructions карточки
[bottom pins] · [префилл — только в ходе без тулов]
```

**Переопределения карточки [D-21]** работают по семантике ST: `system_prompt` и `post_history_instructions` карточки заменяют блоки с `override`, если не задан `forbidOverrides`, и доступен `{{original}}`. Без этого карточки ST под большинством пресетов молча теряют свои инструкции.

### 10.3 Активация лора (M2) [D-7]

Конвейер с семантикой ST:

1. Собрать включённые записи: книга персонажа, книга персоны, книги сессии, заметки Compendium. Типизированные записи (`meta.type`) из книг с доступом `read` сюда не входят: их включает Compendium (§7.4.1) [D-76].
2. Сработать константным.
3. Собрать текст для сканирования: последние `scanDepth` сообщений пути, включая текущий ввод. **Значение по умолчанию одно — 2, как в ST** (для нативных книг и импорта). У книги заметок Compendium свой `scanDepth: 4`.
4. Сопоставить первичные ключи:
   - `match:'literal'` (по умолчанию, семантика ST) — подстрока или целое слово с учётом Unicode: `(?<![\p{L}\p{N}_])kw(?![\p{L}\p{N}_])`, флаги `iu`;
   - `match:'stem'` — совпадение основ по `normalizeTerm` (§7.5);
   - `/regex/` — через re2js. Регулярка, которая не компилируется, считается литералом, а её ошибка пишется в трассу.
5. Применить вторичные ключи с логикой.
6. Рекурсия до 3 уровней: содержимое сработавших записей пополняет буфер, если нет `preventRecursion`. Записи с `excludeRecursion` сопоставляются только с прямым текстом.
7. Группы включения — взвешенный выбор на seed-RNG.
8. **Сначала бросок вероятности, потом бюджет** (порядок ST).
9. Бюджет по `order` с реальным подсчётом токенов. Записи с `ignoreBudget` идут мимо бюджета.
10. Размещение по позициям. Свежесть типизированных записей — забота Compendium (§7.4.1); заметки человека не подавляются.

Таймеры sticky, cooldown и delay выводятся из срабатываний на пути (§5.10), а не хранятся в памяти процесса.

Каждое решение становится вердиктом в трассе: сработала и почему, пропущена и почему, срезана бюджетом. `/lore test <текст>` и `lore/test` показывают вердикты без запуска хода.

### 10.4 Макросы с первого дня

- **Карточка и персона:** `{{char}}`, `{{user}}`, `{{description}}`, `{{personality}}`, `{{scenario}}`, `{{persona}}`, `{{examples}}` (алиасы `mesExamples`, `mes_example`), `{{system_prompt}}`/`{{charPrompt}}`, `{{post_history}}`/`{{charInstruction}}`, `{{original}}`, `{{first_message}}`.
- **Слоты** — см. §10.2.
- **Текстовые:** `{{// …}}`, `{{trim}}`, `{{newline}}`.
- **Случайность и время:** `{{random::a::b}}`, `{{pick::…}}`, `{{roll::1d20}}` — на seed; `{{time}}`, `{{date}}`, `{{weekday}}` — от переданных часов.
- **Переменные:** `{{getvar}}`, `{{setvar}}`, `{{addvar}}`, `{{incvar}}` — переменные сессии (§5.10). Глобальные — позже.

Правила раскрытия:

- каждый блок раскрывается ровно один раз;
- история и вывод модели — **инертные данные**, они не раскрываются;
- во введённом пользователем тексте раскрываются только макросы идентичности, и только на чтение;
- неизвестный макрос остаётся **буквальным текстом** (как в ST) и попадает в трассу. В RoleCall вырезание неизвестных макросов теряло `{{mes_example}}`.

### 10.5 Импорт [D-6]

**v1 (M1–M2):**

- **Карточки CCv2/V3** в JSON и PNG.
  - Из PNG читаются tEXt-чанки `chara` (base64) и `ccv3`; `ccv3` в приоритете.
  - Переносятся в `Character`: альтернативные приветствия, встроенный `character_book` (он становится `book`), `system_prompt`, `post_history_instructions`, `extensions.depth_prompt`. Остальные поля уходят в `extras`.
- **Chat-completion пресеты ST.**
  - `enabled` берётся из `prompt_order` для `character_id 100001`. Промпты, на которые там нет ссылок, импортируются выключенными.
  - `injection_position`: 0 → relative, 1 → `{depth}`.
  - `main` и `jailbreak` получают `override`, `forbid_overrides` переносится.
  - Переносятся семплеры, `assistant_prefill`, `impersonation_prompt`, `assistant_impersonation`.
  - Порядки отдельных персонажей уходят в `extras`.
- **ST world info** с настоящим enum позиций: 0 before, 1 after, 2 note_before, 3 note_after, 4 depth, 5 examples_before, 6 examples_after, 7 outlet. Книга импортируется с `match:'literal'`.

У каждого конвертера есть тест покрытия по слотам: забытый слот — это тихая потеря данных.

**Позже:** `.vnpack` Леви, экспорт пресетов и лорбуков RoleCall (+1 к глубине), Marinara, чаты ST в JSONL [D-9].

---

## 11. Бюджет контекста

Всё считается в одном месте — `prompt/budget.ts` — одинаково для рассказчика и всех агентов.

- **Окно** = `min(caps.contextLength ?? (8192 для localhost | 32768 для удалённых), preset.maxContext, config.window)`. Пресет и сессия могут только уменьшить окно.
- **Резерв на ответ** = `min(maxTokens ?? (window < 24 576 ? 2 048 : 8 192), window / 2)`. *Рев. 6 [D-89]:* на малом окне 8 192 по умолчанию почти не оставляли бы места истории (§7.4.6). Рассуждающей модели на таком окне `max_tokens` стоит задать явно. `maxTokens` здесь уже ограничен `caps.maxOutput`, а в запрос уходит сам резерв: промпт плюс `max_tokens` всегда помещается в окно. Если `max_tokens` пользователя урезан, движок говорит об этом один раз (`max_tokens_reduced`).
- **Подсчёт токенов.**
  - **M1, без зависимостей:** консервативная оценка по символам (символы/3, для кириллицы — символы/2,5) с поправкой EMA.
  - **С M2:** `gpt-tokenizer` o200k, умноженный на поправку EMA для каждой модели.
  - Поправка учится по промпт-токенам, которые сообщает провайдер (llama.cpp `timings.prompt_n`, usage Anthropic): α 0,3, старт 1,15, коридор 0,8–2,0. Вызов с отношением ниже 0,5 — не сэмпл: сервер обрезал промпт (Ollama молча выкидывает старые сообщения под свой `num_ctx`). О таком вызове движок один раз говорит `context_truncated_by_server`.
  - Счётчик подключается через внутренний интерфейс.
- **Доли окна:**
  - лор вместе с блоком Compendium — 25 %; если у Compendium есть кандидаты, движок лора берёт не больше 60 % этой доли (§7.4.1);
  - слот `{{recap}}` — отдельные 10 %: обзоры арок (не больше половины слота), затем пересказы; старейшие выпадают первыми (§7.4.4);
  - директива и блок ядра резервируются первыми и не обрезаются.
- **Финальный проход** по собранному запросу.
  - Срезает самую старую историю **кусками по 8** сообщений, чтобы кэшированный префикс жил несколько ходов.
  - Никогда не срезает: system-блоки, приветствие, текущее сообщение пользователя, вставки агентов, половину пары вызов/результат.
  - Если не помещается одна обязательная часть, возвращает `context_length_exceeded` и ничего не отправляет.
- **Агенты.**
  - Директор — 25 % своего окна на историю, в lite-режиме — 10 %.
  - агенты Compendium — по профилю (§7.4.6): в lite запрос recall ≤ min(6 000, 40 % окна), filing ≤ 45 % окна, окно historian ≤ 35 %; в full — бюджеты Bunraku, зажатые окном.
- **Ограничения на ход.**
  - Результат тула к модели — не больше 4 000 символов.
  - Потолок — 12 вызовов модели на ход.
- **Учёт.** Каждый вызов отправляет событие `usage` с `callKey`, `agent`, `parentToolCallId?` (в v1 пустое; нужно для будущих суб-агентов), `costUsd`, `priceSource`. Стоимость берётся так:
  1. та, что сообщил провайдер (OpenRouter `usage.cost`, NanoGPT);
  2. иначе — из таблицы `[prices."conn:model"]` в конфиге с датой `as_of`;
  3. иначе — `null`, но никогда не 0.

---

## 12. Протокол `--stdio` и REPL

### 12.1 Библиотечный API — канонический

```ts
const engine = await Engine.open({ home, config, fetch?, keys?, clock?, random?, hooks? /* M9 */ });
const s = await engine.session(sessionId);                     // снимок; ничего не проигрывает
const { messageId, version } = await s.send({ text, expectedVersion: s.version() });
const turn = s.runTurn({ kind: 'reply', expectedVersion: version, onError: 'keep' }); // отказ = throw Refusal
for await (const ev of turn.events) render(ev);                // done/stopped/failed/conflict завершают итерацию
engine.events();                                               // все сессии, включая фоновых агентов
```

`--stdio` и one-shot — чистая сериализация тех же вызовов и событий (по образцу пары SDK/RPC в pi).

### 12.2 Формат провода (M6)

**Кадрирование.**

- UTF-8, сообщения JSON-RPC 2.0, по одному на строку.
- Вход режется явным **байтовым** сплиттером по `0x0A` с одним потоковым `TextDecoder`. CR перед LF допускается.
- Пустые строки игнорируются, включая лишнюю пустую строку на EOF у Bun.
- `node:readline` для протокола не используется: Node режет по U+2028/U+2029.

**Каналы.** В stdout идёт только протокол, логи — в stderr.

**Завершение.**

- **Закрытие stdin** — упорядоченное завершение:
  - идущие ходы останавливаются с сохранением частичного текста;
  - полоса доделывает текущую задачу или оставляет её для повторного запуска;
  - lock снимается, выход с кодом 0.
- **SIGINT** останавливает ход; второй SIGINT завершает процесс.
- **SIGTERM** прерывает всё и сохраняет частичный текст.
- Обработчики сигналов есть только в `cli/`, библиотека их не ставит.

**Команды (клиент → ядро).**

```ts
type Command =
  | { method: 'initialize'; params: { protocol: 1; client: { name: string; version: string };
        capabilities?: { gates?: ('review' | 'transform')[]; approvals?: boolean } } }
      // → { protocol: 1, core: { version }, features: ['swipes','tools','director','memory', …] }
  | { method: 'session/new'; params: { character: string | Character; persona?: string | Persona;
        config?: Partial<SessionConfig>; title?: string } }            // → { sessionId, snapshot }
  | { method: 'session/open'; params: { sessionId: string } }           // → Snapshot
  | { method: 'session/list'; params: {} }
  | { method: 'session/close'; params: { sessionId: string } }
  | { method: 'session/configure'; params: { sessionId: string; patch: Partial<SessionConfig> } }   // /model, /preset, /note …
  | { method: 'session/fork'; params: { sessionId: string; at: string } }            // → { sessionId }
  | { method: 'session/preview'; params: { sessionId: string; draft?: string; turnId?: string } }
  | { method: 'message/send'; params: { sessionId: string; text: string; expectedVersion: number; greetingIndex?: number } }
  | { method: 'turn/run'; params: { sessionId: string; kind: TurnKind; expectedVersion: number;
        guidance?: string; fallback?: string; onError?: 'drop' | 'keep'; emptyReply?: 'fail' | 'keep';
        inspect?: boolean /* M9 */ } }                                  // → { turnId, messageId } сразу после допуска
  | { method: 'turn/submit'; params: { sessionId: string; text: string; expectedVersion: number } }
  | { method: 'turn/stop' | 'turn/commitAnyway' | 'turn/discard'; params: { sessionId: string; turnId: string } }
  | { method: 'message/edit'; params: { sessionId: string; messageId: string; text: string; expectedVersion: number } }
  | { method: 'message/hide'; params: { sessionId: string; messageId: string; hidden: boolean; expectedVersion: number } }
  | { method: 'history/select'; params: { sessionId: string; messageId: string; expectedVersion: number; exact?: boolean } }  // голова → новейший потомок; exact: true — на само сообщение (откат, §5.5; M1b)
  | { method: 'history/tails'; params: { sessionId: string } }
  | { method: 'history/search'; params: { sessionId: string; query: string; before?: number; limit?: number } }
  | { method: 'lore/test'; params: { sessionId: string; text: string } }
  | { method: 'memory/list'; params: { sessionId: string; at?: string; type?: string; includeRetired?: boolean } }
  | { method: 'memory/get'; params: { sessionId: string; ref: string; at?: string } }       // → { entry, render, brief }
  | { method: 'memory/tree'; params: { sessionId: string; at?: string; book?: string } }
  | { method: 'memory/file'; params: { sessionId: string; type: EntryType; data: Record<string, unknown> } }
  | { method: 'memory/add'; params: { sessionId: string; title: string; keys: string[]; content: string } }   // заметка (M3)
  | { method: 'memory/edit'; params: { sessionId: string; ref: string; set?: Record<string, unknown>; unset?: string[];
        keys?: string[]; featured?: boolean } }
  | { method: 'memory/retire' | 'memory/restore'; params: { sessionId: string; ref: string; reason?: string } }
  | { method: 'memory/undo' | 'memory/refile'; params: { sessionId: string; messageId: string } }
  | { method: 'memory/retry'; params: { sessionId: string; messageId?: string } }
  | { method: 'memory/recall'; params: { sessionId: string; turnId?: string; test?: string } }   // → RecallRecord + trace.compendium
  | { method: 'memory/export'; params: { sessionId: string; name: string; format: 'core' | 'compendium' } }
  | { method: 'director/show'; params: { sessionId: string; at?: string } }
  | { method: 'caps/get' | 'caps/probe'; params: { conn: string; model: string } }
  | { method: 'models/list'; params: { conn: string } }
  | { method: 'shutdown'; params?: {} };
// зарезервировано: 'draft/run' (M9), 'approval/request', 'input/request'

interface Snapshot {
  config: SessionConfig; version: number; head: string;
  path: MessageView[];                         // последние 200 + курсор для подгрузки
  tails: string[];
  openTurns: { turnId: string; kind: TurnKind; state: 'running' | 'held'; draft?: string }[];
  director?: { turn: number; chapter?: string; arcs: number; seeds: number };
  background: number;
  compendium?: { entries: number; byType: Record<string, number>; pending: number };
}
```

Ошибки имеют вид `{code: -32000, message, data: {code: RefusalCode | ProviderErrorCode}}`.

**Запросы ядро → клиент (M9).** `gate/request {turnId, gateId, kind: 'review' | 'transform', payload}` — ответ `{action: 'send' | 'cancel', edits?}`. Запрос отправляется, только если клиент объявил этот гейт в `initialize`. Иначе `inspect` получает отказ `gate_unsupported`, а хук `transform` для этого клиента не включается.

**События** (уведомление `{"jsonrpc":"2.0","method":"event","params":Event}`). Имена и поля — в собственных понятиях ядра:

```ts
type Event = { sessionId: string; ts: string } & (
  | { type: 'start'; turnId: string; kind: TurnKind; messageId: string; parentId: string }
  | { type: 'text' | 'reasoning'; turnId: string; delta: string; offset: number }   // эфемерные
  | { type: 'prefill'; turnId: string; text: string }
  | { type: 'director'; turnId: string; status: 'planning' | 'planned' | 'reused' | 'failed' | 'skipped';
      reason?: string; summary?: string }
  | { type: 'tool'; turnId: string; callId: string; name: string; phase: 'start' | 'done';
      args?: unknown; ok?: boolean; summary?: string }
  | { type: 'gate'; turnId: string; gateId: string; kind: 'review' | 'transform'; payload: unknown } // M9, в процессе
  | { type: 'done'; turnId: string; message: MessageView }
  | { type: 'stopped'; turnId: string; message: MessageView | null }
  | { type: 'failed'; turnId: string; category: string; code: string; message: string; draft: string }
  | { type: 'conflict'; turnId: string; draft: string }                                // M6
  | { type: 'agent'; agent: 'recall' | 'filing' | 'historian'; turnId?: string; job?: string;
      status: 'queued' | 'started' | 'preempted' | 'adopted' | 'recalled' | 'reused' | 'fallback'
            | 'skipped' | 'done' | 'failed' | 'parked';
      source?: 'sync' | 'prefetch' | 'lexical' | 'reused'; count?: number; skipped?: number; code?: string; reason?: string }
  | { type: 'memory'; change: 'created' | 'merged' | 'arc' | 'note' | 'edited' | 'retired' | 'restored' | 'reverted';
      ref: string; kind: EntryType | 'note' | 'arc'; name: string; by: 'filing' | 'historian' | 'user' }
  | { type: 'usage'; callKey: string; agent: string; parentToolCallId?: string; model: string;
      usage: Usage; costUsd: number | null; priceSource: 'provider' | 'table' | 'none' }
  | { type: 'retry'; callKey: string; attempt: number; delayMs: number; code: string; status?: number }
  | { type: 'recovered'; turnId: string; outcome: 'interrupted' | 'abandoned' | 'dropped'; draft?: string }
  | { type: 'changed'; version: number; change: 'msg' | 'edit' | 'hide' | 'head'; id?: string }
  | { type: 'notice'; level: 'info' | 'warn'; code: string; message: string }   // в т.ч. caps.suggest, prefill_*
  | { type: 'idle'; background: number } );
```

- **Авторитетность.** `text` и `reasoning` эфемерны, но за ними всегда следует авторитетное `done`, `stopped`, `failed` или `conflict` с полным сообщением. Поэтому события «полной замены текста» нет: окончательный текст, в том числе после хуков хоста, несёт `done{message}`.
- **Переподключение.** Проигрывания журнала в v1 нет. `session/open` возвращает снимок с версией, головой и открытыми ходами, затем идут живые события.
- **Склейка дельт.** Писатель JSONL склеивает `text`/`reasoning` в один кадр раз в 40 мс или по 768 символов. Любое другое событие сначала выталкивает накопленный текст.
- **Схема.** JSON Schema генерируется из `protocol/events.ts` и `commands.ts` и поставляется вместе с ядром. Протокол замораживается как версия 1 на M6. Клиенты обязаны игнорировать неизвестные типы событий.

### 12.3 One-shot (с M1)

```
rp-core send <session> "текст" [--kind reply|swipe|continue] [--json]
             [--provider script:<f>|record:<f>|replay:<f>] [--sandbox --seed <f>]
```

- **Вывод.** Без флагов печатается текст ответа. С `--json` — события ядра (`Event`), по одному на строку, без обёртки JSON-RPC.
- **По умолчанию** `onError:'keep'`.
- **Коды выхода:**

  | Код | Значение |
  |---|---|
  | 0 | done |
  | 2 | stopped |
  | 3 | failed |
  | 4 | conflict |
  | 5 | отказ до открытия хода |

  Коды намеренно совпадают с черновиком K4 из Kintsu. В one-shot код 4 практически недостижим: процесс держит lock сессии.
- **`--unlock-stdin`** не нужен: хранилища ключей нет.

### 12.4 REPL

Обычный построчный REPL: `node:readline` для редактирования и истории ввода (протокол он не читает), ANSI для стилей, без TUI-фреймворка.

```
$ rp-core new --card ~/cards/mira.png --model local:qwen3-14b
session s_4fa2 · Mira · narrator local:qwen3-14b (tools: prompted) · ctx 16384
Mira › *Дверь таверны скрипит, когда ты входишь с дождя…*
you  › Сажусь у стойки и спрашиваю про пропавший караван.
  ⋯ search_history "караван" → 2 hits
Mira › *Она ставит недочищенный бокал…*
  [1/1 · 386 tok · 7.9s · director: planned · memory: +2 за прошлый ответ]   /r swipe  /c continue  /e edit
```

Существующую сессию открывает `rp-core chat <session>`; `rp-core new` на терминале сразу открывает её чат.

**Вывод.**

- Рассуждения приглушены и свёрнуты (`/think show|hide`).
- Тулы и агенты — по одной приглушённой строке.
- `*действия*` — курсивом.
- Предупреждения (`notice`) — жёлтой строкой; каждое — один раз за сессию.

**Ввод.**

- Ctrl+C во время генерации останавливает ход с сохранением полученного, даже если что-то уже набрано; на приглашении Ctrl+C сначала стирает набранное, два Ctrl+C подряд на пустом приглашении — выход.
- Строку, набранную во время хода, REPL держит у себя и после `done`/`stopped`/`failed` отправляет через `submit` со свежей версией. Пока идёт ответ, вывод readline приглушён (эхо клавиш и перерисовки строки не попадают в ответ); недонабранный текст возвращается в приглашение после хода.
- Команды правки истории во время хода REPL отклоняет сам.
- При открытии сессии с отложенным (`held`) ответом REPL спрашивает «сохранить / отбросить».

**Команды:**

- **Ответы и история:** `/r` (свайп), `/[` `/]` (листать свайпы), `/regen <указание>`, `/c`, `/e [n]` (правка в `$EDITOR`), `/hide n`, `/rewind n`, `/tails`, `/goto <id>`, `/fork [n]`.
- **Модели и контекст:** `/model narrator|director|recorder|recall <conn:model>`, `/preset`, `/lore add|rm|test`, `/persona`, `/note <текст> [@depth]`.
- **Агенты:** `/director on|off|show`, `/memory [list|show|tree|new|add|edit|retire|restore|undo|refile|retry|recall|export|profile|mode]` (§7.4.9), `/search <q>`.
- **Отладка:** `/trace`, `/preview [--turn id]`, `/usage`, `/probe`.
- **Сессии:** `/sessions`, `/open`, `/help`.

Команды `/impersonate` в v1 нет, она появится вместе с `draft` (M9).

### 12.5 Bunraku, Kintsu, ACP

**Bunraku (M9).** Bunraku встраивает ядро как **библиотеку в процессе**, а не через `--stdio`.

Что даёт ядро:

- **API и хранение.**
  - Глаголы §6.1 с `expectedVersion`.
  - `fetch` и ключи передаются инъекцией на каждый запрос, провайдер собирается заново.
  - `consumerSignal`: ход продолжается после ухода UI.
  - Порт записей `RecordStore` (§5.12) с conformance-тестами. Bunraku сохраняет свой движок хранения (зашифрованный SQLite), но хранит в нём записи ядра.
- **Опции вызова:** `onError:'drop'`, `emptyReply:'keep'`, `fallback`, `inspect`.
- **Хуки хоста** (точки вызова есть в машине состояний с M1 и до M9 пустые):

```ts
interface HostHooks {
  beforeAssemble?(ctx: HookCtx): Promise<Placement[]>;      // планировщики хоста; параллельно с Директором и recall; не валят ход
  transformRequest?(req: { messages: PromptMsg[] }, ctx: HookCtx): Promise<{ edits: { index: number; text: string }[] }>;
  transformReply?(text: string, ctx: HookCtx): Promise<{ text: string; note?: string } | { veto: string }>;
}
```

- **`beforeAssemble`** возвращает размеченные вставки (§10.1). Его статус приходит событиями `agent`. Сбой хука — пустой результат и `notice`.
- **`transformRequest` и `transformReply` — fail-closed.**
  - При исключении, отмене или таймауте (таймаут задаёт хост; без него хук ждёт до Stop или ухода потребителя) ход получает `failed{code:'host_transform_failed', draft}`.
  - Непреобразованный запрос при этом не отправляется, непреобразованный ответ не коммитится.
  - `veto` даёт `failed{code:'host_veto', draft}`.
  - Что сделал хук, записывается в `trace.hooks`.
  - В `--stdio` эти хуки идут к клиенту как `gate/request{kind:'transform'}`.

Что остаётся на стороне Bunraku (в ядре этого не будет):

- выполнение regex — только в песочнице страницы (правило AGENTS 3), ядро получает лишь результат;
- промпты Final Cut и Smart Recovery — через `transformReply`;
- представления Compendium (Dashboard, досье, дерево, построенное моделью) — по данным `memory/list` и `memory/tree`; сам Compendium и его recall живут в ядре (§7.4);
- трекеры и их сверка при выборе свайпа;
- глобальные переменные;
- калибровка счётчика токенов;
- перевод сиблингов в `(message, position)`, событий ядра в `TurnEvent`, `Trace` ядра в трассу Bunraku (лист Tokens, история переменных).

Сознательные расхождения с Bunraku (каждое — решение):

- переменные коммитятся с ответом, а не до отправки [D-30];
- ответ из одних рассуждений по умолчанию — сбой; Bunraku передаёт `emptyReply:'keep'` [D-31];
- события полной замены текста нет, окончательный текст несёт `done`;
- состояние Директора и следы лора у ядра в своей форме, поэтому старые сцены требуют решения [D-27];
- форк несёт переменные, а дубль Bunraku начинается без них.

Адаптер пишется в репозитории Bunraku вместе с Chi (рев. 3). Внутри ядра нет моков в форме ChatStore.

**Kintsu.** Черновик Chi от 28.09.2026 (K4 не решён) предлагает Runner и Stage поверх `scene-turn.ts` Bunraku.

- **Общая поверхность ядра и Kintsu:**
  - коды выхода;
  - `--provider script:/record:/replay:`;
  - `--sandbox --seed`.
- **`--json` ядра — не `TurnEvent`.** Чтобы привести его к `TurnEvent`, нужен маппинг:
  - `start.messageId` в ядре всегда строка;
  - `text` в ядре несёт `offset` и не знает `full`;
  - `director` в ядре имеет статусы `reused`/`skipped` и `summary` вместо строк активности;
  - событий `regex`, `finalcut` и `world` в ядре нет.

Варианты решают Леви и Chi [D-14]:

- **(a)** Runner и Stage работают на rp-core после M9;
- **(b)** Kintsu выходит на `scene-turn`, а rp-core остаётся совместимым по кодам и флагам до миграции;
- **(c)** общей поверхности нет, и протоколов два.

Здесь ничего не проектируется в обход этого решения.

*Рев. 3, решение Леви от 25.10 [D-14]:*
1. Леви сейчас предупреждает Chi о rp-core и договаривается об общей поверхности: коды выхода, `--provider script:/record:/replay:`, `--sandbox --seed`.
2. Разговор о варианте (a) идёт позже, с демо M3–M4.

**ACP** — позже, отдельным пакетом на `@agentclientprotocol/sdk` (Apache-2.0). `session/prompt` отображается на `send` + `runTurn(reply)`; свайпов и правок в ACP нет.

---

## 13. Конфиг и секреты

```toml
# ~/.rp-core/config.toml — секретов здесь нет
[connections.local]
dialect = "openai-chat"
base_url = "http://127.0.0.1:8080"
max_in_flight = 1              # локально по умолчанию 1; 2 — только с -np 2 --no-kv-unified и id_slot (§7.4.7) [D-84]

[connections.openrouter]
dialect = "openai-chat"
base_url = "https://openrouter.ai/api"
key_env = "OPENROUTER_API_KEY"

[connections.anthropic]
dialect = "anthropic"
key_cmd = ["secret-tool", "lookup", "service", "rp-core", "conn", "anthropic"]
api_version = "2023-06-01"
cache_ttl = "1h"

[roles]                        # значения по умолчанию для новых сессий; сессия может переопределить
narrator = "local:qwen3-14b"
director = "narrator"          # ссылка: следует за /model narrator
recorder = "local:qwen3-14b"   # filing и historian
recall = "recorder"           # ссылка: следует за recorder [D-85]
narrator_fallback = ""         # пусто — без запасной модели

[narrator]
max_rounds = 4
prefill_vs_tools = "prefill"   # prefill | tools   [D-28]

[director]
enabled = false
profile = "auto"               # auto | full | lite
on_swipe = "reuse"             # reuse | replan    [D-29]
instructions = ""
style = "the-balanced"         # id личности [D-64]
creativity = "moderate"        # subtle | moderate | dramatic [D-64]

[compendium]                   # заменяет [memory]; §7.4.9
enabled = true
profile = "auto"               # auto | full | lite; auto — lite при окне агента < 24 576 [D-79]
language = ""                  # "" — язык истории
guidance = ""                  # ≤ 4 000; filing и historian; только сужает [D-66]
min_share = 0.4                # пол блока Compendium в доле лора
max_attempts = 3
idle_delay_sec = 8             # задержка фона на локальном origin [D-84]

[compendium.recall]
mode = "auto"                  # auto | sync | prefetch | lexical | off [D-78]
on_miss = "auto"               # auto (lexical локально, sync удалённо) | lexical | sync
max_entries = 0                # 0 — по профилю: full 10, lite 4
min_entries = 0
context_messages = 0           # 0 — по профилю: full 20, lite 6
grace_sec = 4
timeout_sec = 0                # 0 — 30 локально, 20 удалённо; от гранта
on_swipe = "reuse"             # reuse | rerun
guidance = ""                  # ≤ 8 000

[compendium.filing]
enabled = true
wait = 1                       # [D-23, D-86]
every_n = 1
allow = []                     # [] — все типы, кроме summary

[compendium.historian]
interval = 20                  # 0 — выключен
recap_after = 24               # [D-33]
overlap = 0                    # 0 — по профилю: full 10, lite 6

[compendium.books]             # "<книга>" = "read" | "off"; по умолчанию read [D-76]

[caps."local:qwen3-14b"]
tools = "native"               # оверрайд после того, как `rp-core probe` подтвердил

[prices."openrouter:anthropic/claude-sonnet-5-5"]
in_per_m = 2.0
out_per_m = 10.0
as_of = "2026-10-06"
```

Конфиг разбирается встроенным `Bun.TOML.parse`, без зависимостей. Значения из конфига попадают в `SessionConfig` новой сессии. Дальше они меняются записями `config`: через `/model`, `/director`, `session/configure`.

**Секреты [D-20].**

- **Откуда берутся.** Ключи берутся только из `key_env` или `key_cmd`.
  - `key_cmd` запускается через `Bun.spawn` без оболочки: `secret-tool` на Linux, `security` на macOS.
  - Результат живёт в памяти процесса.
  - Из argv ключи не принимаются.
  - Встраивающий хост передаёт свой `keys`.
- **Куда не попадают никогда:** файлы сессий, трассы, события, логи, `caps-cache.json`. Трасса знает только **имена** заголовков.
- **Текст ошибок провайдера** перед записью куда-либо сводится к `{category, code, status}` и фиксированному сообщению для кода: такой текст может цитировать промпт. Сырой текст выводится в stderr только при `--debug`.
- **Исходящие запросы** идут через замок на хост для каждого соединения (§8.8).
- **Хранилище ключей** с шифрованием или общее с Bunraku — позже, без смены форматов.

---

## 14. Тестирование

Всё работает на `bun:test`, без тестовых зависимостей.

**Провайдеры для тестов.**

- **`script:<file>`** — шаги в JSONL на каждый вызов: `{text}`, `{reasoning}`, `{tool:{name,args}}`, `{delay}`, `{error:{code,status,afterOutput}}`, `{usage}`, `{cut}`. Можно проверять хеш запроса.
- **`record:` / `replay:`** записывают нормализованную последовательность `StreamEv`, сырой SSE и хеш запроса; секреты вырезаются. Replay при несовпадении хеша **громко падает** и показывает дифф.
- Так CI проверяет цикл хода на реальном поведении провайдеров — без сети и без денег.

**Golden-фикстуры адаптеров.** Сырые SSE, записанные нами самими (`fixtures/sse/<dialect>/<case>.sse`), проверяются против ожидаемых `StreamEv[]` и проводных запросов.

- **Источники:** llama.cpp во всех форматах рассуждений, Ollama, LM Studio, koboldcpp, vLLM, OpenRouter, NanoGPT, DeepSeek, Anthropic, Gemini.
- **Вызовы тулов:** фрагментами и целиком, повторяющиеся имена, пропуски индексов.
- **Поток:** usage после finish, чанки ошибок посреди потока, обрыв.
- **Рассуждения:** варианты полей, `redacted_thinking`, подписи на пустых частях.
- **DeepSeek после `/model`:** прошлые ходы без его рассуждений → thinking выключен или тулы сняты, и приходит `notice`.
- **Mid-system у Anthropic:** блоки на глубинах 0–4 при чередующейся и нарушенной истории; слияние двух system на одной глубине.

**Golden-фикстуры сборщика.** Вход — карточка, пресет, лорбуки, путь, seed и часы; выход — снимки `{messages, trace}`.

- **Семантика ST** проверяется наблюдением вывода SillyBunny на тех же входах: глубины 0/1/≥count, позиции WI 0–7, порядок, «вероятность до бюджета», переопределения карточки, неизвестные макросы.
- **Префилл и тулы:** пресет с префиллом при включённых тулах → тулы сняты, префилл в запросе, `notice` один раз. При `prefillVsTools='tools'` → наоборот.
- **Пересказы:** новый пересказ не меняет запрос, пока граница обрезки не сдвинулась.
- **Русский (`fixtures/ru`):** формы слов в поиске, в ключах заметок, в селекторе Compendium и в склейке почти-дублей («Мира/Миру/Мирой»).
- **Паритет с RoleCall (рев. 3).**
  - Фикстуры `Bunraku/tools/rc-recorder` (11 случаев, закреплены на VAUDEVILLE 68afe385) портируются и дополняются нашими записями из VAUDEVILLE.
  - Паритет проверяется только там, где ядро сознательно не расходится с RoleCall: §12.5, [D-12], [D-16], [D-30].

**Журнал сессии.**

- Рваная последняя строка, невалидная строка в середине, фаззинг порченых строк.
- Свёртки Директора, Compendium и переменных под свайпом, откатом и форком; оверлеи и устаревание строк (§5.8).
- Бенчмарк полной свёртки на 10k сообщений: цель — меньше 50 мс.

**Крэш-тесты.**

- **Инъекция краша на каждом шаге жизненного цикла:** после `turn`, после `prep`, посреди `chk`, после `held`, во время задачи filing.
- **Сценарий `SIGKILL`:** CLI с медленным скриптовым провайдером убивается посреди ответа. После переоткрытия:
  - сообщение `interrupted` совпадает с префиксом из чекпоинта и несёт `dir` из `prep`;
  - **для свайпа** восстановленный ответ — сиблинг, а не ребёнок старого ответа;
  - для filing после resume — ровно одна действующая строка `mem` на ключ.
- **Парковка задач:** задача, которая падает трижды, паркуется и не ставится заново при открытии, пока не придёт `/memory retry`.

**Машина состояний.**

- Отказы до `turn`.
- `conflict` → `commitAnyway`/`discard` для reply, swipe и continue, включая «голова ушла → хвост» и «U скрыт → dropped».
- `held` остаётся открытым после рестарта.
- Вытеснение фонового запроса интерактивным на `maxInFlight = 1`, а на локальном origin — и при свободном месте; задержка фона после хода и её сброс свайпом [D-84].
- Хуки M9: `transform` fail-closed по таймауту и по исключению, `veto`; гейт `review` — ответ, cancel, Stop, уход потребителя.

**Протокол.**

- Порядок событий, склейка дельт, форма ошибок, коды выхода one-shot.
- Кадрирование: U+2028, CRLF, разорванный UTF-8, EOF без перевода строки, stdin закрыт посреди хода.
- Каждое событие проверяется по сгенерированной схеме.

**Агенты.**

- Читатель плана Директора, редьюсер, таблицы импульса, повторное использование плана на свайпе.
- Compendium: чтение filing на корпусе ответов слабых моделей, слияние, свёртка, свежесть, recall и полоса (§19.7); `lexScore`.
- `structuredCall` на корпусе испорченных ответов: атрибутная форма, незакрытый тег, fence, kwargs в стиле Python, DSML.

**Прочее.**

- **Детерминизм:** правило линтера против `Math.random`/`Date.now` в `src/`. Одинаковые seed, часы и replay дают побайтно одинаковые промпты.
- **Живые smoke-тесты** запускаются по желанию и проверяют только инварианты.
- **Conformance порта (M9):** `describeRecordStoreConformance` гоняется на файловой и на in-memory реализации. Его же может использовать адаптер Bunraku.

---

## 15. Вехи (рев. 4)

Каждая веха заканчивается демо, которое может запустить человек. Порядок — по умолчанию [D-8].

*Рев. 4: вехи пересчитаны по карте портирования (§19).* Порядок прежний, кроме одного изменения: M1 разделена на **M1a** и **M1b**. Причины две:
- на M1 приходится около 40 % всей работы (≈ 42–70 дней из ≈ 98–167), и почти всё это — новый код оболочки;
- самое рискованное — дерево, свёртку и восстановление — стоит доказать на скриптовом провайдере, до REPL и сети.

**Как считались оценки.** Для одного опытного разработчика с ИИ: сумма модулей вехи из §19 плюс связки. Размеры: S = 0,5–1 дня, M = 1,5–2,5 дня, L = 4–6 дней.

| Веха | Суть | Дней | Что дали источники |
|---|---|---|---|
| M1a | ядро хода на скриптовом провайдере | 25–42 | Немного: оболочка пишется с нуля. Из Bunraku — правила хода, склейка дельт, макросы, правила карточек |
| M1b | локальная RP в терминале | 17–28 | `sse` — port; адаптер openai-chat, http и бюджет — adapt из Bunraku и Kit. REPL и конфиг — новые |
| M2 | пресеты и лорбуки | 7–12,5 | **Короче.** Таймеры — port; движок лора и ключи — adapt. Переопределения карточки и `depth_prompt` ушли в M1a |
| M3 | тулы и поиск | 13–23 | **Короче.** Prompted-парсер — port; починка аргументов, протечки и поиск `/btw` — adapt |
| M4 | Story Director | 10,5–18 | **Меньше риска.** Импульс и личности — port; план, промпты, редьюсер и состояние — adapt; ≈ 760 строк тестов переносятся. Объём больше на 3,9 тыс. строк личностей |
| M5 | Compendium (рев. 6): M5a данные и ручной режим → M5b filing, historian и полоса → M5c recall и задержка | 32–52 | Типы, рендер, дерево, промпты и разбор filing, historian и recall, кодек — port/adapt из Bunraku; слияние и свежесть — из RoleCall. Новые: свёртка с оверлеями, полоса и расписание recall и фона, lite-профиль, замеры |
| M6 | `--stdio` | 3,5–6 | **Короче.** Кадрирование, склейка и типы событий готовы на M1a. Конверт JSON-RPC — adapt |
| M7 | нативный Anthropic | 2–4 | **Короче:** ≈ 65 % адаптера из Bunraku, размер L → M |
| M8 | нативный Gemini | 4–7 | Не короче: адаптер новый |
| M9 | стык с Bunraku | 5,5–9 | Немного: гейты — adapt. Порт записей и раннер хуков — новые |
| **Итого** | | **≈ 120–202** (рев. 5 — 113–192; рев. 4 без Compendium — 98–167) | ≈ 24–40 недель одного разработчика |

**Рантайм-зависимости.** На всей M1 (M1a и M1b) зависимостей по-прежнему ноль:
- PNG читается своим обходом чанков и встроенным в Bun `node:zlib`;
- TOML разбирается `Bun.TOML.parse`;
- токены оцениваются эвристикой.

`re2js` и `gpt-tokenizer` приходят на M2, `jsonrepair` — на M3.

---

**M1a. Ядро хода на скриптовом провайдере** · 25–42 дня

*Статус: **готово 26.10.2026**. 671 тест, проверка типов чистая, демо — `docs/M1A-DEMO.md`; открытые мелочи — в «Примечаниях к ревизии», п. 32.*

*Содержание.*
- **Журнал.**
  - Append, fsync/fdatasync, рваные строки, lock с продлением.
  - Чтение по LF через общий `protocol/jsonl.ts` [D-36].
  - Дерево, голова, хвосты, форк.
  - Свёртка: путь, hidden, правки, свайпы, vars.
- **Engine.**
  - `send`, `runTurn` (reply, swipe, continue), `stop`, resume. Отказы, включая `invalid_params` [D-38].
  - Дерево отмены, `prep`, чекпоинты.
  - Правило безусловного коммита при восстановлении.
  - Один повтор и запасная модель.
  - Пустые точки хуков.
  - Семафор на соединение [D-37].
  - `narrate` — скелет без тулов: один стрим, префилл, `empty_response`, abort.
- **Сборка.**
  - Нативные типы и встроенный пресет.
  - `assemble`: раскладка, слоты, переопределения карточки, `depth_prompt`, авторская заметка.
  - `depth.ts` по ST.
  - `shape` — минимум: префилл и хвост continue по `caps.prefill`.
  - **Весь** набор макросов §10.4, включая переменные [D-42, D-43].
  - `rng` [D-44].
  - Оценка токенов по символам.
  - Запись возможностей — фиксированная, от скриптового провайдера.
- **Импорт.**
  - CCv2/V3: JSON и PNG (tEXt, iTXt, zTXt).
  - Маппер `character_book` с единым `stPosition()`.
  - `rp-core import` для карточек [D-72].
- **Протокол и CLI.**
  - События и склейка дельт [D-36].
  - `rp-core new|send|sessions`, one-shot `send [--json]`, сигналы.
  - Скриптовый провайдер с шагом `{pause}` [D-40].
  - Test preload с `RP_CORE_HOME` во временном каталоге.

*Источники (port/adapt).*
- Bunraku:
  - правила хода из `scene-turn.ts` и `scene-turn-resume.ts`;
  - `continuation.ts`, `coalesceTurnEvents`, `readLines`, `injectAtDepth`;
  - лексер и вычислитель макросов, `mulberry32`, `canonicalId`;
  - правила карточек: `detectCard`, приоритет ccv3, `tavern-fields`, `character-book-decode`.
- RoleCall: `import/png-parser.ts`, `streaming/stream-delta.ts`.

*Новое.* entries, log, tree, fold, fork, engine, abort, sched, assemble (Bunraku — образец), native, CLI, скриптовый провайдер.

*Демо.*
- `rp-core new --card mira.png`, затем `rp-core send <сессия> "…" --json --provider script:…` печатает события хода.
- `--kind swipe` даёт сиблинга, `--kind continue` — продолжение.
- `kill -9` посреди медленного скрипта → при следующем открытии приходит `recovered`, а ответ виден как `[interrupted]` с частичным текстом. У свайпа восстановленный ответ — сиблинг, а не ребёнок.
- CI гоняет то же самое.

---

**M1b. Локальная RP в терминале** · 17–28 дней

*Статус: **готово 26.10.2026**. 1468 тестов, проверка типов чистая, живое демо на Ollama (Mag-Mell 12B) — `docs/M1B-DEMO.md`; заметки — «Примечания к ревизии», п. 35–37.*

*Содержание.*
- **Адаптер openai-chat.**
  - Стрим, поля рассуждений, сплиттер think-тегов, usage, включая `timings`.
  - Разбор вызовов тулов и события тулов приходят сразу вместе с портом. К циклу они подключаются на M3.
- **Транспорт.**
  - `http.ts`: замок на хост, таймауты первого байта и простоя, таблица статусов. Здесь же проверяется поведение Bun fetch на длинных паузах.
  - `sse.ts`, `wire.ts` [D-52], аварийный люк соединения [D-53].
- **Возможности и пробы.**
  - `caps.ts` и `hosts/models.json` для локальных бэкендов и роутеров [D-54].
  - Каталожная половина `probe`: `/models`, `/props`, `/api/show`, OpenRouter `supported_parameters`.
- **Shape и бюджет.**
  - `shape`: post-processing ST [D-48], подсказка continue для моделей без assistant-хвоста, строгое чередование, mid-system в режиме as-user.
  - Бюджет кусками по 8 [D-49], EMA [D-50].
- **Конфиг и секреты.** `config.toml`, `key_env` и `key_cmd` [D-73].
- **REPL и вывод.**
  - Свайп, continue, правка, hide, rewind, `/tails`, `/goto`, `/fork`, `/model`, свайп приветствий.
  - Ctrl+C и удержание набранной строки.
  - Вырезание протёкшей разметки тулов в постобработке [D-57].

*Источники (port/adapt).*
- Bunraku `stage/provider`:
  - половины запроса и ответа openai-compatible;
  - сплиттер строк, post-processing;
  - `validateToolProtocol`, `request-overrides`.
- Kit: `guardedFetch` и лестница `/models`.
- Bunraku: `core/stream-bytes.ts`, `tokens/trim.ts`, `budget-app.ts`, `stripToolCallLeaks`.
- Факты RoleCall (`definitions.ts`, `adapters/openai.ts`, `reasoning-effort.ts`) — как данные, с атрибуцией SillyTavern.

*Новое.* `reasoning-tags.ts`, резолвер возможностей, REPL, render, config, secrets.

*Демо.*
- `rp-core new --card mira.png --model local:qwen3-14b` на llama.cpp: потоковая RP. Свайп, continue, правка, откат и Ctrl+C работают.
- `kill -9` посреди ответа → при открытии `[interrupted]` с частичным текстом.
- `/model` переключает на OpenRouter посреди сессии.

---

**M2. Пресеты и лорбуки** · 7–12,5 дня, *короче*

*Содержание.*
- **Импорт.**
  - ST chat-completion пресеты:
    - закон `prompt_order` 100001;
    - маркеры превращаются в слот-макросы;
    - `Preset.formats` [D-70];
    - выключенные маркеры — по ST [D-71].
  - ST world info файлами, `/lore add <файл>`.
- **Движок лора.**
  - Ключи через re2js с литеральным фолбэком и Unicode-границей слова.
  - Вторичные ключи, рекурсия, группы на seed.
  - Сначала вероятность, потом бюджет.
  - Позиции и глубина.
  - Таймеры с пути, `fires` в свёртке.
- **Сборка и токены.** Слоты лора в сборке. `gpt-tokenizer` плюс EMA.
- **Отладка.** `/trace`, `/preview`, `/lore test` — вердикты пересчитываются [D-45].
- **Провайдеры record/replay.**
- **Фикстуры.** rc-recorder 01–11 со списком отклонений, golden-снимки SillyBunny.

*Источники (port/adapt).*
- Bunraku:
  - `core/lore/engine`: engine, recursion, groups, budget, scan, timers, key-word-boundary;
  - `st-preset-wire.ts`, `fillSlots`, `sillytavern/lorebook.ts`.
- RoleCall: `lorebook/triggers/keyword.ts` (re2js) и `parseRegexFromString`.

*Новое.* Немного: связка record/replay и golden-снимки SillyBunny.

*Опционально.* Импорт `.vnpack` (S, ≈ 200 строк, без зависимостей) — если ответ на вопрос 10 будет «нужен рано».

*Демо.*
- Импорт пресета и world book из ST.
- `/trace` показывает, что сработало и почему; `/lore test` выдаёт вердикты без запуска хода.
- `/preview` печатает точный запрос.

---

**M3. Тулы и поиск** · 13–23 дня, *короче*

*Содержание.*
- **Цикл.**
  - Раунды тулов в `narrate`, транспорты native и prompted.
  - Финальный раунд с `finalCue`.
  - Правило «префилл или тулы».
- **Аргументы и протечки.**
  - Цепочка аргументов [D-56].
  - Протечки превращаются в вызовы.
- **Четыре read-only тула.**
  - Страницы `read_history` — по D-58.
  - Хэндлы записей — по D-59.
- **Поиск.** `normalizeTerm` [D-46] и `lexScore`.
- **Провайдеры.**
  - Активные пробы `rp-core probe`: тулы только с `auto`, стрим, `json_schema`.
  - Эхо рассуждений DeepSeek.
- **Ручные заметки Compendium** (§5.8) — без вызовов модели:
  - свёртка `mem` и `applyMemOp`;
  - `/memory list|show|add|retire` для заметок с `on:null`;
  - книга заметок с `match:'stem'` в движке лора.

*Источники (port/adapt).*
- Bunraku: `tool-loop.ts`; из Kit — `stop-core.ts` и `scheduler.ts`.
- RoleCall:
  - `prompted-tool-calls` целиком;
  - часть `tool-call-repair`;
  - DSML, `content-tool-salvage`;
  - поиск `/btw`: `scene-search.ts`, `read-scene-messages.ts`.
- Bunraku: `dramaturg-tools.ts` (код Леви), слияние из `filing-stage.ts` и `merge.ts`.

*Новое.* `normalize`, `lexscore`, парсеры `[TOOL_REQUEST]`, `[TOOL_CALLS]` и `<function=…>`, активные пробы.

*Демо.*
- На 200-м сообщении спросить: «как, по словам трактирщицы, звали её брата?» Локальная модель в prompted-режиме ищет «брат», находит «братом» и отвечает верно.
- Заметка из `/memory add` с ключом «брат» срабатывает на «брата».

---

**M4. Story Director** · 10,5–18 дней, *меньше риска*

*M4a — чистое ядро Директора*, 6–11 дней.
- **Состав:** state, plan (с lite-схемой), reduce, momentum, render, prompt (с новым lite-промптом), личности и ≈ 760 строк портированных тестов.
- **Кто и когда.** Можно отдать второму разработчику и делать параллельно с M2–M3. Лучше всего подходят Chi или Nemo — авторы этого кода в Bunraku.
- **Зависимости.** `normalizeTerm` со стоп-словами [D-46] и `jsonrepair` (для `plan.ts`). Если M4a идёт параллельно с M2, `jsonrepair` приходит на M2, а `text/normalize.ts` делается первым шагом M4a.

*M4b — живой Директор*, 4–7 дней.
- `structuredCall` [D-60]: tagged везде, structured — для openai-chat после пробы M3.
- `call.ts`.
- Директива на глубине 1, контракт — в блоке ядра [D-65].
- `DirectorRecord` пишется в `prep` и в строку ответа [D-61].
- Повторное использование плана на свайпе.
- Таймаут по соединению.
- `/director show`.
- `rp-core compact` [D-35].
- Черновик чтения ответа filing (§7.4.3) — чтобы `structuredCall` проектировался сразу под две схемы.

*Источники (port/adapt).*
- Bunraku:
  - `core/director`: momentum, plan-schema, plan-round, apply, prompts, user-prompt, self-audit, history, bounds, state, personalities;
  - скелет `planTurn` из `scene-director-call.ts`;
  - `core/assembly/director.ts`.
- RoleCall: поиск спанов тега из `prompted-tool-calls`, формула возраста из `seed-aging.ts`.

*Новое.* Lite-профиль, повторное использование плана на свайпе, ветка structured, `checkState`.

*Демо.*
- После 30 ходов `/director show` показывает главы, арки со следующим битом, семена и скрытые арки.
- Свайп повторно использует план, а `/regen <указание>` планирует заново.
- Откат возвращает прежнее состояние.
- Испорченный план на маленькой модели даёт `director: failed (undecodable)`, а ответ всё равно приходит.
- Скриптовый прогон на 300 ходов держит снимок под потолком [D-61].

---

**M5. Compendium** · 32–52 дня (рев. 6; рев. 5 — 25–42)

*Рев. 6.* Compendium целиком [D-26] по проекту §5.8 и §7.4. Веха делится на три подвехи, у каждой своё демо.

**Как считалось.** Сумма модулей §19.7 (29,5–48,5 дня) плюс M5-доли §19.2: `engine/lane.ts` целиком и половина `engine/sched.ts`, ≈ 2,5–4 дня.

**Почему дольше оценки рев. 5.** Та считала только сам порт. Не были посчитаны:
- свёртка с оверлеями библиотечных книг;
- расписание recall и фона для локальных бэкендов;
- lite-профиль и терпимое чтение;
- кодек `compendium-v1.0.0`;
- замеры задержки.

**Зависимости.**
- **M5a** идёт после M3 (`normalizeTerm`, `lexScore`, свёртка заметок) и M2 (движок лора, `trace.trimmed`). Её можно отдать второму разработчику и вести параллельно с M4, как M4a. Лучше всего подходит Chi — автор этого кода в Bunraku. Демо снимка мира и места блока относительно директивы ждут M4.
- **M5b** — после M4b (`structuredCall`).
- **M5c** — после M5a и M5b.

*M5a — данные и ручной Compendium*, 11–19 дней.

*Содержание.*
- **Данные:**
  - 11 типов и SPEC; рендер, полный и краткий;
  - слияние [D-81] и `applyMemOp`;
  - свёртка `compendiumAt` с устареванием и «новейшим действием по ключу» [D-74];
  - оверлеи библиотечных записей [D-75];
  - производное дерево.
- **Активация без модели:**
  - селектор — упоминание в U и в последних 4 сообщениях;
  - свежесть [D-80];
  - блок `[Retrieved World Knowledge]` на глубине 1 с полом в доле лора [D-77];
  - типизированные записи книг уходят из движка лора [D-76].
- **Снимок мира** `worldSnapshot(view, budget)` для Директора (§7.4.5).
- **Ручное управление:** `/memory new|show|tree|edit|retire|restore|list`; `search_lore` и `read_lore` по Compendium с хэндлами `C<n>`.
- **Импорт и экспорт:** кодек `compendium-v1.0.0`, который распознают `rp-core import` и `/lore add` [D-72]; `/memory export --format core|compendium`.

*Источники (port/adapt).*
- Bunraku `src/core/compendium`: `types`, `entry-types`, `read`, `render`, `merge`, `snapshot` (`findMatch`), `filing-stage` (сценарии), `tree`, `relationships` (`normalizeName`).
- Bunraku: `core/assembly/recall-place.ts`, `core/director/compendium-snapshot.ts`, `formats/rolecall/compendium.ts`.
- RoleCall: из `dm-stream/tools/compendium-definitions.ts` — `ARRAY_KEY_FNS`, почти-дубли и `mergeStructuredData`; `tv-stream/compendium-freshness.ts`.

*Новое.* Свёртка с оверлеями и устареванием, краткий рендер, селектор, маршрутизация записей книг.

*Демо.*
- `rp-core import lantern.compendium.json` (экспорт RoleCall), затем `/lore add lantern`: `/memory tree` показывает Cast, Places, Narrative… из производного дерева.
- `/memory new character Мира` в `$EDITOR`. Сообщение «…отдай это Миру…» → `/preview` показывает её краткую запись в блоке `[Retrieved World Knowledge]` на глубине 1 (с M4 — над директивой).
- `/memory edit` записи из библиотечной книги: файл книги не меняется, а `/memory show` показывает оверлей.
- Свайп и откат не трогают правки человека; форк сохраняет ключи записей.
- `/memory export lantern2 --format compendium`, затем повторный импорт — те же записи.
- С включённым Директором (M4) `--keep-requests` показывает в его запросе `[COMPENDIUM CONTEXT]` с Мирой.

*M5b — filing, historian и фоновая полоса*, 13–20 дней.

*Содержание.*
- **Полоса** (`engine/lane.ts`, §19.2 и §19.7): задачи `prerecall`, `file` и `hist`; порядок; ключи; покрытие по диапазонам, отменённые проходы покрыты; парковка; голодание; восстановление [D-86].
- **`sched`:** приоритеты interactive и background, вытеснение [D-37]; семафор по origin, правило локального origin и задержка фона `idleDelaySec` [D-84].
- **Filing** [D-82, D-86]:
  - промпт full дословно с тремя правками и промпт lite;
  - снимок и ростер;
  - терпимое чтение;
  - постановка в дельты;
  - `wait` и `everyN` с делением бюджета user.
- **Historian** [D-83]:
  - два триггера, проверка при каждом принятии ответа;
  - окно по позициям пути, диапазоны — id пути;
  - сюжеты и обзоры `[Arc]`;
  - слот `{{recap}}` с обзорами и стабильной `trace.recap`.
- **Ручное:** `/memory undo|refile|retry`.
- **`structuredCall`:** агенты `filing` и `historian`, `tag: null`.
- События `agent` и `memory`.

*Источники (port/adapt).*
- Bunraku: `filing-prompt`, `filing-schema`, `filing-stage`, `snapshot`, `historian`; `studio/compendium-filing`, `compendium-historian`, `compendium-recap-write`, `compendium-ask`. Сценарии — `compendium-hooks` и `compendium-queue`.
- RoleCall: `summary-watermark.ts`, `postgen-write-delay.ts`, правило памяти из `compendium-definitions.ts`.

*Новое.* Полоса с ключами и покрытием, приоритетный семафор по origin с задержкой фона, lite-промпты, терпимое чтение.

*Демо.*
- 300 сообщений на локальной qwen3-14b, llama.cpp `-c 16384 -np 1`. Compendium заполняется в фоне, `send` не ждёт filing, вытесненный проход возвращается в очередь без попытки.
- Свайп в первые секунды после ответа не будит фон (`idleDelaySec`), и `/trace` показывает тёплый KV рассказчика.
- Свайп ответа убирает его записи. Правка старого ответа делает его проход устаревшим, и полоса записывает его заново.
- `/memory undo <msg>` забирает проход, и полоса его не повторяет; `/memory refile <msg>` пишет его снова.
- Когда начинается обрезка, в `{{recap}}` появляются обзор `[Arc]` и пересказы. Слот не меняется, пока не сдвинется граница.
- `kill -9` во время filing → после открытия ровно одна действующая строка на ключ.

*M5c — recall и задержка*, 8–13 дней.

*Содержание.*
- **Recall** [D-78]:
  - индекс: дерево Bunraku в full, лексический шорт-лист в lite;
  - промпты и терпимое чтение;
  - режимы `auto|sync|prefetch|lexical|off`;
  - ожидание prefetch в полёте, Stop без потери prefetch, дедлайн от гранта, лексический откат;
  - `RecallRecord` в `prep` и коммите; повтор на свайпе и continue.
- **Профили** full и lite [D-79]; проверка запроса рассказчика на малом окне [D-89].
- **Проба слотов** `GET /slots` → `notice{slots_detected}`; закрепление `id_slot` при `max_in_flight = 2` с проверкой по `/slots` [D-84]; документация пресетов бэкендов.
- **Замеры:** `rp-core bench ttft`.

*Источники (port/adapt).*
- Bunraku: `recall-index`, `recall-prompt`, `recall-parse`, `studio/compendium-recall.ts`; порядок вызовов — из `studio/scene-turn.ts:175-183`.
- RoleCall — уроки `pregen-retrieval.ts`: скрытые рассуждения съедают бюджет вывода; причины селектора не идут в промпт рассказчика.

*Новое.* Prefetch с ожиданием, шорт-лист, профили, проба слотов и закрепление, стенд замеров.

*Демо.*
- llama.cpp `-c 16384 -np 1`, qwen3-14b, Директор lite, скриптовый прогон на 60 ходов с паузой 30 с. `/trace` показывает `recall: prefetch`; recall не добавляет вызовов до первого токена в ≥ 90 % ходов.
- Свайп: `recall: reused, 0 calls`. Искусственный таймаут recall: `fallback (lexical)`, а ответ приходит.
- На 300-м сообщении рассказчик вспоминает предательство ~200 сообщений назад — через пересказ, выпавший из слота, или через память персонажа.
- На OpenRouter (full) лог вызовов показывает Директора и recall одновременно.
- `rp-core bench ttft` печатает матрицу; повторная обработка промпта рассказчика считается по `timings.prompt_n`:
  - llama.cpp `-np 1` с `--cache-ram` и с `--cache-ram 0`, `-np 2 --no-kv-unified` с `id_slot` — на модели с полным вниманием и на SWA- или гибридной;
  - koboldcpp с `--smartcache` и без;
  - Ollama с `NUM_PARALLEL` 1 и 2.

*Критерии приёмки M5c.*
- Выбор prefetch не хуже, чем согласованность модели с самой собой. На ≥ 60 ходах скриптового прогона доля записей синхронного выбора, попавших в итоговый блок с prefetch (ярусы 0–2), не ниже 0,8 × той же доли между двумя синхронными прогонами с разным seed. Если ниже, `auto` переключается на `sync`, и это записывается решением.
- С `--cache-ram` или с `-np 2` и `id_slot` повторная обработка промпта рассказчика ≤ 1,5 × нового хвоста.

*Если затянется:* M5a и M5b дают память без модельного recall — режим `lexical` работает без вызовов. M5c тогда становится отдельной вехой после M6.

---

**M6. `--stdio`** · 3,5–6 дней, *короче*

*Содержание.*
- Команды с валидаторами (`invalid_params` [D-38]).
- JSON-RPC с конкурентной диспетчеризацией: `turn/stop` и `commitAnyway` работают во время хода.
- Протокол 1.
- Снимок при открытии.
- `conflict` / `held` / `commitAnyway` / `discard`.
- Генерируемая схема.
- `consumerSignal`.

Кадрирование, склейка и типы событий есть уже с M1a.

*Источники (port/adapt).* Конверт JSON-RPC из Bunraku `mcp/protocol.ts` (≈ 60 строк) и кейсы из `mcp/server.test.ts`.

*Новое.* `commands.ts` и цикл обслуживания. Он не строится ни на `node:readline`, ни на глобальной очереди Bunraku.

*Демо.*
- Скрипт-клиент из ~40 строк ведёт сессию.
- Во время хода он правит старое сообщение → `conflict` → `turn/commitAnyway`.
- `kill -9` сервера → `session/open` показывает восстановленный ход.

---

**M7. Нативный Anthropic** · 2–4 дня, *короче: L → M*

*Содержание.*
- Правило размещения поздних system (§8.5).
- Кэш-метки по `cacheMinTokens` [D-54].
- Thinking по записи возможностей; `disabled` не отправляется на моделях, которые его отвергают.
- Семплеры.
- Structured output через `output_config.format`.
- Политика повтора рассуждений.
- Строки Claude в `models.json`.

*Источники (port/adapt).* Bunraku `anthropic-request.ts` и `anthropic-reply.ts`; минимумы кэша из `core/tokens/cache.ts` — как данные.

*Новое.*
- Обёртка `[System note]`.
- Исправления дефектов Bunraku: thinking `disabled`, безусловная `temperature`, replay рассуждений между ходами.

*Порядок.* Если Claude — основная модель рассказчика или Директора, M7 можно поставить сразу после M3: порт сделал её дешёвой. По умолчанию порядок не меняется.

*Демо.*
- Та же сессия переключается командой `/model narrator anthropic:claude-sonnet-5-5`.
- Ни одного 400 из-за префилла, thinking, forced tools или mid-system.
- Попадания в кэш видны в `/usage`.

---

**M8. Нативный Gemini** · 4–7 дней

*Содержание.* Новый адаптер вокруг replay `gemini-parts`:
- подписи, в том числе на пустых частях;
- настоящие `functionCall.id`;
- ключ в заголовке;
- safety OFF;
- санитайзер схем;
- thinking level или budget;
- строки Gemini в данных;
- `responseSchema` для `structuredCall`.

*Источники (port/adapt).* Из RoleCall — только санитайзер схем (37 строк, с исправлением nullable) и список safety OFF.

*Условие.* Нужны аккаунт Gemini 3 и режим record: записанных фикстур нет ни в одном репозитории.

*Демо.*
- Трёхраундовый цикл тулов на Gemini 3 без ошибок подписи.
- Блокировка safety приходит как `content_filter`.

---

**M9. Стык с Bunraku** · 5,5–9 дней

*Содержание.*
- **Хранение:** порт `RecordStore`, conformance, in-memory реализация.
- **Хуки хоста:** `beforeAssemble`, `transformRequest`, `transformReply`.
- **Гейты:** `review` и `transform`, `answerGate` [D-39], `gate/request`.
- **Разовые генерации:** `draft` (`impersonate`, `quiet`) и `/impersonate`.
- `emptyReply`.
- Экспорт `rp-core/testing`.

*Источники (port/adapt).* `turnGate` и `applyEdits` из Bunraku; паттерн `chatStoreContract(label, make)`.

*Новое.*
- `RecordStore`.
- Раннер хуков с fail-closed.
- `draft`: оценщики его не оценивали, ориентир — 1–2 дня.

*Демо.*
- In-memory хранилище, написанное по спецификации порта, проходит тот же conformance, что и файловое.
- Скриптовый хост выполняет `transform`-гейт. При таймауте ход падает с `host_transform_failed` и не отправляет непреобразованный запрос.
- Настоящая интеграция — после согласия Chi.

---

**Что сдвинулось по сравнению с ревизией 3.**

- **В M1a:**
  - `jsonl.ts`, `coalesce.ts` и типы событий [D-36];
  - переопределения карточки, `depth_prompt` и авторская заметка (были на M2);
  - весь набор макросов вместо подмножества;
  - маппер ST WI и `stPosition()`: каст с `character_book` замораживается при создании сессии.
- **В M1b:**
  - разбор вызовов тулов в адаптере — без второго прохода по парсеру на M3;
  - вырезание протечек [D-57];
  - каталожная половина `probe`.
- **В M3:** ручные заметки Compendium — свёртка `note`/`edit`/`retire`/`restore`, `/memory add|list|show|retire` (§5.8).
- **В M4:** `rp-core compact` [D-35] и черновик чтения ответа filing.
- **В M5:** приоритеты и вытеснение `sched` [D-37]; семафор по origin и задержка фона, закрепление `id_slot` на M5c [D-84].

**Цена порядка** — та же, что в ревизии 2:
- до M6 UI подключается только как библиотека или через one-shot `send --json`;
- до M7 Claude доступен только через OpenRouter: без нативных mid-system, без контроля thinking и с ограниченным управлением кэшем.

**Позже, без срока:**

- MCP с протоколом подтверждений, ACP;
- эмбеддинги за портом, Lookback;
- групповой чат, именованные ветки;
- импорт `.vnpack` (если его не возьмут на M2), чатов RoleCall и ST;
- экспорт карточек, пресетов и лорбуков из `extras`;
- режим review для памяти;
- правки Директора человеком: `dirEdit`, образец — `edits.ts` Bunraku;
- Character Minds (Plan C) — отдельным агентом на `structuredCall`;
- части Compendium вне v1: reconcile, diagnostics, ingest, standardize, smart context (§7.4.10);
- адаптер OpenAI Responses, regex-скрипты в CLI;
- хранилище ключей, steering, `roll`, прогрев префикса llama.cpp (после замеров M5c).

---

## 16. Решения

Пометка «(техн.)» — техническое решение, которое Леви может подтвердить пакетом (вопрос 12 в §18).

| ID | Решение | Рекомендация | Альтернативы | Статус |
|---|---|---|---|---|
| A-1 | Язык и рантайм | TypeScript на Bun, новый автономный headless-core | — | принято пользователем |
| A-2 | Режимы | REPL для человека + `--stdio` JSONL для любого UI | — | принято пользователем |
| A-3 | Порядок провайдеров | OpenAI-совместимый → нативный Anthropic → нативный Google; три семейства — всё поле | — | принято пользователем |
| A-4 | Направление зависимостей | UI → core; core ничего не импортирует из Bunraku и RoleCall | — | принято пользователем |
| A-5 | Происхождение кода (рев. 3) | RoleCall — всё, что работает, включая Директора, Compendium и Plan C; Bunraku — по ситуации. Порт, а не импорт; копирайты сохраняются, всё учитывается в `PROVENANCE.md` (§2) | — | принято пользователем 25.10 |
| A-6 | Цель | порт RP-агента RoleCall в CLI, сознательно простой; в перспективе — замена движка Scenes в Bunraku | — | принято пользователем |
| A-7 | Зависимости | совместимые с AGPL-3.0 (jsonrepair, re2js, gpt-tokenizer; позже ACP/MCP SDK) | — | принято пользователем (рев. 3: «пермиссивные» заменено на «совместимые с AGPL») |
| D-1 | Режим рассказчика | гибрид: Директор и recall до ответа, filing и historian после — фиксированно, read-only тулы — по требованию | чистый агентский цикл; конвейер без тулов | принято пользователем 26.10 |
| D-2 | Поиск по истории | ключевые слова с нормализацией и лёгким стеммингом кириллицы; только активный путь; эмбеддинги — позже за портом | эмбеддинги сразу; гибрид; буквальные подстроки без стемминга | принято пользователем 26.10 |
| D-3 | Подтверждение записей памяти | не нужно: применяются сразу, привязаны к пути, `/memory retire`; review — позже | review каждой записи; review только для update/retire | принято пользователем 26.10 |
| D-4 | Агенты кроме Директора | агенты Compendium: recall, filing, historian (рев. 6); остальное позже на тех же механизмах | + трекеры; + Character Minds; + выбор лора моделью | принято пользователем 26.10 |
| D-5 | Тулы v1 | `search_history`, `read_history`, `search_lore`, `read_lore`; рассказчик не пишет | + `roll`; + пишущие тулы с подтверждением; MCP в v1 | принято пользователем 26.10 |
| D-6 | Форматы импорта v1 | CCv2/V3 (JSON/PNG), ST-пресеты, ST world info; потом `.vnpack`, RoleCall, Marinara | `.vnpack` в v1; RoleCall первым | принято пользователем 26.10 |
| D-7 | Активация лора | ключи с семантикой ST, re2js, вероятность → бюджет, `scanDepth` 2; у заметок Compendium — сравнение по основам; выбор записей моделью — только recall внутри Compendium [D-76]; без векторов | выбор записей моделью; векторы | принято пользователем 26.10 |
| D-8 | Порядок вех | (рев. 4) M1a ядро хода на скриптовом провайдере → M1b локальная RP → M2 лор → M3 тулы → M4 Директор → M5 память → M6 `--stdio` → M7 Anthropic → M8 Gemini → M9 Bunraku | Anthropic до агентов; `--stdio` на M3 как нестабильный протокол 0 | принято пользователем 26.10 |
| D-9 | Импорт старых чатов | позже: ST JSONL (свайпы → сиблинги); RoleCall — только через клиентский экспорт (E2E-шифрование) | ST-импорт на M2 | принято пользователем 26.10 |
| D-10 | Групповой чат | позже; поле `speaker` зарезервировано | v1 с ротацией говорящих | принято пользователем 26.10 |
| D-11 | Лицензия ядра | AGPL-3.0-or-later | Apache-2.0; MIT; MPL-2.0 | принято пользователем 25.10 |
| D-12 | Конвенция глубины | ST: d = число сообщений после блока; импорт RoleCall +1 | конвенция RoleCall | принято пользователем 26.10 |
| D-13 | Хранение | один открытый JSONL-файл-дерево на сессию, одна голова, форки — новые файлы, lock, без шифрования в v1; Bunraku хранит записи ядра в своём SQLite через порт | SQLite-журнал; шифрованные файлы; именованные ветки внутри файла | принято пользователем 26.10 |
| D-14 | Kintsu | сначала предупредить Chi и договориться об общей поверхности (коды выхода, флаги провайдеров, sandbox; события — через маппинг); разговор о переезде (a) — с демо M3–M4 | сразу предлагать (a); вариант (b); независимые проекты (c) | принято пользователем 25.10 |
| D-15 | Транспорт тулов (техн.) | по записи возможностей; неизвестная модель → prompted; без молчаливого переключения; только `caps.suggest` | native по умолчанию; авто-переключение | принято пользователем 26.10 |
| D-16 | Текст и тулы в ответе | текст раундов накапливается; блоки тулов хранятся в сообщении, в последующие промпты не идут | «только последний раунд» (RoleCall); тулы только в трассе (Bunraku) | принято пользователем 26.10 |
| D-17 | Сбой Директора | в этом ходу директивы нет; счётчик идёт; код причины | повтор прошлой директивы с пометкой (RoleCall) | принято пользователем 25.10 (вместе с D-62) |
| D-18 | Повтор рассуждений (техн.) | только внутри цикла тулов, из памяти; между ходами отбрасывать; бета `drop_block` не отправлять | всегда повторять; бета `drop_block` по умолчанию | принято пользователем 26.10 |
| D-19 | Свои адаптеры (техн.) | да, без зависимостей; pi-ai — как чек-лист | зависеть от pi-ai; Vercel AI SDK | принято пользователем 26.10 |
| D-20 | Секреты | `key_env` / `key_cmd`, хранилища ключей нет | зашифрованный файл; хранилище Bunraku | принято пользователем 26.10 |
| D-21 | Переопределения карточки | семантика ST (`override`, `{{original}}`, `forbidOverrides`) | только макросы (RoleCall/Bunraku) | принято пользователем 26.10 |
| D-22 | Частичный текст при сбое | движок и `--stdio`: сбросить, черновик в событии (как Bunraku); REPL и one-shot: сохранить как `interrupted` | всегда сохранять; всегда сбрасывать | принято пользователем 26.10 |
| D-23 | Когда пишет filing | после того как ответ принят (`compendium.filing.wait = 1` [D-86]), фоновый приоритет с вытеснением | сразу (`lag = 0`); блокировать следующий ход | принято пользователем 26.10 |
| D-24 | Lookback | отложить на после v1 | опциональный проход в v1 для моделей без тулов | принято пользователем 26.10 |
| D-25 | Параллельность ходов (техн.) | один ход на сессию; параллельно — разные сессии и форки; правка во время хода → `conflict` | один ход на именованную ветку внутри файла | принято пользователем 26.10 |
| D-26 | Память и Compendium (рев. 5) | **Compendium целиком в ядре**; хранение — строки `mem` с типизированными `data` на пути (§5.8, §7.4, рев. 6) | Хроника (рекомендация рев. 4); Хроника с типами | принято пользователем 25.10 (вопрос 13) |
| D-27 | Существующие сцены Bunraku при переходе на ядро | перевести один раз: сообщения, свайпы, правки, скрытые, дубли → форки, переменные → `vars0`; состояние Директора, таймеры лора и старые трассы начинаются заново | адаптер переводит и Директора, и следы лора (работа Chi, с потерями); старые сцены остаются на движке Bunraku | по умолчанию, ждёт подтверждения |
| D-28 | Префилл пресета и тулы | при префилле тулы рассказчика в этом ходу выключены, `notice` раз за сессию | наоборот: тулы, префилл пропускается; сливать префилл с первым раундом (не проверено на серверах) | принято пользователем 26.10 |
| D-29 | Директор на свайпе | повторно использовать план заменяемого ответа; планировать заново при сбое прошлого плана и на guided re-roll | планировать на каждом свайпе | принято пользователем 26.10 |
| D-30 | Время записи переменных | дифф коммитится с ответом; незакоммиченный ход переменных не меняет | как Bunraku/RoleCall: писать до отправки, при неудаче откатывать частично | принято пользователем 26.10 |
| D-31 | Ответ из одних рассуждений | по умолчанию сбой `reasoning_only` с черновиком; опция `emptyReply:'keep'` (для Bunraku) | всегда сохранять пустое сообщение (Bunraku); всегда отказ (RoleCall) | принято пользователем 26.10 |
| D-32 | Код RoleCall | брать всё, что работает, через порт (§2); Plan C — работа Леви. Основание: общий проект команды, ядро войдёт в Bunraku, куда RoleCall уже портирован | переимплементировать с нуля | принято пользователем 25.10 |
| D-33 | Пересказы (длинный контекст) | пересказы historian включены по умолчанию, один уровень, отдельные 10 % окна [D-83] | выключены по умолчанию; скользящая сводка чата; оба механизма | принято пользователем 26.10 |
| D-34 | Вклады в ядро | DCO (`Signed-off-by`) плюс соглашение команды RoleCall `docs/TEAM-LICENSING.md` о праве на отдельную закрытую лицензию; подписать до первого внешнего коммита (§2, п. 7) | только DCO; CLA | принято пользователем 26.10 |
| D-35…D-73 | Изменения контракта по карте портирования (рев. 4) | см. §19.10; почти все — «принять», с оговорками в D-53, D-61, D-62, D-71 | оставить контракт как есть | приняты все. D-61 и D-62 — 25.10, D-71 — 25.10 в смешанном варианте. Остальные — 26.10, D-43 с правкой для экспортов RoleCall. В D-66…D-68 там, где они расходятся с D-82, D-83, D-86 и D-87, действуют решения Compendium |
| D-74…D-89 | Compendium в ядре (рев. 6): хранение, активация, recall, профили, планировщик, filing, historian, резерв ответа | см. §19.10, §5.8 и §7.4 | Хроника; Compendium в форме Bunraku (квитанции, undo) | приняты 26.10 (вопросы 16–20) |

---

## 17. Риски

1. **Порт тянет за собой сложность (рев. 3).** Код RoleCall и Bunraku решает задачи хоста, которых у ядра нет. Перенос «как есть» раздует ядро и вернёт известные дефекты. *Меры:* правила портирования (§2), карта портирования с вердиктом на каждый модуль, приоритет контракта ядра над паритетом.
2. **AGPL и будущие варианты использования (рев. 3).** Закрытый сервис RoleCall не сможет встроить ядро, не открыв свой код. Сменить лицензию позже можно только с согласия всех авторов, включая авторов портированного кода (Chi, Nemo). *Меры:* решение [D-34] до первых внешних вкладов.
3. **Качество Директора и агентов Compendium на слабых моделях.** Промпты RoleCall настроены под сильные облачные модели, а на локальных 7–14B могут не работать. *Меры:* промпты RoleCall как основа (рев. 3), сессии оценки через record/replay до M4 и M5, lite-профиль, честный сбой.
4. **Prompted-тулы на маленьких локальных моделях ненадёжны:** проза вместо вызовов, битый JSON, протечки шаблонов. *Меры:* проба, цепочка починки, восстановление протечек, финальный раунд, `/search` для человека.
5. **Префилл против тулов.** Пользователи пресетов с префиллом по умолчанию теряют поиск рассказчика [D-28]. *Меры:* видимый `notice`, статус в REPL, переключатель `prefill_vs_tools`.
6. **Одно-слотовые бэкенды.** Вызов Директора или фоновая задача Compendium может выбить KV-кэш рассказчика, и тогда промпт обрабатывается заново целиком. *Меры:* приоритеты и вытеснение; recall заранее (prefetch); задержка фона после хода, чтобы свайп и continue не платили за вытеснение; семафор по origin; пресеты `--cache-ram`, `-np 2` с `id_slot` (M5c), `--smartcache`; отдельное соединение для агентов; прогрев — если замеры M5c покажут нужду (§7.4.7).
7. **Записи возможностей устаревают.** Быстро меняются правила Anthropic (семплеры, thinking, префилл, forced tools, привязка префикса), подписи Gemini и поля vLLM. *Меры:* данные в файлах, пробы, оверрайды, ошибки, которые называют поле.
8. **Пересечение с Kintsu.** Если Kintsu выйдет первым на `scene-turn`, появятся два headless-протокола, а `--json` у них разный. *Меры:* общие коды выхода и флаги, явный маппинг, ранний разговор Леви с Chi. По решению от 25.10 Леви предупреждает Chi сейчас, демо показывает на M3–M4.
9. **Стык с Bunraku.** Старые сцены теряют состояние Директора и таймеры лора [D-27]; трассу нужно переводить для UI Bunraku; трекеры сверяются только на стороне Bunraku; хуки должны быть fail-closed. *Меры:* решение D-27 до M9, conformance-тесты порта, явный список того, что остаётся у Bunraku (§12.5).
10. **Конвенция ST и буквальные макросы.** Пресеты, настроенные под RoleCall, без конвертера окажутся на сообщение выше, и поведение будет ощущаться иначе, чем в RoleCall.
11. **Рост файла сессии.** Его раздувают снимки Директора (≤ 16 КБ типично, потолок 32 КБ на ответ [D-61]), блоки рассуждений, чекпоинты и `prep`. *Меры:* `rp-core compact`, лимиты состояния; позже — снимки-контрольные точки и SQLite за портом.
12. **Неизвестное поведение Bun fetch** при долгом ожидании первого байта: свои таймауты могут убить валидную генерацию или пропустить зависание. Проверяется на M1.
13. **Качество памяти.** Дубли, галлюцинированные факты, разрастание записей. *Меры:* склейка по каноническому имени и алиасам, ключи массивов RoleCall и схлопывание почти-дублей [D-81], NO-WRITE DEFAULT и правило памяти с изменённым убеждением, подавление ещё видимого [D-80], `/memory retire|undo`, уведомление о большой записи; позже — review, reconcile и консолидация записей.
14. **Русская морфология и Unicode.** Лёгкий стемминг даёт ложные совпадения («Мира» и «мир») и пропуски (чередования, супплетивные формы); Turkish İ JS приводит к нижнему регистру неполно. *Меры:* фикстуры `ru`, просьба к модели искать по корням, буквальные фразы в кавычках.
15. **Открытые файлы на диске.** RP-чаты лежат в `~/.rp-core` открытым текстом, и для части сценариев это может быть неприемлемо.
16. **Расползание объёма** против «сознательно простого» ядра. *Меры:* список «позже» в §15 и правило «новая механика только при пользователе в v1».
17. **Compendium на слабых моделях и малых окнах (рев. 6).** Схема из 11 типов и 223 полей рассчитана на сильные модели; слабые выдумывают ключи и значения enum. 30 тысяч токенов снимка — потолок, а не типичный размер (фикстура на 233 записи — 3 741 токен), но в окно 16k не влезает и он. *Меры:* профиль lite — поля 431 токен вместо 620, ростер вместо снимка, шорт-лист вместо дерева [D-79]; терпимое чтение с отбрасыванием поля, а не элемента [D-82]; резерв ответа рассказчика на малом окне [D-89]; оценка на записях qwen3-14b до закрытия M5b. Остаток: мусор в неизвестных полях попадает в рендер.
18. **Задержка до первого токена (рев. 6).** На одно-слотовом бэкенде Директор и фоновые задачи вытесняют KV рассказчика. Prefetch убирает recall с критического пути, но не повторную обработку промпта рассказчика без кэша хоста (по оценке ≈ 8 с на GPU, ≈ 40 с на CPU). Prefetch не видит сообщения игрока: новую тему без имён он ловит хуже. Фона за ход в lite — ≈ 25 с; если игрок отвечает быстрее, задачи голодают. *Меры:* prefetch с добором упоминаний, ожидание в пределах `graceSec`, задержка фона, семафор по origin, `id_slot` и пресеты бэкендов, уведомления `memory_starved` и `recall_slow`; критерии M5c — выбор prefetch не хуже 0,8 от согласованности двух sync-прогонов и повторная обработка ≤ 1,5 × нового хвоста с кэшем хоста или `-np 2` и `id_slot`.

---

## 18. Вопросы к Леви

1. ~~Лицензия ядра.~~ **Отвечено 25.10:** AGPL-3.0-or-later [D-11].
2. ~~Права на код RoleCall.~~ **Отвечено 25.10:**
   - из RoleCall берём всё, что работает, включая Compendium и Plan C (Plan C — работа Леви);
   - из Bunraku — по ситуации, §2 [D-32].
3. **Kintsu, Chi и старые сцены.**
   - **Отвечено 25.10:** сначала предупредить Chi и договориться о кодах выхода и флагах; разговор о переезде — с демо M3–M4 [D-14].
   - Открыто до разговора с Chi:
     - встраивает ли Bunraku ядро как библиотеку и хранит ли записи ядра в своём зашифрованном SQLite [D-13];
     - что будет с существующими сценами [D-27].
4. ~~Поведение Compendium.~~ **Отвечено 25.10:** код и промпты Compendium можно брать. Остался вопрос дизайна — он вынесен в вопрос 13 [D-26].
5. ~~Гибрид, тулы и префилл.~~ **Отвечено 26.10:** гибрид подтверждён; при префилле в пресете важнее префилл, тулы рассказчика в этом ходу выключены [D-1, D-5, D-28]. Исходный вопрос: Подтверждаешь ли ты схему: Директор и recall до ответа, filing и historian после, а у рассказчика только поиск по истории и лору, без записи? И что важнее, когда в пресете есть префилл: префилл (тулы в этом ходу выключены) или тулы (префилл пропускается)? [D-1, D-5, D-28]
6. ~~Порядок вех.~~ **Отвечено 26.10:** порядок вех как есть [D-8]. Исходный вопрос: Устраивает ли порядок: тулы (M3), Директор (M4) и память (M5) идут до `--stdio` (M6) и нативного Anthropic (M7)? До M6 UI подключается только как библиотека или через `send --json`, до M7 Claude доступен только через OpenRouter. [D-8]
7. ~~Память.~~ **Отвечено 26.10:** filing и historian пишут без подтверждения, пересказы включены, в библиотеку — только `/memory export` [D-3, D-23, D-33]. Исходный вопрос:
   - Filing и historian пишут в Compendium сразу, без подтверждения, когда ответ принят; свайп и откат убирают записи сами. Устраивает?
   - Включать ли пересказы старой истории по умолчанию?
   - Нужно ли, чтобы что-то попадало в библиотечные лорбуки, кроме ручного `/memory export`? [D-3, D-23, D-33]
8. ~~Директор и другие агенты.~~ **Отвечено 26.10:** D-17 — ещё 25.10; на свайпе план используется повторно [D-29]; других агентов в v1 нет [D-4]. Исходный вопрос:
   - При сбое Директора в этом ходу директивы нет (как в Bunraku), а не повтор прошлой (как в RoleCall). Устраивает?
   - На обычном свайпе план повторно используется, без нового вызова. Устраивает?
   - Нужны ли в v1, кроме агентов Compendium, трекеры, Character Minds или выбор лора моделью? [D-17, D-29, D-4]
9. ~~Поиск.~~ **Отвечено 26.10:** ключевые слова со стеммингом; эмбеддинги и Lookback — позже [D-2, D-24]. Исходный вопрос: Хватит ли в v1 поиска по ключевым словам с лёгким стеммингом, с эмбеддингами позже? Можно ли отложить Lookback для моделей без тулов? [D-2, D-24]
10. ~~Импорт и охват.~~ **Отвечено 26.10:** как в документе: ST-пресеты, world info, CCv2/V3; `.vnpack`, групповой чат и импорт старых чатов — позже [D-6, D-9, D-10]. Исходный вопрос:
    - Хватит ли в v1 ST-пресетов, world info и карточек CCv2/V3? Или `.vnpack` с твоими самыми подробными листами персонажей нужен уже на M2?
    - Можно ли отложить групповой чат и импорт старых чатов ST/RoleCall на после M9? [D-6, D-9, D-10]
11. ~~Совместимость: семантика ST против Bunraku.~~ **Отвечено 26.10:** принято пакетом [D-7, D-12, D-21, D-30, D-31, D-22, D-16]. Исходный вопрос: Подтверди по умолчанию:
    - конвенцию глубины ST и активацию лора по ключам (`scanDepth` 2), с +1 при импорте пресетов RoleCall;
    - переопределения карточки по ST;
    - переменные, которые коммитятся с ответом;
    - сбой на ответ из одних рассуждений;
    - сохранение частичного текста при сбое в CLI (но не в протоколе);
    - накопление текста между раундами тулов. [D-7, D-12, D-21, D-30, D-31, D-22, D-16]
12. ~~Файлы, ключи и технические решения.~~ **Отвечено 26.10:** принято пакетом [D-13, D-20, D-15, D-18, D-19, D-25]. Исходный вопрос:
    - Нормально ли, что сессии в v1 лежат обычными JSONL-файлами без шифрования, а ключи берутся из env или `secret-tool`?
    - Подтверждаешь ли ты пакетом технические решения: транспорт тулов по записи возможностей, повтор рассуждений только внутри цикла, свои адаптеры без SDK, один ход на сессию? [D-13, D-20, D-15, D-18, D-19, D-25]
13. ~~Память: Хроника или Compendium.~~ **Отвечено 25.10: Compendium целиком** [D-26]. Рекомендация была другой. Проект — §5.8 и §7.4 (рев. 6), решения D-74…D-89. Исходный текст вопроса: Теперь Compendium можно портировать. Есть два пути [D-26]:
    - **Хроника в v1** (рекомендация, §7.4). Из Compendium берутся промпты filing и historian и поведенческие уроки. Так проще, и записи откатываются вместе с деревом сообщений.
    - **Compendium целиком:** типизированные записи, дерево, recall-модель, квитанции.

    **Рев. 4, по карте портирования:** рекомендация — Хроника. Против Compendium целиком:
    - ≈ 1 900–2 400 строк ядра (XL): M5 удлиняется на 3–5 недель;
    - 1–2 вызова модели перед каждым ответом;
    - снимок на 30 тыс. токенов, который не влезает в окно локальной модели;
    - в Bunraku Compendium и так остаётся, через `beforeAssemble`.

    Из Compendium всё равно берутся промпты filing и historian, разбор ответа и правило слияния; поле `data?` резервируется [D-69]. Доводы целиком — §19.11.
14. ~~Вклады Chi и Nemo.~~ **Отвечено 26.10:** DCO плюс соглашение команды (§2, п. 7) [D-34]. Исходный вопрос:
    - **DCO** — подпись `Signed-off-by`. Лицензия остаётся AGPL навсегда.
    - **CLA или общее соглашение команды** — нужно, если закрытому сервису RoleCall когда-нибудь понадобится встроить ядро под другой лицензией.
15. ~~Изменения контракта D-35…D-73.~~ **Отвечено 26.10:**
    - приняты пакетом по рекомендациям;
    - D-43 — с правкой для экспортов RoleCall;
    - в D-66…D-68 там, где они расходятся с решениями Compendium, действуют D-82, D-83, D-86 и D-87.

    Исходный вопрос, частично отвеченный 25.10:
    - D-61 и D-62 приняты по рекомендации, D-17 остаётся;
    - D-71 принято в смешанном варианте.

    Остальные — принимаем пакетом по рекомендациям? Отдельного взгляда требуют три:
    - **D-61** — форма состояния и плана Директора берётся из Bunraku и RoleCall, а не свежая из §7.3;
    - **D-62** — директива отклоняется, только если пуста (вместе с D-17);
    - **D-71** — выключенные маркеры ST-пресета ничего не отправляют, как в ST (вместе с вопросом 11).
16. **(рев. 6) Отвечено 26.10:** prefetch по умолчанию (`auto`), sync на облаке [D-78]. Исходный вопрос: Recall на локальной модели по умолчанию считается заранее, пока ты пишешь (prefetch), и стартует через 8 с после ответа, чтобы быстрый свайп не платил за вытесненный кэш. Упоминания из твоего нового сообщения добираются без модели, но саму модель твоё сообщение не видит. Устраивает или лучше синхронный вызов? Он добавляет ≈ 4–12 с к каждому ответу на одном слоте (оценка). [D-78, D-84]
17. **(рев. 6) Отвечено 26.10:** да, как в Bunraku: доступ `read` по умолчанию, `off` по книге [D-76]. Исходный вопрос: Должен ли recall выбирать и записи обычных ST-книг, как Bunraku (модель может подтянуть запись, у которой не сработал ключ)? Или только Compendium сессии и типизированные книги, а ST-книги остаются чистым ST? [D-76]
18. **(рев. 6) Отвечено 26.10:** показать Chi список отступлений до M5b и предложить ей M5a, если она будет в проекте [D-88]. Исходный вопрос: Список отступлений от Bunraku (D-88) — показать Chi до M5b? В нём, например, `/memory undo`, после которого отменённый пересказ больше не пишется заново (в Bunraku пишется). И не возьмёт ли Chi M5a (данные и ручной Compendium) параллельно с M4, как M4a? Это убирает 11–19 дней с критического пути.
19. **(рев. 6) Отвечено 26.10:** да, проход переписывается [D-86]. Исходный вопрос: Если ты правишь или скрываешь уже записанное сообщение, filing записывает его заново: это лишний фоновый вызов, и записи прежнего прохода пропадают до перезаписи. Устраивает? [D-86]
20. **(рев. 6) Отвечено 26.10:** да, первой режется M5c. Исходный вопрос: M5 выросла до 32–52 дней, общий итог — ≈ 120–202. Если придётся резать, первой откладывается M5c: recall без модели (`lexical`) работает и без неё. Ты согласна с таким порядком?

---

## 19. Карта портирования (рев. 4)

*Рев. 4, 25.10.2026.* Карта отвечает на вопрос из §2: откуда берётся код каждого модуля из §4. Варианты — из RoleCall, из Bunraku или новый код. Карта заменяет предварительную таблицу кандидатов из §2.

**Как она собрана.**
- Семь оценщиков, по одному на группу модулей, сами открыли исходники.
- Они посчитали строки (`wc -l`), выписали импорты и связи: Supabase, сторы, React, синглтоны модуля, AI SDK, studio/stage Bunraku.
- Проверили, есть ли тесты, и нашли основных авторов по `git log`.

Контракт ядра (§5–§13) остаётся целевым, и порт приводится к нему. Если исходник лучше или проще контракта, предложено изменение контракта — D-35…D-73.

**Источники.**
- **RoleCall** — VAUDEVILLE, приложение `apps/rc`, ветка `dev/Levi` @ `fb8dc623e` (`fb8dc623e6beb24083f5105c828462e89fc66ce3`).
- **Bunraku** — @ `702d8120` (`702d81201120a6b90eb29a783a77c60ffdebc374`), AGPL-3.0-or-later, © Coneja-Chibi. «Kit» — это `Bunraku/src/kit`.
- **SillyBunny** (форк SillyTavern, AGPL) @ `3021edca` — эталон поведения ST, но не источник кода.

**Сокращения в таблицах.**
- `BR:` — корень Bunraku.
- `RC:` — `VAUDEVILLE/apps/rc/src/lib/`.
- `VV:` — корень VAUDEVILLE.
- `ST:` — корень SillyBunny.
- Число в скобках — строк в исходном файле. «~N из M» — сколько из них берётся.

**Вердикты.**

| Вердикт | Значение |
|---|---|
| **port** | Копируем с лёгкой адаптацией: переименования, типы ядра, импорты. Логика почти не меняется |
| **adapt** | Берём логику, промпты и тесты, но заметно перестраиваем под контракт ядра |
| **reference** | Читаем ради поведения, краевых случаев и тестов; модуль пишется заново |
| **fresh** | Брать нечего, новый код |

**Усилие** — для одного опытного разработчика с ИИ: S — меньше дня, M — 1–3 дня, L — 3–7 дней, XL — больше 7 дней. В суммах берётся S = 0,5–1, M = 1,5–2,5, L = 4–6 дней. Колонка «Строк ядра» в сводке — ожидаемый размер файлов ядра.

**Происхождение.**
- Файл с вердиктом port или adapt получает шапку из §2 и строку в `PROVENANCE.md` до первого внешнего коммита [D-34].
- В файлах Bunraku нет пофайловых шапок. Копирайт берётся из `LICENSING.md` Bunraku: `Copyright (C) 2026 Coneja-Chibi`. Почти весь код Bunraku, который берёт ядро, — коммиты Chi. Исключения: `kit/loop/_shared/test-harness.ts` (Luis), `studio/dramaturg-tools.ts` (Леви), а также строки Леви в `stage/provider/tool-loop.ts` и его тесте, `core/stream-bytes.ts` и `core/assembly/sanitize.ts`. Шапки этих файлов называют обоих авторов.
- Авторы RoleCall определяются по `git log` и blame: Coneja-Chibi, NemoVonNirgend, Levi, Nagi.
- **Ограничение git.** Всё, что существовало до VAUDEVILLE, попало в него одним коммитом импорта `660a7d67a` (Coneja-Chibi, 12.04.2026), поэтому git приписывает эти строки только Chi. Авторов до импорта нужно взять из исходного репозитория RoleCall или согласовать с командой до первого внешнего коммита [D-34]. Это касается, например, `import/png-parser.ts`, `lorebook/regex-utils.ts`, `lorebook/triggers/keyword.ts`, `ai/message-formatter.ts`, `providers/definitions.ts`.
- Некоторые файлы RoleCall выведены из SillyTavern: `providers/definitions.ts`, `providers/adapters/reasoning-effort.ts`, `ai/message-formatter.ts`, `lorebook/regex-utils.ts`. Факты из них требуют атрибуции SillyTavern, даже если перенесены в JSON.
- Модуль с вердиктом reference получает строку в `PROVENANCE.md` с пометкой «образец». Шапка нужна, только если перенесён код или текст.

### 19.1 Сводка

| Группа | Модулей | port | adapt | reference | fresh | Строк ядра | Дней |
|---|---|---|---|---|---|---|---|
| 19.2 Оболочка: сессия, движок, протокол, CLI | 26 | 1 | 6 | 0 | 19 | ≈ 4 970 | 33,5–56 |
| 19.3 Промпт и лор | 10 | 2 | 6 | 2 | 0 | ≈ 1 770 | 12,5–21 |
| 19.4 Провайдеры | 11 | 1 | 6 | 2 | 2 | ≈ 2 870 (из них ≈ 440 JSON) | 15–25 |
| 19.5 Рассказчик, тулы, поиск | 10 | 1 | 6 | 1 | 2 | ≈ 1 970 | 11–19 |
| 19.6 Story Director | 9 | 2 | 7 | 0 | 0 | ≈ 2 440 + ≈ 3 900 строк личностей | 9,5–16,5 |
| 19.7 Compendium (рев. 6) | 20 | 4 | 9 | 0 | 7 | ≈ 3 700 | 29,5–48,5 |
| 19.8 Форматы и конфиг | 7 | 0 | 4 | 1 | 2 | ≈ 1 520 | 7,5–13 |
| **Итого v1** | **93** | **11** | **44** | **6** | **32** | **≈ 19 250 + 3 900** | **≈ 118,5–199,5** |

*93 строки карты — это 87 модулей плюс 6 долей модулей других групп, учтённых в §19.7: `fold`, `repl`/`lore`, `lane`/`sched`, `structured`, протокол, `probe`.*

**Строки ядра по вердиктам.**
- Порт — ≈ 2 000, плюс 3 900 строк личностей.
- Адаптация — ≈ 10 400.
- Новый код по образцу (reference) — ≈ 1 250.
- С нуля — ≈ 5 550. Почти две трети из них приходится на оболочку: журнал-дерево, свёртку, движок и CLI. Такой модели хранения нет ни в одном из репозиториев.

*Рев. 6:* пересчитано с новым §19.7 (port ≈ 800, adapt ≈ 1 950, fresh ≈ 950 строк вместо прежних ≈ 800 строк группы). Итого источник есть примерно у 65 % логики.

**Работы вне модулей** — ещё ≈ 2–4 дня: фикстуры паритета на M2 и `draft` на M9. Итог по вехам — ≈ 120–202 дня (§15; рев. 5 — ≈ 113–192, рев. 4 — ≈ 98–167).

**Оценено, но не входит в v1:**
- `agents/director/edits.ts` — reference, M, после M9;
- части Compendium вне v1 — §7.4.10;
- Plan C, `agents/minds/*` — reference, XL, ≈ 2 000 строк, после M9;
- `formats/vnpack.ts` — fresh, S, ≈ 200 строк. Позже либо на M2, если так решит вопрос 10.

**Отличия от предварительной таблицы §2:**
- **`providers/gemini`** — новый код. В Bunraku нативного Gemini нет. `google.ts` из RoleCall кладёт ключ в URL и теряет вызовы и подписи из стрима, поэтому из него портируются только санитайзер схем и константы safety.
- **`providers/http`** — из Kit (`egress.ts` `guardedFetch`) и `core/stream-bytes.ts`.
- **`engine/narrate`** — из `tool-loop.ts` Bunraku, а не из narrator-engine RoleCall: в последнем первый вызов разделён.
- **`prompt/assemble`** — пишется по контракту, Bunraku служит образцом. Замыкание импортов его сборщика — 148 файлов и 20 752 строки. Портируются листья: глубина, макросы, бюджет, лор.
- **`agents/compendium`** (рев. 6) — Compendium целиком из Bunraku `core/compendium` (переработка Chi), со слиянием и свежестью RoleCall (§19.7).

### 19.2 Оболочка: сессия, движок, протокол, CLI

| Модуль | Вердикт | Источник (repo:path, строк) | Что меняется | Усилие | Веха |
|---|---|---|---|---|---|
| `index.ts` | fresh | — | Реэкспорт Engine, типов, Event/Command; `exports` по §4 | S | M1a |
| `session/entries.ts` | fresh | `BR:src/kit/sessions/store.ts` (243) — только как пример границы разбора | Ручные guards без зависимостей на каждый вид `Entry`; `parseEntry(line) → Entry \| {bad}`; проверка версии заголовка | S | M1a |
| `session/log.ts` | fresh | `BR:src/studio/atomic-file.ts` (149) — рецепт temp+fsync+rename; `BR:src/studio/fs-backend.ts` `withNodePathLock` (~30 из 178) — lock через `wx`; `RC:ai/jobs/heartbeat.ts` (131) — урок продления | Lock `wx` с {pid, host, started, renewed}, продление по таймеру с проверкой владения. Append одним `write()`. fsync для всего, кроме `chk`; `fdatasync` раз в 2 с. Рваный хвост уходит в `.torn`. Compact с fsync каталога [D-35] | M | M1a (compact — M4) |
| `session/tree.ts` | fresh | — (`BR:src/stage/contracts/chat-store.ts` (499) — только адресация (message, position)) | Индексы id / дети / правки; `path`, `siblings`, спуск к новейшему потомку, `tails`, индекс свайпа | S | M1a |
| `session/fold.ts` | fresh | `BR:src/studio/scene-turn-load.ts` (266) — поведение `fires` | `PathView` с кэшем по версии. Порядок наполнения: путь, правки, свайпы, vars (D-30) → `fires` (M2) → `directorAt` (M4) → Compendium (§19.7). Редьюсеры агентов инъецируются | M | M1a → M2/M3/M4/M5 |
| `session/fork.ts` | fresh | `BR:src/kit/sessions/session-model.ts` `forkFrom` (126) — только идея ссылки на родителя | Копия пути в новый файл; перенумерация `seq`; `mem` с `on:null` | S | M1a |
| `session/port.ts` | fresh | `BR:src/stage/contracts/chat-store.contract.ts` (422), `chat-store.contract-turns.ts` (454) — паттерн «один набор тестов, много бэкендов» | `RecordStore` выделяется из log.ts; in-memory реализация; `Lease` | M | M9 |
| `engine/engine.ts` | fresh | `BR:src/studio/scene-turn-running.ts` (13), `compendium-queue.ts` (20) — берётся идея, не код (это синглтоны модуля) | `Engine.open({home, config, fetch, keys, clock, random, hooks})`; реестр сессий; ходы на экземпляре; `events()`; порядок shutdown | M | M1a |
| `engine/turn.ts` | adapt | `BR:src/studio/scene-turn.ts` (436); `scene-turn-fallback.ts` (15); `src/core/assembly/continuation.ts` (33); `scene-turn-load.ts` стр. 136–153. Справочно: `RC:ai/generation-retry.ts` (266) | Соответствие: beginTurn → `turn`, первый saveCheckpoint → `prep`, saveCheckpoint → `chk`, commitTurn(guard) → `msg`/`edit` с `base`, dropTurn → `end`, конфликт → `held`. Вырезается ~60 % файла: recall, трекеры, regex, Final Cut, Inspector, meter. Добавляется: один повтор той же модели до fallback, типизированные отказы [D-38], завершающий таймер чекпоинта | L | M1a (Директор — M4, held — M6, хуки — M9) |
| `engine/recover.ts` | adapt | `BR:src/studio/scene-turn-resume.ts` (59) | Правило безусловного коммита из ядра: ответ — хвостом под исходным U, continue — `end{abandoned}`. Задачи Compendium восстанавливаются по ключам `file:`/`hist:` | M | M1a (задачи — M5, held — M6) |
| `engine/lane.ts` | fresh | `BR:src/studio/compendium-queue.ts` (20), `serial.ts` (19) — только сериализация. `BR:src/stage/worker-lane.ts` не подходит | FIFO {job, key, task, attempt} на сессию; `preempted` → обратно в очередь; парковка после `maxAttempts` | M | M5 |
| `engine/sched.ts` | fresh | — (`BR:src/kit/loop/scheduler.ts` — планировщик пачки тулов, он уходит в `tools/run.ts`) | M1a — простой семафор на соединение; M5 — семафор по origin, приоритеты, вытеснение, задержка фона на локальном origin [D-37, D-84] | M | M1a / M5 |
| `engine/abort.ts` | fresh | — (паттерны `AbortSignal.any` в `scene-turn.ts` и `scene-director-call.ts`) | Типизированные причины, `child(parent)`, `reasonOf`. Таймер никогда не даёт `user_stop` | S | M1a |
| `engine/hooks.ts` | adapt | `BR:src/studio/scene-turn-gate.ts` `turnGate` (34), `scene-turn-review.ts` `applyEdits` (24) | Гейты на экземпляре Engine с ключом (session, turn, gate); `answerGate` возвращает boolean [D-39]. Раннер `HostHooks` (fail-closed) — новый | M | точки вызова — M1a, реализация — M9 |
| `protocol/events.ts` | adapt | `RC:ai/streaming/stream-delta.ts` (88) | Типы `Event` по §12.2; `applyDelta(text, ev)` по одному `offset`, без `full` | S | M1a (заморозка — M6) |
| `protocol/commands.ts` | fresh | Справочно: `BR:src/ui/server-chats-turn.ts` (279) | Объединение `Command` и валидаторы params → `invalid_params`; генерация JSON Schema | M | M6 |
| `protocol/rpc.ts` | adapt | `BR:src/mcp/protocol.ts` (134) — конверт JSON-RPC, ~60 строк; `BR:src/mcp/server.ts` (195) — антипример | Чтение через jsonl.ts; конкурентная диспетчеризация, чтобы `turn/stop` работал во время хода; ошибки `{-32000, data:{code}}`; `gate/request` на M9 | M | M6 (+M9) |
| `protocol/jsonl.ts` | adapt | `BR:src/kit/mcp/connections.ts` `readLines` (~18 из 297) | `lines(stream)` для stdin и `splitLines(bytes) → {lines, torn}` для журнала; CR, пустые строки, EOF. Один сплиттер на всё ядро [D-36] | S | M1a |
| `protocol/coalesce.ts` | port | `BR:src/ui/server-chats-turn.ts` `coalesceTurnEvents` (стр. 43–104) | Без ветки `full`; ключ пачки (session, turn, type); планировщик инъецируется [D-36] | S | M1a |
| `cli/main.ts` | fresh | `BR:docs/KINTSU-PLAN.md` K4 — спецификация; `BR:src/cli-io.ts` — стиль строгого разбора флагов | Подкоманды `init`/`new`/`chat` (REPL открытой сессии)/`send`/`sessions`/`show`/`import`/`probe`/`models`/`compact`; `--stdio`, `--home`, `--sandbox`/`--seed`, `--debug` | M | M1a–M1b (`compact` — M4 [D-35]; `probe`: каталог — M1b, активные пробы — M3) |
| `cli/repl.ts` | fresh | — (REPL Kit на OpenTUI/React не подходит). Урок RoleCall vvs-805: Stop, нажатый до появления id хода, не должен теряться | readline + ANSI; набранная строка держится до конца хода; вопрос про `held`; Ctrl+C во время допуска | L | M1b, растёт до M5 |
| `cli/render.ts` | fresh | — | Курсив для действий; свёрнутые рассуждения; строка статуса; `notice` раз за сессию | M | M1b |
| `cli/oneshot.ts` | fresh | `BR:docs/KINTSU-PLAN.md` K4 | `send … --json` через coalesce.ts; коды выхода §12.3; `onError:'keep'` | S | M1a |
| `cli/signals.ts` | fresh | `BR:src/kit/mcp/connections.ts` `hookExit` — антипример | Первый SIGINT → stop, второй → выход; SIGTERM → shutdown с сохранением частичного текста | S | M1a |
| `testing/index.ts` | fresh | Паттерн `BR:chat-store.contract.ts`; `BR:scripts/test-sandbox.ts` (99) | `describeRecordStoreConformance`; `test/preload.ts` с `RP_CORE_HOME` во временном каталоге | M | preload — M1a, экспорт — M9 |
| `providers/scripted.ts` | fresh | `BR:src/studio/scene-turn.test.ts` `scripted()` (стр. 21–44); `BR:src/stage/provider/test-fetch-harness.ts` (36) — портируется как помощник | Шаги в JSONL, проверка хеша запроса, шаг `{pause}` [D-40]; record/replay с вырезанием секретов | M | M1a (script), M2 (record/replay) |

- **Bunraku выигрывает везде, где есть что брать.**
  - `scene-turn.ts` — самая чистая рабочая форма правил хода RoleCall:
    - stop сохраняет текст;
    - сбой сбрасывает ход и отдаёт черновик;
    - конфликт держит чекпоинт;
    - полученный ответ не выбрасывается;
    - чекпоинт — каждые 400 символов или 1 с.
  - RoleCall даёт только `stream-delta.ts`: там правила хода спутаны с Supabase, арендой задач и шифрованием.
  - ~70 % строк группы (19 из 26 модулей) — новый код: append-only дерева нет ни в одном репозитории.
- **Кандидаты, которые не подошли:**
  - `stage/worker-lane.ts` — раннер Worker-потоков;
  - `kit/loop/scheduler.ts` — планировщик пачки тулов;
  - `cli.ts` Bunraku — конвертер форматов;
  - REPL Kit — на OpenTUI.
  - Kintsu K4 — только спецификация; его коды выхода 0/2/3/4/5 уже совпадают с §12.3.
- **Не переносить:**
  - запись переменных до отправки и `putBackEffects` (D-30);
  - снимок Директора второй записью после `commitTurn`;
  - модульные `running`, `lanes`, `gate`;
  - события `full`;
  - `node:readline` и глобальную очередь запросов MCP-сервера;
  - коммит упавшего ответа «в конец дубля» без охраны;
  - `commitAnyway` для continue поверх изменённого текста;
  - немедленный выход по SIGINT;
  - `DOMException('stopped')` вместо типизированных причин;
  - atomic replace без fsync каталога.
- **Тесты и фикстуры:**
  - `BR:src/core/assembly/continuation.test.ts` (71) — переносится дословно.
  - Сценарии из `scene-turn.test.ts` (466), `scene-turn-continue.test.ts` (335), `scene-turn-fallback.test.ts` (180) и `scene-turn.regressions.test.ts` (118) переписываются. Тесты восстановления Bunraku кодируют другое правило, копировать их как есть нельзя.
  - `RC:ai/streaming/__tests__/stream-delta.test.ts` (58).
  - Тесты M5 из `server-chats-turn.test.ts` (стр. 190–326) становятся unit-тестами склейки.
  - `mcp/server.test.ts` (208) даёт 5 кейсов для rpc.
- **С первого дня нужно своё:**
  - property-тесты дерева (путь — всегда цепочка от корня к голове, хвосты не пересекаются с путём);
  - инъекция краша на каждом шаге;
  - проверка на M1a, работают ли в Bun `fdatasync` и fsync каталога.
  - Часы и планировщик инъецируются: от них зависят таймеры `chk`, `fdatasync`, склейки и lock.

### 19.3 Промпт и лор

| Модуль | Вердикт | Источник (repo:path, строк) | Что меняется | Усилие | Веха |
|---|---|---|---|---|---|
| `prompt/assemble.ts` | reference | `BR:src/core/assembly/assemble.ts` (448) и `{preset,lore-place,card,macro-pass,sanitize,summary-cut,recall-place,guided-swipe,director,note,types}.ts` (1 103). Справочно: `RC:ai/prompt-assembly.ts` (4 590), `ST:public/scripts/openai.js` стр. 1790–1810 | Новый однопроходный сборщик слотов и вставок (~420 строк) по §10.2. Из Bunraku берутся порядок шагов, пересказ перед остатком истории, построение трассы, `diff()` переменных (безопасный к `__proto__`) и громкие ошибки пресета. Блок guidance — по [D-41]; поля карточки — шаблоны [D-42] | L | M1a → M2 (слоты лора) → M3 (префилл и тулы) → M4 (Директор) → M5a (блок Compendium на глубине 1) → M5b (`{{recap}}` с обзорами арок) |
| `prompt/shape.ts` | adapt | `BR:src/stage/provider/transport-core.ts` (~70 из 165); `BR:src/core/assembly/request.ts` (139), `continuation.ts` (33); `RC:ai/prefill-injection.ts` + `final-message-role.ts` (184); `RC:ai/message-formatter.ts` (715, выведен из ST) | Префилл по `caps.prefill`, а не по регулярке над id модели. Post-processing ST — с учётом блоков: tool-блоки не склеиваются [D-48]. Mid-system в режиме as-user. Правки хоста — по индексу | M | M1a (префилл и хвост continue по `caps.prefill`), M1b (post-processing ST, строгое чередование, mid-system в режиме as-user), M7 (флаги anthropic-native; `cache_control` ставит `anthropic.ts` [D-48]) |
| `prompt/depth.ts` | adapt | `BR:src/core/assembly/conversation.ts` `injectAtDepth` (164), `note.ts` и `director.ts` (161); `ST:openai.js` стр. 1058–1149 | Глубина ST (= глубина RC + 1); при равенстве — по order, затем по источнику. `fromRcDepth` — только для импортёров [D-47] | S | M1a |
| `prompt/macros.ts` | adapt | `BR:src/core/macros/{parse,normalize,evaluate,process,limits,registry}.ts` (945) и подмножество handlers (1 471). Справочно: `RC:macros/processor.ts` + `tokenizer.ts` (1 397), `ST:macros.js` | Лексер и вычислитель без блочных форм. Закрытая таблица §10.4 (~25 макросов). Оверлей переменных → `VarsDiff`. Неизвестные макросы остаются буквальным текстом. Легаси-формы ST и семантика `random`/`pick` — по [D-43] | M | M1a (весь набор §10.4) |
| `prompt/budget.ts` | adapt | `BR:src/core/tokens/trim.ts` (50), `src/core/assembly/budget-app.ts` (95), `request.ts` `presetWindow`; поведение `RC:ai/prompt-assembly.ts` `finalPassBudgetTrim` (стр. 218–315) | Окно и резерв по §11. Куски по 8, отсчёт от самого старого сообщения [D-49]; защищённые части; ранний стоп при проходе от новейших | M | M1b |
| `prompt/tokens.ts` | reference | `BR:src/core/tokens/{base,calibrate,priors,estimate}.ts` (585); `RC:lorebook/tokenizer.ts` (121) | M1: символы/3 (для кириллицы — /2,5) плюс EMA [D-50]. M2: gpt-tokenizer o200k с `disallowedSpecial: new Set()` | S | M1a/M1b, M2 |
| `prompt/rng.ts` | port | `BR:src/core/lore/rng.ts` (34) | mulberry32 + `sub(seed, label)` на splitmix32 + хеш строки; без crypto [D-44] | S | M1a |
| `lore/engine.ts` | adapt | `BR:src/core/lore/engine/{engine,recursion,groups,budget,scan,types}.ts` (1 015). Справочно: `RC:lorebook/engine.ts` + selection/matching/runtime (1 452), `ST:world-info.js` | Порядок ST: бросок вероятности до бюджета, одна ось `order`, `scanDepth` 2. Убираются бюджеты по книгам, триггеры special/emotion, side effects, boosts, key-index. Вердикты считаются по запросу [D-45] | M | M2 (маршрутизация типизированных записей к Compendium [D-76] — M5a) |
| `lore/keys.ts` | adapt | `BR:.../key-word-boundary.ts` (35); `triggers-keyword.ts` + `scan.ts` (427, из них ~45 строк логики); `RC:lorebook/triggers/keyword.ts` (149); `RC:lorebook/regex-utils.ts` `parseRegexFromString` (~25 из 1 014) | re2js с литеральным фолбэком (RoleCall), Unicode-граница слова (Bunraku, [D-46]), таблица вторичной логики. Кэш на экземпляре | S | M2 (сопоставление по основам — M3) |
| `lore/timers.ts` | port | `BR:src/core/lore/engine/timers.ts` (90); `ST:world-info.js` стр. 629–697 | `messagesAgo` считается в сообщениях пути, как в ST, а не в ответах; `fires` берутся из `PathView` | S | M2 |

- **Bunraku выигрывает у RoleCall во всех модулях.**
  - Сборщик RoleCall — асинхронная `assemblePrompt` на ≈ 3 670 строк (файл — 4 590) с 17 запросами к Supabase.
  - Движок лора RoleCall — синглтон с `Math.random`.
  - Реестр макросов RoleCall — изменяемый глобал.
- **Сборщик Bunraku целиком не проще.**
  - Даже нужное подмножество — 3 446 строк плюс движок макросов на 6 704 строки.
  - В ~8 местах он расходится с контрактом ядра.
  - Поэтому `assemble`, `depth`, `budget` и `tokens` пишутся по контракту, а переносятся чистые листья: ~4 000 строк источника дают ~1 050 строк ядра.
- **RoleCall выигрывает дважды:**
  - re2js с литеральным фолбэком в `keys.ts`;
  - поведение `finalPassBudgetTrim` для `budget.ts`.
  - SillyBunny — эталон для глубины, overrides и `{{original}}`, `pick`/`random`, таймеров и правила «вероятность до бюджета».
- **Не переносить:**
  - глубину RC;
  - двойной контракт Директора;
  - вырезание неизвестных макросов;
  - раскрытие макросов в истории и запись `{{setvar}}` из текущего сообщения;
  - несколько проходов макросов;
  - маркер `{{message_history}}`;
  - бюджет до броска вероятности и бюджеты по книгам;
  - `Math.random` в группах;
  - `scanDepth` 100 и 4;
  - ASCII-границу `\W`;
  - `triggeredIds` по голому id: id совпадают между книгами;
  - резерв под `characterPrompt`, который не отправляется;
  - предварительную обрезку на 60 %.
- **Фикстуры паритета.**
  - `BR:tools/rc-recorder` — 11 фикстур и записанные выходы, сняты на RC 68afe385. Берутся как входы.
  - Точный паритет проверяется только для поименованного подмножества (02, позже 06). Остальное — снимки со списком отклонений: 03–05 — бюджет, 07 — глубина +1, 08 — append, 10 — toggle-макросы RC, 11 — бюджет.
  - `macro-corpus.json` — 123 из 179 записей через порт `rc-parity.test.ts` (82). Без block-if, dot/$, lazy/volatile и template.
- **Тесты Bunraku:**
  - лор:
    - `lore/engine`: engine (17), explain (24 → тесты вердиктов), recursion (6+1), groups (4), budget (7), regressions (8);
    - `purity` (1) — расширить на весь `src/` как дешёвую замену линтера §6.9;
    - `timers.test.ts` (11), `triggers-keyword.test.ts` (13);
  - макросы: `process-syntax`, `evaluate.regressions`, `bounds`, `handlers/random`, `time`, `variables.regressions`;
  - провайдерные и бюджетные: post-processing из `transport-core.test.ts` (~11), `budget-app.test.ts` (7).
- **Новое:** golden-снимки SillyBunny.

### 19.4 Провайдеры

| Модуль | Вердикт | Источник (repo:path, строк) | Что меняется | Усилие | Веха |
|---|---|---|---|---|---|
| `providers/types.ts` | reference | `BR:src/stage/contracts/provider.ts` (202); `RC:providers/types.ts` (599) | Типы по §8.1 и `AssistantResult` [D-51]. Из Bunraku — класс `ProviderError`, форма `{url, headers, body}` и парсер `{line, end}` | S | M1a |
| `providers/wire.ts` *(новый)* | adapt | `BR:src/stage/provider/openai-compatible-request.ts` `validateToolProtocol` (стр. 72–115); `transport-core.ts` `normalizeFinishReason`; `request-overrides.ts` + `src/stage/params/custom.ts` (150); `RC:providers/adapters/base.ts` `validateDirectToolProtocol` | Проверка протокола по блокам `PromptMsg`, ремап id, `mergeAdjacent`, таблица finish [D-52]; `applyOverrides` [D-53] | S | M1b |
| `providers/http.ts` | adapt | `BR:src/kit/providers/egress.ts` `guardedFetch` (стр. 45–95 из 206); `src/core/stream-bytes.ts` `chunksOf` (114); `transport-core.ts` `classifyHttpFailure`; `provider-send.ts` (98) | Без AI SDK. `fetch` берётся из env на каждый запрос. Таймеры первого байта и простоя, таблица статусов, тело ошибки не больше 64 КБ | M | M1b |
| `providers/sse.ts` | port | `BR:src/stage/provider/transport-core.ts` `createLineSplitter` (20) и разбор `data:` из ридеров | Генератор `sseEvents`. `data:` принимается с пробелом и без, комментарии пропускаются. Чтение продолжается после finish. EOF без терминального сигнала — `truncated_stream` | S | M1b |
| `providers/reasoning-tags.ts` | fresh | `BR:src/core/reasoning-capture.ts` — таблица `closingForOpening` (~25 строк); тесты из `reasoning-tags.ts` (196); `RC:ai/streaming/openai.ts` — антипример | Стриминговый сплиттер по `caps.reasoning.tags`. Carry-буфер держит начало любого маркера. Флаг `startInside` | S | M1b |
| `providers/openai-chat.ts` | adapt | `BR:src/stage/provider/openai-compatible-request.ts` (250), `-reply.ts` (236), `openai-compatible.ts` + `provider-send.ts` (121), `reasoning-wire.ts` (66, уходит в данные). Только список причуд: `RC:providers/adapters/openai.ts` (741), `base.ts` | Рендер из блоков; эхо рассуждений по `caps.reasoning.echo`; семплеры по записи возможностей. Ридер выдаёт события tool/usage/finish/error. Реестр PARAMS не переносится | M | M1b (тулы в цикле — M3) |
| `providers/anthropic.ts` | adapt | `BR:src/stage/provider/anthropic-request.ts` (295), `anthropic-reply.ts` (183), `anthropic.ts` (29), `src/core/tokens/cache.ts` (311, уходит в данные); `RC:providers/adapters/anthropic.ts` (631) — антипример | Дословный replay внутри цикла тулов, без thinking между ходами. Mid-system по §8.5. Thinking по записи; без семплеров при `fixed`. Кэш-метки `ttl:'1h'` по `cacheMinTokens` | M | M7 |
| `providers/gemini.ts` | reference | `RC:providers/adapters/google.ts` (515), `base.ts` `toGoogleMessages` (118); `VV:packages/managed-ai/src/contracts/gemini-safety.ts` (87) | Новый адаптер вокруг replay `gemini-parts`. Ключ — в заголовке, id вызовов — настоящие `functionCall.id`. Портируются санитайзер схем (37 строк, с исправлением nullable) и список safety OFF | L | M8 |
| `providers/caps.ts` | fresh | Правило «нет поля — выключено» из `BR:openai-compatible-request.ts` и `src/kit/providers/spoke.ts`. Правило «неизвестно — не отправлять» из `VV:packages/managed-ai/src/reasoning-facts.ts` | Резолвер hosts → models (glob) → catalog → probe → user, со следом `source`. Пессимистичные умолчания | M | M1b → M3/M7/M8 |
| `providers/caps-data/{hosts,models}.json` | adapt | `BR:src/kit/providers/spokes/*.ts` (scene-декларации, 196); `src/stage/params/dialects.ts` (58); `reasoning-wire.ts` + `cache.ts`. `RC:providers/definitions.ts` (2 645, из ST); `adapters/openai.ts` стр. 170–370; `adapters/reasoning-effort.ts` (949, из ST); `managed-ai` reasoning-facts + nanogpt-reasoning (202) | Факты в JSON с полями `as_of` и `src` [D-54] | M | M1b (локальные и роутеры) → M7 (Claude) → M8 (Gemini) |
| `providers/probe.ts` | adapt | `BR:src/kit/providers/models.ts` (111); `RC:models/fetcher.ts` `parseCapabilities` (стр. 110–135); `RC:providers/tool-call-test.ts` — антипример (forced tool) | Лестница `/models` и разбор ответа (~60 строк) — порт. `/props`, `/api/show`, koboldcpp и активные пробы — новые. Проба только советует | M | M1b (каталог), M3 (активные пробы) |

- **Bunraku выигрывает для openai-chat и anthropic.** Все файлы `stage/provider` написаны Coneja-Chibi. У них:
  - чистые половины запроса и ответа;
  - ридер-замыкание на каждый запрос;
  - поддержка, объявленная явно;
  - тесты.
- **RoleCall — только источник фактов**, потому что:
  - синглтон Anthropic держит общее `_pendingToolBlocks`;
  - `parseStreamChunk` теряет вызовы тулов и заканчивает поток на `: OPENROUTER PROCESSING`;
  - на один провод три SSE-парсера;
  - возможности определяются регулярками.
- **Не переносить** — ни в коде, ни в тестах, которые эти дефекты закрепляют:
  - `thinking:{type:'disabled'}` на claude-opus-5-5 и claude-sonnet-5-5. Его утверждает `anthropic-request.regressions.test.ts` — этот тест нужно перевернуть;
  - безусловную `temperature`;
  - повтор подписанного thinking между ходами;
  - `function.name +=`;
  - пропуск ошибки OpenRouter, которая приходит с `choices` при HTTP 200;
  - `required → any`;
  - бета-заголовок кэша и безусловные кэш-метки;
  - оптимистичное «модель умеет тулы» по умолчанию;
  - «всё, кроме 401, — `backend_error`»;
  - общий таймаут Kit в 300 с.
- **Тесты Bunraku.**
  - Провайдеры:
    - `openai-compatible-request.test.ts` (334), `-reply.test.ts` (235) и regressions;
    - `anthropic-request.test.ts` (249, часть переписывается), `anthropic-reply.test.ts` (148), `anthropic.test.ts` (199).
  - Транспорт и разбор:
    - `egress.test.ts`, кейсы `guardedFetch` (стр. 49–125);
    - `stream-bytes.test.ts`;
    - `reasoning-tags.test.ts` (107) — прогнать на каждой точке разреза потока;
    - `models.test.ts` (81).
  - `test-fetch-harness.ts` (36) — как утилита.
- **Тесты RoleCall.**
  - `inhouse-nonstream-toolcall-sse.test.ts` стр. 464–600 уходит в `fixtures/sse/openai-chat`.
  - `gemini-thinking-parts.test.ts` (80) и `gemini-safety-extra-body.test.ts`.
- **Сколько стоит перенос тестов.** Все 19 тестовых файлов Bunraku построены на строковом `ProviderMessage`. Перевод на блоки займёт около половины времени порта. Каждый тест разбирается отдельно: оставить, перевернуть или выбросить.

### 19.5 Рассказчик, тулы, поиск

| Модуль | Вердикт | Источник (repo:path, строк) | Что меняется | Усилие | Веха |
|---|---|---|---|---|---|
| `engine/narrate.ts` | adapt | `BR:src/stage/provider/tool-loop.ts` (176), `src/kit/loop/stop-core.ts` (50). Справочно: `BR:src/kit/loop/loop-core.ts` (454), `RC:ai/narrator-engine/narrator-engine.ts` (1 118). Текст `finalCue`: `RC:ai/visual-novel-prompts.ts` стр. 788–792 | `AsyncGenerator` по §7.1 поверх `StreamEv`. Чтения параллельно через run.ts. Потолок 12 вызовов и защита «3 из 8» (stop-core). Вызовы финального раунда уходят в трассу с `notice`. `empty_response`; abort даёт типизированный результат. Разделитель раундов [D-55] | M | M1a (скелет без тулов), M3 (раунды) |
| `tools/types.ts` | reference | `BR:tool-loop.ts` стр. 14–45 (`ToolCallRecord`). Справочно: `src/kit/tools/tool.ts` (204), `RC:ai/narrator-engine/types.ts` (512) | По §9.1 плюс `inContext` и `pageChars` [D-56]. Запись вызова для трассы — без сырого текста результата | S | M3 |
| `tools/run.ts` | adapt | `BR:tool-loop.ts` стр. 65–81 и 127–164; `src/kit/loop/scheduler.ts` (39). Справочно: `src/kit/loop/dispatch.ts` (144), `RC:ai/narrator-engine/tool-executor.ts` (153) | Результаты в порядке вызовов; `Promise.all` с `ctx.signal`. Неизвестный тул, небезопасное имя и дубли id обрабатываются. Кап результата с пометкой `[cut: …]`. Эхо собирается из разобранных аргументов | S | M3 |
| `tools/args.ts` | adapt | `RC:ai/tool-call-repair/index.ts` (338), `layer1-jsonrepair.ts` (161), `layer2-schema.ts` (718, берётся только приведение скаляров), `layer3-validate.ts` (156) | Цепочка по [D-56]. Обязательные поля не заполняются умолчаниями, поля не выбрасываются молча. `schema-parser` и `tokenizer` (657) не берутся | M | M3 |
| `tools/prompted.ts` | port | `RC:ai/prompted-tool-calls/index.ts` (711); обрамление результатов — `RC:ai/btw/loop.ts` стр. 595–700 | Принимает `arguments` и `parameters`; аргументы — через args.ts. Каталог — в блоке ядра; стоп-последовательность `<tool_result`. Вырезатель с состоянием и `end()`, и в стриме тот же fence, что при сохранении | M | M3 (до M4: его использует tagged-режим Директора) |
| `tools/leaks.ts` | adapt | `BR:src/core/assembly/sanitize.ts` `stripToolCallLeaks` (13); `RC:ai/strip-tool-call-leaks.ts` (63), `dsml-tool-calls.ts` (236), `narrator-engine/content-tool-salvage.ts` (182) | `recoverLeaks(text, {offered, nativeCalls})`. Salvage возвращает спаны. Новые парсеры: `[TOOL_REQUEST]`, `[TOOL_CALLS]`, `<function=…>` | M | M1b (только вырезание), M3 (превращение в вызовы) [D-57] |
| `tools/builtin/history.ts` | adapt | `BR:src/studio/dramaturg-tools.ts` (210, Леви); `RC:ai/btw/scene-search.ts` (115), `btw/tools/search-scene-messages.ts` (271), `read-scene-messages.ts` (436) | Работает над `PathView`, ищет только в text-блоках. Сопоставление по основам — новое; фразы в кавычках — буквально. Страницы — по [D-58] | M | M3 |
| `tools/builtin/lore.ts` | adapt | `BR:dramaturg-tools.ts` стр. 122–201 (хэндлы `e3`). Справочно: `RC:ai/dm-stream/tools/executors.ts` стр. 4996–5052 и 4828–4847 | `search_lore` через `lexScore`; хэндлы `L12` и `C<n>` [D-59]; `read_lore` — до 8 000 символов | S | M3 (заметки), M5a (записи Compendium) |
| `text/normalize.ts` | fresh | Определение символа слова — `BR:src/core/lore/engine/key-word-boundary.ts` (35); разбор кавычек справочно — `BR:src/core/search/query.ts` стр. 160–184 | NFKC, lower-case, ё→е; класс слова и стоп-слова [D-46]; ~40 окончаний; кавычки «…» и “…” | M | M2 (класс символа слова и граница для `lore/keys.ts` [D-46]), M3 (`normalizeTerm`: стоп-слова, окончания, кавычки) |
| `text/lexscore.ts` | fresh | Справочно: веса 3/2/1 в `RC:executors.ts` стр. 5003–5040; `BR:src/core/search/query.ts` | Покрытие терминов → совпадения с ключом и заголовком → свежесть или `order` | S | M3 |

- **Цикл берётся из Bunraku `tool-loop.ts`.** Он уже устроен по контракту:
  - один цикл ведёт все вызовы;
  - каждый раунд стримится;
  - финальный раунд идёт с `tool_choice:'none'`, схемы остаются объявленными;
  - текст накапливается.

  Его 12 тестов переносятся почти напрямую. NarratorEngine RoleCall — только справочно: в нём разделённый первый вызов (§2, п. 5), и он привязан к inference-engine, биллингу и чекпоинтам.
- **Тулы берутся из RoleCall.**
  - `prompted-tool-calls` — чистый, 35 тестов, переносится почти целиком.
  - Из `tool-call-repair` (2 100 строк) берутся маркеры шаблонов, Layer 1, приведение скаляров и валидация с проверкой enum и maxLength.
- **`lexScore` — схема ядра, а не веса RoleCall.** RoleCall ставит запись «Брат Алексей» выше записи о трактирщице, где упомянут брат: сумма весов по одному слову бьёт полное покрытие запроса. Фикстура с этим расхождением фиксирует выбор.
- **Не переносить:**
  - чтение конверта `{"name","arguments"}` как `{}` в `prompted`. Layer 2 потом заполняет обязательные поля, и исполняется выдуманный вызов (`index.ts` стр. 365–376);
  - в RoleCall: незафлашенный carry-буфер и разное расширение fence в стриме и при сохранении;
  - в Bunraku: молчаливое игнорирование вызовов финального раунда, пустой ответ без сбоя, последовательные чтения;
  - в RoleCall: устаревший `lastRoundContent` и рассуждения, вклеенные как `<think>`;
  - подстрочный поиск `/btw`: «брат» находится внутри «братства».
- **Тесты.**
  - Bunraku `tool-loop.test.ts` (12) — через скриптовый провайдер.
  - Kit: `stop-core.test.ts` (6, без случая studio_read), `scheduler.test.ts` (3).
  - RoleCall `prompted-tool-calls` — три файла, 35 кейсов, 421 строка, с vitest на bun:test.
  - `repair.test.ts` — ~30 из 47. Кейс «заполняет обязательное поле умолчанием» превращается в «честно падает».
  - Протечки: vvs-257 strip (28 из 30), vvs-728 DSML (9 из 10), content-tool-salvage (8).
  - История: `scene-search.test.ts` (8 из 13), `read-scene-messages-paging.test.ts` (~8 из 14).
  - Новые фикстуры `ru`.

### 19.6 Story Director

| Модуль | Вердикт | Источник (repo:path, строк) | Что меняется | Усилие | Веха |
|---|---|---|---|---|---|
| `agents/structured.ts` | adapt | `BR:src/studio/scene-director-call.ts` (164), `src/core/director/attempt-error.ts` (23); `RC:ai/prompted-tool-calls/index.ts` (~120 из 711: `findOpenTag`, `findToolCallSpans`, `preCleanBody`, `widenOverFence`). Справочно: `RC:ai/dm/runDM.ts`, `inference-failure.ts` | Скелет `planTurn` из Bunraku: один бюджет, лог попыток, один корректирующий проход. Поиск спанов тега — из RoleCall, под `<plan>` и `<memory>`. Ветки structured и tagged, без forced `tool_choice`. Повторы — только по §6.6. Результат — по [D-60] | M | M4 (structured: openai-chat — после пробы M3, Anthropic — M7, Gemini — M8) |
| `agents/director/state.ts` | adapt | `BR:src/stage/contracts/director-types.ts` (379), `src/core/director/state.ts` (25), `bounds.ts` (66), `src/stage/store/director-rules.ts` `checkDirectorState` (~25 из 119); формула возраста — `RC:ai/dm-stream/seed-aging.ts` (126) | Урезанный `DirectorState` Bunraku [D-61]: без activity, edits, archive и trackerUpdates. Возрасты выводятся. Лимиты, `fitState`, `checkState` для `dir` с диска | M | M4 |
| `agents/director/momentum.ts` | port | `BR:src/core/director/momentum.ts` (190) и `enrichFromMomentum` из `directive.ts` (~45 из 82). Справочно: `RC:ai/dm-stream/momentum-engine.ts` (750) | Пороги — объект данных [D-63]. Возрасты считаются от `createdAtTurn`. Мёртвые `tensionPeaks` убираются. Тексты давлений: `commit_planning_round.arcUpdates/seedUpdates` → `arcUpdates`/`seedUpdates` (4 места), как в prompt.ts; `turnsActive` (7 мест) заменяется возрастом от `createdAtTurn` | S | M4 |
| `agents/director/plan.ts` *(новый)* | adapt | `BR:src/core/director/plan-schema.ts` (319), `plan-round.ts` (152). Политика терпимости — `RC:ai/dm-stream/tools/commit-planning-round.ts` (674), `dm-stream/schemas.ts` (220) | `PLAN_SCHEMA` без обёртки тула и новая `PLAN_SCHEMA_LITE`. `readPlan` пишет всё выброшенное в `skipped`. Секции-строки чинятся через jsonrepair. Строгость — по [D-62] | S | M4 |
| `agents/director/reduce.ts` | adapt | `BR:src/core/director/apply.ts` (266); `RC:ai/dm-stream/find-arc-match.ts` (113), `arc-title-sanitizer.ts` (78). Справочно: `DMStreamService.ts` | `applyPlan` без `now`. Сопоставление заголовков через `normalizeTerm`: `[^a-z0-9]` у Bunraku стирает кириллицу. Правило токенов RoleCall [D-63]; `cleanTitle` | M | M4 |
| `agents/director/prompt.ts` | adapt | `BR:src/core/director/prompts.ts` (230), `user-prompt.ts` (180), `self-audit.ts` (41), `history.ts` (38) | `commit_planning_round.X` → `X`. Раздел «How to answer» — только в tagged. `{{user}}` заменяется именем персоны. Бюджет истории — через `prompt/tokens`. Новый lite-промпт (~60 строк). Лимиты — по [D-64] | M | M4 (снимок мира `worldSnapshot` — M5a, §7.4.5) |
| `agents/director/personalities/*.ts` *(новый каталог)* | port | `BR:src/core/director/personalities/` — 10 личностей + `index` + `types` (3 906). Справочно: `RC:ai/dm/personalities/` (4 123) | Копируются как есть; по умолчанию `the-balanced` (Sage) | S | M4 |
| `agents/director/render.ts` | adapt | `BR:src/core/assembly/director.ts` (112), `directive.ts` `sanitizeForPlayerCharacter` (~40 из 82); параметр алиасов — `RC:ai/dm-stream/DirectiveBuilder.ts` (637) | Дескрипторы вставки `{depth:1, role:'system', source:'director'}` для depth.ts. Контракт — в блоке ядра, а не сообщением 0. Фильтр персоны — по [D-65] | S | M4 |
| `agents/director/call.ts` | adapt | `BR:src/studio/scene-director.ts` (174), `src/core/director/settings.ts` (34). Порядок шагов — `RC:DMStreamService` `processTurn`, `jobs/worker.ts` стр. 3812–4165 | `runDirector(view, cfg, binding, caps, kind, signal) → DirectorRecord`. Lite-профиль — по §7.3 (рев. 6: в `auto` — окно < 24 576 или полный промпт не помещается). Повторное использование на свайпе (~15 строк, ни в одном источнике его нет). Без `commitDirector` и без replay правок | M | M4 |
| `agents/director/edits.ts` *(позже)* | reference | `BR:src/core/director/edits.ts` (130); `tracker-round.ts` (177) не переносится | Когда появится `dirEdit`: правки — записи на пути, сопоставление по id+name как в Bunraku | M | после M9 |

- **Bunraku `core/director` — живой путь RoleCall в виде чистых функций.** `turn` и `now` передаются снаружи. Тестов — ~760 строк, плюс ~410 строк тестов хода, вызова и сборки.
- **RoleCall привязан к тому, что ядро взять не может:**
  - `DMStreamService` на 5 163 строки;
  - синглтон `dmToolRegistry`;
  - `DMContextStore` на Supabase;
  - `buildSlugId` из Compendium.

  Но краевые случаи RoleCall остаются эталоном:
  - терпимая схема директивы;
  - секции, присланные строкой;
  - ответ GLM-thinking;
  - терпимый поиск тега;
  - возраст семени от хода посадки.
- **Главное решение — [D-61].** Форма плана и состояния берётся из Bunraku и RoleCall, а не свежие `Plan`/`PlanOp`/`Arc{hidden}` из §7.3:
  - на имена этой формы завязаны ~35 мест в `user-prompt` и `momentum`, пример директивы и 3,9 тыс. строк личностей с историей в продакшене;
  - стык M9 становится почти 1:1.

  Там, где док лучше, меняется код:
  - возрасты выводятся;
  - журнала активности и правок в состоянии нет;
  - заголовки сопоставляются с учётом Unicode;
  - глубина 1 ставится через depth.ts;
  - контракт стоит в блоке ядра;
  - снимок мира — из Compendium ядра через `worldSnapshot` (§7.4.5).
- **Не переносить:**
  - forced `tool_choice` (он есть в обоих репозиториях);
  - «поддержка тулов unknown = нет»;
  - точное регулярное выражение для тега;
  - молчаливый фолбэк native → prompted в RoleCall;
  - собственный повтор Bunraku поверх общей политики: 429 дал бы три отправки;
  - `enable_thinking:true`;
  - счётчики `turnsActive`: они дрейфуют, в RoleCall семена упирались в 52;
  - двойную вставку контракта;
  - ASCII-границы `\b` и `[^a-z0-9]`;
  - состояние истории в system-промпте RoleCall: ломает кэш;
  - повтор прошлой директивы через `_isFallback` (VVS-195);
  - планирование на continue.
- **Тесты Bunraku.**
  - Состояние и лимиты: `bounds.test.ts` (74), `state.test.ts` (37), `fixtures.ts` (18).
  - Импульс, план, редьюсер: `momentum.test.ts` (88), `plan-round.test.ts` (87), `apply.test.ts` (182).
  - Промпт и сборка: `prompts.test.ts` (202), `assemble-director.test.ts` (77).
  - Директива: `directive.test.ts`, `directive-names.test.ts` (23).
  - Вызов и ход: `scene-director-call.test.ts` (47), ~120 строк из `scene-turn-director.test.ts` (288).
  - `fake-director-rig.ts` переезжает в `test/fixtures/scripts/director-*`.
- **Тесты RoleCall.**
  - Поиск тега: `attribute-open-tag` (164) и `fenced-tool-calls` (124) — переделанные под `<plan>`.
  - Терпимость: `arcUpdates-string-tolerance` (134), `cremecafe-glm-thinking` (169), `dm-schema-tolerance-prod-models` (173).
  - Дубли арок: `vvs-264-arc-dedup` (197).
  - `personalities.test.ts` (92).
- **Шапки.**
  - Файлы Директора в Bunraku — коммиты Coneja-Chibi: 0a4580d3, 16b2c4b5, a903d380, 6e99180b.
  - В текстах промптов и личностей — ещё NemoVonNirgend (дополнения от 2026-06-23: `8dd337172`, `95059ab5d`).
  - Апрельские коммиты — Coneja-Chibi: импорт `660a7d67a` (12.04) и разбиение личностей `ca8a2723f` (28.04). Авторы до импорта — по «Ограничению git» выше.
  - `seed-aging` — Levi.

### 19.7 Compendium (рев. 6)

*Рев. 6.* Группа «Летописец и Хроника» заменена Compendium целиком [D-26].
- **Источник** — Bunraku @702d8120: `src/core/compendium` и `src/studio/compendium-*`, переработка Chi вкладки tv-stream RoleCall.
- **Из RoleCall @fb8dc623e** берутся слияние, свежесть и вложенные схемы.
- Строки пересчитаны `wc -l` для этого прохода. Размеры промптов замерены `countText` Bunraku из песочницы, без записи в репозиторий.

| Модуль | Вердикт | Источник (repo:path, строк) | Что меняется | Усилие | Веха |
|---|---|---|---|---|---|
| `agents/compendium/types.ts` | port | `BR:src/core/compendium/types.ts` (37), `entry-types.ts` (81); вложенные формы и enum — `RC:ai/dm-stream/tools/compendium-definitions.ts` стр. 1945–2757 (3 561) | SPEC дословно: 11 типов, 223 поля, `REQUIRED_FIELDS`, `parseStructured`, `identityField`. Токены темы UI убираются. Новые таблицы `LITE_FIELDS` и `NESTED` — только для промптов | S | M5a |
| `agents/compendium/merge.ts` | adapt | `BR:merge.ts` (51); `RC:…/compendium-definitions.ts` стр. 66–365: `ARRAY_KEY_FNS` (стр. 105), почти-дубли (стр. 200–264), `mergeStructuredData` (стр. 318) | Слияние Bunraku плюс ключи массивов и схлопывание почти-дублей RoleCall. Слова — через `normalizeTerm`: `[^a-z0-9]` у RoleCall стирает кириллицу [D-81] | M | M5a |
| `agents/compendium/render.ts` | port | `BR:render.ts` (42) | `renderContent` дословно; `renderBrief` — новый, ≈ 80 строк | S | M5a |
| `agents/compendium/apply.ts` | adapt | `BR:read.ts` (57), `snapshot.ts` — `findMatch` и `entryNames` (~25 из 67), `filing-stage.ts` (80), `relationships.ts` — `normalizeName` (стр. 39 из 107) | `applyMemOp` для `file`, `arc`, `note`, `edit`, `retire`, `restore`; оверлеи библиотечных записей; `prov` для свежести; пересказ не сливается по заголовку. Квитанции и `entry-fields.ts` (118) не нужны | M | M3 (заметки), M5a |
| `session/fold.ts` → `compendiumAt` (доля модуля из §19.2) | fresh | Сценарии — `BR:studio/compendium-hooks.ts` (107), `compendium-undo.ts` (96) | Привязка к пути, устаревание [D-68], «новейшее действие по ключу» [D-74], кэш по `(version, lastMemSeq, хеши книг)`, бенчмарк на 5 000 строк | M | M5a |
| `agents/compendium/tree.ts` | port | `BR:tree.ts` (213) | Без изменений; вход — свёртка и читаемые книги | S | M5a |
| `agents/compendium/{select,place}.ts` | adapt | `BR:core/assembly/recall-place.ts` (38); `RC:ai/tv-stream/compendium-freshness.ts` (127) | Ярусы упоминания, свежесть по происхождению [D-80], дедупликация с лором и слотом, пол доли лора, краткий рендер [D-77]; маршрутизация записей книг [D-76] | M | M5a |
| `agents/compendium/world.ts` | adapt | `BR:core/director/compendium-snapshot.ts` (80). Справочно: `RC:ai/dm-stream/compendium-bridge.ts` (219) | `worldSnapshot(view, budget)` по §7.3: основы вместо точных слов, порядок по `prov.lastSeq`, обрезка полей, `WORLD_FULL` и `WORLD_LITE` | S | M5a |
| `formats/compendium-v1.ts` | adapt | `BR:src/formats/rolecall/compendium.ts` (218) | Чтение в библиотечную книгу с `meta.type`, `meta.data` и `meta.arc`; писатель копии потоком, `tree: null`; распознавание в `rp-core import` [D-72] | M | M5a |
| `cli/repl.ts`, `tools/builtin/lore.ts` — доля Compendium | fresh | Справочно: `BR:studio/compendium-lookup.ts` (108) | Команды `/memory`: new, show, tree, edit, retire, restore, list. `search_lore` и `read_lore` по Compendium с хэндлами `C<n>` [D-59] и рендером | M | M5a |
| `engine/lane.ts`, `engine/sched.ts` — доля Compendium (сверх §19.2) | fresh | Сценарии — `BR:studio/compendium-hooks.ts` (107), `compendium-queue.ts` (20); `RC:ai/tv-stream/postgen-write-delay.ts` (115) | Задачи `prerecall`, `file` и `hist`, их порядок, покрытие по `range` (отменённые проходы — покрыты), `wait` и `everyN` [D-86]; семафор по origin, правило локального origin, задержка фона `idleDelaySec`, счётчик вытеснений и голодание; ожидание prefetch в полёте [D-84] | M | M5b |
| `agents/compendium/filing.ts` | adapt | `BR:filing-prompt.ts` (68), `filing-schema.ts` (86), `filing-stage.ts` (80), `snapshot.ts` (67), `studio/compendium-filing.ts` (139); правило памяти — `RC:…/compendium-definitions.ts` стр. 2786–2805 | Промпт full дословно с тремя правками; новый промпт lite с ростером; терпимое чтение [D-82]; постановка в дельты; бюджет user при `everyN > 1`. Правило памяти адаптировано: выбрасывается память, а не весь вызов | L | M5b |
| `agents/compendium/historian.ts`, слот `{{recap}}` | adapt | `BR:historian.ts` (160), `studio/compendium-historian.ts` (95), `compendium-recap-write.ts` (35), `compendium-ask.ts` (34); `RC:ai/tv-stream/summary-watermark.ts` (147) | Позиции и диапазоны пути [D-58, D-68], два триггера, проверка при каждом принятии ответа, водяной знак из неустаревших строк historian (отменённые и списанные не пишутся заново), обзоры `[Arc]` в слоте [D-83] | L | M5b |
| `agents/structured.ts` — доля Compendium | adapt | `firstObject` из `BR:recall-parse.ts` (58) | Агенты `recall`, `filing` и `historian`; `tag: null` — голый JSON, как в промптах Bunraku [D-85] | S | M5b |
| `protocol/events.ts`, `commands.ts` — доля памяти | fresh | — | События `agent` и `memory`, команды `memory/*` (провод — M6) | S | M5b |
| `agents/compendium/recall/{index,prompt,parse}.ts` | port | `BR:recall-index.ts` (95), `recall-prompt.ts` (55), `recall-parse.ts` (58) | Индекс зажат окном, tagline выводится, беседа ограничена и по токенам; lite-промпт и шорт-лист; чтение голого массива, имён и выловленных хэндлов | M | M5c |
| `agents/compendium/recall/run.ts` | adapt | `BR:studio/compendium-recall.ts` (152); порядок — `BR:studio/scene-turn.ts` стр. 175–183. Справочно: `RC:ai/tv-stream/pregen-retrieval.ts` (1 604), `pregen-retrieval-cache.ts` (262) | Режимы, prefetch и ожидание в пределах `graceSec`, Stop без потери prefetch, дедлайн от гранта, бюджет на рассуждения, лексический откат, `RecallRecord` в `prep` и коммите вместо LRU [D-78] | L | M5c |
| `agents/compendium/{profile,lexical}.ts` | fresh | — | Таблица профилей [D-79]; шорт-лист и ростер через `lexScore`; проверка запроса рассказчика на малом окне и `history_crowded` [D-89] | S | M5c |
| `providers/probe.ts` — доля слотов | fresh | — | `GET /slots` и `total_slots` в `/props` → `notice{slots_detected}`, ёмкость не поднимает; проверка закрепления `id_slot` по `/slots` [D-84] | S | M5c |
| `cli/bench.ts` и документация пресетов | fresh | — | `rp-core bench ttft`: скриптовый прогон, TTFT и `timings.prompt_n`; матрица M5c | M | M5c |

**Итог группы:**
- 20 строк: port — 4, adapt — 9, fresh — 7;
- ≈ 3 700 строк ядра: port ≈ 800, adapt ≈ 1 950, fresh ≈ 950;
- 29,5–48,5 дня: 8 × S, 9 × M, 3 × L.

Вместе с M5-долями `lane.ts` и `sched.ts` из §19.2 веха M5 занимает 32–52 дня (§15). Оценка рев. 4 в 1 900–2 400 строк не учитывала свёртку с оверлеями, расписание recall, профили, полосу и кодек.

- **Почему основа — Bunraku.** Chi уже свела 8-раундовые циклы тулов RoleCall с `tool_choice:'required'` к одному JSON-ответу и одному ремонту — это ровно контракт `structuredCall`. Данные, рендер, дерево и разбор там — чистые функции. RoleCall даёт то, чего нет в Bunraku:
  - ключи массивов при слиянии;
  - фильтр свежести по памятям персонажа;
  - вложенные схемы;
  - правило «память — только с изменённым убеждением или поведением»;
  - регрессионные тесты.
- **Не нужно** (≈ 470 строк): `entry-fields.ts` (118), `studio/compendium-undo.ts` (96), `compendium-commit.ts` (83), `compendium-deps.ts` (53), `compendium-queue.ts` (20), `world-book-writer.ts` (101). Откат даёт свёртка строк `mem`.
- **Позже** — §7.4.10: reconcile, diagnostics, ingest, standardize, refine, дерево от модели, dossiers, dashboard, smart context.
- **Не переносить:**
  - принудительный `tool_choice` — добор RoleCall, `pregen-retrieval.ts:627`, и traversal с `required`, `:1429`;
  - `RECALL_INDEX_TOKENS` без учёта окна и беседу recall без предела по токенам;
  - `MAX_RETRIEVED_CHARS = Infinity` (`RC:pregen-retrieval.ts:83`);
  - причины селектора в промпте рассказчика (`RC:jobs/worker.ts:4112`);
  - LRU-кэши recall в памяти процесса: 32 записи у Bunraku, 256 у RoleCall;
  - таймаут recall 90 с; filing и historian без таймаута и сигнала;
  - слияние массивов только по `deepEq`; ASCII-токены почти-дублей;
  - `everyN` с потерями;
  - диапазоны пересказов по индексам живых сообщений;
  - водяной знак по живым пересказам, из-за которого отменённый или списанный пересказ пишется снова;
  - обзоры `[Arc]` как константные записи лора;
  - `Math.random` в условных записях RoleCall (`pregen-retrieval.ts:908`);
  - traversal-режим и `node_ids` RoleCall.
- **Тесты Bunraku** переписываются на скриптовый провайдер и строки `mem` — ≈ 1 980 строк исходников:
  - `core/compendium/compendium.test.ts` (332), `filing.test.ts` (213), `historian.test.ts` (68), `recall-core.test.ts` (135), `defaults.test.ts` (25);
  - `core/assembly/assemble-recall.test.ts` (108);
  - `studio/scene-turn-recall.test.ts` (291) → тесты хода;
  - `compendium-filing.test.ts` (244), `compendium-historian.test.ts` (184), `compendium-hooks.test.ts` (201) → тесты полосы и свёртки;
  - `core/director/compendium-snapshot.test.ts` (71);
  - `formats/rolecall/compendium.test.ts` (107).

  Фикстура — `fixture-book.ts` (63 строки, 239 записей). Тесты diagnostics (109) и reconcile (85) — вместе с этими проходами.
- **Тесты RoleCall:** `tv-stream/__tests__/compendium-freshness.test.ts` (133), `summary-watermark.test.ts` (150), `scene/__tests__/branch-trim-freshness.test.ts` (42); случаи `ARRAY_KEY_FNS`.
- **Новые тесты:**
  - **свёртка:** свайп, откат, форк; та же операция на любом подмножестве строк; refile и revert; отменённый проход остаётся покрытым; оверлей, правка книги посреди сессии, пропавшая основа; устаревание; пересказы не сливаются; «Мира/Миру/Мирой»; бенчмарк;
  - **профили:** каждый запрос агента ≤ окно − резерв на окнах 8k, 16 384, 24k, 32k и 128k; запрос рассказчика на 16 384 оставляет истории ≥ 25 % окна;
  - **чтение filing:** корпус ответов слабых моделей — записи qwen3-14b через record/replay и ручные случаи;
  - **селектор и свежесть**;
  - **recall:** prefetch, ожидание в полёте, Stop во время ожидания, промах, повтор после перезапуска, таймаут с лексическим откатом, Stop отдельно от таймаута;
  - **полоса:** порядок, вытеснение без попытки, вытеснение на локальном origin при свободном месте, задержка фона и сброс таймера свайпом, голодание, `kill -9` → одна действующая строка на ключ;
  - **паритет:** тексты промптов full совпадают с Bunraku, кроме перечисленных строк [D-88].
- **Шапки.** Файлы Compendium в Bunraku — коммиты Coneja-Chibi (по карте рев. 4), копирайт из `LICENSING.md` Bunraku. `compendium-definitions.ts`, `compendium-freshness.ts` и `summary-watermark.ts` RoleCall — по «Ограничению git» (вступление §19).

### 19.8 Форматы и конфиг

| Модуль | Вердикт | Источник (repo:path, строк) | Что меняется | Усилие | Веха |
|---|---|---|---|---|---|
| `formats/native.ts` | fresh | `BR:src/core/guards.ts` (~40 из 94), `src/core/canonical.ts` `canonicalId`. Чек-лист полей — `BR:src/entities/*/schema.ts` (1 145). Справочно: `RC:ai/preset-loader.ts` стр. 206–230 | Типы §5.1 и §10.2 плюс ручные валидаторы с путём ошибки. `BUILTIN_PRESET`. `extras` и `Imported<T>` [D-70]. Без Zod | M | M1a |
| `formats/card.ts` | adapt | Обход чанков — `RC:import/png-parser.ts` (171). `BR:src/formats/_shared/png.ts` (~30 из 156: приоритет ccv3); `sillytavern/index.ts` `detectCard` (~45 из 225); `_shared/tavern-fields.ts` (~50 из 258); `character-book-decode.ts` (313); `kind-markers.ts` (46). `ST:world-info.js` `convertCharacterBook` | PNG без зависимостей: tEXt, iTXt и zTXt через `node:zlib`. ccv3 приоритетнее chara. V3/V2/flat/V1 разбираются за «файерволом» от пресетов и worldbook. `depth_prompt`. Книги из трёх мест сливаются в одну `book` | M | M1a |
| `formats/st-worldinfo.ts` | adapt | `BR:src/formats/sillytavern/lorebook.ts` (369), `_shared/lore-enums.ts` (~35 из 83). Справочно: `RC:lorebook/parser.ts` (1 359). `ST:world-info.js` стр. 880–889 и 5894 | Один `stPosition()` для позиций 0–7 по ST. Маппинг почти тождественный. Несколько групп через запятую [D-70]. Отсутствующее поле остаётся отсутствующим | S | M1a (маппер записи), M2 (файлы WI) |
| `formats/st-preset.ts` | adapt | `BR:src/formats/_shared/st-preset-wire.ts` (396), `src/core/assembly/preset.ts` `fillSlots` (стр. 50–177). Справочно: `BR:src/formats/sillytavern/preset.ts` (111), `VV:packages/presets-core/src/preset-parser.ts` (1 153), `RC:ai/preset-loader.ts` стр. 559–845. `ST:openai.js` | Закон `prompt_order` 100001. Маркеры превращаются в слот-макросы при импорте. Ключ `custom_prompt_post_processing`. `Preset.formats` [D-70]. Выключенный маркер ничего не отправляет [D-71] | M | M2 |
| `config/config.ts` | fresh | `BR:src/kit/providers/config.ts` (69) — паттерн переопределения home | `Bun.TOML.parse`. Привязка делится по первому `:`. Ссылка `'narrator'`. Ключи в файле — отказ. Ошибки с путём [D-73] | M | M1b |
| `config/secrets.ts` | reference | Семантика secret-tool — `BR:src/kit/keystore/backends/linux-secret.ts` + `keychain-key.ts` + `spawn-collect.ts` (292) | `key_env` и `key_cmd` через `Bun.spawn` без оболочки, таймаут 10 с. `scrub()`. Хранилище Kit не берётся | S | M1b |
| `formats/import.ts` *(новый)* | adapt | `BR:src/formats/_shared/repair-json.ts` (85), `kind-markers.ts` (46). Справочно: `RC:imports/content-detector.ts` (251) | Фиксированный порядок распознавания; двойной JSON и конверты; запись в library под `canonicalId`; команда `rp-core import` [D-72] | S | M1a (карточки), M2 (пресеты, книги) |

- **Ни один адаптер не переносится целиком.**
  - `formats` Bunraku рассчитан на богатую каноническую модель: original/escrow, профили, медиа, Zod, реестр адаптеров по очкам, три npm-библиотеки PNG.
  - RoleCall пишет строки Supabase и штампует умолчания.
  - Типы ядра нарочно маленькие и повторяют форму ST, поэтому импортёры тонкие. Из Bunraku берутся правила и мелкие чистые помощники.
- **Правила берутся из Bunraku:**
  - ccv3 приоритетнее chara;
  - «файервол», чтобы пресеты и worldbook не читались как карточки;
  - пустой `depth_prompt` означает «заметки нет»;
  - закон `prompt_order` 100001;
  - отсутствующее остаётся отсутствующим;
  - правильный ключ `custom_prompt_post_processing`;
  - приведение чисел, записанных строками.

  RoleCall выигрывает в одном: у него единственный обход PNG без зависимостей.
- **Enum позиций WI берётся из SillyBunny.**
  - Оба репозитория, и спецификация Bunraku тоже, отображают позиции 2/3 в examples, а 5–7 — в `'character'`. Ошибка есть и в декодере WI, и в декодере `character_book`.
  - Регрессия: в `BR:samples/sillytavern/lorebooks/Eorzea-FFXIV.json` одна запись стоит на позиции 3 и должна стать `note_after`.
- **Не переносить:**
  - первый попавшийся чанк в `RC:formats/png/writer.ts` (понижает V3 до V2);
  - `extensions` как признак V2;
  - `depth_prompt` в `_rawExtensions`;
  - падение `png-chunk-text` на iTXt;
  - `scanDepth` 100 и 4;
  - `order → priority` и `displayIndex → sortOrder`;
  - случайные UUID;
  - ключ `prompt_post_processing`;
  - штамп `DEFAULT_PRESET_SAMPLERS` и старых форматов;
  - синглтон расшифрованного vault;
  - токен Spotify рядом с ключами LLM.
- **Тесты Bunraku:**
  - `canonical.test.ts` (7);
  - `png.test.ts` — регрессия порядка чанков. Носитель собирается тестовым PNG-писателем на ~20 строк;
  - `card-io-parse`, `sillytavern.test.ts`, `tavern-fields.test.ts`, `character-book.test.ts`, `lorebook.test.ts`;
  - `preset.test.ts` на `spec-walk.preset.json`;
  - `st-preset-tolerance.test.ts`;
  - `repair-json.test.ts` (111), `kind-markers.test.ts` (29);
  - `spawn-collect.test.ts` (16) — как форма.
- **Тесты RoleCall:**
  - vvs-745;
  - `lorebook/parser.test.ts`;
  - `prompt-post-processing-roundtrip.test.ts` — с перевёрнутым ожиданием;
  - `preset-marker-slots.test.ts`.
- **Фикстуры:**
  - `Seraphina.png` (ST default, AGPL), `v3-full.json`;
  - `BR:samples/sillytavern/fixtures/*.preset.json` и `presets/{plain,tracker}`;
  - SillyBunny `Default.json`. Сторонние пресеты из SillyBunny не брать: их лицензия неясна;
  - новые: карточка V2 с `depth_prompt` и карточка в iTXt.
- **На M1 рантайм-зависимостей нет:** PNG читается своим обходом плюс `node:zlib`, TOML — через `Bun.TOML.parse`. Встроенные в карточку книги хранятся с M1a, а срабатывают с движком лора на M2.

### 19.9 Что не портируем и почему

- **Части Compendium вне v1 (рев. 6).** Compendium портируется целиком (§19.7). Не переносятся квитанции, undo и запись в книги Bunraku (≈ 470 строк): их заменяет свёртка строк `mem`. Построенное моделью дерево, refine, standardize, dossiers и dashboard остаются в Bunraku или идут позже (§7.4.10). Из RoleCall (≈ 17 600 строк Compendium) берутся только слияние, свежесть и вложенные схемы.
- **Plan C — Character Minds.** Это `RC:ai/tv-stream/tools/*` (≈ 1 700 строк), `mind-stream` (≈ 550) и `lib/character-mind` (≈ 7 500).
  - Работа Леви, портировать можно.
  - В v1 не входит (§7.6, D-4): нужны Supabase, pgvector и эмбеддинги.
  - После M9 — отдельным агентом на `structuredCall`.
- **Расширения хода Bunraku** остаются в Bunraku (§12.5) или выключены (recall Compendium теперь в ядре, §7.4): трекеры и `tracker-round`, regex-гейт, Final Cut, Smart Recovery, Inspector, meter, переменные до отправки, глобальные переменные.
- **Обвязка RoleCall:**
  - `worker.ts` (11 008 строк), `DMStreamService` (5 163), `prompt-assembly.ts` (4 590), `NarratorEngine` (1 118);
  - inference-engine, биллинг, долговечные чекпоинты, строки Supabase, синглтон `dmToolRegistry`.
- **ChatStore Bunraku** — 90 методов и 48 правил, ветки как полные копии, SQLite. Берётся только паттерн conformance-тестов.
- **Kit:**
  - Vercel AI SDK: из стека берутся только `guardedFetch`, лестница `/models` и факты спиц;
  - REPL на OpenTUI;
  - vault и keystore (≈ 900 строк без тестов: AES, связки ключей ОС) — по D-20;
  - MCP-сервер.
- **Полный движок макросов Bunraku** (6 704 строки, 30 семейств): block-if, dot/$, scopes, структурированные переменные, сегменты превью.
- **Подсчёт токенов и бюджет Bunraku:**
  - реестр PARAMS;
  - Budgeter-паритет;
  - байесовская калибровка счётчика токенов с персистентным кэшем.
- **Тяжёлая починка и эвристики:**
  - Layer 4 и `schema-parser`/`tokenizer` (657 строк) из `tool-call-repair` RoleCall;
  - эвристики `thinking-tags` RoleCall (1 800 строк) и look-alike теги Bunraku;
  - reasoning-rescue;
  - `image-payload-compat`: учится по тексту ошибок, а это запрещает §8.2.
- **Устаревшие таблицы моделей:** `models.ts` RoleCall (эпоха gpt-4o) и `known-context.ts` Bunraku. Их заменяют записи с `as_of` [D-54].
- **Позже:**
  - экспорт карточек, пресетов и лорбуков;
  - импорт RoleCall, Marinara и ST-чатов;
  - `.vnpack` (или на M2 по вопросу 10);
  - правки Директора человеком (`edits.ts`).

### 19.10 Изменения контракта по итогам порта (D-35…D-89)

*Статус на 26.10:*
- D-35…D-73 приняты: D-61, D-62, D-71 — 25.10, остальные — 26.10 пакетом, D-43 с правкой;
- D-74…D-89 приняты 26.10 (вопросы 16–20).

Оценщики предложили эти изменения там, где исходник лучше или проще контракта. Синтез отбросил предложения, которые нарушают обязательные правила документа: глубину ST [D-12], запрет принудительного `tool_choice`, один цикл на все вызовы, хранение в JSONL-дереве и простоту. Статус всех — **ждут подтверждения**. Отдельного внимания требуют D-61 (форма состояния Директора), D-62 (строгость директивы, вместе с D-17) и D-71 (выключенные маркеры ST-пресетов, вместе с вопросом 11).

#### D-35 (§5.3, §15)
- **Изменение.** `rp-core compact` переезжает на M4. Раньше подразумевалось, что он есть на M1.
- **Почему.** Файл раздувают снимки Директора, а они появляются на M4. До этого компактизация ужимает только `chk` и `prep` закрытых ходов. Перенос снимает работу с самой тяжёлой вехи.
- **Рекомендация.** Принять.

#### D-36 (§4, §5.3, §12.2, §12.3, §15)
- **Изменение.** Журнал и протокол читают строки одним сплиттером по LF — `protocol/jsonl.ts`. В нём две функции: `lines(stream)` для stdin и `splitLines(bytes) → {lines, torn}` для файла. Последний неоконченный сегмент на stdin считается строкой, а в журнале — рваным хвостом (`torn`).

`jsonl.ts`, `coalesce.ts` и типы `events.ts` появляются уже на M1. One-shot `send --json` пишет события через тот же склеивающий писатель, что и `--stdio`. Пачка склейки собирается по ключу (session, turn, type). Любое другое событие сначала выталкивает пачку.
- **Почему.** §4 сейчас кладёт чтение по LF и в `log.ts`, и в протокол — получается два сплиттера. Склейку по 40 мс / 768 символов уже реализует Bunraku (`coalesceTurnEvents`). CI гоняет `send --json` с M1, и формат событий не должен меняться на M6.
- **Рекомендация.** Принять.

#### D-37 (§3, §8.8, §15)
- **Изменение.** `sched.ts` строится в два этапа. На M1 это простой семафор на соединение: им пользуются рассказчик и Директор. Приоритеты interactive/background и вытеснение добавляются на M5, вместе с `lane.ts`.
- **Почему.** Пока нет Летописца, нет и фоновых запросов, так что вытеснять нечего. Приоритетного семафора нет ни в одном репозитории — это новый код, и его разумно писать вместе с первым потребителем.
- **Рекомендация.** Принять.

#### D-38 (§6.1, §6.6, §12.2)
- **Изменение.** Добавить два кода.

- **Отказ `invalid_params`.** Возникает, если guidance передан для хода, который не swipe, или длиннее 10 000 символов. В протоколе — ещё и если params имеют не тот вид.
- **Сбой `commit_deferred`.** Ответ пришёл полностью, но не записался. Чекпоинт остаётся, и ответ появится при следующем открытии.
- **Почему.** Bunraku бросает `StudioValidationError` ещё до открытия хода. Ситуацию «ответ есть, записи нет» он отдаёт общим `backend_error` с черновиком, и клиент не знает, что ответ вернётся. §6.6 уже описывает это поведение, но кода для него нет.
- **Рекомендация.** Принять.

#### D-39 (§6.1, §12.2, §12.5)
- **Изменение.** `answerGate` возвращает boolean: `false`, если на этом гейте никто не ждёт, — так же, как `answer()` в Bunraku. Протокол переводит `false` в ошибку `gate_not_waiting`.
- **Почему.** Сейчас поздний или повторный ответ на гейт ничем не отличается от принятого.
- **Рекомендация.** Принять, веха M9.

#### D-40 (§14)
- **Изменение.** У скриптового провайдера появляется шаг `{pause:'<имя>'}`. Поток стоит, пока тест не отпустит его программно. Это паттерн gate из скриптового провайдера в тестах Bunraku.
- **Почему.** Иначе тесты Stop, конфликта и восстановления зависят от таймингов `{delay}` и становятся нестабильными.
- **Рекомендация.** Принять.

#### D-41 (§6.3)
- **Изменение.** Блок guided re-roll остаётся одним system-блоком на глубине 0, но меняется его содержимое:
- формулировка указания берётся из guided-swipe RoleCall и Bunraku;
- добавляется метка `[REJECTED DRAFT - NOT PART OF THE STORY]`;
- отвергнутый текст (до 2 000 символов) огорожен внутри блока.
- **Почему.** В RoleCall отвергнутый черновик уходит assistant-сообщением, а за ним идёт system. У Anthropic такое невалидно (§8.5). Огороженный текст читается как цитата, даже если проза в нём имитирует директиву.
- **Рекомендация.** Принять.

#### D-42 (§10.4)
- **Изменение.** Значения полей карточки и персоны, которые подставляет слот-макрос, тоже считаются шаблонами. Они раскрываются в том же проходе, с ограничением глубины 100. Инертны только история и вывод модели. Правило «каждый блок раскрывается один раз» относится к блокам, а не к подставленным значениям.
- **Почему.** Карточки ST массово содержат `{{char}}` и `{{user}}` в description и scenario. ST, RoleCall и Bunraku раскрывают их. Если читать правило буквально, в промпт уйдут сырые макросы.
- **Рекомендация.** Принять до начала M1a.

#### D-43 (§10.4, §6.9)
- **Изменение.** Три изменения в макросах.

1. Поддержать устаревшие формы ST, которые встречаются в импортированных карточках и пресетах: `<USER>`, `<BOT>`, `<CHAR>`, экранированные `\{\{`, формы с одним двоеточием и с пробелом (`{{random:a,b}}`, `{{roll 1d20}}`).
2. `{{random::a::b}}` выбирает элемент из списка, как в ST, с экранированием запятых. Числовой диапазон, как в RoleCall, не поддерживается.
3. `{{pick}}` получает seed из хеша (id сессии, источник блока, текст блока, смещение) и сохраняет выбор между ходами и свайпами, как `getPickReplaceMacro` в ST. `{{random}}` и `{{roll}}` остаются на seed хода. Во вход `assemble` добавляется id сессии.
- **Почему.** Без устаревших форм импортированные карточки дают сырой текст. Числовой `random` RoleCall расходится с ST, и у него есть баг с отрицательным диапазоном. Если `pick` меняется на каждом свайпе, макрос теряет смысл.
- **Рекомендация.** Принять.
- **Статус.** Принято 26.10 с правкой для экспортов RoleCall — по той же логике, что D-71.
  - В RoleCall `{{random}}` без аргументов даёт целое от 0 до 100, `{{random::a}}` — от a до 100, `{{random::a::b}}` с числами — от a до b. С тремя и больше аргументами или с текстом это выбор, как в ST (`handlers/random.ts`, стр. 45–85).
  - Импортёр пресета с `extensions.rolecall` переписывает числовые формы в явный список `{{random::a::…::b}}`, если в диапазоне не больше 101 значения. Шире — оставляет как есть и выдаёт предупреждение `rc_random_range`.
  - ST-пресеты и карточки читаются по правилам ST без изменений.

#### D-44 (§6.9)
- **Изменение.** Подпотоки RNG выводятся через splitmix32 по метке: `lore.prob`, `lore.group`, `macro:<источник блока>`. Сам поток генерирует mulberry32. Каждый источник блока получает свой подпоток, а не номер по счётчику вызовов.
- **Почему.** На mulberry32 работает Bunraku и записан корпус макросов RoleCall, поэтому его случайные записи воспроизводятся. Схема Bunraku `randomSeed + calls++` перетасовывает все последующие `{{random}}`, если добавить или убрать один блок пресета. Для паритета с корпусом тест подаёт блоку `mulberry32(entry.seed)` напрямую, минуя `sub()`; в рабочем пути — подпотоки по метке.
- **Рекомендация.** Принять.

#### D-45 (§5.7, §10.3)
- **Изменение.** Вердикты лора в трассе не хранятся. Трасса держит только `fired` и `cut`. `/lore test`, `/trace` и `/preview --turn` пересчитывают вердикты из seed и `now`.

Словарь причин `why` берётся из перечисления LoreVerdict Bunraku:
- срабатывания: constant, key, secondary, sticky, recursion;
- отказы: disabled, no-key-match, secondary-logic, chance, cooldown, delay, budget-cut, exclude-recursion, group-lost;
- плюс regex-error.
- **Почему.** AssemblyResult Bunraku несёт до 1 000 вердиктов на ход, а трасса рассчитана на 1–3 КБ. Сборка детерминирована, поэтому пересчёт точен. Вместо нового словаря берётся готовый и проверенный.
- **Рекомендация.** Принять.

#### D-46 (§7.5, §10.3)
- **Изменение.** В `text/normalize.ts` — одно определение слова для поиска, ключей лора и стемминга.

- Символ слова — `\p{L}\p{N}\p{M}`. Для границы ключей лора к нему добавляется `_`, как в ST.
- Письменности без пробелов (Han, Hiragana, Katakana, Thai) сопоставляются подстрокой, как в Bunraku.
- Фразы можно брать не только в прямые кавычки, но и в «…» и “…”.
- Перед AND из запроса выбрасывается короткий список служебных слов ru/en: и, в, на, по, как, the, a, of.
- **Почему.** Без `\p{M}` комбинирующие знаки режут слово посередине: NFD-ударения, разложенные й и ё. Если не выделить CJK, ключи «целым словом» перестанут срабатывать внутри текста — это регрессия против ST и RoleCall. Модель пишет запросы вроде «как звали брата», и AND проваливается на «как». Ёлочки нужны, потому что Леви пишет по-русски.
- **Рекомендация.** Принять.

#### D-47 (§10.1, §14)
- **Изменение.** Два уточнения про глубину.

1. Именованное отклонение для golden-снимков SillyBunny. ST склеивает вставки с одинаковыми глубиной, order и ролью в одно сообщение через перевод строки. Внутри одного order он ставит system после user и assistant. Ядро держит блоки раздельно, чтобы каждый источник был виден в трассе.
2. `prompt/depth.ts` экспортирует `fromRcDepth(d) = d + 1`. Её вызывают только импортёры (пресеты RoleCall, экспорт с `extensions.rolecall`) и перевод ожиданий rc-recorder.
- **Почему.** Если отклонение не записать, golden-тесты против SillyBunny будут падать на ожидаемом расхождении. Правило +1 живёт в одном месте, как требует §2 п. 6.
- **Рекомендация.** Принять: согласуется с D-12.

#### D-48 (§6.2 шаг 5, §8.4, §4)
- **Изменение.** `shape.ts` применяет `Preset.postProcessing` (none / merge / semi / strict / single по ST) до правил записи возможностей. При этом он учитывает блоки: сообщения с tool_call или tool_result и сообщения с разным `placement` не склеиваются.

Граница ответственности:
- `shape.ts` делает всё, что не зависит от диалекта: post-processing, решение о префилле, строгое чередование, mid-system в режиме as-user для роутеров;
- адаптеры делают проводное: ведущий system-прогон, размещение по §8.5, `cache_control`.

Следом правятся §4 (комментарий `shape.ts` — «роли, префилл, post-processing») и §6.2 шаг 5 (кэш-метки убрать из shape: их ставят адаптеры).
- **Почему.** Поле `postProcessing` в контракте есть, а владельца у него нет: в RoleCall и Bunraku это делает транспорт. §4 отдаёт `shape.ts` роли и кэш-метки, а §8.4–§8.5 — адаптерам. Без одного правила склейка и mid-system выполнятся дважды. Кроме того, склейка RoleCall не знает о тулах и теряет tool_calls второго сообщения.
- **Рекомендация.** Принять.

#### D-49 (§11)
- **Изменение.** Сетка обрезки по 8 сообщений привязана к самому старому сообщению пути, как в `trim.ts` Bunraku. Граница пересказов выровнена по кускам и сдвигается только на целый кусок. Измерение идёт от новейших сообщений назад и останавливается, как только бюджет превышен.
- **Почему.** Без привязки граница сдвигается каждый ход, и кэш ломается чаще, чем обещает §8.7. Без раннего стопа путь в 10k сообщений каждый ход токенизируется целиком.
- **Рекомендация.** Принять.

#### D-50 (§11)
- **Изменение.** Поправка EMA счётчика токенов не хранится. При открытии сессии она выводится из пути: сравнением `gen.usage.inputTotal` с `trace.tokens.estimated`.
- **Почему.** Контракт не говорит, где живёт EMA. Вывод чистый и воспроизводимый, нового файла не нужно — это в духе правила «производное вычисляется».
- **Рекомендация.** Принять.

#### D-51 (§8.1, §8.8)
- **Изменение.** Три уточнения в типах.

- Определить `AssistantResult = {blocks, replay?, usage?, finish:{reason, raw}, model?}`: §8.1 его использует, но не определяет. `model` — модель, которую реально отдал сервер; она идёт в `gen.served`.
- Добавить `Usage.inputCacheWrite1h?`.
- Перечислить значения `ProviderError.category`: auth, request, rate, server, network, content, protocol.
- **Почему.** Эхо рассуждений DeepSeek и сопоставление replay работают по модели. Запись в кэш с TTL 1 ч (умолчание §8.4) стоит 2×, а не 1,25×, и TokenReport Bunraku это уже различает.
- **Рекомендация.** Принять.

#### D-52 (§4, §8.3, §8.8)
- **Изменение.** Новый файл `providers/wire.ts` для общих чистых помощников адаптеров:
- проверка протокола тулов по блокам `PromptMsg` (порт `validateToolProtocol` из Bunraku);
- ремап id под диалект;
- `mergeAdjacent`, который не склеивает подписанные части;
- таблица причин остановки.

Отдельно записать, что отображением HTTP-статусов в `ProviderError` владеет `http.ts`.
- **Почему.** Все три адаптера делают одну и ту же проверку из §8.3. В Bunraku `anthropic-request.ts` импортирует её из спицы OpenAI — признак того, что общего места нет.
- **Рекомендация.** Принять.

#### D-53 (§13, §8.2)
- **Изменение.** Аварийный люк на соединении: в `[connections.x]` можно задать `headers`, `extra_body` и `exclude_body`.
- Имена заголовков пишутся в файле, значения берутся из env.
- Принимается только JSON; неразбираемый текст — ошибка, а не тихий пропуск.
- Люк применяется последним.
- Защищённые ключи не трогаются: model, messages, stream, tools, tool_choice, заголовки авторизации и версии.
- **Почему.** Это единственный способ обойти причуду сервера, которой ещё нет в записи возможностей, без нового релиза. Основа — порт `request-overrides` Bunraku вместе с тестами. RoleCall в такой ситуации молча отправлял запрос без оверрайда.
- **Рекомендация.** Принять, но только с защищёнными ключами. Иначе через `extra_body` вернулся бы принудительный `tool_choice`, который запрещает §7.2.

#### D-54 (§8.2, §8.4)
- **Изменение.** Новые поля `ModelCaps`:
- `cacheMinTokens?` — минимальная кэшируемая длина: 512 у fable/mythos/opus-5, 1024 по умолчанию, 2048 или 4096 у части моделей 4.x;
- `stopMax?` — 4 у OpenAI, 16 у DeepSeek;
- `extraBody?` — у OpenRouter `allow_fallbacks:false`, `session_id` и safety_settings для Gemini через OpenRouter; у llama.cpp `cache_prompt`;
- `reasoning.efforts?` — допустимые значения effort вместо регулярок для их подгонки.

Каждая строка `hosts.json` и `models.json` несёт `as_of` и `src` (URL или id инцидента).

`reasoning.tags` по умолчанию: `<think>`, `<thinking>`, `<thought>`, `[THINK]`, `◁think▷`, `<|begin_of_thought|>`.

Thinking у Qwen3 переключается через `control:'toggle'` и `chat_template_kwargs` из данных.
- **Почему.** §8.4 требует учитывать минимальную длину кэша, но поля для неё нет: Bunraku выводит её регуляркой по id модели, а §8.2 это запрещает. Правила Claude, Gemini и OpenAI в 2026 году менялись каждый месяц. Без `as_of` и `src` файл `models.json` превратится в те же регулярки под другим именем.
- **Рекомендация.** Принять.

#### D-55 (§7.1, D-16)
- **Изменение.** Разделитель раундов: если уже отстримленный текст не кончается пробельным символом, перед текстом следующего раунда идёт одна дельта с переводом строки. Она попадает и в события, и в коммит.

Если хост задал `maxRounds` больше потолка 8 (Bunraku допускает до 20), значение обрезается до 8 с `notice{code:'tool_rounds_clamped'}`.
- **Почему.** Без разделителя текст двух раундов склеивается слово к слову. Bunraku уже так делает, но неявно. Молчаливая обрезка нарушила бы правило «ничего не происходит молча».
- **Рекомендация.** Принять.

#### D-56 (§9.1)
- **Изменение.** `ToolCtx` получает два поля:
- `inContext(msgId)` — из окна трассы сборки, для пометки «(in context)»;
- `pageChars` — из окна модели, для размера страниц.

Новый порядок цепочки аргументов:
1. лимит 1 МиБ;
2. пустая строка или `null` → `{}`;
3. срез шаблонных маркеров;
4. `JSON.parse`;
5. пред-проходы (python-вызов, пропущенные скобки) и `jsonrepair`;
6. снятие массива в корне;
7. приведение скаляров;
8. валидация: тип, required, enum, maxLength, min/max, `additionalProperties:false`.
- **Почему.** Без этих полей встроенные тулы не выполнят требования §7.5. Регулярка маркеров (`TEMPLATE_MARKERS` из RoleCall) привязана к концу строки и не трогает валидный JSON. После `jsonrepair` срезать маркеры уже поздно: он вклеивает мусор в значение.
- **Рекомендация.** Принять.

#### D-57 (§8.3, §6.2 шаг 9, §15)
- **Изменение.** Восстановление протечек делится на две части:
- вырезание обёрток (Hermes `<tool_call>`, DSML, `<function…>`, `<invoke>`) — в постобработке с M1;
- превращение полных вызовов в настоящие — на M3.
- **Почему.** Локальные модели без тулов (GLM, Qwen, DeepSeek через совместимые хосты) протекают обёртками в прозу уже на M1. `stripToolCallLeaks` из Bunraku занимает 12 строк, так что ранний перенос стоит дёшево.
- **Рекомендация.** Принять.

#### D-58 (§7.5)
- **Изменение.** Страница `read_history`:
- размер — clamp(15 % окна в символах, 6 000, 18 000), но не меньше двух целых сообщений;
- `maxOutput` тула — страница + 1 000;
- слишком длинное одиночное сообщение режется с явной пометкой остатка.

Нумерация `#n` — позиция на активном пути начиная с 1; приветствие — `#1`.

Скрытые сообщения исключены из поиска. При чтении на их месте стоит заглушка «#n скрыто», чтобы номера не съезжали.
- **Почему.** RoleCall измерил: сериализованное RP-сообщение занимает около 1 800 символов. Со страницей в 3 500 символов агент получал одно сообщение и сдавался или выдумывал цитаты (`read-scene-messages.ts`, стр. 50–112). Со страницей в 4 000 символов демо M3 под угрозой.
- **Рекомендация.** Принять.

#### D-59 (§9.2)
- **Изменение.** В вводе и выводе тулов id записей заменяются короткими хэндлами на ход: `L12` для лора, `C<n>` для записей Compendium (ключи записей — §5.8). `read_lore` переводит их обратно по таблице хода.
- **Почему.** Модели портят длинные id. Оба источника пришли к коротким хэндлам: `e<n>` в Bunraku, `toReadableId` в RoleCall.
- **Рекомендация.** Принять.

#### D-60 (§7.2)
- **Изменение.** Результат `structuredCall`:
- новый код сбоя `no_output` — нет ни тега, ни JSON. Он отличается от `undecodable`, где ответ найден, но не разбирается;
- и успешный результат, и сбой несут `attempts: {transport, outcome, ms, status?, finish?, tokens?}[]`;
- `skipped` становится списком `{path, why}[]`, например `arcUpdates[3]`.

Если в видимом тексте тега нет, он ищется в тексте рассуждений, с пометкой в трассе.

Повторы идут только по общей политике §6.6: без собственного повтора агента и без опции autoRetry.
- **Почему.** RoleCall и Bunraku не зря различают «модель ничего не вызвала» и «вызвала криво». Журнал попыток (PlannerAttempt из Bunraku) нужен трассе. Путь к элементу полезнее индекса. GLM-thinking кладёт план в рассуждения при пустом content — это ловит тест RoleCall cremecafe. Два повтора подряд дали бы три отправки на 429.
- **Рекомендация.** Принять.

#### D-61 (§7.3, §5.9, §4)
- **Изменение.** Форма плана и состояния берётся из Bunraku и RoleCall вместо свежих `Plan`, `PlanOp` и `Arc{hidden}`.

**План** — `PlanningRound {directive, arcUpdates[], seedUpdates[], invisibleArcUpdates[], analysis, chapterUpdate}`. **Директива** — `NarratorDirective` из RoleCall: mood, pacing, include, avoid, dialogueGuidance, sceneGuidance, endingHook, arcDirections, callbacks, characterBeats, narrativeGoal.

**Состояние** — урезанное `DirectorState` из Bunraku:
- chapters — список; длины глав — константа `CHAPTER_TURNS` 20/50/100 (*рев. 6:* `estimatedTurns` не хранится, §7.3);
- arcs — status seeding|building|climax|resolution|complete|abandoned, пять горизонтов от immediate до epic, stages[], nextBeat;
- seeds;
- invisibleArcs — отдельная коллекция с жизненным циклом и уликами;
- pacing, nextIntentions, lastDirective, nextId, turn.

Без activity, edits, archive и trackerUpdates. Возрасты выводятся из plantedAtTurn и createdAtTurn.

Новые файлы: `agents/director/plan.ts` и каталог `personalities/`.

**Лимиты:**
- ≤ 24 живых арок, ≤ 12 скрытых;
- ≤ 32 семян, ≤ 16 заметок;
- ≤ 10 завершённых элементов каждого вида;
- ≤ 6 этапов, ≤ 4 подкреплений, ≤ 6 улик;
- 300 символов на поле.

`fitState` уступает элементы в прежнем порядке; byUser и userAuthored не вытесняются.

**DirectorRecord** = `{ok, transport, model, directive, analysis?, skipped, attempts, state, reducer, reusedFrom?}`, без `ops`. Коды сбоя:
- `no_tool_support` → `transport_unsupported`;
- `inference_error` → `provider_error`;
- нет вызова → `no_output`.
- **Почему.** На имена этой формы завязаны около 35 мест в user-prompt и momentum, пример директивы и 3,9 тыс. строк личностей, проверенных в продакшене. Переход на PlanOp означал бы переписать настроенные промпты без тестов. Стык M9 становится почти 1:1. Там, где док лучше, меняется код: возрасты выводятся, журнала активности в состоянии нет, сопоставление идёт по Unicode.
- **Рекомендация.** Принять форму плана и состояния.

Отклонить потолок снимка в 64 КБ, который предлагает оценка. Снимок пишется в каждую версию ответа в JSONL, файл целиком грузится в память, а свёртка 10k сообщений должна укладываться в 50 мс. Поэтому:
- жёсткий потолок `fitState` — 32 КБ;
- цель — не больше 16 КБ в типичной сессии; на M4 это проверяет скриптовый прогон на 300 ходов;
- при превышении ужимаются лимиты завершённых элементов и этапов.

В §5.9 «4–10 КБ» заменить на эти числа, и в §17 п. 11 — тоже: «(≤ 16 КБ типично, потолок 32 КБ на ответ [D-61])». `dir` у предков свёртка может разбирать лениво.
- **Статус.** Принято Леви 25.10.

#### D-62 (§7.3 «Проверка и редьюсер»)
- **Изменение.** Новые правила строгости директивы:
- отклоняется только директива без единого содержательного поля (mood, narrativeGoal, arcDirections, characterBeats, callbacks, sceneGuidance, include; *рев. 6:* также dialogueGuidance, endingHook, avoid и явно присланный `pacing ≠ medium` — как `hasDirectiveContent` RoleCall, `DirectiveBuilder.ts:415-429`, §7.3). Проверка VVS-130 в RoleCall (`schemas.ts:180-205`) — отдельное правило: объект без единого известного ключа директивы;
- отсутствующий или неверный pacing приводится к 'medium';
- поле `focus` убирается;
- шкала pacing — slow|medium|fast|breakneck;
- нейтральная директива не выдумывается.
- **Почему.** По логам RoleCall, grok-4.1-fast, gemini-3.1-flash-lite и gemma-4 пропускают mood или pacing. При строгом чтении маленькая модель каждый ход получает сбой Директора и лишний корректирующий вызов.
- **Рекомендация.** Принять как середину между RoleCall (терпимо) и Bunraku с доком (строго). Нужно подтверждение Леви — вместе с D-17.
- **Статус.** Принято Леви 25.10; D-17 остаётся: при сбое директивы в этом ходу нет.

#### D-63 (§7.3 «Импульс», «Проверка и редьюсер»)
- **Изменение.** **Импульс** — значения RoleCall:
- принудительный сигнал на пределе горизонта: immediate 2, short 9, medium 15, long 30, epic 75 ходов; арки в seeding исключены;
- застой — 15 ходов;
- семя созрело через 30 ходов при ≥ 2 подкреплениях, просрочено при 2×;
- давление посадки — 12/20/35 ходов; критическое, если семян не было вовсе;
- скрытой арке пора всплыть на expectedSurfaceTurn или в возрасте ≥ 2/6/12/25/60.

Давления (`planningPressures`) идут отдельным user-сообщением после user-промпта.

**Редьюсер.** Новая глава отклоняется в первые 3 хода (подсказка — до 10-го), а не в первые 5. Заголовки сопоставляются по шагам, поверх `normalizeTerm` и стоп-слов, вместо Jaccard ≥ 0,6:
1. точный id;
2. нормализованный заголовок;
3. ≥ 2 общих значимых токена, покрывающих не меньше половины более короткого заголовка.
- **Почему.** Рев. 3 уже велит брать пороги RoleCall — здесь их точные значения из порта. Правило токенов RoleCall проверено тестами vvs-264, а Jaccard — непроверенная замена.
- **Рекомендация.** Принять. Если `alternation:'strict'`, два user-сообщения подряд склеивает `shape.ts` (D-48).

#### D-64 (§7.3 «Промпт», §5.1 SessionConfig, §13)
- **Изменение.** Лимиты промпта Директора:
- `director.instructions` — до 2 000 символов вместо 1 500;
- самопроверка — 2 400 символов (начало и конец текста);
- история — новейшие 30 сообщений в пределах 25 % окна (в lite — 10 %).

В `SessionConfig.director` добавляются:
- `style` — один из 10 id личностей, по умолчанию `the-balanced` (Sage);
- `creativity` — subtle|moderate|dramatic, по умолчанию moderate.
- **Почему.** Лимит 2 000 — у RoleCall и Bunraku, поэтому настройки Bunraku не обрежутся при встраивании. Личности и creativity портируются. `director.style` §7.3 уже упоминает, но не определяет.
- **Рекомендация.** Принять.

#### D-65 (§7.3 «Доставка»)
- **Изменение.** Заголовок директивы — `[DIRECTOR CONSTRAINTS - BINDING THIS TURN] … [/DIRECTOR CONSTRAINTS]` вместо `[Director — this turn]`.

Фильтр персоны расширяется:
- убираются characterBeats и dialogueGuidance персоны;
- персона удаляется из include.characters;
- выбрасываются arcDirections, callbacks и биты, которые утверждают что-то о её внутреннем состоянии;
- имя и алиасы сравниваются с учётом Unicode.
- **Почему.** Текст контракта NARRATOR_AUTHORITY ссылается именно на этот заголовок, и в RoleCall и Bunraku он протестирован. Нынешний фильтр «только beats, где who — персона» пропускает остальные способы решить за игрока.
- **Рекомендация.** Принять. Список глаголов внутреннего состояния — английский, поэтому для русских историй фильтр слабее. Русские фикстуры добавить на M4.

#### D-66 (§7.4, §5.1, §13)
- **Изменение.** Новая необязательная настройка `memory.guidance` — до 1 500 символов. Это указание Летописцу: оно сужает, что записывать, но не расширяет. Устроено так же, как `director.instructions`.
- **Почему.** Такая настройка есть и в RoleCall (`filingGuidance`), и в Bunraku (`filing.guidance`), и пользователи через неё управляют Летописцем. Правило «не расширяет» уже есть в портируемом промпте.
- **Рекомендация.** Принять.
- **Статус (рев. 6).** В проекте Compendium настройка называется `compendium.guidance` (≤ 4 000 символов, filing и historian, только сужает; §7.4.9).
- **Статус (26.10).** Принято пакетом; там, где D-66 расходится с решениями Compendium (D-82, D-83, D-86, D-87), действуют они.

#### D-67 (§7.4, §5.8, §12.2)
- **Изменение.** Правила операций Летописца:
1. Летописец выдаёт только `add` и `update`. `retire` доступен только пользователю (`/memory retire`).
2. Ключи в `update` объединяются с существующими, а не заменяют их.
3. 800 символов — лимит записи. `append`, который его превысит, пропускается с причиной, а не обрезается.
4. Строка `mem` получает поле `skipped?: {op, why}[]`.
5. `add` превращается в `update`, если нормализованный заголовок совпал с заголовком **или ключом** живой записи.
- **Почему.** В Bunraku модель не может удалить запись (правило R3), массивы при слиянии дописываются, а лишние элементы отклоняются с причиной (MAX_ITEM_CHARS, квитанции). Варианты имён — главный источник дублей в RoleCall («Lycanthrope» и «Wolfman»). Поле `skipped` нужно `/memory` и событию `agent`, чтобы сказать, что именно отклонено.
- **Рекомендация.** Принять. Сравнивать только с заголовком и ключами записи, без общих слов, и проверить на фикстурах `ru`.
- **Статус (рев. 6).** Для агентов Compendium:
  - п. 1 действует: агенты пишут только `file` и `arc`, списывает только человек;
  - п. 2 и п. 5 действуют через слияние [D-81] и `findMatch` по имени и алиасам;
  - п. 3 заменён границами D-87;
  - п. 4 — поле `skipped` строки `mem` (§5.8).
- **Статус (26.10).** Принято пакетом; там, где D-67 расходится с решениями Compendium (D-82, D-83, D-86, D-87), действуют они.

#### D-68 (§7.4, §5.8, §6.7)
- **Изменение.** Четыре правила для пересказов.

1. **Перекрытие.** До N сообщений перед отрезком (по умолчанию 6; в RoleCall и Bunraku — 10) показываются модели с пометкой «уже пересказано» и в `range` не входят.
2. **Лимит текста** — 1 500 символов.
3. **Пустой результат** задачи всё равно пишется как `mem{key, on, ops:[]}`. Это касается и `record`.
4. **Устаревание.** Пересказ считается непокрытым, если в его диапазоне есть `edit` или `hide` с `seq` больше, чем у его строки `mem`.
- **Почему.** 1. Оба источника пришли к перекрытию, чтобы не рвать события на границе отрезка.
2. Без лимита несколько пересказов не влезут в 10 % окна, отведённые под слот.
3. Иначе ключ не закрывается, и восстановление ставит задачу снова и снова. В Bunraku эту роль играет квитанция nothing_to_file.
4. В RoleCall и Bunraku диапазоны молча устаревают после правок, и пересказ навсегда подменяет изменённый текст.
- **Рекомендация.** Принять все четыре.
- **Статус (26.10).** Принято пакетом; там, где D-68 расходится с решениями Compendium (D-82, D-83, D-86, D-87), действуют они.

#### D-69 (§5.8)
- **Изменение.** Зарезервировать поле `data?: Record<string, unknown>` в `MemOp` (add и update) и в `ChronicleMeta`. В v1 кода для него нет.
- **Почему.** Тогда типизированный слой Compendium или импорт книг Compendium из RoleCall и Bunraku потом не потребует миграции формата сессии (вопрос 13).
- **Рекомендация.** Принять: имя резервируется без реализации, как требует §1.1.

#### D-70 (§5.1, §10.2, §10.5)
- **Изменение.** Пять изменений в нативных форматах.

1. `extras?` у `LoreEntry` и у `Preset.blocks[]` — для uid, displayIndex, vectorized, scan sources, characterFilter, injection_trigger.
2. Каждый импортёр возвращает `Imported<T> = {value, warnings: {code, path, message}[]}`. Предупреждения называют всё, что в файле есть, но не исполняется. Пользователь видит их как `notice`.
3. `LoreEntry.group` становится `groups?: string[]`: ST допускает несколько групп через запятую.
4. `Preset.formats?: {wi?, personality?, scenario?, newChat?, newExampleChat?}`. Это wi_format, personality_format и scenario_format из ST, которые применяются к непустым значениям слотов через `{0}`, а также new_chat_prompt и new_example_chat_prompt.
5. Позже — необязательный `when?` у блока (injection_trigger в ST).
- **Почему.** Сейчас неизвестным полям записи и блока негде жить, и при обратном экспорте они теряются. Без предупреждений лор не срабатывает без объяснений. Ни RoleCall, ни Bunraku не применяют formats, поэтому старые ST-пресеты теряют обрамление и golden-снимки SillyBunny (§14) упадут. Поддержка formats — около 20 строк сборщика.
- **Рекомендация.** Принять. Пункт 5 — только резерв имени.

#### D-71 (§10.5)
- **Изменение.** Конвертер ST-пресетов следует ST.
- Выключенный маркер (worldInfoBefore/After, personaDescription и т. п.) становится выключенным слот-блоком и ничего не отправляет.
- Синтезируется только отсутствующий chatHistory — с предупреждением.
- Пресет с `extensions.rolecall` считается экспортом RoleCall: глубины внутри чата получают +1 через `fromRcDepth`, с предупреждением.
- **Почему.** RoleCall и Bunraku всегда синтезируют `{{lore}}` и `{{persona}}`, даже если пресет их выключил. ST так не делает. Экспорт RoleCall записан в грамматике ST, но с глубиной RoleCall, и без поправки вставки окажутся на сообщение выше.
- **Рекомендация.** Принять, с предупреждением на каждый выключенный слот. Пресеты, которые работали в RoleCall, могут потерять лор, поэтому нужно подтверждение Леви — вместе с вопросом 11.
- **Статус.** Принято Леви 25.10 в **смешанном варианте**:
  - ST-пресеты ведут себя как в ST: выключенный маркер ничего не отправляет, и на каждый такой слот выдаётся предупреждение;
  - пресеты с `extensions.rolecall` (экспорт RoleCall) ведут себя как в RoleCall: лор и персона подставляются всегда, глубины получают +1 через `fromRcDepth`.

#### D-72 (§4, §10.5, §12.4)
- **Изменение.** Новый модуль `formats/import.ts` и команда `rp-core import <файл> [--as имя]`. В REPL импорт идёт через `/lore add <файл>` и `new --card`.

**Порядок распознавания:**
1. PNG-карточка;
2. JSON CC;
3. ST-пресет;
4. ST WI с объектом entries;
5. отдельный character_book;
6. иначе — отказ с причиной.

**Чтение:** файл пробуется как есть, затем как двойной JSON, затем как конверт экспорта.

**Запись:** атомарно в `library/<вид>/<canonicalId(name)>.json`; `canonicalId` — NFKC и `\p{L}\p{N}`.
- **Почему.** §10.5 перечисляет конвертеры, но не точку входа. `new --card`, `/lore add` и демо M2 нуждаются в одном шаге распознавания и записи. Реестр Bunraku на 29 адаптеров с подсчётом очков избыточен. ASCII-слаг превратил бы кириллические имена в пустые или совпадающие.
- **Рекомендация.** Принять.

#### D-73 (§13, §12.1)
- **Изменение.** **Конфиг.**
- Даты — только строками. `Bun.TOML.parse` 1.3.14 отвергает литералы дат: `as_of = 2026-10-06` даёт «Expected key but found -». Ошибка называет строку конфига и советует кавычки.
- Имена соединений — без `:`.
- Привязка `conn:model` делится по первому `:`: так работают `qwen3:14b` и `a/b`.
- Поля, похожие на ключи (api_key, key, token), — отказ.

**Секреты.**
- Закрепить подпись `keys?: (conn) => string | undefined | Promise<string | undefined>` в `Engine.open`.
- `key_cmd` — с таймаутом 10 с. При ошибке — `{category:'auth', code:'key_unavailable', conn, exit}`, без stdout и stderr.
- **Почему.** Поведение проверено на Bun 1.3.14. Заблокированная связка ключей может держать secret-tool бесконечно, а его вывод может содержать эхо приглашений.
- **Рекомендация.** Принять.


#### Решения прохода по Compendium (рев. 6)

#### D-74
- **Решение.** Хранение Compendium (§5.8). Записи — строки `mem` с операциями по имени: `file` (создать или дописать) и `arc`; человеку доступны ещё `note`, `edit`, `retire`, `restore` и `revert`. Тождество записи разрешается при свёртке (`findMatch` Bunraku: тип плюс имя или алиас после `normalizeName`). Ключи записей строятся из типа и имени при создании, а не из `seq`. Для ключа задачи действует последнее действие — повторная запись или `revert`. `revert` закрывает ключ и для полосы: отменённый проход считается покрытым и заново не пишется; заново пишут только `/memory refile`, устаревание и `/memory retry`. Правки человека с `on:null` глобальны. Устаревание D-68.4 распространено на filing: правка или скрытие внутри диапазона прохода — запись заново.
- **Рекомендация.** Принять. Операции по имени применимы к любому подмножеству строк. Поэтому свайп, откат, форк и догоняющий historian работают без кода отмены, ключи не ломаются на форке, а `/memory undo` не превращается в отложенный `/memory refile`.
- **Альтернативы.** Операции по id записи (`update{id}`), как в Хронике: ломаются, когда строки ложатся не по порядку, и когда форк перенумеровывает `seq`. Квитанции и undo Bunraku (≈ 470 строк). Отмена прохода по `seq` строки: ломается на форке. Отменённый проход снова становится долгом полосы, как в Bunraku: undo тогда просто откладывает повторную запись.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### D-75
- **Решение.** Библиотечные книги только читаются [D-3]. Если у сущности есть типизированная запись в читаемой книге, filing о ней пишет оверлей сессии с тем же ключом `lib:<книга>:<id>`; правки человека — тоже. Если книга поменяла запись посреди сессии, дельты накладываются на новую основу. Если запись из книги пропала — уведомление `library_entry_missing`. Экспорт — единственный путь в библиотеку.
- **Рекомендация.** Принять. Иначе filing создаёт дубль в сессии: снимок Bunraku видит только записываемые книги.
- **Альтернативы.** Дубль в сессии (так ведёт себя Bunraku с книгой только для чтения). Запрет filing о библиотечных сущностях. Запись в книгу — противоречит D-3.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### D-76
- **Решение.** Какие записи включает Compendium. Типизированные записи — сессии и книг с доступом `read` — попадают в промпт только через Compendium, то есть через селектор и recall; движок лора их не видит. Нетипизированные записи книг остаются движку лора с семантикой ST и при этом — кандидаты recall. Доступ задаёт `compendium.books.<книга>`: `read` (по умолчанию) или `off` — тогда книга работает как обычный лорбук. Уточняет D-7: выбор записей моделью есть, но только внутри Compendium.
- **Рекомендация.** Принять, с доступом `read` по умолчанию, как в Bunraku. Один путь и один бюджет для типизированных записей — условие того, что персонаж помещается в окно 16k.
- **Альтернативы.** Как в Bunraku: типизированные записи срабатывают и по ключам в движке лора (полным текстом, на позиции записи), и через recall. Recall читает только Compendium сессии и типизированные книги, а книги ST остаются чистым ST. Признак «книга Compendium» по доле типизированных записей — книга может переключаться сама.
- **Статус.** Принято 26.10 (вопрос 17): recall может выбирать и записи обычных ST-книг, доступ `read` по умолчанию, `off` — по книге.

#### D-77
- **Решение.** Активация и размещение. Каждый ход без модели работает селектор с тремя ярусами: 0 — записи, упомянутые в U (по основам имени и алиасов); 1 — выбор recall; 2 — упомянутые в последних 4 сообщениях. Всё приходит одним блоком `[Retrieved World Knowledge]` на глубине 1, источник `compendium`: при равной глубине он ниже лора и выше директивы, причин выбора в нём нет. Пол — 40 % доли лора, лимиты зависят от профиля; срез идёт по ярусам и пишется в трассу. Глубина 4 остаётся только заметкам человека.
- **Рекомендация.** Принять.
- **Альтернативы.** Как в Bunraku: срабатывание по ключам в движке лора плюс отдельный блок recall. Блок на глубине 4, как у Хроники. Ярусы графа связей и «залипания» выбора — сразу, а не после замеров.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### D-78
- **Решение.** Recall: режимы и расписание.
- Режимы: `auto`, `sync`, `prefetch`, `lexical`, `off`. `auto` выбирает `prefetch`, если origin привязки recall локальный, иначе `sync`.
- Prefetch — фоновая задача после коммита ответа, первая в полосе; на локальном origin она стартует не раньше `idleDelaySec` после хода. При U(n+1) берутся её picks плюс упоминания в U. Если она ещё в полёте, ход ждёт её не дольше `graceSec` (4 с), иначе это промах. Stop прерывает ожидание, а не задачу. Промах ведёт к `lexical` локально и к `sync` удалённо.
- Sync запускается вместе с Директором; на одном месте семафор ставит Директора первым.
- Дедлайн от гранта: 30 с локально, 20 с удалённо (у Bunraku — 90 с). Сбой даёт лексический откат с событием, ход не валится. Если рассуждения не выключаются, к бюджету вывода добавляется 1 024.
- `RecallRecord` хранится в `prep` и коммите; свайп и continue повторяют выбор без вызова.
- Lite: шорт-лист из 40 кандидатов, ответ — только `entry_ids`, не больше 4, без второго вызова. Full: промпт Bunraku дословно, не больше одного ремонта или добора.
- **Рекомендация.** Принять. На локальном бэкенде recall перестаёт добавлять 4–12 с до первого токена (оценка), а на облаке ведёт себя как в Bunraku. Качество prefetch проверяется на M5c: доля записей синхронного выбора, попавших в итоговый блок с prefetch, — не ниже 0,8 от той же доли между двумя синхронными прогонами; иначе `auto` переходит на sync.
- **Альтернативы.** Всегда sync, как в Bunraku: на одном слоте +4–12 с к каждому ответу. `auto` по числу слотов (prefetch только при одном слоте): на локальном `-np 2` sync recall всё равно делит GPU с ходом. Только лексика, без модели. Recall как поле в ответе Директора — после замеров M5c.
- **Статус.** Принято 26.10 (вопрос 16): `auto` — prefetch на локальном origin, sync на облаке; замер M5c может перевести `auto` на sync.

#### D-79
- **Решение.** Профили full и lite. `compendium.profile` — `auto`, `full` или `lite`; `auto` выбирает lite при окне агента < 24 576 (тот же порог у Директора в `auto`, §7.3). Профиль меняет то, что видит модель, и лимиты числа и размера элементов. В lite это:
- шорт-лист вместо дерева;
- `LITE_FIELDS` — 69 полей, 431 токен против 620 у списка полей Bunraku (system filing ≈ 960 против 1 148);
- ростер и 4 краткие записи вместо снимка;
- краткий рендер и меньшие лимиты.
Правила чтения и свёртка в обоих профилях одинаковы. Full — код Bunraku с бюджетами, зажатыми окном.
- **Рекомендация.** Принять.
- **Альтернативы.** Порог 16k: окно 16 384 получило бы full. Lite для всех локальных соединений. Один профиль на всё.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### D-80
- **Решение.** Свежесть. Подавление ещё видимого выводится из происхождения в свёртке:
- пересказ скрыт, пока видно его последнее сообщение;
- сюжет и событие — пока видно сообщение, из которого их создали;
- элемент массива любой записи (память, связь, развитие сюжета) — пока видно добавившее его сообщение; запись тогда рендерится без него.
Окно видимости — граница обрезки прошлого хода. Правило применяется и к индексу recall, и к блоку. Оно заменяет правило «пока видны все источники».
- **Рекомендация.** Принять. Это правила RoleCall (`compendium-freshness.ts`), выведенные из пути. У Bunraku ветка сюжетов и событий не работала: `turnNumber` там не пишется.
- **Альтернативы.** Правило §7.4 рев. 2 («видны все источники») — слабее RoleCall. RoleCall как есть — фильтр только памяти персонажа. Скрывать целиком любую запись, созданную в окне: на больших окнах без обрезки персонажи не попадали бы в блок вовсе.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### D-81
- **Решение.** Слияние. `mergeData` Bunraku: пустое не стирает, объекты сливаются вглубь, скаляры заменяются, имя сохраняется. К нему добавляются ключи массивов RoleCall (`ARRAY_KEY_FNS`: связь — по `with` и `nature`, память — по `what_happened` и `when` и т. д.) и схлопывание почти-дублей в списках строк (`compendium-definitions.ts:200-264`: все значимые слова меньшего факта есть в большем или Jaccard ≥ 0,8) по словам `normalizeTerm`.
- **Рекомендация.** Принять. Без ключей смена статуса связи даёт вторую связь, а токенизация RoleCall `[^a-z0-9]` стирает кириллицу.
- **Альтернативы.** Только Bunraku (`deepEq`). Только RoleCall.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### D-82
- **Решение.** Терпимое чтение filing и historian — аналог D-62 для памяти.
- Принимаются разные конверты и плоские элементы, синонимы типов (en и ru), camelCase, приведение видов и enum.
- Поле с неверным видом или значением enum уходит в `skipped`, а элемент сохраняется.
- Память без `changed_belief` и `changed_behavior` и связь без `with` отбрасываются. Правило памяти — адаптация RoleCall: там в фазе postgen такая память отклоняет весь вызов (`compendium-definitions.ts:2786-2805`).
- Поле памяти `event` читается как `what_happened`.
- Ремонт — только если ответ не читается целиком.
- **Рекомендация.** Принять.
- **Альтернативы.** Как в Bunraku — элемент отклоняется целиком при любой ошибке вида; слабая модель так теряет большую часть записей. Как в RoleCall — вызов отклоняется из-за одной памяти. Схема на каждый тип в `structured` — огромный `anyOf`.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### D-83
- **Решение.** Historian и слот пересказов. Historian заменяет задачу `recap` [D-33].
- Проверяется при каждом принятии ответа, после filing, если тот поставлен; работает и без filing.
- Триггеры: ≥ 20 ходов игрока после водяного знака или ≥ 24 срезанных непокрытых сообщения. В устойчивом режиме частоту задаёт размер окна: на 16k — раз в 4–5 ходов, на 128k — раз в ~10.
- Водяной знак — по неустаревшим строкам historian, включая отменённые. Списанный или отменённый пересказ заново не пишется; назад знак сдвигает только устаревание. Диапазоны — id пути, позиции в промпте — номера на пути.
- Перекрытие — 10 сообщений в full, 6 в lite.
- Каждый пересказ принадлежит сюжету; если сюжета нет, он создаётся.
- Обзоры `[Arc]` стоят в слоте `{{recap}}` первыми, занимают не больше половины слота (в lite — 2 по ≤ 1 200 символов, такой же лимит у обзора при записи) и меняются только со сдвигом границы обрезки.
- **Рекомендация.** Принять.
- **Альтернативы.** Обзоры как константные записи лора, как в Bunraku: на окне 16k они съедают долю лора. Водяной знак по живым пересказам, как в Bunraku и RoleCall: списанный пересказ пишется снова. Только триггер обрезки (D-33). Только интервал (Bunraku). Меньшее окно в lite: больше запусков, и каждый платит за переписанный обзор.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### D-84
- **Решение.** Планировщик по origin.
- Семафор `sched` ставится на origin (`scheme://host:port`), а не на имя соединения.
- Ёмкость: явный `max_in_flight`; иначе 1 локально и 4 удалённо. Проба `GET /slots` ёмкость не поднимает: при общем KV (`-np` = auto у llama-server — 4 слота на один пул `-c`) его по `/slots` не отличить от раздельного, а переполнение пула роняет все идущие запросы. Если слотов ≥ 2 — `notice{slots_detected}` с советом.
- Локальный origin: фоновая задача стартует только без интерактивных запросов и не раньше `compendium.idleDelaySec` (8 с) после хода или переноса головы; интерактивный запрос вытесняет её, даже если место свободно. Задача, вытесненная 3 раза подряд, идёт первой и даёт `notice{memory_starved}`.
- Prefetch в полёте ход ждёт в пределах `graceSec`.
- Агенты не шлют `cache_prompt:false`. Агенты, работающие с той же моделью Ollama, шлют опции раннера рассказчика.
- Закрепление `id_slot` (рассказчик — 0, агенты — 1) при `max_in_flight = 2` — на M5c, если проба подтвердит, что сервер его принимает. Прогрев префикса — после замеров M5c.
- **Рекомендация.** Принять.
- **Альтернативы.** Семафор на имя соединения, как в §8.8 сейчас: два имени на одном llama-server молча выбивают друг другу кэш. Ёмкость из пробы `/slots`: на стоковом llama-server четыре запроса в пуле на одно окно. Фон сразу после хода: свайп через 2 с платит полной обработкой промпта рассказчика. `-np 2` без закрепления: вторая подряд фоновая задача берёт LRU-слот рассказчика.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### D-85
- **Решение.** Роли, имена и транспорт.
- Новая роль `recall` (→ `recorder` → `narrator`); `recorder` — модель filing и historian.
- `SessionConfig.memory` становится `compendium`; задачи полосы — `file` и `hist` (плюс `prerecall` в памяти) вместо `record` и `recap`.
- Агенты `structuredCall` — `recall`, `filing` и `historian`; `tag: null` означает голый JSON-объект, как просят промпты Bunraku.
- `compendium.guidance` — до 4 000 символов (`MAX_GUIDANCE` Bunraku; по D-66 было 1 500), общая для filing и historian; у recall своя, до 8 000.
- REPL остаётся `/memory`, протокол — `memory/*`.
- **Рекомендация.** Принять.
- **Альтернативы.** Тег `<memory>` — меняет промпты Bunraku. Recall на привязке Директора (так предлагало исследование) — Директор чаще всего дорогая модель. Переименовать REPL и протокол в `compendium`.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### D-86
- **Решение.** Когда пишет filing.
- `filing.wait` — от 0 до 5, по умолчанию 1; обобщает `lag` [D-23].
- `filing.everyN` — от 1 до 10, без потерь: одна задача на N принятых ответов покрывает все N обменов. Ключ — последний ответ, `range` — от первого сообщения игрока. Если группа не помещается в бюджет, она делится на задачи.
- Покрытие считается по `range` строк на пути; отменённые проходы покрыты [D-74].
- Правка или скрытие внутри диапазона делает проход устаревшим, и он пишется заново (скрытые сообщения — нет).
- **Рекомендация.** Принять.
- **Альтернативы.** `everyN` Bunraku — пишет только каждый N-й ответ, промежуточные теряются. Правки старых сообщений не трогают записанное, как в RoleCall и Bunraku, — записанное молча расходится с текстом.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### D-87
- **Решение.** Границы типизированных записей вместо 800 символов D-67.3:
- элемент — до 6 000 символов JSON в full и 3 000 в lite, глубина ≤ 6;
- за проход — до 12 элементов в full и 6 в lite;
- операции одной строки `mem` — до 24 000 символов;
- обзор — до 6 000 / 1 200 символов, пересказ — до 1 500.
Запись при записи не ограничена; на 12 000 символов JSON — уведомление. В промпте — полный рендер до 4 000 символов или краткий до 700.
- **Рекомендация.** Принять. Потолок записи при записи сломал бы договор upsert; предел ставится на рендере и в снимке filing.
- **Альтернативы.** Жёсткий потолок записи с пропуском дальнейших дельт. Без уведомления, как в Bunraku.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### D-88
- **Решение.** Отступления от Bunraku и паритет.
- Промпты full переносятся дословно, кроме перечисленных строк: правок промпта filing (строка о книгах, вложенные формы, пример памяти, библиотечные записи в снимке), строки prefetch в recall, ограничения беседы recall по токенам и выведенного tagline.
- Поведенческие отступления: ключи массивов RoleCall; чтение по полям; свежесть по происхождению; пересказы не сливаются по заголовку; отменённый или списанный пересказ не пишется заново; обзоры в слоте; оверлеи; prefetch и лексический откат; задержка фона; `everyN` без потерь; дедлайны recall и filing.
- Golden-тесты сверяют тексты промптов full с Bunraku. Флагов в коде нет.
- Список отступлений — в `PROVENANCE.md`; его нужно согласовать с Chi до M5b.
- **Рекомендация.** Принять и согласовать список с Chi до M5b, чтобы стык M9 не стал сюрпризом.
- **Альтернативы.** Каждое отступление — за флагом, с тестами паритета при выключенных флагах (проект fidelity-first): больше кода и путей. Не проверять паритет вовсе.
- **Статус.** Принято 26.10 (вопрос 18). Список отступлений показывается Chi до M5b; ей предлагается M5a, если к тому времени она будет в проекте.

#### D-89
- **Решение.** Резерв ответа рассказчика на малом окне (§11): `min(maxTokens ?? (window < 24 576 ? 2 048 : 8 192), window / 2)`, если `max_tokens` не задан привязкой или пресетом. Для окна 16 384 это оставляет истории ≥ 5 000 токенов при полной доле лора и слоте пересказов (§7.4.6). Если на историю остаётся меньше 25 % окна — `notice{history_crowded}` раз за сессию.
- **Рекомендация.** Принять. Рассуждающей модели на малом окне `max_tokens` стоит задать явно.
- **Альтернативы.** Оставить 8 192: на окне 16k на голову, лор, блок Compendium, слот и историю остаётся 8 192, и истории почти нет. Резерв 4 096: истории ≈ 3 000 токенов, 4–5 обменов. Урезать долю лора на малом окне вместо резерва.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

### 19.11 Вопрос 13: доводы

*Рев. 5:* Леви выбрала Compendium целиком (25.10). *Рев. 6:* все четыре вопроса решены проходом по Compendium: вызовы перед ответом — §7.4.2 и §7.4.7, размер снимка — §7.4.6, схема для слабых моделей — §7.4.3, хранение — §5.8. Доводы ниже сохранены как история — список того, что пришлось решить при порте:
- вызовы модели перед ответом;
- размер снимка;
- схема для слабых моделей;
- хранение.

**Рекомендация: в v1 — Хроника (§7.4) с портированными промптами Compendium, а не Compendium целиком.** Скорее всего, полного Compendium не будет в ядре вообще: он остаётся в Bunraku.

Оценка группы памяти по исходникам даёт шесть доводов.

1. **Объём.**
   - Compendium: в ядро пришлось бы перенести типизированные записи (791 строка), historian (160), recall (611) и оркестрацию (376) из Bunraku, плюс дерево, которое строит модель (571). Итого ≈ 1 900–2 400 строк ядра и ≈ 1 500 строк тестов. Это XL: M5 удлиняется на 3–5 недель.
   - Хроника: ≈ 800 строк, 7–12 дней.
   - Квитанции, undo и book-writer Bunraku (≈ 575 строк) в ядре стали бы мёртвым кодом: откат уже даёт свёртка `mem` по пути.
2. **Вызовы модели.**
   - Compendium добавляет 1–2 вызова **перед каждым ответом**: recall плюс ремонт или добор, с таймаутом 90 с. Сверх того — запись 1 (+1) и historian 1 (+1) раз в 20 ходов.
   - В оригинале RoleCall: recall — до 3–4 вызовов, writer — до 8 раундов, historian — до 8 раундов.
   - Хроника: 0 вызовов перед ответом и ≈ 1,1 в фоне.
3. **Размер промпта.**
   - Снимок Compendium — 30 000 токенов. В RoleCall к нему добавляется ещё 20k на ростер, в Bunraku `SNAPSHOT_TOKENS` = 30 000.
   - В демо M5 у Летописца ≈ 6,5k токенов (40 % окна 16k), и снимок туда просто не влезает.
4. **Схема.**
   - Compendium: 11 типов и ≈ 280 полей, которые слабая локальная модель должна выдать через tagged JSON.
   - Хроника: плоская `LoreEntry` и не больше 5 операций.
5. **Форма хранения.** Compendium пишет в библиотечные книги под проверкой ревизий. Это противоречит D-3 и правилу «производное вычисляется, а не хранится».
6. **Дублирование.** В Bunraku Compendium уже есть целиком: 3 151 строка core и 1 710 строк studio. §12.5 и так оставляет Compendium и recall на стороне Bunraku через `beforeAssemble`. Порт в ядро дал бы вторую копию.

**Что из Compendium всё равно берётся.**
- Из Bunraku (переработка Chi):
  - `filing-prompt.ts` (68) и `historianMessages` — с правилами «по умолчанию ничего не записывать», «без дублей», «guidance только сужает»;
  - `filing-schema.ts` (86) и `filing-stage.ts` (80);
  - правило слияния из `merge.ts`, `findMatch`.
- Из RoleCall — уроки и тесты:
  - водяной знак — только из пересказов;
  - задержка записи;
  - подавление видимого;
  - «читать перед записью» (VVS-742).

**Как оставить дверь открытой.**
- Сейчас — резерв `data?` в `MemOp` и `ChronicleMeta` [D-69].
- Позже — типизированный слой поверх той же свёртки `mem`, ≈ 250–300 строк: entry-types, merge, render, findMatch.
- Recall — отдельный агент до ответа на `structuredCall`, в рамках D-7.
- Дерево — только производное.

**Что решить с Chi до M9.** Если Bunraku продолжит писать в свой Compendium, а ядро — в Хронику, рассказчик получит пересекающиеся факты из двух книг. Варианта два:
- Bunraku ставит `memory.enabled=false` и держит Compendium через `beforeAssemble`;
- Bunraku переходит на Хронику.

**Plan C (Character Minds)** — работа Леви: ≈ 2,2 тыс. строк тулов и mind-stream плюс ≈ 7,5 тыс. в `lib/character-mind`. Портировать его можно, но он вне v1 (§7.6, D-4): ему нужны Supabase, pgvector и эмбеддинги. Это не отказ, а очередь: после M9, отдельным агентом на `structuredCall` и полосе.

---

## Примечания к ревизии

**Отклонено.**

1. *Ревью 2: пометить D-15, D-18, D-19, D-25 статусом «решение архитектора».* Бриф задаёт ровно два статуса. Вместо этого такие решения помечены «(техн.)», все решения со статусом «ждёт подтверждения» внесены в список решений, а вопрос 12 спрашивает о технических пакетом.
2. *Ревью 2: удалить `usage.parentToolCallId`.* Поле оставлено необязательным: это прямое требование критика исследования. В v1 оно просто пустое.

**Сделано частично.**

3. *Ревью 2: удалить транспорт `tool` из `structuredCall`.* В v1 он не реализуется, но имя зарезервировано: критик исследования называет native-auto+strict+корректирующий проход допустимым транспортом.
4. *Ревью 1: при безусловном коммите reply, у которого родитель ушёл с пути, — `end{dropped}`.* Вместо этого ответ вешается под исходного родителя хвостом, чтобы не терять оплаченный текст. Сбрасывается он, только если родитель скрыт.
5. *Ревью 2: `conflict`/`commitAnyway` на M3.* Перенесено на M6: по тому же ревью сервер протокола ушёл после памяти, а до M6 второго писателя нет.
6. *Ревью 1 «общий гейт уже в M0» и ревью 2 «гейты — на M9».* Совмещено так: механизм спроектирован целиком сейчас (§12.5), точки вызова есть с M1 как пустые, реализация — на M9.
7. *Ревью 2: убрать Lookback и D-24.* Lookback убран из v1, но D-24 остался в таблице со статусом «отложить», чтобы номера решений не съехали.

**Принято с явным отступлением от требований критика исследования.**

8. *Ревью 2: убрать `chk{round}`.* Критик требует чекпоинт после каждого раунда тулов. Но восстановление не продолжает цикл, а тулы v1 только читают, так что повторять нечего. Чекпоинт раунда вернётся вместе с пишущими тулами.
9. *Ревью 2: убрать закрепление `id_slot`.* Критик называет его опцией; оно отложено, а в v1 его заменяет вытеснение фоновых запросов.

**Ревизия 3 (25.10.2026, решения Леви).**

10. *Лицензия* — AGPL-3.0-or-later вместо рекомендованной Apache-2.0 [D-11]. Отсюда следует, что зависимости теперь «совместимые с AGPL», а не только пермиссивные (A-7).
11. *Происхождение кода.* Правило «ничего не копировать, чистая комната» заменено правилами портирования (§2) [D-32, A-5]:
    - из RoleCall берётся всё, что работает, включая Compendium и Plan C;
    - из Bunraku — по ситуации;
    - копирайты сохраняются, порт учитывается в `PROVENANCE.md`.

    Удалены CI-grep идентификаторов, проверка `jscpd` и требование выбрать числа заново.
12. *Kintsu* — принят вариант «сначала предупредить Chi, разговор о переезде — с демо M3–M4» [D-14].
13. *Затронутые разделы* помечены «рев. 3»: §2, §4, §7.3, §7.4, §7.5, §9.2, §12.5, §14, §16, §17, §18.
14. *Без изменений.* Контракты §5–§11 не пересматривались. Источник каждого модуля определит отдельная карта портирования. Новые открытые вопросы — 13 (память) и 14 (вклады, D-34).

**Ревизия 4 (25.10.2026, карта портирования).**

15. Добавлены разделы:
    - §19 — карта портирования: 79 строк модулей, источники с коммитами;
    - §19.10 — изменения контракта D-35…D-73, ждут подтверждения;
    - §19.11 — доводы по вопросу 13.
16. §15 заменён: M1 разделена на M1a и M1b, у каждой вехи есть источники и оценка в днях.
17. Карту проверил отдельный ревьюер. 18 утверждений подтверждены, 2 серьёзные и 15 мелких ошибок исправлены, среди них:
    - неверная атрибуция апрельского импорта `660a7d67a` — это коммит Chi;
    - три вердикта port понижены до adapt;
    - исправлен порядок зависимостей `shape.ts`, `normalize.ts` и `jsonrepair`.
18. Текст §5–§11 не менялся: изменения контракта вступят в силу после подтверждения.

**Ревизия 5 (25.10.2026, решения Леви по вопросам 13 и 15).**

19. *Память* — Compendium целиком [D-26], а не рекомендованная Хроника:
    - хранение — строки `mem` с типизированными `data` на пути [D-69];
    - что нужно спроектировать, перечислено в §7.4 «Рев. 5»;
    - M5 оценена в ≈ 25–42 дня, итог — ≈ 113–192 дня;
    - добавлены риски 17 и 18.
20. *Директор:*
    - D-61 принято: форма состояния и плана из Bunraku и RoleCall;
    - D-62 принято: директива отклоняется, только если пуста;
    - D-17 остаётся.
21. *Пресеты* — D-71 принято в смешанном варианте: ST-пресеты по правилам ST, экспорты RoleCall по правилам RoleCall.
22. Текст §7.3 и §5.8–§7.4 ещё не переписан под D-61 и Compendium. Это сделает следующий проход.

**Ревизия 6 (25.10.2026, проект Compendium в ядре).**

23. Переписаны §5.8, §7.3 (под D-61…D-65), §7.4, §19.7 и веха M5; новые решения D-74…D-89 (§19.10). M5 — 32–52 дня, итог — ≈ 120–202.
24. Проект проверили два ревьюера: сверка фактов и согласованность с реализмом. Приняты все замечания уровней blocker и major. Частично принято одно: окно historian в lite не уменьшено — цену запуска задаёт вывод (пересказ и переписанный обзор), и меньшее окно дало бы больше запусков; вместо этого — уведомление `memory_starved` и приоритет голодающей задачи.
25. Главные правки по ревью: ёмкость origin не берётся из `/slots` (общий KV llama-server); на локальном origin фон не идёт рядом с ходом и стартует с задержкой `idleDelaySec`; закрепление `id_slot` перенесено на M5c; `/memory undo` больше не превращается в повторную запись; резерв ответа на малом окне [D-89]; относительный критерий качества prefetch; §5.9, §7.2 и D-61, D-62 согласованы с §7.3.
26. Заново проверены: 15 упоминаний `commit_planning_round.X`; system filing — 1 148 токенов, список полей — 620, `LITE_FIELDS` — 431; выбор слота, общий KV и `id_slot` — по исходникам llama-server.

**Ревизия 7 (26.10.2026, ответы на вопросы 5–12).**

25. Приняты все умолчания вопросов 5–12: D-1–D-10, D-12, D-13, D-15, D-16, D-18–D-25, D-28–D-31, D-33.
    - При префилле в пресете тулы рассказчика в этом ходу выключены [D-28].
    - Других агентов в v1 нет: Character Minds — после M9 [D-4].
    - Импорт `.vnpack` остаётся «позже» [D-6].
    - Порядок вех не меняется [D-8].
26. Остаются открытыми: вопрос 14 (DCO или CLA), вопрос 15 (D-35…D-60, D-63…D-70, D-72, D-73 пакетом), вопросы 16–20 по Compendium (D-74…D-89).

**Ревизия 8 (26.10.2026, вопросы 14 и 15).**

27. *Вклады — DCO плюс соглашение команды* `docs/TEAM-LICENSING.md` [D-34, §2 п. 7].
28. *D-35…D-73 приняты.*
    - D-43 — с правкой: числовые `{{random}}` в экспортах RoleCall переписываются в явный список, если в диапазоне не больше 101 значения.
    - В D-66…D-68 действуют решения Compendium там, где они расходятся.
29. *Остаются открытыми:* вопросы 16–20 (D-74…D-89) и D-27.

**Ревизия 9 (26.10.2026, вопросы 16–20).**

30. Приняты D-74…D-89:
    - recall по умолчанию `auto`: prefetch на локальном origin, sync на облаке [D-78];
    - recall выбирает и записи обычных ST-книг [D-76];
    - список отступлений показывается Chi до M5b, ей предлагается M5a [D-88];
    - правка или скрытие сообщения переписывают проход filing [D-86];
    - при нехватке сроков первой режется M5c.
31. Все вопросы §18 закрыты. Открыто только D-27, а до начала кода нужен `docs/TEAM-LICENSING.md` (TL;DR).

**Ревизия 10 (26.10.2026, M1a реализована).**

32. *M1a готова.* `rp-core/src` — ≈ 11 тыс. строк, тесты — ≈ 9 тыс., всего 671 тест. Демо и замеры — `docs/M1A-DEMO.md`: свёртка 10k сообщений — ≈ 10 мс, `fsync` каталога под Bun работает.
33. *Контракт уточнён по ходу реализации*, текст §5.3, §6.6 и §6.7 синхронизирован:
    - хвостовой коммит — одна строка `msg` с `tail:true`, голову не переносит;
    - событие `recovered` получило исход `dropped` и `draft`;
    - в `prep` появились поля `cont`, `prefill` и `model`;
    - в `EngineOptions` — `timeouts` и `timers`.
34. *Открытые мелочи на M1b и позже:*
    - при запасной модели с другим `caps.prefill` continue восстанавливается с режимом основной модели;
    - `engine.events()` буферизует без предела для подписчика, который не читает;
    - `--sandbox --seed` не реализован (формат seed не определён);
    - токены CJK недооцениваются;
    - у макросов нет канала ошибок;
    - вне ST-семантики `use_regex` у Seraphina не исполняется (регулярки — M2).

**Ревизия 11 (26.10.2026, M1b реализована).**

35. *M1b готова.*
    - Есть адаптер openai-chat, `config.toml`, секреты, записи возможностей с пробой каталога и REPL.
    - Добавлены команды `init`, `chat`, `probe` и `models`.
    - Работает на живой Ollama: первый токен — ≈ 6 с на холодной модели, 30–80 мс на тёплой.
36. *Найдено при реализации:*
    - **fetch в Bun 1.3.14** имеет собственный таймаут простоя в 5 минут. `http.ts` выключает его через `timeout:false`, таймауты принадлежат движку (§8.8).
    - **Ollama** не сообщает свой `num_ctx` через API, а по умолчанию это 4096. Окно нужно задать в `[caps."conn:model"] context_length` или параметром `num_ctx` в Modelfile. Иначе сервер молча обрезает промпт, и ядро предупреждает `notice{context_truncated_by_server}`.
    - **Текст ошибок провайдера** больше не попадает в сообщения: `ProviderError.message` — фиксированная фраза на код, сырой текст лежит в `detail` и виден только под `--debug`, с вырезанными секретами.
37. *Открытые мелочи:*
    - после `finish_reason` без `[DONE]` ход ждёт таймаут простоя, прежде чем закоммитить;
    - `models` при 401 завершается с кодом 0;
    - текст, набранный во время ответа в REPL, не виден до конца ответа;
    - `key_cmd` переживает `kill -9` самого rp-core.
