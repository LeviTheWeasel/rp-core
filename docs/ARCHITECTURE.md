# rp-core — итоговая архитектура

*Документ для Леви, 27.10.2026, ревизия 15.*

*Ревизия 15: этап M4.5 — TUI — готов. `rp-core tui` и `rp-core new --tui` открывают чат на весь экран терминала, в три колонки, на OpenTUI. Новые решения D-125…D-139 ждут подтверждения — вопрос 23. Вопросы 21 и 22 тоже ещё открыты.*

*Ревизия 14: M4 (Story Director) реализована. Новые технические решения D-98…D-124 ждут подтверждения — вопрос 22. Вопрос 21 (D-90…D-97 и правка D-59) тоже ещё открыт.*

*Ревизия 13: M3 реализована (ревизии 10–12 — M1a, M1b и M2, см. «Примечания к ревизии»). Новые технические решения D-90…D-97 и правка D-59 ждут подтверждения — вопрос 21.*

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
  - *Рев. 15:* `rp-core tui` — тот же REPL на весь экран, в три колонки (§12.4.1).
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
- **Вехи по умолчанию [D-8], рев. 4:** M1a ядро хода на скриптовом провайдере → M1b локальная RP в терминале → M2 пресеты и лорбуки → M3 тулы и поиск → M4 Директор → M4.5 TUI (рев. 15) → M5 Compendium → M6 `--stdio` → M7 Anthropic → M8 Gemini → M9 стык с Bunraku.
- **Объём и источники (рев. 4, §19).**
  - ≈ 19 тыс. строк кода ядра (рев. 6, с Compendium; в рев. 4 — ≈ 16 тыс.) плюс 3,9 тыс. строк личностей Директора.
  - Источник есть примерно у 65 % логики. Оболочка (журнал-дерево, движок, CLI) пишется с нуля. Провайдеры, Директор, тулы и лор в основном адаптируются из Bunraku и RoleCall.
  - Оценка — ≈ 98–167 рабочих дней одного разработчика с ИИ (§15). С Compendium целиком (рев. 6) — ≈ 120–202.
  - *Рев. 13:* после M3 в `src` ≈ 34 тыс. строк TypeScript, в тестах — ≈ 43 тыс.
  - *Рев. 14:* после M4 в `src` ≈ 46 тыс. строк, в тестах — ≈ 55 тыс.
  - *Рев. 15:* после TUI в `src` ≈ 50 тыс. строк, в тестах — ≈ 61 тыс.
- **Статус (рев. 15, 27.10).** Реализованы M1a, M1b, M2, M3, M4 и этап M4.5 — TUI (§15; «Примечания к ревизии», п. 32–63). D-1…D-89 приняты, кроме D-27. Ждут подтверждения пакетом три набора технических решений: решения M3 — D-90…D-97 и правка D-59 (вопрос 21 в §18), решения M4 — D-98…D-124 (вопрос 22) и решения TUI — D-125…D-139 (вопрос 23). Что ещё открыто:
  - **D-27** — судьба существующих сцен Bunraku при переходе на ядро. Решается с Chi, до M9.
  - **`docs/TEAM-LICENSING.md`** [D-34] — написать и подписать до первого внешнего коммита.
  - **Разговоры с Chi:**
    - предупредить о rp-core и согласовать коды выхода и флаги с Kintsu [D-14];
    - показать список отступлений Compendium до M5b [D-88];
    - предложить ей M5a (M4a уже сделана: это порт её кода из Bunraku);
    - карта алиасов для ключей вне схемы в примерах личностей [D-111];
    - сказать ли о TUI сейчас: он пересекается со Stage из плана Kintsu [D-14] (вопрос 23).
  - **TUI в Warp** — смотрит Леви: сам Warp мы не запускали (§15, M4.5).
  - **Следующая веха** — M5: Compendium (§15).

---

## 1. Цели и не-цели

### 1.1 Цели: семь способностей из списка Леви

| # | Способность | Механизм в ядре | Веха |
|---|---|---|---|
| 1 | Искать по ранним сообщениям | Тулы `search_history`/`read_history` по активному пути, с нормализацией и лёгким стеммингом кириллицы (§7.5). В REPL — `/search`, в библиотеке — `SessionHandle.search`, в протоколе — `history/search` (M6) | M3 |
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
| **Зависимости** | `jsonrepair` (ISC), `re2js` (MIT), `gpt-tokenizer` (MIT); в `package.json` закреплены `re2js` 2.9.0 и `gpt-tokenizer` 4.1.0 (с M2), `jsonrepair` 3.14.0 (с M3). Позже MCP-клиент и ACP SDK (Apache-2.0); pi-ai (MIT) [D-19] | Любая лицензия, совместимая с AGPL-3.0 |

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

**Что это меняет в остальном документе.** Разделы §5–§11 описывают **целевой контракт** ядра: типы, жизненный цикл, правила. «Спроектирован заново» теперь значит «контракт ядра», а не «запрещено портировать». Откуда берётся каждый модуль, решает **карта портирования — §19** (рев. 4). Там, где порт оказался лучше контракта, предложены изменения D-35…D-73 (§19.10). Все они приняты (ревизия 8; D-43 — с правкой для экспортов RoleCall); где текст §5–§11 с ними расходится, действуют они. *Рев. 13:* решения M3 (D-90…D-97, правка D-59) уже в коде, и §5–§11 описывают код; подтверждения ждут сами решения (вопрос 21).

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
      assemble.ts       # чистая assemble(input) → {messages, tools, prefill, trace, varsDiff, toolRoom, kept}
      assemble/gap.ts   # заметка о пропуске и напоминание для тулов истории [D-96]
      shape.ts          # приведение под модель по ModelCaps (роли, префилл, кэш-метки)
      depth.ts          # ЕДИНСТВЕННАЯ функция глубины
      macros.ts  budget.ts  tokens.ts  rng.ts
    text/
      normalize.ts      # normalizeTerm: NFKC, регистр, ё→е, лёгкий стемминг
      lexscore.ts       # одно лексическое ранжирование: search_lore, селектор, шорт-лист и ростер Compendium
    lore/      engine.ts  keys.ts  timers.ts  scan.ts  place.ts   # place — куда идут сработавшие записи (M2)
    formats/
      native.ts         # Character, Persona, Preset, LoreBook + валидаторы
      card.ts           # CCv2/V3: JSON, PNG tEXt chara/ccv3, character_book
      st-preset.ts  st-worldinfo.ts
      import.ts  kind-markers.ts  library.ts   # распознавание файла и запись в library/ [D-72]
      compendium-v1.ts  # кодек compendium-v1.0.0 (RoleCall, Bunraku): импорт книги и экспорт копии
    providers/
      types.ts  caps.ts  caps-data/{hosts,models}.json  probe.ts
      probe-active.ts   # активные пробы `rp-core probe --active` (M3)
      http.ts           # fetch с замком на хост, таймауты первого байта и простоя
      sse.ts  reasoning-tags.ts
      openai-chat.ts    # M1
      anthropic.ts      # M7
      gemini.ts         # M8
      scripted.ts       # script:
      record.ts         # record: / replay: (M2)
    tools/     types.ts handles.ts run.ts args.ts prompted.ts leaks.ts builtin/{index,history,lore}.ts
    agents/
      structured.ts     # structuredCall: общий транспорт JSON для Директора и агентов Compendium
      director/         # state, plan, momentum, reduce, prompt, render, call, personalities/ [D-61]
      compendium/       # types, notes (M3: заметки как книга лора), merge, render, apply, tree, select,
                        # place, world, filing, historian, recall/{index,prompt,parse,run}, profile, lexical
    protocol/  events.ts commands.ts rpc.ts jsonl.ts coalesce.ts
    config/    config.ts secrets.ts
    testing/   index.ts # M9: script/record/replay, describeRecordStoreConformance
    cli/       main.ts repl.ts render.ts oneshot.ts signals.ts bench.ts   # bench — rp-core bench ttft (M5c)
      repl-view.ts      # M4.5: порт вывода REPL — ReplView, TurnView, BannerInfo; LineView — построчный REPL
      tui/              # M4.5: rp-core tui на OpenTUI — run, app, source, keys, io, view, theme, transcript,
                        # turn-view, sgr, sanitize, models-pane, agents-pane, agents, types [D-125…D-139]
  test/  fixtures/{sse,assemble,sessions,scripts,cards,presets,lore,ru}
```

**Рантайм-зависимости по вехам:**

| Веха | Добавляется |
|---|---|
| M1 | ничего |
| M2 | `re2js` и `gpt-tokenizer` (загружается лениво) |
| M3 | `jsonrepair` (только в `tools/args.ts`) |
| M4.5 | `@opentui/core` ровно 0.7.0, с нативной библиотекой; грузят его только `rp-core tui` и `new --tui` [D-126] |

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

Если роль `director`, `recorder` или `recall` указывает на `'narrator'` (или `recall` — на `'recorder'`), а пресет задаёт семплеры, то агенты их **не** наследуют. Агенты используют только `Binding.samplers`; иначе у них температура провайдера по умолчанию. *Рев. 14 [D-119]:* Директор, который следует за рассказчиком, берёт у его привязки только соединение и модель — не `maxTokens`, не семплеры, не `reasoning` и не `fallback`; его температура — 0,7, если своя привязка Директора не задаёт другую [D-101].

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

**Компактизация.** `rp-core compact` переписывает файл без строк `chk` и `prep` у закрытых ходов. Это единственная операция, которая переписывает журнал: сначала пишется временный файл, затем выполняется rename под lock. *Рев. 14 (M4) [D-114, D-124]:* номера `seq` сохраняются, поэтому версии не меняются. Перед rename compact проверяет, что lock всё ещё его, а журнал — тот же файл того же размера и mtime. Переписанный файл читается назад и должен дать те же строки минус убранные; строку, без которой читатель принял бы пропущенную им строку, compact оставляет. Режим файла и mtime журнала сохраняются. Команда — §12.3.

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
- **`reasoning_content` DeepSeek** — простой текст. Он берётся из сырых блоков `reasoning` ответов той же пары `gen.connection` и `gen.model`. Ответ без такого блока (приветствие, ответ другой модели) получает в запросе с тулами заглушку `" "` (§8.4) [D-94].
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

Раунды тулов хранятся **внутри** assistant-сообщения как чередование блоков. Это нужно для показа, поиска и полной трассы. Каждый раунд даёт по порядку:

- `reasoning` — сырое рассуждение раунда, если оно было;
- `text` — видимый текст раунда, если он не пустой. Перед ним стоит `"\n"` [D-55], если сохранённый до него текст не пуст и не кончается пробельным символом;
- `tool_call` на каждый вызов, затем `tool_result` на каждый вызов, в порядке вызовов.

Ответ из двух раундов с двумя вызовами выглядит так: text, tool_call, tool_call, tool_result, tool_result, text.

- **id вызова** — id сервера, если он проходит `SAFE_ID` и ещё не встречался в ходе. Иначе — `call_<раунд>_<i>`, при совпадении с суффиксом `_2`, `_3`…
- **Имя и аргументы.** Имя, которое не проходит `SAFE_NAME`, хранится как `invalid_tool`. `args` — канонический JSON разобранных аргументов или `'{}'`, если их не удалось прочитать.
- **`tool_result` с `error:true`** — тул сообщил ошибку или не выполнялся: неизвестный тул, плохие аргументы, `cancelled` после Stop (§6.5).
- **Блоки всегда парные.** Вызовы, которые модель сделала на финальном раунде, не исполняются и не хранятся (§7.1).
- **Ход без тулов** хранит `[reasoning?, text]`, как в M2.
- **`gen` хода.** `transport` — `native` или `prompted`, если тулы предлагались, иначе `none`. `rounds` — вызовы модели в цикле, который дал ответ. `usage` — сумма по всем вызовам хода, включая повтор и запасную модель; `cost` в ней есть, только если он есть у каждого вызова.

В последующих ходах сборка рендерит только текст [D-16]. Текстовые блоки сообщения склеиваются так, как стримились, и уходят одним текстовым блоком, поэтому ответ из нескольких раундов не режется на части. Так делают и RoleCall, и Bunraku, и у этого три плюса:

- префикс стабилен;
- native- и prompted-формы не смешиваются;
- подписанные рассуждения из чужих ходов не попадают в запрос.

Исключение — эхо рассуждений DeepSeek в запросе с тулами: сырые рассуждения ответов той же модели идут перед их текстом (§5.4, §8.4) [D-94].

Вариант «отдавать тулы и в последующих ходах» — позже, если найдётся потребитель.

### 5.7 Трасса

```ts
interface Trace {
  seed: number; now: string; window: number; reserve: number;
  tokens: { estimated: number; reported?: number; counter?: 'chars' | 'o200k' };   // estimated — сообщения и префилл запроса (M2) плюс нативные объявления тулов (M3)
  blocks: { src: string; role: string; tok: number }[];          // 1:1 с отправленными сообщениями
  lore: { fired: { book: string; id: string; why: string }[]; cut: string[]; budget: number;
          unsent?: Record<string, string> };                     // сработала, но пресет не берёт её слот (M2)
  recap: { ids: string[]; arcs: { key: string; rev: number }[]; boundary: string | null };   // что стоит в слоте и где обрезка (§7.4.4)
  compendium?: { rev: string; source: 'sync' | 'prefetch' | 'lexical' | 'reused' | 'off';
                 picks: { ref: string; via: 'mention' | 'model' | 'window' }[];
                 injected: { ref: string; tok: number }[]; cut: { ref: string; tok: number }[];
                 repeated: string[]; hidden: number };                // без текстов записей (§7.4.1)
  prefill: 'sent' | 'tools_off' | 'skipped_for_tools' | 'unsupported' | null;   // [D-28]
  macros: { unknown: string[] };
  trimmed: { from: string; to: string } | null;
  calls: { callKey: string; agent: string; model: string; ms: number; usage?: Usage }[];   // строка на вызов модели
  agents: Record<string, { status: 'done' | 'reused' | 'skipped' | 'failed'; code?: string; transport?: string }>;
  tools?: { round: number; callId: string; name: string; ok: boolean; repaired?: string[];       // строка на вызов тула (M3)
            refused?: 'final_round' | 'unknown_tool' | 'bad_args' | 'cancelled'; ms?: number; chars?: number; cut?: true }[];
  rounds?: { n: number; transport: 'native' | 'prompted';                                         // цикл тулов (M3)
             ended: 'answer' | 'max_rounds' | 'ceiling' | 'guard' | 'room' | 'stopped' | 'error'; room: number; roomLeft: number };
  hooks?: { name: string; ok: boolean; note?: string }[];        // M9
  presetHash: string; loreHashes: Record<string, string>;
  loreNames?: Record<string, string>;                           // имя книги по ключу источника: таймеры идут за миром по имени (M2)
  partial?: true;                                               // трасса из `prep` восстановленного хода
}
```

- **Размер.** Трасса компактная, 1–3 КБ. Полные тексты запросов не хранятся.
- **Пересборка.** `/preview --turn <id>` пересобирает запрос детерминированно по `seed`/`now` из записи `turn`. Если с тех пор что-то изменилось, предупреждение `preview_inputs_changed` называет что: пресет, книги, история (правка или скрытие сообщения на пути — сверяется по журналу), обрезка истории, авторская заметка или вставки, окно, модель или только раскладка сообщений под модель (с причиной: соединение модели, post-processing пресета, caps). Это же предупреждение выводит `/trace`.
- **Отладка.** `--keep-requests` пишет полные тексты в `sessions/<id>.requests/` — пока не реализовано, нужно к демо M5. До тех пор полный запрос показывает `/preview`.
- **Ход с тулами.** `blocks` и `tokens.estimated` описывают запрос раунда 0: `/preview --turn` сверяет их один в один. `tokens.reported` — prompt-токены, которые сервер насчитал за раунд 0; только они идут в EMA [D-50] и в проверку окна сервера. В `calls` — строка на каждый вызов модели; `callKey` рассказчика — `<turn>:narrator:<раунд>`, у повтора и запасной модели раунда 0 — тоже `:0`.
- **`tools`** — строка на вызов тула, без аргументов и текста результата: раунд, id, имя, исход, время, длина результата и `cut`, если результат обрезан. `refused` — почему вызов не выполнялся: `final_round` (вызов на финальном раунде, §7.1), `unknown_tool`, `bad_args` (цепочка D-56 сдалась), `cancelled` (Stop).
- **`rounds`** есть, только если ход предлагал тулы. `n` — вызовы модели в цикле, финальный раунд включён. `ended` — почему цикл перестал звать тулы (§7.1). `room` — комната тулов, которую оставила сборка [D-93], `roomLeft` — что от неё осталось, в токенах бюджета.
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

- **`normalizeName`** — порт `BR:relationships.ts:39`: нижний регистр, всё, кроме букв, цифр и пробелов, превращается в пробел. Он учитывает Unicode, так что кириллица сохраняется. Изменения порта [D-95]: сначала NFKC, `ё` → `е`, комбинирующие знаки (`\p{M}`) остаются, как в классе слова D-46; пробелы схлопываются, края обрезаются. Поэтому «Ёж», «ёж» и «Еж» — одно имя. Имя без букв и цифр нормализуется в `''`, и заметку с таким заголовком свёртка не создаёт (`invalid`).
- Ключ не меняется при переименовании записи.
- **Ключ — не хэндл.** Модель и человек видят короткие хэндлы.
  - `C<n>` заметки — её номер по порядку создания среди всех заметок пути, включая списанные, с 1 (`noteRefs`). Номер один и тот же в `/memory` и в выводе тулов и от хода к ходу не меняется: `C3` в строке поиска и `/memory show C3` — одна заметка [D-59]. `read_lore` понимает `C<n>` любой живой заметки, даже если поиск этого хода её не показывал; на `C<n>` списанной заметки он отвечает `no such handle`.
  - `L<n>` записей лора в тулах и `e<n>` в индексе recall живут один ход.

**Свёртка** — чистая функция `foldCompendium` (`agents/compendium/apply.ts`); `session/fold.ts` вызывает её для каждого `PathView` (§5.11):

```ts
compendiumAt(msgId) = fold(
  memRows.filter(r => r.on === null || ancestorsOrSelf(msgId).has(r.on))   // привязка к пути
         .filter(r => !stale(r))                                           // D-68.4
         .filter(newestActionPerKey),                                      // refile и revert
  bySeq, applyMemOp, readableLibraryEntries)                               // затравка — типизированные записи книг
```

Сейчас из фильтров работает только привязка к пути: строки человека (`key:null`) применяются все. Устаревание и «новейшее действие по ключу» касаются строк агентов и появятся вместе с ними (M5a), как и затравка из типизированных записей книг.

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

**Стоимость.** Строки `mem` не меняют `version` (§5.3), поэтому свёртка кэшируется по `(version, lastMemSeq, хеши читаемых книг)`. Пока книг в свёртке нет, сессия кэширует дерево и `PathView` по `(version, lastMemSeq)`.
- Цель — 5 000 строк и 1 500 записей быстрее 30 мс, в пределах 50 мс на `PathView` (§5.11).
- Если бенчмарк не выдержит, свёртка станет инкрементальной: строки только дописываются, и при том же пути применяются лишь новые.

**Заметки** — записи человека без типа (`note`), бывшая ручная Хроника. Они есть с M3.
- **Как пишутся.** Глаголы `memoryAdd`, `memoryEdit`, `memoryRetire` и `memoryRestore` (в REPL — `/memory add|edit|retire|restore`, §7.4.8) пишут по одной строке `mem` с `key:null`, `on:null`, `by:'user'` и одной операцией, с fsync. Версию строка не меняет (§5.3). Пока идёт ход, глаголы получают отказ `session_busy`. О каждой правке приходит событие `memory` с `kind:'note'`, `by:'user'` и `change` — `note`, `edited`, `retired` или `restored`.
- **Ссылка на заметку** — `C<n>`, ключ `note:…` или заголовок, если он однозначен.
- **Ключи по умолчанию.** `memoryAdd` без ключей пишет ключи `[заголовок]`. Если у заметки ровно такие ключи, переименование без новых ключей переносит их на новый заголовок; ключи, которые написал человек, остаются.
- **Книга заметок** — `notesBook(view.compendium)`: живые заметки по порядку создания, книга `{name:'Заметки', scanDepth:4, match:'stem', wholeWords:false, recursive:false}` с ключом источника `@notes`. Сборка ставит её перед книгами сессии, а движок лора собирает её отдельной группой сразу после книги карточки: бюджет режет заметки после записей карточки и до книг сессии. Нет живых заметок — нет и книги, и запрос остаётся как в M2.
- **Запись книги** — одна на заметку: позиция `{depth:4, role:'system'}`, `order` 100, текст `[Memory: <заголовок>]\n<текст>`. Ключи — ключи заметки, а если их нет — заголовок. Источник в трассе — `compendium` (§10.1). Заметки тратят бюджет лора.
- **Ключи сравниваются по основам**: «Мира» срабатывает и на «Миру», и на «Мирой».
- **Книга заметок — не мир.** Правило «книга читается один раз по имени» (§10.3) её не касается: лорбук или книга карточки с именем «Заметки» не прячет заметки, и заметки не прячут их.
- Заметки работают, что бы ни стояло в `compendium.enabled`.
- **Свёртка сейчас** применяет `note`, `edit`, `retire` и `restore` над заметками. Операции `file`, `arc` и `revert`, а также правка типизированной или библиотечной записи пропускаются с причиной `not_until_m5` в `issues`: их применит M5a, а строка из более новой версии не ломает чтение.
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
  transport?: 'structured' | 'tagged'; profile?: 'full' | 'lite'; model?: string;   // profile — рев. 14
  directive?: NarratorDirective; analysis?: PlanningAnalysis;   // форма — §7.3 [D-61]
  skipped: { path: string; why: string }[];
  attempts: { transport: string; outcome: string; ms: number; status?: number; finish?: string; tokens?: number }[];
  state: DirectorState;                 // после applyPlan и fitState (или прежнее с turn+1 при сбое)
  reducer: number;                      // версия редьюсера, которым получен снимок
  reusedFrom?: string;                  // id ответа, чей план повторно использован при свайпе [D-29]
  fromReasoning?: true;                 // план найден в рассуждениях, а не в видимом тексте [D-60]
}
```

**Как вычисляется состояние на сообщении пользователя U.** Берётся `dir.state` ближайшего предка-ответа, у которого есть `dir`. (Когда появятся правки человека, к нему будут применяться `dirEdit` на пути до U включительно.)

*Рев. 14 [D-103].* Это чистая функция `directorAt(tree, fromId)` в `agents/director/state.ts`, а не метод `PathView` (§5.11). Она идёт по `parent` от U включительно и берёт `dir.state` первого ответа ассистента, чей `dir` принимает `checkRecord` и у которого `reducer === 1`. Состояние несут и удачные, и проваленные записи. Скрытые ответы считаются: скрытие убирает текст, а не историю плана. Нечитаемый `dir` пропускается, и приходит `notice{director_state_invalid}` раз за сессию. Нет ни одного такого ответа — `emptyState()`: ход 0, `nextId` 1, mood `ambient`. Пока Директор выключен, его счётчик ходов стоит.

Из этого правила следует:

- **Свайп** планирует от состояния до заменённого ответа.
- **Будущая смена редьюсера** не переписывает уже сохранённые снимки.

**Восстановление.** Строка `prep` хранит `DirectorRecord`, и с fsync. Поэтому ответ, восстановленный после краша, получает свой `dir`: план не теряется, счётчик ходов идёт дальше.

**Размер.** Снимок ограничен лимитами и `fitState` (§7.3): ≤ 16 КБ типично, потолок 32 КБ [D-61]. *Рев. 14 [D-116]:* потолок считается в байтах UTF-8 и держится для любого письма. «≤ 16 КБ типично» для русского текста не держится: на 300 подробных русских ходах медиана — ≈ 20–24 КБ, максимум — 32 552 байта (§7.3).

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
                                        // состояние Директора — не поле: его даёт чистая функция directorAt(tree, fromId),
                                        // agents/director/state.ts (рев. 14, D-103; §5.9). PathView остаётся данными для M6
  compendium: CompendiumView;           // свёртка на голове (§5.8)
  compendiumAt(msgId: string): CompendiumView;   // M5a; пока вид пути до другого сообщения строит foldViewAt
                                        // книга заметок — не поле: её строит notesBook(compendium) при сборке (§5.8)
  castNames: string[];                  // имена и алиасы карточки и персоны: снимок мира, §7.3
  vars: Record<string, string | number>;
  fires: { msgId: string; fired: Trace['lore']['fired']; continued?: true; names?: Record<string, string> }[];
  continued?: ReadonlySet<string>;      // сообщения с правкой continue: их скан — на позиции msg + 1 (M2)
}                                       // срабатывания continue считаются с позиции msg + 1, как в ST (M2)
```

- **Кто читает.** Сборщик, агенты, тулы и снимки протокола читают только `PathView`.
- **Как считается.** `PathView` пересчитывается целиком при смене версии или новой строке `mem` и кэшируется по `(version, lastMemSeq)`: строки `mem` версию не меняют (§5.3), а свёртку Compendium меняют. Цель — < 50 мс на 10k сообщений. Если бенчмарк её не выдержит, тогда появится инкрементальная свёртка.

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
| `preview({draft?, turn?, explain?})` | ничего | M2 | Тот же путь сборки. Вместо директивы — заглушка, Директор не вызывается (*рев. 14:* свайп, который повторит план, показывает повторённую директиву, а `turn` — сохранённую директиву того ответа [D-106]). `turn` пересобирает прошлый ответ, `explain` даёт вердикты лора. В памяти резервируется seed следующего хода. С тулами — тот же выбор тулов, что у хода, и запрос раунда 0 |
| `search({query, before?, limit?})` | ничего | M3 | Тот же поиск, что у `search_history`, по активному пути (§7.5). Работает и во время хода |
| `notes()` | ничего | M3 | Заметки пути по порядку создания, живые и списанные (§5.8) |
| `memoryAdd` / `memoryEdit` / `memoryRetire` / `memoryRestore` | одна строка `mem` | M3 | Заметки (§5.8). Версию не меняют. Во время хода — отказ `session_busy`; ещё `invalid_params` и `not_found` |
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
   - Вход: `assemble({view, cast, preset, lorebooks, placements, caps, budget, seed, now, kind})`. `placements` — директива и блок Compendium (§7.4.1); заметки Compendium приходят с `view` и становятся книгой `@notes` (§5.8).
   - Выход: `{messages, tools, prefill, trace, varsDiff, toolRoom, kept}`. `toolRoom` — комната тулов [D-93], `kept` — id сообщений, чей текст ушёл в историю.
   - **Тулы выбираются двумя проходами сборки** [D-92]: проход A — без тулов, ровно запрос M2; проход B — со схемами, если по проходу A есть что предложить (§7.1). Шаги 4–5 — одна функция `buildRequest`; её же вызывает `preview`.
   - Правило «префилл или тулы» [D-28] применяется здесь.
   - Если не помещается одна только обязательная часть — `failed{code:'context_length_exceeded'}` и `end{failed}`, ничего не отправлено.
5. **Приведение под модель (shape) — чистая функция.** Роли, системные сообщения посреди диалога, префилл или подсказка continue, кэш-метки — всё по `ModelCaps`. Правки хоста задаются по индексу сообщения.
6. **Строка `prep`** с `dir`, `recall`, `vars` и трассой до отправки, с fsync.
7. **Хуки хоста (M9).**
   - `transformRequest` — гейт `transform`, fail-closed.
   - Гейт `review` — только при `inspect`.
   - Ответ `cancel`, Stop или уход потребителя дают `stopped{message:null}` и `end{dropped}`.
8. **Рассказ** — цикл тулов (§7.1).
   - Дельты приходят событиями `text`: видимый текст всех раундов с разделителями D-55.
   - Вызовы тулов приходят событиями `tool` (`start`, затем `done`). Каждый вызов модели, о котором сервер сообщил usage, — событием `usage`.
   - `chk{text}` пишется каждые 400 символов или каждую секунду, с тем же текстом, что события `text`. Пока идёт стрим, раз в 2 с делается `fdatasync`.
9. **Постобработка** [D-57].
   - Inline-рассуждения отделяет по тегам адаптер, ещё в потоке (§8.4).
   - Протёкшая разметка тулов вырезается. У ответа с раундами тулов — из каждого текстового блока отдельно: пустой блок выпадает, порядок блоков остаётся. Разделитель D-55 перед блоком ставится заново по тому, что осталось перед ним, так что вырезка не склеивает раунды.
   - **Сохраняется не всё, что стримилось.** Спаны, которые цикл превратил в вызовы (JSON в прозе, разметка другого диалекта, §8.3), уже показаны событиями и `chk`, но в хранимый текст не попадают: цикл убрал их из блоков раунда (§7.1). Черновик в событиях `failed` и `conflict` — тоже текст после постобработки.
   - `notice{code:'tool_markup_stripped'}` приходит раз за сессию. Он считает вырезанные блоки, спаны, ставшие вызовами, и блоки `<tool_call>` и теги с именем тула [D-97], которые раунд скрыл, не исполнив: в нативном раунде — неисполненные, на финальном — все, так что вызов блоком или тегом на финальном раунде даёт его рядом с `tool_calls_on_final_round`. Блок или тег, из которого вышел вызов раунда тулов (с результатом или с ошибкой), не считается: вырезатель скрыл его ещё в потоке.
   - Если видимого текста не осталось — например, весь текст хода был вызовом в JSON, — ход проваливается как пустой ответ (§7.1).
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

На continue нет ни Директора, ни тулов, ни агентов Compendium. Это правило одно для всех агентов. В запросе continue нет ни блока тулов, ни заметки о пропуске истории [D-92, D-96]. *Рев. 14 [D-106]:* контракт Директора в блоке ядра остаётся, а на глубине 1 повторяется сохранённая директива цели (`dir.directive`), если она есть; своего `dir` continue не пишет. Блок Compendium повторяет выбор цели из её `RecallRecord`, без вызова; тексты записей берутся из текущей свёртки (§7.4.2).

- **Модель принимает префилл** (`caps.prefill = 'assistant-last'`): текущий текст уходит последним assistant-сообщением, добавка приклеивается как есть.
- **Модель префилл не принимает** (Claude ≥ 4.6, deepseek-reasoner, Gemini): старый текст уходит обычным assistant-ходом, за ним — user-подсказка «продолжи с того места, где остановился, не повторяй». Добавка присоединяется через пустую строку.
- **Эхо.** Если добавка начинается с повтора старого текста, повтор срезается.
- **Добавить нечего** — `failed{nothing_to_add}` и `end`.
- **Коммит** — `edit{reason:'continue', turn}` с `gen` и `trace`.
  - У ответа с раундами тулов добавка дописывается в последний текстовый блок, порядок блоков остаётся. Если новый полный текст уже не начинается с прежних текстовых блоков, остальные блоки идут первыми, затем один текстовый блок — как у правки `edit` человека.

### 6.5 Stop

`stop` прерывает AbortController хода. Сигнал доходит до fetch провайдера, до `ctx.signal` каждого тула, до вызова Директора и до хуков хоста. Ожидающие гейты разрешаются как `cancel`, никогда как одобрение.

- **Текст уже пришёл.** Он коммитится с `finish:'stopped'`, событие — `stopped{message}`. Директива этого хода сохраняется в `dir`, потому что ответ существует.
- **Вызовы раунда, который ещё стримился,** отбрасываются: ни один из них не исполнялся.
- **Вызов, чей тул уже работал,** получает синтетический результат `cancelled` (`error:true`), поэтому в хранилище блоки всегда парные.
- **Текста нет.** Пишется `end{stopped-empty}`, событие — `stopped{message:null}`.
- **Остановленный ход** не повторяется и не переходит на запасную модель.

### 6.6 Сбой, повтор, запасная модель, конфликт

**Повтор.**

- **Условия.** Ещё не пришли текст, рассуждение или вызов тула, а ошибка — 408/425/429/500/502/503/504/524/529. Повтор и запасная модель оборачивают весь цикл тулов, поэтому на деле это раунд 0, и цикл запускается заново.
- **Как.** Один повтор с учётом `retry-after` (не дольше 8 с) и джиттером; событие `retry`.
- **Без повтора.** Неоднозначные сетевые ошибки после отправки тела (`fetch failed`) не повторяются: можно заплатить дважды.

**Запасная модель** (`fallback` в вызове или в привязке роли).

- Одна попытка, при тех же условиях и только с **другой** парой connection:model.
- Никогда не используется после Stop.
- Маршрут пишется в `gen.route`.
- **Запрос [D-90].** Обычно это запрос основной модели, приведённый под caps запасной (shape). Заново, для неё самой, он собирается с тем же `PathView`, seed и `now`, если у неё другой транспорт тулов (`caps.tools`) или ход предлагает тулы, а правило эха рассуждений у неё другое (§8.4) [D-94]: история не должна нести рассуждения чужой модели. Строка `prep` остаётся записью основной модели.
- Если запрос запасной модели не собирается (например, не помещается в её окно), ход кончается сбоем основной модели.

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
| Рассказчик | каждый ход | собранный промпт + тулы | блоки ответа | 1; с тулами — до `narrator.maxRounds` раундов с вызовами (по умолчанию 4, потолок 8) и финальный текстовый раунд |
| Story Director | до reply и guided re-roll; на обычном свайпе по умолчанию повторно использует план [D-29]; никогда на continue | состояние на U, импульс, свежая история, ход игрока | `PlanningRound` (директива + обновления состояния, §7.3) | 1 (+1 корректирующий); с повторами §6.6 — до 4, они входят в `CALL_CEILING` хода [D-101] |
| Compendium · recall | перед `reply`: sync, заранее в фоне (prefetch) или без модели; на свайпе и continue — повтор выбора | индекс кандидатов + свежая беседа | `entry_ids` → блок на глубине 1 | sync — 1 (+1); prefetch — 1 в фоне; повтор и lexical — 0 |
| Compendium · filing | фон, когда ответ принят [D-23, D-86] | обмен + снимок Compendium | операции `file` | 1 (+1) |
| Compendium · historian | фон, при принятии ответа (после filing): 20 ходов игрока за водяным знаком или 24 срезанных непокрытых сообщения | самое старое непокрытое окно + дайджест сюжетов | пересказы, сюжеты, обзоры арок | 1 (+1); раз в ~10 ходов на большом окне, раз в 4–5 в lite |
| Поиск по истории и лору | тулы | запрос | сниппеты | 0 |

Типичный ход со всем включённым: на облаке — 3–4 вызова на переднем плане (Директор ∥ recall, рассказчик 1–2) и ≈ 1 в фоне; на локальном бэкенде — 2–3 на переднем плане (Директор lite, рассказчик 1–2) и ≈ 2 в фоне (prerecall, filing; historian — раз в 4–5 ходов). Потолок на ход — 12 вызовов модели (`CALL_CEILING`), повтор и запасная модель рассказчика в их числе: раунд, который стал бы 12-м вызовом, — финальный текстовый.

### 7.1 Цикл рассказчика

Один цикл владеет **всеми** вызовами хода, включая первый, и каждый раунд стримится. В RoleCall первый вызов и движок были разделены, и это породило большинство его багов.

```ts
async function narrateRounds(c: RoundsInput): Promise<RoundsResult> {
  let wire = c.messages;                                  // из buildRequest(); внутри хода не пересобирается
  const t = c.tools;                                      // TurnTools | null: выбраны до отправки [D-92]
  const blocks: Block[] = [];
  for (let round = 0; ; round++) {
    const forced = !t ? null : round >= c.maxRounds ? 'max_rounds' : c.callsBefore + round + 1 >= CALL_CEILING ? 'ceiling'
                 : guard ? 'guard' : roomLeft < MIN_ROOM_TOKENS ? 'room' : null;
    const last = !t || forced !== null;
    const r = await streamCall({
      messages: t?.transport === 'native' && last && round > 0 ? [...wire, finalCueMessage(c.caps)] : wire,
      ...roundFields(t, c.caps, c.samplers, last),        // native: схемы и toolChoice 'auto' | 'none'; prompted: стопы
      prefill: t ? undefined : c.prefill,                 // префилл только в ходе без тулов [D-28]
      maxTokens: t ? roundMaxTokens(c.maxTokens, added, t.roomTokens) : c.maxTokens,
      onText: (d) => show(stripper.push(d)),              // события text и строки chk{text}; разделитель D-55
    });
    const calls = roundCalls(t, r);                       // нативные вызовы, блоки <tool_call> или утечки [D-57]
    if (!calls.length) return { blocks: [...blocks, ...own(r)], finish: r.finish, ended: forced ?? 'answer' };
    if (last) {                                           // модель проигнорировала 'none'
      notice('tool_calls_on_final_round');                // вызовы уходят в трассу, не исполняются
      return { blocks: [...blocks, ...own(r)], finish: 'max_rounds' };
    }
    const results = await runTools(calls, ctx, room);     // параллельно, в порядке вызовов, в долях комнаты
    blocks.push(...own(r), ...toolCalls(results), ...toolResults(results));   // own: рассуждение и текст раунда
    wire = [...wire, assistantMsg(r, r.replay), resultsMsg(results)];          // только дописываем; replay — в памяти
    roomLeft -= spent(wire.slice(-2)); added += spent(wire.slice(-2));         // комната тулов [D-93]
  }
}
```

**Правило «префилл или тулы» [D-28].** Префилл и раунды тулов в одном ходе не сочетаются: иначе получается пара assistant(prefill) + assistant(tool_calls), которую строгие шаблоны отвергают. Если модель ответит прозой сразу, префилл просто не дошёл бы. Поэтому выбор делается при сборке, один раз на ход:

| Условие | Что происходит | Сигнал |
|---|---|---|
| в пресете есть префилл, `caps.prefill ≠ 'none'`, `narrator.prefillVsTools = 'prefill'` (по умолчанию) | тулы рассказчика в этом ходу выключены, префилл отправляется | `notice{code:'prefill_disables_tools'}` раз за сессию; в строке статуса REPL `tools: off (prefill)`; `trace.prefill = 'tools_off'` |
| то же, но `prefillVsTools = 'tools'` | префилл не отправляется, тулы работают | `notice{code:'prefill_skipped_for_tools'}` раз за сессию; `trace.prefill = 'skipped_for_tools'` |
| префилл есть, но `caps.prefill = 'none'` | префилл не отправляется | `notice{code:'prefill_unsupported'}` раз за сессию; `trace.prefill = 'unsupported'` |

Первые две строки работают, только когда ходу вообще есть что предложить (ниже). Ход без тулов отправляет префилл, как в M2.

**Какие тулы предлагаются [D-92].** Набор выбирается до отправки, двумя проходами сборки (`engine/request.ts`), и до конца хода не меняется; свой набор бывает только у запасной модели, если её запрос собирается заново (§6.6).

1. **Проход A** собирает запрос без тулов — байт в байт запрос M2.
2. **Что предложить** — по проходу A:
   - `search_history` и `read_history` — если история не поместилась целиком (`trace.trimmed` не пуст);
   - `search_lore` и `read_lore` — если в лоре хода (книги персоны, карточки и сессии, заметки) есть включённая запись или живая заметка, которая в проходе A не сработала.

   На continue и при `caps.tools = 'none'` не предлагается ничего. Набор пуст — уходит запрос прохода A.
3. **Проход B** собирает запрос со схемами: блок тулов `core:tools` (§8.3), комната тулов, правило D-28, а у модели с эхом рассуждений — её сырые рассуждения в истории (§8.4) [D-94]. Если D-28 выключил тулы, уходит проход B без тулов: его трасса и уведомление говорят почему.
4. **Проход B не годится** — блок тулов не помещается или комната меньше `MIN_ROOM_TOKENS` (256 токенов): тулы стоили бы одного блока, и уходит запрос прохода A.
5. **Проход B обрезал историю, которую проход A оставил целиком,** а тулов истории в наборе нет: они добавляются, и проход B собирается ещё раз. Не помещаются оба набора — пробуются одни тулы истории: когда история обрезана, прочесть её важнее, чем несработавший лор. Не помещается и это — остаётся первый проход B.

`/preview` строит запрос той же функцией, поэтому показывает те же тулы.

**Заметка о пропуске и напоминание [D-96].** Когда предложены оба тула истории, а запрос оставляет часть сообщений за бортом, сборка добавляет два системных сообщения:
- `core:gap` — в чате, прямо перед первым сообщением после пропуска: `[Messages #A–#B of this chat are not shown here. search_history finds what was said in them; read_history shows them in full.]`, а для одного сообщения — та же фраза в единственном числе. Номера — как у тулов истории: позиции на пути с 1, скрытые сообщения считаются;
- `core:remind` — на глубине 0, после всех остальных вставок глубины 0. Текст зависит от транспорта тулов (`remindText`, `prompt/assemble/gap.ts`):
  - native (`REMIND_TEXT`): `(Part of this chat is hidden from you. If your reply depends on a detail from it — a name, a place, a promise, who said what — look it up with search_history before you write. If it does not, just write the reply.)`;
  - prompted (`REMIND_TEXT_PROMPTED`): та же просьба, но сам вызов показан отдельной строкой — `<tool_call>{"name": "search_history", "args": {"query": "one or two key words"}}</tool_call>`, — и модель просят после него остановиться. Эту строку и пример в блоке ядра строит одна функция, `promptedCallLine` (`tools/prompted.ts`), поэтому разойтись они не могут. Полный текст — в D-96 (§19.10).

Оба входят в фиксированную часть и не обрезаются; под заметку заранее резервируется самая широкая форма для длины пути. Заметка меняется, только когда сдвигается обрезка, а запрос с этого места меняется и так, поэтому закэшированный префикс не страдает. Напоминание — постоянный текст у конца запроса, у каждого транспорта свой; фиксированная часть меряет тот вариант, что уходит. С одними тулами лора, без тулов и на continue их нет.

**Комната тулов [D-93].** Сборка с тулами держит свободной комнату `toolRoom(window, reserve)` = round(0,25 × (окно − резерв)) токенов бюджета: ради неё история режется сильнее. Если обязательная часть всю комнату не оставляет, комнатой становится остаток. Комната — всё, что цикл может дописать в запрос.
- **До запуска тулов** раунд оплачивает своё: assistant-сообщение (видимый текст, своё рассуждение, если оно идёт эхом, эхо вызовов с сырыми аргументами), оболочку сообщения с результатами и финальную подсказку — цикл с тулами всегда кончается финальным раундом. Результатам достаётся остаток, в символах — 2,5 на токен (`roomChars`). `pageChars` для `read_history` — меньшее из `historyPageChars(окно)` и этого остатка. `runTools` делит остаток на доли до запуска (§9.1).
- **Результат, которому не хватило места даже на пометку обрезки,** приходит одной пометкой `NO_ROOM_MARK` — `[cut: no room was left for this result]`, — а не пустым.
- **Счётчик хода измерил результаты плотнее** 2,5 символа на токен (CJK, списки имён), и они перешли остаток больше чем на max(10 % остатка, 2 токена на вызов): раунд тулов запускается ещё раз в комнате, уменьшенной в той же пропорции. Тулы v1 только читают, так что повтор безопасен.
- **После раунда** из комнаты вычитается то, что раунд дописал на деле, а если следующий раунд финальный — и подсказка. Осталось меньше `MIN_ROOM_TOKENS` — следующий раунд финальный (`ended:'room'`).
- **`max_tokens` поздних раундов** — `roundMaxTokens`: резерв минус то, на сколько цикл перешёл комнату, но не меньше 1. Раунд 0 просит столько же, сколько ход без тулов. Так промпт плюс `max_tokens` остаётся в окне, даже когда один текст до вызова занял всю комнату.

**Правила цикла.**

- **Раунды.** Раунд — один вызов модели, и каждый стримится. Раундов с вызовами тулов — не больше `narrator.maxRounds` (по умолчанию 4). Значение больше 8 (`MAX_TOOL_ROUNDS`), заданное хостом в конфиге сессии, урезается до 8, и в ходе с тулами приходит `notice{code:'tool_rounds_clamped'}` раз за сессию. В `config.toml` `max_rounds` вне 1–8 — ошибка конфига (§13). Раунд финальный, если тулов нет или если выполнено одно из условий (при нескольких в `ended` идёт первое):
  - его номер ≥ `maxRounds` (`max_rounds`);
  - он стал бы 12-м вызовом модели за ход (`ceiling`, `CALL_CEILING`);
  - сработала защита от зацикливания (`guard`);
  - комнаты тулов осталось меньше `MIN_ROOM_TOKENS` (`room`).

  Цикл, который запускал тулы, всегда кончается финальным раундом. Причина пишется в `trace.rounds.ended`, даже если модель на финальном раунде просто ответила. `answer` — раунд, которому ещё можно было звать тулы, ответил без них; `stopped` и `error` — Stop и сбой.
- **Текст между раундами накапливается [D-16].** Протокол тулов просит модель сначала искать, потом писать. Перед первым видимым текстом раунда k > 0, если текст хода не кончается пробельным символом, в поток уходит один `"\n"` — событием и в `chk` [D-55]. Раунд без текста ничего не шлёт.
- **Сохраняется не всё, что стримилось.** Видимый текст каждого раунда с тулами проходит потоковый вырезатель блоков `<tool_call>` и тегов с именем предложенного тула [D-97]: они не доходят ни до событий, ни до `chk`. Но спан, который восстановление утечек превратило в вызов (JSON в прозе, разметка другого диалекта, §8.3 [D-57]), распознаётся только в конце раунда, и события с `chk` его уже показали. В хранимый текст и в запрос следующего раунда он не идёт: вызов исполняется или отклоняется, но рассказом не остаётся. Исключение — закрытый блок `<tool_call>` или тег с именем тула, ставший вызовом в нативном раунде: его вырезатель скрыл ещё в потоке. Из хранимого текста его убирает тот же вырезатель, с теми же стыками (`recoverLeaks` с `keep`), и в счёт `tool_markup_stripped` он не идёт. Разделитель D-55 в хранилище решается по сохранённому тексту (`storedSeparator`), так что убранный спан не склеивает раунды. Остальную разметку вырезает шаг 9 (§6.2).
- **Раунд в запросе** (§8.3).
  - **Нативный:** схемы и `toolChoice:'auto'`. Вызовы — из потока, а если их нет — восстановленные утечки предложенных тулов, в том числе блок `<tool_call>` без закрывающего тега после полного вызова и тег с именем предложенного тула [D-97]. В запрос дописываются assistant-сообщение (своё рассуждение раунда, если оно идёт эхом; видимый текст без разделителя и восстановленных спанов; эхо вызовов) с `replay` раунда и одно сообщение `role:'tool'` с результатами в порядке вызовов.
  - **Prompted:** тулов в запросе нет, к стопам семплера добавляется `PROMPTED_STOP` (`<tool_result`). Вызовы — блоки `<tool_call>` и теги с именем предложенного тула [D-97] в сыром тексте раунда, а если их нет — утечки других диалектов; нечитаемый блок — тоже вызов, с ошибкой вместо результата. В запрос дописываются сырой текст раунда с тегами, обрезанный по выдуманному `<tool_result>`, и одно user-сообщение с результатами.
- **Эхо рассуждений внутри хода** [D-18]. В нативном раунде своё рассуждение раунда идёт в его assistant-сообщение, если `caps.reasoning.echo ≠ 'never'` и вызов не выключает thinking (`reasoning:'none'` у модели с `canDisable`); что из него отправить, решает адаптер (§8.6). `replay` живёт только в памяти хода.
- **Финальный раунд** [D-91].
  - В нативном запросе — `toolChoice:'none'`, а схемы тулов остаются объявленными: Gemini отвергает tool-сообщения без схем. Сервер, который `tool_choice` не соблюдает (`caps.toolChoiceHonored = false`, Ollama), получает этот раунд без тулов: так решает адаптер `openai-chat` (§8.3).
  - Если до финального раунда были раунды с тулами, в запрос добавляется `FINAL_CUE`: тулы кончились, продолжи сцену, не упоминай тулы и не повторяй написанное. В нативном режиме это отдельное сообщение — `system`, если `caps.midSystem` равно `native` или `anthropic-native`, иначе `user`; `src:'core:final_cue'`. В prompted — абзац в конце сообщения с результатами.
  - Вызовы на финальном раунде (модель проигнорировала `'none'`) не исполняются и не сохраняются, текст раунда остаётся. В `trace.tools` идут строки с `refused:'final_round'`, `notice{code:'tool_calls_on_final_round'}` приходит раз за сессию, `finish` — `max_rounds`. Блоки `<tool_call>` и теги с именем тула этого раунда считаются скрытой разметкой: если модель позвала тул ими, рядом приходит и `tool_markup_stripped` (§6.2, шаг 9).
  - RP-ход всегда заканчивается прозой.
- **Ошибка — это событие, а не пустой ответ.** Правила пустого ответа читают весь ход. Если ни один раунд не дал видимого текста, ход проваливается, как в M2: `empty_response`, `content_filter`, `refusal`, а ответ из одних рассуждений — по [D-31] (§6.6). Раунды тулов такого хода не сохраняются. Ход, чей единственный видимый текст был восстановленным вызовом, тоже пуст. Финальный раунд без текста после текста в прежних раундах — обычный коммит.
- **Защита от зацикливания.** После каждого раунда для каждого вызова берётся тройка: имя, канонический JSON аргументов, sha-1 текста результата. Если любая тройка встречается 3 раза среди последних 8 вызовов хода, следующий раунд финальный.
- **Тулы читают `PathView` запроса** — свёрнутый на `upTo` (§6.3), а не текущую голову сессии. `ToolCtx` один на ход; `signal` (дочерний сигнал хода) и `pageChars` у каждого раунда свои.
- **Учёт.** Каждый вызов модели — строка `trace.calls` (§5.7) и, если сервер сообщил usage, событие `usage`. `gen.usage` — сумма по вызовам, `trace.tokens.reported` — prompt-токены раунда 0.

### 7.2 `structuredCall` — общий транспорт для JSON-агентов

Директор и агенты Compendium (recall, filing, historian) получают JSON через один помощник, `agents/structured.ts`. Правило выбора транспорта записано здесь один раз и одинаково для всех.

*Рев. 14.* Раздел переписан под то, что построено на M4 [D-98…D-100, D-117, D-121…D-123]. Пока помощником пользуется только Директор; агенты Compendium подключатся на M5.

```ts
type ReadResult<T> = { ok: true; value: T; skipped: Skip[] }
                   | { ok: false; code: 'invalid' | 'missing_directive'; message: string };
function structuredCall<T>(s: {
  agent: 'director' | 'recall' | 'filing' | 'historian';
  schema: { name: string; schema: JSONSchema };   // в structured уходит полем запроса responseSchema
  read(raw: unknown): ReadResult<T>;              // raw — разобранный JSON, корень уже проверен: объект
  system: string; user: string[];                 // user-сообщения по порядку; у Директора — промпт и давления
  tag: 'plan' | null;                             // null — голый JSON-объект, как просят промпты Bunraku (§7.4)
  route: { conn: Connection; model: string; caps: ModelCaps };
  transport: 'structured' | 'tagged';             // chooseTransport(caps); на весь ход
  samplers: Partial<Samplers>; reasoning?: ModelRequest['reasoning']; maxTokens: number;
  count?: (text: string) => number;               // счётчик сессии: max_tokens корректирующего прохода [D-121]
  repair: boolean;                                // false — без корректирующего прохода (recall lite, M5)
  callKeyPrefix: string;                          // `${turnId}:director` → `…:0`, `…:1`, …
  budgetMs: number; turnSignal: AbortSignal;      // бюджет агента; дочерний сигнал хода
  env: AgentCallEnv;                              // семафор, fetch, таймауты, часы, события retry и usage
}): Promise<
  | { ok: true; value: T; transport: Transport; skipped: Skip[]; attempts: Attempt[]; calls: TraceCall[]; fromReasoning?: true }
  | { ok: false; code: StructuredFailCode; message?: string; attempts: Attempt[]; calls: TraceCall[] }>;
type StructuredFailCode = 'transport_unsupported' | 'provider_error' | 'no_output' | 'undecodable'
                        | 'invalid' | 'missing_directive' | 'timeout' | 'aborted';
interface Attempt { transport: 'structured' | 'tagged'; outcome: AttemptOutcome; ms: number;
                    status?: number; finish?: string; tokens?: number }   // tokens — выходные
type AttemptOutcome = 'ok' | 'ok_reasoning' | 'retried' | StructuredFailCode;
// TraceCall — строка trace.calls (§5.7): { callKey, agent, model: 'conn:model', ms, usage? }
```

1. **Транспорт выбирается до вызова,** записывается в трассу и до конца хода не меняется. Выбирает вызывающий — функцией `chooseTransport(caps)`.
   - **`structured`** — если `caps.structuredOutput.mode = 'json_schema'` **и** поддержка подтверждена. Для облачных API её подтверждает пресет хоста (Anthropic `output_config.format`, Gemini `responseSchema`). Для локальных серверов (OpenAI-совместимый `response_format`) — активная проба (`rp-core probe <conn:model> --active`, §8.2: схема соблюдена — `confirmedBy:'probe'`) или пользователь (`structured_output` в `[caps]` — `confirmedBy:'user'`). Строку `hosts.json`, которая подтверждает это локальному серверу словом `host`, проверка данных возможностей не пропускает. Утверждение «llama.cpp/Ollama всегда превращают схему в грамматику» не принимается на веру.
   - **`tagged`** — во всех остальных случаях. Описание схемы идёт в system, ответ — один JSON-объект: внутри `<plan>…</plan>` у Директора, без тега у агентов Compendium (так написаны промпты Bunraku). Объект без тега ищется в fence или как первый целый объект — порт `firstObject` из `BR:recall-parse.ts`.
   - **Принудительный выбор тула не используется никогда.** На claude-opus-5-5, claude-sonnet-5-5, claude-fable-5-1 и claude-mythos-5-1 он возвращает 400.
   - Третий транспорт, `tool` (`tool_choice:'auto'` + `strict` + корректирующий проход), зарезервирован. Он появится, если пробы найдут модели, где не работают ни `structured`, ни `tagged`.
   - *Рев. 14:* на M4 есть только адаптер openai-chat. Транспорт `structured` вживую не проверен: ни у одной локальной модели здесь нет подтверждённого `json_schema`.
2. **Вызов** — один `streamCall` (`engine/narrate.ts`) с полем `agent` и, в structured, `responseSchema`. Тулов и префилла нет, стопы — из семплеров. Текст и рассуждения собираются молча: событий `text` у агента нет. Сообщения — system, затем user по порядку; пустое user-сообщение не отправляется. При `alternation:'strict'` user-сообщения склеиваются через пустую строку: агенты не проходят через `shape.ts`.
3. **Чтение ответа** [D-98]:
   1. Текст — видимый, без think-тегов: их содержимое уходит в рассуждения. Если видимый текст пуст, а у модели `caps.reasoning.answerInReasoning`, текстом становятся рассуждения — как у рассказчика.
   2. JSON ищется: при `tag:'plan'` — сканером M3 (п. 4); при `tag:null` — в fence ```` ```json ````, иначе первый целый объект (`firstObject` на `balancedEnd`).
   3. Разбор — `looseJson` (`tools/args.ts`, единственный вход `jsonrepair`). Корень не объект — `undecodable`.
   4. `read(value)`. Ядро схемы проверяется строго, отдельные элементы — снисходительно: плохая операция пропускается и записывается в `skipped`.
   5. Если в видимом тексте не нашлось ничего, а рассуждения не пусты, они ищутся так же [D-60]. Успех там — исход `ok_reasoning` и `fromReasoning: true`.

   Коды чтения: ничего не найдено — `no_output`; найдено, но не читается (в том числе объект, который оборвал `finish:'length'`) — `undecodable`; `read()` отказал — его код, `invalid` или `missing_directive`.
4. **`<plan>` у Директора** [D-99, D-117, D-123]. Ответ ищет тот же сканер, что у prompted-тулов: `parsePromptedCalls(text, [{name:'plan'}, {name:'commit_planning_round'}])` (`tools/prompted.ts`: теги с именем [D-97] и `<tool_call>`). Второго порта поиска спанов из RoleCall нет.
   - План — первый блок без ошибки с именем `plan` или `commit_planning_round`. Конверт `{"name": "plan" | "commit_planning_round", "arguments" | "args": {…}}` разворачивается на один уровень, на обоих транспортах. Следующие блоки — `skipped {path:'plan', why:'extra block'}`.
   - Пустой блок (`<plan></plan>`, `{}`, вызов плана без аргументов) планом не считается: поиск идёт дальше; если в ответе только пустые блоки — `missing_directive`. Блоки с ошибкой до плана (упоминание `<plan>` в прозе) пропускаются. Безымянный `<tool_call>` с объектом, в корне которого есть `directive`, — план.
   - Хорошего блока нет: целый объект с `directive` в fence или в тексте всё равно берётся. Иначе оборванный или битый блок — `undecodable`.
   - Тега нет вовсе: в tagged объект из fence или первый целый объект берётся, только если в корне есть `directive` (текстовый путь RoleCall); иначе `no_output`. В structured ответ — объект по построению, и любой объект идёт в `read()`.
5. **Корректирующий проход** — один, только при `repair` и только после ошибки чтения: `no_output`, `undecodable`, `invalid`, `missing_directive`. После ошибки провайдера, таймаута, Stop и `transport_unsupported` его нет.
   - К сообщениям первого запроса дописываются assistant с плохим ответом и user с текстом коррекции. Эхо — видимый текст, иначе рассуждения, до 1 000 символов; если оба пусты — «(no text)».
   - Тексты коррекции — английские и постоянные. Причина в них — короткая фраза по коду («no plan block was found», «the JSON could not be read», «the directive was empty») или сообщение `read()`, обрезанное до 200 символов.
   - Итог — исход последней попытки.
   - *Рев. 14 [D-121]:* `max_tokens` прохода меньше на то, что добавляют эхо и текст коррекции (по `count`): промпт плюс `max_tokens` остаётся там, где его поставил вызывающий. Если остаётся меньше 600 (`AGENT_OUTPUT_FLOOR`), проход не отправляется и остаётся код первой попытки.
6. **Ошибки провайдера** — только общая политика §6.6: до вывода один повтор на `isRetryable` (`engine/route.ts`) после `retryDelayMs` (≤ 8 с), событие `retry` с callKey упавшего вызова. Обе попытки пишутся в `attempts`: `retried`, затем исход повтора. Своего повтора и запасной модели у агентов в v1 нет — это отступление от «или в привязке роли» §6.6.
7. **`transport_unsupported`** [D-122] — только structured-попытка, которую сервер отверг ответом 400 `bad_request` до любого вывода. Молча на tagged ядро не переходит: транспорт фиксирован на ход [D-60]. Движок шлёт `notice{caps.suggest}` раз за сессию: поставить `structured_output = "none"` в `[caps."conn:model"]` или выполнить `rp-core probe <conn:model> --active --write`. Любой другой 400 — `provider_error`. У tagged этого кода не бывает.
8. **Время.** Бюджет агента (`budgetMs`) отсчитывается с первого места в семафоре: `streamCall` зовёт `onSlot`. Корректирующий проход и повтор укладываются в тот же бюджет. Бюджет обрывает сигнал агента с причиной `budget:director` — это `timeout`. Stop и другой обрыв — `aborted`. Свой таймаут первого байта или простоя у вызова (`ProviderError` с кодом `timeout`, без HTTP-статуса) — тоже `timeout`.
9. **Учёт.** Каждый вызов, включая повторённый, — строка `calls` для `trace.calls` с агентом и моделью `conn:model`. Событие `usage` несёт агента. Текст ошибки провайдера в результат не попадает: только код и HTTP-статус попытки.

### 7.3 Story Director (рев. 6, D-61)

Директор — планировщик, который работает до рассказчика. Каждый ход он читает своё состояние на сообщении игрока U, отчёт импульса, свежую историю и снимок мира. Ответ — один JSON: **директива** рассказчику плюс **обновления состояния**. Рассказчик видит только отрендеренную директиву.

Этот раздел — сверка контракта ядра с портом:
- форма плана и состояния — из Bunraku и RoleCall [D-61];
- строгость чтения директивы — [D-62];
- пороги импульса и сопоставление заголовков — [D-63];
- лимиты промпта, личности и `creativity` — [D-64];
- доставка и фильтр персоны — [D-65];
- сбой — [D-17];
- *рев. 14:* как построено на M4 — [D-98…D-124] (§19.10). Места, где сборка изменила текст, помечены «рев. 14».

Код портируется из `Bunraku/src/core/director` — это живой путь RoleCall в виде чистых функций. Промпты и личности берутся оттуда же и сверяются с RoleCall `dm/`, краевые случаи — по тестам RoleCall. Пофайловая карта — §19.6.

Транспорт — `structuredCall` (§7.2) с тегом `plan`. Принудительный `tool_choice` не используется никогда: принудительный `commit_planning_round` на свежих Claude даёт 400.

**Место в ходе.**

- Директор работает на шаге 3 §6.2, до сборки, с дочерним сигналом хода и своим таймаутом.
- На continue Директора нет (§6.4). *Рев. 14:* запрос continue повторяет сохранённую директиву цели [D-106].
- На обычном свайпе повторно используется план заменяемого ответа [D-29]. На guided re-roll и после проваленного плана Директор планирует заново от состояния на U (§5.9).
  - *Рев. 14 [D-104].* Повтор — когда `onSwipe = 'reuse'`, указания нет, а `dir` заменяемого ответа удачный. Вызова нет. Запись — копия с `attempts: []` и `reusedFrom` — ответом, чей план был первым (`dir.reusedFrom ?? id заменяемого`). Событие — `director{status:'reused'}`, `trace.agents.director.status = 'reused'`.
  - `dir` несут `prep` и коммит, в том числе stopped-коммит с частичным текстом: директива этот текст формировала. Проваленный ход ничего не коммитит.
- **Recall Compendium (§7.4.2)** от Директора не зависит: Директор не читает выбор recall, recall не читает директиву.
  - Sync-вызов recall — interactive. Он запускается вместе с Директором, как в RoleCall (`jobs/worker.ts:3812`, `Promise.allSettled`) и Bunraku (`studio/scene-turn.ts:175-183`), и сборка ждёт оба. Если оба на одном origin с одним местом (§8.8, [D-84]), семафор выполняет их по очереди, Директор первым.
  - Prefetch — фоновая задача полосы, которую ход ждёт не дольше `graceSec`. На локальном origin это режим по умолчанию, и recall не стоит на критическом пути (§7.4.7).
- Директор не валит ход. Задержать его он может не дольше своего таймаута плюс ожидание очереди.
- На одно-слотовом бэкенде без кэша промптов в памяти хоста вызов Директора вытесняет KV-кэш рассказчика, и промпт рассказчика обрабатывается заново (риски 6 и 18, §7.4.7). Поэтому lite-профиль урезает и промпт, и вывод. *Рев. 14, замер ревью:* у запроса Директора и запроса рассказчика общий префикс — 5 токенов, то есть вытеснение полное.

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
| принудительное действие по арке | ходов без прогресса не меньше предела горизонта: immediate 2, short 9, medium 15, long 30, epic 75. Арки в `seeding` исключены. *Рев. 14 [D-117]:* ходы без прогресса — `turn − (lastProgressTurn ?? createdAtTurn)`; хода отсрочки нет |
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
- **Давления (`planningPressures`)** идут отдельным user-сообщением после него. При `alternation:'strict'` их склеивает `shape.ts` (D-48). *Рев. 14 [D-118]:* агенты не проходят через `shape.ts` — user-сообщения через пустую строку склеивает сам `structuredCall` (§7.2).
- **После вызова** шаг `enrichFromMomentum` добавляет:
  - forceful `arcDirection` для каждой арки с принудительным сигналом;
  - `callback` для каждого созревшего семени, которого директива ещё не называет.

  *Рев. 14 [D-117]:* «называет» — целым словом (цепочкой основ), равенством после свёртки или по id. В источниках сравнение подстрокой, и арку «Art» там «называет» «The Party». Сравнение идёт только с записями планировщика, и каждый список останавливается на 12 элементах.

  Затем работает фильтр персоны. Порядок — как в RoleCall (`jobs/worker.ts:3973-3983`).
- **Мёртвый код не переносится:** `tensionOf` и `tensionPeaks`. Поле `involvedCharacters`, на котором они стоят, никто не пишет.

**Промпт.**

- **System** стабилен на сессию и кэшируется. Это порт `prompts.ts` Bunraku (RoleCall `buildDMSystemPrompt`). В нём:
  - роль и правила, включая «THE TEST» о персонаже игрока;
  - блок личности `director.style`: одна из 10, по умолчанию `the-balanced` (Sage), неизвестный id тоже даёт Sage. К нему добавляется `SHARED_PERSONALITY_GUIDANCE` [D-64];
  - строка `## Creativity Level` по `director.creativity`: subtle | moderate | dramatic, по умолчанию moderate [D-64];
  - блок персоны: имя и описание; `{{user}}` заменяется именем персоны;
  - в tagged — описание схемы и раздел «How to answer». В structured схема уходит в запрос.

  *Рев. 14 [D-110, D-117]:*
  - правила плана (`PLAN_RULES`, бывшее описание тула в `plan-round.ts`) стоят в system на обоих транспортах;
  - схема в tagged — компактный JSON: `PLAN_SCHEMA` с описаниями (13 167 символов, ≈ 2,9 тыс. токенов o200k), lite — `PLAN_SCHEMA_LITE` без ключей `description` (2 622 символа, ≈ 640 токенов). В structured схема уходит в запрос с описаниями, под именем `director_plan`;
  - без персоны `{{user}}` — «the player», и блока персоны нет. Персона с одним именем тоже получает правила о персонаже игрока. `{{char}}` — имя карточки. Других макросов нет, раскрывается только system; `director.instructions` идут как есть.

  Размер, замеренный на Bunraku @702d8120:
  - Sage без персоны — 19 531 символ, с персоной — ≈ 23,4 тыс.;
  - самая длинная личность (oracle) — 21 961 без персоны;
  - схема tagged (`PLANNING_TOOL.parameters`) — ещё 13 746.

  Полный tagged-промпт — ≈ 33–40 тыс. символов, ≈ 9–10 тыс. токенов.

  *Рев. 14, замер ядра (o200k):* system Sage в full — 21 276 символов без персоны (19 531 Bunraku плюс `PLAN_RULES`); oracle — 23 751. С tagged-схемой и «How to answer» — 34 958 символов, ≈ 7,8 тыс. токенов; с короткой персоной — 38 908, ≈ 8,8 тыс. У oracle — 37 433 и 41 383 символа, ≈ 8,5 и 9,5 тыс. Оценка «9–10 тыс.» для Sage завышена, для самой длинной личности с персоной — близка. Lite system — ≈ 7,5 тыс. символов в structured (≈ 1,7 тыс. токенов) и ≈ 10,6 тыс. в tagged (≈ 2,5 тыс.).
- **User** собирается на каждый ход в порядке `user-prompt.ts` Bunraku:
  1. номер хода и сводка состояния: арки, намерения, mood;
  2. отчёт импульса;
  3. снимок мира `[COMPENDIUM CONTEXT]` — с M5a, см. ниже;
  4. самопроверка: `lastDirective` против последнего ответа рассказчика. От прозы берётся 2 400 символов, начало и конец [D-64]. *Рев. 14:* только если прошлый ход Директора планировал (`state.lastDirective.turn === state.turn`), а родитель U — видимый ответ ассистента [D-110, D-123];
  5. главы с подсказками по `CHAPTER_TURNS`;
  6. ход игрока и постоянные указания `director.instructions` (≤ 2 000 символов [D-64]). *Рев. 14:* при guided re-roll — ещё строка «The player asked for a new version of the last answer: <указание>» [D-104];
  7. свежая история: новейшие 30 сообщений в пределах 25 % окна Директора, в lite — 10 % [D-64]. Старые рассуждения вырезаны, самое старое не поместившееся сообщение обрезается посередине (`history.ts`). *Рев. 14 [D-110]:* это видимые сообщения пути до U, с приветствием, только текстовые блоки; пустые по тексту не входят. Метка — `[Turn N] role:`, как в Bunraku. Сам U стоит только в разделе 6. На малом окне lite отдаёт историю целиком [D-121];
  8. арки по степени застоя — со следующим битом и последними 6 этапами; ритм; намерения; живые семена с пометкой OVERDUE; Shadow World — скрытые арки и заметки игрока.

  Лимиты показа (`PROMPT_LIMITS`): 25 арок, 40 семян, 25 скрытых арок, 30 заметок, 300 символов на текст. Всё, что не показано, считается строкой «(+N more…)». *Рев. 14:* lite на малом окне показывает меньше — `LITE_SHOW_LIMITS`: 8 арок, 10 семян, 0 скрытых арок, 2 этапа на арку [D-121].
- **Правка текста при порте.** 15 упоминаний `commit_planning_round.X` (11 в `user-prompt.ts`, 4 в `momentum.ts`) становятся именами полей `X`. Голое «in commit_planning_round» (`user-prompt.ts:133`) становится «in your plan». В `prompts.ts` упоминаний нет.
- **Параметры вызова** (*рев. 14:* переписано по сборке [D-101, D-119, D-121]; рев. 6 говорила «рассуждения — минимальный уровень из допустимых» и «`maxTokens` в full — `min(16 384, окно − промпт)`»).
  - `finish:'length'` без восстановимого JSON — `undecodable`.
  - **Привязка** — `roles.director`. Без неё или со значением `'narrator'` Директор берёт у привязки рассказчика только соединение и модель: не `maxTokens`, не семплеры, не `reasoning`, не `fallback` [D-119]. Явная привязка Директора идёт целиком. Привязка разрешается в теле хода: нет соединения или ошибка записи возможностей — `DirectorRecord{ok:false, code:'no_connection'}`, а не отказ хода. `--provider` действует и на Директора; запасной модели у него нет.
  - **Температура** — `binding.samplers.temperature ?? 0,7` (0,7 — `settings.ts` Bunraku). Остальные семплеры — только привязки; семплеры пресета не наследуются.
  - **Рассуждения** — `binding.reasoning`, если задано; иначе `'none'`, если модель умеет их выключать (`caps.reasoning.canDisable`); иначе `'low'`, если она принимает уровень и `'low'` среди допустимых; иначе не задаются.
  - **`maxTokens`** — `min(нужное, окно − промпт, caps.maxOutput, явный лимит привязки)`. Нужное: full — 16 384 (`PLANNER_MAX_TOKENS` Bunraku); lite — 1 500 и ещё 1 024, если вызов думает (`caps.reasoning.output ≠ 'none'`, и рассуждения не выключены), как у recall (§7.4.2). Окно и нижняя граница — «Окно» ниже.
  - **Учёт.** Вызовы Директора — строки `trace.calls` (агент `director`, модель `conn:model`) и `trace.agents.director = {status, code?, transport?}`. `gen.usage` — по-прежнему только рассказчика. callKey — `${turnId}:director:${n}`.

**Снимок мира — из Compendium (с M5a).** Сам Директор Compendium не читает. Готовый текст ему отдаёт модуль памяти (§7.4.5). *Рев. 14:* `runDirector` принимает `worldSnapshot`, но ход его пока не передаёт, поэтому до M5a раздела `[COMPENDIUM CONTEXT]` нет.

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
- `full` на окне < 16 384 всё равно даёт lite, с `notice{director_lite}`: полный tagged-промпт (≈ 9–10 тыс. токенов; замер рев. 14 — ≈ 7,8–9,5 тыс. system по личностям, без персоны и с короткой) там не помещается вместе с историей.
- *рев. 14 [D-121]:* `full` на окне ≥ 16 384 тоже даёт lite, если полный промпт вместе с 4 096 токенами вывода не помещается в окно. `notice{director_lite}` называет обе причины.

Окно 16 384 поэтому получает lite и у Директора, и у Compendium. Первые пользователи Директора по порядку сборки — слабые локальные модели.

| Параметр | Full | Lite |
|---|---|---|
| System | `prompts.ts` целиком, с блоком личности | новый сжатый текст правил (≈ 60 строк, ≈ 7 тыс. символов) и дайджест личности из её же полей: name, title, tagline, coreBeliefs, `preferences.pacingRhythm`, `directiveSafety.hintingStyle`. Дайджест — 0,8–1,2 тыс. символов (замерено), новых текстов не нужно. *Рев. 14:* правила с `PLAN_RULES_LITE` — ≈ 6,3 тыс. символов и ≈ 60 строк; весь lite system в structured — 7,4–7,8 тыс. символов по личностям; дайджест — 0,89–1,33 тыс. (у jester, shadow и thrill-seeker длиннее `pacingRhythm`) |
| Схема | `PLAN_SCHEMA`, шесть секций | `PLAN_SCHEMA_LITE` (состав — ниже); *рев. 14:* в tagged — без описаний [D-117] |
| User-промпт | все разделы | без Shadow World и давления скрытых арок. Скрытые арки в состоянии не трогаются |
| История | 30 сообщений, 25 % окна | 10 % окна; *рев. 14:* на малом окне — 0 [D-121] |
| Снимок мира | `WORLD_FULL`, ≤ 4 000 символов | `WORLD_LITE`, ≤ 1 500 символов |
| Вывод | `min(16 384, остаток окна)` | ≤ 1 500 токенов; + 1 024, если рассуждения не выключаются; *рев. 14:* не больше остатка окна [D-121] |
| Транспорт | §7.2 | `structured` предпочтителен, если проба его подтвердила: тогда схема уходит из system |

Состав `PLAN_SCHEMA_LITE`:
- `directive`: mood, pacing, narrativeGoal, sceneGuidance, endingHook; до 3 arcDirections, до 3 characterBeats, до 2 callbacks;
- `arcUpdates`: arcId, title, status, arcType, horizon, newStageTitle, nextBeat, markNextBeatDelivered. *Рев. 6:* без `arcType` и `horizon` новая арка всегда получала бы `side` и `medium` (`apply.ts:163, 166`), подсказка «Consider adding a character arc» (`user-prompt.ts:95`) висела бы невыполнимой в каждом ходе, а горизонты immediate и short были бы недостижимы;
- `seedUpdates`: id, title, action, description, payoffHorizon, outcome;
- `analysis`: whatHappened и до 3 intentions;
- `chapterUpdate`: action, title, description;
- `invisibleArcUpdates` нет.

По оценке исследования, на GPU задержку Директора определяет прежде всего декодирование ответа, а не обработка промпта. Поэтому lite урезает схему, а не только историю. Это проверяется замерами на M5c, вместе с recall.

**Окно (рев. 14) [D-101, D-121].** Запрос Директора всегда помещается в его окно — и в lite, и в full.
- **Окно** — своё: `contextWindow({caps, local, configWindow})` маршрута Директора (`prompt/budget.ts`). `preset.maxContext` — окно рассказчика.
- **Резерв вывода:** full — 4 096 (проверка профиля D-102), lite — 1 500 или 2 524, если вызов думает. Место под промпт — окно минус резерв. Промпт считается счётчиком сессии, без EMA.
- **Lite не помещается** — он сжимается и собирается заново: сначала без истории (раздел истории — одна строка «[The conversation history is left out: your context window is too small for it this turn.]»), затем ещё и с `LITE_SHOW_LIMITS` в показе состояния. Остаются элементы с самым свежим прогрессом, остальное — «(+N more…)». Берётся первый вариант, который оставляет резерв, иначе самый сжатый. Full, который не помещается, сначала уходит в lite (выше).
- **Нижняя граница.** Если окно минус промпт меньше 600 токенов, ничего не отправляется: `DirectorRecord{ok:false, code:'no_room'}`, событие `failed{reason:'no_room'}`, `notice{director_no_room}` раз за сессию — окно модели Директора слишком мало для его промпта. Граница проверяется по месту в окне. `caps.maxOutput` и явный лимит привязки только ограничивают `max_tokens`: такой лимит пользователь выбрал сам.
- **Корректирующий проход** просит меньше на своё эхо и текст коррекции (§7.2, п. 5).
- **Обрезка сервером.** Вызовы Директора проходят ту же проверку, что рассказчик: сервер насчитал гораздо меньше токенов промпта, чем оценка, — `notice{context_truncated_by_server}` раз за сессию.
- **Замер** (`test/engine-m4/window.test.ts`, русский планировщик, o200k). Окно 8 192: все 40 ходов планируют, промпт ≤ 6 800 токенов, `max_tokens` ≥ 1 392, история уходит с 16-го хода. Окно 4 096: планируют только 1-й и 3-й ходы (промпт 3 158 и 3 488, `max_tokens` 938 и 608), остальные 38 — `no_room`: один lite tagged system там ≈ 2,5 тыс. токенов.

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
- *Рев. 14 — как построено [D-107, D-123]* (`readPlan`, `agents/director/plan.ts`):
  - регистр значений перечислений правится молча; алиасы и неизвестные значения выбрасывают поле в `skipped`;
  - секция строкой разбирается через `looseJson`; `analysis` строкой (JSON-строка сначала разбирается) — `whatHappened`; нет `chapterUpdate` — `{action:'none', title:''}`;
  - ключ обновления арки — первое непустое из `arcId`, `id`, `title`; все пусты — `skipped`;
  - `tension_level` строкой — число, зажатое в 0..10, иначе поле выбрасывается; `targetTurn` — только безопасное целое ≥ 0, строка из цифр приводится, остальное выбрасывается;
  - плохой элемент списка уходит в `skipped` один, директива целиком — никогда;
  - обрезки и зажатия тоже пишутся в `skipped`;
  - намерений читается до 10 (в lite — 3), хранится 5. Lite читает полную форму, только с меньшими лимитами: присланное сверх lite-схемы не выбрасывается;
  - план в рассуждениях `readPlan` сам не ищет — это делает `structuredCall` (§7.2).

**Редьюсер.** `applyPlan(state, round, {turn}) → {state, skipped}` — чистая функция, порт `apply.ts` Bunraku, без `now`.

- **Id** выдаются из `nextId`: `arc-N`, `seed-N`, `hidden-N`. Глава получает `chapter-<number>`.
- **Главы.**
  - Первая глава создаётся всегда, что бы ни прислала модель.
  - `start_new` отклоняется, пока текущей главе меньше 3 ходов [D-63]; промпт подсказывает не делать этого до 10-го хода. Отказ пишется в `skipped`.
  - *Рев. 14 [D-118]:* отказ — только пока текущая глава `active`: главу, которую модель уже пометила `concluding`, можно закрыть раньше. Первая глава без заголовка — «The Story Begins», следующая — «Chapter N».
- **Арки** сопоставляются по шагам [D-63], поверх `normalizeTerm` (§7.5) со стоп-словами:
  1. точный id;
  2. нормализованный заголовок;
  3. ≥ 2 общих значимых токена, покрывающих не меньше половины более короткого заголовка.

  Bunraku сравнивает через `[^a-z0-9]` (`apply.ts:24, 26`) и стирает этим кириллицу, поэтому русские арки дублировались бы. Новая арка получает `cleanTitle`: одно предложение, ≤ 80 символов. Новая арка сверх лимита живых отклоняется в `skipped`; Bunraku пропускает её молча.

  *Рев. 14 — как построено [D-108, D-123]:*
  - после точного id идёт id из эха в селекторе (`[arc-1] The Lighthouse`, `arc-1: Маяк`), если такая арка есть. Без этого селектор, скопированный из строки промпта, заводил дубль арки;
  - «нормализованный заголовок» — ключ сопоставления: основы всех слов. Он сравнивается как прислан, затем после `cleanTitle`;
  - токены — основы `wordsOf` длиннее двух символов, без `DIRECTOR_STOP` (стоп-слова D-46 и служебные слова Директора, английские и русские; сам `STOP_WORDS` не меняется). Пустой ключ не совпадает ни с чем. Все 19 векторов vvs-264 дают прежний результат;
  - `cleanTitle` — шаги Bunraku, удаление заикания и эха `arc-N`; правил hex-слагов нет: они резали «Dead» и «Cafe».
- **Семена** сопоставляются по id или по нормализованному `hint`. Неизвестный id уходит в `skipped`. `plant` ставит `lastPlantTurn = turn`. *Рев. 14:* `relatedArcId` сводится сопоставлением арок к id арки; арки нет — поле не хранится, запись в `skipped` [D-123]. Подкрепление считается и без своего текста, но не чаще раза за ход [D-118].
- **Скрытые арки** сопоставляются по id или по нормализованному заголовку. Улики дедуплицируются без учёта регистра. *Рев. 14:* id годится и из эха `hidden-N`; заголовок сравнивается как прислан и после `cleanHiddenTitle`, новые скрытые арки получают очищенный заголовок [D-123].
- **Прогресс.** `lastProgressTurn` двигают только новый этап, смена статуса и доставленный бит. Переписанное описание прогрессом не считается.
- **Этапы.** Этап, повторяющий заголовок предыдущего, не добавляется. `stage.turn = turn`: Bunraku пишет туда счётчик `turnsActive` (`apply.ts:141`), а у новой арки — 0 (`:167`). Это исправляется. *Рев. 14:* сравнение — с последним этапом, после `foldText` [D-108].
- **Тексты.** *Рев. 14 [D-123]:* каждый хранимый текст проходит лимиты длины, поэтому `checkState(fitState(applyPlan(…)))` — всегда состояние. Это проверяет property-тест на случайных планах (`test/director/state-roundtrip.test.ts`).
- **Ритм.**
  - Нет mood или mood тот же — `turnsAtCurrentMood + 1`.
  - *Рев. 6:* mood сравнивается по словам после `normalizeTerm`: «tense, watchful» содержит «tense». В источниках сравнение — точное равенство с action, climax, calm и т. д. При свободном mood подсказки ритма там почти не срабатывают.
  - *Рев. 14 [D-109, D-118]:* слова ритма — данные `MOOD_WORDS` в `agents/director/mood.ts`, английские и русские; их читают и редьюсер, и импульс. Тот же mood — тот же набор основ без служебных слов. climax тоже ставит `lastActionSequence`, как в Bunraku.
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
| снимок | ≤ 16 КБ типично, потолок 32 КБ; *рев. 14:* потолок — в байтах UTF-8, «типично» для русского не держится (ниже) | 600 000 байт |

  Элементы с `byUser` и `userAuthored` не вытесняются никогда.
- **`fitState`** — последний шаг перед записью. Шаги идут по порядку, пока JSON состояния не уложится в 32 КБ:
  1. завершённых элементов каждого вида — 5, затем 0. `lastPlantTurn` остаётся, поэтому давление посадки не выдаёт ложное «семян не было вовсе»;
  2. этапов — 3, улик — 3, подкреплений — 2;
  3. описания — до 160 символов, этапов — 1, намерений — 3;
  4. завершённых глав — 2;
  5. рабочие наборы — по самому давнему `lastProgressTurn` или `plantedAtTurn`: 12 арок, 16 семян, 6 скрытых арок.

  Каждый сработавший шаг пишется в `skipped` (`{path:'state', why:'fit:<шаг>'}`). В v1 элементов человека нет (`dirEdit` — позже), поэтому шаг 5 всегда укладывает состояние в потолок.

  *Рев. 14 [D-116].* Последняя фраза неверна для кириллицы (2 байта на символ) и CJK (3 байта): подробный русский планировщик держал 287 из 300 состояний выше 32 КБ и после шага 5. Потолок — 32 768 байт UTF-8 от `JSON.stringify(state)`; Bunraku считал символы UTF-16. Поэтому, пока состояние выше потолка, идут ещё два шага:

  6. каждый текст модели — до 120 символов и 240 байт UTF-8; улик — 1; главы — только текущая; рабочие наборы — 8 арок, 10 семян, 4 скрытые арки. Заголовки арок не режутся: это ключи сопоставления;
  7. `lastDirective` убирается; следующий ход идёт без самопроверки.

  `fit:over-cap` — если и после шага 7 состояние выше потолка. Так бывает только с элементами человека, а в v1 их нет. Худший замер после шага 7 — ≈ 28 КБ: CJK и 4-байтовые символы на всех лимитах D-61.

  `checkState` больше не ограничивает весь JSON двумя потолками: каждая строка — до 2 000 кодовых точек, весь JSON — до 4 × 32 КБ (131 072 байта). Так ядро не отвергает состояние, которое само записало. Неизвестные ключи `checkState` не копирует.

  **Оценка размера** — на синтетическом состоянии в 300 ходов, на живой сессии не замерялась:
  - ≈ 32 КБ в форме Bunraku;
  - ≈ 19 КБ без текстов, которые не читает ни один промпт, и без `lastDirective`;
  - ≈ 16 КБ при ~6 арках, 10 семенах и 2 скрытых арках;
  - при полных лимитах D-61 — ≈ 61 КБ, поэтому `fitState` будет ужимать насыщенные сессии.

  Проверка — скриптовый прогон на 300 ходов на M4.

  *Рев. 14, замер* (`test/demo-m4/three-hundred.test.ts`): 300 подробных русских ходов через весь конвейер — `runDirector`, `readPlan`, `applyPlan`, фильтр персоны, `fitState`, журнал. Каждый снимок — не больше 32 768 байт.
  - Директива заполнена до всех лимитов: медиана — 19 946 байт; авторская директива одна больше потолка, поэтому шаг 7 срабатывает на каждом ходу и самопроверки нет.
  - Директива обычного размера: медиана — 23 784 байта, максимум — 32 552; самопроверка остаётся на всех 300 ходах.
  - Под 16 КБ — 4 и 0 снимков из 300. Оценка «≈ 16 КБ типично» для подробного русского планировщика не держится: типичный размер — ≈ 20–24 КБ.

**Результат** — `DirectorRecord`. Он заменяет тип в §5.9:

```ts
interface DirectorRecord {
  turn: number; ok: boolean; code?: DirectorFailCode;
  transport?: 'structured' | 'tagged'; profile?: 'full' | 'lite'; model?: string;
  directive?: NarratorDirective;              // итоговая, после enrich и фильтра персоны — как отправлена
  analysis?: PlanningAnalysis;                // для /director show и трассы
  skipped: { path: string; why: string }[];   // [D-60]
  attempts: { transport: string; outcome: string; ms: number; status?: number; finish?: string; tokens?: number }[];
  state: DirectorState;                       // после applyPlan и fitState; при сбое — прежнее с turn + 1
  reducer: number;                            // версия редьюсера: 1
  reusedFrom?: string;                        // [D-29]
  fromReasoning?: true;                       // рев. 14: план найден в рассуждениях [D-60]
}
type DirectorFailCode = 'no_connection' | 'transport_unsupported' | 'provider_error' | 'no_output'
                      | 'undecodable' | 'missing_directive' | 'timeout' | 'aborted'
                      | 'no_room';            // рев. 14: промпт не помещается в окно, ничего не отправлено [D-121]
```

*Рев. 14.* Тип живёт в `agents/director/types.ts`; `entries.ts` его реэкспортирует, а любое чтение `dir` из журнала идёт через `checkRecord` [D-117]. Код `invalid` из `structuredCall` записывается как `undecodable`. `skipped` — пропуски чтения, редьюсера, фильтра персоны и `fitState`, в этом порядке, под одним лимитом в 20 записей и `+N more`. Проваленная запись хранит `transport`, `profile` и `model`, если вызов был; запись `no_room` — `profile` и `model`.

- Запись пишется в `prep` с fsync и коммитится в строке ответа (§5.9).
- Операций в записи нет: новое состояние лежит целиком в `state`, авторская директива — в `state.lastDirective`.
- Коды Bunraku переводятся так [D-61]: `no_tool_support` → `transport_unsupported`, `inference_error` → `provider_error`, ни одного вызова → `no_output`.
- Событие `director{status:'planned', summary}`; `summary` — короткая строка вида «арки +1 ~2 · семена +1 · глава 2».
- *Рев. 14 [D-105, D-123]:* события — `planning` при старте вызова, затем `planned{summary}`, `reused{summary}` или `failed{reason}`. `summary` — английская строка `summaryOf(prev, next)`: `arcs +1 ~2 · seeds +1 ~1 -1 · hidden +1 ~1 · chapter 2`, только ненулевые части, иначе `no changes`. `seeds ~N` — подкреплённые семена, `hidden ~N` — скрытые арки с новой уликой, этапом или статусом.
- *Рев. 14 — порядок шагов `runDirector` [D-105]:* (повтор на свайпе) → `directorAt(U)` → ход + 1 → импульс → профиль → промпты → `structuredCall` с `readPlan` внутри `read` → проверка обрезки сервером → `applyPlan` (авторская директива — в `state.lastDirective`) → `enrichFromMomentum` → фильтр персоны → `fitState` → запись. Результат — `DirectorRun {record, calls, agent}`: ходу нужны и строки `trace.calls`, и строка `trace.agents`.

**Таймаут.**

- **По умолчанию** `director.timeoutSec` = таймаут первого байта соединения + 60 с: 660 с для localhost, 180 с для удалённых.
- **Отсчёт** начинается, когда запрос получил место в семафоре. Ожидание очереди в бюджет не входит.
- Корректирующий проход укладывается в тот же бюджет.
- *Рев. 14 [D-101]:* отсчёт запускает `onSlot` первого вызова; повтор §6.6 — в том же бюджете. Вызовы Директора (до 4: вызов, повтор, коррекция, повтор) входят в `callsBefore` рассказчика, так что `CALL_CEILING` (12) считает весь ход.

**Доставка [D-65].**

- **Контракт.** Пока Директор включён, в блоке ядра в конце ведущего system-прогона стоит `NARRATOR_AUTHORITY`.
  - Это порт текста RoleCall `buildNarratorSystemAddition` (`DirectiveBuilder.ts:582`, 37 строк; в Bunraku — `core/assembly/director.ts:60`).
  - К нему добавляется одна строка ядра: «никогда не действуй, не говори и не решай за `{{user}}`».
  - Заголовок в контракте и в директиве — одна константа `DIRECTOR_HEADER`. В RoleCall в заголовке длинное тире, в Bunraku — дефис; разъехаться они не должны.
  - Контракт стоит **и в ходах без директивы.** Bunraku вставляет его только вместе с отрендеренной директивой (`director.ts:99-110`). Тогда на сбойных ходах меняется голова промпта и ломается кэш.
  - *Рев. 14 [D-106, D-120].* Контракт — на любом виде хода: reply, swipe, continue и при сбое плана. Без персоны строка ядра называет «the player». Сразу после неё — строка языка: «Write the story in the language it is already written in; these constraints are in English only for you.» Её добавил живой прогон: с первой английской директивы Mag-Mell 12B начала мешать английский в русскую историю.
  - *Рев. 14 [D-106].* Блок ядра = контракт + протокол и каталог тулов. Его src — `core:tools`, если тулы предложены, и `core:director`, если в нём только контракт. «Тулы предложены» в `assemble.ts` теперь значит `tools.length > 0`. С выключенным Директором запросы байт в байт как на M3: golden-снимки, паритет и хеши запросов не менялись.
- **Директива** рендерится портом `renderDirective` из `core/assembly/director.ts`.
  - Обёртка — `[DIRECTOR CONSTRAINTS - BINDING THIS TURN]` … `[/DIRECTOR CONSTRAINTS]`.
  - *Рев. 15 [D-139]:* этот же блок, как его получил рассказчик, целиком печатает `/director show` (§12.4).
  - Порядок разделов — как в Bunraku: Mood и Pacing (при `medium` Pacing опускается), Scene Guidance (`Tension: <слово> (n/10)`), Include, Avoid, Narrative Goal, Story Arc Directions, Callbacks, Character Beats, Dialogue guidance, `[Ending: …]`.
  - Директива ставится на **глубине 1** по конвенции ST, прямо над сообщением игрока. Роль — system, источник — `director`. Ставится после бюджета и не обрезается.
  - При равной глубине `director` идёт последним из постоянных источников (§10.1; ниже него только guidance при guided re-roll), поэтому директива стоит и ниже блока Compendium на той же глубине (§7.4.1).
  - У Anthropic глубина 1 стоит после assistant-хода, поэтому адаптер сливает директиву в user-ход (§8.5). Пресет может перенести её на глубину 0.
  - *Рев. 14:* пока нет — `{{slot::director}}` в v1 пуст, директиву пресет не двигает [D-106].
- **Continue и preview (рев. 14) [D-106].**
  - Continue Директора не зовёт. Запрос повторяет на глубине 1 сохранённую директиву цели (`dir.directive`), если она есть, — как recall повторяет свой выбор. Своего `dir` continue не пишет.
  - Preview следующего ответа показывает контракт и на глубине 1 заглушку `[DIRECTOR CONSTRAINTS - BINDING THIS TURN]` / `(the Director plans this when the turn runs)` / `[/DIRECTOR CONSTRAINTS]`. Свайп, который повторит план, показывает повторённую директиву.
  - `preview({turn})` рендерит сохранённую директиву того ответа, даже если сегодня Директор выключен: её и отправили. Поэтому `/trace` и `/preview --turn` совпадают с отправленным. Контракт в preview — по сегодняшнему конфигу.
- **Фильтр персоны** — `sanitizeForPlayerCharacter(directive, names)`. `names` — имя и алиасы персоны; границы слов — Unicode (*рев. 14:* посимвольно, а не lookbehind `(?<![\p{L}\p{N}_])` — ниже). Фильтр:
  - убирает characterBeats и dialogueGuidance персоны;
  - удаляет персону из `include.characters`;
  - выбрасывает arcDirections, callbacks и биты, которые утверждают что-то о её внутреннем состоянии. Список глаголов — английский; русский список и фикстуры `ru` — на M4 (*рев. 14:* сделаны, ниже).

  `endingHook` и `narrativeGoal` не фильтруются ни в одном источнике: их проверяет сам планировщик по «THE TEST» system-промпта. Всё убранное попадает в `skipped` с `why:'persona'`.

  *Рев. 14 — как построено [D-112].*
  - **Граница слова** — не lookbehind `(?<![\p{L}\p{N}_])`, а посимвольная проверка кодовой точки до и после имени: `isLoreWordChar`, `[\p{L}\p{N}\p{M}_]` (`text/normalize.ts`). В Bun lookbehind по `\p{…}` ошибается на суррогатных парах (рев. 12). Тексты сравниваются после свёртки: NFKC, регистр, `ё` → `е`.
  - **Русские правила.** Глагол внутреннего состояния считается после имени в именительном падеже («Елисей не знает»), слово состояния («кажется», «хочется», «страшно», «жаль») — после дательного («Елисею кажется»). Между ними — до трёх слов-наполнителей («не», «вдруг», «уже», «начинает»). Притяжательная форма — «мысли Елисея». Имя в другом падеже перед глаголом — чужое подлежащее: «Брат Елисея думает» остаётся. Глаголы записаны явными формами, формы имени — по падежам единственного числа. Английские правила — как в Bunraku.
  - Любой список, который фильтр опустошил, теряет ключ. Без персоны фильтр ничего не меняет.
  - Фикстуры — `test/fixtures/ru/director-persona.json`. Известные пропуски — «Примечания к ревизии», п. 54.
  - На повторе плана при свайпе фильтр прогоняется заново, с сегодняшними именами [D-104].
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
  - поиск спанов тега — из `prompted-tool-calls`. *Рев. 14:* второй раз не портировался: его уже портировала M3 (`tools/prompted.ts`), Директор зовёт её [D-99].
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

- **Порядок.** При равной глубине `compendium` стоит после авторской заметки, заметки карточки и `lore` и перед директивой (§10.1, рев. 12). Директива остаётся ближе всех к U.
- **Причины выбора** в блок не попадают, только в трассу. RoleCall вставлял их (`jobs/worker.ts:4112`), Bunraku убрал.
- **Повторы.** Пропускаются записи, которые уже стоят в промпте: сработавшие в движке лора и стоящие в слоте `{{recap}}`.
- **Бюджет** — доля лора, 25 % промптовой части окна (окно минус резерв ответа, §11). Движок лора идёт первым, по правилам ST. Если у селектора есть кандидаты, лор берёт не больше 60 % доли: пол Compendium — 40 % (`compendium.minShare`).
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
- **рассказчик** — резерв ответа 2 048, если `max_tokens` не задан [D-89, §11]; голова пресета, карточка, персона, контракт Директора и каталог тулов — ≈ 3 000 (оценка); директива ≤ 600; лор с блоком Compendium ≤ 3 584 (25 % от окна минус резерв, рев. 12; блок ≤ 1 600); слот пересказов ≤ 1 638. На историю остаётся ≥ 5 500 токенов, ≈ 7 обменов. Если на историю остаётся меньше 25 % окна — `notice{history_crowded}` раз за сессию с советом: меньше лора, меньше `max_tokens`, другой пресет.

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
- заметки — `/memory add`; `edit`, `retire` и `restore` работают и для них.

**Что работает сейчас (M3)** — только заметки (§5.8): `/memory` (список с хэндлами `C<n>`), `/memory show <ref>`, `/memory add <заголовок> | <ключи> | <текст>`, `/memory edit <ref> <заголовок> | <ключи> | <текст>` (пустая часть оставляет прежнее значение; без `$EDITOR`), `/memory retire <ref> [причина]`, `/memory restore <ref>`. `<ref>` — `C<n>`, ключ `note:…` или заголовок. На остальные команды этого раздела и §7.4.9 REPL отвечает, что они придут с M5.

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
| { method: 'memory/add'; params: { sessionId: string; title: string; keys: string[]; content: string } }   // заметка; глагол memoryAdd — с M3, метод — с M6
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

Поиск устроен как тулы рассказчика и одновременно как `/search` в REPL и `search` в `SessionHandle`; в протоколе это `history/search` (M6).

**`normalizeTerm` (`text/normalize.ts`)** — одна функция для поиска, ключей заметок, селектора Compendium, склейки почти-дублей и снимка мира Директора:

1. Свёртка (`foldText`): NFKC, локаленезависимый lower-case, `ё`→`е`; комбинирующие знаки U+0300–U+036F выбрасываются, чтобы ударение не резало и не меняло слово. Пунктуация на краях слова не считается.
2. Слова — максимальные последовательности символов `\p{L}\p{N}\p{M}` (`WORD_CHAR_CLASS`, [D-46]), найденные посимвольно. Кусок письменности без пробелов (Han, Hiragana, Katakana, Thai) — одно слово, оно сопоставляется подстрокой; там, где такая письменность встречается с другой, слово кончается. Английское притяжательное `'s` остаётся при своём слове.
3. Кириллическое слово:
   - предлог или форма местоимения из закрытого списка (`над`, `надо`, `под`, `подо`, `вас`, `вам`, `вами`, `нас`, `нам`, `нами`, `тем`, `том`, `тому`, `чем`, `чему`, `кем`, `ком`, `кому`, `ним`, `них`, `ней`) получает свою основу с меткой `FUNCTION_WORD_MARK` и совпадает только само с собой. Поэтому короткие имена с ними не сходятся: Надя/Нади/Надей ≠ над, надо; Вася ≠ вас; Тёма ≠ тем; Тома ≠ том, тому;
   - у слова длиной ≥ 4 срезается самое длинное окончание из собственного списка, если остаётся ≥ 3 буквы. В списке 55 окончаний: падежные, прилагательных и причастий, а из глагольных только возвратные `-ться`, `-тся`, `-лся`, `-лась`, `-лось`, `-лись` (остальные глагольные ломают существительные);
   - затем, пока после среза остаётся ≥ 3 буквы, срезается конечная гласная, `ь` или `й` основы, а также конечное `-ов`/`-ев`. Так сходятся формы, где окончание съедает часть основы: герой/героя, Алексей/Алексея, Петров/Петрова.
4. Латинское слово: срезается притяжательное `'s`; у слова длиной ≥ 4 — окончание множественного числа (`-ies` → `-i`, иначе `-s`, кроме `-ss`, `-us`, `-is`). Затем, если осталось ≥ 4 буквы, конечное `-e` срезается только после s, x, z, ch, sh, i, o (horse/horses, box/boxes, hero/heroes), а конечное `-y` становится `-i` (party/parties). Другое конечное `-e` остаётся, поэтому Sam ≠ same, Tim ≠ time, plan ≠ plane.
5. Остальные слова (цифры, смешанные и другие письменности) только сворачиваются.
6. Термин совпадает со словом, если совпали их основы.

Список окончаний — свой, без зависимости и без кода Snowball. Фикстуры — `test/fixtures/ru/normalize-terms.json`:

- сходятся: «караван/каравана/караваном», «Мира/Миру/Мирой», «трактирщица/трактирщицу», «брат/брата/братом», «ёж/еж»;
- расходятся: брат/братства, мир/мирный, пары из шага 3 и Sam/same;
- известные промахи (раздел `misses`): беглые гласные и чередования (отец/отца, друг/друзья), слова из трёх букв (Аня/Ани), существительные на `-мя` (имя/имени), неправильные английские формы (man/men, wolf/wolves). Глагольные формы, кроме возвратных, не сводятся;
- известные ложные склейки (раздел `merges`): омографы (Иван/Иванов, любой/любовь), короткие имена и обычные слова (Света/свет, Люда/люди, Люба/любой/любовь, Костя/кость, Женя/жена), хвост основы, срезанный в чужую основу (королева/король, Пётр/Петров).

Тест держит промахи и склейки такими, какие они есть, поэтому любое изменение стеммера видно. Обход для склейки — ключ заметки с полным именем, фраза в кавычках или ключ `/regex/`.

- **`search_history {query, before?, limit?}`.**
  - **Область:** активный путь до сообщения, на которое отвечает ход (вид запроса), действующий текст после правок, только text-блоки: рассуждения, вызовы и результаты тулов не ищутся. Скрытые сообщения и сиблинги-свайпы исключены: того, что в них, в этой линии времени не было.
  - **Сопоставление:** все части запроса должны совпасть (AND). Слова сравниваются по основам. Фразы в кавычках (`"…"`, «…», “…”) ищутся подряд идущими словами, с той же свёрткой, но без стемминга. Слова письменностей без пробелов ищутся подстрокой. Стоп-слова [D-46] (`и`, `в`, `на`, `по`, `как`, `the`, `a`, `of`) выбрасываются из запроса, если в нём есть что-то ещё. Регулярок, написанных моделью, нет.
  - **Результат:** сначала новые, по строке на попадание: `#n говорящий: сниппет`, сниппет — ±110 символов вокруг первого совпадения. Говорящий — имя персонажа или персоны. По умолчанию 10 попаданий, не больше 20 (`limit`). Если есть более старые, последняя строка — `More matches before #k: call search_history again with before=k.`, где `#k` — самое старое показанное попадание; так курсор не пропускает сообщения. В малой комнате раунда попаданий меньше, и курсор указывает на непоказанные. Попадания, текст которых уже есть в запросе, помечены `(in context)`.
  - **Пустой результат** говорит, что не совпали слова, а не что этого не было, и советует взять корень короче, другое слово или имя.
  - **Описание тула** просит искать по корням и коротким формам слов и читать сообщение через `read_history`, прежде чем его цитировать.
- **`read_history {from, to?}`** читает страницами [D-58].
  - Номер `#n` — позиция на пути с 1 (приветствие — `#1`); скрытые сообщения считаются и читаются как `#n (hidden)`.
  - Страница — `historyPageChars`: 15 % окна в символах (3 символа на токен), но не меньше 6 000 и не больше 18 000. В раунде она не больше оставшейся комнаты тулов (§9.1) и не меньше `PAGE_FLOOR_CHARS` (500).
  - Сообщения идут целиком, пока помещаются в страницу. Первое приходит всегда; если оно длиннее страницы, приходят его начало и пометка `[#n continues for N more characters, which read_history cannot show]`. Если первое пришло целым, второе целое сообщение приходит, даже когда выходит за страницу, но помещается в лимит результата: так D-58 даёт два целых сообщения.
  - После сообщений идут `returned: #a to #b` и `next_from: k` (`null`, когда диапазон прочитан), затем `You have not read #k to #end yet. Call read_history with from=k before you say anything about them.`, если диапазон не дочитан, или `The chat ends at #N.`, если `to` не задан или выходит за конец чата.
  - `maxOutput` = 2 × страница + `PAGE_SLACK_CHARS` (1 000). Результат не длиннее `ctx.limit`: место под строки после сообщений вычитается заранее, и они всегда доходят. Если лимит меньше `PAGE_FLOOR_CHARS` плюс эти строки, страница — то, что лимит оставляет. Если в лимит не входит даже `READ_MIN_HEAD_CHARS` (100) символов начала первого сообщения, приходит только курсор: `No room was left in this round to read #from.`, `next_from: from` и запрет утверждать, что это прочитано.
  - Описание тула запрещает утверждать, что прочитан диапазон, который не вернулся.
- **Происхождение (рев. 3).** Код портирован из `/btw` scene-search Леви (RoleCall: `btw/scene-search.ts`, `search-scene-messages.ts`, `read-scene-messages.ts`) и из `studio/dramaturg-tools.ts` Bunraku (нумерация `#n`, заглушки скрытых, страницы). При порте изменены четыре вещи:
  - граница слова — на Unicode;
  - добавлен стемминг;
  - область поиска сужена до активного пути;
  - курсор `before` берётся от последнего показанного попадания: у RoleCall он брался от края просмотренного окна и пропускал сообщения.

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
  | { t: 'replay'; r: Replay }                   // нагрузки для повтора в цикле тулов, перед finish (§8.6)
  | { t: 'finish'; reason: FinishReason; raw: string; model?: string }   // model — модель, которую отдал сервер
  | { t: 'error'; err: ProviderError; afterOutput: boolean };
interface Provider { stream(req: ModelRequest, env: { fetch: typeof fetch; key: string | null }): AsyncIterable<StreamEv> }
// complete(req) = aggregate(stream(req)) + проверка терминального состояния: наверх ВСЕГДА стримим
```

**Тулы в запросе.**

- `tools` — спецификации тулов хода, отсортированные по имени. Их несёт только native-раунд. Prompted-раунд идёт без `tools`: каталог лежит в блоке ядра, а `stop` — это стопы семплера плюс `PROMPTED_STOP` (§8.3).
- `toolChoice` — `'auto'` на обычном раунде и `'none'` на финальном; схемы на финальном раунде остаются объявленными [D-91]. Уйдут ли `tool_choice` и схемы на провод, решает адаптер по записи возможностей (§8.3).
- `prefill` и тулы в одном запросе не встречаются [D-28].
- Объявления нативных тулов сервер считает частью промпта. Поэтому их считает и ядро: сборка — в фиксированной части бюджета, трасса — в `trace.tokens.estimated` (`estimateToolSpecs`: JSON объявлений в том виде, в каком их несёт openai-chat). Иначе EMA и проверка обрезки на сервере читали бы native-ходы как дрейф токенизатора. Каталог prompted-тулов и так лежит в сообщениях.

**Устройство адаптера.**

- Чистый `build(req) → {url, headers, body}` и фабрика парсера на каждый запрос: `createParser() → {line(raw) → StreamEv[], end() → AssistantResult}`.
- `AssistantResult.replay` хранит дословные нагрузки текущего раунда. Поток отдаёт их событием `replay` прямо перед `finish`, не больше раза на вид: у openai-chat это `reasoning_details` и `tool_extra`. Цикл кладёт их на wire-сообщение раунда (§8.6).
- Совпадение `replay` проверяется только по `connection` + `model`; `kind` говорит адаптеру, как его рендерить.
- Изменяемого состояния на уровне модуля нет: синглтон адаптера Anthropic в RoleCall перемешивал параллельные потоки.
- `fetch` и ключ передаются **на каждый запрос** (`Engine.open({fetch, keys})`), и провайдер между запросами не кэшируется. Это нужно хосту с собственным замком исходящих запросов (Bunraku).

**Общий `sse.ts`.**

- **Чтение.** Один байтовый поток и один `TextDecoder`. Разбиение по LF, CR допускается. `data:` принимается с пробелом и без. Строки-комментарии `:` пропускаются.
- **Когда останавливаться.** Чтение продолжается после `finish` до `[DONE]`, `message_stop`, EOF или паузы `FINISH_GRACE_MS` (§8.8), потому что usage приходит после finish. EOF без терминального сигнала — это `truncated_stream`, а не придуманный stop. `finish` отдаётся вместе с чанком, где пришёл `finish_reason`, а не на `[DONE]`: обрыв, простой, ошибка или Stop между ними стоят только usage (ответ коммитится с `finish` провайдера, сбой — `stream_tail_failed`).
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
  tools: 'native' | 'prompted' | 'none';                  // транспорт тулов (§8.3); 'none' — тулы не предлагаются
  toolChoice: ('auto' | 'none' | 'required')[]; toolChoiceHonored: boolean;   // Ollama: false
  parallelToolCalls: 'send-true' | 'param' | 'never';      // llama.cpp: нужно явно true
  strictTools: boolean; toolIdFormat?: 'mistral9';
  structuredOutput: { mode: 'json_schema' | 'none'; confirmedBy?: 'host' | 'probe' | 'user' };
  midSystem: 'anthropic-native' | 'native' | 'as-user'; alternation: 'free' | 'strict';
  prefill: 'assistant-last' | 'prefix-flag' | 'none';
  reasoning: { output: 'none' | 'reasoning_content' | 'reasoning' | 'reasoning_details' | 'tags'
                      | 'anthropic-blocks' | 'gemini-parts';
               tags?: string[]; control: 'none' | 'effort' | 'budget' | 'adaptive' | 'level' | 'toggle';
               canDisable: boolean; offShape?: unknown /* Sonnet 5.5: between_tools */;   // canDisable: reasoning 'none' выключает thinking
               echo: 'never' | 'tool-turn' | 'all-with-tools'; answerInReasoning?: boolean };   // 'all-with-tools' — эхо DeepSeek (§8.4)
  samplers: { accepted: string[]; fixed?: boolean; wire?: Record<string, string> };
  streamUsage: 'stream_options' | 'always' | 'timings' | 'none';
  caching: 'auto-prefix' | 'anthropic-breakpoints' | 'none';
  maxInFlight: number;                 // ёмкость origin: явный max_in_flight, иначе 1 локально и 4 удалённо; проба слотов только советует [D-84]
  source: ('host' | 'model' | 'catalog' | 'probe' | 'user')[];
}
```

**Порядок источников.** Каждый следующий уточняет предыдущий.

1. **Пресеты хостов** (`hosts.json`): llama.cpp :8080, Ollama :11434, LM Studio :1234, koboldcpp :5001, vLLM, OpenRouter, NanoGPT, DeepSeek, api.anthropic.com, generativelanguage.googleapis.com. Пресеты локальных серверов (`LOCAL_SERVER_KINDS`: llama.cpp, Ollama, LM Studio, koboldcpp, vLLM) не утверждают `structuredOutput`: его подтверждает проба или пользователь (§7.2), и `checkCapsRows` отвергает `confirmedBy:'host'` в такой строке.
2. **Строки по шаблону модели** (`models.json`). Например, у claude-opus-5-5, claude-sonnet-5-5, claude-fable-5-1 и claude-mythos-5-1 в `toolChoice` нет `'required'`, а также стоят `canDisable:false`, `prefill:'none'` и фиксированные семплеры.
3. **Метаданные каталогов:** OpenRouter `supported_parameters`, Ollama `/api/show`, llama.cpp `/props`, koboldcpp `/api/extra/version`.
4. **Активные пробы** (`rp-core probe <conn>:<model> --active`, в REPL `/probe --active`). Они зовут модель через тот же адаптер, что и ход, — не больше `ACTIVE_PROBE_MAX_CALLS` (6) вызовов, повтор тоже считается:
   - `stream` — пинг: ответ, поле рассуждений, usage в потоке. Если не пришли ни usage, ни `timings` llama.cpp, а запись не просила `stream_options`, пинг повторяется с ним (`stream_usage`);
   - `tools` — один тул с `tool_choice:'auto'`, принудительный вызов не используется. Итог — native-вызов, вызов, протёкший текстом, отказ сервера или ответ без вызова. После native-вызова `tools_result` отправляет результат так, как его шлёт финальный раунд цикла (`toolChoice:'none'`); факт `tools:'native'` пишется, только если ответил и он;
   - `json_schema` — ответ по схеме на промпт, который JSON не просит: объект ровно по схеме значит, что сервер её навязал.

   Правила проб:
   - **Потолок ответа** — `probeMaxTokens`: значение из `ACTIVE_PROBE_TOKENS` (96 у пингов, 1 024 у вызова тула, 512 у ответа на результат и у JSON), но не больше `maxOutput` записи и не больше `max(16, окно − PROBE_PROMPT_TOKENS)`, где `PROBE_PROMPT_TOKENS` = 512. Запас нужен думающей модели: рассуждение тратит тот же `max_tokens`.
   - **Вердикт** — `ok`, `no` или `inconclusive`. `no` — довод: отказ, протечка, проза вместо схемы. `inconclusive` — ничего не узнали (таймаут, сбой сервера, ответ упёрся в потолок, пустой ответ) и факта не даёт.
   - **Ошибка 5xx до вывода.** Вызов повторяется один раз, если вызовы ещё есть. 500/501 — отказ, только если 5xx пришла и на повтор, а сервер не Ollama: Ollama отказывает в тулах кодом 400, а её 500 — упавший раннер.
   - **Проба без вызова.** Если вызовы кончились, проба получает `inconclusive` с текстом `PROBE_NOT_RUN` («not run: …»).
   - **Хранение.** Факты лежат в `<home>/caps-cache.json`: у строки `conn:model` часть `catalog` (источник 3) и часть `probe` (источник 4); старая строка `caps` читается как `catalog`. Пишет их только `--write`, новые факты пробы ложатся поверх старых. Без `--write` печатается готовый блок `[caps."conn:model"]`. Записанное действует с новых ходов; открытый REPL держит записи, с которыми стартовал.
5. **Оверрайды** `[caps."conn:model"]` в конфиге.

**Если о модели ничего не известно,** всё, что может дать 400, считается неподдерживаемым:

- неизвестное поле не отправляется;
- тулы — `prompted` [D-15];
- `structuredOutput` — `none`.

**Одно правило для всех агентов.** Транспорт определяется до вызова и **никогда** не переключается посреди хода. Fallback с другим транспортом получает свой запрос, собранный заново, и идёт, только пока у хода нет вывода [D-90]: транспорты в одном ходе не смешиваются. Сбой транспорта превращается в типизированный отказ. У рассказчика совет `notice{code:'caps.suggest'}` с готовой строкой конфига приходит в одном случае: DeepSeek отверг заглушки эха (§8.4). Транспорт модели показывает `rp-core probe --active`.

Запись возможностей меняется только через пресет, каталог, явную пробу или пользователя. Ядро не делает выводов из текста ошибок и ничего не применяет само.

### 8.3 Транспорты тулов

**native.**

- Тулы уходят в поле провайдера; набор отсортирован и стабилен.
- `tool_choice` — только `auto` или `none`, и только если значение есть в `caps.toolChoice`: DeepSeek V4 и reasoner отвечают 400 на любой `tool_choice` и не получают его вовсе.
- Для llama.cpp `parallel_tool_calls:true` отправляется, если так сказано в записи.
- Блок ядра здесь — только протокол (`renderCoreBlock`): сначала искать, потом писать; не гадать; не упоминать тулы в самом рассказе.
- Живой текст раунда тоже проходит стриминговый вырезатель `<tool_call>` (ниже): блок в стиле Qwen и тег с именем предложенного тула [D-97] не попадают ни в события, ни в chk.
- id вызова — серверный, если он проходит `SAFE_ID` и ещё не занят в ходу; иначе `call_<раунд>_<i>`.

**prompted** (`<tool_call>`).

- Нативные тулы не отправляются.
- **Каталог** — текст протокола плюс по записи на тул, аргументы выводятся из JSON Schema. Он лежит в **блоке ядра**: отдельном system-блоке в конце ведущего прогона, никогда не внутри блока пресета.
- **Формат вызова:** `<tool_call>{"name":…,"args":{…}}</tool_call>`. Пример в блоке ядра и строку вызова в напоминании [D-96] строит одна функция, `promptedCallLine`.
- **Терпимый парсер** (`parsePromptedCalls`) принимает:
  - ключи `arguments`, `parameters` и подобные вместо `args`, а также форму OpenAI `{"function": {…}}`;
  - атрибутную форму `<tool_call name="x">`, fences вокруг блока и внутри него;
  - контейнер `<tool_calls>`, массив, NDJSON и `{"tool_calls": […]}` — по вызову на элемент;
  - тело в виде python-вызова: `search_history(query="…")`;
  - незакрытый блок — в конце текста, перед следующим открывающим тегом или перед `<tool_result`, — если вызов внутри полный;
  - обёртку: пустой незакрытый блок или тег, который закончил открывающий тег следующего вызова, — разметка без вызова. `<tool_call><search_history>брат</search_history></tool_call>` — один вызов, а `'<search_history>'.repeat(3000)` — один оборванный;
  - имя предложенного тула как тег [D-97]: `<search_history>брат</search_history>` — вызов `search_history`. Тело — JSON-объект (конверт `{"name", "args"|"arguments"|"parameters"}` или сами аргументы), а если у тула ровно одно обязательное поле и оно строковое — просто текст этого поля. Пустое тело закрытого тега (и самозакрывающийся `<search_history/>`) — вызов без аргументов у любого тула: чего не хватает, скажет проверка аргументов. Регистр имени не важен, атрибуты и префикс `ns:` допускаются. Имена, которых нет среди предложенных, тегами не считаются: `<i>`, `<br>`, `<search>` остаются прозой, а ход без тулов не меняется.
  - незакрытый тег — как незакрытый блок. JSON-тело кончается после объекта, если дальше идёт проза. Текстовое тело (после ведущего слова `json`, если оно есть) — первой строкой, если ниже есть ещё текст: проза ниже остаётся текстом. Fence вокруг текста, открытый внутри тега, кончается своей закрывающей строкой, а незакрытый идёт до конца блока: до конца текста или до следующего открывающего тега. Пустой тег, оборванный концом текста, — оборванный вызов.
- **Незакрытый блок, за вызовом которого идёт проза,** кончается сразу после значения, а проза остаётся текстом: в потоке, в chk и в сохранённом ответе.
  - Значение — JSON, который закрывается и строго парсится, или целый python-вызов.
  - Ещё значения через запятую — это ещё вызовы того же блока: `{…}, {…}`, `[f(…), g(…)]`.
  - Знаки, которые модель оставила после вызова (`,` `;` `:` `}` `]` `)`), уходят вместе с блоком, даже через пробелы и переводы строк.
  - `[OOC: …]`, `<i>`, `<br>` после значения остаются прозой. python-вызов, за которым идёт проза с `)` на конце, — тоже вызов, а проза остаётся.
  - Если продолжение ещё может быть частью вызова (`{`, `</`, имя тега тула, `name(` без пробела), блок идёт до прежнего конца и читается как оборванный, если тело целиком не полное. Имя предложенного тула здесь — тоже имя тега, в том числе обрезанное концом текста: незакрытый блок `{…}`, а следом `<search_hi` в конце текста — оборванный вызов, на экран ничего не выходит. После текстового тела такой обрезанный тег уходит вместе с блоком, а запросом остаётся текст.
- **Нечитаемый блок** всё равно становится вызовом (имя из блока или `invalid_tool`) с ошибкой в результате: пары вызов/результат в хранении не рвутся.
- **Стриминговый вырезатель** с carry-буфером не пускает обрывки тегов в события `text`. Он придерживает и хвостовые пробелы, и строку, которая может оказаться fence вокруг следующего блока; склейка всего, что он выдал, равна `stripPromptedCalls` всего текста. Решённые блоки он помнит и заново не читает: 100 КБ незакрытых открывающих тегов, поданные по 16 символов, вырезаются быстрее чем за 0,1 с (было ≈ 17 с).
- **`PROMPTED_STOP`** (`<tool_result`) — стоп-последовательность: раунд шлёт стопы семплера плюс её. Если стопов больше `caps.stopMax`, она остаётся, а уходят последние стопы семплера. Если сервер стоп проигнорировал, всё с `<tool_result` срезается, прежде чем текст раунда вернётся в провод (`cutAtPromptedStop`).
- **Результаты** возвращаются одним user-сообщением: блоки `<tool_result name="…" id="…">` в порядке вызовов, через пустую строку; `</tool_result` внутри текста экранируется. id вызовов — `call_<раунд>_<i>`. Сырой текст вызова внутри хода остаётся в wire-сообщениях: если его вырезать, модель отучится звать тулы.

**Восстановление протечек** (любой диалект и транспорт) [D-57].

- Распознаются известные форматы в прозе (`recoverLeaks`): Hermes/Qwen `<tool_call>`, DSML, Claude `<function_calls>`/`<invoke>`, `[TOOL_REQUEST]`, `[TOOL_CALLS]`, `<function=…>`, служебные токены вызовов DeepSeek V3 и Kimi K2. Когда тулы предложены, сюда же входит закрытый тег с именем предложенного тула [D-97].
- Полный вызов предложенного тула превращается в вызов. Блок с несколькими вызовами берётся целиком или никак. Остальное — неполное, чужой тул, нечитаемое — вырезается при постобработке (§6.2 шаг 9).
- Извлечение JSON-вызовов предложенных тулов из прозы включается, только когда раунд не дал ни одного вызова: native — ни одного нативного, prompted — ни одного блока `<tool_call>` или тега с именем тула.
- Если native-раунд не дал вызовов и восстановление ничего не нашло, блоки `<tool_call>` и теги с именем тула в его тексте читает prompted-парсер. Так незакрытый блок с полным вызовом тоже исполняется, если все его вызовы читаются и называют предложенные тулы.
- Восстановленный вызов не остаётся в тексте ответа: его нет в сохранённом тексте раунда, а у native — и в wire-тексте. События и chk оставляют то, что уже стримилось. Такие куски входят в счёт `notice{tool_markup_stripped}`, как и блоки `<tool_call>` и теги с именем тула, которые native-раунд скрыл, но не исполнил (эхо нативного вызова, чужой тул, нечитаемый блок); результата-ошибки такие блоки не получают.
- Исключение — восстановленный спан внутри блока `<tool_call>` или тега с именем тула: его потоковый вырезатель скрыл ещё в потоке. `recoverLeaks` оставляет такие спаны в тексте (`keep`), и их убирает тот же вырезатель, с теми же стыками. Поэтому подряд идущие закрытые блоки native-раунда хранятся так же, как стримились, и в счёт уведомления не входят.

**Финальный раунд** [D-91].

- native: `toolChoice:'none'`, схемы остаются объявленными. Если сервер `tool_choice` не соблюдает (`toolChoiceHonored:false`, Ollama), адаптер не шлёт ни тулов, ни `tool_choice`: иначе модель всё равно позвала бы тул.
- prompted: запрос тот же, что у обычного раунда.
- Цикл, который уже звал тулы, добавляет на финальный раунд `FINAL_CUE` — просьбу продолжить сцену без тулов. У native это отдельное сообщение: `system`, если `caps.midSystem` — `native` или `anthropic-native`, иначе `user` (src `core:final_cue`). У prompted — конец user-сообщения с результатами.
- Вызовы финального раунда не исполняются (§7.1).

**Префилл или тулы** [D-28]. Префилл и тулы в одном запросе не встречаются; какой из них уйдёт в этом ходу, решает сборка до запроса (§7.1).

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
  - Читаются все известные поля с дедупликацией, что бы ни говорила запись возможностей: `reasoning_content`, затем `reasoning`, если отличается, затем текст `reasoning_details`, если первые два пусты. Ollama на `/v1` стримит thinking в `delta.reasoning`, и оно приходит как рассуждение (docs/M3-DEMO.md).
  - Inline-теги `<think>` и подобные режет стриминговый сплиттер по `caps.reasoning.tags`.
- **DeepSeek** (`echo:'all-with-tools'`) в режиме thinking с тулами требует `reasoning_content` на всех прошлых assistant-сообщениях, иначе 400 [D-94].
  - **Когда эхо включено.** У маршрута `caps.reasoning.echo = 'all-with-tools'`, тулы предложены нативно, и thinking в этом вызове включён: не `reasoning:'none'` при `canDisable`. Адаптер и уведомление об отказе заглушки берут это правило из `echoesReasoning` (`wire.ts`); сборка проверяет то же условие в `echoRuleOf` (`engine/request.ts`).
  - **Что уходит.** Сборка кладёт в историю сырые блоки `reasoning` только тех ответов, что сгенерировала эта же пара соединение + модель. Внутри цикла рассуждение раунда едет на его собственном wire-сообщении. Адаптер ставит `reasoning_content` (или `reasoning`, если так сказано в `caps.reasoning.output`) на **каждое** assistant-сообщение: его собственное рассуждение, а если его нет (приветствие, ответ другой модели, ответ без thinking) — `ECHO_PLACEHOLDER`, один пробел. Пустую строку DeepSeek, по стороннему отчёту, отвергает; что пробел проходит, на настоящем API не проверено.
  - Thinking не выключается, тулы не снимаются, `caps.suggest` заранее не приходит. Если thinking выключен (`reasoning:'none'` при `canDisable`), ничего не эхается.
  - **Отказ.** Если запрос с заглушками получил HTTP 400 с кодом `bad_request`, приходит `notice{code:'caps.suggest'}`, раз за сессию. Он называет выход: `tools = "none"` в `[caps."conn:model"]`. 400 о длине контекста (`context_length_exceeded`) — не отказ заглушки.
  - Fallback, чьё правило эха отличается, собирает свой запрос заново [D-90]: чужие рассуждения в него не попадают.
- **Usage** берётся из финального чанка с `choices:[]`, из повторного чанка OpenRouter или из `timings` llama.cpp.
- **Дополнительно:**
  - OpenRouter — `provider.allow_fallbacks:false` и `session_id`, без изменчивых метаданных;
  - llama.cpp — `cache_prompt:true`.
- **Ollama.** На `/v1` (проверено на 0.34.2) действует `num_ctx` из Modelfile: на демо M3 сервер насчитал 10 377 токенов промпта при оценке 9 869 и прочёл промпт целиком (docs/M3-DEMO.md). Каталог берёт окно из `/api/ps` у загруженной модели или из `PARAMETER num_ctx`, но не обученный контекст. Если нет ни того, ни другого, окно — умолчание сервера (на демо 4096), и его нужно указать в `[caps."conn:model"] context_length`. `tool_choice` Ollama не соблюдает (`toolChoiceHonored:false`).

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

- **Внутри текущего цикла тулов** рассуждения повторяются из `replay` в памяти — дословно, кроме перекладки на переименованный id вызова (ниже):
  - блоки Anthropic: thinking и redacted_thinking, включая пустые;
  - части Gemini с подписями;
  - `reasoning_details` OpenRouter (без них Gemini 3 через OpenRouter зависает);
  - неизвестные ключи вызовов (`tool_extra`, например `extra_content.google.thought_signature`).
- **Сырое рассуждение раунда** едет на wire-сообщении нативного раунда, если `caps.reasoning.echo ≠ 'never'` и вызов не выключает thinking. Prompted-раунд возвращает в провод только сырой текст, без рассуждения. Отправит ли его адаптер, решает он сам: openai-chat — только при эхе DeepSeek (§8.4).
- **Переименованный id.** Если цикл заменил id вызова от сервера (§8.3), `rekeyReplay` переносит запись `tool_extra` на новый id, а запись `reasoning_details`, чей `id` равен старому id вызова, получает новый. Второе — предположение о том, как OpenRouter связывает подпись Gemini с вызовом; без сети его не проверить. Без переименования нагрузки уходят как есть.
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
   - Пересказы стоят в точке обрезки и меняются только вместе с ней. Там же, когда предложены тулы истории, стоит заметка о пропуске (`core:gap`) [D-96].
4. **Вставки по глубине:** сработавший лор, заметки и блок Compendium, директива, авторская заметка. С тулами истории последним на глубине 0 стоит напоминание `core:remind` [D-96]; его текст постоянный для транспорта тулов (у prompted он показывает вызов `search_history`).
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
- **После `finish`** вызов ждёт хвост (usage, `[DONE]`) не дольше `FINISH_GRACE_MS` (3 с) тишины и заканчивается тихо: с finish провайдера и без ошибки. Лимит простоя идёт рядом; если он короче паузы, остановка — сбой хвоста (`stream_tail_failed`). Так сервер без `[DONE]` больше не держит ход до таймаута простоя.
- У Bun fetch свой таймаут простоя (5 минут); `http.ts` выключает его (`timeout: false`): таймауты принадлежат движку.

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
interface Tool<A extends Record<string, unknown> = Record<string, unknown>> {
  name: string; description: string; schema: JSONSchema;   // плоский объект, без юнионов в корне
  effect: 'read';                                          // v1: только чтение; 'write' зарезервирован
  maxOutput?(ctx: ToolCtx): number;                        // символов к модели (по умолчанию DEFAULT_TOOL_OUTPUT = 4 000)
  run(args: A, ctx: ToolCtx): Promise<ToolOutput>;         // { text, summary, error? }: ожидаемый сбой — результат, не исключение
}
interface ToolCtx {                                        // один на ход; signal и pageChars — на раунд, limit — на запуск
  view: PathView; upTo: string;                            // вид запроса, свёрнутый на upTo: свайп не видит ответ, который заменяет
  names: { char: string; user: string };                   // говорящие в результатах
  lore: readonly LoreSource[]; compendium: CompendiumView; // источники лора хода (персона, карточка, @notes, книги сессии); заметки
  handles: HandleTable;                                    // L<n> на ход; C<n> заметки — её хэндл /memory [D-59]
  inContext(msgId: string): boolean;                       // текст сообщения есть в запросе: «(in context)» [D-56]
  pageChars: number;                                       // страница read_history в этом раунде [D-58]
  limit?: number;                                          // доля запуска в комнате раунда, ≤ maxOutput; ставит runTools
  signal: AbortSignal; now: string; rng: Rng;
}
```

- **Показ [D-92].** Набор тулов выбирается один раз на ход, в `engine/request.ts`.
  - Сначала запрос собирается без тулов (проход A) — байт в байт как на M2.
  - Тулы истории (`search_history`, `read_history`) предлагаются, если проход A обрезал историю. Тулы лора (`search_lore`, `read_lore`) — если в лоре хода есть включённая запись или живая заметка, которая не сработала.
  - Предложить нечего — уходит проход A. Иначе проход B собирает запрос со схемами: блок ядра, комната тулов [D-93] (§11). Если проход B не собирается или оставляет комнату меньше `MIN_ROOM_TOKENS` (256), уходит проход A.
  - Проход B обрезает больше, чем A: он держит комнату и блок ядра. Если A сохранил всю историю, а B её обрезал, тулы истории добавляются, и проход B собирается ещё раз; если так не помещается, тулы истории идут одни; если и так нет, остаётся первый проход B.
  - Отсортированный список одновременно уходит модели и служит таблицей диспетчеризации.
  - Тулов не получают continue, модели с `caps.tools = 'none'`, `draft` и ходы, где их выключил префилл [D-28].
- **Исполнение** (`tools/run.ts`, `runTools`).
  - Все вызовы в v1 — чтения, поэтому пачка исполняется параллельно, а результаты встают в порядке вызовов.
  - Одинаковые вызовы раунда (тот же тул, те же канонические аргументы) исполняются один раз и получают один результат.
  - Ошибка одного тула не трогает другие. Неизвестный тул получает результат-ошибку со списком доступных тулов; упавший — `Tool <name> failed: …` (до 300 символов).
  - Stop даёт `cancelled` запускам, которые ещё не закончились; закончившиеся сохраняют результат.
- **Комната раунда.** Цикл (`engine/narrate.ts`) берёт остаток комнаты тулов и сначала вычитает из него собственное сообщение раунда (видимый текст, своё рассуждение, если оно уходит эхом, эхо вызовов с сырыми аргументами), оболочку сообщения с результатами и финальную подсказку. Остальное, в символах (2,5 на токен, с поправкой EMA), достаётся результатам; страница `read_history` в этом раунде не больше его. `runTools` делит это место до запуска тулов:
  - сначала тексты отказанных вызовов (неизвестный тул, плохие аргументы), каждый не больше `DEFAULT_TOOL_OUTPUT`;
  - остаток — по доле на каждый вызов, повторы тоже: запуск, который отвечает на N одинаковых вызовов, берёт N долей, потому что его результат уходит модели N раз;
  - доли распределяются заливкой (`waterFill`) по `maxOutput` тулов: запуск, которому хватает меньше своей доли, отдаёт остаток другим;
  - свою долю тул видит как `ctx.limit` и подгоняет под неё вывод, чтобы курсор, `next_from` и строка «not shown» дошли целыми.
- **Обрезка.** После запуска каждый результат страховочно обрезается до min(`maxOutput`, его доля + часть места, которое не взяли тулы до него). Обрезанный текст кончается пометкой `[cut: the result was longer than N characters]`, и пометка входит в лимит. Если лимит меньше самой пометки, приходит одна `NO_ROOM_MARK` — `[cut: no room was left for this result]`: результат не бывает пустым или обрезанным молча. Она выходит за лимит не больше чем на свою длину; чего не хватило комнате, цикл берёт из `max_tokens` следующего раунда, и тот становится финальным. Тул, который держится в своём лимите, не обрезается никогда.
- **Повтор в меньшей комнате.** Символы комнаты рассчитаны на 2,5 символа на токен. Если счётчик хода меряет результаты дороже оставшегося места больше чем на max(10 %, 2 токена на вызов) (CJK, списки имён), пачка запускается ещё раз в комнате, уменьшенной в той же пропорции: тулы v1 только читают, и повтор безопасен. Небольшой перебор забирает `max_tokens` следующего раунда (§11).
- **Аргументы** проходят цепочку [D-56] (`tools/args.ts`): лимит 1 МиБ → пустая строка или `null` → `{}` → срез шаблонных маркеров (`TEMPLATE_MARKERS` из RoleCall, только в конце строки) → `JSON.parse` → пред-проходы (python-вызов, пропущенные скобки) и `jsonrepair` 3.14.0 → снятие массива с одним объектом в корне → приведение скаляров по схеме → валидация (тип, required, enum, minLength/maxLength, minimum/maximum, minItems/maxItems, `additionalProperties:false`).
  - Корень после починки должен быть объектом: прозу `jsonrepair` превращает в строку, и это ошибка.
  - При неудаче тул не запускается, а модель получает до 500 символов: `Invalid arguments for <tool>: <что не так>. Send one complete JSON object that matches the schema.`
  - Каждая починка пишется в трассу (`template_markers`, `python_call`, `missing_braces`, `jsonrepair`, `array_root`, `coerce:<поле>`).
  - Недостающие обязательные значения не выдумываются, неизвестные ключи не выбрасываются молча: это ошибка.
  - Вызов, который уходит модели эхом, пересобирается из разобранных аргументов: JSON с ключами по алфавиту (`canonicalJson`), `{}`, если аргументы не разобрались.

### 9.2 Встроенные тулы v1 [D-5]

| Тул | Что делает |
|---|---|
| `search_history {query, before?, limit?}` | §7.5 |
| `read_history {from, to?}` | §7.5 |
| `search_lore {query}` | Ранжированный поиск через `lexScore` по включённым записям лорбуков хода (персона, карточка, книги сессии) и живым заметкам. Книга `@notes` пропускается: заметки идут один раз, как записи Compendium. Выключенные записи и списанные заметки не показываются. До 10 строк `<хэндл> <заголовок> (<книга>): <отрывок>` (отрывок ≈ 200 символов, у заметки вместо книги — `note`), если совпадений больше, последняя строка — `N more match; add a word to narrow it.` Остальные записи Compendium с кратким рендером — с M5a |
| `read_lore {ids}` | Полные записи по хэндлам, в порядке запроса: до 20 хэндлов и до 8 000 символов на весь результат |

**`lexScore` (`text/lexscore.ts`)** — одно лексическое ранжирование: сейчас для `search_lore`, позже для селектора, шорт-листа и ростера Compendium (M5) и снимка мира Директора (M4). Запрос разбирается, как в §7.5 (слова по основам, фразы, подстроки), записи сравниваются лексикографически:

1. сколько **разных** частей запроса совпало в заголовке, ключах или тексте записи — больше лучше. Частичное совпадение считается (в отличие от AND у `search_history`); запись без совпадений в список не попадает;
2. при равенстве — сколько частей совпало именно в заголовке или ключе (заголовок считается ключом). Заголовок и каждый ключ сравниваются отдельно, так что фраза не перескакивает через два ключа; ключи `/regex/` в ранжировании не участвуют;
3. затем `rank`, больший выше: `order` для записей лорбуков (без `order` — 100), `prov.lastSeq` для заметок. Шкалы разные, это только разрыв ничьей;
4. затем порядок записей: книги в порядке источников, записи в порядке книги, после них заметки в порядке создания.

Схема своя. Веса `search_lorebook` из RoleCall (заголовок × 3, ключи × 2, текст × 1) на запросе «брат трактирщица» ставят «Брат Алексей» выше трактирщицы, у которой в тексте есть брат; `lexScore` ставит трактирщицу первой. Это фикстура `test/text/lexscore.test.ts`.

**`read_lore`.**

- Строка с несколькими хэндлами делится по запятым, точкам с запятой и пробелам: `"L1, L2"`, `"[L1 L2]"`, `["L1, L2"]` читают оба. Если в строке есть куски в форме хэндла, считаются только они (`L1 (Замок)` — это L1). Строка без них остаётся одним id, и модель узнаёт, что заголовок — не хэндл.
- Хэндл читается свободно: после NFKC (полноширинный `Ｌ１` — это L1), без кавычек и скобок вокруг, в любом регистре, с кириллической `С` вместо латинской C. Другие кириллические буквы хэндлом не считаются (`Л1`).
- Неизвестный хэндл получает строку `"X": no such handle. Use the handles search_lore gave, like L3 or C2.`; хэндл, названный дважды, показывается один раз.
- Запись, которая не помещается в остаток результата, обрезается с пометкой, сколько осталось, если остаётся хотя бы 500 символов (первая — всегда). Хэндлы после неё перечисляются строкой `Not shown, the result is full: L5, L6. Call read_lore with them again.`

**Хэндлы [D-59]** (`tools/handles.ts`).

- `L<n>` — записи лорбуков, на один ход, с 1 в порядке первого появления. Таблица у хода одна, поэтому хэндл значит одну запись во всех раундах хода. Следующий ход нумерует заново.
- `C<n>` заметки — её хэндл из `/memory`: порядок создания всех заметок на пути, с 1. Он стабилен между ходами, поэтому `C3` в строке поиска и `/memory show C3` — одна заметка, и `read_lore` находит любую живую заметку по `C<n>`, даже если поиск в этом ходу её не показывал. Остальные записи Compendium (с M5a) нумеруются после заметок.

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

- Сообщения чата — это область истории: приветствие, история, текущее сообщение пользователя. Вставленные блоки, пересказы, префилл continue и заметка о пропуске [D-96] не считаются.
- `d = 0` — после последнего сообщения; `d = 1` — прямо над текущим сообщением пользователя; `d ≥ count` — перед первым.
- **При равной глубине** блоки упорядочены по `order` по возрастанию, затем по источнику: preset < авторская заметка < depth-заметка карточки < lore < compendium < director < guidance. *Рев. 12:* для ST-источников это порядок самого ST (golden-снимок 06): у него внутри одной глубины и роли идут заметка, заметка карточки, записи WI. Вставки лора на глубине получают `order` расширений ST — 100; `order` записи упорядочивает их только между собой. Директор по-прежнему ближе всех к чату; ниже него только guidance при guided re-roll и, когда с тулами истории часть истории не показана, напоминание о них (`core:remind`) [D-96].

`prompt/depth.ts` — единственный код, который вычисляет вставки. Им пользуются:

- блоки пресета внутри чата;
- лор `@depth`;
- `depth_prompt` карточки;
- авторская заметка;
- директива и блок Compendium (глубина 1);
- заметки Compendium (глубина 4);
- guidance (глубина 0).

**Импорт.** Глубины ST переносятся 1:1. При импорте пресетов RoleCall (с M2) и лорбуков RoleCall (позже) к глубине внутри чата прибавляется 1: у RC глубина 0 означает «перед текущим сообщением пользователя».

**Агенты** попадают в сборку только размеченными вставками (`{src, at: {depth, role} | {slot}}`) с настоящим источником в трассе. В блоки пресета они не вклеиваются никогда.

### 10.2 Нативные форматы

```ts
interface Preset {                 // format: 'core.preset/1'
  name: string;
  blocks: { id: string; name?: string; role: 'system' | 'user' | 'assistant'; enabled: boolean;
            content: string;                                   // макросы разрешены
            at: 'relative' | 'top' | 'bottom' | { depth: number; order?: number };
            override?: 'card_system' | 'card_post_history'; extras?: Record<string, unknown> }[];   // extras — D-70
  forbidOverrides?: boolean;
  samplers?: Partial<Samplers>;
  context?: { maxContext?: number /* может только уменьшать окно */; maxMessages?: number };
  prefill?: string; impersonation?: { prompt?: string; prefill?: string };
  postProcessing?: 'none' | 'merge' | 'semi' | 'strict' | 'single';
  formats?: { wi?: string; personality?: string; scenario?: string; newChat?: string; newExampleChat?: string };   // D-70
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
  probability?: number; groups?: string[]; groupWeight?: number;   // несколько групп — D-70
  scanDepth?: number; caseSensitive?: boolean; wholeWords?: boolean;
  preventRecursion?: boolean; excludeRecursion?: boolean; ignoreBudget?: boolean;
  sticky?: number; cooldown?: number; delay?: number;
  meta?: CompendiumMeta;            // {type?, data?, aliases?, featured?, arc?}: типизированная запись Compendium (§5.8)
  extras?: Record<string, unknown>; // D-70
}
```

**Маркеры** во время выполнения не существуют: конвертер превращает их в **слот-макросы**.

- `{{history}}` — ровно один на пресет. Это проверяется при загрузке; отсутствие — ошибка, а не тихая потеря.
- Слоты лора: `{{lore::before}}`, `{{lore::after}}`, `{{lore::examples_before}}`, `{{lore::examples_after}}`, `{{outlet::name}}`. *Рев. 12:* `{{outlet::name}}` — ещё и макрос ST: он раскрывается везде, где стоит (авторская заметка, поля карточки, заметка на глубине), а внутри текста записей лора даёт пустую строку.
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

Конвейер с семантикой ST. *Рев. 12:* шаги уточнены по реализации, по коду SillyBunny и по golden-снимкам (§14).

1. Собрать включённые записи в порядке стратегии ST «character first»: книга персоны, книга персонажа, затем книги сессии (они сливаются в один список, как глобальные миры ST). Каждая группа сортируется по `order` по убыванию (без `order` — 100), устойчиво. Книга заметок Compendium (`@notes`, §5.8) — своя группа сразу после книги персонажа: бюджет принимает заметки после записей карточки и раньше записей книг сессии. С M5a типизированные записи (`meta.type`) из книг с доступом `read` сюда не входят: их включает Compendium (§7.4.1) [D-76]; до тех пор это обычные записи.
   - **Книга читается один раз по имени**, как мир в ST. Встроенная книга карточки или персоны пропускается, если у книги сессии то же `name` (книга карточки — и если оно совпадает с книгой персоны). Из двух книг сессии с одним именем читается более поздняя. `/lore` показывает, какая книга пропущена. Книга заметок — не мир: она никого не заслоняет и не заслоняется, даже если книга персоны, карточки или сессии называется «Заметки».
   - Таймеры следуют за миром по имени (`trace.loreNames`): если книга читается теперь под другим ключом, её прошлые срабатывания не теряются.
2. Для каждой записи в прямом проходе: не наступил `delay` → пропуск; открыто окно sticky → срабатывает как `sticky`; идёт cooldown → пропуск; константная → срабатывает.
3. Собрать текст для сканирования: сообщения пути до текущего ввода включительно, новые первыми, каждое как `Имя: текст` (в ST `world_info_include_names` включён), скрытые — без них. Запись читает последние `scanDepth` из них. **Значение по умолчанию одно — 2, как в ST** (для нативных книг и импорта). `scan_depth` и `recursive_scanning` уровня книги у `character_book` не переносятся: ST их не читает. У книги заметок Compendium свой `scanDepth: 4`.
4. Сопоставить первичные ключи. Умолчания — поставляемые настройки SillyBunny: без учёта регистра, **целыми словами**.
   - `match:'literal'` — целое слово с Unicode-границей (`\p{L}\p{N}\p{M}_`, проверка посимвольная: lookbehind в Bun ошибается на суррогатных парах). Ключ из нескольких слов и текст в письменностях без пробелов сопоставляются подстрокой. Ключ и текст нормализуются в NFC. В ключах раскрываются макросы идентичности (`{{char}}`, `{{user}}`).
   - `match:'stem'` — слова ключа должны стоять в тексте подряд с теми же основами (`normalizeTerm`, §7.5): «Мира» срабатывает на «Мирой». Ключ в письменности без пробелов сопоставляется свёрнутой подстрокой. Регистр и `wholeWords` здесь не действуют. Ключ `/regex/` остаётся регуляркой; если re2js его не компилирует, он сопоставляется как stem-ключ своего текста. Так сопоставляется книга заметок.
   - `/regex/flags` — через re2js (флаги i, s, m). Регулярка, которую re2js не компилирует (lookbehind, обратные ссылки), сопоставляется как литерал своего текста без слешей, как в RoleCall; если запись не сработала, её вердикт — `regex-error`; предупреждение `lore_regex_invalid` — один раз на запись.
5. Применить вторичные ключи с логикой (`and_any` по умолчанию).
6. Группы включения среди записей этого прохода — взвешенный выбор на seed-RNG (`lore.group`). Запись со sticky выигрывает; группа, уже представленная в прошлом проходе, проигрывает целиком.
7. **Сначала бросок вероятности, потом бюджет** (порядок ST, `lore.prob`; бросок адресуется позицией записи, поэтому не зависит от соседей). Бюджет — накопленный текст всех принятых записей, каждая с `\n`, против `round(25 % × (окно − резерв))` (§11).
   - Первая не поместившаяся запись ставит переполнение; дальше проходят только записи с `ignoreBudget`.
   - `ignoreBudget` пропускает проверку, но её текст — принятый текст и считается против следующих записей (как в ST).
   - Вдали от границы считается сумма длин записей, вблизи — точная длина склеенного текста: срез точный, стоимость линейная.
8. Рекурсия до 3 уровней: текст принятых записей без `preventRecursion` (и из книг с `recursive`, по умолчанию да) пополняет буфер; следующий проход сопоставляет ещё не решённые записи с текстом чата и буфером. Записи с `excludeRecursion` рекурсия не будит. В ST по умолчанию рекурсия без предела — названное отклонение G-5 (§14).
9. Размещение по позициям. Внутри места — по `order` по возрастанию, при равном `order` — в порядке, обратном срабатыванию (ST сортирует по убыванию и вставляет в начало). Исключение — `examples_before`: ST вставляет в начало дважды, поэтому там `order` по убыванию, а равные — в порядке срабатывания. Сработавшая запись, слот которой пресет не берёт (выключенный `worldInfoBefore`), не отправляется, но бюджет занимает, как в ST; трасса держит её в `lore.unsent`, `/trace` и предупреждение `lore_unsent` об этом говорят.
10. Свежесть типизированных записей — забота Compendium (§7.4.1); заметки человека не подавляются.

Таймеры sticky, cooldown и delay выводятся из срабатываний на пути (§5.10), а не хранятся в памяти процесса. Арифметика — как `TimedEffects` в ST, в сообщениях пути без скрытых (ST считает чат для WI без `is_system`): sticky держится, пока длина чата меньше L+S; cooldown после sticky начинается с первого скана на длине ≥ L+S, как его перевзводит ST; срабатывания continue считаются с позиции сообщения плюс один.

Каждое решение становится вердиктом: сработала и почему, пропущена и почему, срезана бюджетом. В трассе хранятся только `fired`, `cut` и `unsent`, вердикты пересчитываются по seed и часам [D-45]. `/lore test <текст>` и `lore/test` показывают их без запуска хода, `/trace` — для прошлого ответа, `/preview --verdicts` — для любого запроса.

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
  - *Рев. 12, по реализации (как в ST):*
    - пресетом ST считается файл с признаком chat-completion; пресеты text-completion (NovelAI и др.), тела запросов и голые семплеры отклоняются с причиной;
    - без порядка 100001 действует порядок ST по умолчанию: только стандартные промпты, свои — выключены, с предупреждением;
    - `dialogueExamples` всегда стоит `relative`;
    - свой `relative`-промпт отправляется только при `system_prompt: false`, как в `populateChatCompletion`; файлы с признаками RoleCall читаются по правилам RoleCall (предупреждение `rc_signs`);
    - поля подключения и секреты (`proxy_password`, `reverse_proxy`, `custom_url`, заголовки, модели) в библиотеку не попадают;
    - макросы, которых ядро не исполняет (`{{#if}}`, `{{.var}}` SillyBunny и т. п.), называются при импорте (`unknown_macro`): в модель они уходят как текст.
- **ST world info** с настоящим enum позиций: 0 before, 1 after, 2 note_before, 3 note_after, 4 depth, 5 examples_before, 6 examples_after, 7 outlet. Книга импортируется с `match:'literal'`. *Рев. 12:* декораторы в начале записи разбираются, как `parseDecorators` в ST (`@@activate` → константная, `@@dont_activate` → выключена, остальные — в `extras` с предупреждением); `scan_depth` и `recursive_scanning` уровня книги не переносятся (ST их не читает).
- **Экспорт пресетов RoleCall** (`extensions.rolecall`) — с M2, по правилам RoleCall [D-71]: глубины +1, лор и персона всегда, пины RoleCall → `top`/`bottom` по `injection_order`, append — выключенными, шаблоны форматов и заголовки нового чата и примеров — в `extras` без применения (RoleCall их не применял), числовой `{{random}}` — по D-43.

У каждого конвертера есть тест покрытия по слотам: забытый слот — это тихая потеря данных.

**Позже:** `.vnpack` Леви, экспорт лорбуков RoleCall (+1 к глубине), Marinara, чаты ST в JSONL [D-9].

---

## 11. Бюджет контекста

Всё считается в одном месте — `prompt/budget.ts` — одинаково для рассказчика и всех агентов.

- **Окно** = `min(caps.contextLength ?? (8192 для localhost | 32768 для удалённых), preset.maxContext, config.window)`. Пресет и сессия могут только уменьшить окно.
- **Резерв на ответ** = `min(maxTokens ?? (window < 24 576 ? 2 048 : 8 192), window / 2)`. *Рев. 6 [D-89]:* на малом окне 8 192 по умолчанию почти не оставляли бы места истории (§7.4.6). Рассуждающей модели на таком окне `max_tokens` стоит задать явно. `maxTokens` здесь уже ограничен `caps.maxOutput`, а в запрос уходит сам резерв: промпт плюс `max_tokens` помещается в окно. В раундах тулов после нулевого `max_tokens` меньше на то, что цикл дописал сверх комнаты тулов (`roundMaxTokens`, не ниже 1): например, длинный текст перед вызовом или результат, который счётчик меряет дороже 2,5 символа на токен. Так промпт плюс `max_tokens` остаётся в окне и в этих раундах. Если `max_tokens` пользователя урезан, движок говорит об этом один раз (`max_tokens_reduced`).
- **Подсчёт токенов.**
  - **M1, без зависимостей:** консервативная оценка по символам (символы/3, для кириллицы — символы/2,5) с поправкой EMA.
  - **С M2:** `gpt-tokenizer` o200k, умноженный на поправку EMA для каждой модели. Словарь грузится лениво (≈ 0,3 с при первом подсчёте); счёт кэшируется по тексту. В трассе записано, чем считали (`tokens.counter`), и EMA учится только на сэмплах того же счётчика.
  - Поправка учится по промпт-токенам, которые сообщает провайдер (llama.cpp `timings.prompt_n`, usage Anthropic): α 0,3, старт 1,15, коридор 0,8–2,0. Вызов с отношением ниже 0,5 — не сэмпл: сервер обрезал промпт (Ollama молча выкидывает старые сообщения под свой `num_ctx`). О таком вызове движок один раз говорит `context_truncated_by_server`.
  - Счётчик подключается через внутренний интерфейс.
  - **Ход с тулами:** сэмпл EMA — нулевой раунд, его оценка и его промпт-токены; суммы по раундам поправку не учат. У native-тулов в оценку промпта (`trace.tokens.estimated`) входят объявления схем: сервер считает их промптом, и без них EMA принимал бы их за дрейф счётчика.
- **Доли окна:**
  - лор вместе с блоком Compendium — 25 % промптовой части окна, `round(0,25 × (окно − резерв))`, как `world_info_budget` в ST (рев. 12: ST берёт долю от `getMaxPromptTokens()`, а не от всего окна); если у Compendium есть кандидаты, движок лора берёт не больше 60 % этой доли (§7.4.1);
  - слот `{{recap}}` — отдельные 10 %: обзоры арок (не больше половины слота), затем пересказы; старейшие выпадают первыми (§7.4.4);
  - комната тулов [D-93] — ещё `round(0,25 × (окно − резерв))` (`toolRoom`), только когда тулы предложены (§9.1; тулы истории — только когда история не поместилась [D-92]). Сборка держит комнату свободной, обрезая историю дальше. В неё дописываются раунды хода: текст модели, эхо вызовов, результаты, финальная подсказка. Если даже защищённые сообщения не оставляют целой комнаты, уходит вся обрезаемая история, а комната — то, что осталось. При комнате меньше `MIN_ROOM_TOKENS` (256) тулы не предлагаются; когда в ходе её остаётся меньше, следующий раунд — финальный;
  - директива и блок ядра резервируются первыми и не обрезаются. С тулами в эту часть входят блок ядра (`core:tools`), у native-тулов — объявления схем, а с тулами истории — заметка о пропуске (`core:gap`) и напоминание (`core:remind`) [D-96] в варианте транспорта хода. Номера в заметке зависят от обрезки, поэтому резервируется самая широкая заметка: оба номера из стольких цифр, сколько их в длине пути. Если история поместилась целиком, заметка и напоминание не уходят, а резерв остаётся неиспользованным.
- **Финальный проход** по собранному запросу.
  - Срезает самую старую историю **кусками по 8** сообщений, чтобы кэшированный префикс жил несколько ходов.
  - Никогда не срезает: system-блоки, текущее сообщение пользователя, вставки агентов, половину пары вызов/результат. Приветствие — только в крайнем случае: если без него запрос не помещается (рев. 12; `notice{greeting_dropped}`). Освободившееся место снова занимает история, по той же сетке кусков.
  - Если не помещается одна обязательная часть, возвращает `context_length_exceeded` и ничего не отправляет. Сообщение называет части и их размер: лор, приветствие, остальное.
  - Префилл и подсказка continue считаются в обязательной части.
- **Агенты.**
  - Директор — 25 % своего окна на историю, в lite-режиме — 10 %.
  - агенты Compendium — по профилю (§7.4.6): в lite запрос recall ≤ min(6 000, 40 % окна), filing ≤ 45 % окна, окно historian ≤ 35 %; в full — бюджеты Bunraku, зажатые окном.
- **Ограничения на ход.**
  - Результат тула к модели — не больше его `maxOutput` и его доли комнаты раунда (§9.1). По умолчанию `maxOutput` — `DEFAULT_TOOL_OUTPUT`, 4 000 символов (так у `search_lore`); у `search_history` и `read_lore` — 8 000, у `read_history` — 2 × страница + 1 000 [D-58]. Тулы со списками сами подгоняют строки под меньшую комнату.
  - Потолок — 12 вызовов модели на ход (`CALL_CEILING`), повторы и запасная модель включены.
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
  | { method: 'memory/add'; params: { sessionId: string; title: string; keys: string[]; content: string } }   // заметка; глагол memoryAdd — с M3
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
  | { type: 'tool'; turnId: string; callId: string; name: string; round?: number; phase: 'start' | 'done';
      args?: unknown; ok?: boolean; summary?: string }   // round — раунд цикла с 0; args у done — разобранные аргументы
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
- **Тулы.** В текстовом режиме stdout несёт только ответ. Каждый законченный вызов тула — одна строка в stderr: `rp-core: ⋯ search_history "караван" → 2 hits`. Если строка ответа ещё не закончена, строка тула начинается с новой строки. С `--json` это события `tool` с номером раунда.
- **Подсказка на `model_not_found`.** В текстовом режиме без `--provider` после сбоя идёт строка `rp-core: hint: …`. Она называет:
  - модель рассказчика, которую держит сессия;
  - `rp-core models <conn>` — что есть на сервере;
  - `/model narrator <conn>:<model>` в `rp-core chat <id>` — как сменить модель сессии; `[roles]` в `config.toml` задаёт только новые сессии.

  Если ход перешёл на запасную модель и сервер не знает именно её, подсказка называет запасную модель и `[roles] narrator_fallback`. Чей вызов упал, говорит `TurnOutcome.failed.route` (`conn:model`). Событие `failed` при этом не меняется.
- **Директор (M4) [D-113].** В текстовом режиме итог Директора — одна строка в stderr, как строка тула: `rp-core: ⋯ director: planned — seeds +1 · chapter 1`, `⋯ director: reused — no changes`, `⋯ director: failed (undecodable)`. `planning` не печатается. С `--json` это события `director`.

**Активные пробы.**

```
rp-core probe <conn>:<model> --active [--write] [--json]
```

- **Что делает.** Сначала, как и без `--active`, читается каталог сервера (§8.2, источник 3). Потом модель получает не больше `ACTIVE_PROBE_MAX_CALLS` = 6 вызовов через тот же адаптер, что и ход:
  - `stream` — ответ в одно слово: работает ли стрим, в каком поле рассуждения, как приходит usage. Если пинг не удался, остальные пробы не идут;
  - `stream_usage` — тот же пинг со `stream_options`, если usage не пришёл, а `stream_options` не отправлялся;
  - `tools` — один тул с `tool_choice: auto`: нативный вызов, вызов текстом (`prompted`) или отказ сервера. После нативного вызова `tools_result` отправляет результат и читает ответ; только после него пишется `tools: native`;
  - `json_schema` — ответ по схеме: соблюдает ли её сервер.
- **Потолок ответа** — `ACTIVE_PROBE_TOKENS`: 96 для пинга, 1024 для тула, 512 для результата тула и для JSON. Так думающей модели хватает места. Потолок не выше `maxOutput` модели и окна минус `PROBE_PROMPT_TOKENS` (512).
- **Вердикт** каждой строки — `ok`, `not ok` или `inconclusive`.
  - `not ok` — свидетельство: отказ сервера, вызов текстом, проза вместо схемы.
  - `inconclusive` — проба ничего не узнала (таймаут, ошибка сервера, ответ упёрся в потолок) и факта не даёт.
  - Ошибку 5xx до вывода проба спрашивает ещё раз. 500 или 501 дважды — отказ, но не у Ollama: она отказывает в тулах кодом 400.
  - Проба, на которую не хватило вызовов, пишет `not run`.
- **Хранение.** Без `--write` ничего не пишется, а отчёт предлагает строки для `[caps."conn:model"]`. С `--write` факты ложатся в `caps-cache.json` отдельной частью строки модели, рядом с каталогом. Новые сессии и чаты читают их при запуске. Проба без `--active` их не стирает. `[caps]` в конфиге сильнее любой пробы.
- **`--json`** добавляет к результату объект `active`: вызовы, наблюдения и факты.
- **Ограничения.** `--active` берёт ровно одну `<conn>:<model>`: на платном API вызовы стоят денег. Код выхода — как у `probe`: 0, если сервер ответил на запрос каталога, иначе 1. Ctrl+C завершает процесс; кэш пишется только в конце, так что ничего не сохраняется.
- В чате то же делает `/probe --active [--write]` для модели рассказчика (§12.4).

**Компактизация (M4) [D-35, D-114, D-124].**

```
rp-core compact <session> [--json]
```

- **Что делает.**
  1. Открывает сессию через движок: прерванный ход восстанавливается, как при любом открытии. Затем закрывает её. `config.toml` для этого не нужен.
  2. Под lock переписывает журнал без строк `chk` и `prep` закрытых ходов: временный файл → fsync → rename → fsync каталога. Номера `seq` сохраняются, поэтому версии не меняются. История, свайпы и снимки Директора (`msg.dir`) остаются.

  Если убирать нечего, файл не трогается.
- **Вывод.** `compacted <id>: <before> → <after> bytes (N lines removed)`. С `--json` stdout несёт один объект `{"sessionId","before","after","removed","kept"?}` (размеры — в байтах), а события восстановления идут в stderr строками JSON.
- **Защита [D-124].**
  - Перед rename compact проверяет, что lock всё ещё его, а журнал — тот же файл (dev/ino) того же размера и mtime, что при чтении. Иначе временный файл удаляется, и приходит отказ `session_locked`.
  - Переписанный файл читается назад и должен дать те же строки минус убранные. Строку, без которой читатель принял бы строку, которую он раньше пропускал, compact оставляет (`kept`).
  - Временный файл создаётся с правами 0600 и получает режим журнала; mtime журнала сохраняется, поэтому порядок `rp-core sessions` не меняется.
- **Отказы — код 5:**
  - `session_locked` — сессию держит другой процесс, или журнал изменился во время работы;
  - `turn_open` — ответ, отложенный конфликтом, ждёт решения;
  - `draft_recovered` — восстановление на шаге 1 отложило черновик, единственная копия которого лежит в убираемых строках. Черновик показывается первым; следующий запуск compact его удалит;
  - `session_not_found`.

  Отказ печатается как у `send`: строка `rp-core: refused (<код>): …`, подсказка и `{"type":"refusal",…}` последней строкой stderr; с `--json` — только последняя.

### 12.4 REPL

Обычный построчный REPL: `node:readline` для редактирования и истории ввода (протокол он не читает), ANSI для стилей, без TUI-фреймворка. *Рев. 15:* тот же REPL на весь экран — `rp-core tui` (§12.4.1). Построчный REPL остаётся по умолчанию. Порты TUI не изменили его вывод ни на байт [D-127]; сознательно изменён только `/director show`: последняя директива теперь печатается целиком [D-139].

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
- Баннер называет транспорт тулов рассказчика: `(tools: native|prompted|off)`.
- Тулы — по одной приглушённой строке на законченный вызов, перед текстом, к которому он привёл: `⋯ search_history "караван" → 2 hits`. В строке имя тула, разобранные аргументы (первый, если он строка, — в кавычках, остальные — `ключ=значение`) и итог тула. Ту же строку `send` пишет в stderr (`render.ts` `toolLine`). Перевод строки, которым новый раунд отделён от прошлого текста [D-55], сразу после строки тула на экран не выводится; в сохранённом ответе он остаётся.
- Агенты — тоже по одной приглушённой строке.
  - *Рев. 14 (M4) [D-113]:* Директор — одна строка на ход: `⋯ director: planned — seeds +1 · chapter 1`, `⋯ director: reused — no changes`, `⋯ director: failed (undecodable)`. `planning` не печатается.
  - Пока Директор включён, баннер добавляет `director <conn:model> (<profile>)`, где profile — значение `director.profile`: auto, full или lite.
- Если префилл пресета снял тулы с ответа [D-28], в строке статуса стоит `tools: off (prefill)`.
- `*действия*` — курсивом.
- Предупреждения (`notice`) — жёлтой строкой; каждое — один раз за сессию.

**Ввод.**

- Ctrl+C во время генерации останавливает ход с сохранением полученного, даже если что-то уже набрано; на приглашении Ctrl+C сначала стирает набранное, два Ctrl+C подряд на пустом приглашении — выход. Во время `/probe --active` Ctrl+C останавливает пробу: ничего не сохраняется (`(probe stopped; nothing stored)`), и это нажатие не считается первым из двух для выхода.
- Строку, набранную во время хода, REPL держит у себя и после `done`/`stopped`/`failed` отправляет через `submit` со свежей версией. Пока идёт ответ, вывод readline приглушён (эхо клавиш и перерисовки строки не попадают в ответ); недонабранный текст возвращается в приглашение после хода.
- Команды правки истории во время хода REPL отклоняет сам.
- При открытии сессии с отложенным (`held`) ответом REPL спрашивает «сохранить / отбросить».

**Команды:**

- **Ответы и история:** `/r` (свайп), `/[` `/]` (листать свайпы), `/regen <указание>`, `/c`, `/e [n]` (правка в `$EDITOR`), `/hide n`, `/rewind n`, `/tails`, `/goto <id>`, `/fork [n]`.
- **Модели и контекст:** `/model narrator|director|recorder|recall <conn:model>`, `/preset`, `/lore add|rm|test`, `/persona`, `/note <текст> [@depth]`.
- **Агенты:** `/director on|off|show` (M4), `/memory [list|show|tree|new|add|edit|retire|restore|undo|refile|retry|recall|export|profile|mode]` (§7.4.9).
  - *Рев. 14 [D-113]:* `/director` — то же, что `/director show`. Он печатает настройку (модель, профиль, личность) и состояние на голове (`directorAt`): ход и последний итог — planned, reused (с ответом, чей план повторён) или failed (код); главу — текущую и число завершённых; арки — заголовок, статус, приоритет, горизонт, возраст, следующий бит, пометку застоя; семена — hint, возраст из срока, подкрепления, `OVERDUE` и «ripe for payoff»; скрытые арки — заголовок, статус, тип, возраст из срока, число улик; намерения; последнюю директиву. Пустое состояние — «The Director has not planned yet.»
  - *Рев. 15 [D-139]:* последняя директива печатается целиком, как её получил рассказчик: блок `[DIRECTOR CONSTRAINTS - BINDING THIS TURN]` … `[/DIRECTOR CONSTRAINTS]` (`renderDirective` директивы записи — после дополнения и фильтра персоны). Заголовок и каждая строка блока приглушены, отступа нет, так что копия — точный текст. Так и в построчном REPL, и в TUI (Ctrl+D). Раньше здесь была однострочная сводка, каждое поле обрезано до 30–40 символов. Заголовки:
    - план записи на голове — `last directive (turn N, as sent):`; свайп, повторивший план, — `last directive (turn N, reused from <id>, as sent):`;
    - запись на голове директивы не отправила (план сорвался) — блок ближайшей записи выше по пути, которая её отправила: `last directive (turn M, as sent on <id>; turn N sent none):`;
    - такой записи на пути нет, но состояние хранит директиву — её авторская копия (до дополнения и фильтра): `last directive (turn M, as the Director wrote it; turn N sent none):`;
    - директивы нет — `no directive yet`; пустая после рендера — `<заголовок>: empty (the narrator got no Director block)`.
  - `/director on` и `/director off` меняют `director.enabled` через `configure`, со следующего хода. Выключенный Директор хранит свой план, `show` его показывает.
- **Заметки и поиск:** `/memory`, `/memory show|add|edit|retire|restore` — часть `/memory` для ручных заметок (§5.8); `/search <слова> [before=n]`.
  - `/memory` (или `/memory list`) — заметки пути по порядку создания, с хэндлами `C1`, `C2`, …; снятые — приглушённо;
  - `/memory show <ref>` — одна заметка и текст, который получит модель. `<ref>` — хэндл `C<n>`, ключ `note:…` или название; название с пробелами в `edit` и `retire` берётся в кавычки;
  - `/memory add <название> | <ключи> | <текст>` — ключи через запятую; без ключей ключом служит название;
  - `/memory edit <ref> <название> | <ключи> | <текст>` — пустая часть оставляет старое значение; при переименовании хэндл и ключ `note:…` не меняются;
  - `/memory retire <ref> [причина]` — заметка перестаёт срабатывать и уходит из поиска; `/memory restore <ref>` её возвращает;
  - каждая правка — одна строка `mem` с `on:null`; во время хода REPL её отклоняет. Подтверждение называет хэндл и название: `note C2 "Lamp" retired: …`. Тот же `C<n>` модель видит в выводе тулов [D-59];
  - остальные подкоманды `/memory` из §7.4.9 отвечают, что придут с M5;
  - `/search` — тот же поиск, что у `search_history` (§7.5), по этому пути и только на чтение: по 10 совпадений, новые сначала; `before=n` показывает более старые.
- **Отладка:** `/trace`, `/preview [--turn id]`, `/usage`, `/probe`, `/probe --active [--write]`.
  - `/trace` добавляет раунды тулов (`rounds: n · <транспорт> tools · ended: … · tool room x of y tok used`) и строку на каждый вызов. Ход без тулов печатается как раньше.
  - `/preview` показывает блок `core:tools` как обычное сообщение и строку тулов с транспортом.
  - *Рев. 14:* `/trace` перечисляет все вызовы хода — агент, модель, время: `calls: director <conn:model> 7.6s, narrator <conn:model> 5.6s`. `/usage` при вызовах других агентов печатает строку на агента (`narrator  N generations · …`, `director  N calls · …`) и `total`; каждый вызов оценивается по своей модели [D-101].
  - `/probe` объясняет, как пробовать сервер из оболочки. `/probe --active` запускает активные пробы модели рассказчика (§12.3) и печатает отчёт в чат. Под `--provider script:` и `replay:` команда отклоняется, под `record:` её нет: вызовы пробы попали бы в запись. Факты, записанные через `--write`, этот чат не видит: соединения строятся при открытии, факты действуют со следующего `rp-core chat`.
- **Сессии:** `/sessions`, `/open`, `/help`.

Команды `/impersonate` в v1 нет, она появится вместе с `draft` (M9).

#### 12.4.1 TUI (рев. 15, M4.5)

`rp-core tui <session> [--provider …]` открывает сессию на весь экран терминала, `rp-core new --tui` — новую сессию [D-125]. Внутри — тот же REPL, что у `rp-core chat`: каждая команда `/…`, удержание строки во время хода, отказы, правила Ctrl+C. Без терминала на stdin и stdout команда выходит с кодом 64: `rp-core tui needs a terminal; use rp-core chat`. Скрипты, пайпы и `--provider script:` остаются у `rp-core chat`.

**Порты [D-127].** TUI ведёт настоящий `Repl` через два порта.
- Ввод — `ReplOptions.source`: `LineSource` (поле ввода TUI, `TextareaSource`) и `InterruptSource` (Ctrl+C). У `LineSource` есть `inline` (своя строка ввода: REPL ставит метку и подставляет текст для `/e`), `multiline` (настоящие переводы строк) и режим `prompt(text, 'line' | 'edit')`.
- Вывод — `ReplOptions.view`: `ReplView` из `src/cli/repl-view.ts` (`line`, `echo`, `message`, `banner`, `turn` → `TurnView`, `status`, `idle`). По умолчанию — `LineView`, прежний вывод построчного REPL. TUI подставляет `TuiView`.
- `ReplOptions.command: 'chat' | 'tui'` — какую команду называют подсказки REPL.
- `chat.ts` разделён на `chatDeps`, `onChatTerm` и `endChat`. TUI берёт `chatDeps` и `endChat`, сигналы ловит сам [D-135].

**Экран [D-128].**
- Три колонки: Models — 28 колонок, Chat — остаток (не меньше 40), Agents — 36.
- От 120 колонок видны все три, от 90 — чат и Agents, уже — только чат. F2 прячет боковые панели; второе F2 возвращает те, что помещаются по ширине.
- Chat: лента, строка статуса и строка ввода. Метка ввода — `you ›`, при правке — `edit ›`. Поле растёт от 1 до 6 строк и не выходит за колонку чата [D-139].
- Models: сессия, персонаж и персона; рассказчик — `conn:model`, окно, транспорт тулов, `(script)` или `(recording)` под `--provider`; Директор — off или `conn:model` (с «follows narrator»), профиль последнего плана, стиль; затем клавиши, по строке на клавишу.
- Agents: рассказчик — состояние, 6 последних вызовов тулов с длительностью, итог последнего ответа; Директор — статус хода и запись на голове (ход, профиль, транспорт, модель, попытки, глава, арки, семена к сроку); агенты M5 — по блоку на агента; внизу — вызовы, токены и цена по пути.

**Лента [D-130, D-137].**
- При открытии — весь активный путь карточками: `Имя › текст` и приглушённая строка статуса ответа. Подсказок REPL (`/r swipe /c continue /e edit`) в ней нет: их заменяют клавиши.
- Дальше лента только дописывается, в порядке REPL. Строки REPL — системные строки: приглушённые, жёлтые, красные. Ход — живая карточка.
- Рассуждения свёрнуты в `⋯ thinking (N chars)`, пока не `/think show`.
- `*действия*` — курсивом, `**жирный**` — жирным, оба без звёздочек, как отрендеренный markdown, и во время потока тоже. Речь внутри действия — прямым шрифтом, `*акцент*` внутри речи — курсивом. `*` открывает курсив только перед непробельным символом, если прямо перед ней нет буквы или цифры, и закрывает только после непробельного, если прямо за ней нет буквы или цифры; любая другая `*` рисуется как есть и ничего не переключает (`5 * 3`, `f*ck`, `* item`, одиночная `*`). `***x***` — жирный курсив. Перевод строки закрывает жирный, действие и акцент; незакрытое выделение теряет открывающую `*` — поток не может смотреть вперёд. Это только в TUI: построчный REPL оставляет звёздочки обоих видов [D-139].
- Continue — новый блок после строки `/c`: `…последние слова`, затем добавка.
- Длинная история: живых записей — до 150, старые сворачиваются в архивные блоки по 50. При открытии строится только хвост; выше — строка `⋯ N earlier messages · Ctrl+Home loads more` [D-138].

**Клавиши [D-129].**

| Клавиша | Действие |
|---|---|
| Enter | отправить |
| Shift+Enter, Alt+Enter, Ctrl+J | новая строка в поле ввода |
| Ctrl+C | остановить ответ, очистить ввод, дважды — выйти (правила REPL) |
| Ctrl+R | свайп (`/r`) |
| Ctrl+G | guided re-roll: `/regen ` в поле ввода |
| Ctrl+O | continue (`/c`) |
| Ctrl+E | правка последнего сообщения в поле ввода (`/e`) |
| Alt+← / Alt+→ | версии ответа (`/[`, `/]`) |
| PgUp / PgDn | лента на страницу |
| ↑ / ↓ при пустом вводе | лента на 3 строки |
| Ctrl+Home / Ctrl+End | начало / конец ленты |
| Ctrl+D | состояние Директора (`/director show`) |
| F1 | `/help` |
| F2 | боковые панели |
| F3 | мышь вкл/выкл |
| Esc | отменить правку, очистить ввод |

- Клавиша-команда вставляет строку команды через тот же источник ввода. Правила REPL — удержание, отказ во время хода — действуют как есть.
- Ctrl+буква узнаётся и в русской раскладке: по `baseCode` (протокол kitty) или по клавише ЙЦУКЕН (modifyOtherKeys).
- Левая панель называет действующую клавишу новой строки: Shift+Enter — если терминал сообщил протокол kitty, иначе Alt+Enter. Ctrl+J работает везде.
- `/help` в TUI добавляет строку про правку на месте, а если левой панели не видно, — и все клавиши.

**Правка [D-131].** `/e` и Ctrl+E правят сообщение прямо в поле ввода, с настоящими переводами строк. Enter сохраняет, Esc или Ctrl+C отменяют. `$VISUAL` и `$EDITOR` в TUI не используются.

**Цвета [D-134].** Все цвета — из терминала, hex нет.
- Текст — цвет терминала по умолчанию (SGR 39). Приглушённое — он же с атрибутом DIM.
- Акценты — палитра ANSI терминала: 2 — игрок, 5 — персонаж, 4 — клавиши и агенты, 3 — жёлтый, 1 — красный, 8 — рамки и полоса прокрутки.
- Фон — фон терминала (SGR 49); у поля ввода своего фона нет.
- Поэтому светлая и тёмная тема работают без определения темы. `NO_COLOR` — только атрибуты; фон выделения мышью остаётся цветом 8.

**Мышь и выделение [D-139].**
- Мышь включена по умолчанию: колесо прокручивает ленту.
- Простое протягивание — выделение OpenTUI: фон — цвет 8 палитры, текст — цвет по умолчанию. Конец выделения отправляет текст в буфер обмена через OSC 52, статус пишет `sent N chars to the clipboard`: отправлено, а дошло ли — TUI не видит. В терминалах VTE (GNOME Terminal, Tilix, Terminator), которые OSC 52 игнорируют, TUI ничего не отправляет: статус говорит об этом и предлагает Shift+протягивание. VTE узнаётся по `VTE_VERSION`, если `TERM_PROGRAM` или переменные kitty не называют терминал, который OSC 52 принимает: Warp, WezTerm, iTerm2, kitty и Ghostty, запущенные из GNOME Terminal, наследуют его `VTE_VERSION`.
- Shift+протягивание — выделение самого терминала (Warp, GNOME Terminal и другие).
- F3 выключает мышь. Тогда терминал выделяет сам, а колесо обычно превращает в ↑/↓: при пустом вводе они тоже прокручивают ленту.

**Лог [D-132, D-136].** Пока экран поднят, ничто не пишет в stdout и stderr. Каждая строка REPL идёт и в ленту, и в `<home>/logs/tui.log`: отчёты команд, уведомления, ошибки, строки `--debug`. Необработанная ошибка — в лог и красной строкой статуса. Строки, сказанные во время выхода, и причина выхода с кодом 1, 3 или 130 печатаются в stderr после восстановления терминала.

**Выход и сигналы [D-132, D-135].**
- Движок и сессия открываются до экрана: отказ (lock, нет сессии) печатается обычной ошибкой CLI, код 5.
- Выход: `renderer.destroy()` → ожидание `renderer.closed` (не дольше 2 с) → прежние stdout и stderr → `\x1b[?2027l` → `endChat`.
- Коды — как у `rp-core chat`: 0 после `/quit`; 3, если ответ упал под `script:` или `replay:`; 130, если ход не остановился после Stop.
- SIGTERM, SIGHUP, SIGQUIT, SIGABRT, SIGPIPE и SIGBUS ловит сам TUI: строка в ленту и лог → `engine.close()` (частичный ответ сохранён, lock снят) → восстановление терминала → код 128 + номер сигнала (SIGHUP — 129, SIGTERM — 143). Второй сигнал — выход сразу.
- Текст модели, строки из файлов и id моделей проходят санитайзер: escape-последовательности и управляющие символы уходят. Под Warp уходят ещё ZWJ, VS16 и модификаторы тона кожи.

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
director = "narrator"          # ссылка: следует за /model narrator — только соединение и модель [D-119]
recorder = "local:qwen3-14b"   # filing и historian
recall = "recorder"           # ссылка: следует за recorder [D-85]
narrator_fallback = ""         # пусто — без запасной модели

[narrator]
max_rounds = 4                 # раунды тулов на ответ, 1–8 [D-55]
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
tools = "native"               # native | prompted | none; оверрайд — после проверки `rp-core probe <conn:model> --active`

[prices."openrouter:anthropic/claude-sonnet-5-5"]
in_per_m = 2.0
out_per_m = 10.0
as_of = "2026-10-06"
```

Конфиг разбирается встроенным `Bun.TOML.parse`, без зависимостей. Значения из конфига попадают в `SessionConfig` новой сессии. Дальше они меняются записями `config`: через `/model`, `/director`, `session/configure`.

**Поправки возможностей.** `[caps."conn:model"]` — поля `ModelCaps` (§8.2) в snake_case; они сильнее каталога и проб. Для тулов важны:
- `tools = "native" | "prompted" | "none"` — транспорт тулов рассказчика; `"none"` выключает тулы этой модели;
- `reasoning.echo = "never" | "tool-turn" | "all-with-tools"` — правило эха рассуждений (§8.4). Если DeepSeek отверг запрос с заглушкой эха (HTTP 400), `notice{caps.suggest}` советует `tools = "none"` [D-94];
- `structured_output = "json_schema" | "none"`.

Отчёт `rp-core probe <conn:model> --active` без `--write` предлагает для этой таблицы строки `tools`, `stream_usage` и `structured_output`. С `--write` те же факты идут в `caps-cache.json` (§12.3); процесс читает кэш при запуске.

`[narrator] max_rounds` вне 1–8 — ошибка конфига. Больше 8 может задать только хост; тогда ход обрезает значение до 8 с `notice{tool_rounds_clamped}` [D-55].

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

**Лог TUI (рев. 15) [D-132, D-136].** У `rp-core tui` нет stderr, пока экран поднят. Всё, что REPL печатает строками, идёт в `<home>/logs/tui.log` (по умолчанию `~/.rp-core/logs/tui.log`): отчёты команд, уведомления, ошибки, строки `--debug`. Каждая строка — с меткой времени, без SGR.
- Карточки ответов в лог не идут. Но отчёты команд идут, а `/search` и `/preview` цитируют историю — как и журнал сессии, это открытый текст на диске (риск 15).
- С `--debug` в лог попадает сырой текст ошибок провайдера — тот, что `rp-core chat` пишет в stderr. Ключей в нём нет.
- Лог только дописывается: ротации нет, права файла — по umask.

---

## 14. Тестирование

Всё работает на `bun:test`, без тестовых зависимостей.

**Провайдеры для тестов.**

- **`script:<file>`** — шаги в JSONL на каждый вызов: `{text}`, `{reasoning}`, `{tool:{name,args}}` или `{tool:{name,argsText}}` (аргументы как есть — для сломанного JSON), `{replay}`, `{delay}`, `{pause}`, `{error:{code,status,afterOutput}}`, `{usage}`, `{cut}`, `{finish}`. Можно проверять хеш запроса; `toolChoice` и `stop` в хеш не входят.
  - Первая строка файла может быть `{"caps": {…}}` — частичная запись возможностей поверх `SCRIPT_CAPS` (там `tools: 'none'`). Так скриптовое соединение получает тулы.
  - Каждое поле этой строки проверяется по типу и по диапазонам `[caps]` из `config.toml`; у `structuredOutput`, `reasoning` и `samplers` — и вложенные поля (`samplers.wire` — объект строк). Ошибка называет строку и поле: `script line 1: caps.<поле> must be …`.
- **`record:` / `replay:`** записывают нормализованную последовательность `StreamEv`, сырой SSE и хеш запроса; секреты вырезаются. Replay при несовпадении хеша **громко падает** и показывает дифф.
- Так CI проверяет цикл хода на реальном поведении провайдеров — без сети и без денег.

**Golden-фикстуры адаптеров.** Сырые SSE, записанные нами самими (`fixtures/sse/<dialect>/<case>.sse`), проверяются против ожидаемых `StreamEv[]` и проводных запросов.

- **Источники:** llama.cpp во всех форматах рассуждений, Ollama, LM Studio, koboldcpp, vLLM, OpenRouter, NanoGPT, DeepSeek, Anthropic, Gemini.
- **Вызовы тулов:** фрагментами и целиком, повторяющиеся имена, пропуски индексов.
- **Поток:** usage после finish, чанки ошибок посреди потока, обрыв.
- **Рассуждения:** варианты полей, `redacted_thinking`, подписи на пустых частях.
- **DeepSeek с тулами** [D-94]: прошлые сообщения ассистента без своего рассуждения этой модели (приветствие, ответ другой модели после `/model`, ответ с выключенным thinking) уходят с заглушкой `reasoning_content: " "`. Thinking не выключается, тулы не снимаются, `notice` нет. `notice{caps.suggest}` с `tools = "none"` приходит раз за сессию и только на 400 `bad_request` запроса с заглушкой, не на `context_length_exceeded` (`test/engine-m3/request.test.ts`, `test/adapter-m3/wire.test.ts`). Заглушка на живом API DeepSeek не проверена.
- **Mid-system у Anthropic:** блоки на глубинах 0–4 при чередующейся и нарушенной истории; слияние двух system на одной глубине.

**Golden-фикстуры сборщика.** Вход — карточка, пресет, лорбуки, путь, seed и часы; выход — снимки `{messages, trace}`.

- **Семантика ST** проверяется наблюдением вывода SillyBunny на тех же входах: глубины 0/1/≥count, позиции WI 0–7, порядок, «вероятность до бюджета», переопределения карточки, неизвестные макросы.
  - *Рев. 12, M2:* 7 случаев сняты 26.10 с SillyBunny 3021edcae: ST во временной папке данных шлёт запрос на заглушку-сервер, тело запроса и есть снимок (`test/golden/st/`, инструменты — `tools/st-golden/`). Входы — файлы в форматах самого ST, ядро читает их своими импортёрами.
  - Совпадение точное, кроме пяти названных отклонений (README снимков): G-1 — примеры диалога одним сообщением, а не отдельными `example_user`/`example_assistant`; G-2 — лор на позиции примеров без строк `Имя:` не выбрасывается; G-3 — вставки одной глубины и роли не склеиваются [D-47]; G-4 — Unicode-граница слова [D-46]; G-5 — рекурсия не глубже 3.
- **Префилл и тулы:** пресет с префиллом при включённых тулах → тулы сняты, префилл в запросе, `notice` один раз. При `prefillVsTools='tools'` → наоборот.
- **Пересказы:** новый пересказ не меняет запрос, пока граница обрезки не сдвинулась.
- **Русский (`fixtures/ru`):** формы слов в поиске, в ключах заметок, в селекторе Compendium и в склейке почти-дублей («Мира/Миру/Мирой»).
  - *M3:* `test/fixtures/ru/normalize-terms.json` — группы слов, которые должны сойтись и разойтись, ожидаемые основы, известные промахи и ложные склейки; его проверяет `test/text/normalize.test.ts`. Ключи заметок по основам — `test/lore-m3/`. Чат `test/fixtures/ru/innkeeper-200` (199 сообщений, его порождает `tools/fixtures/innkeeper.ts`) — для демо M3. Селектор и почти-дубли — M5.
- **Паритет с RoleCall (рев. 3).**
  - Фикстуры `Bunraku/tools/rc-recorder` (11 случаев, закреплены на VAUDEVILLE 68afe385) портируются и дополняются нашими записями из VAUDEVILLE.
  - Паритет проверяется только там, где ядро сознательно не расходится с RoleCall: §12.5, [D-12], [D-16], [D-30].
  - *Рев. 12, M2:* 11 фикстур портированы: сами записи — `test/fixtures/rc-recorder/`, тесты — `test/parity/rc-recorder/`; отклонения с обоснованием — `docs/PARITY-RC.md`. Своих записей из VAUDEVILLE пока нет; лорбуков в фикстурах нет, поэтому паритет лора с RoleCall не проверен. Корпус макросов (`macro-corpus.json`, D-43/D-44) не портирован — открыто.
  - *M3:* корпус тулов — `test/parity/rc-tools/corpus.json`, 121 строка: входы тестов RoleCall для prompted-парсера, починки аргументов, DSML, salvage и исполнителя тулов, плюс свои. Выход RoleCall записан его же модулями на `fb8dc623e`. Строка без отклонения должна совпасть с RoleCall точно, строка с отклонением называет TD-n из `docs/PARITY-RC.md`. Тест — `test/parity/rc-tools/`.

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

**Тулы и поиск (M3).**

- **Без тулов всё как в M2.** Если тулы не предложены, запрос, трасса и сохранённые блоки совпадают с M2 побайтно: golden, паритет и хеши скриптовых запросов не меняются. `test/prompt-m3/no-tools.test.ts` сверяет сборку с дайджестами, снятыми на коде M2.
- **Разбор** (`test/tools-parse/`): цепочка аргументов, prompted-парсер и потоковый стриппер, восстановление протечек, раннер (`run.ts`: доли комнаты, обрезка), хэндлы.
  - `stream-property.test.ts`: для 50 ответов из RNG с seed любая нарезка потока (по символу, каждое разбиение на два куска, 20 случайных) даёт ровно `stripPromptedCalls(reply)` — живой текст равен сохранённому (§8.3). Плюс «суп» из тысяч коротких случайных текстов.
  - `adversarial-timing.test.ts`: на 100 кБ враждебного текста разбор, вырезание и восстановление укладываются в 50 мс каждое (тысячи незакрытых тегов с именем тула [D-97] проверяются в разборе, вырезании и потоке, тысячи незакрытых `<tool_call>` — в потоке); потоковый стриппер по 16 символов — не дольше 3 × того же потока прозы + 50 мс. Сначала идёт версия на 2 кБ, чтобы регрессия падала за секунды, а не висела.
- **Тулы** (`test/tools-builtin/`): поиск по пути, страницы `read_history` [D-58], `search_lore` и `read_lore` с хэндлами [D-59], размер результата в комнате раунда.
- **Поиск** (`test/text/`): `normalizeTerm` по таблице `normalize-terms.json`, `parseQuery`, `lexScore`.
- **Цикл** (`test/engine-m3/`): раунды native и prompted на скриптовом провайдере, финальный раунд, потолок вызовов, защита «3 из 8», комната тулов, Stop и сбой посреди цикла, крэш после раунда, запасная модель с другим транспортом [D-90], выбор тулов в два прохода [D-92], эхо DeepSeek [D-94].
- **Демо** (`test/demo-m3/`): `innkeeper.test.ts` — демо §15 детерминированно; `review-fixes.test.ts` — исправления ревью вместе, на настоящем проводе openai-chat (мок на `Bun.serve`); `live-fixes.test.ts` — правки после живых прогонов: напоминание со строкой вызова [D-96] и дословный вывод Mag-Mell `<search_history>…</search_history>` [D-97], который теперь даёт один вызов.

**TUI (M4.5) [D-133].**

- **`test/tui/`** — 268 тестов в 15 файлах на headless-рендерере OpenTUI: `createTestRenderer` из `@opentui/core/testing`, клавиатура kitty. Символы вне BMP вводятся через `pressKeys([...s])`: `typeText` режет emoji на половинки UTF-16.
  - `kit.ts` — `tuiRig`, клон `replRig` из `test/repl/kit.ts`: настоящий `runTui` со скриптовым провайдером и поддельными часами. `chat-kit.ts` — рендерер с минимальным Ui для ленты.
  - `e2e.test.ts`: раскладка на 120, 100 и 70 колонках (каждая строка кадра — ровно ширина терминала); ввод, поток, Ctrl+C; удержанная строка и отказ правки; каждая команда `/…`; правка на месте; Директор и тул в панелях; `/open` и `/fork`; русская раскладка; `/quit` посреди хода снимает lock. Пока экран поднят, в stdout и stderr не пишется ничего (шпион).
  - `colors.test.ts` проверяет спаны кадра: ни одного rgb-цвета, фон — фон терминала; при `NO_COLOR` — только цвет по умолчанию.
  - `signals.test.ts`: сигналы выхода, второй сигнал, SIGHUP посреди ответа; три теста — в настоящем pty через `Bun.Terminal` (без него пропускаются).
  - `polish-host.test.ts`, `polish-chat.test.ts` и `polish2.test.ts` — правки D-139.
  - Пороги по часам (кадры, открытие 2 000 и 5 000 сообщений) — только с `RP_CORE_PERF=1`; структурные границы — всегда.
- **`test/repl/ports.test.ts`** — 14 тестов портов REPL. Построчный REPL байт в байт прежний: тесты `test/repl`, `test/cli`, `test/cli-m4`, `test/demo-m3` и `test/demo-m4` не менялись. *Позже D-139 сознательно изменил `/director show`; его тесты в `test/repl/m4-render.test.ts` и `m4-flows.test.ts` переписаны под директиву целиком.*
- **Регрессии ревью** проверены мутацией: каждый тест правки падает на коде до неё.
- **Временные каталоги.** `test/preload.ts` ставит `TMPDIR` в `<корень теста>/tmp`, а корень удаляется в `afterAll`. Раньше всё, что тесты создавали в `tmpdir()` (временные дома, обвязки CLI и REPL, дочерние процессы), оставалось в `/tmp`: тысячи каталогов за прогон заполнили его. `/tmp` часто живёт в памяти (tmpfs). Полный прогон рев. 15 шёл с `TMPDIR` на домашнем диске (`~/.cache`).

**Прочее.**

- **Детерминизм:** правило линтера против `Math.random`/`Date.now` в `src/`. Одинаковые seed, часы и replay дают побайтно одинаковые промпты.
- **Живые тесты** идут только с `RP_CORE_LIVE=1`. `test/adapter/live-ollama.test.ts` делает один короткий вызов к Ollama. `test/live/m3-ollama.test.ts` задаёт вопрос демо M3 локальной модели.
  - Переменные: `RP_CORE_OLLAMA_URL` (по умолчанию `http://127.0.0.1:11434`), `RP_CORE_OLLAMA_M3_MODEL` (`magmell-16k:latest`), `RP_CORE_OLLAMA_CTX` (16384), `RP_CORE_OLLAMA_TOOLS` (`prompted` по умолчанию или `native`), `RP_CORE_OLLAMA_MAX_TOKENS` (300; рассуждения думающей модели входят в него).
  - Инварианты проверяются на каждой попытке: блок ядра; заметка о пропуске и напоминание по одному, в том числе слитые с соседним сообщением (src `core:gap+history`); парные блоки; в сохранённом тексте нет разметки тулов, включая четыре имени тулов как теги. Вызов `search_history` и ответ «Тихон» должны случиться хотя бы в одной из трёх попыток.
  - Попытка, которая кончилась не `done`, печатает исход, уведомления, события тулов и то, что стримилось (до 2000 символов); в конце печатается JSON всех попыток.
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
| M4.5 | TUI (рев. 15, вставлена 27.10) | вне оценки | Ничего: новый код на `@opentui/core` 0.7.0 |
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

*Рев. 15:* сейчас рантайм-зависимостей четыре: `re2js`, `gpt-tokenizer`, `jsonrepair` и `@opentui/core` 0.7.0 (M4.5). OpenTUI грузят только `rp-core tui` и `rp-core new --tui`. С ним приходит нативная библиотека под платформу — на Linux x64 это `libopentui.so`, ≈ 5 МБ [D-126].

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
  - Разбор вызовов тулов и события тулов приходят сразу вместе с портом. К циклу они подключены на M3 (§7.1).
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

*Статус: **готово 26.10.2026**. 2086 тестов (и 1 живой, пропускается без `RP_CORE_LIVE`), проверка типов чистая; 7 golden-снимков SillyBunny и 11 фикстур rc-recorder сверены (отклонения названы); живое демо на Ollama — `docs/M2-DEMO.md`; заметки — «Примечания к ревизии», п. 38–41.*

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

*Статус: **готово 27.10.2026**. 3334 теста (и 2 живых, пропускаются без `RP_CORE_LIVE`), проверка типов чистая; корпус паритета тулов с RoleCall (121 строка) сверен, отклонения названы в `docs/PARITY-RC.md`; демо — `test/demo-m3/innkeeper.test.ts` и живые прогоны `docs/M3-DEMO.md`; заметки — «Примечания к ревизии», ревизия 13.*

*Содержание.*
- **Цикл** (`narrateRounds`, §7.1).
  - Раунды тулов в `narrate`, транспорты native и prompted. Повтор и запасная модель оборачивают весь цикл, пока у хода нет вывода. Запасная модель с другим транспортом или другим правилом эха получает свой запрос [D-90].
  - До `narrator.maxRounds` раундов (по умолчанию 4, потолок `MAX_TOOL_ROUNDS` = 8), не больше `CALL_CEILING` = 12 вызовов модели на ход, защита «3 из 8».
  - Финальный раунд: `toolChoice:'none'`, схемы остаются в запросе, `FINAL_CUE` [D-91]. Вызовы на нём не выполняются, трасса пишет их как отказанные.
  - Правило «префилл или тулы» [D-28].
- **Запрос.**
  - Тулы предлагаются, только когда могут помочь: история не влезла — `search_history` и `read_history`; включённая запись лора или заметка не сработала — `search_lore` и `read_lore`. Без тулов запрос — ровно как в M2 [D-92].
  - Комната тулов — четверть окна без резерва ответа [D-93].
  - При тулах истории — заметка о пропуске `core:gap` и напоминание `core:remind` [D-96].
  - Эхо рассуждений DeepSeek: у каждого прошлого ответа — своё рассуждение или заглушка `" "` [D-94].
- **Аргументы и протечки.**
  - Цепочка аргументов [D-56], `jsonrepair` 3.14.0.
  - Протечки превращаются в вызовы: теги `<tool_call>` и `<function=…>`, DSML, `[TOOL_REQUEST]`, `[TOOL_CALLS]`, спецтокены, JSON в прозе, а также имя предложенного тула как тег — `<search_history>брат</search_history>` [D-97]. В сохранённый текст они не попадают.
- **Четыре read-only тула:** `search_history`, `read_history`, `search_lore`, `read_lore`.
  - Страницы `read_history` — по D-58.
  - Хэндлы — по D-59: `L<n>` записей лора живут один ход, `C<n>` заметки — это её хэндл в `/memory`.
- **Поиск.** `normalizeTerm` [D-46] и `lexScore`; `/search` в REPL.
- **Провайдеры.**
  - Активные пробы `rp-core probe <conn:model> --active` и `/probe --active` (§12.3): стрим и usage, один тул только с `auto` и раунд с результатом, `json_schema`. До 6 вызовов, вердикты `ok` / `not ok` / `inconclusive`, факты — только с `--write`.
  - Событие стрима `replay` (`reasoning_details`, `tool_extra`); его пишут и проигрывают `record:` и `replay:`.
  - Строка `{"caps": …}` в начале файла скрипта.
- **Ручные заметки Compendium** (§5.8) — без вызовов модели:
  - свёртка `mem` (`foldCompendium`) для операций `note`, `edit`, `retire`, `restore`; ключ `note:<название>` строится через `normalizeName` [D-95];
  - `/memory list|show|add|edit|retire|restore` для заметок с `on:null` и глаголы `memoryAdd|Edit|Retire|Restore` в `SessionHandle`;
  - книга заметок `@notes` с `match:'stem'` в движке лора, вставка на глубине 4.
- **CLI.** Баннер `(tools: …)`, строки тулов в REPL и в stderr `send`, раунды в `/trace`, блок тулов в `/preview`, подсказка на `model_not_found` (§12.3, §12.4).

*Что ушло дальше.*
- Операции `file`, `arc` и `revert` строк `mem`, типизированные и библиотечные записи — M5. Свёртка M3 пропускает их с пометкой `not_until_m5`, чтобы строки поздней версии её не ломали.
- Recall, filing и historian — M5; в M3 заметки пишет только человек.
- `/memory tree|new|undo|refile|retry|recall|export|profile|mode` — M5; REPL отвечает, с какой вехой они придут.
- Слияние из `filing-stage.ts` и `merge.ts` заметкам не понадобилось — оно в M5a.

*Источники (port/adapt).*
- Bunraku: `tool-loop.ts`; из Kit — `stop-core.ts` и `scheduler.ts`.
- RoleCall:
  - `prompted-tool-calls` целиком;
  - часть `tool-call-repair`;
  - DSML, `content-tool-salvage`;
  - поиск `/btw`: `scene-search.ts`, `read-scene-messages.ts`.
- Bunraku: `dramaturg-tools.ts` (код Леви), `normalizeName` из `relationships.ts` [D-95].
- RoleCall ещё: `search-scene-messages.ts`, описания тулов из `rc-knowledge.ts`, `executeSearchLorebook` и `extractSmartSnippet` для `search_lore`; веса `search_lorebook` — только образец расхождения для `lexScore`.
- SillyTavern (через SillyBunny): идея заглушки `reasoning_content` для DeepSeek. Полный список — `PROVENANCE.md`.

*Новое.* `normalize` (свой список русских окончаний), `lexscore`, хэндлы, восстановление `[TOOL_REQUEST]`, `[TOOL_CALLS]`, `<function=…>`, `<function_calls>` и спецтокенов, активные пробы, выбор тулов и комната, заметка о пропуске и напоминание, заметки (`agents/compendium/{types,notes}.ts`), русский чат на 199 сообщений для демо.

*Демо.*
- На 200-м сообщении спросить: «как, по словам трактирщицы, звали её брата?» Локальная модель в prompted-режиме ищет «брат», находит «братом» и отвечает верно.
- Заметка из `/memory add` с ключом «брат» срабатывает на «брата».

*Как прошло.*
- **Детерминированно** — `test/demo-m3/innkeeper.test.ts`. Чат `test/fixtures/ru/innkeeper-200`: 199 сообщений, имя брата есть только в #5. Скриптовая модель с prompted-тулами, окно 16k. Запрос несёт заметку о пропуске и напоминание [D-96]. Модель ищет «брат», результат поиска показывает «…с младшим братом — его зовут Тихон…», финальный раунд называет Тихона. Заметка с ключом «брат» срабатывает на «брата» на глубине 4, `/search` находит #5. `test/demo-m3/review-fixes.test.ts` повторяет демо с нативными тулами.
- **Вживую** — на Ollama, `docs/M3-DEMO.md`; тот же вопрос задаёт `test/live/m3-ollama.test.ts` (только с `RP_CORE_LIVE=1`). На двух опробованных локальных моделях заявка демо не выполнена: даже после D-96 и D-97 Mag-Mell 12B (prompted) и gemma4:26b (native) отвечали по видимой части чата, не зовя `search_history`, и часто выдумывали имя. Цикл доказывают детерминированные демо (`innkeeper.test.ts`, `review-fixes.test.ts`, `live-fixes.test.ts`); прогоны — в `docs/M3-DEMO.md` и в «Примечаниях к ревизии», п. 43.

---

**M4. Story Director** · 10,5–18 дней, *меньше риска*

*Статус: **готово 27.10.2026**. 4254 теста прошли, 3 пропущены (живые, без `RP_CORE_LIVE`), 0 упали — 4257 тестов в 199 файлах; проверка типов чистая. Демо без модели — `test/demo-m4/`; живые прогоны — `docs/M4-DEMO.md`; решения сборки — D-98…D-124 (§19.10, ждут подтверждения — вопрос 22); заметки — «Примечания к ревизии», ревизия 14.*

*M4a — чистое ядро Директора*, 6–11 дней.
- **Состав:** state, plan (с lite-схемой), reduce, momentum, render, prompt (с новым lite-промптом), личности и ≈ 760 строк портированных тестов.
- **Кто и когда.** Можно отдать второму разработчику; M2 и M3 готовы, поэтому M4a ничего не ждёт. Лучше всего подходят Chi или Nemo — авторы этого кода в Bunraku.
- **Зависимости.** `normalizeTerm` со стоп-словами [D-46] (`text/normalize.ts`) и `jsonrepair` (для `plan.ts`) — оба есть с M3; `jsonrepair` пока подключён только в `tools/args.ts`.

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

*Как прошло.*
- **Детерминированно** — `test/demo-m4/`, скриптовые ответы модели и настоящий движок: `runDirector`, `readPlan`, `applyPlan`, `fitState`, журнал и свёртка.
  - `thirty-turns.test.ts` — 30 ходов русской истории. На голове — две главы (первая завершена, вторая `concluding`), четыре арки, у трёх — следующий бит в ожидании, семена (одно оплачено на 18-м ходу, три ждут), скрытые арки с уликами. Читаемый дамп состояния печатается в вывод теста.
  - `three-hundred.test.ts` — 300 подробных русских ходов: каждый снимок не больше 32 768 байт, медиана — 19 946 и 23 784 байта для двух планировщиков, максимум — 32 552 (§7.3).
  - `swipes.test.ts` — свайп повторно использует план без вызова, `/regen <указание>` планирует заново с указанием, откат возвращает прежнее состояние, и следующий план идёт от него. Испорченный план на lite с окном 8k даёт `director: failed (undecodable)` после корректирующего прохода, а ответ приходит; `max_tokens` прохода меньше, чем у первого вызова [D-121].
- **Вживую** — `docs/M4-DEMO.md`. Ollama на 127.0.0.1, `magmell-16k:latest` (Mag-Mell 12B, окно 16 384) — и рассказчик, и Директор (`roles.director` не задан). Профиль auto → lite (окно < 24 576), транспорт tagged. Сессия с трактирщицей Марфой и персоной Елисеем (`test/fixtures/ru/innkeeper-200`), `--max-tokens 300`; четыре русских хода, `/r`, `/regen <указание>`, `/rewind 5`, `/director show` и `/trace`. Ничего не скачано, не создано и не удалено.
  - **Прогон 1, до правок ревью.** План хода 1 — с первой попытки (117,6 с на холодной модели). Ход 2 — после корректирующего прохода: первая попытка упёрлась в 300 токенов. Ходы 3 и 4, `/r` и `/regen` — `failed (undecodable)`: обе попытки кончились `finish:'length'` ровно на 300 токенах. Причина — Директор брал у рассказчика всю привязку, вместе с `--max-tokens 300` → [D-119]. С первого ответа под английской директивой рассказчик стал вставлять в русский текст целые английские предложения → [D-120]. Ответы рассказчика приходили всегда; откат возвращал состояние хода 2.
  - **Прогон 2, после правок.** Все 5 вызовов Директора (ходы 1–4 и `/regen`) спланировали с первой попытки: 404–460 выходных токенов, `finish` — `end`; 110 с на холодной модели, дальше 7,6–8,8 с. `/r` — `reused` без вызова, `reusedFrom` — заменённый ответ. `/regen` — новый план. `/rewind 5` → `/director show` — снова состояние хода 2.
  - **Что модель напланировала за 4 хода:** главу 1 «A Warm Welcome», одно семя («The old map»), по два намерения на ход и директиву (mood, обстановка, напряжение 2–3 из 10, концовка; со 2-го хода — один бит персонажа, на 4-м ходу и в `/regen` — одно направление арки). Арок не завела ни одной; события ходов 2–4 — `planned — no changes`: менялись только намерения и директива. Скрытых арок нет — в lite их нет по замыслу.
  - **Язык.** Рассказчик держал русский в 5 ответах из 6; ответ на `/regen` посередине перешёл на английский. D-120 помогает, но 12B-модель не лечит.
- **Вживую не прогонялось:** 30 живых ходов (≈ 60 вызовов) — заявку демо закрывает детерминированный `thirty-turns`; транспорт structured — ни у одной локальной модели здесь нет подтверждённого `json_schema`; профиль full — ему нужно окно ≥ 24 576 или `profile = "full"` с промптом, который помещается; облачная модель.

---

**M4.5. TUI** · вне оценки: этап вставлен 27.10 (рев. 15)

*Статус: **готово 27.10.2026**. 4541 тест прошёл, 3 пропущены (живые, без `RP_CORE_LIVE`), 0 упали — 4544 теста в 215 файлах; проверка типов чистая. Из них новых 287: 268 в `test/tui/` (15 файлов), 14 в `test/repl/ports.test.ts` и 5 в тестах `/director show` (`test/repl/m4-render.test.ts`, `m4-flows.test.ts`). Решения сборки — D-125…D-139 (§19.10, ждут подтверждения — вопрос 23); заметки — «Примечания к ревизии», ревизия 15.*

*Почему вставлен.* Решение Леви от 27.10: после M4, до M5, — полноэкранный интерфейс в терминале. Слева — текущие модели и горячие клавиши с описаниями. В середине, шире всего, — чат. Справа — агенты и их последние вызовы тулов.

*Содержание.*
- **Команды** `rp-core tui <session>` и `rp-core new --tui` [D-125]. Всё, что умеет REPL, работает и здесь (§12.4.1).
- **Порты REPL** — `src/cli/repl.ts`, новый `src/cli/repl-view.ts`, `src/cli/chat.ts` [D-127]. Это отдельный зелёный шаг без OpenTUI: вывод построчного REPL не изменился ни на байт.
- **Хост** `src/cli/tui/`, 16 файлов: поле ввода как источник строк, клавиши, лента, панели Models и Agents, тема, санитайзер, лог, сигналы [D-128…D-139].
- **Зависимость** `@opentui/core` ровно 0.7.0, `bun.lock` в репозитории; грузит её только путь `tui` [D-126].
- **Тесты** — `test/tui/` на headless-рендерере OpenTUI и `test/repl/ports.test.ts`; правка `test/preload.ts`: `TMPDIR` внутри корня теста [D-133].

*Как строился.*
- Сначала — исследование OpenTUI 0.7.0 с прототипом в настоящем pty. Решения T-1…T-11 записаны до кода (`.notes/tui-decisions.md`).
- Фаза 1 — порты. Фаза 2 — три блока параллельно против общего `src/cli/tui/types.ts`: `host` (запуск, ввод, клавиши, лог), `chat` (лента, поток, SGR, санитайзер), `panes` (Models и Agents). Потом — сборка в одну программу. Контракты блоков — `.notes/tui-contract-*.md`.
- Портированного кода нет.

*Как прошло.*
- **Первый взгляд Леви** — Warp со светлой темой. Текст был белым на белом: OpenTUI рисует текст без заданного цвета ярко-белым (`38;5;15`). Теперь все цвета берутся из терминала (T-12 → D-134).
- **Ревью сборки** — 21 подтверждённая находка, все исправлены (T-13…T-16 → D-135…D-138). Главные:
  - после закрытия терминала (SIGHUP) оставался процесс-сирота: 100 % CPU, и он продлевал lock сессии;
  - строки REPL, сказанные при выходе, и причина выхода пропадали вместе с экраном;
  - continue дописывал карточку выше экрана;
  - сессия на 5 000 сообщений открывалась медленно: лента — 654 мс, теперь 81 мс.
- **Второй взгляд Леви** — Warp и GNOME Terminal в Ubuntu (T-17 → D-139):
  - длинный ввод заезжал на панель Agents;
  - метка ввода была с отступами (`you      ›`);
  - мышь была выключена по умолчанию, терминал превращал колесо в ↑/↓, и колесо двигало курсор в поле ввода;
  - цвета выделения OpenTUI не читались на фиолетовом фоне Ubuntu;
  - `**жирный**` показывался со звёздочками.
- **Третий взгляд Леви** — Warp (тоже D-139):
  - курсив показывался со звёздочками;
  - `/director show` давал директиву сводкой с обрезанными полями; теперь — блок целиком, как его получил рассказчик, и в построчном REPL тоже.
- **pty** (эмулятор pyte): открытие, ответ с рассуждениями, Ctrl+C, Ctrl+R, F2, смена размера 120 → 80, `/quit` — код 0, termios восстановлен. В pty через `Bun.Terminal`: `kill -HUP`, `-QUIT`, `-TERM` → 129, 131, 143; терминал закрыт посреди ответа → 129, частичный ответ сохранён, lock снят.

*Не проверено нами.*
- Сам Warp — его смотрит Леви. Всё остальное — в pty с pyte, который не отвечает на запросы возможностей терминала.
- Ввод через IME и Ctrl+Z (suspend).
- Доходит ли OSC 52 до буфера обмена в каждом терминале. VTE (GNOME Terminal) его игнорирует: там статус так и говорит и предлагает Shift+протягивание.
- macOS и другие версии Bun, кроме 1.3.14.

*Не в v1:* картинки, экран настроек, вопрос «сохранить / отбросить» об отложенном ответе (M6), внешний редактор для `/e`.

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
- **В M3:** ручные заметки Compendium — свёртка `note`/`edit`/`retire`/`restore`, `/memory add|list|show|edit|retire|restore` (§5.8).
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

Пометка «(техн.)» — техническое решение, которое Леви может подтвердить пакетом (вопросы 12, 21, 22 и 23 в §18).

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
| D-90…D-97 | M3: тулы и поиск (рев. 13): запасная модель с другим транспортом, финальный раунд, выбор тулов в два прохода, комната тулов, эхо рассуждений DeepSeek (D-94 пересмотрено после ревью), `normalizeName`, заметка о пропуске и напоминание (при prompted-тулах — со строкой вызова), имя предложенного тула как тег — вызов этого тула. Плюс правка D-59: `C<n>` заметки в тулах — её хэндл `/memory` | см. §19.10 | — | ждут подтверждения (техн.) |
| D-98…D-124 | M4: Story Director (рев. 14): контракт `structuredCall` и поиск `<plan>` сканером M3, параметры вызова, профиль lite/full, состояние на пути — чистая функция `directorAt`, повтор плана на свайпе, доставка и контракт, вход `runDirector`, чтение плана, сопоставление арок, слова ритма, личности, фильтр персоны с русскими правилами, `/director`, `rp-core compact`, уведомления. После первой волны — потолок снимка для любого письма (D-116), хвосты ядра (D-117), отступления блоков (D-118). После ревью и живого прогона — «следует за рассказчиком» значит только соединение и модель (D-119), строка языка в контракте (D-120), запрос всегда в окне и код `no_room` (D-121), узкий `transport_unsupported` (D-122), правки чистого ядра (D-123) и `compact` (D-124) | см. §19.10 | — | ждут подтверждения (техн.) |
| D-125…D-139 | M4.5: TUI (рев. 15): команды `rp-core tui` и `new --tui`, OpenTUI 0.7.0 только на пути `tui`, порты REPL (`LineSource`, `ReplView`), раскладка и панели, клавиши, лента, правка на месте, безопасность терминала, тесты на headless-рендерере и `TMPDIR` тестов, цвета из терминала. После ревью — свои обработчики всех сигналов выхода (D-135), ни одна строка REPL не теряется (D-136), лента как чат (D-137), мелкие правки (D-138). После второго и третьего взгляда Леви — ввод, мышь, выделение, `**жирный**` и `*курсив*` без звёздочек, `/director show` с директивой целиком (D-139) | см. §19.10 и §12.4.1 | только построчный REPL | ждут подтверждения (техн.) |

---

## 17. Риски

1. **Порт тянет за собой сложность (рев. 3).** Код RoleCall и Bunraku решает задачи хоста, которых у ядра нет. Перенос «как есть» раздует ядро и вернёт известные дефекты. *Меры:* правила портирования (§2), карта портирования с вердиктом на каждый модуль, приоритет контракта ядра над паритетом.
2. **AGPL и будущие варианты использования (рев. 3).** Закрытый сервис RoleCall не сможет встроить ядро, не открыв свой код. Сменить лицензию позже можно только с согласия всех авторов, включая авторов портированного кода (Chi, Nemo). *Меры:* решение [D-34] до первых внешних вкладов.
3. **Качество Директора и агентов Compendium на слабых моделях.** Промпты RoleCall настроены под сильные облачные модели, а на локальных 7–14B могут не работать. *Меры:* промпты RoleCall как основа (рев. 3), сессии оценки через record/replay до M4 и M5, lite-профиль, честный сбой. *Рев. 14, живые прогоны M4 (Mag-Mell 12B, lite, tagged, 4 хода):* после D-119 все 5 планов прочитались с первой попытки, но модель не завела ни одной арки — три плана из четырёх не изменили состояния, кроме намерений и директивы. Под английской директивой рассказчик съезжал на английский; после строки языка [D-120] русский держался в 5 ответах из 6. Профиль full, транспорт structured, облачная модель и 30 живых ходов не опробованы (§15).
4. **Prompted-тулы на маленьких локальных моделях ненадёжны:** проза вместо вызовов, битый JSON, протечки шаблонов. *Меры:* проба, цепочка починки, восстановление протечек, финальный раунд, `/search` для человека.
5. **Префилл против тулов.** Пользователи пресетов с префиллом по умолчанию теряют поиск рассказчика [D-28]. *Меры:* видимый `notice`, статус в REPL, переключатель `prefill_vs_tools`.
6. **Одно-слотовые бэкенды.** Вызов Директора или фоновая задача Compendium может выбить KV-кэш рассказчика, и тогда промпт обрабатывается заново целиком. *Меры:* приоритеты и вытеснение; recall заранее (prefetch); задержка фона после хода, чтобы свайп и continue не платили за вытеснение; семафор по origin; пресеты `--cache-ram`, `-np 2` с `id_slot` (M5c), `--smartcache`; отдельное соединение для агентов; прогрев — если замеры M5c покажут нужду (§7.4.7). *Рев. 14, замер ревью (o200k, профиль full, 10-й ход):* у запроса Директора (≈ 15,5 тыс. токенов) и запроса рассказчика (≈ 5,7 тыс.) общий префикс — 5 токенов. Значит, на одном слоте без кэша хоста каждый вызов Директора вытесняет весь KV-кэш рассказчика, а рассказчик — кэш Директора: каждый ход оба промпта обрабатываются заново целиком. Два соседних запроса Директора делят его system (≈ 8,8 тыс. токенов), но на одном слоте между ними стоит рассказчик.
7. **Записи возможностей устаревают.** Быстро меняются правила Anthropic (семплеры, thinking, префилл, forced tools, привязка префикса), подписи Gemini и поля vLLM. *Меры:* данные в файлах, пробы, оверрайды, ошибки, которые называют поле.
8. **Пересечение с Kintsu.** Если Kintsu выйдет первым на `scene-turn`, появятся два headless-протокола, а `--json` у них разный. *Меры:* общие коды выхода и флаги, явный маппинг, ранний разговор Леви с Chi. По решению от 25.10 Леви предупреждает Chi сейчас, демо показывает на M3–M4.
9. **Стык с Bunraku.** Старые сцены теряют состояние Директора и таймеры лора [D-27]; трассу нужно переводить для UI Bunraku; трекеры сверяются только на стороне Bunraku; хуки должны быть fail-closed. *Меры:* решение D-27 до M9, conformance-тесты порта, явный список того, что остаётся у Bunraku (§12.5).
10. **Конвенция ST и буквальные макросы.** Пресеты, настроенные под RoleCall, без конвертера окажутся на сообщение выше, и поведение будет ощущаться иначе, чем в RoleCall.
11. **Рост файла сессии.** Его раздувают снимки Директора (≤ 16 КБ типично, потолок 32 КБ на ответ [D-61]), блоки рассуждений, чекпоинты и `prep`. *Меры:* `rp-core compact`, лимиты состояния; позже — снимки-контрольные точки и SQLite за портом. *Рев. 14, замер:* на 300 подробных русских ходах снимок — медиана ≈ 20–24 КБ, максимум 32 552 байта [D-116], то есть ≈ 6–7 МБ снимков на 300 ответов, и ещё столько же в копиях `prep`. `rp-core compact` убирает только копии в `prep` и строки `chk`; снимки `msg.dir` остаются у каждой версии ответа [D-114].
12. **Неизвестное поведение Bun fetch** при долгом ожидании первого байта: свои таймауты могут убить валидную генерацию или пропустить зависание. Проверяется на M1.
13. **Качество памяти.** Дубли, галлюцинированные факты, разрастание записей. *Меры:* склейка по каноническому имени и алиасам, ключи массивов RoleCall и схлопывание почти-дублей [D-81], NO-WRITE DEFAULT и правило памяти с изменённым убеждением, подавление ещё видимого [D-80], `/memory retire|undo`, уведомление о большой записи; позже — review, reconcile и консолидация записей.
14. **Русская морфология и Unicode.** Лёгкий стемминг даёт ложные совпадения («Мира» и «мир») и пропуски (чередования, супплетивные формы); Turkish İ JS приводит к нижнему регистру неполно. *Меры:* фикстуры `ru`, просьба к модели искать по корням, буквальные фразы в кавычках.
15. **Открытые файлы на диске.** RP-чаты лежат в `~/.rp-core` открытым текстом, и для части сценариев это может быть неприемлемо.
16. **Расползание объёма** против «сознательно простого» ядра. *Меры:* список «позже» в §15 и правило «новая механика только при пользователе в v1».
17. **Compendium на слабых моделях и малых окнах (рев. 6).** Схема из 11 типов и 223 полей рассчитана на сильные модели; слабые выдумывают ключи и значения enum. 30 тысяч токенов снимка — потолок, а не типичный размер (фикстура на 233 записи — 3 741 токен), но в окно 16k не влезает и он. *Меры:* профиль lite — поля 431 токен вместо 620, ростер вместо снимка, шорт-лист вместо дерева [D-79]; терпимое чтение с отбрасыванием поля, а не элемента [D-82]; резерв ответа рассказчика на малом окне [D-89]; оценка на записях qwen3-14b до закрытия M5b. Остаток: мусор в неизвестных полях попадает в рендер.
18. **Задержка до первого токена (рев. 6).** На одно-слотовом бэкенде Директор и фоновые задачи вытесняют KV рассказчика. *Рев. 14:* для Директора вытеснение полное — общий префикс его запроса и запроса рассказчика 5 токенов (риск 6). Во втором живом прогоне M4 (Mag-Mell 12B, lite) вызов Директора на тёплой модели шёл 7,6–8,8 с до ответа рассказчика. Prefetch убирает recall с критического пути, но не повторную обработку промпта рассказчика без кэша хоста (по оценке ≈ 8 с на GPU, ≈ 40 с на CPU). Prefetch не видит сообщения игрока: новую тему без имён он ловит хуже. Фона за ход в lite — ≈ 25 с; если игрок отвечает быстрее, задачи голодают. *Меры:* prefetch с добором упоминаний, ожидание в пределах `graceSec`, задержка фона, семафор по origin, `id_slot` и пресеты бэкендов, уведомления `memory_starved` и `recall_slow`; критерии M5c — выбор prefetch не хуже 0,8 от согласованности двух sync-прогонов и повторная обработка ≤ 1,5 × нового хвоста с кэшем хоста или `-np 2` и `id_slot`.
19. **Локальная модель не тянется к тулам в RP-промпте, даже когда ей говорят (рев. 13).** На первом живом демо M3 ни одна локальная модель не позвала тул: Mag-Mell 12B (prompted) и gemma4:26b (native) отвечали по видимой части чата, как будто это весь чат. Подсказка про тулы стояла только в голове запроса, у Mag-Mell — за ≈ 9 000 токенов до вопроса. Повторные прогоны 27.10 с заметкой о пропуске, напоминанием со строкой вызова и тегом с именем тула [D-96, D-97] тоже не дали ни одного вызова: обе модели отвечали по видимой части и часто выдумывали имя. gemma4:26b в коротком промпте с одним тулом зовёт его через `/v1` Ollama, а в полном RP-промпте решает не искать. Думающая модель к тому же тратит бюджет ответа на рассуждения: при `max_tokens` 300 они заняли у gemma4:26b большую часть ответа, при 1024 вторая попытка ушла в `reasoning_only` [D-31]. *Меры:* recall Compendium до ответа (M5; на локальном origin — prefetch [D-1, D-78]) — путь, который не зависит от решения модели; модели, обученные вызовам тулов (облачная модель, например DeepSeek, — не опробована, нужно согласие Леви на расход); запас `max_tokens` или выключенный thinking для думающих моделей на Ollama; уже сделаны — заметка о пропуске и напоминание [D-96], тег с именем тула как вызов [D-97], детерминированные демо и живой тест `test/live/m3-ollama.test.ts` (`RP_CORE_LIVE=1`).
20. **Эхо рассуждений DeepSeek не проверено вживую (рев. 13).** С тулами DeepSeek требует `reasoning_content` всех прошлых ответов. Ответ без своих рассуждений (приветствие, ответ другой модели, ответ с выключенным thinking) уходит с заглушкой — одним пробелом [D-94]. Что DeepSeek её примет, — ожидание, а не проверка: пустую строку он, по стороннему сообщению, отвергает. Так же вживую не проверена перекладка `reasoning_details` OpenRouter при переименовании id вызова. *Меры:* на 400 `bad_request` в запросе с заглушками — `notice` раз за сессию с выходом `tools = "none"` в `[caps."conn:model"]`; проверка на живом API.
21. **OpenTUI — пакет версии 0.x (рев. 15).** За ним ≈ 350 версий. Ломающие изменения выходят в минорных релизах, однажды — в патче (0.6.7). ScrollBox на `main` уже переписан после 0.7.0 (#1805). Открытые баги 0.7.0 TUI обходит сам: режим 2027 после выхода (#1727), незакрытая вставка (#1270). Нижняя граница Bun у 0.7.0 — 1.3.14, ровно наша. *Меры:* версия закреплена ровно (`0.7.0`, без `^`), `bun.lock` в репозитории; OpenTUI грузит только путь `tui`, так что ядро, `chat`, `send` и библиотека от него не зависят; обновление — отдельным шагом, с `test/tui` и pty.
22. **Нативная библиотека OpenTUI под каждую платформу (рев. 15).** Рендер — `libopentui.so` через `bun:ffi` (на Linux x64 ≈ 5 МБ). Пакеты есть для 8 платформ: darwin x64 и arm64, linux x64 и arm64 (glibc и musl), win32 x64 и arm64. Проверен только Linux x64 (glibc) с Bun 1.3.14. Скриптов установки нет; Bun ставит и glibc-, и musl-вариант. *Меры:* библиотеку грузят только `tui` и `new --tui`; `new --tui` грузит её до создания сессии, поэтому сбой загрузки не оставляет lock; `rp-core chat` работает без неё.
23. **Терминалы ведут себя по-разному (рев. 15).** TUI проверен в pty с эмулятором pyte (он не отвечает на запросы возможностей) и глазами Леви в Warp и GNOME Terminal.
    - Shift+Enter доходит только с протоколом kitty или modifyOtherKeys; запасные — Alt+Enter и Ctrl+J.
    - Warp по-своему считает ширину emoji с ZWJ и оставляет призрачные глифы (opencode#58028). Под `TERM_PROGRAM=WarpTerminal` санитайзер убирает ZWJ, VS16 и тона кожи.
    - VTE (GNOME Terminal) молча игнорирует OSC 52: копирование протягиванием там не работает, а ответа терминала TUI не получает. Поэтому в VTE (по `VTE_VERSION`) TUI ничего не отправляет: статус говорит, что терминал копирование не примет, и предлагает Shift+протягивание; в остальных терминалах он пишет `sent N chars to the clipboard` — «отправлено», а не «скопировано». Доходит ли OSC 52 до буфера в каждом терминале, вживую не проверено.
    - Цвет курсора — фиксированный серый #808080: OpenTUI шлёт его конкретным OSC 12.
    - Не проверены: ввод через IME; Ctrl+Z (OpenTUI не обрабатывает SIGTSTP, #906); часы непрерывного стрима; macOS.

    *Меры:* цвета только из терминала [D-134], запасные клавиши, санитайзер, строка `Shift+drag select` в панели, `rp-core chat` как запасной путь; проверка Леви в Warp.

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
21. **(рев. 13) Решения M3: D-90…D-97 и правка D-59.** Они технические, их можно подтвердить пакетом, как в вопросе 12. Код им уже следует; подробно — §19.10.
    - D-90 — запасная модель с другим транспортом тулов получает свой запрос;
    - D-91 — финальный раунд: `tool_choice:'none'` при объявленных схемах и `FINAL_CUE`;
    - D-92 — тулы предлагаются, только когда нужны: тулы истории — если история срезана, тулы лора — если в лоре есть несработавшая запись;
    - D-93 — комната тулов: четверть промптовой части окна держится свободной;
    - D-94 — эхо рассуждений DeepSeek: свои рассуждения или заглушка-пробел. Пересмотрено после ревью; заглушка вживую не проверена;
    - D-95 — `normalizeName` с NFKC и `ё`→`е`: на ней строятся ключи заметок в журнале;
    - D-96 — заметка о пропуске и напоминание о `search_history`; при prompted-тулах напоминание показывает строку вызова. Заметка и напоминание появились после первого живого демо, вариант со строкой вызова — после второго; это тексты для модели;
    - D-97 — имя предложенного тула как тег (`<search_history>брат</search_history>`) — вызов этого тула. Появилось после второго живого прогона; правила для обёрток, оборванных тегов и пустого тела уточнены после проверки, три принятых прочтения — в §19.10. Риск: будущий тул с коротким бытовым именем (`roll`, `note`) сделает это слово тегом и в прозе;
    - правка D-59 — `C<n>` заметки в тулах совпадает с хэндлом `/memory` и не меняется между ходами.

    Принимаем пакетом? Рекомендация — **принять**. [D-90…D-97, D-59]
22. **(рев. 14) Решения M4: D-98…D-124.** Они технические, их можно подтвердить пакетом, как в вопросах 12 и 21. Код им уже следует; подробно — §19.10. Отдельного взгляда заслуживают пять:
    - D-119 — Директор, который следует за рассказчиком, берёт у него только соединение и модель. Найдено живым прогоном: лимит ответа рассказчика (`--max-tokens 300`) обрезал каждый план;
    - D-120 — строка в контракте: «пиши историю на том языке, на котором она уже написана; ограничения — по-английски только для тебя». Это текст для модели. После неё Mag-Mell 12B держала русский в 5 ответах из 6, а не во всех;
    - D-121 — запрос Директора всегда помещается в окно. На малом окне lite сначала отдаёт историю, потом укорачивает списки. Не помещается и так — код `no_room`: в этом ходу Директор не планирует, ответ приходит;
    - D-116 — потолок снимка 32 КБ держится для любого письма ценой двух последних шагов `fitState`. «≤ 16 КБ типично» (D-61) для русского не достигается: медиана — ≈ 20–24 КБ;
    - D-103 — состояние Директора даёт чистая функция `directorAt`, а не поле `PathView` (§5.11).

    Принимаем пакетом? Рекомендация — **принять**. [D-98…D-124]
23. **(рев. 15) Решения TUI: D-125…D-139.** Их можно подтвердить пакетом, как в вопросах 12, 21 и 22. Код им уже следует; подробно — §19.10 и §12.4.1. Отдельного взгляда заслуживают пять:
    - D-126 — новая рантайм-зависимость `@opentui/core` 0.7.0: версия 0.x, закреплена ровно, с нативной библиотекой под платформу. Её грузят только `rp-core tui` и `new --tui`;
    - D-134 — цвета только из терминала: текст — его цвет по умолчанию, акценты — его палитра ANSI. Светлая и тёмная тема читаются одинаково;
    - D-139 — мышь включена по умолчанию: колесо прокручивает чат, протягивание выделяет и копирует через OSC 52, Shift+протягивание — выделение терминала, F3 выключает мышь. Там же `/director show` печатает директиву целиком — это сознательно меняет вывод построчного REPL;
    - D-131 — `/e` и Ctrl+E правят в поле ввода; `$VISUAL` и `$EDITOR` в TUI не используются;
    - D-125 — не в v1: картинки, экран настроек, вопрос об отложенном ответе (M6), IME, Ctrl+Z.

    Принимаем пакетом? Рекомендация — **принять**. [D-125…D-139]

    И второе: сказать ли Chi о TUI сейчас? В плане Kintsu есть Stage (§12.5), и полноэкранный TUI ядра с ним пересекается. Рекомендация — **сказать** в том же разговоре, где ты предупреждаешь её о rp-core и договариваешься о кодах выхода и флагах [D-14], и показать TUI на демо M3–M4.

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
| `providers/scripted.ts` | fresh | `BR:src/studio/scene-turn.test.ts` `scripted()` (стр. 21–44); `BR:src/stage/provider/test-fetch-harness.ts` (36) — портируется как помощник | Шаги в JSONL, проверка хеша запроса, шаг `{pause}` [D-40]; record/replay с вырезанием секретов — *рев. 12:* в отдельном `providers/record.ts` | M | M1a (script), M2 (record/replay) |

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
| `providers/probe.ts` | adapt | `BR:src/kit/providers/models.ts` (111); `RC:models/fetcher.ts` `parseCapabilities` (стр. 110–135); `RC:providers/tool-call-test.ts` — антипример (forced tool) | Лестница `/models` и разбор ответа (~60 строк) — порт. `/props`, `/api/show`, koboldcpp и активные пробы — новые; *рев. 13:* активные пробы — в отдельном `providers/probe-active.ts`. Проба только советует | M | M1b (каталог), M3 (активные пробы) |

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
| `engine/narrate.ts` | adapt | `BR:src/stage/provider/tool-loop.ts` (176), `src/kit/loop/stop-core.ts` (50). Справочно: `BR:src/kit/loop/loop-core.ts` (454), `RC:ai/narrator-engine/narrator-engine.ts` (1 118). Текст `finalCue`: `RC:ai/visual-novel-prompts.ts` стр. 788–792 | `narrateRounds` по §7.1 — `Promise<RoundsResult>`: каждый раунд — `streamCall` поверх `StreamEv`, текст и вызовы идут колбэками (`onText`, `onTool`). Чтения параллельно через run.ts. Потолок 12 вызовов и защита «3 из 8» (stop-core). Вызовы финального раунда уходят в трассу с `notice`. `empty_response`; abort даёт типизированный результат. Разделитель раундов [D-55]. *Рев. 13:* текст `FINAL_CUE` свой, cue RoleCall не взят [D-91]; комната тулов по раундам [D-93] | M | M1a (скелет без тулов), M3 (раунды) |
| `tools/types.ts` | reference | `BR:tool-loop.ts` стр. 14–45 (`ToolCallRecord`). Справочно: `src/kit/tools/tool.ts` (204), `RC:ai/narrator-engine/types.ts` (512) | По §9.1 плюс `inContext`, `pageChars` и (*рев. 13*) `limit` [D-56]. Запись вызова для трассы — без сырого текста результата | S | M3 |
| `tools/run.ts` | adapt | `BR:tool-loop.ts` стр. 65–81 и 127–164; `src/kit/loop/scheduler.ts` (39). Справочно: `src/kit/loop/dispatch.ts` (144), `RC:ai/narrator-engine/tool-executor.ts` (153) | Результаты в порядке вызовов; `Promise.all` с `ctx.signal`. Неизвестный тул, небезопасное имя и дубли id обрабатываются. Кап результата с пометкой `[cut: …]`; *рев. 13:* комната раунда делится между вызовами до запуска (`ctx.limit`) [D-56, D-93]. Эхо собирается из разобранных аргументов | S | M3 |
| `tools/args.ts` | adapt | `RC:ai/tool-call-repair/index.ts` (338), `layer1-jsonrepair.ts` (161), `layer2-schema.ts` (718, берётся только приведение скаляров), `layer3-validate.ts` (156) | Цепочка по [D-56]. Обязательные поля не заполняются умолчаниями, поля не выбрасываются молча. `schema-parser` и `tokenizer` (657) не берутся | M | M3 |
| `tools/prompted.ts` | port | `RC:ai/prompted-tool-calls/index.ts` (711); обрамление результатов — `RC:ai/btw/loop.ts` стр. 595–700 | Принимает `arguments` и `parameters`; аргументы — через args.ts. Каталог — в блоке ядра; стоп-последовательность `<tool_result`. Вырезатель с состоянием и `end()`, и в стриме тот же fence, что при сохранении. *Рев. 13:* имя предложенного тула как тег — тоже вызов [D-97]; `promptedCallLine` строит и пример блока ядра, и строку вызова в напоминании [D-96] | M | M3 (до M4: его использует tagged-режим Директора) |
| `tools/leaks.ts` | adapt | `BR:src/core/assembly/sanitize.ts` `stripToolCallLeaks` (13); `RC:ai/strip-tool-call-leaks.ts` (63), `dsml-tool-calls.ts` (236), `narrator-engine/content-tool-salvage.ts` (182) | `recoverLeaks(text, {offered, nativeCalls, tools?, keep?})`. Salvage возвращает спаны. Новые парсеры: `[TOOL_REQUEST]`, `[TOOL_CALLS]`, `<function=…>`; с `tools` — и закрытый тег с именем тула [D-97]; спаны внутри `keep` остаются в тексте для вырезателя | M | M1b (только вырезание), M3 (превращение в вызовы) [D-57] |
| `tools/builtin/history.ts` | adapt | `BR:src/studio/dramaturg-tools.ts` (210, Леви); `RC:ai/btw/scene-search.ts` (115), `btw/tools/search-scene-messages.ts` (271), `read-scene-messages.ts` (436) | Работает над `PathView`, ищет только в text-блоках. Сопоставление по основам — новое; фразы в кавычках — буквально. Страницы — по [D-58] | M | M3 |
| `tools/builtin/lore.ts` | adapt | `BR:dramaturg-tools.ts` стр. 122–201 (хэндлы `e3`). Справочно: `RC:ai/dm-stream/tools/executors.ts` стр. 4996–5052 и 4828–4847 | `search_lore` через `lexScore`; хэндлы `L12` на ход и `C<n>` — хэндл `/memory` заметки [D-59, правка рев. 13]; `read_lore` — до 8 000 символов | S | M3 (заметки), M5a (записи Compendium) |
| `text/normalize.ts` | fresh | Определение символа слова — `BR:src/core/lore/engine/key-word-boundary.ts` (35); разбор кавычек справочно — `BR:src/core/search/query.ts` стр. 160–184 | NFKC, lower-case, ё→е; класс слова и стоп-слова [D-46]; ~40 окончаний (*рев. 13:* в коде 55, плюс закрытый список служебных слов — над, вас, тем… — со своей основой); кавычки «…» и “…” | M | M2 (класс символа слова и граница для `lore/keys.ts` [D-46]), M3 (`normalizeTerm`: стоп-слова, окончания, кавычки) |
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

*Рев. 13, по реализации M3.* Сверх строк карты появились пять файлов нового кода: `tools/handles.ts` (хэндлы [D-59]), `tools/builtin/index.ts` (наборы тулов), `prompt/assemble/gap.ts` (заметка о пропуске [D-96]), `providers/probe-active.ts` (активные пробы, §19.4) и `agents/compendium/notes.ts` (заметки как книга лора, §19.7). Фактические источники, коммиты и что изменено — в `PROVENANCE.md`; там `tools/types.ts` записан новым кодом, а не reference.

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
- *Рев. 14 — как построено на M4.* Подробно — §7.2, §7.3 и D-98…D-124 (§19.10). Отличия от этой карты:
  - поиск спанов `<plan>` второй раз не портировался: Директор зовёт сканер M3 `tools/prompted.ts` [D-99]; теги — только `<plan>`, агенты Compendium идут с `tag:null` [D-85];
  - `turnsActive` → возраст — только в трёх местах теневых арок; `turnsActive` у `ForcedArcAction` — «ходы без прогресса», `turnsSinceProgress` [D-117];
  - `runDirector` принимает больше, чем в строке `call.ts` выше, и возвращает `DirectorRun` [D-105];
  - общие типы и константы — `agents/director/types.ts`, слова ритма — `agents/director/mood.ts` [D-109]. Строки `PROVENANCE.md` есть у всех портированных файлов, в том числе у `types.ts`.

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
  - REPL на OpenTUI (*рев. 15:* TUI ядра — новый код прямо на `@opentui/core` 0.7.0, без React и без кода Kit [D-126]);
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

### 19.10 Изменения контракта по итогам порта (D-35…D-139)

*Статус на 27.10:*
- D-35…D-73 приняты: D-61, D-62, D-71 — 25.10, остальные — 26.10 пакетом, D-43 с правкой;
- D-74…D-89 приняты 26.10 (вопросы 16–20);
- D-90…D-97 (сборка M3) и правка D-59 ждут подтверждения (вопрос 21). Правки рев. 13 к D-55, D-56 и D-58 уточняют принятые решения по реализации;
- D-98…D-124 (сборка M4) ждут подтверждения (вопрос 22). D-116 уточняет D-61 (типичный размер снимка), D-107 — D-62 (правила чтения), D-112 — D-65 (граница слова в фильтре персоны), D-119 — D-101 (что значит «следует за рассказчиком»);
- D-125…D-139 (сборка TUI, M4.5) ждут подтверждения (вопрос 23). D-139 уточняет D-125 (выделение мышью есть), D-132 (мышь включена по умолчанию) и D-113 (`/director show` печатает последнюю директиву целиком).

Оценщики предложили эти изменения там, где исходник лучше или проще контракта. Синтез отбросил предложения, которые нарушают обязательные правила документа: глубину ST [D-12], запрет принудительного `tool_choice`, один цикл на все вызовы, хранение в JSONL-дереве и простоту. Статус каждого решения — в списке выше и в его записи. Отдельного внимания требовали D-61 (форма состояния Директора), D-62 (строгость директивы, вместе с D-17) и D-71 (выключенные маркеры ST-пресетов, вместе с вопросом 11); все три приняты 25.10, D-71 — в смешанном варианте.

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
- **Статус (рев. 12, M2).** Реализовано: вердикты пересчитывают `/lore test`, `/trace` (несработавшие записи прошлого ответа), `/preview [n|id] --verdicts` и `rp-core preview --verdicts`. Кроме `fired` и `cut`, трасса держит `lore.unsent` (сработала, но слот не отправляется) и `loreNames` (имя книги по ключу — для таймеров). Запись за пределом рекурсии получает `no-key-match` с `detail.recursionLimit`.

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
- **Правка рев. 13.** По реализации M3 разделитель ленивый: `"\n"` уходит прямо перед первым видимым текстом раунда k > 0 и только если текст хода не кончается пробельным символом; раунд без текста его не шлёт. В хранилище разделитель решается по сохранённому тексту, а не по потоку (`storedSeparator`, `engine/narrate.ts`): спан, который восстановление протечек превратило в вызов, и вырезка шага 9 не склеивают раунды и не оставляют лишний `"\n"` (§6.2, §7.1). REPL не печатает этот перевод строки сразу после строки тула.

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
- **Правка рев. 13.** По реализации M3 у `ToolCtx` есть и третье поле — `limit`: сколько символов может занять результат этого вызова. Его ставит `runTools` до запуска тула:
  - сначала резервируются тексты отклонённых вызовов;
  - остаток комнаты раунда делится по доле на вызов с учётом `maxOutput` каждого тула: недобор одного тула достаётся остальным. Одинаковые вызовы исполняются один раз, но берут долю за каждый;
  - тул с курсором (`next_from`, «More matches») подгоняет вывод под `limit`, поэтому обрезка раннера, которая остаётся страховкой, его не трогает.

  Вне `runTools` поля нет, действует только `maxOutput`. `pageChars` — страница D-58 по окну, но не больше остатка комнаты тулов. `inContext` читает `kept` сборки — id сообщений, чей текст ушёл в запрос.

#### D-57 (§8.3, §6.2 шаг 9, §15)
- **Изменение.** Восстановление протечек делится на две части:
- вырезание обёрток (Hermes `<tool_call>`, DSML, `<function…>`, `<invoke>`) — в постобработке с M1;
- превращение полных вызовов в настоящие — с M3 (`recoverLeaks` в `tools/leaks.ts`, вызовы раунда — `engine/narrate.ts`).
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
- **Правка рев. 13.** По реализации M3 и ревью:
  - `maxOutput` тула — 2 × страница + 1 000 (`PAGE_SLACK_CHARS`): пол в два целых сообщения требует места под два сообщения размером со страницу. Второе сообщение приходит целым, если первое пришло целым, а второе выходит за страницу, но помещается в `limit` без строк пагинации; третьего за страницей нет.
  - Страница — `historyPageChars(окно)` (15 % окна по 3 символа на токен, от 6 000 до 18 000), но не больше остатка комнаты тулов и не больше `limit` [D-56] без строк пагинации. Пол `PAGE_FLOOR_CHARS` (500) действует, пока `limit` это позволяет; ниже страница — то, что `limit` оставляет.
  - Если для начала первого сообщения не остаётся и `READ_MIN_HEAD_CHARS` (100) символов, результат — только курсор: `No room was left in this round to read #n.`, `next_from: n` и запрет утверждать, что диапазон прочитан. Это не ошибка.
  - Тексты для модели английские: скрытое сообщение — `#n (hidden)`.

#### D-59 (§9.2)
- **Изменение.** В вводе и выводе тулов id записей заменяются короткими хэндлами на ход: `L12` для лора, `C<n>` для записей Compendium (ключи записей — §5.8). `read_lore` переводит их обратно по таблице хода.
- **Почему.** Модели портят длинные id. Оба источника пришли к коротким хэндлам: `e<n>` в Bunraku, `toReadableId` в RoleCall.
- **Рекомендация.** Принять.
- **Правка рев. 13 (после ревью M3).** Хэндл заметки — её хэндл `/memory`: `C<n>` по порядку создания всех заметок на пути, живых и списанных, с 1 (`noteRefs`). Он не меняется от хода к ходу, поэтому `C3` в строке поиска и `/memory show C3` — одна заметка. `read_lore` находит `C<n>` любой живой заметки пути, даже если поиск в этом ходу её не показал; списанная заметка свой номер сохраняет, но не читается. `L<n>` записей лора остаётся на ход, по порядку первого появления. Хэндл читается терпимо: NFKC, кавычки и скобки вокруг, любой регистр, кириллическая «С» вместо латинской C; несколько хэндлов в одной строке (`"L1, L2"`) читаются по отдельности.
  - **Почему.** С хэндлами на ход тул и REPL нумеровали заметки по-разному: в строке поиска стояло `C3`, а `/memory show C3` показывал другую заметку.
  - **Статус.** Ждёт подтверждения (вопрос 21).

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
- *Рев. 14.* Потолок держится, цель «≤ 16 КБ типично» для русского текста — нет: прогон на 300 ходов дал медиану ≈ 20–24 КБ. Потолок считается в байтах UTF-8, у `fitState` ещё два шага — D-116.

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
- *Рев. 14.* Правила чтения уточнены при сборке — D-107.

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
- *Рев. 14.* Граница слова — посимвольная, а не lookbehind; русские правила и фикстуры сделаны — D-112.

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
- **Статус (рев. 12, M2).** Реализовано. `wi_format` к outlet не применяется — как в ST: там `formatWorldInfo` оборачивает только before/after, а макрос outlet отдаёт записи как есть. В экспортах RoleCall шаблоны форматов, `new_chat_prompt` и `new_example_chat_prompt` остаются в `extras` без применения: RoleCall их не применял.

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
- **Уточнение (рев. 12, M2).** Выключенный маркер персоны в экспорте RoleCall остаётся выключенным, а блок персоны RoleCall ставится после `main`. Отсутствующий `chatHistory` синтезируется; выключенный или без ссылки — включается на месте, тоже с предупреждением.

#### D-72 (§4, §10.5, §12.4)
- **Изменение.** Новый модуль `formats/import.ts` и команда `rp-core import <файл> [--as имя]`. В REPL импорт идёт через `/lore add <файл>` и `new --card`.

**Порядок распознавания:**
1. PNG-карточка;
2. JSON CC;
3. ST-пресет — *рев. 12:* только chat-completion; шаблоны text-completion, instruct и context отклоняются с причиной;
4. ST WI с объектом entries;
5. отдельный character_book;
6. иначе — отказ с причиной.

**Чтение:** файл пробуется как есть, затем как двойной JSON, затем как конверт экспорта.

**Запись:** атомарно в `library/<вид>/<canonicalId(name)>.json`; `canonicalId` — NFKC и `\p{L}\p{N}`. *Рев. 12:* id пресета `builtin` зарезервирован за встроенным пресетом, такой файл сохраняется как `builtin-2`.
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
- **Решение.** Резерв ответа рассказчика на малом окне (§11): `min(maxTokens ?? (window < 24 576 ? 2 048 : 8 192), window / 2)`, если `max_tokens` не задан привязкой или пресетом. Для окна 16 384 это оставляет истории ≥ 5 000 токенов при полной доле лора и слоте пересказов (§7.4.6; с рев. 12 доля лора считается от окна минус резерв, и истории остаётся ≥ 5 500). Если на историю остаётся меньше 25 % окна — `notice{history_crowded}` раз за сессию.
- **Рекомендация.** Принять. Рассуждающей модели на малом окне `max_tokens` стоит задать явно.
- **Альтернативы.** Оставить 8 192: на окне 16k на голову, лор, блок Compendium, слот и историю остаётся 8 192, и истории почти нет. Резерв 4 096: истории ≈ 3 000 токенов, 4–5 обменов. Урезать долю лора на малом окне вместо резерва.
- **Статус.** Принято 26.10 пакетом (вопросы 19–20).

#### Решения M3: тулы и поиск

*Приняты при сборке M3 (`.notes/m3-decisions.md`); D-94 пересмотрено после ревью, D-96 добавлено после первого живого демо и дополнено после второго (при prompted-тулах напоминание показывает строку вызова), D-97 добавлено после второго. Код им уже следует. Подтверждаются пакетом — вопрос 21.*

#### D-90
- **Решение.** Запасная модель с другим транспортом тулов. Повтор и запасная модель оборачивают весь цикл раундов и срабатывают, только пока ход ничего не выдал (§6.6).
- Если `caps.tools` запасной модели не такой, как у основной, запрос для неё собирается заново: `buildRequest` с запасной моделью вместо основной, на том же виде пути, seed и часах. С пересмотром D-94 запрос пересобирается и тогда, когда ход предлагает тулы, а правило эха рассуждений у двух моделей разное.
- Иначе запрос основной только приводится под запасную модель, как на M2.
- Строка `prep` не переписывается: в ней остаётся запрос основной.
- Если свой запрос запасной модели не собирается (например, её окно мало), ход завершается сбоем основной модели.
- **Рекомендация.** Принять. Блок ядра зависит от транспорта: у prompted в нём каталог и формат `<tool_call>`, у native — только протокол, а схемы уходят полем запроса. Чужой запрос, приведённый под другую модель, дал бы ей не тот протокол.
- **Альтернативы.** Только приводить запрос основной, как на M2: модель с prompted получила бы блок ядра без каталога. Запасная модель без тулов: поиск пропадает в том самом ходе, где основная упала.
- **Статус.** Ждёт подтверждения (вопрос 21).

#### D-91
- **Решение.** Финальный раунд.
- Запрос идёт с `toolChoice: 'none'`, схемы тулов остаются в `ModelRequest` (§7.1). Адаптер openai-chat снимает их сам, если `caps.toolChoiceHonored = false`: Ollama позвала бы тул и при `none`. Это решение адаптера по записи возможностей, а не цикла.
- На каждом финальном раунде после раунда тулов добавляется `FINAL_CUE` (`engine/narrate.ts`): у native — отдельным сообщением (`system`, если `caps.midSystem` — `native` или `anthropic-native`, иначе `user`; src `core:final_cue`), у prompted — в конце user-сообщения с результатами. Текст cue RoleCall для визуальной новеллы не используется.
- Раунд финальный, если тулов нет, достигнут `maxRounds` (не больше 8 [D-55]), это двенадцатый вызов модели в ходе (`CALL_CEILING`; повтор и запасная модель считаются), сработала защита от зацикливания или комнаты тулов осталось меньше `MIN_ROOM_TOKENS` (256 токенов). Цикл, который запускал тулы, всегда заканчивается финальным раундом.
- Вызовы на финальном раунде (модель не послушала `none`) не исполняются и не хранятся блоками: строки `trace.tools` с отказом `final_round`, `notice{tool_calls_on_final_round}` раз за сессию, finish `max_rounds`. Видимый текст раунда сохраняется.
- **Рекомендация.** Принять. Так устроен `tool-loop.ts` Bunraku, только он молча выбрасывал вызовы финального раунда. Gemini отвергает tool-сообщения без схем (§7.1), поэтому схемы снимаются лишь там, где сервер всё равно не слушает `tool_choice`.
- **Альтернативы.** Cue только при `toolChoiceHonored = false`, как в тексте §7.1 рев. 2. Снимать схемы на финальном раунде везде. Исполнять вызовы финального раунда — тогда у цикла нет предела.
- **Статус.** Ждёт подтверждения (вопрос 21).

#### D-92
- **Решение.** Тулы выбираются на каждый ход, в два прохода сборки.
- Проход A собирает запрос без тулов — байт в байт как на M2.
- `search_history` и `read_history` предлагаются вместе, если проход A срезал историю. `search_lore` и `read_lore` — если в лоре хода (персона, карточка, заметки, книги сессии) есть включённая запись или живая заметка, которая в проходе A не сработала.
- На continue и при `caps.tools = 'none'` тулов нет. Если предложить нечего, запрос хода — проход A.
- Иначе проход B собирает запрос со схемами. Если правило префилла [D-28] выключило тулы, запрос — проход B без них. Если блок ядра не помещается или комната тулов [D-93] меньше `MIN_ROOM_TOKENS`, запрос — проход A.
- *Правка после ревью.* Проход B резервирует комнату и блок ядра, поэтому может срезать историю, которую проход A оставил. Тогда к набору добавляются тулы истории, и проход B собирается ещё раз. Если так не помещается (малое окно), пробуются тулы истории без тулов лора: при срезанной истории читать её важнее. Берётся первый вариант, где тулы сохранились и комната не меньше `MIN_ROOM_TOKENS`; иначе остаётся первый проход B.
- `preview` строит запрос той же функцией `buildRequest`.
- **Рекомендация.** Принять. Без тулов запрос, трасса и сохранённые блоки остаются как на M2: golden-снимки, паритет и хеши скриптовых запросов не меняются. Тулы стоят блока ядра и четверти промптовой части окна [D-93]; если история видна целиком и весь лор сработал, эта цена ничего не даёт. Остаток: на окнах 2 048–2 560 (o200k, встроенные тулы) даже тулы истории без лора оставляют комнату меньше `MIN_ROOM_TOKENS`, и остаётся первый проход B — с тулами лора и без заметки о пропуске [D-96].
- **Альтернативы.** Предлагать все четыре тула всегда: блок ядра и комната в каждом запросе, и запрос без нужды в тулах уже не равен M2. Решать только по проходу A: в полосе, где историю срезает сам проход B, тулы истории не предлагались (находка ревью).
- **Статус.** Ждёт подтверждения (вопрос 21).

#### D-93
- **Решение.** Комната тулов. Когда тулы предлагаются, `assemble` держит свободными `toolRoom(окно, резерв) = round(0,25 × (окно − резерв))` токенов (`TOOL_SHARE`, `prompt/budget.ts`) и для этого срезает больше истории.
- Блок ядра и, у native, JSON схем считаются в фиксированной части.
- Если защищённые сообщения оставляют меньше полной комнаты, комната — то, что осталось; приветствие уходит, только когда не осталось ничего.
- `AssembleResult.toolRoom` — комната (0 без тулов), `kept` — id сообщений пути, чей текст ушёл в запрос (для пометки `(in context)`).
- Цикл тратит комнату по раундам. До запуска тулов из неё вычитаются собственное сообщение раунда (текст, свои рассуждения при эхе, эхо вызовов), оболочка сообщения с результатами и cue на случай финального раунда; результатам достаётся остаток. Если осталось меньше `MIN_ROOM_TOKENS`, следующий раунд финальный.
- Если раунд всё же добавил больше, чем вмещала комната (например, длинный текст перед вызовом), следующие раунды просят `max_tokens` меньше на превышение (`roundMaxTokens`): промпт плюс `max_tokens` остаётся в окне. Раунд 0 и ход без тулов шлют резерв целиком, как на M2.
- С настоящим счётчиком (o200k) пачка, чьи результаты по токенам вышли за остаток больше чем на max(10 %, 2 токена на вызов), запускается ещё раз в комнате, уменьшенной в той же пропорции. Тулы v1 только читают, поэтому повтор безопасен.
- Результат, которому не хватило места даже на пометку обрезки, приходит как `[cut: no room was left for this result]`, а не пустым.
- **Рекомендация.** Принять. Внутри хода запрос не пересобирается, раунды только дописываются (§7.1), поэтому место под вызовы, результаты и текст между раундами резервируется заранее.
- **Альтернативы.** Без резерва: тулам остаётся только то, что история случайно не заняла. Пересобирать запрос между раундами — против §7.1.
- **Статус.** Ждёт подтверждения (вопрос 21).

#### D-94
- **Решение (пересмотрено после ревью).** Эхо рассуждений DeepSeek. С тулами DeepSeek требует `reasoning_content` всех прошлых ходов, иначе 400 (документация DeepSeek).
- Правило действует, когда у модели `caps.reasoning.echo = 'all-with-tools'`, тулы уходят native (или в запросе уже есть вызов тула) и thinking в этом вызове включён — то есть не `reasoning 'none'` при `canDisable`.
- Тогда каждое assistant-сообщение запроса несёт `reasoning_content`: свои сырые рассуждения того же соединения и модели, если они есть, иначе заглушку — один пробел (`ECHO_PLACEHOLDER`, `openai-chat.ts`).
- Если thinking выключен, ничего не повторяется и запрос не пересобирается. Запасная модель с другим правилом получает свой запрос [D-90].
- Если провайдер всё же отверг запрос с заглушками ответом 400 `bad_request`, приходит `notice{caps.suggest}` раз за сессию с выходом: `tools = "none"` в `[caps."conn:model"]`.
- **Рекомендация.** Принять. Первый план — выключить thinking на ход, если у прошлого ответа нет рассуждений этой модели, а без `canDisable` снять тулы — не сходился: ответ, написанный без thinking, рассуждений не имеет, и следующий ход с тулами снова выключал thinking, до конца чата. Исключение для приветствия и так ставило каждый ход DeepSeek с тулами на заглушку: приветствие карточки есть почти в каждом чате. Заглушка вживую не проверена (пустую строку DeepSeek, по стороннему сообщению, отвергает), и README говорит об этом прямо.
- **Альтернативы.** Первый план: thinking выключен или тулы сняты на ход — не сходится. Тулы DeepSeek выключены всегда. Пустая строка вместо пробела, как в SillyTavern.
- **Статус.** Ждёт подтверждения (вопрос 21).

#### D-95
- **Решение.** `normalizeName` (`agents/compendium/apply.ts`) — порт функции Bunraku (`relationships.ts:39`) с названной правкой: сначала NFKC, после lower-case `ё`→`е`, в классе символов имени сохраняется `\p{M}` [D-46], имя без букв и цифр даёт `''`. Остальное как в Bunraku: lower-case без локали, всё, что не буква, цифра, знак или пробел, становится пробелом, пробелы схлопываются, края обрезаются.
- Ключ заметки — `note:<normalizeName(заголовок при создании)>`. Если ключ уже занят любой записью, включая списанные, к нему добавляется `#2`, `#3`…
- **Рекомендация.** Принять. Ключи заметок, построенные ею, хранятся в строках `mem`, поэтому правка порта записана решением. С ней «Ёж», «ёж» и «Еж» — одна заметка, а знак ударения внутри имени не режет его на два слова.
- **Альтернативы.** Порт как есть: «Ёж» и «Еж» дали бы две заметки, а ударение резало бы имя. `normalizeTerm` вместо `normalizeName`: стемминг склеил бы «Мира» и «Мир».
- **Статус.** Ждёт подтверждения (вопрос 21).

#### D-96
- **Решение.** Заметка о пропуске и напоминание. Если предложены оба тула истории [D-92] и запрос пропускает отрезок сообщений, в запросе появляются два system-сообщения.
1. **Заметка о пропуске** (src `core:gap`) стоит в чате прямо перед первым сообщением, отправленным после пропуска: `[Messages #A–#B of this chat are not shown here. search_history finds what was said in them; read_history shows them in full.]`. A и B — номера тулов истории: позиции на пути с 1, скрытые сообщения считаются. При A = B — форма единственного числа: `[Message #A of this chat is not shown here. search_history finds what was said in it; read_history shows it in full.]`. Заметка стоит там, где запрос и так меняется при сдвиге обрезки, поэтому кэшированный префикс не страдает. Она считается в фиксированной части по худшей ширине чисел и не срезается; глубины вставок считаются только по сообщениям чата.
2. **Напоминание** (src `core:remind`) стоит на глубине 0 после всех остальных вставок глубины 0: `(Part of this chat is hidden from you. If your reply depends on a detail from it — a name, a place, a promise, who said what — look it up with search_history before you write. If it does not, just write the reply.)`. Это текст для native-тулов (`REMIND_TEXT`). *Дополнено после второго живого прогона:* при prompted-тулах напоминание показывает сам вызов (`REMIND_TEXT_PROMPTED`): `(Part of this chat is hidden from you. If your reply depends on a detail from it — a name, a place, a promise, who said what — look it up before you write. Write the call on a line of its own, then stop:`, с новой строки `<tool_call>{"name": "search_history", "args": {"query": "one or two key words"}}</tool_call>`, с новой строки `If it does not, just write the reply.)`. Строку вызова и пример в блоке ядра строит одна функция — `promptedCallLine` (`tools/prompted.ts`; `gap.ts` её импортирует), поэтому разойтись они не могут; `test/prompt-m3/remind-prompted.test.ts` проверяет, что парсер читает из напоминания ровно один вызов `search_history`. Вариант выбирается по транспорту хода (`remindText`, `prompt/assemble/gap.ts`), фиксированная часть меряет тот, что уходит. Для одного транспорта текст постоянный и стоит в конце чата, поэтому кэш он не ломает. Блоки пресета после истории (post-history и т. п.) идут после него, как после любой вставки глубины 0.

Без тулов или только с тулами лора их нет, и запрос остаётся как на M2. На continue тулы не предлагаются, поэтому нет и их. Место под оба сообщения резервируется, как только предложены тулы истории; если история в итоге поместилась целиком, они не отправляются.
- **Рекомендация.** Принять. На первом живом демо (`docs/M3-DEMO.md`) обе локальные модели отвечали по видимой части чата, как будто это весь чат: запрос нигде не говорил, что история срезана, а подсказка про тулы стояла только в голове, у Mag-Mell — за ≈ 9 000 токенов до вопроса. Это тексты для модели, поэтому они английские и детерминированные. Второй прогон, уже с этими текстами, тоже не дал вызова: в одной из трёх попыток Mag-Mell (prompted) написала тег с именем тула, `<search_history>…</search_history>`, с выдуманным результатом внутри, а пример формата по-прежнему стоял только в голове. Тот же запрос, отправленный в Ollama вручную с напоминанием со строкой вызова, дал один вызов в нужном формате (незакрытый) из трёх; с текстом D-96 — ни одного. Прогоны после дополнения (Mag-Mell, prompted; gemma4:26b, native) тоже не дали вызова: заметка и напоминание вызова не гарантируют («Примечания к ревизии», п. 43; риск 19).
- **Альтернативы.** Назвать пропуск в блоке ядра, как предлагал `docs/M3-DEMO.md`: блок ядра стоит в кэшированной голове, и номера отрезка сбрасывали бы кэш с головы. Напоминание последним сообщением всего запроса, после post-history-блоков пресета.
- **Статус.** Ждёт подтверждения (вопрос 21).

#### D-97
- **Решение.** Имя предложенного тула как тег — вызов этого тула. Это ещё один диалект к D-57. В раунде с предложенными тулами `<NAME …>BODY</NAME>`, где NAME — имя предложенного тула, — один вызов NAME (`tools/prompted.ts`).
- Тег читается, как остальные: имя в любом регистре, пробелы после `<`, атрибуты (не читаются), префикс `ns:`. Незакрытый тег в конце текста или перед следующим открывающим тегом — как незакрытый `<tool_call>`.
- BODY — JSON-объект: конверт `{"name": NAME, "args"|"arguments"|"parameters": {…}}` даёт свои аргументы, любой другой объект и есть аргументы.
- Иначе, если у схемы тула ровно одно обязательное поле и оно строковое, обрезанный BODY — значение этого поля (`query` у `search_history`).
- Иначе вызов нечитаемый и уходит модели ошибкой, как любой нечитаемый prompted-вызов.
- Тег разбирается, исполняется и вырезается из потока и из сохранённого текста там же, где блок `<tool_call>`: в prompted-раунде и в native-раунде без нативных вызовов (восстановление протечек, затем prompted-разбор). В native-раунде закрытый тег, ставший вызовом, убирает потоковый вырезатель (`recoverLeaks` с `keep`): хранится то же, что стримилось, и в счёт `tool_markup_stripped` тег не входит. Финальный раунд вырезает тег, не исполняя, и считает в `tool_markup_stripped`.
- Имена, которых нет среди предложенных, тегами не бывают: ход без тулов байт в байт как на M2, а теги прозы (`<i>`, `<br>`, `<search>`) не трогаются. Тул с именем тега-обёртки (`tool_call`, `tool_calls`, `tool_result`) тегом не становится: обёртка сохраняет своё значение.
- *Уточнено после проверки.* Пустой незакрытый блок или тег, который закончил открывающий тег следующего вызова, — обёртка, разметка без вызова: `<tool_call><search_history>брат</search_history></tool_call>` — один вызов, `'<search_history>'.repeat(3000)` — один оборванный. Тег семейства, оборванный концом текста после значения вызова (`<search_hi` за `{…}`), — часть вызова: вызов оборван, на экран ничего не выходит; после текстового тела такой тег уходит с блоком, а запросом остаётся текст. Fence, открытый внутри тега вокруг текста, кончается своей закрывающей строкой, а незакрытый — там, где кончается блок: концом текста или следующим открывающим тегом.
- *Прочтения, принятые при проверке:*
  1. вызов блоком `<tool_call>` или тегом на финальном раунде даёт два уведомления: `tool_calls_on_final_round` о вызове и `tool_markup_stripped` о скрытой разметке;
  2. незакрытое текстовое тело (после ведущего слова `json`, если оно есть) — первая строка, если ниже есть ещё текст: запрос — одна строка, рассказ идёт ниже;
  3. пустой BODY закрытого или самозакрывающегося тега — вызов без аргументов у любого тула; чего не хватает, модели скажет проверка аргументов. Пустой тег, оборванный концом текста, — оборванный вызов.
- **Рекомендация.** Принять. Во втором живом прогоне Mag-Mell (prompted) вместо вызова написала `<search_history>…</search_history>` с выдуманным результатом внутри [D-96]. Такой тег однозначен: его имя — имя тула из этого же запроса.
- **Риск.** Будущий тул с коротким бытовым именем (`roll`, `note`) сделает это слово тегом и в прозе. У тулов v1 в именах есть `_`.
- **Альтернативы.** Оставить такой тег прозой и полагаться только на напоминание со строкой вызова [D-96]. Считать тегом любое имя, похожее на тул: `<search>` или `<i>` в прозе стали бы вызовами.
- **Статус.** Ждёт подтверждения (вопрос 21).

#### Решения M4: Story Director

*Приняты при сборке M4 (`.notes/m4-decisions.md`, разделы B–H). D-98…D-115 — до сборки; D-116…D-118 — после первой волны, по открытым вопросам блоков; D-119…D-124 — после ревью сборки и первого живого прогона. Код им уже следует. Подтверждаются пакетом — вопрос 22.*

*Уточнения текста без своих номеров (раздел A заметки):*
- §19.6 «спаны тега для `<plan>` и `<memory>`» — только `<plan>`: агенты Compendium идут с `tag:null` [D-85];
- §19.6 «`turnsActive` (7 мест) → возраст» — возраст только в трёх местах теневых арок; у `ForcedArcAction` это «ходы без прогресса», `turnsSinceProgress`;
- `DIRECTOR_HEADER` — `[DIRECTOR CONSTRAINTS - BINDING THIS TURN]` с дефисом, одна константа для контракта и директивы;
- потолок снимка 32 КБ — в байтах UTF-8 от `JSON.stringify(state)`; Bunraku считал символы UTF-16;
- `PathView.directorAt(msgId)` (§5.11) — чистая функция `directorAt(tree, fromId)` [D-103].

#### D-98
- **Решение.** Контракт `structuredCall` (`agents/structured.ts`) — как в §7.2 рев. 14.
- Вход: агент, схема `{name, schema}`, `read(raw) → ReadResult`, system, список user-сообщений, тег, маршрут, транспорт, семплеры, рассуждения, `maxTokens`, `count?`, `repair`, префикс callKey, бюджет, сигнал хода, окружение вызова. Результат несёт `attempts` и строки `calls` для `trace.calls`.
- Транспорт выбирает вызывающий: `chooseTransport(caps)` — `structured`, только если `json_schema` подтверждён (`confirmedBy`), иначе `tagged`. На M4 есть только openai-chat.
- Один вызов — один `streamCall` с `agent` и, в structured, `responseSchema`; без тулов и префилла. Текст и рассуждения собираются молча.
- Чтение: видимый текст без think-тегов (при `answerInReasoning` — рассуждения) → поиск JSON (`<plan>` — D-99; `tag:null` — fence, иначе первый целый объект) → `looseJson` → корень не объект — `undecodable` → `read()`. В видимом тексте ничего, а рассуждения не пусты — тот же поиск в них: исход `ok_reasoning` [D-60].
- Коды чтения: ничего — `no_output`; найдено, но не читается, в том числе оборвано `finish:'length'`, — `undecodable`; `read()` отказал — его код.
- Корректирующий проход (при `repair`) — один, только после ошибки чтения. Эхо — видимый текст, иначе рассуждения, до 1 000 символов; «(no text)», если оба пусты. Итог — исход последней попытки.
- Ошибки провайдера — только общий повтор §6.6: один, до вывода, на `isRetryable`, через `retryDelayMs` (≤ 8 с). Обе попытки — в `attempts`. Своего повтора и запасной модели у агентов в v1 нет; это отступление от «или в привязке роли» §6.6.
- Бюджет агента обрывает сигнал с причиной `budget:director` — `timeout`; другой обрыв — `aborted`; таймаут первого байта или простоя самого вызова — `timeout`.
- **Рекомендация.** Принять. Один помощник служит Директору и трём агентам Compendium. Коды и журнал попыток дают трассе то, что Bunraku доставал регулярками из текста ошибки.
- **Альтернативы.** Свой повтор агента, как в Bunraku: 429 дал бы три отправки. Молча переходить на tagged после отказа structured — против D-15 и D-60.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-99
- **Решение.** Ответ Директора в tagged ищет сканер M3: `parsePromptedCalls(text, [{name:'plan'}, {name:'commit_planning_round'}])` (`tools/prompted.ts`, теги с именем [D-97] и `<tool_call>`). Второго порта поиска спанов из RoleCall нет.
- План — первый блок без ошибки с именем `plan` или `commit_planning_round`. Конверт `{"name": …, "arguments" | "args": {…}}` внутри разворачивается на один уровень. Следующие блоки — `skipped {path:'plan', why:'extra block'}`.
- Блоки с ошибкой до плана (упоминание `<plan>` в прозе) пропускаются. Хорошего блока нет: оборванный или битый блок — `undecodable`.
- Тега нет вовсе: объект в fence, иначе первый целый объект, — только если в корне есть `directive` (текстовый путь RoleCall). Иначе `no_output`.
- Сканер используется как есть; сигнатуры M3 не меняются.
- Тексты коррекции — свои, английские: для tagged — «Your answer had no usable plan (<reason>). Answer again with exactly one <plan>…</plan> block that holds one JSON object following the schema above, with a directive that sets at least one field. Write nothing else.»; для structured — короче, без тега. `<reason>` — постоянная фраза по коду или сообщение `read()`, обрезанное до 200 символов.
- *Уточнено D-117 (конверт на обоих транспортах, безымянный `<tool_call>`, запасной объект с `directive`) и D-123 (пустой блок — не план).*
- **Рекомендация.** Принять. Сканер M3 уже читает теги с именем, обёртки, fence и оборванные блоки, и у него есть тесты. Модели, обученные на RoleCall, пишут и `<plan>`, и вызов `commit_planning_round`.
- **Альтернативы.** Свой регексп тега, как в Bunraku. Отдельный порт `findToolCallSpans` из RoleCall (§19.6, рев. 4) — второй код для той же разметки.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-100
- **Решение.** «Черновик чтения ответа filing» на M4b — тест: `structuredCall` с `tag:null` и схемой-конвертом `{filings:[{type, entry}]}` через тестовый `read()`. Он проверяет fence, голый объект, починку битого JSON и отсутствие коррекции при `repair:false` (`test/structured/filing-draft.test.ts`). Кода filing в `src` нет — он на M5b.
- **Рекомендация.** Принять. Черновик нужен, чтобы `structuredCall` сразу годился для второй схемы. Тест это проверяет и не заводит код раньше вехи.
- **Альтернативы.** Читатель filing в `src` уже на M4 — код без вызывающего до M5b.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-101
- **Решение.** Параметры вызова Директора.
- Привязка — `roles.director ?? 'narrator'`. Разрешается в теле хода, а не при приёме: нет соединения или ошибка записи возможностей — `DirectorRecord{ok:false, code:'no_connection'}`, не отказ хода. `--provider` действует и на Директора. `binding.fallback` не используется. *Что значит `'narrator'` — D-119.*
- Температура — `binding.samplers.temperature ?? 0,7`. Остальные семплеры — только привязки: семплеры пресета не наследуются. Чего модель не принимает, отбросит адаптер.
- Рассуждения — `binding.reasoning`; иначе `'none'`, если `caps.reasoning.canDisable`; иначе `'low'`, если модель принимает уровень; иначе не задаются. Тип `ModelRequest.reasoning` не меняется: `'minimal'` на M4 не добавлен.
- Окно — своё: `contextWindow({caps, local, configWindow})` маршрута Директора. `preset.maxContext` — окно рассказчика.
- `maxTokens`: full — `min(16 384, окно − промпт, caps.maxOutput, binding.maxTokens)`; lite — 1 500 и ещё 1 024, если вызов думает (рассуждения не выключаются), под теми же ограничениями. Нижняя граница — D-121.
- Бюджет — `director.timeoutSec ?? таймаут первого байта + 60 с`: 660 с локально, 180 с удалённо. Отсчёт — с первого места в семафоре: `streamCall` получил необязательный `onSlot`. Коррекция и повтор — в том же бюджете.
- Вызовы Директора (до 4: вызов, повтор, коррекция, повтор) входят в `callsBefore` рассказчика: `CALL_CEILING` 12 считает весь ход. callKey — `${turnId}:director:${n}`.
- Учёт: строки `trace.calls` (агент `director`, модель `conn:model`) и `trace.agents.director = {status, code?, transport?}`; `gen.usage` — только рассказчика. `/usage` считает строки других агентов по их собственной модели.
- **Рекомендация.** Принять. У Директора своё окно, свой вывод и свой бюджет; ход от него не падает.
- **Альтернативы.** Наследовать семплеры пресета — пресет настроен под прозу рассказчика. Отсчёт бюджета со старта — очередь на одном слоте съела бы его до вызова.
- **Статус.** Ждёт подтверждения (вопрос 22). *Уточнено D-119 и D-121.*

#### D-102
- **Решение.** Профиль lite или full выбирается в `runDirector` до вызова.
- `director.profile = 'lite'` — lite.
- `'full'` на окне < 16 384 — lite и `notice{director_lite}` раз за сессию.
- `'auto'` — lite, если окно < 24 576 (`SMALL_WINDOW`) или если полный промпт (system, user с историей на 25 % окна, давления; счётчик сессии без EMA) вместе с 4 096 токенами вывода не помещается в окно.
- Lite — новый сжатый system (≈ 60 строк, написан на M4), дайджест личности, `PLAN_SCHEMA_LITE`, история на 10 % окна, без Shadow World и давления скрытых арок.
- *Рев. 14, D-121:* проверка «промпт + 4 096» действует и для явного `'full'`; тогда тоже `director_lite`.
- **Рекомендация.** Принять. Так §7.3 рев. 6, с порогом Compendium [D-79].
- **Альтернативы.** Профиль только по окну, без проверки промпта: full на окне 24k с длинной историей не помещался бы.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-103
- **Решение.** Состояние на пути — чистая функция `directorAt(tree, fromId)` в `agents/director/state.ts`. `PathView` остаётся данными (его сериализует M6); метод `PathView.directorAt` из §5.11 не заводится.
- Функция идёт по `parent` от `fromId` включительно и берёт `dir.state` первого ответа ассистента, чей `dir` принимает `checkRecord` и у которого `reducer === 1`. Удачные и проваленные записи несут состояние одинаково.
- Скрытые ответы считаются: скрытие убирает текст, а не историю плана.
- Нечитаемый `dir` пропускается (берётся следующий предок), движок шлёт `notice{director_state_invalid}` раз за сессию.
- Такого ответа нет — `emptyState()`: значения Bunraku, ход 0, `nextId` 1, mood `ambient`, ритм 0/0.
- Вызывающие: ход передаёт U (для свайпа — родителя заменяемого ответа), `/director show` — голову. Ходы — ходы Директора: пока он выключен, счётчик стоит (так задумано).
- **Рекомендация.** Принять. Свёртка — одна функция на дереве, без кэша и без поля, которое M6 пришлось бы сериализовать.
- **Альтернативы.** Метод `PathView.directorAt` (§5.11 рев. 2): `PathView` перестаёт быть данными.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-104
- **Решение.** Записи Директора на пути.
- Запись несут `prep.dir` и `dir` тела коммита. Stopped-коммит с частичным текстом — тоже: директива этот текст формировала (паритет с Bunraku). Проваленный ход ничего не коммитит. Continue `dir` не пишет: у цели остаётся свой.
- Повтор на свайпе [D-29]: `kind = 'swipe'`, `onSwipe = 'reuse'`, указания нет, `dir.ok` заменяемого ответа — `true`. Тогда вызова нет. Запись — копия с `attempts: []` и `reusedFrom: replaced.dir.reusedFrom ?? replacedId`. Фильтр персоны прогоняется заново на скопированной директиве с сегодняшними именами; его пропуски — `skipped` копии. Событие — `director{status:'reused'}`, `trace.agents.director.status = 'reused'`.
- Иначе — нет `dir`, план провалился, есть указание, `onSwipe = 'replan'` — новый план от `directorAt(U)`.
- Guided re-roll: указание — ещё одна строка в разделе 6 user-промпта: «The player asked for a new version of the last answer: <указание>».
- **Рекомендация.** Принять. Обе версии ответа выросли из одного состояния на U, поэтому копия корректна. Фильтр с сегодняшними именами нужен, если персону переименовали между ходами.
- **Альтернативы.** Хранить на stopped-коммите только текст — его директива потерялась бы для трассы и `/preview --turn`. Копировать `skipped` оригинала — пропуски чтения относятся к другому вызову.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-105
- **Решение.** Вход и порядок `runDirector` (`agents/director/call.ts`).
- Вход: дерево, вид пути на U, `upTo` (U), `kind: 'reply' | 'swipe'`, `replaced?`, `guidance?`, конфиг сессии, персона `{name, description?, aliases?}`, имя карточки, маршрут (`null` — нет соединения), привязка, счётчик токенов, `turnId`, сигнал хода, окружение вызова, `worldSnapshot?` (M5a; без него раздела нет), `emit` и `notice(key, notice)`. Окно считается внутри, по маршруту.
- Результат — `DirectorRun {record, calls, agent}`: ходу нужны строки `trace.calls` и строка `trace.agents`.
- Порядок: (проверка повтора) → `directorAt(U)` → ход + 1 → импульс → профиль → промпты → `structuredCall` с `readPlan` внутри `read` → `applyPlan` (авторская директива — в `state.lastDirective`) → `enrichFromMomentum` → фильтр персоны → `fitState` → запись.
- Сбой: директивы нет, состояние — `fitState({...prev, turn})`, `ok:false` и код. Текст ошибки провайдера не хранится: только категория и HTTP-статус.
- События: `planning` при старте вызова, затем `planned{summary}`, `failed{reason: код}` или `reused{summary}`. `summary` — короткая английская строка, только ненулевые части: `arcs +1 ~2 · seeds +1 -1 · hidden +1 · chapter 2`; `chapter N` — когда началась глава. Формат дополнен в D-123.
- *Исправляет §19.6:* сигнатура `runDirector(view, cfg, binding, caps, kind, signal)` там слишком узкая.
- **Рекомендация.** Принять. Всё, что Директору нужно от хода, передаётся явно; окно зависит от маршрута, поэтому считается внутри.
- **Альтернативы.** Возвращать голую запись — ходу пришлось бы восстанавливать строки трассы и строку агента.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-106
- **Решение.** Доставка директивы и контракта.
- Директива — `{depth:1, role:'system', src:'director', text: renderDirective(directive)}` в `placements`. Пустой рендер не ставится. `{{slot::director}}` в v1 пуст: пресет директиву пока не двигает.
- Контракт: пока `director.enabled`, блок ядра несёт контракт (`NARRATOR_AUTHORITY` и строка «never act, speak or decide for <имя персоны>») на любом виде хода — reply, swipe, continue, сбой плана. Голова промпта не меняется.
- `AssembleInput.contract?: string`. Блок ядра = контракт + протокол и каталог тулов; его src — `core:tools`, если тулы предложены (с контрактом или без), и `core:director`, если в нём только контракт. Каждая проверка `core !== null` в `assemble.ts`, которая значила «тулы предложены», стала `tools.length > 0`.
- С выключенным Директором запросы байт в байт как на M3: golden-снимки, паритет, хеши.
- Continue: вызова нет; запрос повторяет на глубине 1 сохранённую `dir.directive` цели, если она есть, — как recall повторяет свой выбор.
- Preview: следующий ответ — контракт и заглушка на глубине 1 (`[DIRECTOR CONSTRAINTS - BINDING THIS TURN]`, «(the Director plans this when the turn runs)», `[/DIRECTOR CONSTRAINTS]`). Свайп, который повторит план, — повторённая директива. `preview({turn})` рендерит сохранённую директиву того ответа, поэтому `/trace` и `/preview --turn` совпадают с отправленным.
- **Рекомендация.** Принять. Голова стабильна при любом исходе плана. Продолжение пишется под теми же ограничениями, что и его цель.
- **Альтернативы.** Контракт только вместе с директивой, как в Bunraku: на сбойных ходах ломается кэш головы. Continue без директивы — продолжение теряет ограничения своей цели.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-107
- **Решение.** Чтение плана (`readPlan`, D-62 и матрица терпимости RoleCall).
- Регистр значений перечислений правится молча; `horizon` вида `X-term` — `X`. Алиасы значений и неизвестные значения выбрасывают поле в `skipped`. Неизвестные ключи — в `skipped`. `null` — поля нет.
- Секция строкой — через `looseJson`, иначе `skipped`. `analysis` строкой — `whatHappened` (JSON-строка сначала разбирается). Нет `chapterUpdate` — `{action:'none', title:''}`.
- Семя без допустимого `action` — `skipped`, не `'reinforce'`. Ключ обновления арки — `arcId`, `id` или `title` (первый непустой); все пусты — `skipped`. `arcDirection` без допустимого `urgency` — `'moderate'`.
- `tension_level` строкой — число, зажатое в 0..10, иначе поле выбрасывается. `targetTurn` строкой из цифр — число, иначе выбрасывается. Плохой элемент списка уходит в `skipped` один, директива целиком — никогда.
- Содержательная директива — по D-62: непустое mood, narrativeGoal, arcDirections, characterBeats, callbacks, include (с непустым списком), dialogueGuidance, endingHook, avoid (с непустым списком), sceneGuidance (с заданным полем) или явно присланный `pacing ≠ 'medium'`. Нет ничего — `missing_directive`.
- Лимиты: ≤ 40 записей на секцию; ≤ 12 элементов в списке директивы (lite: 3 arcDirections, 3 characterBeats, 2 callbacks); намерений читается до 10 (lite — 3), хранится 5; текст ≤ 300 на поле, заголовок арки ≤ 80. `skipped` — до 20 записей, дальше `{path:'skipped', why:'+N more'}`.
- План в рассуждениях `readPlan` сам не ищет — это делает `structuredCall` [D-98]. Умолчания намерений — из `readAnalysis` Bunraku.
- *Уточняет D-62 и текст §7.3 «Чтение плана»:* секция строкой разбирается `looseJson` (единственный вход `jsonrepair`), семя без `action` уходит в `skipped`, обрезки и зажатия тоже пишутся в `skipped`.
- **Рекомендация.** Принять. Плохое поле не валит план, а каждое отступление видно в трассе.
- **Альтернативы.** Строгое чтение — маленькая модель каждый ход шла бы в корректирующий проход. Подстановки RoleCall (`neutral` mood, `reinforce` у семени) — выдуманные данные.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-108
- **Решение.** Сопоставление арок и заголовки (паритет с RoleCall `find-arc-match.ts`, `arc-title-sanitizer.ts`).
- Шаги: (1) точный id; (2) равные ключи сопоставления; (3) ≥ 2 общих значимых токена, которые покрывают не меньше половины значимых токенов более короткого заголовка.
- Токены — основы `wordsOf(title)` длиннее двух символов, без `DIRECTOR_STOP`: стоп-слова D-46 плюс служебные слова Директора, английские и русские. Сам `STOP_WORDS` не меняется. Пустой ключ не совпадает ни с чем. Все 19 векторов vvs-264 дают прежний результат.
- `cleanTitle` — шаги Bunraku, удаление заикания и срез эха `arc-N`. Правил hex-слагов нет: они резали «Dead» и «Cafe».
- Этап не добавляется, если совпадает с последним этапом после `foldText`. Семена — по id или свёрнутому `hint`; скрытые арки — по id или ключу; улики — без учёта регистра.
- *Уточнено D-123:* эхо id в селекторе.
- **Рекомендация.** Принять. Правило токенов проверено векторами vvs-264, а основы `normalizeTerm` дают его и для русского.
- **Альтернативы.** Сравнение Bunraku через `[^a-z0-9]` стирает кириллицу, и русские арки дублируются.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-109
- **Решение.** Слова ритма. Mood переводится в ритм по словам — основам `wordsOf` [D-63]:
  - action — action, fight, chase, battle, combat, бой, драка, погоня, схватка, битва, сражение;
  - quiet — calm, quiet, reflective, intimate, aftermath, peaceful, спокойствие, спокойный, тихий, тишина, размышление, близость;
  - climax — climax, кульминация;
  - tense — tense, tension, напряжение, напряжённый, тревога, тревожный.
- Данные — `MOOD_WORDS` и `moodKinds(mood)` в `agents/director/mood.ts`; их читают редьюсер (счётчики ритма) и импульс (сигналы ритма). Пороги прежние: 8 / 12 / 4.
- **Рекомендация.** Принять. Bunraku сравнивал весь mood целиком с `action`, `climax`, `calm`: «tense, watchful» никогда не был tense, а русский mood не совпадал ни с чем.
- **Альтернативы.** Просить модель выбирать mood из списка — пришлось бы менять портированные промпты и личности.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-110
- **Решение.** Входы промпта.
- История — видимые (не скрытые) сообщения пути до U, только текстовые блоки [D-16], с приветствием; новейшие 30 в пределах 25 % окна Директора (lite — 10 %); самое старое из не поместившихся режется посередине. Пустые по тексту сообщения не входят. Сам U стоит только в разделе 6.
- Самопроверка — если `state.lastDirective?.turn === state.turn` (прошлый ход Директора планировал) и родитель U — ответ ассистента. Проза — его текст, 2 400 символов начала и конца.
- Макросы: `{{user}}` — имя персоны (без персоны — «the player», и блока персоны нет); `{{char}}` — имя карточки; других нет. `director.instructions` идут как есть. Персона с одним именем тоже получает правила о персонаже игрока — Bunraku требовал описание.
- Правила описания тула из `plan-round.ts` (`:14-23`) переходят в system на обоих транспортах (`PLAN_RULES`). Tagged добавляет схему и «How to answer», structured шлёт схему в запросе. Схема в tagged — компактный JSON (full или lite).
- **Рекомендация.** Принять. Тула больше нет, а его правила нужны модели на обоих транспортах.
- **Альтернативы.** Раскрывать все макросы ядра — текст Директора зависел бы от переменных и seed хода.
- **Статус.** Ждёт подтверждения (вопрос 22). *Уточнено D-123:* самопроверка пропускает скрытый ответ.

#### D-111
- **Решение.** Личности — копия Bunraku (12 файлов) как есть, плюс названные правки текста:
  - weaver (STAGE 9) и oracle (строка 291) указывают на `invisibleArcUpdates` с `surfaceCondition` вместо characterSecrets, worldState, coreMemories и revealCondition — этих полей в ядре нет;
  - осиротевшая строка 315 у architect убрана.
- Ключи вне схемы в примерах личностей остаются: они уходят в `skipped`. Карта алиасов ждёт Chi.
- По умолчанию и для неизвестного id — `the-balanced` (Sage).
- **Рекомендация.** Принять. Тексты проверены в продакшене; правки убирают ссылки на поля, которых в ядре нет.
- **Альтернативы.** Переписать примеры под схему без Chi.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-112
- **Решение.** Фильтр персоны `sanitizeForPlayerCharacter(directive, names)`; `names` — имя персоны и алиасы.
- Убирает биты и реплики персоны, персону из `include.characters` (опустевший список теряет ключ), arcDirections, callbacks и биты, которые утверждают её внутреннее состояние. `endingHook` и `narrativeGoal` не фильтруются. Каждое удаление — `skipped {why:'persona'}`.
- Граница слова — посимвольная проверка кодовой точки до и после имени (`isLoreWordChar`, `[\p{L}\p{N}\p{M}_]`, как в `text/normalize.ts`), а не lookbehind по `\p{…}`: в Bun он ошибается на суррогатных парах (рев. 12).
- Русский список: глаголы внутреннего состояния после имени в именительном, слова состояния вроде «кажется» — после дательного, до трёх слов-наполнителей, притяжательное «мысли Елисея». Английские правила — как в Bunraku.
- Русские фикстуры обязательны: `test/fixtures/ru/director-persona.json`.
- *Исправляет §7.3 «Фильтр персоны» и D-65:* там записан lookbehind `(?<![\p{L}\p{N}_])`.
- **Рекомендация.** Принять. Без русского списка фильтр пропускал бы «Елисей решает» в русской истории.
- **Альтернативы.** Только английский список, как в источниках. Морфологический разбор — зависимость и сложность ради одного фильтра.
- **Статус.** Ждёт подтверждения (вопрос 22). Известные пропуски — «Примечания к ревизии», п. 54.

#### D-113
- **Решение.** Директор в CLI.
- REPL: `/director` (= `show`), `/director show`, `/director on`, `/director off` (`configure({director:{enabled}})`). `show` печатает состояние на голове: ход и последний итог (planned, reused, failed с кодом), главу (текущую и число завершённых), арки (заголовок, статус, приоритет, горизонт, возраст, следующий бит), семена (hint, возраст, подкрепления, ripe и OVERDUE), скрытые арки (заголовок, статус, улики), намерения и сводку последней директивы. Пустое состояние — «The Director has not planned yet.»
- *Изменено D-139:* вместо сводки — последняя директива целиком, как её получил рассказчик (§12.4).
- `/help` его показывает; строка M3 «Later: /director (M4)» убрана.
- One-shot `send` в текстовом режиме пишет в stderr `⋯ director: planned — <summary>`, `failed (<код>)` или `reused`, как строки тулов.
- Баннер — `director <conn:model> (<profile>)`, пока Директор включён.
- **Рекомендация.** Принять. Человеку нужен один взгляд на план, а скрипту — строка итога.
- **Альтернативы.** `/director edit` — вместе с `dirEdit`, позже.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-114
- **Решение.** `rp-core compact <session> [--json]`. Открывает сессию через движок (восстановление отрабатывает), берёт lock, отказывает при открытом или отложенном ходе (код 5, `turn_open`). Затем переписывает журнал без строк `chk` и `prep` закрытых ходов: временный файл → fsync → rename → fsync каталога. Номера `seq` сохраняются, поэтому версии не меняются. Печатает `compacted <id>: <before> → <after> bytes`.
- Снимки `msg.dir` остаются (риск 11: контрольные точки — позже).
- *Ужесточено D-124.*
- **Рекомендация.** Принять. Строки `chk` и `prep` закрытых ходов читает только восстановление после краша.
- **Альтернативы.** Убирать и снимки `msg.dir` у старых версий — тогда свайп и откат к ним теряют состояние Директора.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-115
- **Решение.** Уведомления Директора — раз за сессию каждое, через общий шлюз уведомлений сессии:
  - `director_lite` (info) — явный full на малом окне или полный промпт не помещается;
  - `director_state_invalid` (warn) — на пути есть нечитаемая запись;
  - `caps.suggest` (warn) — сервер отверг structured.
- *Дополнено D-121:* `director_no_room` (warn) и `context_truncated_by_server` для промптов Директора.
- **Рекомендация.** Принять. Каждое называет причину и выход.
- **Альтернативы.** Уведомление на каждом ходу — шум.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-116
- **Решение.** Потолок снимка держится для любого письма. «Шаг 5 всегда укладывает» (§7.3) неверно для кириллицы (2 байта на символ) и CJK (3): подробный русский планировщик за 300 ходов держал 287 из 300 состояний выше 32 КБ.
- `fitState` получает ещё два шага, только пока состояние выше потолка:
  - 6 — каждый текст модели до 120 символов (и до 240 байт UTF-8, чтобы уложился и CJK); улик — 1; главы — только текущая; рабочие наборы — 8 арок, 10 семян, 4 скрытые арки. Заголовки арок не режутся: это ключи сопоставления;
  - 7 — `lastDirective` убирается; следующий ход идёт без самопроверки.
- `fit:over-cap` остаётся для состояния, которое и после шага 7 выше потолка: так бывает только с элементами человека, в v1 их нет.
- `checkState` больше не ограничивает весь JSON двумя потолками: каждая строка — до 2 000 кодовых точек, весь JSON — до 4 × потолка. Ядро не отвергает состояние, которое само записало.
- Замер — `test/demo-m4/three-hundred.test.ts`: каждый снимок ≤ 32 768 байт; медиана ≈ 20 КБ (директива на всех лимитах) и ≈ 24 КБ (обычная), максимум 32 552 байта; худший синтетический случай после шага 7 — ≈ 28 КБ (CJK).
- *Уточняет D-61:* потолок 32 КБ держится, цель «≤ 16 КБ типично» для русского текста — нет (под 16 КБ — 4 и 0 снимков из 300).
- **Рекомендация.** Принять. Потолок нужен свёртке на 10k сообщений; текст и `lastDirective` — то, чем дешевле всего пожертвовать.
- **Альтернативы.** Поднять потолок до 64 КБ — отклонено в D-61. Оставить `fit:over-cap` — тогда `checkState` отвергал бы записанное, и Директор планировал бы от старого предка.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-117
- **Решение.** Хвосты чистого ядра после первой волны.
- Импульс: `turnsSinceProgress = turn − (lastProgressTurn ?? createdAtTurn)`. Хода отсрочки нет.
- `enrichFromMomentum`: имя считается названным только целым словом (цепочкой основ), равенством после свёртки или по id. Сырого сравнения подстрокой нет: «Art» не назван в «The Party».
- `structuredCall`: конверт `{name: 'plan' | 'commit_planning_round', arguments | args: {…}}` разворачивается на обоих транспортах до `read`; безымянный `<tool_call>` с объектом, в корне которого `directive`, — план; если у всех блоков ошибка, целый объект с `directive` в fence или в тексте всё равно берётся.
- Директор записывает `invalid` из `structuredCall` как `undecodable`.
- `skipped` записи — пропуски чтения, редьюсера, фильтра и `fitState`, в этом порядке, под одним лимитом `READ_LIMITS.skipped` (20) и `{path:'skipped', why:'+N more'}`.
- Схема: `responseSchema.name = 'director_plan'`. В tagged — компактный JSON `PLAN_SCHEMA` (full) или `PLAN_SCHEMA_LITE` без ключей `description` (lite: 2 622 символа, ≈ 640 токенов o200k вместо 7 997 символов и ≈ 1 770 токенов). Structured шлёт схему с описаниями.
- `DirectorRecord` в `entries.ts` — реэкспорт типа из `agents/director/types.ts`; страж строки остаётся `anyObj`; любое чтение `dir` идёт через `checkRecord`.
- *Исправляет §7.3:* правило «хода отсрочки» в таблице импульса и «сравнение подстрокой» у enrich.
- **Рекомендация.** Принять. Каждая правка закрывает вопрос, который блок первой волны оставил открытым.
- **Альтернативы.** Правило отсрочки Bunraku (`?? turn`): арка без прогресса никогда не застаивается. Подстрока: одна буква в arcName глушит почти все добавления.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-118
- **Решение.** Отступления блоков, принятые при сборке (подробно — `.notes/m4-contract-*.md`):
  - state — рабочие наборы сохраняют порядок списка; `lastPlantTurn` заполняется при вытеснении; неизвестные ключи `checkState` выбрасывает;
  - plan — `arcType` есть в полной схеме обновления арки; нехранимые поля скрытой арки в схему не входят; обрезки текста пишутся в `skipped`;
  - reduce — `start_new` отклоняется, только пока текущая глава `active` и моложе 3 ходов; глава без заголовка — «Chapter N»; тот же mood — тот же набор основ; climax тоже ставит `lastActionSequence`;
  - momentum — защиты ритма Bunraku (`> 0`) сохранены; давление посадки — от большего из `lastPlantTurn` и новейшего семени;
  - prompt — вход `rhythm` берётся из `report.rhythm`; арки отсортированы по `lastProgressTurn ?? createdAtTurn`;
  - render — русское правило внутреннего состояния по падежу (именительный для глаголов, дательный для слов вроде «кажется»), до трёх слов-наполнителей;
  - structured — think-теги вырезаются до чтения; при строгом чередовании user-сообщения склеиваются.
- **Рекомендация.** Принять. Каждое отступление записано блоком с причиной и покрыто тестом.
- **Альтернативы.** Буквальный текст заметки там, где блок нашёл ошибку источника.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-119
- **Решение.** «Следует за рассказчиком» — то же соединение и та же модель, и ничего больше. `roles.director` не задан или равен `'narrator'` — Директор берёт у привязки рассказчика только `conn` и `model`: не `maxTokens`, не `samplers`, не `reasoning`, не `fallback`. Это настройки ответа рассказчика. Явная привязка Директора сохраняет все свои поля (они — по D-101).
- Найдено живым прогоном 27.10: `rp-core new --max-tokens 300` ограничил каждый план 300 токенами → `finish:'length'` → `undecodable` на 4 планах из 6; ещё один прошёл только корректирующим проходом.
- *Исправляет D-101* в части «`binding.maxTokens` ограничивает» для этого случая.
- **Рекомендация.** Принять. После правки все 5 планов второго прогона прочитались с первой попытки.
- **Альтернативы.** Брать привязку целиком, но без `maxTokens` — тогда семплеры прозы рассказчика шли бы в планировщик.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-120
- **Решение.** Рассказчик держит язык истории. В контракте после строки о персоне — строка `LANGUAGE_LINE`: «Write the story in the language it is already written in; these constraints are in English only for you.»
- Найдено живым прогоном: Mag-Mell 12B начала мешать английский в русскую историю с первой английской директивы.
- **Рекомендация.** Принять. Это текст для модели и постоянная строка, так что кэш головы не ломается. Во втором прогоне русский держался в 5 ответах из 6: строка помогает, но не лечит 12B-модель.
- **Альтернативы.** Директива на языке истории — нужен перевод или многоязычные промпты. Ничего не делать.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-121
- **Решение.** Запрос Директора всегда помещается в его окно — и в lite, и в full.
  1. Резерв вывода: full — 4 096 (проверка D-102); lite — 1 500 (+1 024, если рассуждения не выключаются). Место под промпт — окно минус резерв.
  2. Промпт больше места — lite сжимается и собирается заново: сначала история — 0; затем показ состояния с лимитами lite — 8 арок, 10 семян, 0 скрытых, 2 этапа на арку; вне показа — элементы с самым старым прогрессом, «(+N more…)». Full сначала уходит в lite (D-102), в том числе явный `'full'`, чей промпт с 4 096 не помещается (`notice{director_lite}`).
  3. `maxTokens = min(нужное, окно − промпт, caps.maxOutput, явный binding.maxTokens)`. Если окно минус промпт меньше 600, ничего не отправляется: `DirectorRecord{ok:false, code:'no_room'}` (новый код) и `notice{director_no_room}` раз за сессию.
  4. Корректирующий проход снижает `maxTokens` на эхо и текст коррекции (`StructuredInput.count`); ниже 600 он не идёт, и остаётся код первой попытки.
  5. Вызовы Директора проходят проверку обрезки сервером, как рассказчик: `notice{context_truncated_by_server}` раз за сессию.
- Отступление сборки: граница 600 проверяется по месту в окне. `caps.maxOutput` и явный лимит привязки только ограничивают `max_tokens` — такой лимит пользователь выбрал сам.
- Найдено ревью: lite на окне 4 096 слал промпт и `max_tokens` больше окна (4,5–5,6 тыс. токенов), и Ollama молча резала промпт, теряя начало system; явный full на окне 16k давал `max_tokens` 858, 288 и даже 1 — меньше одного плана.
- **Рекомендация.** Принять. Честный `no_room` лучше плана, у которого сервер отрезал правила. Замер — §7.3 «Окно».
- **Альтернативы.** Отправлять как есть и полагаться на сервер — молчаливая обрезка. Резать system — модель теряет правила и схему.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-122
- **Решение.** `transport_unsupported` — узкий код: только structured-попытка, отвергнутая HTTP 400 `bad_request` до любого вывода. 400 после текста или рассуждений, или помеченный адаптером `afterOutput`, — `provider_error`, без `notice{caps.suggest}`. Любой другой 400 — тоже `provider_error`.
- Найдено ревью: сервер, который уже начал отвечать по схеме (vLLM может прислать 400 посреди потока), не отвергал `response_format`, а совет выключить structured был бы ложным.
- **Рекомендация.** Принять. Остаток: 400 `bad_request` до вывода по другой причине — например, `max_tokens` больше лимита облачной модели без `caps.maxOutput` — всё ещё читается как отказ structured.
- **Альтернативы.** Читать текст ошибки сервера — у разных серверов он разный, а ядро текст ошибок не хранит.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-123
- **Решение.** Правки ревью в чистом ядре.
- `checkState` читает `relatedArcId` семени терпимо: строка 1..2 000 символов остаётся, иное выбрасывается; состояние не отвергается. `applyPlan` сводит `relatedArcId` через сопоставление арок к id арки; неизвестная арка — поле не хранится, запись в `skipped`.
- Каждый хранимый текст проходит лимиты длины, поэтому `checkState(fitState(applyPlan(…)))` — всегда состояние. Это проверяет property-тест на случайных планах (`test/director/state-roundtrip.test.ts`: 8 случайных прогонов по 60 ходов).
- Селектор с эхом id (`[arc-1] The Lighthouse`, `arc-1: Маяк`, `hidden-2 …`) находит эту арку, если такой id есть, иначе — по очищенному заголовку. Новые скрытые арки тоже получают очищенный заголовок.
- Номера ходов — безопасные целые: читатель плана выбрасывает остальные, читатель состояния выбрасывает плохой `targetTurn`, а не отвергает состояние.
- Пустой `<plan></plan>` или вызов плана без аргументов — не «хороший блок»: поиск идёт дальше.
- Самопроверка пропускает скрытый родительский ответ.
- `summaryOf` считает и подкреплённые семена (`seeds ~N`), и скрытые арки с новой уликой, этапом или статусом (`hidden ~N`): план, который сделал только это, не выглядит как «no changes».
- **Рекомендация.** Принять. До правки `relatedArcId` длиннее 80 символов или `targetTurn` 1e20 делали запись нечитаемой, и следующий ход планировал от старого состояния. Эхо id плодило дубли арок. Пустой блок тратил корректирующий проход.
- **Альтернативы.** Строгий `checkState` с починкой при записи — тогда журналы старой сборки оставались бы нечитаемыми.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### D-124
- **Решение.** `compact` ужесточён.
- Перед rename compact проверяет, что lock всё ещё его, а журнал — тот же файл (dev/ino) того же размера, что при чтении; сборка сверяет и mtime. Иначе удаляет временный файл и отказывает (`session_locked`).
- Переписанный файл читатель должен принять строка в строку как исходный минус убранные строки. Строку, удаление которой сделало бы принятой пропущенную читателем строку, compact оставляет (`kept`).
- Временный файл создаётся с правами 0600 и получает режим журнала; mtime журнала сохраняется.
- Если восстановление на шаге 1 отложило черновик (событие `recovered` с `draft`), compact останавливается до переписывания: черновик показывается первым, отказ — `draft_recovered`. С `--json` события восстановления идут в stderr строками JSON.
- **Рекомендация.** Принять. Ревью показало: строки, которые дописал другой процесс, пока compact стоял дольше TTL lock, терялись; журнал с правами 0600 становился 0644; `rp-core sessions` переупорядочивался.
- **Альтернативы.** Продлевать lock во время compact — повторная проверка перед rename и так отказывает при украденном lock.
- **Статус.** Ждёт подтверждения (вопрос 22).

#### Решения M4.5: TUI

*Приняты при сборке TUI (`.notes/tui-decisions.md`, T-1…T-17). T-1…T-11 — до кода; T-12 — после первого взгляда Леви в Warp; T-13…T-16 — после ревью сборки; T-17 — после второго взгляда Леви. Код им уже следует. Подтверждаются пакетом — вопрос 23. Контракты блоков и их отступления — `.notes/tui-contract-*.md`.*

*Соответствие:* D-125 — T-1; D-126 — T-2; D-127 — T-3; D-128 — T-4, T-5 и T-8; D-129 — T-6; D-130 — T-7; D-131 — T-9; D-132 — T-10; D-133 — T-11; D-134 — T-12; D-135 — T-13; D-136 — T-14; D-137 — T-15; D-138 — T-16; D-139 — T-17.

#### D-125
- **Решение.** Команды и объём TUI.
- `rp-core tui <session> [--provider …]` — флаги те же, что у `chat`. Нужен терминал на stdin и stdout; иначе код 64 и строка `rp-core tui needs a terminal; use rp-core chat`. Проверка идёт до загрузки OpenTUI.
- `rp-core new --tui` открывает новую сессию в TUI. Вместе с `--json` или `--no-chat` — ошибка использования. Без терминала — код 64 до создания сессии. Строка о том, как открыть сессию снова, называет `rp-core tui <id>`.
- `rp-core chat` остаётся построчным REPL по умолчанию и не меняется: скрипты, пайпы, `--provider script:`.
- В TUI работает всё, что умеет REPL: каждая команда `/…`, удержанные строки, отказы во время хода, правила Ctrl+C, `/open`, `/fork`, `/e` (на месте, D-131).
- Не в v1: картинки, экран настроек, вопрос «сохранить / отбросить» об отложенном ответе (M6), гарантии для IME, Ctrl+Z.
- *Уточнено D-139:* выделение мышью в TUI есть; в T-1 его не было.
- **Рекомендация.** Принять. Человек видит модели и агентов рядом с чатом, а построчный REPL остаётся для скриптов и CI.
- **Альтернативы.** Сделать TUI режимом `rp-core chat` — сломались бы пайпы и `--provider script:`. TUI отдельным пакетом — второй код тех же правил.
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-126
- **Решение.** Библиотека — `@opentui/core`, ровно `0.7.0` (без `^`); `bun.lock` в репозитории. Лицензия MIT. Пир `web-tree-sitter`, который Bun ставит вместе с ним, мы не импортируем.
- Нативная часть — `libopentui.so` через `bun:ffi`; пакеты под 8 платформ. Скриптов установки нет.
- OpenTUI грузит только путь `tui`: `main.ts` делает `await import('./tui/index.ts')` для `rp-core tui` и `new --tui`. Другие команды, библиотека `rp-core` и тесты вне `test/tui` его не загружают. `src/cli/tui/types.ts` берёт из OpenTUI только типы.
- `new --tui` загружает модуль до создания сессии: если он не загрузился, lock не остаётся.
- Портированного кода нет. REPL Kit на OpenTUI и React не портируется (§19.9): TUI ядра написан заново на императивном API.
- **Рекомендация.** Принять. Прототип в настоящем pty проверил всё, что нужно трём колонкам: раскладку, поток в прилипающую ленту, ввод с кириллицей, emoji и CJK, свой Ctrl+C, восстановление терминала и headless-тесты.
- **Альтернативы.** Свой рендер на ANSI — раскладку, поле ввода, прокрутку и ширины пришлось бы писать самим. Плавающая версия `^0.7.0` — у OpenTUI ломающие изменения выходят и в минорных релизах, однажды — в патче (0.6.7).
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-127
- **Решение.** TUI ведёт тот же `Repl` через два порта (`src/cli/repl.ts`, новый `src/cli/repl-view.ts`).
- Ввод — `ReplOptions.source: {source: LineSource, interrupts: InterruptSource}`. Он сильнее `deps.input`, `deps.onInterrupt` и readline. У `LineSource` новые поля: `inline` (своя строка ввода: REPL ставит метку через `prompt` и подставляет текст для `/e`), `multiline` (настоящие переводы строк вместо `⏎`) и режим `prompt(text, 'line' | 'edit')`.
- Вывод — `ReplOptions.view`, фабрика `ReplView`: `line`, `echo`, `message`, `banner`, `turn` → `TurnView`, `status`, `idle`. По умолчанию — `LineView`: прежние `Screen` и `TurnPrinter`. `bannerInfo()` вынесен из приветствия: сессия, конфиг, журнал, привязки рассказчика и Директора, окно, транспорт тулов — данные для панелей.
- `ReplOptions.command: 'chat' | 'tui'` — какую команду называют подсказки REPL (`--debug`, `/probe --active --write`). По умолчанию — `chat`.
- `chat.ts`: `runChat` разбит на `chatDeps`, `onChatTerm` и `endChat`; поведение `runChat` прежнее.
- Фаза 1 — отдельный зелёный шаг без OpenTUI: вывод построчного REPL байт в байт прежний, ни один старый тест не менялся.
- **Рекомендация.** Принять. Одна логика REPL на два экрана: команды, удержание строк и правила Ctrl+C не дублируются.
- **Альтернативы.** Свой REPL внутри TUI — второй код тех же правил. TUI поверх `--stdio` — протокола нет до M6.
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-128
- **Решение.** Раскладка и боковые панели.
- Строка из трёх колонок: Models — 28, не сжимается; Chat — остаток, не меньше 40; Agents — 36. Рамки одинарные, заголовки ` Models `, ` Chat `, ` Agents `: подписи английские, как весь CLI.
- От 120 колонок — все три; от 90 до 119 — чат и Agents; меньше 90 — только чат. F2 прячет боковые панели; второе F2 возвращает те, что помещаются по ширине.
- Колонка чата: лента (ScrollBox, прилипает к низу), строка статуса и строка ввода — метка и поле. Поле растёт от 1 до 6 строк.
- Models: сессия (название не повторяется, если совпадает с именем персонажа), персонаж и персона; рассказчик — `conn:model`, окно, транспорт тулов (native, prompted, off), `(script)` или `(recording)` под `--provider`; Директор — off или `conn:model` (с «follows narrator»), профиль последнего плана и стиль; затем клавиши. Данные — из `bannerInfo()`: при открытии, при смене сессии и на `idle()`.
- Agents:
  - рассказчик — состояние (idle, waiting, thinking N chars, writing, тул, retry), 6 последних вызовов тулов, новые сверху, с длительностью по `ts` событий, итог последнего ответа (токены, секунды, finish, раунды, транспорт);
  - Директор — off, planning…, planned или reused со сводкой, failed с кодом; по записи на голове (`directorAt`) — ход, профиль, транспорт, модель, попытки, глава, живые арки, семена к сроку;
  - агенты M5 — по блоку на имя из события `agent`;
  - внизу — итог по пути из `pathUsage`: вызовы, токены, цена.
- Каждое событие хода панель Agents получает через `TurnView`. `memory` и `changed` уровня сессии — из `engine.events()` по id текущей сессии и только вне хода.
- Строки панелей не переносятся: они обрезаются по колонкам терминала с «…».
- **Рекомендация.** Принять. Так попросила Леви: модели и клавиши слева, чат шире всего в середине, агенты справа. На узком терминале остаётся главное — чат.
- **Альтернативы.** Три колонки при любой ширине — на 80 колонках чату не хватит места. Вкладки вместо колонок — агентов не видно во время ответа.
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-129
- **Решение.** Горячие клавиши — таблица в §12.4.1. Список один: `HOTKEYS` в `src/cli/tui/types.ts`, строки для показа — `keyRows`. По нему работают и левая панель, и `/help`.
- Клавиша-команда вставляет строку команды через `LineSource` TUI, как набранную. Правила REPL — удержание, отказ во время хода — действуют без изменений. Ctrl+G кладёт `/regen ` перед набранным текстом в поле ввода.
- Ctrl+буква узнаётся по `name` или по `baseCode`: в протоколе kitty Ctrl+R в русской раскладке приходит как `ctrl+к` с `baseCode` 114. Где `baseCode` нет (modifyOtherKeys), кириллица переводится в клавишу ЙЦУКЕН [D-138].
- Левая панель называет действующую клавишу новой строки: Shift+Enter — если терминал сообщил протокол kitty, иначе Alt+Enter. Ctrl+J работает везде.
- Пока идёт правка на месте, клавиши-команды не действуют; прокрутка, F2 и F3 — действуют.
- *Дополнено D-139:* ↑ и ↓ при пустом вводе прокручивают ленту на 3 строки; после F3 — строка `Shift+drag select`; `/help` перечисляет клавиши, когда левой панели не видно.
- **Рекомендация.** Принять. Частые действия — свайп, continue, правка, версии — одной клавишей, а правила хода остаются у REPL.
- **Альтернативы.** Действия клавиш мимо REPL — второй код правил удержания и отказов. Только по `name` — Ctrl+буква не работала бы в русской раскладке.
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-130
- **Решение.** Лента чата.
- При открытии — весь активный путь, а не только последнее сообщение. Каждое сообщение — карточка: заголовок `Имя › ` (жирный; у игрока — `you`, как в REPL), текст с оформлением прозы (`*действия*` курсивом), у ответа — приглушённая строка статуса.
- Дальше лента только дописывается, в порядке REPL: `line()` — системные строки (приглушённые, жёлтые, красные — как их оформил REPL), `echo` — строка игрока, `message` — карточка, `turn` — живая карточка. Дельты `text` идут через `applyDelta` и санитайзер; на конечном событии карточка закрывается.
- Рассуждения свёрнуты в `⋯ thinking (N chars)`, пока не `/think show`.
- Каждая запись — один `TextRenderable` с одним `StyledText`. Живых записей — до 150 (`LAYOUT.liveCards`); старые сворачиваются в архивные блоки по 50 (`ARCHIVE_BLOCK`).
- Прокрутка прилипает к низу. PgUp/PgDn, Ctrl+Home/Ctrl+End; отправка сообщения и клавиша-команда возвращают вниз.
- *Дополнено D-137, D-138 и D-139.*
- **Рекомендация.** Принять. Цена кадра растёт с числом элементов, а не с длиной текста (#1339). Замер прототипа на 5 000 сообщений: дельта с кадром — 24,7 мс, когда у каждого сообщения свои элементы, и 0,58 мс, когда история — один `StyledText`.
- **Альтернативы.** Все сообщения отдельными элементами — кадр замедляется с длиной чата. Только последнее сообщение при открытии — пропадает контекст.
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-131
- **Решение.** `/e` и Ctrl+E правят сообщение прямо в поле ввода: настоящие переводы строк, метка `edit ›`, Enter сохраняет, Esc или Ctrl+C отменяют.
- `$VISUAL` и `$EDITOR` в TUI не используются: TUI передаёт REPL окружение без них. Приостанавливать рендерер ради внешнего редактора в 0.7.0 ненадёжно: `suspend()` выключает raw-режим раньше, чем мышь (#1710). `/help` в TUI это говорит.
- *Дополнено D-137:* Ctrl+E при набранном тексте ничего не делает; статус просит отправить или очистить ввод.
- **Рекомендация.** Принять. Правка остаётся на экране, терминал не переходит между программами.
- **Альтернативы.** Внешний редактор через `renderer.suspend()` — не проверен и с известным багом.
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-132
- **Решение.** Терминал после TUI — такой же, как до него.
- Рендерер: `exitOnCtrlC: false`, `autoFocus: false`, `openConsoleOnError: false`, `targetFps` 30. SIGINT — не сигнал выхода: Ctrl+C в raw-режиме приходит клавишей, и её, как и внешний SIGINT, получает REPL. *Уточнено D-135* (своих сигналов выхода у OpenTUI нет) *и D-139* (мышь включена по умолчанию).
- Движок и сессия открываются до рендерера: отказ (lock, нет сессии) печатается обычной ошибкой CLI, код 5. Обработчики сигналов и ошибок ставятся раньше всего, что может бросить; запуск обёрнут в try/finally.
- Выход: `renderer.destroy()` → `await renderer.closed` (не дольше 2 с) → прежние stdout и stderr → `\x1b[?2027l` (0.7.0 оставляет режим 2027 включённым, #1727) → `endChat`. Коды REPL сохранены: 0, 3, 130.
- Пока экран поднят, никто не пишет в `process.stdout` и `process.stderr`: OpenTUI их не перехватывает, и текст лёг бы в кадр. Io TUI шлёт `out` и `err` в ленту и в `<home>/logs/tui.log`. Необработанная ошибка — в лог и красной строкой статуса, а не в консоль OpenTUI: та забирает фокус.
- Текст модели, строки из файлов и id моделей проходят санитайзер: целые escape-последовательности (CSI, OSC, DCS и другие) и управляющие символы C0 и C1 уходят, кроме `\n`; `\t` — два пробела. Под Warp (`TERM_PROGRAM=WarpTerminal`) уходят ещё ZWJ, VS16 и модификаторы тона кожи: от них Warp рисует призрачные глифы (opencode#58028).
- **Рекомендация.** Принять. Каждое правило закрывает дефект, найденный прототипом в pty. По умолчанию Ctrl+C уничтожал рендерер, клик по ленте забирал фокус у ввода, ошибка открывала консоль, а после смерти от сигнала терминал оставался в альтернативном экране.
- **Альтернативы.** Значения OpenTUI по умолчанию — все четыре дефекта выше.
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-133
- **Решение.** Тесты TUI — на headless-рендерере OpenTUI: `createTestRenderer` из `@opentui/core/testing`, клавиатура kitty. Символы вне BMP — через `pressKeys([...s])`: `typeText` режет emoji на половинки UTF-16.
- `test/tui/kit.ts` — `tuiRig`, клон `replRig` из `test/repl/kit.ts`: настоящий `runTui` со скриптовым провайдером и поддельными часами.
- Покрыто: раскладка на 120, 100 и 70 колонках; ввод, Enter и поток; пауза и Ctrl+C; удержанная строка и отказ правки; каждая команда `/…`; правка на месте; Директор после хода; строка тула; `/open` и `/fork`; уведомление о восстановлении; отказ lock до рендерера; `/quit` посреди хода снимает lock; клавиши в русской раскладке; санитайзер, `sgrToChunks`, архив.
- Проверка в настоящем pty — у ведущего (`pty_drive.py` с эмулятором pyte); плюс взгляд Леви в Warp. Три pty-теста сигналов — в `test/tui/signals.test.ts`, через `Bun.Terminal`.
- `test/preload.ts` ставит `TMPDIR` в `<корень теста>/tmp`; корень удаляется в `afterAll`. Раньше всё, что тесты создавали в `tmpdir()`, оставалось в `/tmp`: тысячи временных домов за прогон заполнили его.
- **Рекомендация.** Принять. Headless-рендерер отдаёт кадр текстом и спанами с цветами. По ним проверяются раскладка, цвета и то, что в stdout не попало ничего.
- **Альтернативы.** Только pty-тесты — медленнее, и нужен эмулятор терминала. Уборка во всех обвязках, которые создают каталоги, — легко забыть в новой.
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-134
- **Решение.** Цвета TUI — только из терминала, без hex.
- Текст — цвет терминала по умолчанию: `RGBA.defaultForeground()`, SGR 39. Приглушённое — тот же цвет с атрибутом DIM.
- Акценты — палитра ANSI терминала, `RGBA.fromIndex(n)`, `38;5;n`: 2 — игрок, 5 — персонаж, 4 — клавиши и агенты, 3 — жёлтый, 1 — красный, 8 — рамки и полоса прокрутки.
- Фон — фон терминала, SGR 49. У поля ввода своего фона нет: строку ввода отмечает метка `you ›`.
- Каждый элемент и каждый кусок текста задаёт цвет явно: текст, плейсхолдер, курсор, рамки, полоса прокрутки. Ничто не падает в белый цвет OpenTUI. Пустые клетки кадра закрашивает подложка в цвете текста терминала.
- Курсор — серый #808080 с намерением «цвет по умолчанию»: OpenTUI шлёт цвет курсора конкретным OSC 12.
- `NO_COLOR` — цвет по умолчанию везде; различаются только атрибуты. Исключение — фон выделения мышью (цвет 8, D-139): иначе выделения не видно.
- Найдено первым взглядом Леви, Warp со светлой темой: текст без заданного цвета OpenTUI рисует ярко-белым (`38;5;15`), и на белом фоне он пропал. Так же белеют пустые клетки кадра и клетки под непрозрачной заливкой.
- **Рекомендация.** Принять. Светлая и тёмная тема работают без определения темы. В pty вывод несёт только SGR 0, 1, 2, 3, 39, 49 и `38;5;{2,3,4,5,8}`.
- **Альтернативы.** Определять тему по ответу на OSC 11 и держать две палитры hex — терминал может не ответить. Свои hex-цвета и свой фон — спорят с темой пользователя.
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-135
- **Решение.** Все сигналы выхода обрабатывает TUI, не OpenTUI: `exitSignals: []`.
- Обработчик OpenTUI только вызывал `destroy()` и не выходил, а как слушатель он отменял действие сигнала по умолчанию. Найдено ревью: после закрытия терминала (SIGHUP) оставался процесс-сирота на 100 % CPU, и он продлевал lock сессии.
- `runTui` сам ловит SIGTERM, SIGHUP, SIGQUIT, SIGABRT, SIGPIPE и SIGBUS — от запуска до восстановления терминала. Первый сигнал: строка (у SIGTERM — та же, что у `rp-core chat`; у других — `rp-core: SIGHUP: closing the session (the partial answer is kept)`) → лента и `tui.log` → `engine.close()`: ход остановлен, частичный ответ сохранён, lock снят → восстановление терминала → та же строка в stderr → код 128 + номер сигнала (SIGHUP — 129, SIGTERM — 143). Под `--sandbox` его каталог удаляется. Второй сигнал — выход сразу.
- Если рендерер исчез иначе, слушатель `destroy` закрывает источник ввода, и TUI выходит как после `/quit`. Методы источника после уничтожения поля ничего не делают. Записи после обрыва терминала (EIO) перехватываются.
- **Рекомендация.** Принять. Проверено в настоящем pty: `kill -HUP`, `-QUIT`, `-TERM` → 129, 131, 143; терминал закрыт посреди ответа → 129, частичный ответ сохранён, lock снят.
- **Альтернативы.** Сигналы OpenTUI — сирота на SIGHUP (выше).
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-136
- **Решение.** Ни одна строка REPL не теряется.
- Пока экран поднят, каждая строка REPL идёт и в ленту, и в `tui.log` — вместе со строками `--debug` и ошибками. `rt.debug` вне работы REPL тоже идёт через Io TUI.
- Строки, сказанные во время выхода, печатаются в stderr после восстановления терминала. После выхода с кодом 1, 3 или 130 туда же идут последние строки REPL (до 6): почему чат закрылся, например `(1 answer failed: script_exhausted; exit 3)`. Выход 0 не печатает ничего.
- `tui.log` — `<home>/logs/tui.log`: строка с меткой времени, без SGR. `exit N` в логе — настоящий код, в том числе на пути сигнала.
- **Рекомендация.** Принять. Найдено ревью: строки, сказанные при выходе, и причина выхода пропадали вместе с экраном.
- **Альтернативы.** Писать только в лог — человек не видит, почему чат закрылся.
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-137
- **Решение.** Лента TUI читается как чат, а не как построчный REPL.
- Строка статуса ответа — без подсказок REPL `/r swipe /c continue /e edit`: их заменяют клавиши. Пометки finish, edited и hidden — один раз, в строке статуса, а не перед текстом.
- Строки клавиш в панели — по одной строке на клавишу: подписи и описания укорочены.
- Continue (Ctrl+O, `/c`) — как в REPL: новый блок после строки `/c`, `…последние слова`, затем добавка. Оформление прозы учитывает весь текст ответа. Когда ответ готов, исходная карточка, если она ещё на месте, перерисовывается из итогового сообщения. Выше экрана ничего не дописывается.
- Строка REPL посреди ответа (удержанная строка, уведомление) не сбрасывает оформление прозы ответа.
- Ctrl+E при набранном тексте его не стирает: статус `send or clear the input first (Esc)`, больше ничего.
- Подсказки, которые называют `rp-core chat`, в TUI называют `rp-core tui` (`ReplOptions.command`, D-127). Байты REPL не меняются.
- Долгая команда (`/probe --active`, `/preview` большой сессии) через 300 мс пишет в статусе `working…`; строки, отправленные за это время, — `queued: N`.
- **Рекомендация.** Принять. Это находки ревью: continue дописывал карточку выше экрана, пометки шли дважды, Ctrl+E терял набранное.
- **Альтернативы.** Continue на месте, в старой карточке: строка `/c` остаётся пустой, а карточка может быть за экраном.
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-138
- **Решение.** Мелкие правки ревью.
- Большая сессия: при открытии строятся только новейшие записи (`LAYOUT.liveCards`), до 300 сообщений перед ними (`HISTORY_BATCH`) — сразу в архив, остальное не строится. Сверху — строка `⋯ N earlier messages · Ctrl+Home loads more`; Ctrl+Home достраивает следующие 300. Замер, 5 000 сообщений по 800 символов: лента открывается за 81 мс вместо 654, первый кадр — 20 мс вместо 188, память ленты — +53 МБ вместо +352.
- Санитайзер — для каждой строки из модели, файла или id модели: заголовки карточек и обе панели. U+2028 и U+2029 — переводы строк.
- Ширины — в колонках терминала (`Bun.stringWidth`), а не в единицах UTF-16.
- Поток: дельта дописывается к живому тексту, перерисовки хода склеиваются в одну на кадр.
- Ctrl+буква в русской раскладке узнаётся и под modifyOtherKeys, где `baseCode` нет: кириллица переводится в клавишу ЙЦУКЕН.
- Незакрытая вставка (bracketed paste) ограничена: через 1 с без байта она закрывается, Ctrl+C закрывает её сразу. Сам OpenTUI ждал бы конца вставки бесконечно (#1270).
- Пороги по часам в тестах — только с `RP_CORE_PERF=1`: под нагрузкой они давали ложные падения.
- **Рекомендация.** Принять. Каждая правка закрывает находку ревью и покрыта тестом, который падает на коде до правки.
- **Альтернативы.** Строить всю историю при открытии — сессия на 5 000 сообщений открывается в 8 раз медленнее.
- **Статус.** Ждёт подтверждения (вопрос 23).

#### D-139
- **Решение.** Правки после второго и третьего взгляда Леви — Warp со светлой темой и GNOME Terminal в Ubuntu, 27.10.
- **Ввод не выходит из колонки чата.** Поле стоит в строке рядом с меткой. Без `flexShrink: 1`, `minWidth: 0` и `flexBasis: 0` Yoga отдавал ему всю ширину колонки, и длинный ввод рисовался поверх панели Agents.
- **Метка ввода — `you ›` и `edit ›`**, без отступов. Лента сохраняет выравнивание REPL.
- **Мышь включена по умолчанию.** С выключенной мышью терминал в альтернативном экране превращает колесо в ↑/↓, и колесо двигало курсор в поле ввода. Warp и большинство терминалов выделяют сами, если держать Shift. F3 выключает мышь; левая панель показывает `Shift+drag select`. При пустом вводе ↑/↓ прокручивают ленту на 3 строки — так работает и колесо, превращённое в стрелки.
- **Выделение OpenTUI читается и копируется.** Простое протягивание — выделение OpenTUI; его цвета по умолчанию пропадали на фиолетовом фоне Ubuntu. Теперь на каждом выделяемом элементе фон выделения — цвет 8 палитры, текст — цвет по умолчанию. Конец выделения отправляет текст через OSC 52 (`renderer.copyToClipboardOSC52`), статус пишет `sent N chars to the clipboard`: дошёл ли текст, TUI не видит. VTE (GNOME Terminal) OSC 52 игнорирует; там TUI ничего не отправляет, статус говорит об этом и предлагает Shift+протягивание — выделение самого терминала (VTE узнаётся по `VTE_VERSION`, §12.4.1).
- **`**жирный**` — жирным** в ленте TUI: звёздочки не видны, `**`, разрезанный дельтами, тоже работает. Построчный REPL не изменился.
- **Один маркер остановки.** После Ctrl+C строки `[stopped]` нет, если строка статуса уже говорит `· stopped`.
- **`/help` в TUI** перечисляет клавиши, когда левой панели не видно: терминал уже 120 колонок или панели спрятаны F2.
- *Третий взгляд (27.10).* **`*курсив*` тоже без звёздочек** в ленте TUI (§12.4.1): `*` переключает курсив по правилу границ, как `**`; `5 * 3`, `f*ck` и одиночная `*` видны и ничего не переключают. Это заменяет «одиночная `*` — по-прежнему курсив» второго взгляда. Построчный REPL оставляет звёздочки.
- *Третий взгляд.* **`/director show` печатает последнюю директиву целиком** — блок `[DIRECTOR CONSTRAINTS …]`, как его получил рассказчик (§12.4), вместо сводки с полями по 30–40 символов: Леви не видела ни крючка, ни директивы целиком. Это меняет вывод построчного REPL — сознательно; D-127 обещал неизменный вывод только для портов. *Уточняет D-113.*
- **Рекомендация.** Принять. Всё это Леви увидела сама. Каждая правка покрыта тестом (`test/tui/polish-host.test.ts`, `test/tui/polish-chat.test.ts`, `test/tui/polish2.test.ts`; для `/director show` — `test/repl/m4-render.test.ts` и `m4-flows.test.ts`), который падает с откатом правки.
- **Альтернативы.** Мышь выключена по умолчанию, как в D-132, — колесо двигает курсор, а не ленту.
- **Статус.** Ждёт подтверждения (вопрос 23).

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

**Ревизия 12 (26.10.2026, M2 реализована).**

38. *M2 готова.*
    - Есть движок лора (`src/lore/`), импорт ST-пресетов, world info и `character_book`, чтение экспортов пресетов RoleCall, подсчёт o200k, `preview`, команды REPL `/preset`, `/lore add|rm|test`, `/preview`, `/trace` и разовые `import`, `new --preset --lore`, `preview`.
    - Работают провайдеры `record:` и `replay:`. Повтор идёт без сети; при изменённом запросе он падает с `replay_mismatch` и читаемой разницей.
    - Живое демо на Ollama (Default и Geechan, мир Eldoria) — `docs/M2-DEMO.md`.
    - Новые зависимости: `re2js` 2.9.0 и `gpt-tokenizer` 4.1.0 (MIT).
    - Сборку проверили четыре ревьюера; 39 подтверждённых находок исправлены с регрессионными тестами.
39. *Установлено golden-снимками и кодом SillyBunny* (текст §10.1, §10.3, §11 исправлен):
    - бюджет WI — `round(25 % × (max context − max tokens))`, а не 25 % всего окна;
    - поставляемые умолчания SillyBunny: целые слова и рекурсия включены, имена в тексте сканирования включены, стратегия «character first»;
    - при равном `order` записи идут в порядке, обратном срабатыванию;
    - внутри одной глубины ST ставит авторскую заметку, заметку карточки, затем WI; ранг источников ядра теперь такой же;
    - текст `ignoreBudget`-записи считается против следующих записей;
    - cooldown после sticky перевзводится на первом скане после окна; длина чата для таймеров считается без скрытых сообщений;
    - `scan_depth` и `recursive_scanning` уровня `character_book` ST не читает (карточки Wymare ставят 100 и false — у нас они теперь не действуют);
    - текст авторской заметки ST берёт из поля интерфейса, а не из метаданных чата (важно только для съёмки снимков);
    - макросы SillyBunny (`{{#if}}`, `{{.var}}`) в новых пресетах вроде Geechan v5.2 ядро не исполняет: они уходят в модель текстом и называются при импорте и в `/trace`.
40. *Решено по ходу* (записано в `.notes/m2-contract-*.md`):
    - `preview` резервирует seed следующего хода, поэтому `/preview` и `/lore test` в REPL совпадают со следующим ходом во всём, что зависит от seed (лор, `{{random}}`); макросы времени берут часы своего вызова; разовый `rp-core preview` берёт свой seed;
    - приветствие срезается последним перед `context_length_exceeded` (§11);
    - `replay` берёт caps у соединения, на котором вызов записан;
    - в Bun lookbehind по `\p{…}` ошибается на суррогатных парах — граница слова проверяется посимвольно (это касается и `normalizeTerm` на M3).
41. *Открытые мелочи:*
    - примеры диалога и вставки одной глубины отправляются не так, как в ST (G-1, G-3), — сознательно, но для моделей, натренированных на ST-разметке, это можно пересмотреть;
    - уже импортированные пресеты читались старыми правилами — их стоит импортировать заново;
    - выключенный маркер WI в экспорте RoleCall включается на месте, а RoleCall ставит записи в начало блока персонажа — нужна запись RoleCall с лорбуком;
    - паритет лора с RoleCall не проверен (нет фикстур); корпус макросов `macro-corpus.json` (D-43/D-44) не портирован;
    - `rp-core import package.json` проходит как карточка CCv1;
    - в карточках неизвестные макросы при импорте не называются.

**Ревизия 13 (27.10.2026, M3 реализована).**

42. *M3 готова.*
    - Есть цикл тулов рассказчика (`engine/narrate.ts`): раунды native и prompted, финальный раунд, потолок вызовов, защита от зацикливания и комната тулов. Тулы v1 — `search_history`, `read_history`, `search_lore`, `read_lore`; с ними починка аргументов [D-56], восстановление протечек [D-57], стемминг `normalizeTerm` и ранжирование `lexScore`.
    - Есть заметки человека (`/memory`): они срабатывают как книга лора. Есть `/search` и активные пробы — `rp-core probe --active` и `/probe --active` в REPL.
    - Без предложенных тулов запрос, трасса и сохранённые блоки — как на M2: golden-снимки, паритет и хеши запросов не менялись.
    - `src` — ≈ 34 тыс. строк TypeScript (на M2 — ≈ 26 тыс.), тесты — ≈ 43 тыс. (на M2 — ≈ 28 тыс.). Полный прогон: 3334 теста прошли, 2 пропущены (живые, без `RP_CORE_LIVE`), 0 упали — 3336 тестов в 164 файлах. Проверка типов чистая.
    - Новая зависимость: `jsonrepair` 3.14.0 (ISC), только в `tools/args.ts`.
    - Закрыта мелочь п. 37: после `finish` без `[DONE]` вызов ждёт хвост не дольше `FINISH_GRACE_MS` (3 с) тишины, а не таймаут простоя (§8.8).
    - Демо §15 без модели — `test/demo-m3/innkeeper.test.ts`: скриптовая модель зовёт `search_history`, находит «братом» в #5 и отвечает «Тихон».
43. *Живые прогоны 27.10* (A–C — `test/live/m3-ollama.test.ts`: чат innkeeper-200, вопрос §15, `narrator.maxRounds` 2; Ollama 0.34.2; ничего не скачано, не создано и не удалено; всего ≈ 17 вызовов модели):
    - **A** — после D-96 и исправлений ревью: `magmell-16k:latest`, prompted, окно 16384, `max_tokens` 300. Первая попытка на холодной модели — `failed` через 61 с, из них 54 с — загрузка; это не таймаут (предел первого байта на локальном origin — 600 с), а код сбоя тест тогда не печатал (теперь печатает). Проверка D-96 в тесте не знала, что shape сливает заметки с соседними сообщениями (`core:gap+history`), — исправлена. В трёх попытках вызова нет: тег `<search_history>…</search_history>` с выдуманным результатом и прозой (→ D-97), «Гордей» (покойный муж из карточки) и ответ без имени.
    - **Сырая проверка** — тот же запрос вручную, с напоминанием со строкой вызова: из трёх ответов один — правильный незакрытый `<tool_call>`, с текстом D-96 — ни одного → D-96 дополнено.
    - **B** — после дополнения D-96 и D-97, та же модель: три попытки без вызова («Сергей…», «…Гордей», «Гордей»), разметки в сохранённом тексте нет, инварианты выполнены. Запрос нёс заметку о пропуске и напоминание со строкой вызова.
    - **C** — `gemma4:26b`, native, окно 4096 (умолчание `/v1` Ollama), `max_tokens` 1024. Первая попытка (204 с) — рассуждение и ответ «имя брата не упоминается», без вызова, хотя рассуждение цитирует заметку о пропуске. Вторая — `reasoning_only` [D-31]: рассуждения съели все 1024 токена.
    - **Прямая проверка gemma4:26b** — промпт на 97 токенов с одним тулом: вызов `search_history {"query":"sister"}`. Нативные вызовы через `/v1` Ollama у неё работают; в полном RP-промпте она решает не искать.
    - *Что это показывает.* Ядро шлёт задуманное: заметку с правильным диапазоном, напоминание, схемы native и `tool_choice: auto`. Цикл доказывают детерминированные демо, в том числе на дословном выводе живой модели по проводу openai-chat. Заявка демо §15 на двух опробованных локальных моделях (12B RP-файнтюн без обучения тулам и 26B думающая) не выполнена: обе отвечают по видимой части и часто выдумывают имя (риск 19, §17).
    - *Дальше:* облачная модель, обученная вызовам тулов (DeepSeek, OpenRouter), — когда Леви согласится на расход; recall до ответа (M5, prefetch на локальном origin [D-1, D-78]) — путь, который не зависит от решения модели; думающим моделям на Ollama — больший запас ответа или выключенный thinking.
44. *Ждут подтверждения* (вопрос 21, §19.10): решения сборки D-90…D-97 и правка D-59 — хэндл заметки `C<n>` в тулах совпадает с `/memory` и не меняется между ходами. D-94 пересмотрено после ревью: вместо выключения thinking — заглушка. D-96 добавлено после первого живого демо и дополнено после второго прогона: при prompted-тулах напоминание показывает строку вызова. D-97 (имя предложенного тула как тег — вызов) тоже добавлено после второго прогона, а его правила для обёрток, оборванных тегов и пустого тела уточнены после проверки. Правки D-55, D-56 и D-58 уточняют принятые решения по реализации.
45. *Найдено при реализации:*
    - **Ollama `/v1` берёт `num_ctx` из Modelfile.** Ollama 0.34.2 прочла промпт в 13 917 токенов целиком для `magmell-16k:latest` (`num_ctx 16384` в Modelfile). Утверждение Bunraku, что `/v1` игнорирует `num_ctx`, здесь не подтвердилось.
    - **Ollama стримит thinking как `delta.reasoning`.** Парсер читает все известные поля рассуждений, и они сохраняются сырым блоком. Думающей модели в цикле тулов нужен запас `max_tokens`: у gemma4:26b рассуждения заняли большую часть 260 токенов ответа при `max_tokens` 300.
    - **DeepSeek с тулами требует `reasoning_content` всех прошлых ходов**, иначе 400 (документация DeepSeek) → [D-94].
    - **Первый живой прогон демо не удался:** ни одна модель не позвала тул, потому что запрос нигде не говорил, что чат срезан → [D-96].
    - **Объявления native-тулов считаются в оценке промпта** (`trace.tokens.estimated`): сервер считает их промптом (≈ 500 токенов o200k на два тула истории). Без них EMA и проверка обрезки сервером читали бы их как дрейф счётчика.
    - **Ответ из нескольких раундов в истории** уходит одним текстовым блоком: блоки склеиваются без разделителя, а не через `\n\n` в адаптере. Это касается и запросов без тулов, если в истории есть такой ответ.
46. *Ревью сборки:* 30 подтверждённых находок, из них 8 серьёзных; все исправлены с регрессионными тестами. Повторная проверка исправлений нашла ещё 35 замечаний: остатки исправленных находок, тесты, которые не ловили регрессию, дефекты, внесённые самими исправлениями, и расхождения с документами. Исправлено всё, кроме оставленного с причиной: это открытые мелочи п. 47 и нечитаемые блоки native-раунда, которые не получают результата-ошибки (§8.3). 7 находок опровергнуты. Ожидания golden-снимков, паритета и запросов без тулов при этом не менялись.
47. *Открытые мелочи:*
    - на окнах 2 048–2 560 (o200k, встроенные тулы) тулы истории не помещаются даже без тулов лора; остаётся запрос с тулами лора, без заметки о пропуске [D-92];
    - доли комнаты до запуска делятся только по `maxOutput`: размер результата заранее неизвестен, поэтому `read_history` рядом с пустым `search_history` всё равно читает страницу по своей равной доле (это вопрос эффективности, лимит не нарушается);
    - `search_history` в доле меньше одной строки попадания теряет строку «More matches» при обрезке раннером;
    - в восстановлении протечек остаются медленные формы на 100 КБ (до 5,7 с на искусственном входе: незакрытый ```` ``` ```` и 100 КБ пробелов); ревью отклонило их как недостижимые при ограниченном ответе. Потоковый вырезатель prompted на потоке незакрытых открывающих тегов больше не медленный (≈ 17 с → меньше 0,1 с, §8.3);
    - проза всё ещё стирается после нескольких редких форм: блок в атрибутной форме без значения, контейнер `<tool_calls>` из блоков `<tool_call>`, полное значение и обрезанный закрывающий тег `</tool_cal`;
    - `gen.reasoningMs` не пишется (с M1);
    - `gen.usage` хода без тулов с повтором — сумма обоих вызовов, а не один вызов, как на M2: на M3 `gen.usage` — сумма вызовов хода. Трасса и EMA — как на M2;
    - заглушка DeepSeek и перекладка `reasoning_details` OpenRouter при переименовании id вызова вживую не проверены.

**Ревизия 14 (27.10.2026, M4 реализована).**

48. *M4 готова.*
    - Есть Story Director (`src/agents/director/`): состояние и `fitState`, чтение плана (full и lite), редьюсер с сопоставлением арок, импульс, промпты и 10 личностей, рендер директивы, контракт, фильтр персоны и `runDirector`. Есть общий помощник для JSON-агентов `structuredCall` (`src/agents/structured.ts`).
    - В ходе: Директор до сборки, директива на глубине 1, контракт в блоке ядра, запись в `prep` и в строке ответа, повтор плана на свайпе, директива цели на continue, заглушка в `/preview`, строки вызовов в `trace.calls`.
    - В CLI: `/director show|on|off`, строка Директора в REPL и в stderr `send`, Директор в баннере, `/usage` по агентам, `rp-core compact`.
    - С выключенным Директором запросы байт в байт как на M3: golden-снимки, паритет и хеши запросов не менялись.
    - `src` — ≈ 46 тыс. строк TypeScript (на M3 — ≈ 34 тыс.), тесты — ≈ 55 тыс. (на M3 — ≈ 43 тыс.). Полный прогон: 4254 теста прошли, 3 пропущены (живые, без `RP_CORE_LIVE`), 0 упали — 4257 тестов в 199 файлах. Проверка типов чистая.
    - Новых рантайм-зависимостей нет.
49. *Как строилось.*
    - Решения сборки записаны до кода — `.notes/m4-decisions.md`, разделы A–H. Каждый блок писал свой контракт с отступлениями и API: `.notes/m4-contract-*.md`, правки после ревью — `.notes/m4-contract-fixes-*.md`.
    - Первая волна — семь чистых блоков параллельно, против общего `agents/director/types.ts`: state, plan, reduce, momentum, prompt (с личностями), render, structured. Вторая — вызов и ход (integrate) и CLI.
    - Вопросы, которые блоки первой волны оставили открытыми, решены как D-116…D-118. После ревью сборки и первого живого прогона — D-119…D-124.
    - Портированные файлы получили шапку и строку `PROVENANCE.md`: Bunraku @702d8120, RoleCall @fb8dc623.
50. *Ждут подтверждения* (вопрос 22, §19.10): решения сборки D-98…D-124. Четыре из них уточняют принятые решения: D-116 — D-61 (типичный размер снимка), D-107 — D-62 (правила чтения), D-112 — D-65 (граница слова в фильтре персоны), D-119 — D-101 (что значит «следует за рассказчиком»). Вопрос 21 (D-90…D-97 и правка D-59) тоже ещё открыт.
51. *Живые прогоны 27.10* (`docs/M4-DEMO.md`; Ollama, Mag-Mell 12B и рассказчиком, и Директором, lite, tagged; ничего не скачано, не создано и не удалено; 17 вызовов модели в первом прогоне, из них 11 у Директора, и 11 во втором, из них 5 у Директора). Подробно — §15, M4.
    - Первый прогон нашёл две ошибки. Директор брал у рассказчика всю привязку, вместе с `--max-tokens 300`, и 4 плана из 6 оборвались на 300 токенах → D-119. Под английской директивой рассказчик стал мешать английский в русский текст → D-120.
    - Второй прогон, после правок: 5 планов из 5 с первой попытки, повтор на свайпе, `/regen` и откат работают. Арок модель за 4 хода не завела. Русский держался в 5 ответах из 6.
    - Не прогонялись: 30 живых ходов, транспорт structured, профиль full, облачная модель.
52. *Ревью сборки:* 16 подтверждённых находок — 4 серьёзные, 4 средние, 8 мелких; все исправлены. Правки кода идут с регрессионными тестами, и эти тесты падают на коде до правки. 9 находок опровергнуты. Главные:
    - запрос Директора выходил за окно: lite на окне 4 096, явный full на 16k с `max_tokens` меньше одного плана, корректирующий проход с прежним `max_tokens` → D-121;
    - ядро записывало состояние, которое потом само не могло прочесть: `relatedArcId` длиннее 80 символов, `targetTurn` 1e20 → D-123;
    - самопроверка цитировала скрытый ответ; эхо id в селекторе плодило дубли арок; пустой `<plan></plan>` прятал настоящий план → D-123;
    - `transport_unsupported` срабатывал на любой 400 structured → D-122;
    - `compact` мог потерять строки, дописанные другим процессом, и сделать принятой строку, которую читатель раньше пропускал; он менял права файла на 0644 и mtime, а с `--json` печатал события восстановления текстом → D-124;
    - у `agents/director/types.ts` не было строки в `PROVENANCE.md` — добавлена.
53. *Найдено при реализации:*
    - **Шаг 5 `fitState` не укладывает кириллицу и CJK в 32 КБ:** подробный русский планировщик — 287 состояний из 300 выше потолка → D-116. «≤ 16 КБ типично» для русского не держится: медиана — ≈ 20–24 КБ.
    - **Полный tagged system Директора — ≈ 7,8–9,5 тыс. токенов** o200k: у Sage 7,8–8,8 тыс. (без персоны и с короткой), у oracle 8,5–9,5 тыс. Рев. 6 оценивала 9–10 тыс. Lite-схема с описаниями — 7 997 символов (≈ 1 770 токенов), без них — 2 622 (≈ 640) → D-117.
    - **Общий префикс запроса Директора и запроса рассказчика — 5 токенов** (замер ревью): на одном слоте вытеснение KV-кэша полное (риски 6 и 18).
    - **Bunraku сортировал арки по `lastProgressTurn ?? Infinity`:** арки без прогресса шли последними, против его же правила «по застою». В ядре — `lastProgressTurn ?? createdAtTurn` [D-118].
    - **Русские имена и глаголы.** Без падежа фильтр персоны резал бы «Брат Елисея думает»: подлежащее там — брат. Правило по падежу — D-112, D-118.
54. *Открытые мелочи:*
    - `worldSnapshot` — заглушка до M5a: `runDirector` его принимает, ход не передаёт, раздела `[COMPENDIUM CONTEXT]` нет;
    - транспорт structured вживую не проверен: ни у одной локальной модели здесь нет подтверждённого `json_schema`. 400 `bad_request` до вывода по другой причине (например, `max_tokens` больше лимита облачной модели без `caps.maxOutput`) всё ещё читается как отказ structured [D-122];
    - карта алиасов для ключей вне схемы в примерах личностей (romantic, thrill-seeker, shadow, jester; у jester ещё `"pacing": "balanced"`) ждёт Chi [D-111];
    - известные пропуски русского фильтра персоны: «сомнения мучают Елисея» (существительное, глагол, имя), беглые гласные в именах (Павел/Павла, Лев/Льва), имена-прилагательные («Хромой», «старый землемер» в косвенных падежах), двухбуквенные имена, незаписанные наполнители («Елисей так и не может решить»). Ложные срабатывания: «Пусть брат Елисея решит»; Надежда или Любовь как NPC прямо перед именем персоны;
    - на окне 4 096 lite за 40 ходов планирует только 1-й и 3-й, остальные — `no_room`: один lite tagged system там ≈ 2,5 тыс. токенов. Следующие рычаги — проза самопроверки (2 400 символов) и описания арок, которые lite user-промпт показывает дважды;
    - `rp-core compact` убирает только копии в `prep` и строки `chk`; снимки `msg.dir` остаются (риск 11);
    - `turn_open` и `draft_recovered` — не коды `Refusal` движка: если M6 откроет `compact` через `--stdio`, их нужно добавить;
    - правок человека нет: `dirEdit` и `/director edit` — позже.

**Ревизия 15 (27.10.2026, этап M4.5 — TUI).**

55. *TUI готов.*
    - `rp-core tui <session>` и `rp-core new --tui` открывают чат на весь экран терминала, в три колонки, на OpenTUI (`src/cli/tui/`, 16 файлов). Внутри — тот же REPL через два порта: `LineSource` и `ReplView` (§12.4.1).
    - Этап вставлен решением Леви от 27.10, после M4 и до M5 (§15, M4.5).
    - `src` — ≈ 50 тыс. строк TypeScript (на M4 — ≈ 46 тыс.), тесты — ≈ 61 тыс. (на M4 — ≈ 55 тыс.). Полный прогон с `TMPDIR` в `~/.cache`: 4541 тест прошёл, 3 пропущены (живые, без `RP_CORE_LIVE`), 0 упали — 4544 теста в 215 файлах. Проверка типов чистая.
    - Новая рантайм-зависимость — `@opentui/core` ровно 0.7.0 [D-126].
    - Построчный REPL не изменился: его тесты прошли без правок.
56. *Как строилось.*
    - Сначала — исследование OpenTUI 0.7.0 с прототипом в настоящем pty. Решения T-1…T-11 записаны до кода — `.notes/tui-decisions.md`.
    - Фаза 1 — порты REPL, отдельным зелёным шагом. Фаза 2 — блоки `host`, `chat` и `panes` параллельно, против общего `src/cli/tui/types.ts`; затем сборка в одну программу. Контракты — `.notes/tui-contract-*.md`.
    - T-12 появилось после первого взгляда Леви, T-13…T-16 — после ревью, T-17 — после второго взгляда.
    - Портированного кода нет.
57. *Ждут подтверждения* (вопрос 23, §19.10): решения сборки D-125…D-139. Там же — сказать ли Chi о TUI сейчас: Stage из плана Kintsu с ним пересекается [D-14]. Вопросы 21 и 22 тоже ещё открыты.
58. *Первый взгляд Леви* — Warp со светлой темой. Обычный текст пропал: белый на белом. OpenTUI рисует текст без заданного цвета белым (`38;5;15` или `38;2;255;255;255`); так же белеют пустые клетки кадра и клетки под непрозрачной заливкой. Теперь цвета — только из терминала, у каждого элемента цвет задан явно, непрозрачных заливок нет [D-134].
59. *Ревью сборки:* 21 подтверждённая находка, все исправлены. У каждой правки — регрессионный тест; он проверен мутацией: с откатом правки падает. Главные:
    - после закрытия терминала (SIGHUP) оставался процесс-сирота на 100 % CPU, и он продлевал lock сессии: обработчик сигналов OpenTUI только вызывал `destroy()` → D-135;
    - строки REPL, сказанные при выходе, и причина выхода пропадали вместе с экраном → D-136;
    - continue дописывал карточку выше экрана; пометки ответа шли дважды; Ctrl+E терял набранный текст → D-137;
    - сессия на 5 000 сообщений открывалась медленно (лента — 654 мс, теперь 81 мс); незакрытая вставка могла заблокировать ввод; русская Ctrl+буква не узнавалась под modifyOtherKeys → D-138.
60. *Второй взгляд Леви* — Warp со светлой темой и GNOME Terminal в Ubuntu → D-139:
    - длинный ввод заезжал на панель Agents;
    - метка ввода была с отступами — `you      ›`;
    - мышь была выключена по умолчанию, терминал превращал колесо в ↑/↓, и колесо двигало курсор в поле ввода;
    - цвета выделения OpenTUI не читались на фиолетовом фоне Ubuntu;
    - `**жирный**` показывался со звёздочками.

    Заодно: один маркер остановки вместо двух, `/help` со списком клавиш, когда левой панели не видно.

    *Третий взгляд* (Warp) — тоже D-139: `*курсив*` показывался со звёздочками; `/director show` давал директиву однострочной сводкой с обрезанными полями — ни крючка, ни директивы целиком. Теперь курсив в TUI без звёздочек, а `/director show` — и в построчном REPL — печатает блок, который получил рассказчик. Статус копирования говорит «отправлено» (`sent N chars to the clipboard`), а в VTE — что OSC 52 там не дойдёт.
61. *Найдено при реализации* (OpenTUI 0.7.0):
    - кадр очищается пробелами с белым цветом текста, а непрозрачная заливка сбрасывает цвет своих пустых клеток на белый. Поэтому фон рисует подложка в цвете терминала, а поле ввода и полоса прокрутки — без заливки;
    - после выхода режим 2027 остаётся включённым (#1727): TUI выключает его сам;
    - сигналы выхода OpenTUI только вызывают `destroy()`, процесс не выходит [D-135];
    - `copyToClipboardOSC52` бросает `NativeError`, пока терминал не настроен (в headless-рендерере — всегда): копирование обёрнуто в try/catch, статус — `NOT_COPIED`;
    - поле ввода рядом с меткой Yoga растягивал на всю колонку. Нужны `flexShrink: 1`, `minWidth: 0` и `flexBasis: 0`: без `flexBasis: 0` многострочное поле выходило до 4 колонок шире;
    - цвет курсора уходит конкретным OSC 12 `#rrggbb` при любом намерении — отсюда серый #808080.
62. *Тестовая инфраструктура.* `test/preload.ts` ставит `TMPDIR` в `<корень теста>/tmp`; корень удаляется в `afterAll`. Раньше временные дома, обвязки CLI и REPL и дочерние процессы оставляли каталоги в `/tmp`: тысячи за прогон заполнили его.
63. *Открытые мелочи:*
    - проверка в Warp — за Леви; IME, Ctrl+Z и доход OSC 52 до буфера обмена в каждом терминале не проверены (риск 23);
    - `tui.log` растёт без ротации, права файла — по umask (§13);
    - вставка, куски которой приходят с паузой больше 1 с (медленный ssh), режется на паузе; остаток приходит как набранные клавиши, и Enter в нём отправит строку (`PASTE_IDLE_MS`);
    - SIGBUS и SIGABRT от настоящего сбоя, а не от `kill`, обработчику JS небезопасны;
    - на низком терминале нижние строки панели Models обрезаются;
    - баг OpenTUI #1514 (липкий ScrollBox тянет читателя к хвосту, когда раскладка сжимается) в 0.7.0 есть; у нас не проверялся.
