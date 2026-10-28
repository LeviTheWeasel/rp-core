# rp-core

**Русский** · [English](README.md)

Терминальный чат для ролевых историй с локальными и удалёнными моделями. rp-core читает карточки персонажей, хранит историю с вариантами ответов и ветками, поддерживает пресеты и лорбуки SillyTavern. Можно продолжить чат, экспортированный из SillyTavern или RoleCall.

## Установка

Нужны [Bun](https://bun.sh) **1.3 или новее** (для полноэкранного интерфейса — **1.3.14 или новее**) и этот репозиторий.

```bash
git clone https://github.com/LeviTheWeasel/rp-core.git
cd rp-core
bun install
bun link
rp-core --version
```

`bun link` добавляет команду `rp-core` в `~/.bun/bin`. Если команда не находится, добавьте эту папку в `PATH` или запускайте `bun src/cli/main.ts` из каталога репозитория.

## Настройка модели

Запустите сервер модели и создайте конфигурацию:

```bash
rp-core init
rp-core models ollama
```

`rp-core init` создаёт `~/.rp-core/config.toml` и не перезаписывает существующий файл. В нём уже есть подключение к локальному Ollama. Укажите точное имя модели из `rp-core models ollama` как модель по умолчанию:

```toml
[roles]
narrator = "ollama:имя-модели"

[caps."ollama:имя-модели"]
context_length = 16384
```

Значение `context_length` должно совпадать с окном контекста, с которым сервер **реально** запустил модель. Для Ollama при необходимости увеличьте `num_ctx` на его стороне. Если не хотите задавать модель по умолчанию, передайте `--model ollama:имя-модели` в `rp-core new`. Подключения к llama.cpp, LM Studio и OpenRouter также описаны в конфигурации; API-ключ для удалённого сервера задаётся через переменную окружения (`key_env`), а не записывается в файл.

## Запуск

```bash
rp-core new --card ./character.png --model "ollama:имя-модели"
```

Подойдёт карточка персонажа в PNG или JSON (CCv1/V2/V3). В терминале сразу откроется чат: напишите сообщение и нажмите Enter. `/help` покажет команды, `/quit` закроет чат. Чтобы вернуться к истории, узнайте её ID через `rp-core sessions` и выполните `rp-core chat <id>`. Для полноэкранного интерфейса используйте `rp-core tui <id>` или добавьте `--tui` к `rp-core new`. В TUI нажмите **F4**, чтобы выбрать модель рассказчика из настроенных подключений.

## Импорт

Для карточек, пресетов и лорбуков `rp-core import <файл>` добавляет файл в библиотеку и выводит его ID. Такой файл можно также передать прямо в `rp-core new`.

| Что импортировать | Команда | Как использовать |
|---|---|---|
| Карточка персонажа (PNG/JSON) | `rp-core import ./character.png` | `rp-core new --card <id>` |
| Пресет SillyTavern **Chat Completion** (JSON) | `rp-core import ./preset.json` | `rp-core new --card <id-карточки> --preset <id-пресета>` |
| Лорбук SillyTavern (JSON) | `rp-core import ./world.json` | `rp-core new --card <id-карточки> --lore <id-лорбука>` |

**Персона.** Создайте JSON-файл и передайте его при создании истории:

```json
{"name": "Ника", "description": "Путешественница и картограф", "aliases": ["Nika"]}
```

```bash
rp-core new --card ./character.png --persona ./persona.json
```

Отдельная команда `rp-core import` для персоны не нужна: `--persona` читает файл при создании сессии. Персона из экспорта RoleCall импортируется вместе с историей.

**История чата из SillyTavern.** Экспортируйте одиночный чат из SillyTavern в `.jsonl`. Сначала импортируйте карточку персонажа: её нет в файле чата.

```bash
rp-core import ./character.png                 # запомните ID карточки
rp-core import ./chat.jsonl --card <id-карточки> --dry-run
rp-core import ./chat.jsonl --card <id-карточки>
rp-core chat <id-сессии-из-вывода>
```

Импорт сохраняет сообщения, свайпы, выбранный вариант и скрытые сообщения. Через `--persona ./persona.json` можно задать полную персону, а через `--model conn:model` — модель рассказчика. Групповые чаты пока не поддерживаются.

**История чата из RoleCall.** В RoleCall экспортируйте историю как **RoleCall (.rolecall zip)**, затем выполните:

```bash
rp-core import ./story.rolecall --dry-run
rp-core import ./story.rolecall
rp-core chat <id-из-вывода-импорта>
```

По умолчанию импортируется основная ветка; `--chat all` добавит остальные. Отдельный JSONL-экспорт RoleCall и произвольные архивы чатов не поддерживаются.

Подробности о настройках, командах чата, форматах импорта и устранении ошибок — в [полном руководстве](docs/USER-GUIDE.md). Архитектура описана в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Лицензия: [AGPL-3.0-or-later](LICENSE).

