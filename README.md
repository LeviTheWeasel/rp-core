# rp-core

**English** · [Русский](README-ru.md)

rp-core is a terminal chat for roleplay stories with local or remote models. It reads character cards, keeps message swipes and branches, supports SillyTavern presets and lorebooks, and can continue a story exported from RoleCall.

## Install

You need [Bun](https://bun.sh) **1.3 or newer** (**1.3.14 or newer** for the full-screen UI) and this repository.

```bash
git clone https://github.com/LeviTheWeasel/rp-core.git
cd rp-core
bun install
bun link
rp-core --version
```

`bun link` puts the `rp-core` command in `~/.bun/bin`. If your shell cannot find it, add that directory to `PATH` or run `bun src/cli/main.ts` from the repository.

## Configure a model

Start your model server and create the config file:

```bash
rp-core init
rp-core models ollama
```

`rp-core init` creates `~/.rp-core/config.toml` without overwriting an existing file. It includes a local Ollama connection. Set the default narrator to the exact model ID printed by `rp-core models ollama`:

```toml
[roles]
narrator = "ollama:model-name"

[caps."ollama:model-name"]
context_length = 16384
```

Set `context_length` to the context window the server **actually** uses. With Ollama, increase `num_ctx` on the server if needed. You can instead choose a model per story with `rp-core new --model ollama:model-name`. The config also includes llama.cpp, LM Studio and OpenRouter connections. For a remote server, provide its API key through an environment variable (`key_env`), not in the config file.

## Start a chat

```bash
rp-core new --card ./character.png --model "ollama:model-name"
```

The card may be PNG or JSON (CCv1/V2/V3). In a terminal, the chat opens immediately. Type a message and press Enter; `/help` lists commands and `/quit` exits. Run `rp-core sessions` to find a session ID, then `rp-core chat <id>` to return to it. Use `rp-core tui <id>` for the full-screen UI, or add `--tui` to `rp-core new`. In the TUI, press **F4** to choose a narrator model from your configured connections.

## Import files

`rp-core import <file>` adds a supported file to your library and prints its ID. You can also pass a file directly to `rp-core new`, which imports it while creating the story.

| File | Import command | Use it with |
|---|---|---|
| Character card (PNG/JSON) | `rp-core import ./character.png` | `rp-core new --card <id>` |
| SillyTavern **Chat Completion** preset (JSON) | `rp-core import ./preset.json` | `rp-core new --card <card-id> --preset <preset-id>` |
| SillyTavern lorebook (JSON) | `rp-core import ./world.json` | `rp-core new --card <card-id> --lore <lorebook-id>` |

**Persona.** Create a JSON file and pass it when starting a story:

```json
{"name": "Nika", "description": "A traveller and cartographer", "aliases": ["Ника"]}
```

```bash
rp-core new --card ./character.png --persona ./persona.json
```

There is no separate `rp-core import` command for a persona: `--persona` reads the file when the session is created. A RoleCall export imports its persona with the story.

**RoleCall chat history.** In RoleCall, export the story as **RoleCall (.rolecall zip)**, then run:

```bash
rp-core import ./story.rolecall --dry-run
rp-core import ./story.rolecall
rp-core chat <session-id-from-import-output>
```

The main chat is imported by default; use `--chat all` to include other branches. Standalone RoleCall JSONL exports and arbitrary chat archives are not supported.

For configuration, chat commands, import details and troubleshooting, see the [full guide](docs/USER-GUIDE.md). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the architecture. License: [AGPL-3.0-or-later](LICENSE).
