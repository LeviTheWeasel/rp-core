# rp-core

A headless roleplay agent core, with a terminal chat on top. You give it a character card and a
model (local or remote); it keeps the story as a tree of messages with swipes, branches and crash
recovery, builds the prompt with SillyTavern semantics, and streams the answers.

- **Status:** milestone **M1b**. You can play in the terminal against Ollama, llama.cpp, LM Studio,
  koboldcpp, vLLM, OpenRouter or DeepSeek (any OpenAI-compatible server).
- **Built with:** TypeScript on [Bun](https://bun.sh), with zero runtime dependencies.
- **Licence:** AGPL-3.0-or-later.
- **Design:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (in Russian).

## Contents

1. [What works today](#what-works-today)
2. [Install](#install)
3. [Quick start with Ollama](#quick-start-with-ollama)
4. [Connecting Ollama, in detail](#connecting-ollama-in-detail)
5. [Playing in the chat](#playing-in-the-chat)
6. [Editing messages and choosing an editor](#editing-messages-and-choosing-an-editor)
7. [Other servers: llama.cpp, LM Studio, OpenRouter and friends](#other-servers)
8. [config.toml reference](#configtoml-reference)
9. [One-shot commands and scripting](#one-shot-commands-and-scripting)
10. [Where your data lives](#where-your-data-lives)
11. [Troubleshooting](#troubleshooting)
12. [Command reference](#command-reference)
13. [Development](#development)

## What works today

**Works now (M1b):**

| Area | What you get |
|---|---|
| Characters | Character cards from PNG or JSON (CCv1/V2/V3), with alternate greetings, the embedded lorebook, `system_prompt`, `post_history_instructions` and `depth_prompt` |
| Chat | A streaming chat in the terminal |
| Story tree | Swipes and guided re-rolls, continue, edit, hide, rewind, branches (tails) and forks |
| Models | Switch the model in the middle of a session (`/model`) |
| Notes | Author's note |
| Safety | Ctrl+C stops an answer and keeps what arrived; after a crash or `kill -9` the answer comes back as `[interrupted]` |
| Inspection | `/trace` shows what went into the prompt; `/usage` shows tokens and cost |
| Scripting | One-shot commands with JSON events, and a scripted fake model for tests |

**Not yet:**

| Milestone | Arrives |
|---|---|
| M2 | Lorebook activation by keys, importing SillyTavern presets and world info |
| M3 | Tools and history search |
| M4 | The Story Director |
| M5 | The Compendium (memory) |
| M6 | `--stdio` for other UIs |
| M7, M8 | Native Anthropic, then native Gemini |

The character's embedded lorebook is imported and kept, but it does not fire until M2.

## Install

You need **Bun 1.3 or newer** and this repository.

**1. Install the dev tools.** This step is only needed for tests and the typecheck: rp-core itself
has no runtime dependencies.

```bash
cd ~/Documents/AI/rp-core
```

```bash
bun install
```

**2. Make the `rp-core` command available everywhere.** This links the repository into Bun's global
folder, `~/.bun/bin`, which must be on your `PATH`. The command always runs the current code of
this folder, so a `git pull` needs no reinstall.

```bash
bun link
```

```bash
rp-core --version
```

To undo it later, run `bun unlink` in this folder.

**Without linking**, you can call the script directly as `bun ~/Documents/AI/rp-core/src/cli/main.ts`,
or define an alias for it:

```bash
alias rp-core='bun ~/Documents/AI/rp-core/src/cli/main.ts'
```

## Quick start with Ollama

This assumes Ollama is running (`ollama serve`, or the system service) and has at least one model
(`ollama list`).

**1. Create the config file.** This writes a commented starter to `~/.rp-core/config.toml`. It never
overwrites an existing file.

```bash
rp-core init
```

**2. See what the server has.** The starter config already contains a connection named `ollama` at
`http://127.0.0.1:11434`.

```bash
rp-core models ollama
```

**3. Tell rp-core the real context window.** Edit `~/.rp-core/config.toml` and add a block for the
model you will use. Without it, a long card or a long story gets cut by Ollama without warning; see
[the next section](#connecting-ollama-in-detail) for why.

```toml
[caps."ollama:hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M"]
context_length = 4096
```

**4. Start a story.** The chat opens right away.

```bash
rp-core new --card ~/cards/mira.png --model "ollama:hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M"
```

- **Write a message:** type and press Enter.
- **Help:** `/help` lists the commands.
- **Leave:** `/quit`.
- **Come back later:** `rp-core chat <session>`. `rp-core sessions` lists the session ids.

## Connecting Ollama, in detail

### The connection

The starter config has it already:

```toml
[connections.ollama]
dialect = "openai-chat"
base_url = "http://127.0.0.1:11434"
local = true
```

A model is named in a binding as `"<connection>:<model id>"`, for example
`"ollama:strovolos-magmell-v12:latest"`. The binding is split at the **first** colon, so model ids
that contain colons work. Use the exact id that `rp-core models ollama` (or `ollama list`) prints.

To make a model the default for new sessions, set it under `[roles]` (then `--model` can be left
out):

```toml
[roles]
narrator = "ollama:strovolos-magmell-v12:latest"
```

### The context window: the one thing to get right

Ollama serves every model with its own runtime window, `num_ctx`. It is **4096 tokens unless you
change it**, and the OpenAI-compatible API does not report it. rp-core therefore cannot know it on
its own: it assumes 8192 for a local server and warns you once the server starts cutting
(`context_truncated_by_server`).

A short budget also has a direct cost. rp-core keeps part of the window for the answer: at most
2048 tokens, and never more than half the window. So with a 4096 window, the prompt gets only about
2048 tokens. That covers the card, the greeting, your message and the history together. A rich card
alone can exceed that. Then the turn is refused with:

```
✗ the answer failed (request/context_length_exceeded): the required part of the prompt needs about
  5301 tokens, but only 2048 are available (window 4096 - reply reserve 2048)
```

Your message stays in the session: fix the window, then press `/r` to ask for the answer.

**Give the model a bigger window.** You can do this per model or for the whole server.

**Per model (recommended): a Modelfile variant.** It reuses the same weights, so nothing is
downloaded again.

```bash
printf 'FROM hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M\nPARAMETER num_ctx 16384\n' > /tmp/magmell-16k.Modelfile
```

```bash
ollama create magmell-16k -f /tmp/magmell-16k.Modelfile
```

This creates `magmell-16k:latest`. Use that id in bindings and in the `[caps]` block.

**For the whole server: the `OLLAMA_CONTEXT_LENGTH` variable.** With the systemd service, open its
override file:

```bash
sudo systemctl edit ollama
```

Add these lines:

```ini
[Service]
Environment="OLLAMA_CONTEXT_LENGTH=16384"
```

Then restart the service:

```bash
sudo systemctl restart ollama
```

**Then tell rp-core the same number:**

```toml
[caps."ollama:magmell-16k:latest"]
context_length = 16384
```

**Memory.** A bigger window costs VRAM for the KV cache: roughly 160 KiB per token for a 12B Mistral
Nemo model, so about 2.5 GiB for 16k. After the first answer, `ollama ps` shows whether the model
still runs `100% GPU`. If part of it spilled to the CPU, answers get much slower; use 12288 or 8192
instead.

### Checking it

```bash
rp-core probe "ollama:magmell-16k:latest"
```

`probe` prints:

- the server kind;
- the models;
- the window, which Ollama reports only while the model is loaded;
- the capabilities rp-core will use: `context 16384`, how prompts are shaped, and which sampler
  fields are sent.

`--write` stores what the server said in `~/.rp-core/caps-cache.json` for later turns.

**First-answer latency.** The first answer after Ollama loads a model takes a few seconds while the
model loads. Later answers start in well under a second, because Ollama keeps the prompt cached.

## Playing in the chat

### Starting a session

```bash
rp-core new --card <file or library id> [--model conn:model] [--persona me.json] [--max-tokens 400] [--title "..."]
```

- **The card.** `--card` takes a PNG or JSON card. The card is imported into your library first;
  later sessions can name it by its library id (`rp-core import card.png` prints it).
- **Your persona.** `--persona` is a small JSON file: `{"name": "Ника", "description": "...",
  "aliases": ["Nika"]}`. It fills `{{user}}` in the card and greetings. Without it, `{{user}}` is
  `User`.
- **Reply length.** `--max-tokens` caps the length of the answers.
- **Without opening the chat.** With `--no-chat`, or when not on a terminal, `new` only prints the
  session id.

### What you see

```
session s_4c55fe7e · Maren Vell · narrator ollama:magmell-16k:latest (tools: off) · ctx 16384
Maren Vell › *The chest sat in the middle of the flooded nave…*
  [greeting 1/7]   /r next greeting  /[ /] browse
you        › "I'm not Corvin," I say and step closer.
Maren Vell › …
  [swipe 1/1 · 312 tok · 5.8s · end]   /r swipe  /c continue  /e edit
```

- **Status line.** After every answer: which version of the answer you are looking at, its length,
  the time it took, and why it ended. `length` means it hit the token cap; `/c` continues it.
- **Actions.** `*actions*` are shown in italics.
- **Reasoning.** A model's reasoning is folded to one dim line; `/think show` unfolds it.

### Commands

| Command | What it does |
|---|---|
| *(any text)* | Your message; the character answers |
| `/r` | **Swipe**: a new version of the last answer. On a greeting it shows the next greeting; on your own unanswered message it asks for the answer |
| `/regen <direction>` | A guided swipe: a new version that follows your direction, e.g. `/regen she is angrier` |
| `/[`  `/]` | Previous / next version of the last message |
| `/c` | Continue the last answer from where it stopped |
| `/e [n]` | Edit message *n* (default: the last one); see [the next section](#editing-messages-and-choosing-an-editor) |
| `/hide n`, `/unhide n` | Leave message *n* out of the prompt, or bring it back. Nothing is ever deleted |
| `/show` | The story so far, numbered; the numbers are what `/e`, `/hide` and `/rewind` take |
| `/rewind n` | Go back to message *n*; your next message starts a new branch |
| `/tails` | List the branches that leave the current path; `/goto <id>` switches to one |
| `/fork [n]` | Copy the story (up to message *n*) into a new session and open it |
| `/model [role] [connection:model]` | Show the models, or change one: `/model narrator ollama:magmell-16k:latest`. The change is saved in the session |
| `/note <text> [@depth]`, `/note off` | The author's note, inserted *depth* messages from the end (default 4) |
| `/think show`, `/think hide` | Show the model's reasoning, or fold it |
| `/usage` | Tokens and cost of the current path (cost needs `[prices]` or a server that reports it) |
| `/trace` | What the last answer's prompt held: window, reserve, size, what was trimmed |
| `/sessions`, `/open <id>` | List sessions, switch to one |
| `/help`, `/quit` | Help, leave |

To send a message that starts with `/`, start it with `//` instead.

### Swipes, branches and forks

The story is a tree, and nothing is overwritten:

- **A swipe** is a sibling of the answer it replaces. `/[` and `/]` walk between the versions.
- **`/rewind`** plus a new message grows a new branch from an earlier point. The old continuation
  stays as a *tail*; `/tails` lists them and `/goto` returns to one.
- **`/fork`** copies the path into a separate session, so two versions of a story can go on
  independently.

### Ctrl+C and crashes

- **During an answer:** Ctrl+C stops it and keeps what arrived, marked `[stopped]`. Text you typed
  meanwhile comes back at the prompt.
- **Typing during an answer:** a line you send waits until the answer ends, then goes out.
- **At the prompt:** Ctrl+C clears the typed line; pressing it twice on an empty prompt quits.
- **After a crash:** if the terminal closes or the process is killed mid-answer, the next
  `rp-core chat <session>` recovers that answer as `[interrupted]`. You lose at most about a second
  of text.

## Editing messages and choosing an editor

`/e [n]` edits message *n* (default: the last). How depends on whether you named an editor.

### Default: editing in place

If neither `$VISUAL` nor `$EDITOR` is set, the message is put into the chat's input line, ready to
edit:

```
editing in place: Enter saves · Ctrl+C cancels · ⏎ is a line break · set $EDITOR to use an editor
edit       › "Well," Maren said⏎⏎Her boots tapped a staccato rhythm…
```

- **Enter** saves; **Ctrl+C** cancels.
- **Line breaks** show as `⏎`, because one input line cannot hold them. Keep them where they are, or
  copy and paste a `⏎` to add one; they become real line breaks on save.
- **Long lines** are fine: the line wraps. Home/End (or Ctrl+A/Ctrl+E) jump to the start and end.

This works in every terminal, Warp included, because the chat itself reads the keys.

### Using an editor

Set `$VISUAL` or `$EDITOR`. `$VISUAL` wins when both are set; an empty value counts as unset. `/e`
then saves the message to a temporary file, runs the editor on it, and reads it back when the
editor exits.

**Just for one session:**

```bash
EDITOR=nano rp-core chat s_4c55fe7e
```

**For every session:** add the line to `~/.bashrc` (or `~/.zshrc`), then open a new terminal.

```bash
export EDITOR=nano
```

The value is a shell snippet, as in git, so arguments are allowed. The file name is added at the
end.

| Editor | `EDITOR=` | Notes |
|---|---|---|
| nano | `nano` | Ctrl+O, Enter saves; Ctrl+X quits |
| vim / vi | `vim` | Esc, then `:wq` saves and quits; `:q!` quits without saving |
| VS Code | `code --wait` | `--wait` is required: without it rp-core reads the file before you edit it |
| Zed | `zed --wait` | same |
| Sublime Text | `subl -w` | same |
| Kate | `kate --block` | same |

- **Graphical editors** must wait until you close the file or window. The `--wait`-style flags in
  the table make them do that. A graphical editor also avoids every terminal quirk.
- **Cancelling:** quit the editor without saving, or with an error (vim `:cq`), and the edit is
  cancelled. A file left unchanged changes nothing.
- **Warp:** a terminal editor started from inside the chat may not get the keyboard. Your keys show
  up as lines under the editor and never reach it. Use the default in-place editing, or a graphical
  editor. If you are already stuck, close the editor from another terminal with `pkill -f
  rp-core-edit`; the edit is cancelled and the chat goes on.

## Other servers

Every server that speaks the OpenAI Chat Completions API works through the `openai-chat` dialect.
rp-core ships presets for the common ones: which fields each accepts, how it streams usage and
reasoning, how a reply prefill is sent. You rarely need overrides.

```toml
# llama.cpp: llama-server -m model.gguf --port 8080 -c 16384
[connections.llamacpp]
base_url = "http://127.0.0.1:8080"
max_in_flight = 1                # 2 only with -np 2 --no-kv-unified

# LM Studio: Developer tab, Start server
[connections.lmstudio]
base_url = "http://127.0.0.1:1234"

# koboldcpp
[connections.kobold]
base_url = "http://127.0.0.1:5001"

# OpenRouter: the key comes from an environment variable
[connections.openrouter]
base_url = "https://openrouter.ai/api"
key_env = "OPENROUTER_API_KEY"

# DeepSeek, key from the desktop keyring
# (store it once: secret-tool store --label=rp-core service rp-core conn deepseek)
[connections.deepseek]
base_url = "https://api.deepseek.com/beta"
key_cmd = ["secret-tool", "lookup", "service", "rp-core", "conn", "deepseek"]
```

- **Context window.** For llama.cpp and LM Studio the window is what you started the server with
  (`-c` / the context slider). `rp-core probe` reads it from llama.cpp's `/props`.
- **Remote servers** get 4 requests in flight by default; local ones get 1.
- **Switching mid-story:** `/model narrator openrouter:<model id>`. The next answer comes from the
  new model; the story stays the same.

**Keys never go into the config file.** A key comes from one of two places:

- an environment variable (`key_env`);
- a command that prints it (`key_cmd`). The command runs without a shell, with a 10 s timeout.

Fields that look like keys (`api_key`, `token`, `password`, …) are refused. Keys never reach session
files, events or output. Error messages are fixed sentences, and a server's own words are shown only
with `--debug`, with keys and header values replaced by `[redacted]`.

## config.toml reference

`rp-core init` writes a commented file with every option. In short:

| Table | Holds |
|---|---|
| `[connections.<name>]` | One per server. Fields: `dialect` (`"openai-chat"`), `base_url`, `key_env`, `key_cmd`, `max_in_flight` (1–64), `local` (overrides the guess from the URL), `headers` (header name → *name of the env variable* holding its value), `extra_body` (fields added to every request; `model`, `messages`, `stream`, `tools`, `tool_choice` are protected), `exclude_body`. Names may hold letters, digits, `_` and `-`, never `:` |
| `[roles]` | Defaults for new sessions: `narrator = "conn:model"`, `narrator_fallback`, and `director`/`recorder`/`recall` (later milestones; they may say `"narrator"`). A session keeps its own copy; `/model` changes it there |
| `[narrator]` | `max_rounds` (tool rounds, M3) and `prefill_vs_tools` (`"prefill"` or `"tools"`: which wins when a preset prefill meets tools) |
| `[director]`, `[compendium]` | Reserved for M4 and M5 |
| `[caps."conn:model"]` | Your corrections to what rp-core believes about a model: `context_length`, `max_output`, `tools`, `prefill`, `mid_system`, `alternation`, `reasoning`, `samplers_accepted`, `stream_usage`, `max_in_flight`, `extra_body`, … Override only after checking (`rp-core probe` shows the current values) |
| `[prices."conn:model"]` | `in_per_m`, `out_per_m` (USD per million tokens) and `as_of` (a quoted date) for the cost in `/usage` |

Dates must be quoted strings (`as_of = "2026-10-26"`): a bare TOML date is refused. A broken file
makes the commands that read it (`new`, `chat`, `send`, `probe`, `models`) exit with code 64 and name
the file, the line and the key. `sessions`, `show` and `import` do not need it.

## One-shot commands and scripting

You can run a turn without the chat:

```bash
id=$(rp-core new --card card.png --model ollama:magmell-16k:latest --no-chat)
```

```bash
rp-core send "$id" "Hello there"
```

| Command | What it does |
|---|---|
| `rp-core send "$id" "Hello there"` | Streams one answer |
| `rp-core send "$id" --kind swipe` | A sibling answer |
| `rp-core send "$id" --kind swipe --guidance "colder"` | A guided swipe |
| `rp-core send "$id" --kind continue` | Extends the last answer |
| `rp-core send "$id" "Hi" --json` | The turn's events, one JSON object per line |
| `rp-core show "$id"` | The active path; safe to run while another process plays |

- **`--json`** prints events: `start`, then `text`… deltas, then `changed` and `done`, or `stopped` /
  `failed`. These are the events a UI will consume.
- **Piped input** to `chat` works as a script: each line waits for the previous answer.

  ```bash
  printf 'Hi\n/r\n/quit\n' | rp-core chat "$id"
  ```

- **No model at all.** `--provider script:<file>` replaces every model with a scripted one, which is
  useful for trying the flow and for tests. The file is JSONL: each line is one model call, written
  as a JSON array of steps:

  ```json
  [{"text": "Hello, "}, {"delay": 300}, {"text": "traveller."}]
  [{"error": {"code": "rate_limited", "status": 429}}]
  ```

  The step types are `text`, `reasoning`, `delay` (ms), `pause`, `error`, `usage`, `cut` (end the
  stream abruptly) and `finish`. Each process starts the script from its first line.

## Where your data lives

Everything is under `~/.rp-core`. Change it with `--home <dir>` or `RP_CORE_HOME`; `--sandbox` uses
a temporary folder that is removed at exit.

```
~/.rp-core/
  config.toml          connections, roles, overrides, prices (no secrets)
  caps-cache.json      what `probe --write` learned
  library/characters/  imported cards in the native format
  sessions/<id>.jsonl  one session = one append-only journal
  sessions/<id>.lock   held while a process has the session open
```

A session file is plain JSONL that only ever grows. Everything in it stays recoverable: every swipe,
edit and hidden message is still there. Back it up by copying the file.

## Troubleshooting

| You see | What it means | Do |
|---|---|---|
| `context_length_exceeded … only 2048 are available (window 4096 …)` | The card plus your message do not fit the window | Give the model a bigger window ([details](#the-context-window-the-one-thing-to-get-right)) and set `context_length`; or lower `--max-tokens`. Then `/r` |
| notice `context_truncated_by_server` | The server cut the prompt: its real window is smaller than rp-core thinks | Set `[caps."conn:model"] context_length` to the server's window |
| answers stop mid-sentence, status says `length` | The reply hit the token cap | `/c` continues; raise `--max-tokens` for new sessions |
| `no_connection` | The session's binding names a connection that is not in `config.toml` | Check the connection name, or `/model narrator <conn:model>` |
| `session_locked` | Another process has the session open | Close the other chat. A lock left by a crashed process is taken over automatically |
| `the server refused the API key` / `key_unavailable` | Wrong key, unset `key_env`, or a failing `key_cmd` | Check the variable or command; `--debug` shows the server's words, redacted |
| `/e` opens vi and keys do nothing | A terminal editor inside the chat in a terminal like Warp | Unset `$EDITOR` to edit in place, or use a graphical editor ([details](#using-an-editor)) |
| The first answer takes several seconds | The server is loading the model | Normal; later answers start fast |
| The character answers in English to a Russian message | The card and the model, not rp-core | Write the card in Russian, or say so in the first message or in `/note` |

Add `--debug` to any command to see raw server errors and stack traces on stderr; secrets are
redacted.

## Command reference

| Command | What it does |
|---|---|
| `init [--json]` | Writes the starter `config.toml` unless one exists; prints its path |
| `new --card <file\|library id> [--model conn:model] [--max-tokens n] [--persona <json>] [--title t] [--no-chat] [--json] [--provider script:<f>]` | Imports the card and creates a session; opens the chat on a terminal, else prints the id (`--json`: `{sessionId, title, greetings}`) |
| `chat <session> [--provider script:<f>]` | The chat on a session (lock and crash recovery first) |
| `import <file> [--as name] [--json]` | Imports a card into the library; prints its id |
| `send <session> [text] [--kind reply\|swipe\|continue] [--guidance t] [--json] [--provider script:<f>]` | One turn. `reply` needs text (`-` reads stdin); `swipe` and `continue` take none |
| `probe [conn[:model]] [--write] [--json]` | The server's catalog: kind, models, windows, slots (advice only) and the caps a model gets; `--write` stores it |
| `models <conn> [--json]` | The connection's model ids |
| `sessions [--json]` | Sessions, newest first |
| `show <session> [--json]` | The active path with markers `[interrupted]`, `[stopped]`, `[hidden]`, `[edited]`. Never takes the lock |

**Global flags** may go anywhere on the line: `--home <dir>`, `--sandbox`, `--debug`, `--help`
(also `rp-core help <command>`) and `--version`.

**Output channels.** stdout carries only the product: the answer text, streamed and ending with a
newline. With `--json` it carries events as JSONL instead: the session's open events first
(`recovered`, `notice`), then the turn's. Everything meant for humans goes to stderr.

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | done |
| `1` | other error (unreadable card or script, missing session, unreachable server for `probe`/`models`) |
| `2` | stopped |
| `3` | failed |
| `4` | conflict |
| `5` | refused before the turn opened; stderr ends with `{"type":"refusal","code":…,"message":…}` |
| `64` | usage or `config.toml` error |
| `130`, `143` | SIGINT, SIGTERM |

## Development

**Checks:**

| Command | What it runs |
|---|---|
| `bun test` | The full suite, about 1500 tests |
| `RP_CORE_SKIP_SLOW=1 bun test` | Without the ~30 s fetch long-pause tests |
| `bunx tsc --noEmit -p .` | The typecheck |
| `RP_CORE_LIVE=1 bun test test/adapter/live-ollama.test.ts` | One short call to a real Ollama. Set the model with `RP_CORE_OLLAMA_MODEL` and the URL with `RP_CORE_OLLAMA_URL` |

**Code layout:**

| Folder | Holds |
|---|---|
| `src/engine` | Turns, recovery, scheduling |
| `src/session` | The journal, tree and views |
| `src/prompt` | Assembly, macros, shaping, budget |
| `src/providers` | Transport, the openai-chat adapter, capability data, the scripted provider |
| `src/formats` | Cards, world info, library |
| `src/config` | Config and keys |
| `src/cli` | Commands and the chat |

The design and its decisions (D-1…D-89) are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The
milestone demos with transcripts and timings are [`docs/M1A-DEMO.md`](docs/M1A-DEMO.md) and
[`docs/M1B-DEMO.md`](docs/M1B-DEMO.md).

**Ported code.** Code taken from RoleCall and Bunraku keeps its copyright headers and is listed in
[`PROVENANCE.md`](PROVENANCE.md).

**Contributing.** Sign off every commit (`git commit -s`, Developer Certificate of Origin). Before
the first outside contribution, the RoleCall team signs `docs/TEAM-LICENSING.md` (ARCHITECTURE.md
§2, D-34).

## Licence

AGPL-3.0-or-later. See [`LICENSE`](LICENSE).
