# rp-core: full guide

A headless roleplay agent core, with a terminal chat on top. You give it a character card and a
model (local or remote); it keeps the story as a tree of messages with swipes, branches and crash
recovery, builds the prompt with SillyTavern semantics, and streams the answers.

- **Status:** milestone **M5b**. You can play in the terminal against Ollama, llama.cpp, LM Studio,
  koboldcpp, vLLM, OpenRouter or DeepSeek (any OpenAI-compatible server), with SillyTavern presets
  and lorebooks. The narrator can search the story and the lore before it answers, and you can give
  it notes to remember. The [Compendium](#the-compendium) keeps typed world knowledge (characters,
  places, items…) from RoleCall exports, from your own entries and, in the background, from the
  story itself: a filing agent writes down what each answer established, and a historian summarises
  the story for the narrator once old messages leave its prompt. The narrator gets the entries the
  story names. A Story Director can plan the story before each answer (off by default). A story
  begun in RoleCall [goes on here](#continuing-a-rolecall-story) from its export.
  Besides the line chat there is a [full-screen TUI](#the-full-screen-tui) with the models, the chat
  and the agents side by side.
- **Built with:** TypeScript on [Bun](https://bun.sh), with four runtime dependencies: `re2js`
  (regex lorebook keys), `gpt-tokenizer` (token counts), `jsonrepair` (broken tool-call arguments)
  and `@opentui/core` (the full-screen TUI only).
- **Licence:** AGPL-3.0-or-later.
- **Design:** [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) (in Russian).

## Contents

1. [What works today](#what-works-today)
2. [Install](#install)
3. [Quick start with Ollama](#quick-start-with-ollama)
4. [Connecting Ollama, in detail](#connecting-ollama-in-detail)
5. [Playing in the chat](#playing-in-the-chat)
6. [The full-screen TUI](#the-full-screen-tui)
7. [Editing messages and choosing an editor](#editing-messages-and-choosing-an-editor)
8. [Presets and lorebooks](#presets-and-lorebooks)
9. [Importing a SillyTavern chat](#importing-a-sillytavern-chat)
10. [Continuing a RoleCall story](#continuing-a-rolecall-story): [exporting it](#exporting-the-story-from-rolecall),
   [what comes over](#what-comes-over), [when it does not fit](#when-the-story-does-not-fit)
11. [Tools and search](#tools-and-search)
12. [Notes](#notes)
13. [The Compendium](#the-compendium): [its background agents](#the-background-agents), the
    [`{{recap}}` slot](#the-recap-slot), [the /memory commands](#the-memory-commands), [the keys](#the-compendium-keys)
14. [The Story Director](#the-story-director)
15. [Other servers: llama.cpp, LM Studio, OpenRouter and friends](#other-servers)
16. [Active probes](#active-probes)
17. [config.toml reference](#configtoml-reference)
18. [One-shot commands and scripting](#one-shot-commands-and-scripting)
19. [Recording and replaying a chat](#recording-and-replaying-a-chat)
20. [Where your data lives](#where-your-data-lives)
21. [Troubleshooting](#troubleshooting)
22. [Command reference](#command-reference)
23. [Development](#development)

## What works today

**Works now (M5b, the M4.5 TUI and the RoleCall story import):**

| Area | What you get |
|---|---|
| Characters | Character cards from PNG or JSON (CCv1/V2/V3), with alternate greetings, the embedded lorebook, `system_prompt`, `post_history_instructions` and `depth_prompt` |
| Presets | SillyTavern chat-completion presets: prompt order, markers, samplers, prefill, formats (`/preset`) |
| Lorebooks | SillyTavern world info and card books, activated as in SillyTavern: keys and `/regex/` keys, secondary keys, recursion, inclusion groups, probability, sticky, cooldown, delay, positions and depths, the budget (`/lore`) |
| Chat | A streaming chat in the terminal |
| Full-screen TUI | `rp-core tui`: the models and the hotkeys, the chat, and the agents with their tool calls in three columns; the same commands as the chat, plus hotkeys, mouse scrolling and copying, `**bold**` and `*italic*` in answers without their asterisks, colours from your terminal's theme |
| Story tree | Swipes and guided re-rolls, continue, edit, hide, rewind, branches (tails) and forks |
| Models | Switch the model in the middle of a session (`/model`) |
| Tools and search | The narrator looks up earlier messages and lore before it answers, with the server's own tool calling or with calls written as text; `/search` runs the same search for you |
| Notes | Author's note; your own notes for the narrator (`/memory add`), sent when their keys come up |
| Compendium | Typed entries of 11 kinds (characters, places, items, events, plots…) from RoleCall Compendium exports and from your own `/memory new`. Each answer, the entries the story names go to the narrator in one block, short or whole by the window; the Director sees the characters and places in the scene. You edit library entries without touching the book, and export the session's entries as a lorebook or a RoleCall file (`/memory`) |
| Compendium agents | In the background, between turns: a filing agent writes what each accepted answer established into the Compendium, and a historian writes summaries and `[Arc]` overviews of the story. Once old messages leave the prompt, the `{{recap}}` slot gives the narrator those overviews and summaries. Swipes and rewinds take an answer's records off the path, edits file it again; `/memory undo`, `refile`, `retry`, `wait` and `status` steer the work. On a local server they wait until you pause, and a turn never waits for them |
| Story Director | Before each answer, a second model call plans chapters, arcs, seeds and hidden arcs and gives the narrator a directive for this turn. Off by default; `/director on` turns it on, `/director` shows its plan |
| RoleCall stories | `rp-core import <story>.rolecall` continues a story from RoleCall's export: the character, the persona, the preset with the chat's own settings and the lorebooks (identical ones once) go to the library, then each chat you pick (the main one by default) becomes a session with every swipe, the reasoning split off as RoleCall did, the Director's state and the Compendium on from the import. A dry run first, all or nothing, and a warning when the story does not fit the narrator's window ([details](#continuing-a-rolecall-story)) |
| SillyTavern chats | `rp-core import <chat>.jsonl --card <library id>` continues a solo chat, keeping its messages, swipes, selected versions and hidden lines ([details](#importing-a-sillytavern-chat)) |
| Safety | Ctrl+C stops an answer and keeps what arrived; after a crash or `kill -9` the answer comes back as `[interrupted]` |
| Inspection | `/trace` shows what went into the prompt, which lore fired and why the rest did not, which Compendium entries were picked, what the `{{recap}}` slot held, and the tool rounds; `/preview` prints the exact request before it is sent; `--keep-requests` keeps every request of a turn as a file; `/lore test` explains every lore entry; `/usage` shows tokens and cost; `rp-core probe --active` tests what a model can do |
| Scripting | One-shot commands with JSON events, a scripted fake model for tests, and recording and replaying real model calls; `rp-core compact` shrinks a session's journal |

**Not yet:**

| Milestone | Arrives |
|---|---|
| M5c | Recall: a model picks the Compendium entries before each answer (or ahead of it, between turns, on a local server); `/memory recall`, `profile`, `mode`; slot pinning on llama.cpp and latency measurements ([details](#not-in-m5b-yet)) |
| M6 | `--stdio` for other UIs |
| M7, M8 | Native Anthropic, then native Gemini |

## Install

You need **Bun 1.3 or newer** and this repository. The full-screen TUI needs **Bun 1.3.14 or newer**
(its library, OpenTUI, asks for it; we test on 1.3.14).

**1. Install the dependencies.** This fetches the four runtime dependencies (`re2js`,
`gpt-tokenizer`, `jsonrepair`, `@opentui/core`) and the dev tools for tests and the typecheck.
OpenTUI is the big one: about 28 MB on disk on Linux x64 with its native libraries, plus
`web-tree-sitter` (about 6 MB), which Bun installs with it. Only the TUI loads it.

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
- **Come back later:** `rp-core chat <session>`, or `rp-core tui <session>` for the
  [full-screen TUI](#the-full-screen-tui). `rp-core sessions` lists the session ids.

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

A short budget also has a direct cost. rp-core keeps part of the window for the answer, never more
than half of it: the reply length you set (`--max-tokens` at `new`, which goes into the session's
narrator binding), else the preset's (a SillyTavern preset's `openai_max_tokens`), else 2048 (8192
on a window of 24576 tokens or more). So with a 4096 window, the prompt gets only about 2048 tokens.
That covers the card, the greeting, your message and the history together. Old history goes first;
the greeting goes last, as in SillyTavern (a notice says so). A rich card alone can exceed that.
Then the turn is refused with:

```
✗ the answer failed (request/context_length_exceeded): the required part of the prompt needs about
  5301 tokens, but only 2048 are available (window 4096 - reply reserve 2048): the preset's blocks
  5271 (lore included: 0 of its budget 512), your current message 30; the greeting (571 tokens) is
  already left out
```

Your message stays in the session: fix the window, then press `/r` to ask for the answer.

**Give the model a bigger window.** You can do this per model or for the whole server.

**Per model (recommended): a Modelfile variant.** It reuses the same weights, so nothing is
downloaded again.

```bash
printf 'FROM hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M\nPARAMETER num_ctx 16384\n' > magmell-16k.Modelfile
```

```bash
ollama create magmell-16k -f magmell-16k.Modelfile
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

`--write` stores what the server said in `~/.rp-core/caps-cache.json` for later turns. With
`--active` it also tries the model itself: whether it calls tools; see [Active probes](#active-probes).

**First-answer latency.** The first answer after Ollama loads a model takes a few seconds while the
model loads. Later answers start in well under a second, because Ollama keeps the prompt cached.

## Playing in the chat

### Starting a session

```bash
rp-core new --card <file or library id> [--model conn:model] [--preset <id or file>] [--lore <id or file>] [--persona me.json] [--max-tokens 400] [--title "..."]
```

- **The card.** `--card` takes a PNG or JSON card. The card is imported into your library first;
  later sessions can name it by its library id (`rp-core import card.png` prints it).
- **Your persona.** `--persona` is a small JSON file: `{"name": "Ника", "description": "...",
  "aliases": ["Nika"]}`. It fills `{{user}}` in the card and greetings. Without it, `{{user}}` is
  `User`. It may carry a lorebook of its own under `"book"`, in rp-core's format:
  `{"name": "Nika's notes", "entries": [{"id": "1", "keys": ["compass"], "content": "...",
  "position": "before"}]}`. That book is scanned first, before the card's.
- **Preset and lorebooks.** `--preset` and `--lore` take SillyTavern files or library ids; see
  [Presets and lorebooks](#presets-and-lorebooks).
- **Reply length.** `--max-tokens` caps the length of the answers.
- **Without opening the chat.** With `--no-chat`, or when not on a terminal, `new` only prints the
  session id.
- **Full-screen.** With `--tui`, the new session opens in the [TUI](#the-full-screen-tui) instead.

### What you see

```
session s_4c55fe7e · Maren Vell · narrator ollama:magmell-16k:latest (tools: prompted) · ctx 16384
Maren Vell › *The chest sat in the middle of the flooded nave…*
  [greeting 1/7]   /r next greeting  /[ /] browse
you        › "I'm not Corvin," I say and step closer.
  ⋯ search_history "Corvin" → 2 hits
Maren Vell › …
  [swipe 1/1 · 312 tok · 5.8s · end]   /r swipe  /c continue  /e edit
```

- **Banner.** The session, the character, the narrator's model, whether it can use tools
  (`native`, `prompted` or `off`; see [Tools and search](#tools-and-search)) and its context window.
- **Status line.** After every answer: which version of the answer you are looking at, its length,
  the time it took, and why it ended. `length` means it hit the token cap; `/c` continues it.
  `tools: off (prefill)` means the preset's prefill switched the tools off for that answer.
- **Tool calls.** Each lookup the narrator made is one dim line before the text it led to.
- **The Director.** With the [Story Director](#the-story-director) on, one dim line
  `⋯ director: …` comes before each answer, and the banner names the Director's model.
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
| `/model [role] [connection:model]` | Show the models, or change one: `/model narrator ollama:magmell-16k:latest`. The change is saved in the session. `/model director narrator` makes the Director follow the narrator again; `/model recorder <conn:model>` gives the Compendium's agents a model of their own ([details](#the-recorder-their-model)) |
| `/note <text> [@depth]`, `/note off` | The author's note, inserted *depth* messages from the end (default 4) |
| `/think show`, `/think hide` | Show the model's reasoning, or fold it |
| `/preset [id\|file]` | Show the preset, or switch it ([details](#presets-and-lorebooks)) |
| `/lore`, `/lore add <id\|file>`, `/lore rm <id>` | The session's lorebooks: list, add, remove |
| `/lore test <text>` | Which lore entries a message would wake, and why; nothing is sent |
| `/preview [n] [--wire] [--verdicts]` | The exact request of the next answer (or of answer *n*), without sending it; `--verdicts` adds the lore test |
| `/usage` | Tokens and cost of the current path (cost needs `[prices]` or a server that reports it) |
| `/trace` | What the last answer's prompt held: window, reserve, size, what was trimmed, the lore that fired and why the rest did not, the tool rounds and calls |
| `/search <words> [before=n]` | Find earlier messages of this path, newest first ([details](#tools-and-search)) |
| `/memory`, `/memory list\|show\|tree\|new\|edit\|retire\|restore\|export\|on\|off` | The Compendium of this path: list its entries, write and change them, export them ([details](#the-compendium)) |
| `/memory undo\|refile <n>`, `/memory retry\|wait\|status` | The Compendium's background work: take back or redo what the agents wrote from message *n*, run failed tasks again, wait for the work, see it ([details](#the-memory-commands)) |
| `/memory add <title> \| <keys> \| <text>` | A note for the narrator ([details](#notes)) |
| `/director`, `/director show` | The Story Director's plan at this point of the story: chapter, arcs, seeds, hidden arcs, and the last directive in full, as the narrator got it ([details](#the-story-director)) |
| `/director on`, `/director off` | Let the Director plan every reply from the next turn, or stop it. Its plan is kept |
| `/probe --active [--write]` | Test the narrator's model with a few tiny calls ([details](#active-probes)) |
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

## The full-screen TUI

`rp-core tui` shows a session on one screen: the models and the hotkeys on the left, the chat in the
middle, the agents and their tool calls on the right. It is the same chat as `rp-core chat`. Every
slash command, held lines, refusals during an answer and the Ctrl+C rules work as described in
[Playing in the chat](#playing-in-the-chat).

### Starting it

```bash
rp-core tui <session>
```

```bash
rp-core new --card ~/cards/mira.png --model "ollama:magmell-16k:latest" --tui
```

- **It needs a real terminal** on stdin and stdout. Without one it exits with code 64 and says
  `rp-core tui needs a terminal; use rp-core chat`.
- **The line chat stays.** `rp-core chat` is unchanged and is still what `new` opens by default.
  Pipes, scripts and `--provider script:` runs use it. Both open the same session files, so you can
  switch between them (not at the same time: the session is locked while one has it open).
- **Refusals come first.** A locked or missing session is refused before the screen opens, as in
  `chat` (exit 5).
- **`--provider`** works on `tui` as on `chat`. `new --tui` cannot be combined with `--no-chat` or
  `--json`.

### What you see

A real capture at 140 × 36 on a scripted model, with the empty rows cut:

```
┌─ Models ─────────────────┐┌─ Chat ───────────────────────────────────────────────────────────────────┐┌─ Agents ─────────────────────────┐
│ Alice                    ││ Alice › Oh! Another adventurer! I was just about to head inside. Want to ││ Narrator · idle                  │
│                          ││ join me?                                                                 ││   last 0.8s · end                │
│ Narrator                 ││   [greeting 1/3]                                                         ││   1 round · tools off            │
│ script:default           ││                                                                          ││                                  │
│ ctx 8k · tools off       ││ you   › Привет, Алиса                                                    ││ Director · off                   │
│ (script)                 ││                                                                          ││                                  │
│                          ││   ⋯ thinking (21 chars)                                                  ││                                  │
│ Director · off           ││ Alice › Алиса оборачивается. «Привет, путник. Пойдём?»                   ││                                  │
│                          ││   [swipe 1/1 · 0.4s · end]                                               ││                                  │
│ Enter      send          ││                                                                          ││                                  │
│ Alt+Enter  new line      ││ you   › ещё                                                              ││                                  │
│ Ctrl+C     stop / quit   ││                                                                          ││                                  │
│ Ctrl+R     swipe         ││ Alice › Другая версия ответа.                                            ││                                  │
│ Ctrl+G     guided reroll ││   [swipe 2/2 · 0.0s · end]                                               ││                                  │
│ Ctrl+O     continue      ││                                                                          ││                                  │
│ Ctrl+E     edit last     ││ you   › день?                                                            ││                                  │
│ Alt+←/→    versions      ││                                                                          ││                                  │
│ PgUp/PgDn  scroll        ││ Alice › Она смотрит в календарь: Monday / Morning — пора.                ││                                  │
│ C-Home/End top/bottom    ││   [swipe 1/1 · 0.8s · end]                                               ││                                  │
│ Ctrl+D     Director      ││                                                                          ││                                  │
│ F1         help          ││                                                                          ││                                  │
│ F2         side panes    ││                                                                          ││                                  │
│ F3         mouse: on     ││                                                                          ││                                  │
│ Shift+drag select        ││                                                                          ││                                  │
│ F4         choose model  ││                                                                          ││                                  │
│ Esc        cancel/clear  ││                                                                          ││                                  │
│                          ││                                                                          ││ Usage                            │
│                          ││ ready · Enter sends · F1 help                                            ││   3 calls · usage not reported   │
│                          ││ you › Write your line… (Enter sends)                                     ││   cost unknown                   │
└──────────────────────────┘└──────────────────────────────────────────────────────────────────────────┘└──────────────────────────────────┘
```

- **Models (left, 28 columns).** The session title, the character and your persona. The narrator's
  `connection:model`, its window and whether it can use tools; `(script)` or `(recording)` under
  `--provider`. The Director: `off`, or its model (`follows narrator` when it uses the narrator's),
  the profile of its last plan and its style. Then the hotkeys, one per row.
- **Chat (middle, the rest).** The whole current path when the session opens, then the chat as it
  goes: each message under its name, the status line under each answer, the tool and Director lines,
  the replies of slash commands. Under it, one status row (`ready`, `answering…`, `working…`,
  `sent 4 chars to the clipboard`, errors) and the input box.
- **Agents (right, 36 columns).** See [The Agents pane](#the-agents-pane).

**Narrow terminals.** At 120 columns or more you get all three columns. From 90 to 119 you get the
chat and the Agents pane; below 90, the chat only. F2 hides both side panes at any width and brings
them back; it cannot show a pane the width has no room for. When the left pane is not on screen,
F1 (`/help`) lists the hotkeys under the commands.

**Long sessions.** The newest 150 cards and rows stay separate; older ones are folded into blocks of
50. On open the TUI builds only the newest part and up to 300 messages before it; a dim row at the
top, `⋯ N earlier messages · Ctrl+Home loads more`, counts the rest, and each Ctrl+Home builds 300
more. So a session with thousands of messages opens and scrolls fast.

### Hotkeys

The labels are those of the left pane.

| Key | The pane says | What it does |
|---|---|---|
| Enter | send | Sends the line: a message or a slash command |
| Alt+Enter (or Shift+Enter) | new line | A line break in the input. Alt+Enter and Ctrl+J need nothing special; Shift+Enter works only in terminals that report it (the kitty keyboard protocol), and the pane shows it only then |
| Ctrl+C | stop / quit | Stops the answer and keeps what arrived; at the prompt it clears the input; twice within 2 seconds on an empty input it quits. It also cancels an edit in place |
| Ctrl+R | swipe | `/r` |
| Ctrl+G | guided reroll | Puts `/regen ` into the input; type the direction and press Enter |
| Ctrl+O | continue | `/c` |
| Ctrl+E | edit last | Puts the last message into the input to edit (`/e`) |
| Alt+←/→ | versions | `/[` and `/]` |
| PgUp/PgDn | scroll | Scrolls the chat a page |
| C-Home/End | top/bottom | Ctrl+Home and Ctrl+End: the top and the bottom of the chat. In a long session Ctrl+Home also loads 300 older messages |
| Ctrl+D | Director | `/director show` |
| F1 | help | `/help` |
| F2 | side panes | Hides or shows both side panes |
| F3 | mouse: on | Mouse reporting on or off; the row shows the current state |
| Shift+drag | select | The terminal's own text selection (see [Mouse](#mouse-selecting-and-copying)) |
| F4 | choose model | Opens the narrator model picker. It lists configured connections and models reported by their servers; ↑/↓ selects, Enter switches this session, Esc closes, F4 refreshes. Unreachable servers are marked in the list |
| Esc | cancel/clear | Cancels an edit in place, or clears the input |

- **Hotkeys are typed lines.** A hotkey that stands for a command goes in as if you typed it, so the
  chat's rules apply: during an answer it waits or is refused, as the typed command would be.
- **On a Russian layout** the Ctrl+letter keys work as on the Latin one; see
  [Troubleshooting](#troubleshooting).

### Typing and editing

- **Enter** sends. **Alt+Enter**, **Ctrl+J** or (where it works) **Shift+Enter** start a new line. The
  input grows up to 6 rows.
- **↑ / ↓ on an empty input** scroll the chat by 3 lines. With text in the input they move the
  cursor.
- **During an answer** you can type; a line you send waits until the answer ends. A slow command
  (`/probe --active`, `/preview` of a big session) shows `working…` in the status row, and
  `queued: N` counts the lines that wait.
- **Editing in place.** `/e [n]` and Ctrl+E put the message into the input with its real line
  breaks, labelled `edit ›`. Enter saves; Esc or Ctrl+C cancels. The TUI does not use `$VISUAL` or
  `$EDITOR`. If the input already holds text, Ctrl+E does nothing and the status row says
  `send or clear the input first (Esc)`.
- **`*italic*` and `**bold**`.** In answers, `*actions*` show in italics and `**bold**` in bold, both
  without their asterisks, as rendered markdown, also while the answer streams. Speech inside an
  action stays upright; `*emphasis*` inside speech is italic. A `*` opens italics only before a
  non-blank character with no letter or digit right before it, and closes them only after a
  non-blank character with no letter or digit right after it; any other `*` is drawn as it is
  (`5 * 3`, `f*ck`, `* item`, a lone `*`). `***both***` is bold italic. A span still open at a line
  break ends there, without its opening `*`. The line chat (`rp-core chat`) keeps both kinds of
  asterisks on screen.

### Mouse: selecting and copying

- **The mouse is on by default.** The wheel scrolls the chat. F3 turns mouse reporting off (the row
  then says `mouse: off`) and on again. With it off, the terminal handles the mouse; most terminals
  then turn the wheel into ↑ / ↓, which still scroll the chat while the input is empty.
- **Shift+drag** selects text the terminal's own way, while the mouse is on. Copy it as you usually
  do in that terminal.
- **A plain drag** selects inside the TUI. When you let go, the text is sent to the clipboard with
  OSC 52, and the status row says `sent N chars to the clipboard`. Whether it arrives is up to the
  terminal: Warp, kitty, WezTerm and iTerm2 say they accept OSC 52 (we have not checked each), and
  the TUI cannot see the answer. GNOME Terminal and other VTE terminals (Tilix, Terminator) ignore
  OSC 52; there the TUI sends nothing, and the status row says so and points to Shift+drag.

### Colours

The TUI uses your terminal's colours: text in its default colour, accents from its 16-colour
palette, no background of its own. A light or a dark theme works without a setting. With `NO_COLOR`
set (to any non-empty value), text has no colours, only bold, dim and italic; a mouse selection
still shows on palette grey.

### The Agents pane

- **Narrator.** Its state: `idle`, `waiting…`, `thinking (N chars)`, `writing…`, `tool <name>`,
  `retry <code>`, `stopped` or `failed (<code>)`. Then its last 6 tool calls, newest first, each
  with its time, and the last answer: tokens, seconds, why it ended, rounds and the tool transport.
- **Director.** `off`, `planning…`, `planned`, `reused`, `skipped` or `failed (<code>)`, with the
  time it took and the plan's summary. Then the stored plan: turn, profile, transport, model, the
  last attempts, the chapter, live arcs and seeds due.
- **Filing** and **Historian**, the [Compendium's agents](#the-background-agents), once they have
  work: `Filing · queued`, `started`, `done (n)` (n changes written), `preempted` (it gave way to a
  turn), `failed [<code>]`, `parked [<code>]`, `skipped` (a run that something newer replaced) or
  `idle`; below it the time of the last pass and its last change, as `memory: created character
  "Фрол"`. A session that opens with work queued shows it at once. The REPL's `⋯ memory:` lines go
  to the chat as well.
- **Usage** above Context: calls, tokens in and out, and the cost (as `/usage`), the agents' calls
  included.
- **Context** below Usage: the narrator's effective window and a bar for the **last** prompt, against
  the space left after its reply reserve. `~` marks an estimate. On a local Ollama connection the
  block also checks `/api/ps` and warns if the loaded model's actual window is smaller than rp-core's
  configured window. A model that has not loaded yet has no runtime window to report.

From a live session on Ollama with the Director on:

```
Director · planned · 42.2s
  seeds ~1
  turn 3 · lite · tagged
  ollama:magmell-16k:latest
  tagged ok · 42.2s · 511 tok
  chapter 1 "A Warm Welcome"
  0 live arcs · 0 seeds due
```

### Logs, leaving and signals

- **Logs.** While the screen is up, nothing is printed to the terminal. The chat's own lines
  (command output, notices, errors) and the `--debug` lines also go to `<home>/logs/tui.log`
  (`~/.rp-core/logs/tui.log`); the answers do not. An unexpected error shows in red in the status
  row and goes to the log.
- **Leaving.** `/quit`, or Ctrl+C twice on an empty input, restores the terminal and exits with 0.
  Lines the TUI could not show any more, and why it ended on exit 1, 3 or 130, are printed in the
  restored terminal.
- **Closing the terminal** (SIGHUP), SIGTERM, SIGQUIT and the other exit signals end it cleanly: the
  partial answer is kept, the lock is released, and the exit code is 128 + the signal's number
  (SIGHUP 129, SIGTERM 143). A second signal leaves at once.

### Limits

- **Tested by us** in a headless renderer and in a real pseudo-terminal. Warp and GNOME Terminal were
  tried by hand, before the latest fixes. What we have not verified: Warp's own behaviour
  (Shift+Enter, Shift+drag), OSC 52 copying in each terminal, input methods (IME), and Ctrl+Z
  (suspending the TUI is not supported).
- **Emoji in Warp.** Warp sizes joined emoji differently, so under Warp the TUI drops emoji joiners,
  VS16 and skin-tone marks from the text it shows.
- **Size.** OpenTUI brings a native library of about 5 MB per platform and about 28 MB on disk in
  all (see [Install](#install)). No other command loads it.
- **No external editor**, no images and no settings screen in this version.

## Editing messages and choosing an editor

`/e [n]` edits message *n* (default: the last). How depends on whether you named an editor. In the
full-screen TUI it always edits in the input box ([details](#typing-and-editing)). The same editor
opens for `/memory new` and `/memory edit` ([details](#writing-entries-in-the-editor)).

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

## Presets and lorebooks

rp-core reads SillyTavern's chat-completion presets and its world info (lorebook) files, and
RoleCall's Compendium exports. You import a file once into your library; from then on a session
names it by its library id. A RoleCall story export brings its own preset and lorebooks along
([Continuing a RoleCall story](#continuing-a-rolecall-story)).

### Importing

`rp-core import` recognises the file by its content, whatever its name:

| File | Becomes | In |
|---|---|---|
| A character card: PNG or JSON (CCv1, V2, V3) | a character | `library/characters` |
| A SillyTavern chat-completion preset, also one exported from RoleCall | a preset | `library/presets` |
| SillyTavern world info, or a bare `character_book` | a lorebook | `library/lorebooks` |
| A RoleCall Compendium export (`compendium-v1.0.0`) | a lorebook whose typed entries feed [the Compendium](#the-compendium) | `library/lorebooks` |
| A RoleCall story export (a `.rolecall` zip) | the character, persona, preset and lorebooks, then one session per chosen chat ([details](#continuing-a-rolecall-story)) | `library/…`, `sessions` |
| A SillyTavern solo chat export (`.jsonl`, with `--card <library id>`) | a session with its messages and swipes ([details](#importing-a-sillytavern-chat)) | `sessions` |

Refused, with the reason: the other SillyTavern files below ("Not a preset"), RoleCall's account
backup (also a `.rolecall` file, but JSON), RoleCall's story as a lone `.jsonl` file, and any other
ZIP archive.

```bash
rp-core import "My Preset.json"
```

```bash
rp-core import ~/worlds/Eldoria.json
```

- **Where to find them.** SillyTavern keeps presets in `data/default-user/OpenAI Settings/` and
  world info in `data/default-user/worlds/`; its export buttons give the same files.
- **Library ids.** Presets go to `library/presets`, world info to `library/lorebooks`. The id is the
  name in lower case with its words joined by `-`. SillyTavern writes no name into presets and world
  info, so those are named after the file: `My Preset.json` becomes `my-preset`. Cards, bare
  `character_book` files and RoleCall Compendium exports carry a name of their own and are named by
  it (a `character_book` without one, by its file). `--as <name>` picks another name. Importing the
  same file twice changes nothing. `builtin` is the built-in layout's id: a preset called that is
  saved as `builtin-2`.
- **RoleCall Compendium exports** (`compendium-v1.0.0`) become lorebooks whose typed entries feed
  [the Compendium](#the-compendium); see [Importing a RoleCall Compendium](#importing-a-rolecall-compendium).
- **Warnings.** Settings rp-core does not honour are named in a warning and kept in the imported
  file. A preset's connection settings (API source, model names, proxy and its password) are left
  out on purpose: the connection comes from `config.toml`.
- **Not a preset.** Instruct and context templates, system prompts and reasoning templates (the
  Advanced Formatting files), SillyTavern's text-completion presets (NovelAI, KoboldAI, text
  generation: the reason names which) and API request bodies are refused, with the reason. A
  chat-completion preset is told by its prompts, its prompt order or its chat-completion settings,
  not by its samplers.
- **Which prompts are sent.** As in SillyTavern: the order and the on/off switches come from the
  preset's global prompt order; without one, SillyTavern's default order is used and the preset's
  own extra prompts come in switched off. A custom prompt among the others is sent only when it is
  not marked as a system prompt (`system_prompt: false`, which SillyTavern writes for every prompt
  you add). Presets made in RoleCall (they say `prompt_post_processing` or `{{message_history}}`)
  keep RoleCall's reading, and the import says so.
- **The preset's context size.** A SillyTavern preset carries its own context size
  (`openai_max_context`), and rp-core honours it: it can only make the window smaller. SillyTavern's
  `Default.json` says 4095, so a session on it gets a 4095-token window even on a 16k model. The
  banner and `/preset` say so (`ctx ≤4095` in the banner when the model's own window is not known
  yet); raise the value in the file (or use another preset) for more.
- **The preset's reply length.** A SillyTavern preset's reply length (`openai_max_tokens`) becomes
  the reply reserve, the part of the window kept for the answer, capped at half the window. Geechan's
  v5.2 asks for 10000 tokens: on a 16k model 8192 are kept for the reply, which halves the room for
  the prompt and, with it, the lore budget. `--max-tokens` at `new` (the session's narrator binding)
  overrides the preset's value.
- **SillyBunny-only macros.** Some newer presets (Geechan's, for example) use SillyBunny's macro
  engine: `{{#if …}}…{{/if}}` blocks and `{{.variable = …}}` shorthands; RoleCall-born ones use
  `{{if …}}`, `{{choice::…}}` and the like. rp-core does not know those forms; they are sent as
  written. The import names each one in a warning, and `/trace` lists them under "unknown macros".
- **Book settings SillyTavern ignores.** A card book's own `scan_depth` and `recursive_scanning` are
  kept in the file but not applied: SillyTavern scans every world at its global depth (2) with
  recursion on, and so does rp-core. The import says so when the values differ.
- **Entry decorators.** An entry that starts with `@@activate` fires without a key, one with
  `@@dont_activate` never fires, as in SillyTavern. Other `@@` lines at the start (`@@depth`,
  `@@role`) are stripped, as SillyTavern strips them.
- **The card's own book** needs no import: it comes with the card and is used in every session of
  that card. A book without a name is called "Mira's Lorebook", as SillyTavern calls it. A book is
  read once by name, as in SillyTavern: if you also add a library book with the same name (the
  card's `Eldoria` and `Eldoria.json`, say), the library one is read and the card's copy is not.
  `/lore` shows which. An open sticky or cooldown follows the world, not the copy.

### Choosing them for a session

When you start a session, `--preset` and `--lore` take a library id or a file (a file is imported
on the way). `--lore` may be given more than once.

```bash
rp-core new --card mira.png --model ollama:magmell-16k:latest --preset my-preset --lore eldoria --lore harbor
```

In the chat:

| Command | What it does |
|---|---|
| `/preset` | The session's preset and the presets in your library |
| `/preset <id\|file>` | Switch the preset from the next answer. `builtin` is the built-in layout. A file is imported first and its warnings are shown |
| `/lore` | The lorebooks this session scans, in order: your persona's (the `book` of your `--persona` file), the card's own, then the ones you added |
| `/lore add <id\|file>` | Add a lorebook from the next answer; a world info or Compendium file is imported first. A book with the name of one already in the session takes its place: a changed copy of `Harbor.json`, imported as `harbor-2`, replaces `harbor`. Its [Compendium](#the-compendium) entries join `/memory` at once, and the line says so |
| `/lore rm <id>` | Take a lorebook out of the session. It stays in the library. Its [Compendium](#the-compendium) entries leave `/memory` at once, and the line says so |
| `/lore test <text>` | Which entries a message with this text would wake, and why. Nothing is sent or saved |

Changing the preset or the lorebooks is refused while an answer is being written.

### Testing the lore

```
you  › /lore test We walk up to the lighthouse.
lore test: a reply to your text (nothing is sent)
  ✓ "Gull Point lighthouse" harbor:0 · key · keys: lighthouse · 13 tok
  ✗ "Evening fog" harbor:1 · no-key-match
  ✗ "The keeper" harbor:2 · disabled
1 of 3 fired · 13 tok of lore · 15 of 1973 budget tok (counts ×1.15 for this model)
```

Each line is one entry: its title, then `book:entry`, then the reason. A fired entry ends with its own
token count, the same count `/preview` shows. The last line measures the budget in budget tokens:
those counts times rp-core's correction for this model, which starts at ×1.15 and then follows the
server's own counts. An entry cut with "skipped: an earlier entry had already used up the budget" was
never tried: once one entry overflows the budget, SillyTavern stops trying the rest.

- **Why an entry fired:** `key`, `secondary`, `constant`, `sticky` (still inside its sticky window)
  or `recursion` (woken by the text of another entry).
- **Why it did not:** `no-key-match`, `secondary-logic` (its secondary keys failed), `chance` (its
  probability roll, with the numbers), `cooldown` and `delay` (with the messages left), `budget-cut`
  (the lore budget was full: what the entry would have cost and the most that was left, in budget
  tokens),
  `group-lost` (another entry of its inclusion group won), `exclude-recursion`, `disabled`,
  `regex-error` (a `/regex/` key that does not compile).
- **Recursion** wakes entries through the text of others for at most 3 loops. An entry the next
  loop would have woken says so ("recursion would wake it, but it stops after 3 loops").
  SillyTavern's default has no limit.
- **Not sent.** An entry that fired into a place the preset does not send (its `worldInfoBefore` is
  switched off, say) is marked "not sent", here and in `/trace`. A book that is skipped (missing from
  the library, invalid) is named below the list.
- **The budget** is a quarter of the prompt part of the context window, SillyTavern's default.
- **Rolls.** Entries with a probability below 100 % roll for every answer. In the chat, `/lore test`
  and `/preview` use the next answer's own seed, so they agree with it; a one-shot
  `rp-core preview` rolls its own (below). `/trace` shows what really fired.

Entries behave as in SillyTavern: keys are looked for in the last 2 messages (an entry may set its
own scan depth), ignoring case and as whole words unless the entry says otherwise. A hidden message
(`/hide`) is not read, and it does not count in the messages that sticky, cooldown and delay count
either: SillyTavern leaves it out of its chat the same way, so hiding one keeps a sticky entry one
message longer.

### Seeing what was sent

**`/trace`** after an answer shows the lore that fired, with the reason, and what the budget cut.
Below that, the entries that did not fire: the answer's request is rebuilt with its own seed and
clock, nothing sent, and each entry with a reason of its own (a lost roll, a cooldown, a budget
cut, …) gets a line; the plain no-key-match and disabled ones are counted on one line. When the
preset, a book, the history or the model changed since, a notice says what changed, as for
`/preview n`.

```
trace of 16a7c58e · ollama:magmell-16k:latest
  window 16384 · reserve 400 · prompt ~1210 tok · 9 messages sent
  trimmed: nothing · prefill: none
  unknown macros: none
  lore fired: 1 · budget 3996 tok
    ✓ "Gull Point lighthouse" harbor:0 (key)
  lore not fired (recomputed from its seed):
    ✗ "Storm" harbor:3 · chance · keys: lighthouse · roll 0.71 > 0.50
    ✗ 2 more: no-key-match 1, disabled 1
```

**`/preview`** prints the exact request of the next answer without sending it. Every message comes
numbered, with its role, where it came from (`main`, `worldInfoBefore`, `history`, …) and its token
count, followed by its full text. Then the prefill, the reply limit and the samplers the connection
sends; a preset's samplers it does not send (`top_k` on most OpenAI-style servers, say) are named on
their own line.

- **`/preview n`** rebuilds the request of answer *n* (its number in `/show`) with that turn's own
  seed and clock, under today's preset and lorebooks. When the rebuild cannot match what was sent, a
  notice says what changed: the preset, a book, the history (an edit or a hidden message since),
  which old messages the budget leaves out, the author's note, the window, the model, or how the
  messages are shaped for it (another model's connection may merge or re-role them). An answer
  [imported from RoleCall](#continuing-a-rolecall-story) has no request to rebuild, and the line says so.
- **`/preview --verdicts`** (also with *n*) adds every lore entry's verdict, as `/lore test` prints
  them.
- **`/preview --wire`** prints the JSON body as the server would receive it, then the notices. Headers,
  and with them your key, are left out.
- **From the shell:** `rp-core preview <session>` does the same; `--draft "text"` previews a reply to
  a message you have not sent (a session with only its greeting needs one), `--verdicts` adds the lore
  test, `--json` prints everything as one JSON object. With `--wire` the body is all that goes to
  stdout; the notices and the verdicts go to stderr. A one-shot preview draws its own seed: `{{random}}`, `{{roll}}` and lore entries with
  a probability below 100 % can come out differently in the next `send`. Inside the chat, `/preview`
  and `/lore test` use the next answer's seed.

## Importing a SillyTavern chat

SillyTavern's **Manage chat files → Export as .jsonl** saves one chat's metadata and messages. A
solo chat export does not contain its character card or preset. Import the card separately, then
give its library id to the chat importer:

```bash
rp-core import ./mira.png
rp-core import ./harbor.jsonl --card mira --dry-run
rp-core import ./harbor.jsonl --card mira
rp-core chat <session-id-from-import-output>
```

The import keeps the text and order of messages, every swipe as a version and `swipe_id` as the
selected version. It also keeps `extra.reasoning` as a reasoning block and excludes messages marked
`is_system` from the model context. The export's `user_name` becomes a name-only persona; use
`--persona ./persona.json` for a full one. `--model conn:model` chooses another narrator. The
session uses your `config.toml` defaults for the preset and lorebooks, because the chat file does
not contain them. `--as "New title"` sets a title, `--new` creates another copy, and `--json`
prints a machine-readable report. A second import of the same file and card is refused by default.

Group chats with more than one assistant name are refused. Media and file attachments are not
copied; the importer warns when it sees them. SillyTavern checkpoints are separate chat files:
import each one separately if you want its branch. `--dry-run` checks the file and the card without
writing a session.

## Continuing a RoleCall story

A story you began in RoleCall can go on in rp-core. RoleCall exports a story as one `.rolecall`
file, and `rp-core import` turns it into library items and a session that opens where RoleCall left
off: the character, your persona, the preset with the chat's own settings, the lorebooks, every
message with its swipes, and the Story Director's plan.

```bash
rp-core import harbor-nights.rolecall --dry-run
rp-core import harbor-nights.rolecall
rp-core chat s_795cec5b
```

### Exporting the story from RoleCall

In RoleCall's Scenes, right-click the story and choose **Export to JSONL → RoleCall (.rolecall
zip)**. A branch's own menu has the same item under **Export As**. RoleCall decrypts the story in
your browser for the export, so it may ask for your recovery phrase first. The download is named
`<story>-rolecall-<date>.rolecall`; any name works, since rp-core recognises the file by its
content. It is a ZIP archive with the whole story tree (the main timeline and every branch), the
character card, your persona, the preset, the lorebooks, and for each chat its tracker, its
storyboard and the Director's state.

Two other RoleCall files look alike. Both are refused, with the reason:

- **RoleCall (JSONL)**, from the same menu: the same story as one `.jsonl` file. Export the
  `.rolecall` zip instead; it holds the same data, and the card, the preset and the books besides.
- **Your account backup**, which RoleCall also names `.rolecall`. It is one JSON file for the whole
  account, not a story.

Import the file as RoleCall wrote it: an archive unpacked and packed again usually has its
`manifest.json` one folder down, and rp-core refuses it with plain words.

### Running the import

Run it with `--dry-run` first. It reads and checks everything and writes nothing. This is the
synthetic export the tests build (`test/rcimport/kit.ts`, every name in it invented):

```
$ rp-core import harbor-nights.rolecall --dry-run
character tavik-ashvale                  new  "Tavik Ashvale"
persona   wren-calder                    new  "Wren Calder"
preset    quill-lantern-v2-1                new  "Quill & Lantern v2.1" · 12 blocks on
preset    quill-lantern-v2-1-harbor-nights  new  "Quill & Lantern v2.1 (Harbor Nights)" · the chat's own settings applied
lorebook  ashvale-saga                   new  "Ashvale Saga" · 6 entries, 1 identical copy merged
lorebook  ashvale-saga-compendium        new  "Ashvale Saga Compendium" · 18 entries, 2 consumed row(s) disabled
lorebook  harbor-atlas                   new  "Harbor Atlas" · 6 entries
session   s_795cec5b                     new  "Harbor Nights" · chat c8a2838b · 12 messages (15 versions) · head 7b0f5451 · director on, its state at turn 5 · compendium on from the import
rp-core: dry run: nothing was written
rp-core: warning: the story export does not say which messages were hidden in RoleCall; every message is imported visible
…
rp-core: warning: preset quill-lantern-v2-1: macros rp-core does not run stay literal text: {{else}}, {{/if}}, {{.pace}}
…
rp-core: warning: 1 tracker (relationships, calendar, resources…) not carried: rp-core has no trackers (--keep-raw keeps a copy)
…
rp-core: warning: s_795cec5b: the Compendium starts after the imported 5 turns: it files and summarises new turns only; the imported ones stay in the history and the lorebooks
rp-core: hint: run it again without --dry-run to import
```

- **Library items.** One line each: the kind, the library id, `new`, `same (already in the
  library)` or `reused (an equal book)`, the name, and a detail.
- **Sessions.** One line per imported chat: its id and title, the RoleCall chat it came from (the
  first 8 characters of its id), the messages and their versions (a message with three swipes is
  three versions), the head (the message the session opens at), the Director and the Compendium. A
  branch that shares its start with its parent ends with `fork of <session>`.
- **Warnings** go to stderr. One about a library item names it. One about a session names it when
  the run imports more than one (the Compendium and fit lines always do), and one that holds for
  several sessions is one line. Most say where rp-core does something differently from RoleCall; a
  real 800-message export gives about forty-five. Read them once.

Without `--dry-run` you get the same report, and everything is written at once: the library items,
then the sessions' journals. If anything fails, what the run wrote is removed again (`import
failed: …; nothing was imported`), and a library item the run reused is never touched. Then each
new session's next request is built, never sent, to check that the story fits its narrator
([below](#when-the-story-does-not-fit)), and the hints say how to go on:

```
rp-core: hint: `rp-core chat s_795cec5b` continues the story (`rp-core tui s_795cec5b` full-screen)
rp-core: hint: its narrator is ollama:qwen3:14b; /model in the chat changes it
```

| Flag | What it does |
|---|---|
| `--dry-run` | Read and check everything, print the report, write nothing |
| `--chat main` | The main timeline only (the default): the chat RoleCall marks as the main one |
| `--chat all` | Every chat of the story. A chat whose messages equal another's is skipped with a line; a branch whose copied start equals its parent's becomes a [fork](#swipes-branches-and-forks) of the parent's session, otherwise a session of its own |
| `--chat <prefix>[,<prefix>…]` | The chats whose id starts so, in any case; `main` may stand in the list. A prefix that names no chat, or several, is refused with the list of chats: id, title and size |
| `--model conn:model` | The narrator of the new sessions, a connection of `config.toml`. Without it, `[roles] narrator`. RoleCall's model choice does not come over |
| `--compendium on\|off` | Turn the [Compendium](#the-compendium) on after the imported past (`on`, the default), or leave it off. `/memory on` later starts it from that moment |
| `--as <title>` | The story's title; without it, the main chat's. The preset's copy is named after it |
| `--new` | Import chats that were imported before once more, as new sessions |
| `--keep-raw` | Copy each chat's `tracker.json`, `storyboard.json` and `dm-context.json` to `<home>/imports/<session>/`, for your reference; rp-core does not read them |
| `--json` | The report as one JSON object: `{"dryRun", "library", "sessions", "skipped", "warnings"}`, and `"kept"` with `--keep-raw`; each warning with its `code`, `message`, `count` and the sessions or items it names |

```bash
# every branch too, on a bigger model, under another title
rp-core import harbor-nights.rolecall --chat all --model openrouter:vendor/model --as "Harbor Nights II"
# one branch, by the start of its chat id (a prefix that names nothing lists them)
rp-core import harbor-nights.rolecall --chat 12eb
# without the Compendium, keeping RoleCall's tracker and storyboard files beside the session
rp-core import harbor-nights.rolecall --compendium off --keep-raw
# a second copy of a story imported before
rp-core import harbor-nights.rolecall --new
```

**Importing again.** The session id comes from the RoleCall chat's id, so a chat imported before is
skipped with a line, and the run is refused when that chat was all it asked for:

```
rp-core: skipped chat c8a2838b "Harbor Nights": already imported as s_795cec5b
```

So `--chat all` after the main chat imports the rest, and a branch imported later still becomes a
fork of the session its parent was imported as, when that session holds the branch point. A newer
export of the same story, after you played on in RoleCall, does not update the session: `--new`
imports it as a new one. Library items that did not change are reused; a changed preset or book is
saved under a new id (`-2`).

Exit codes: 0 when the import ran (or would run); 1 when it is refused (`import failed: …`: no
character card in the export, a `--chat` that names nothing, a chat already imported, a file that is
not a story export); 64 for a bad flag value.

### What comes over

- **The character**, from the card in the export, read as any card is. The database row beside it
  (`.raw.json`) is never read.
- **Your persona**, with the text RoleCall sent for it: its sections (appearance, personality,
  history…) in RoleCall's order and markup, else its description. It is saved in
  `library/personas/` and is the session's persona, so `{{user}}` is its name.
- **The preset**, rebuilt from RoleCall's prompt rows as RoleCall's own preset export writes it,
  then read with RoleCall's rules, like any RoleCall preset ([Importing](#importing)): the same
  prompts in the same order, and a marker that carries text is sent, as RoleCall sends it. When
  the chat had settings of its own (prompt toggles, samplers, Start Reply With, a message limit),
  they go into a copy named `<preset> (<story>)`, and the session uses the copy. RoleCall macros
  rp-core does not run (`{{if}}`, `{{setvar}}`, `{{.x}}`, …) stay text, named in one warning.
- **The lorebooks**, each read as a [RoleCall Compendium](#importing-a-rolecall-compendium) book:
  typed entries feed the Compendium, plain rows stay lore, `[Arc]` overviews become arc entries.
  Books with the same rows (RoleCall's forks and copies of a book) come in once. A different book
  whose name is taken gets the start of its RoleCall id added (`Harbor Atlas (5f0c2a1e)`), because
  rp-core reads a book once by name. Rows a Compendium split consumed come in disabled: their data
  lives in the typed rows. A book equal to one already in your library is reused. The session gets
  the books the chat had on, in RoleCall's order.
- **The messages**, all of them, with their swipes and times. Swipes become versions of their
  message, as rp-core's own swipes are, and the version RoleCall showed is the one on the path: `/[`
  and `/]` walk the last answer's versions, `/tails` lists the others. The first message, when it is
  the character's, is the greeting. `{{user}}` and `{{char}}` in the text are written out with the
  names, as RoleCall showed them.
- **Reasoning.** Stored reasoning, and `<think>` blocks inside the text, become the answer's
  reasoning (`/think show`), split as RoleCall split them from the history it sent, by RoleCall's
  own rules (an unclosed tag too). So the narrator gets the history RoleCall sent. A chat that kept
  inline thinking in its history keeps its answers as they are.
- **The Story Director**, when the chat had RoleCall's Director on in its full mode: on, with
  RoleCall's personality, following the narrator's model. Its state at the last turn (chapters,
  arcs, seeds, hidden arcs, the last directive) is renumbered (`arc-1`, `seed-1`, …) and fitted to
  the 32 KB cap. It sits on every version of the last answer, and the same state, dated a turn
  earlier and without the last directive, on every version of the answer before it. Your next message plans the next turn from RoleCall's state; a
  swipe (`/r`) of the last answer keeps RoleCall's last directive; `/regen` plans that turn again.
  What rp-core's Director does not keep (hidden events, off-screen NPC actions, parallel timelines,
  core memories, RoleCall's DM notes, the details of each arc and seed) is left out, with a warning
  each.
- **The Compendium**, on from the import (`compendium on from the import`): the filing agent and the
  historian work on the turns you play from now on. The imported past is not filed or summarised
  again: on a long story that would be hundreds of calls, and the lorebooks already carry it.
  RoleCall's summaries stay entries of their books: they fire by their keys like other lore, and the
  narrator's search finds them, but the [`{{recap}}` slot](#the-recap-slot) does not use them (it
  uses the books' `[Arc]` overviews). One warning per session says how far RoleCall's summaries
  reach. On a real 800-message export they covered turn 364 of 402, so turns 365–402 are summarised
  nowhere; they stay in the history while it has room for them.
- **Branches** (`--chat all`): each chat is a session. A branch keeps its own title, else it is
  `<story> · <branch name>` (or `<story> · chat <id>`).

### What does not come over

Most of these are one warning line with counts, said only when the story used them:

- **Trackers** (relationships, calendar, resources…) and **the storyboard**: rp-core has neither.
  `--keep-raw` keeps the files.
- **RoleCall's chat summary.** The warning says whether the lorebooks carry the story's past.
- **Hidden messages and images.** The export carries neither: every message comes in visible
  (`/hide n` hides one again), and without images.
- **TunnelVision, immersion modules, mind and the agent loop.** For a book TunnelVision managed,
  RoleCall sent only its constant rows and fetched the rest with its tools; here its rows fire by
  keyword like any lore. A warning names those books.
- **Per-book token budgets.** rp-core's lorebooks share one budget.
- **Chat settings with no preset field** (reasoning effort, for one).
- **Older plans of the Director.** Only its last state comes over.
- **The requests.** rp-core did not build the imported answers' requests, so `/preview n` on one
  says so; `/preview` alone shows the next request.

### When the story does not fit

A RoleCall story often runs on a model with a large window, under a preset that keeps a lot of it
for the answer. After the writes, the import builds each new session's next request, without
sending it. When the parts that are never trimmed do not fit the narrator's window, a warning says
so. Here is the synthetic story on a narrator with a 2 048-token window:

```
rp-core: warning: s_795cec5b: the story does not fit its narrator ollama:qwen3:14b: its next request needs about 1416 tokens, but only 1024 are available (window 2048 - reply reserve 1024), so every turn would be refused; choose a narrator with a larger window (/model in the chat, --model when importing) or the built-in layout (/preset builtin); `rp-core preview s_795cec5b` shows the parts
```

On a real 800-message export with five large lorebooks, the request needed about 40 000 tokens; a
16 384-token narrator left 8 384 after the preset's reply reserve of 8 000. On a 65 536-token window
it fit. What to do:

- **A narrator with a larger window:** `--model` when you import, or `/model narrator
  <conn:model>` in the chat (saved in the session). Set the model's `context_length` so rp-core knows
  its window: the check uses the window rp-core knows, and for a local model it does not know it
  assumes 8 192 ([details](#the-context-window-the-one-thing-to-get-right)). The preset's own
  context size, as RoleCall stored it or the chat set it, can still make the window smaller
  ([details](#importing)).
- **The built-in layout:** `/preset builtin` sends rp-core's short layout instead of RoleCall's
  preset. The preset's instructions are then not sent; `/preset <id>` brings them back.
- **See the parts:** `rp-core preview <session>` (or `/preview` in the chat) refuses with the
  parts and their sizes: the preset's blocks with the lore, the in-chat inserts, the Director's
  contract and your message. `/director off` saves the Director's part.

A turn that cannot fit is refused before the Director plans, so it costs no Director call. The
check needs the written session, so a dry run does not make it.

### Your story stays on your machine

- **The file is your story in plain text.** RoleCall keeps your chats encrypted end to end and
  decrypts them in your browser to export them. So the `.rolecall` file holds everything
  unencrypted: every message and swipe, the reasoning, your persona, the Director's hidden arcs.
  Keep it as you would keep a private journal.
- **The import is local.** rp-core reads the file on your machine and writes only under your home
  (`library/`, `sessions/`, and with `--keep-raw` `imports/`). It sends nothing anywhere: no model
  is called, and the fit check builds the request without sending it.
- **Then it is an ordinary session.** Each turn sends its history to the narrator you chose. A
  local model keeps the story on your machine; a hosted API gets what each request holds.
- **Reporting a problem.** The report prints titles, names and chat ids on your terminal. Do not
  attach the export to a bug report: the warning codes and counts (`--json`) say enough. rp-core's
  tests build a synthetic export; the one test that can read yours (`RP_CORE_RC_EXPORT`, off by
  default) only checks that it opens and keeps nothing.

## Tools and search

The narrator can look things up before it writes. It has four tools, and all of them only read:

| Tool | What it does |
|---|---|
| `search_history` | Finds earlier messages of this story by words, newest first |
| `read_history` | Reads earlier messages in full, by their numbers (`#1` is the greeting) |
| `search_lore` | Finds lorebook entries and [Compendium](#the-compendium) entries, your [notes](#notes) included, by words |
| `read_lore` | Reads those entries in full |

- **Offered only when they can help.** The history tools come when the story no longer fits the
  window and its oldest messages were left out; the lore tools when a lorebook entry or a note did
  not fire for this answer, or a Compendium entry was not sent with it. A short story whose lore is
  all in the prompt gets no tools, and its request is exactly what it would be without them.
  Continuing an answer (`/c`) never offers tools.
- **Told what is hidden.** With the history tools comes a note where the left-out messages were
  (`[Messages #2–#161 of this chat are not shown here. search_history finds what was said in them;
  read_history shows them in full.]`) and, at the end of the request, a reminder to look a detail up
  before writing. With prompted tools the reminder shows the call itself, on a line of its own:
  `<tool_call>{"name": "search_history", "args": {"query": "one or two key words"}}</tool_call>`.
- **Words, not meaning.** The search matches words and their roots, ignoring case: `караван` finds
  `каравана` and `караваном`, `caravans` finds `caravan`. Every word must match. A few very common
  words (`the`, `a`, `of`, `и`, `в`, `на`) are skipped. Quotes keep a phrase together: `"north road"`.
- **Only this path.** Swipes you did not keep, other branches and hidden messages are never searched.

### Native or prompted

The banner says how the narrator calls its tools:

```
session s_4c55fe7e · Mira · narrator ollama:qwen3:14b (tools: native) · ctx 16384
```

- **`native`:** the server's own tool calling (the `tools` field of the OpenAI API). Hosted models,
  llama.cpp started with `--jinja`, and Ollama models whose template knows tools.
- **`prompted`:** the tools are described in the prompt, and the model writes its calls as
  `<tool_call>{…}</tool_call>` lines of text. rp-core takes them out of the answer, runs them and
  sends the results back. This works with any model that follows instructions well enough. A call
  written with the tool's own name as the tag, `<search_history>брат</search_history>`, counts too:
  small models reach for that form.
- **`off`:** no tools.

The value comes from what rp-core knows about the model. [`rp-core probe --active`](#active-probes)
finds out by trying; `tools = "native"`, `"prompted"` or `"none"` under `[caps."conn:model"]` in
`config.toml` sets it by hand and wins over any probe. A model that writes tool calls as text while
set to `native` still works: those calls are recognised and run, and the markup never reaches the
answer.

Small local models often do not look anything up in a roleplay prompt, even when told to: in the M3
demo and its reruns, Mag-Mell 12B (prompted) and gemma4:26b (native) answered from the visible chat,
often with a made-up name ([`docs/M3-DEMO.md`](M3-DEMO.md)). For local models the
[Compendium](#the-compendium) does not wait for the model to ask: the entries a message names are
sent with it (M5a), and a model that picks entries before the answer comes in M5c. To see the same
demo on a hosted model, see [`docs/M3-DEMO.md`](M3-DEMO.md#on-a-hosted-model).

### Rounds

One answer can take several calls to the model:

1. The model asks for a lookup, or writes its answer straight away.
2. rp-core runs the lookups and sends back the results. The model asks again or writes.
3. The last round asks for text only. It comes after `max_rounds` rounds (`[narrator] max_rounds` in
   `config.toml`, default 4, at most 8), when the same lookup keeps coming back, or when the room
   for results runs out.

An answer never takes more than 12 model calls, retries included. In the chat each lookup is one dim
line, and the text after it continues the same answer:

```
you  › What became of the caravan?
  ⋯ search_history "caravan" → 3 hits
  ⋯ read_history from=41 to=44 → #41 to #44
Mira › *She sets the glass down.* "It never reached the pass…"
```

- **The tool room.** When tools are offered, a quarter of the prompt's part of the window stays free
  for their results, so the history is trimmed a little further. A result too long for what is left
  is cut, and says so.
- **Broken arguments.** Models sometimes write broken JSON. What can be repaired safely (a trailing
  comma, a missing bracket) is repaired and noted in `/trace`; anything else goes back to the model as
  an error that asks for one valid object. A missing value is never made up.
- **A preset prefill.** A reply prefill (a preset that starts the answer with `*She`) and tools do
  not mix. By default (`[narrator] prefill_vs_tools = "prefill"`) the prefill is sent and the tools
  are off for that answer: the status line says `tools: off (prefill)`. With `"tools"` the prefill
  is skipped instead.
- **Ctrl+C** keeps what was written. Lookups that were still running are recorded as cancelled.
- **DeepSeek's reasoners** want their own earlier reasoning back once tools are involved. Each
  earlier answer is sent with the reasoning it was written with; one that has none (a greeting, an
  answer from another model, one written with thinking off) is sent with a one-space placeholder
  in its place. DeepSeek is expected to accept that, but it has not been tried against the live API
  yet. If DeepSeek refuses such a request, a notice says how to turn the tools off for that model:
  `tools = "none"` under `[caps."conn:model"]`.
- **`rp-core send`** prints the same lookup lines on stderr; stdout stays the answer alone. With
  `--json` they are `tool` events with the round they came from.

### Searching yourself

`/search` runs the same search as `search_history` and prints what the narrator would get:

```
you  › /search caravan
#44 Mira: …the caravan never reached the pass; the snow came early that year… (in context)
#41 Levi: Where did the caravan go after Tal Dara?
… 8 more …
(older matches: /search caravan before=12)
```

`#n` is the message's number on the path (as `read_history` counts, the greeting is `#1`), then who
wrote it (the character, or your persona's name) and the words around the first match. `(in context)` means the last answer's prompt already
held that message. Ten hits at a time, newest first; `before=n` shows the older ones.

### What /trace and /preview show

```
trace of 7c1e09ab · ollama:qwen3:14b
  window 16384 · reserve 1024 · prompt ~11840 tok · 31 messages sent
  trimmed: 4f1a2b3c … 9e8d7c6b · prefill: none
  …
  calls: narrator ollama:qwen3:14b 3.1s, narrator ollama:qwen3:14b 2.4s
  rounds: 2 · native tools · ended: answer · tool room 412 of 3840 tok used
  tool calls: 1
    round 0 · search_history · ok · 380 chars
```

- **`rounds`:** the model calls of the answer, how the tools were called, why the lookups stopped
  (`answer`: the model wrote its answer; `max_rounds`; `ceiling`: 12 calls; `guard`: the same call
  kept coming back; `room`: the tool room ran out; `stopped`; `error`), and how much of the tool room
  the results took.
- **One line per lookup:** its round, the tool, `ok`, `error` (the tool said what was wrong, for
  example an unknown message number) or `refused` with the reason, the repairs made to its
  arguments, the size of the result and `cut` when it was shortened.
- **`/preview`** shows the `core:tools` message, which tells the narrator how to use its tools, like
  any other message, and the tools line names them with the transport:
  `tools: read_history, search_history (native)`.

## Notes

A note is something you want the narrator to keep in mind: a name, a promise, a place. It has a
title, keys and a text, and works like a small lorebook entry that belongs to the story. Notes are
the plain part of [the Compendium](#the-compendium): no type and no fields, just text with keys.

```
/memory add Brother | Yan, brother | Mira's brother Yan sails the north road and owes Levi a favour.
```

- **When it fires.** When one of its keys comes up in the last 4 messages, the narrator gets the note
  4 messages from the end, as `[Memory: Brother]` followed by its text. Keys match by word roots
  and ignore case (`брат` matches `брата` and `братом`). A note without keys is keyed by its title.
- **Budget.** Notes count against the lore budget, like any lorebook entry; `/trace` lists a note
  that fired with the rest of the lore. Notes stay lore: unlike the Compendium's typed entries,
  they never go into its block.
- **Found anyway.** A note that did not fire can still be found by the narrator: `search_lore`
  searches notes too.
- **Saved in the session.** Each change is one line in the session's journal: nothing is deleted,
  and the story itself does not change (no new swipe, no new version). A change is refused while an
  answer is being written.
- **Sent either way.** `/memory off` stops the Compendium's block, not the notes.

| Command | What it does |
|---|---|
| `/memory` | The Compendium of this path; your notes are under `Notes`, each with its handle (`C1`, `C2`, …), the start of its text and its keys. `/memory list note --retired` adds the retired ones, dimmed |
| `/memory show <ref>` | One note: its keys, when it was written and last changed, and the exact text the narrator gets |
| `/memory add <title> \| <keys> \| <text>` | A new note. Keys are separated by commas and may be left empty |
| `/memory edit <ref> <title> \| <keys> \| <text>` | Change a note. An empty part keeps the old value: `/memory edit C1 \| \| new text` changes only the text. The note keeps its handle and its `note:…` key when its title changes; a note without keys then fires on the new title |
| `/memory edit <ref>` | The note's text in your editor ([details](#editing-messages-and-choosing-an-editor)) |
| `/memory retire <ref> [reason]` | The note stops firing and leaves the search. It stays in the journal |
| `/memory restore <ref>` | A retired note comes back |

`<ref>` is the handle from `/memory`, the note's key (`note:brother`) or its title. A title with
spaces goes in quotes for `edit` and `retire`: `/memory retire "Old lighthouse" it burnt down`.

The narrator sees the same handles: in a lookup line such as `⋯ read_lore ids=C3`, `C3` is the note
that `/memory show C3` prints. Lorebook entries are numbered `L1`, `L2`, … for one answer only, in
the order the narrator's searches found them; the next answer numbers them again. A typed entry of
a library book is not one of those: it has its `C<n>`, as `/memory` prints it.

One numbering covers the whole Compendium: the books' typed entries first, then the session's
entries in the order they were written. So adding a book with typed entries moves the notes'
handles up by that many, and removing it moves them back (`/lore add` and `/lore rm` say so).

## The Compendium

The Compendium is the story's book of its world: who is who, where things are, what happened. Each
entry has a type and fields. A character has a role, a state, relationships and memories; a place
has a parent place and dangers; and so on. There are 11 types: `character`, `location`, `item`,
`power`, `organization`, `event`, `plot`, `threat`, `worldbuilding`, `summary` and `creature`.

The design is Chi's (Coneja-Chibi). She built the Compendium for RoleCall and Bunraku, and rp-core
ports it; [`PROVENANCE.md`](../PROVENANCE.md) lists what was taken and what changed, and
[`docs/COMPENDIUM-DEVIATIONS.md`](COMPENDIUM-DEVIATIONS.md) lists every place where it differs
on purpose, for her review.

M5a built the data and the manual part; M5b adds the agents that write by themselves. Entries come
from:

- **library books:** a RoleCall Compendium export, added to the session like any lorebook;
- **you:** `/memory new` writes an entry in your editor, `/memory edit` changes one;
- **your notes** (`/memory add`, see [Notes](#notes)): Compendium entries without a type;
- **the agents:** in the background, the filing agent writes what each answer established, and the
  historian writes summaries and `[Arc]` overviews of the story ([below](#the-background-agents)).

Picking the entries before the answer with a model (recall) is still to come ([Not in M5b
yet](#not-in-m5b-yet)).

**Notes and typed entries.** `/memory` lists both, with one numbering, but they reach the narrator
differently. A note is lore: it fires by its keys, 4 messages from the end.
A typed entry never goes through the lorebook engine: it reaches the narrator only through the
Compendium's own block (below), when the story names it. This holds for a book's typed entries too,
while the Compendium reads the book. A book's plain entries stay ordinary lore.

### Importing a RoleCall Compendium

RoleCall exports a Compendium as one JSON file (`compendium-v1.0.0`). It imports like any lorebook:

```bash
rp-core import lantern.compendium.json
```

```
lantern
rp-core: warning: RoleCall's stored tree and node constraints are dropped: rp-core derives the tree from the entries (tree)
rp-core: imported lorebook "Lantern" as <home>/library/lorebooks/lantern.json
rp-core: hint: /lore add lantern in the chat, or rp-core new --lore lantern
```

Then add it to a session: `--lore lantern` at `new`, or `/lore add lantern` in the chat. Both also
take the file itself and import it on the way.

- **The name.** The book is named by the name inside the file: "Lantern" becomes `lantern`. `--as
  <name>` picks another.
- **Typed entries** keep their type, their fields and their aliases. A typed entry with no filled
  field stays plain lore.
- **The rest.** RoleCall's plain entries become ordinary lorebook entries, with their keys,
  positions and settings; the warnings name the settings rp-core does not honour.
- **`[Arc]` overviews** become arc entries of the Compendium (`/memory list arc`). They no longer
  fire as lore every turn: they reach the narrator through the [`{{recap}}` slot](#the-recap-slot)
  once the story is long enough to be trimmed. With the Compendium off, or the book set `"off"`, they
  are plain lore again.
- **The tree.** RoleCall's stored tree is dropped: rp-core builds the tree from the entries
  (`/memory tree`).
- **The book file never changes.** When you edit one of its entries, the change is kept in the
  session as an *overlay* over the book. One book can serve several stories.

### What the narrator gets

Before each answer a selector picks the entries the story names. It calls no model. In this order:

1. **`mention`:** entries your message names;
2. **`window`:** entries named in the 4 messages before it;
3. **`constant`:** a book's entries marked constant.

- **Names.** An entry is named by its name, by an alias, or, for a book's entry, by one of its
  lorebook keys (not a `/regex/` one). Words match by their roots, ignoring case. A name matches
  when every significant word of it is in one message, in any order: «Это фонарь вашего мужа,
  Гордея?» names «Фонарь Гордея», and «Мире» names «Мира». These must appear in order instead: a
  book's keys (with their secondary keys, as in the lorebook), the titles of events, plots and
  summaries, and names with a one- or two-letter word or a word like «the» («Блок А», «The Lantern
  Guild»).
- **Last in their group:** entries about the card's character or your persona, whose names come up
  in almost every message.
- **Never picked:** notes (they are lore), arcs and retired entries.

The picks go into one block at depth 1, just above your message: after any lore or author's note at
that depth, before the Director's directive. `/preview` shows it as `compendium:block`. From a live
run on Mag-Mell 12B (window 16 384), the block sent with «Это фонарь вашего мужа, Гордея? Он висит у
двери.»:

```
[Retrieved World Knowledge]
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
…
```

The card says nothing about a lantern; the answer took its facts from the entry. Марфа looks at
«медный фонарь» and says «Он брал его с собой на перевоз».

How much of each entry goes in depends on the profile:

| Profile | Used by `auto` | Entries | Each entry | The block |
|---|---|---|---|---|
| `full` | on a window of 24 576 tokens or more | up to 12 | whole, up to 4 000 characters; a longer one as a brief of up to 1 200 | what the lore budget leaves |
| `lite` | below 24 576 | up to 6 | always a brief, up to 700 characters | what the lore budget leaves, at most 1 600 tokens |

- **The window** is the narrator's. `profile` under `[compendium]` can fix one.
- **A brief** is the name, one line about the entry, then its main fields as `Label: value` lines: a
  character's role, state, closest relationships and last memories; a place's type, parent and
  dangers; an item's owner and condition; and so on.
- **`(more: read_lore C8)`** ends a brief that left something out, when the narrator has the lore
  tools for this answer. `read_lore C8` returns the whole entry. `search_lore` finds Compendium
  entries too, and the lore tools are offered when an entry was not sent.
- **The budget.** The block shares the lore budget with the lorebooks. When there is something to
  send, the lorebooks may use 60 % of it, and the block gets what they leave (`min_share = 0.4`). An
  entry that does not fit is cut, and the next one is tried. With nothing picked, the request is the
  same as without the Compendium.
- **Held back while the prompt still shows them:** what the agents filed from messages that are
  still in the prompt. A summary waits until its messages are trimmed, an event or a plot until the
  answer it was filed from is, and a character's memories one by one. `/trace` counts them as
  `hidden by freshness`. Your entries, the books' and the arcs are never held back.

`/trace` gives the block one line. From the same answer:

```
  compendium: lite · picked 3: C8 "Фонарь Гордея" (mention), C1 "Глеб" (window), C2 "Сыч" (window) · injected 3: C8 "Фонарь Гордея" brief 72 tok, C1 "Глеб" brief 96 tok, C2 "Сыч" brief 70 tok · block 244 tok
```

The profile; each pick and why; what went in, as `brief` or `full`, and its cost; then, when they
happen, `cut by the budget`, `over the entry limit (lite: 6)` and `hidden by freshness`. The counts
are budget tokens ([Testing the lore](#testing-the-lore)), so `/preview` shows the same block a
little smaller.

**Known limits of matching by roots.** A short one-word name can match a common word: «Мира» also
matches «мир» (world). A vowel that drops out misses: «Уголёк» and «Уголька» have different roots.
The words of a name split over two messages do not count. In a long message the words of a name
can match even when they belong to different sentences, and a hyphenated name («Жан-Поль») matches
in any order too.

### The Director's [COMPENDIUM CONTEXT]

With [the Director](#the-story-director) on, its prompt also gets a short snapshot of the world from
the Compendium: the characters, their relationships, the tensions between them, and the key places.
First come the characters named in the last 6 messages, the card's character and your persona; then
those they have relationships with; then featured entries; then the rest. Lite fits it into 1 500
characters (6 characters, 3 tensions, 2 places), full into 4 000 (15, 5, 5); long fields are cut.
From the same live run, the Director's request for that answer (kept with `--keep-requests`):

```
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

Only characters and places go in. Building it calls no model.

### The background agents

Two agents keep the Compendium up to date while you play. Both run in the session's *background
lane*: one call at a time, between turns, on the [recorder's model](#the-recorder-their-model) (by
default the narrator's). They are on whenever the Compendium is on.

- **The filing agent** reads an answer once it is *accepted*: once you have answered it with your
  next message (`[compendium.filing] wait = 1`). It reads the answer and the message it answers, and
  files what lasts: a new character, place, item, event or plot, or a change to one already there
  (a memory, a relationship, a new state). A name or alias the Compendium already has extends that
  entry instead of making a second one, and a book's entry gets an overlay, as with `/memory edit`.
  The greeting is card material and is never filed; neither are hidden messages.
- **The historian** comes after filing. Every `interval` player turns (default 20), or once
  `recap_after` messages (default 24) since its last pass have been trimmed from the narrator's
  prompt, it reads the messages since its last pass, with a few before them for context. It writes
  summaries, each under a plot (the plot names the Compendium already has are reused, a book's
  included), and for each plot its summaries name, an `[Arc]` overview of the whole thread,
  rewritten each time.
- **The narrator** gets their work like any other entry: [the block](#what-the-narrator-gets) sends
  the filed entries the story names, and the [`{{recap}}` slot](#the-recap-slot) sends the overviews
  and summaries once old messages are trimmed.

From the third live run on Mag-Mell 12B (Ollama, window 16 384, the Director on, the innkeeper
book, `idle_delay_sec = 2` and the historian every 2 turns for a short run), from the first
`/memory wait`, after the second message:

```
you   › /memory wait 300
⋯ memory: filing #3 → +1: C11 "Марфа"
the background lane is idle
you   › Расскажите, кто у вас тут бывает. Кажется, вон тот охотник на меня косится.
  ⋯ director: planned — no changes
Марфа › Марфа бросила взгляд через залу на угрюмого бородача в волчьей шапке у дальней стенки, …
  [swipe 1/1 · 300 tok · 13.9s · length]   /r swipe  /c continue  /e edit
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
```

- **`filing #3`** is the pass of answer #3 (the numbers are `/show`'s). It made C11, Марфа (the
  card's character, from what the story said about her); the next pass added to the book's «Горелая
  балка» (C4) as an overlay.
- **`historian #1–#5`** read messages #1 to #5. Its three summaries went under the book's plot
  «Пропавший обоз», and C15 is that plot's overview.
- **`/memory wait`** made the script wait for the passes. Without it each line still prints, at the
  next pause.

`/memory show` names the pass that wrote an entry. Printed by today's code from that run's journal:

```
you   › /memory show C14
C14 Разговор о дороге в Велеград · summary · summary:75a397f6.2
  origin: this session, filed by the historian from #5 (hist:d3c818d8-75a397f6) at journal row 34
  covers messages #1 … #5

  # Разговор о дороге в Велеград

  Елисей спрашивает Марфу о шуме на дороге и узнаёт, что мост в Горелой балке в плохом состоянии. Марфа советует быть осторожным и не застревать там на ночь.

  ## Parent plot
  Пропавший обоз
…
you   › /memory show C15
C15 [Arc] Пропавший обоз · arc · arc:пропавший обоз
  origin: this session, filed by the historian from #5 (hist:d3c818d8-75a397f6) at journal row 34

  # [Arc] Пропавший обоз

  Елисей, землемер, направляющийся в Велеград, останавливается на ночь в трактире «Сонный гусь». Он беседует с хозяйкой Марфой о цели своей поездки и узнаёт о плохом состоянии моста в Горелой балке, что может осложнить его путь. Марфа советует быть осторожным и не застревать там на ночь.
```

**Reading what a model sends.** Small models rarely answer in exactly the asked shape, so the
answer is read leniently: JSON in a fence or among prose, several envelopes, type names in English
or Russian («персонаж», «место»), camelCase field names. A field that cannot be used is dropped and
the rest of the item kept; `· 1 skipped` on the line counts them. A memory must say what changed in
the character (`changed_belief` or `changed_behavior`): a plain record of events is dropped.

### When they run

The lane works out what is owed after every change (an answer, a swipe, an edit, `/memory on`),
from the story itself, so there is no queue to manage.

- **Never during a turn.** A pass starts only once the turn has ended, and a turn never waits for a
  pass: the message you send goes to the narrator at once.
- **On a local server** (`localhost`, a private address, a `.local` name) the narrator and the
  agents share the server. A pass waits until the server has been quiet for `idle_delay_sec` (8 s)
  after the last answer, swipe, continue or edit, so a `/r` right after an answer is served first. A
  message you send while a pass runs takes the server: the pass gives way and runs again at the
  next pause, and that does not count as a failed attempt. A pass that gives way 3 times in a row
  goes first at the next pause (notice `memory_starved`).
- **On a hosted API** a pass starts when the turn has ended and may run beside the next turn while
  the connection has a free place (`max_in_flight`). When it has none, the turn takes the place and
  the pass gives way.
- **Failures** are tried again after a wait (15 s, then 30 s, doubling up to 5 min). After
  `max_attempts` (3) failed attempts the task is *parked* until `/memory retry`. When two tasks of one
  agent park in a row, that agent pauses (notice `memory_paused`) until `/memory retry` or the next
  open. A pass too big for the recorder's window parks at once (`no_room`).
- **Leaving.** `/quit` does not wait. A pass that was running is dropped and runs again when the
  session opens next, as after a crash; nothing is written twice (the demo kills a filing call with
  `kill -9` and checks it). A piped script does not wait for the lane either, unless it says
  `/memory wait`.
- **One-shot commands** (`send`, `preview`, `compact`, and `new` without the chat) start no
  background work. The next `chat` or `tui` on the session files what they left.
- **`RP_CORE_LANE=manual`** runs the background work only at `/memory wait`. The tests set it; the
  default is `auto`.

In the live runs the script waited for every pass (`/memory wait`), so no pass raced a turn there.
Giving way and the idle wait are checked by the tests, with a one-place server and fake clocks
(`test/lane-m5b`, `test/sched-m5b`; [`docs/M5B-DEMO.md`](M5B-DEMO.md) §3).

### Swipes, rewinds and edits

What an agent writes is bound to the answer it came from (the historian's pass to the last answer it
read), and the Compendium is read from the current path:

- **A swipe or a rewind** takes the replaced answer's entries and changes off the path. Going back
  to it (`/[`, `/]`, `/goto`) brings them back, without a call. A swipe before the answer was
  accepted costs no call at all: the new version is filed once you answer it.
- **An edit or a hide** of a message a pass read makes that pass stale. The lane files it again from
  the new text, and the new record replaces the old. Your own `/memory edit` of an agent's entry is
  kept: it applies after the new pass.
- **A fork** copies what was filed. Answers that were not yet accepted at the fork point are filed on
  the fork.
- **Turning the Compendium on** mid-story (`/memory on`) files only the answers after that moment,
  and the historian starts there too. A session made with the Compendium on (every new session, and
  the sessions made since M5a) owes its whole story, so an older one may open with many answers to
  file (notice `memory_backlog`; `/memory status` counts them). `/memory off` and then `/memory on`
  starts from that moment instead.

### The `{{recap}}` slot

While the whole story fits the window, the slot is empty and the request is the same as without
it. Once the oldest messages are trimmed, one system message goes where they were, right after the
greeting:

1. **`[Arc] <plot>`** and its overview, for the plots of the summaries in the slot (the most recently
   active first), then the books' `[Arc]` overviews. Together they take at most half of the slot;
   lite takes at most two, each cut to 1 200 characters. A session arc replaces the book's arc of
   the same plot.
2. **`[Summary: <title>]`** and its text, for the summaries that cover the trimmed messages, oldest
   first. When they do not fit, the oldest go first.

- **Its size:** at most 10 % of the narrator's window, taken from the history's share.
- **Stable while the cut stays.** Until the cut moves, every request gets the same overviews and
  summaries, an overview the historian rewrote meanwhile included (as it was), so a server that
  caches the prompt keeps its cache.
- **In a preset.** A preset with `{{recap}}` in an enabled block gets the slot there instead.
- **Compendium off:** no slot.

From the M5b demo on a scripted model with a 4 096-token window, once trimming started
([`docs/M5B-DEMO.md`](M5B-DEMO.md) §2 g), the `/trace` line and the slot in `/preview`:

```
  recap: 1 arc: C21 "Украденный свет" rev 41 · 1 summary: C20 "Переправа к маяку" · boundary 1f6b8745
```

```
#7 system · recap · 156 tok
[Arc] Украденный свет
Маяк погас, Латунный фонарь сняли. Ян привёз Мире стекло фонаря, а лодочник Фрол видел в ночь кражи лодку с солью у Старой пристани: след ведёт к Соляному суду.

[Summary: Переправа к маяку]
Лодочник Фрол перевёз Яна через гавань к Серому маяку и рассказал, что в ночь кражи у Старой пристани стояла лодка с солью, а один мешок звенел. У маяка Мира развернула свёрток Яна: в нём было целое стекло Латунного фонаря.
```

`rev 41` is the journal row that wrote the overview; the boundary is the first message kept after
the cut. The live runs' 16 384-token window held the whole story, so their `/trace` has no `recap:`
line.

### The recorder, their model

- **By default the narrator's** connection and model, nothing else: not its reply limit or
  samplers. The agents use temperature 0.3 and up to 4 096 tokens per answer (1 500 on lite).
- **A model of their own:** `recorder = "conn:model"` under `[roles]` for new sessions, or
  `/model recorder <conn:model>` in the chat; `/model recorder narrator` makes it follow the narrator
  again. A cheaper hosted model costs less; a connection to another server keeps the agents off the
  narrator's place and its prompt cache. Two connections to one server share its places (notice
  `slots_shared`).
- **Profile.** By the recorder's window: `profile = "auto"` runs them lite below 24 576 tokens. Lite
  sends a roster of up to 60 entry names instead of the whole Compendium and asks for at most 6
  items per pass; full sends the Compendium (up to 30 % of the window) and runs lite when that would
  not leave 4 096 tokens for the answer.
- **Time:** `timeout_sec` under `[compendium.filing]`, for both agents: 300 s on a local server and
  120 s on a remote one.
- **No connection:** when the recorder's connection is not in `config.toml`, nothing runs, and the
  notice `recorder_unavailable` says so once.

`/model` lists it. From the third live run's journal:

```
you   › /model
  narrator ollama:magmell-16k:latest
  director narrator (follows)
  recorder narrator (follows)
  recall   narrator (follows)
```

### The language they write in

`language` under `[compendium]` names it for new sessions (`language = "Russian"`): both agents'
prompts then end with «Write every field value in Russian.» Left blank (the default), rp-core names
the story's language itself, from the script of the texts the agent reads: Cyrillic is Russian, or
Ukrainian, Belarusian, Serbian or Macedonian by their own letters; Greek, Japanese, Chinese,
Korean, Arabic, Hebrew and Thai are named too. A Latin or mixed text names nothing, and the prompt
says «Write every field value in the language the story is written in.» instead.

Naming it matters on small models. In the second live run the prompts had only that general line:
Mag-Mell 12B filed in Russian, but its historian wrote English summaries of the Russian story:

```
⋯ memory: historian #1–#7 → +4: C15 "The Sleeping Goose's History", C16 "The Traveler's Arrival", C17 "The Innkeeper's Tale", C18 [Arc] "The Sleeping Goose's History"
```

With the language named, the third run's historian wrote «Прибытие землемера в трактир», «Разговор о
дороге в Велеград» and the arc of «Пропавший обоз» in Russian (above). The narrator's own drift into
English is the Director's matter ([Language](#language)).

### Lines, the agents pane and notices

Each pass that ended prints one dim line between turns, never inside an answer: at the next pause,
during `/memory wait`, or above a fresh prompt. The numbers are `/show`'s.

| Line | What it means |
|---|---|
| `⋯ memory: filing #3 → +2: C17 "Фрол", C6 "Серый маяк"` | The pass of answer #3 changed these entries, new ones and overlays alike. `· 1 skipped` counts what the reader dropped |
| `⋯ memory: historian #1–#7 → …` | The historian's pass over messages #1 to #7 |
| `⋯ memory: filing #13 → nothing to file` | Nothing worth filing; the historian says `nothing to record`, and `nothing new` means what it wrote changed nothing |
| `⋯ memory: filing #7 gave way to a turn; it runs again at the next pause` | A turn took the server; not a failed attempt |
| `⋯ memory: filing #7 failed [<code>] (attempt 1 of 3)` | A failed attempt; it is tried again after a wait |
| `⋯ memory: filing #7 parked after 3 failed attempts: /memory retry #7 runs it again` | Parked until `/memory retry` |
| `⋯ memory: undo → −2: C17 "Фрол", event "Лодка с солью"` | What `/memory undo` took back |

In the [TUI](#the-agents-pane) the agents pane gives each agent a block. Notices print as yellow
`! <text> (<code>)` lines, once each:

| Notice | When | Do |
|---|---|---|
| `memory_backlog` | More than `every_n + 3` accepted answers wait to be filed: the recorder cannot keep up | A second slot on the server, a separate connection for the recorder (`/model recorder`), or a larger `[compendium.filing] every_n` |
| `memory_starved` | Turns took the same pass away 3 times in a row; it goes first at the next pause | The same; a server that keeps prompts in a host cache helps too |
| `memory_paused` | Two tasks of one agent were parked in a row: that agent starts nothing new until `/memory retry` or the next open | Check the recorder's connection and model (`--debug` shows the server's words), then `/memory retry` |
| `recorder_unavailable` | The recorder's connection is not in `config.toml` (or its model cannot be resolved): nothing runs | `/model recorder <conn:model>` with a connection you have, or add the connection |
| `filing_classic_conflict` | The filing agent wanted to file a name that a book has as a plain, untyped entry; it was not filed | Give the book's entry a type, or let the name go |
| `slots_shared` | Two connections the session uses are one server: they share its places, so the background waits for turns there | Nothing; it is information |

### Cost and speed

- **One call per accepted answer**, plus a historian call every `interval` player turns. On a hosted
  API that is money: `[compendium.filing] every_n = 3` files three answers in one call, and a
  cheaper [recorder](#the-recorder-their-model) costs less.
- **On Mag-Mell 12B** (Ollama, window 16 384, lite, tagged answers), over the three live runs, a
  filing pass took 1.4–11.2 s and a historian pass 6.9–10.5 s, each on its first attempt.
- **`/usage`** has a row per agent, each priced by its own model. From the third live run, printed
  by today's code from its journal:

  ```
  usage on this path:
    narrator   3 generations · in 10100 tok · out 900 tok · cost unknown
    director   3 calls · in 13766 tok · out 1278 tok · cost unknown
    filing     2 calls · in 3373 tok · out 266 tok · cost unknown
    historian  1 call · in 1363 tok · out 628 tok · cost unknown
    total      in 28602 tok · out 3072 tok · cost unknown
  ```

- **On a one-place local server** each pass also pushes the narrator's prompt out of the server's
  cache, so the next answer processes its prompt again. The idle wait keeps a swipe or a quick reply
  from paying for that; a second slot or a separate server for the recorder avoids it.

### The /memory commands

| Command | What it does |
|---|---|
| `/memory`, `/memory list [type\|note\|arc] [--retired]` | The Compendium of this path, grouped as in the tree: per entry its handle, name, aliases, a line about it, its book and its size. Give a type (or `note`, `arc`) for just those; `--retired` adds the retired ones |
| `/memory show <ref>` | One entry: its key, aliases, where it came from (a book, an overlay, you), when it last changed, and its whole text, as `read_lore` gives it |
| `/memory tree [book]` | The session's own tree, then one per book (or only that book's) |
| `/memory new <type> [name]` | A new entry, written in your editor ([below](#writing-entries-in-the-editor)) |
| `/memory edit <ref>` | Change an entry in your editor. A book's entry gets an overlay; the book file stays as it is |
| `/memory retire <ref> [reason]` | The entry leaves the story: no block, no lore tools. It stays in the journal. A name of several words needs no quotes: the longest run of first words that names an entry is the ref, the rest the reason |
| `/memory restore <ref>` | A retired entry comes back |
| `/memory export <name> [--format core\|compendium] [--force]` | Copy this session's entries out ([below](#exporting)) |
| `/memory on`, `/memory off` | Send the Compendium from the next answer, or stop. The entries are kept either way |
| `/memory add <title> \| <keys> \| <text>` | A note ([Notes](#notes)) |
| `/memory undo <n> [file\|hist]` | Take back what the agents wrote from message *n*: the filing pass bound to it and the historian's pass whose window holds it, or only the one you name. Their changes leave from the next turn, and the lane does not repeat an undone pass (an edit of the message later still files it again) |
| `/memory refile <n> [file\|hist]` | Run the passes bound to message *n* again, or only the one you name; an accepted answer that was never filed gets its filing pass. The new pass replaces the old one, an undo too. A refile lasts while the session is open |
| `/memory retry [n]` | Run the parked tasks again (those that failed every attempt), or only message *n*'s. It also wakes a paused agent |
| `/memory wait [sec]` | Wait until the background work is done, at most *sec* seconds (up to 24 h). Ctrl+C stops the waiting, not the work |
| `/memory status` | The background work: what runs, what is queued, held or parked, and how many accepted answers are not filed yet |

`<ref>` is the entry's handle (`C16`), its key (`character:мира`), or a name or alias only one entry
has. `<n>` is a message: its number as `/show` prints it (`5` or `#5`), or its id. `undo`, `refile`
and `retry` are refused while an answer is being written. For example:

```
/memory list character
/memory show Мира
/memory new character Мира
/memory edit Ульяна
/memory retire C2 уехала из города
/memory export lantern2 --format compendium
/memory undo 9
/memory refile 9 file
/memory wait 60
```

An undo and a refile from the second live run (Mag-Mell 12B). The second call filed less than the
first: the agents run at temperature 0.3, so a refile can come out differently.

```
you   › /memory wait 300
⋯ memory: filing #9 → +2: C2 "Сыч", C19 "Происшествия на дороге" · 1 skipped
the background lane is idle
you   › /memory undo 9
undone: filing #9; what it wrote leaves the Compendium from the next turn (/memory refile #9 file runs it again)
⋯ memory: undo → −2: C2 "Сыч", event "Происшествия на дороге"
you   › /memory refile 9
filing #9 queued again (/memory wait waits for it)
you   › /memory wait 300
⋯ memory: filing #9 → +1: C2 "Сыч"
the background lane is idle
you   › /memory status
the Compendium's background lane is idle: nothing queued, nothing parked
```

- **`/memory status`** while work is waiting starts with the counts, as `the Compendium's background
  lane: 1 running, 2 queued, 1 parked · 3 answers not filed yet`, then one line for the running pass
  (with ` · waiting for a place on the server` while it waits for the server), the queued ones, the
  held ones (their agent is off for this session) and each parked one with the `/memory retry` that
  runs it again. `blocked:` or `paused:` under the first line says why nothing can start.
- **`/memory wait`** prints the passes as they end, then `the background lane is idle` (`: nothing
  to do` when nothing ran), with what is parked or not filed yet; after *sec* seconds it says what
  still runs.

`/memory list` right after adding the book `lantern` (from the demo):

```
you        › /memory list
The Compendium of this path: 15 live · /memory show <ref> prints one
Cast (3)
  C1  Арсений Кеттер (aka Старшина, Арсений) — Старшина Гильдии фонарщиков, сорок лет зажигает огни Вельмара. [lib: lantern] [featured] [1.6k]
  C2  Селина Бранд — Хочет, чтобы свет принадлежал городу. [lib: lantern] [406]
  C3  Ульяна (aka Смотрительница) — Смотрительница Серого маяка, тридцать зим не пропустившая ни одной ночи. [lib: lantern] [338]
Places (3)
  C4  Вельмар — Портовый город на Сером мысу; ночью его улицы держат только фонари. [lib: lantern] [256]
…
```

`[lib: lantern]` marks a book's entry, `[lib: lantern, edited]` one with an overlay. The last number
is the size of its fields in characters (of a note or an arc: of its text).

```
you        › /memory tree
World Knowledge (this session) · 0
Lantern (lib: lantern) · 15
  Cast · 3
    Гильдия фонарщиков · 1: C1 Арсений Кеттер
    Соляной суд · 1: C2 Селина Бранд
    Unaffiliated · 1: C3 Ульяна
  Places · 3
    C4 Вельмар · 3
      C5 Фонарный ряд
      C6 Серый маяк
  Items · 1: C7 Латунный фонарь
…
```

The tree is built from the entries, as in RoleCall: Cast, Places, Items, Powers, Organizations,
Events, Plots, Threats, Worldbuilding, Narrative and Bestiary; characters grouped by their
affiliation, places under their parent place, events by their plot. A tree of fewer than 5 entries,
or of more notes than typed entries, is grouped by category instead (one `General` group when there
are none).

- **Saved in the session.** Every change is one line in the journal, and shows from the next turn.
  A change is refused while an answer is being written.
- **On every branch.** Your entries and edits belong to no message: a swipe or a rewind keeps them,
  and a fork copies them with the same keys. What the agents wrote belongs to its answer
  ([Swipes, rewinds and edits](#swipes-rewinds-and-edits)).

### Writing entries in the editor

`/memory new character Мира` opens your editor (`$VISUAL` or `$EDITOR`, else editing in place; the
TUI uses its input box) on a template:

```json
{
  "//": "fill what you know; blank fields are ignored. role: protagonist|antagonist|ally|rival|neutral|background|deity|player_character; current_state.status: alive|dead|missing|transformed|imprisoned|unknown; relationships[].nature: ally|enemy|romantic|family|mentor|rival|unknown; relationships[].status: active|past|strained|unknown; memories[].emotional_weight: trivial|notable|formative|defining",
  "name": "Мира",
  "aliases": [],
  "description": "",
  "role": "",
  "current_state": {},
  "relationships": [],
  "memories": []
}
```

- **Fill what you know** and save. Blank fields are ignored. The `"//"` line lists the values a
  field may take; it is not saved. A summary's template has `title`, `summary`, `significance` and
  `participants`.
- **A mistake** (broken JSON, a missing name, a refusal) prints one red line, and the editor opens
  again on your text. In a piped script without a named editor nothing is written instead; there
  the in-place editor gets one line, so write the JSON on one line.
- **Nothing is written** when you quit without saving, or save it empty or unchanged.
- **A name already taken** by an entry of the same type, a book's included, is refused before the
  editor opens: `/memory new: "Мира" is already C16; use /memory edit C16`.
- **The confirmation** names the entry: `character C16 "Мира" filed (from the next turn)`.

`/memory edit <ref>` opens the entry's fields the same way. On save, what you changed or removed
becomes one edit; if nothing changed, nothing is written. The entry keeps its handle and its key.
Changing its name (`name`; a summary's `title`, a worldbuilding entry's `topic`) renames it: the old
name stays as a former name (`/memory show` lists it), and a name another entry of that type has is
refused. An arc opens as its `overview`, a note as its text.

A book's entry gets an overlay (from the demo):

```
you        › /memory edit Ульяна
character C3 "Ульяна" changed: set current_state (from the next turn; the book file stays as it is)
you        › /memory show Ульяна
C3 Ульяна · character · lib:lantern:00000000-0000-4000-8000-000000000e03
  aka: Смотрительница
  origin: the library book lantern, entry 00000000-0000-4000-8000-000000000e03; changed in this session (an overlay: the book file stays as it is)
  last changed at journal row 10
  keys: Ульяна
…
```

- **The book changes later:** the overlay applies over the new version of the entry.
- **The entry leaves the book, or the book leaves the session:** the overlay stays in the journal
  but is not applied, and the notice `library_entry_missing` says so once. It applies again when the
  book comes back (`/lore add`).
- **A very large entry** (12 000 characters of fields or more) gets the notice
  `compendium_large_entry` once. It still works; the block sends a brief of it.

### Exporting

`/memory export <name>` copies out what this session added to the world: its own entries and its
overlays (as whole entries), retired ones included and switched off. A book's untouched entries are
not copied: they are in the library already.

- **`--format core`** (the default): a library lorebook `<name>`; another session adds it with
  `/lore add <name>`. A library book of that name is refused unless `--force` replaces it; a book
  this session reads is never replaced.
- **`--format compendium`:** a RoleCall file, `<home>/exports/<name>.compendium.json`
  (`compendium-v1.0.0`), for RoleCall or for `rp-core import`. An existing file is refused unless
  `--force`. RoleCall keeps one featured entry per type, so a warning names the entries that lose the
  flag. More than 5 000 entries or 10 MB is refused: RoleCall would not import it.

```
you        › /memory export lantern2 --format compendium
exported 2 entries as a RoleCall Compendium file (compendium-v1.0.0): <home>/exports/lantern2.compendium.json
```

Imported again, that file gives the same types, names, aliases and fields.

### Turning it on and off

- **New sessions** have the Compendium on, and with it the background agents, on the narrator's
  model unless you [bind a recorder](#the-recorder-their-model). Sessions made before M5a have it
  off: `/memory on` turns it on, and `/memory` says when it is off.
- **`/memory off`** keeps every entry and stops the block, the `{{recap}}` slot, the Director's
  snapshot and the background agents. A book's typed entries and `[Arc]` overviews are then sent as
  plain lore again, with their text from the file. Notes are sent either way. While it is off,
  `/memory new` refuses a name that a book's entry of that type has: turn the Compendium on and edit
  that entry instead.
- **`/memory on`** later files the answers from then on, not the ones in between
  ([Swipes, rewinds and edits](#swipes-rewinds-and-edits)).
- **One agent only:** `enabled = false` under `[compendium.filing]` stops filing, `interval = 0`
  under `[compendium.historian]` stops the historian (new sessions).
- **One book as a plain lorebook:** set it `"off"` under `[compendium.books]` (new sessions).

### The [compendium] keys

`[compendium]` in `config.toml` sets new sessions only: a session keeps the values it was created
with, as with `[director]`. M5b reads these:

| Key | Default | What it does |
|---|---|---|
| `enabled` | `true` | Use the Compendium, its agents included; `/memory on` and `/memory off` switch a session |
| `profile` | `"auto"` | `auto`, `full` or `lite`: for the block by the narrator's window ([above](#what-the-narrator-gets)), for the agents by the recorder's ([details](#the-recorder-their-model)) |
| `min_share` | `0.4` | The part of the lore budget kept for the block when it has something to send, 0–1 |
| `language` | `""` | The language the agents write in, up to 80 characters; blank: the story's, named from its script ([details](#the-language-they-write-in)) |
| `guidance` | `""` | Your standing instructions to the filing agent and the historian, up to 4 000 characters. They cannot widen what the agents may write |
| `max_attempts` | `3` | Failed attempts (1–10) before a task is parked until `/memory retry` |
| `idle_delay_sec` | `8` | On a local server: how long (0–60 s) it must be quiet after an answer, a swipe or an edit before a background call starts ([details](#when-they-run)) |
| `[compendium.books]` | every book `"read"` | `<library id> = "read"` or `"off"`; an `"off"` book is a plain lorebook |

`[compendium.filing]`, the filing agent:

| Key | Default | What it does |
|---|---|---|
| `enabled` | `true` | File answers |
| `wait` | `1` | How many of your messages (0–5) must follow an answer before it is filed; `0` files it as soon as it is written, also before a swipe |
| `every_n` | `1` | Accepted answers (1–10) per filing call; a group waits until it is full |
| `allow` | every type but `summary` | The types it may write, e.g. `["character", "location", "item"]`. Summaries are the historian's |
| `timeout_sec` | 300 local, 120 remote | One call's time (1–3600 s), the corrective pass and retries included; the historian's too |

`[compendium.historian]`:

| Key | Default | What it does |
|---|---|---|
| `interval` | `20` | Player turns (0–100) between its passes; `0` turns it off |
| `recap_after` | `24` | It also runs once this many messages (1–1000) after its last pass were trimmed from the narrator's prompt |
| `overlap` | 10 full, 6 lite | Messages (1–100) of the part it already summarised that it reads again for context |

```toml
[compendium]
profile = "lite"
language = "Russian"

[compendium.books]
harbor = "off"

[compendium.filing]
every_n = 2

[compendium.historian]
interval = 10
```

The `[compendium.recall]` table is checked, so a typo is still an error, but nothing uses it yet:
it is for recall (M5c), as is the `recall` role.

### Keeping the requests

`--keep-requests` on `rp-core chat`, `tui` or `new` writes every model request of each turn to a
file:

```
<home>/sessions/<session>.requests/<call key>.json
```

In the live run, one answer with the Director on left `t_89099cd6_director_0.json` and
`t_89099cd6_narrator_0.json`; its swipe reused the plan and left only a narrator file. The
background agents' requests are kept too, by their job: the third M5b live run left
`j_2dbb27cd_filing_0.json` and `j_8b2fcecd_historian_0.json` among them. A call key that comes again
(a retry, a fallback) gets `-2`, `-3`. The file is the engine's request (messages,
tools, samplers), not the HTTP body (`/preview --wire` shows that), and never holds headers or keys.
It holds your story, so keep it where you keep sessions. Off by default; `send` and `preview` refuse
the flag.

### Not in M5b yet

M5c, the last part of the Compendium, is **recall**:

- **A model picks the entries.** Today the block holds the entries the story names, found by their
  words. Recall asks a model which entries the next answer needs, from an index of the Compendium
  (its tree on full, a short list found by words on lite). On a local server it can run ahead, between
  turns, so the answer does not wait for it; without a model the word match stays (`lexical`).
- **Its commands and keys:** `/memory recall`, `profile` and `mode`, the `[compendium.recall]` table
  and the `recall` role (`/model recall`). The commands already answer that they come with M5c.
- **Local servers:** pinning the narrator and the agents to their own slots on llama.cpp
  (`id_slot`), warnings about Ollama and LM Studio settings that make the server reload or swap the
  model, and
  `rp-core bench ttft` to measure the time to the first token.

The demos of the Compendium, step by step: [`docs/M5A-DEMO.md`](M5A-DEMO.md) (the data and the
manual part) and [`docs/M5B-DEMO.md`](M5B-DEMO.md) (the agents and the slot).

## The Story Director

The Story Director is one more model call before each answer. It reads the recent story and its own
plan from the turns before, and updates that plan:

- **chapters:** the current one, with a title; a new one at a major turn of the story;
- **arcs:** story threads, each with a status, the stages that already happened, and a *next beat*,
  the next concrete event to push;
- **seeds:** details planted now that should pay off later;
- **hidden arcs:** things that move behind the scenes, with the clues let slip so far (the full
  profile asks for them; lite does not);
- **a directive** for this answer: mood, pacing, the scene, character beats, an ending hook and more.

The narrator gets the directive near the end of its prompt (at depth 1) and writes the answer under
it. The plan is saved on the answer in the session's journal, so every point of the story has its
own plan. With [the Compendium](#the-compendium) on, the Director also reads a short snapshot of the
characters and places in the scene ([details](#the-directors-compendium-context)). The Director is
**off by default**.

### Turning it on

For new sessions, in `config.toml`:

```toml
[director]
enabled = true
```

In the chat, `/director on` and `/director off`. The switch is saved in the session and applies from
the next turn. `[director]` in `config.toml` sets new sessions only: a session keeps the values it was
created with, as with `[roles]`.

While it is on, the banner names its model and profile:

```
session s_0d042d8c · Марфа · narrator ollama:magmell-16k:latest (tools: prompted) · director ollama:magmell-16k:latest (auto) · ctx 16384
```

### Its model

- **By default it follows the narrator:** the same connection and the same model, nothing else. It
  does not take the narrator's reply limit (`--max-tokens`), samplers or reasoning setting.
- **Another model:** `director = "conn:model"` under `[roles]` in `config.toml` for new sessions, or
  `/model director <conn:model>` in the chat. `/model director narrator` makes it follow the narrator
  again.
- **Its own reply limit:** 1 500 tokens on the lite profile (2 524 when the model cannot stop
  thinking), up to 16 384 on the full one. Never more than its window leaves after the prompt, or
  than the model's own output limit.
- **Its own window:** the Director's model's window (`context_length` under `[caps."conn:model"]`),
  not the preset's.
- **Sampling:** temperature 0.7. Thinking is turned off when the model allows it.

### Profiles: lite and full

| `profile` | What runs |
|---|---|
| `auto` (default) | Full when the window is at least 24 576 tokens and the full prompt plus 4 096 tokens for the plan fits; else lite |
| `full` | Full when the window is at least 16 384 tokens and the full prompt plus 4 096 fits; else lite, with a notice once per session |
| `lite` | Always lite |

Lite is for small windows. Compared with full, it leaves out:

- the long rules: a short text instead, and a digest of the personality instead of its whole text;
- hidden arcs: no section about them in the prompt, no reminders about them, no hidden-arc updates in
  the plan's schema;
- most of the history: 10 % of the window instead of 25 %;
- long lists: at most 3 arc directions, 3 character beats and 2 callbacks per directive, 3 intentions
  kept instead of 5.

When even the lite prompt is too big, it shrinks further: first the history goes, then the lists it
shows (8 arcs and 10 seeds at most).

### Tagged or structured

- **Tagged** (the default): the plan's JSON schema is in the prompt, and the model answers with one
  `<plan>{…}</plan>` block.
- **Structured:** the server enforces the schema (`response_format`). Used only when that is
  confirmed for the model: by `rp-core probe <conn:model> --active --write`, by `structured_output =
  "json_schema"` under `[caps."conn:model"]`, or by a hosted catalog that says so (OpenRouter's, after
  `rp-core probe --write`).

If the server refuses structured output, the plan fails with `transport_unsupported`, and a notice
says what to do: `structured_output = "none"` under `[caps."conn:model"]`, or the active probe with
`--write`. If a plan cannot be read, the Director asks the model once more with a short correction.

### The director line

One dim line before each answer:

```
you   › Добрый вечер. Найдётся ли у вас комната на ночь? Я землемер, иду в Велеград.
  ⋯ director: planned — seeds +1 · chapter 1
Марфа › Марфа кивнула, слушая ответ Елисея, …
```

- **`planned — <summary>`:** what the plan changed. `arcs +1 ~2` is one new arc and two changed;
  `seeds +1 ~1 -1` is planted, reinforced, paid off or dropped; `hidden +1 ~1` the same for hidden
  arcs; `chapter 2` when a chapter started. A plan that changed only the directive and its intentions
  says `no changes`. A full line: `⋯ director: planned — arcs +1 · seeds +1 · chapter 2`.
- **`reused`:** a swipe (`/r`) keeps the plan the replaced answer was written under, without a call.
  `on_swipe = "replan"` plans again on every swipe instead.
- **`failed (<code>)`:** no plan this turn. The answer still comes, without a directive. The turn
  still counts, so ages go on; the plan stays as it was.

How it moves with the story:

- **`/regen <direction>`** always plans again, and the Director sees your direction too.
- **`/c`** makes no call: the continued text keeps its answer's directive.
- **Going back** (`/rewind`, `/goto`, `/[` and `/]`) brings back the plan of that point. The next
  plan starts from it; the plans on the other branch stay there.

The codes of `failed (<code>)`:

| Code | What happened | Do |
|---|---|---|
| `undecodable` | The plan was cut off or its JSON could not be read, also after the correction | See [Troubleshooting](#troubleshooting) |
| `no_output` | The answer held no plan at all, also after the correction | The model does not follow the format; try another one for the Director |
| `missing_directive` | The plan's directive set nothing | Usually passes on the next turn |
| `no_room` | The Director's window cannot hold even its shortened prompt and 600 tokens for the plan. Nothing was sent | A bigger window ([Small windows](#small-windows)) |
| `timeout` | No plan within the time budget (`timeout_sec`) | Raise `timeout_sec`, or a faster model |
| `provider_error` | The server refused or failed the call (after one retry when that can help) | `--debug` shows the server's words |
| `transport_unsupported` | The server refused structured output | Do what the notice says |
| `no_connection` | The Director's binding names a connection that is not in `config.toml` | Fix the connection, or `/model director narrator` |
| `aborted` | You pressed Ctrl+C while it planned. The answer stops too | Nothing |

### /director show

`/director` (or `/director show`) prints the plan at the current point of the story. From the second
live run on Mag-Mell 12B, after four Russian turns (printed by today's code from that run's journal;
[`docs/M4-DEMO.md`](M4-DEMO.md) §3):

```
director on · ollama:magmell-16k:latest (the narrator's model) · profile auto · style the-balanced
turn 4 · planned on 6af484fb · tagged · lite · ollama:magmell-16k:latest
chapter 1 "A Warm Welcome" · active · 3 turns
arcs: none
seeds: 1 waiting
  seed-1 "The old map" · long · age 3/10 · 0 reinforcements
hidden arcs: none
intentions:
  must · next: Demonstrate Marfa's hospitality and care for Elisey's wellbeing by offering a safe, alternative path, building her character arc as a knowledgeable and caring host.
  should · eventually: Plant the idea of a hidden, potentially secret route that could factor into Elisey's journey, hinting at future story developments.
last directive (turn 4, as sent):
[DIRECTOR CONSTRAINTS - BINDING THIS TURN]
The following are non-negotiable scene constraints decided by the Story Director.
They take precedence over any internal planning, director framework, or evaluation
protocol you may otherwise apply to arc/callback/character-beat decisions.
Your job is to render these constraints as excellent prose. Do NOT second-guess
which arc to advance, which callback to weave in, or which character beat to hit -
the Director has already made those decisions. Execute them.

Mood: warm and inviting

Scene Guidance:
  Setting: A cozy, dimly-lit inn room with a crackling fireplace
  Atmosphere: Intimate, with the scent of herbs and honey
  Tension: mild (3/10)

Narrative Goal: Establish Marfa as a knowledgeable and caring host who looks out for travelers' safety

Story Arc Directions:
  - "Marfa's Concern for Travelers" (moderate): Show Marfa offering Eлиsey a safe, alternative route out of concern for his wellbeing

Character Beats:
  - Marfa: Expresses worry about the state of the roads and bridges

[Ending: Marfa leans in closer, her voice barely above a whisper]
[/DIRECTOR CONSTRAINTS]
```

- **First line:** on or off, the model, the profile, the style.
- **`turn 4 · planned on 6af484fb`:** the Director's turn count, the last result (`planned`,
  `reused (the plan of <id>)` or `failed (<code>)`) and the answer it is saved on; then the
  transport, the profile and the model, and `N skipped` when parts of the plan were dropped.
- **Chapter:** number, title, status, age, and how many chapters are completed.
- **Arcs:** id, title, status, priority, horizon, age, and `stale: N turns without progress` after 15
  such turns; below each, `next:` with the pending next beat.
- **Seeds:** hint, payoff horizon, `age N/T` (T: the age at which the payoff is due; `OVERDUE` from
  then on), reinforcements, and `ripe for payoff` (age 30 or more with 2 or more reinforcements).
- **Hidden arcs:** id, title, status, type, `age N/T` (with `OVERDUE`) and the number of clues.
- **Intentions:** what the Director means to do next, by priority and target.
- **Last directive:** the whole `[DIRECTOR CONSTRAINTS - BINDING THIS TURN]` …
  `[/DIRECTOR CONSTRAINTS]` block, exactly as the narrator got it (after the persona filter), dim and
  not indented, so a copy is the exact text. This holds in `rp-core chat` and in the TUI (Ctrl+D). The
  heading says where it comes from:
  - `last directive (turn 4, as sent):` the plan of the answer at the head;
  - `last directive (turn 4, reused from <id>, as sent):` a swipe that reused the plan of `<id>`;
  - `last directive (turn 2, as sent on <id>; turn 4 sent none):` the head's plan failed, so this is
    the last block sent before it on this path, on answer `<id>`;
  - `last directive (turn 2, as the Director wrote it; turn 4 sent none):` no answer on this path
    carries a sent block; this is the Director's own copy, as it wrote it (before the persona filter);
  - `no directive yet`, and `…: empty (the narrator got no Director block)` for a plan that left
    nothing to send.

Before the first plan it says "The Director has not planned yet." With the Director off, it says so
and still shows the kept plan.

While the Director is on, the narrator's prompt also holds a fixed block, the contract: follow the
directive, never act, speak or decide for your persona, keep the story's language. It is sent on
every turn, failed plans included. `/preview` shows it, and a placeholder where the directive will go.

### Cost and speed on local models

- **One more call per answer** (two when the correction runs). A turn has at most 12 model calls,
  the Director's included.
- **About 8 s more per answer** on Mag-Mell 12B (Ollama, window 16 384, lite, tagged): plans of
  404–460 tokens took 7.6–8.8 s each once the model was loaded. The first one, while the model
  loaded, took 110 s. An answer with its plan took 13–14 s; a swipe that reused the plan, 5.1 s.
- **No shared prompt cache:** the Director's prompt and the narrator's differ from the first token.
  On a server that keeps one prompt in its cache, the Director's call pushes out the narrator's, and
  the narrator's prompt is processed again.
- **Where to see it:** `/trace` lists the calls (`calls: director … 7.6s, narrator … 5.6s`); `/usage`
  adds a row per agent, each priced by its own model.

### Small windows

The Director needs room for its prompt and at least 600 tokens for the plan. Without it nothing is
sent: `failed (no_room)`, with a notice once per session.

- **A 4 096 window is too small.** That is Ollama's default. The lite system prompt alone takes about
  2 500 tokens there. In a test of 40 turns only turns 1 and 3 plan; the other 38 fail `no_room`. Give
  the model a bigger window ([details](#the-context-window-the-one-thing-to-get-right)), or give the
  Director a model with one.
- **8 192 is enough** for a lite Director in the tests: a story of 40 Russian turns plans on every
  turn; from turn 16 on, the history is left out of the Director's prompt.

### Language

The directive and the contract are in English. The contract tells the narrator to write in the
story's own language. Small models may still drift: in the live run Mag-Mell 12B kept a Russian story
in Russian in 5 of 6 answers and switched to English in the middle of one. In the first M5b live run
(the same model, the Director on) it mixed English and Spanish into its third answer and wrote the
fourth and fifth in English («Марфа испуганно перекрестилась и шепотом начала свой story: " Months
ago, …»). `/r` asks again; `/director off` removes the English directive. The Compendium's agents
are told the story's language separately ([details](#the-language-they-write-in)).

### The [director] keys

| Key | Default | What it does |
|---|---|---|
| `enabled` | `false` | Plan every reply |
| `profile` | `"auto"` | `auto`, `full` or `lite` ([above](#profiles-lite-and-full)) |
| `on_swipe` | `"reuse"` | `reuse`: a swipe keeps the plan; `replan`: a swipe plans again |
| `instructions` | `""` | Your standing instructions to the Director, sent as written, up to 2 000 characters |
| `style` | `"the-balanced"` | The Director's personality (below). An unknown value is `the-balanced` |
| `creativity` | `"moderate"` | `subtle`, `moderate` or `dramatic` |
| `timeout_sec` | 660 local, 180 remote | The Director's time per turn, 1–3600 seconds; the correction and a retry share it |

The ten personalities (`style`), from Bunraku and RoleCall:

| `style` | Name | Its line |
|---|---|---|
| `the-weaver` | Meridian | The world breathes. Your choices matter. Let's see what emerges. |
| `the-architect` | Cassian | Build the investment. Earn the devastation. Let the moments breathe. |
| `the-oracle` | Vesper | Knowledge is currency. Revelation is art. Timing is everything. |
| `the-romantic` | Rosalind | Love is built in quiet moments, not grand gestures. |
| `the-thrill-seeker` | Magnus | Fortune favors the bold. The stakes are always rising. |
| `the-shadow` | Morrigan | The oldest stories are the ones that make you check over your shoulder. |
| `the-jester` | Felix | Life's a stage, and we're all ridiculous. Might as well laugh. |
| `the-enigma` | Cassandra | The truth hides in plain sight. Question everything. |
| `the-chronicler` | Aldric | History breathes. Legends walk. Your story joins the eternal chronicle. |
| `the-balanced` | Sage | The story speaks. I listen. Together we find the way. |

The milestone demo, with the live runs: [`docs/M4-DEMO.md`](M4-DEMO.md).

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

## Active probes

`rp-core probe` asks a server what it has. With `--active` it also tries one model with a few tiny
calls, and tells you what the model really does:

```bash
rp-core probe "ollama:magmell-16k:latest" --active
```

```
ollama  http://127.0.0.1:11434  server: ollama
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
  …
```

This model's Ollama template has no tools, so Ollama refuses the `tools` field and the model gets
the `prompted` transport. Ollama is asked for usage with `stream_options` from the start, so there
is no separate usage probe and no usage fact; the first call took 87 s because Ollama was loading
the model. A model that calls the tool shows `tools ok native call …` and a `tools_result` line for
the round trip.

- **What it tries.** A one-word reply (does streaming work, how does token usage arrive), a question
  with one tool offered (does the model call it, write the call as text, or does the server refuse
  tools: `native`, `prompted` or a hint), and a reply under a JSON schema (does the server enforce
  it).
- **What it costs.** At most 6 calls with a fixed short prompt. A ping may write 96 tokens; the
  tool call may write 1024 and the tool result and JSON replies 512, so that a model that thinks
  before it answers has room to (never more than the model's own output limit). Only a thinking
  model uses that room. A run writes at most about 3 300 tokens: a fraction of a cent for most
  models, a few cents up to about 25 cents for a thinking model on a premium API. It is not free,
  so `--active` takes one `connection:model`, never a whole server.
- **Keeping the result.** Without `--write` nothing is stored: the report ends with the lines to
  paste into `config.toml` if you want them. With `--write` the facts go to
  `~/.rp-core/caps-cache.json` next to the catalog, and new sessions and chats use them. A later
  plain `rp-core probe --write` keeps them. `[caps."conn:model"]` in `config.toml` always wins.
- **Each line says `ok`, `not ok` or `inconclusive`.** `not ok` is an answer: the server refused,
  the model wrote the call as text, or it ignored the schema. `inconclusive` means the probe learned
  nothing: a timeout, a server error, or a model that was still thinking when its reply was cut
  off. An inconclusive probe stores nothing and keeps what an earlier run stored. A server error
  (HTTP 5xx) is asked once more before it counts: llama.cpp without `--jinja` answers the tools
  field with HTTP 500 every time, an Ollama runner that crashed once does not. Ollama says "no
  tools" with HTTP 400, so a 500 from Ollama stays inconclusive even twice. A probe the run had no
  call left for (repeats count) says `not run`.
- **In the chat.** `/probe --active` probes the narrator's model; `/probe --active --write` stores
  the facts, which the chat picks up the next time you open it. Ctrl+C stops the probe, and nothing
  is stored then.
- **`--json`** adds an `active` object to each result: the calls, what each showed, and the facts.

## config.toml reference

`rp-core init` writes a commented file with every option. In short:

| Table | Holds |
|---|---|
| `[connections.<name>]` | One per server. Fields: `dialect` (`"openai-chat"`), `base_url`, `key_env`, `key_cmd`, `max_in_flight` (1–64), `local` (overrides the guess from the URL), `headers` (header name → *name of the env variable* holding its value), `extra_body` (fields added to every request; `model`, `messages`, `stream`, `tools`, `tool_choice` are protected), `exclude_body`. Names may hold letters, digits, `_` and `-`, never `:` |
| `[roles]` | Defaults for new sessions: `narrator = "conn:model"`, `narrator_fallback`, `director` (unset or `"narrator"`: the narrator's connection and model), `recorder` (the Compendium's agents; unset or `"narrator"` likewise; see [The recorder](#the-recorder-their-model)) and `recall` (M5c; it may say `"narrator"` or `"recorder"`). A session keeps its own copy; `/model` changes it there |
| `[narrator]` | `max_rounds` (rounds of lookups per answer, 1–8, default 4; see [Rounds](#rounds)) and `prefill_vs_tools` (`"prefill"` or `"tools"`: which wins when a preset prefill meets tools) |
| `[director]` | The Story Director for new sessions: `enabled` (default `false`), `profile` (`"auto"`, `"full"`, `"lite"`), `on_swipe` (`"reuse"`, `"replan"`), `instructions` (up to 2 000 characters), `style` (a personality, default `"the-balanced"`), `creativity` (`"subtle"`, `"moderate"`, `"dramatic"`), `timeout_sec` (1–3600); see [The \[director\] keys](#the-director-keys) |
| `[compendium]` | The Compendium for new sessions: `enabled` (default `true`), `profile` (`"auto"`, `"full"`, `"lite"`), `min_share` (0–1, default 0.4), `language`, `guidance`, `max_attempts` (default 3), `idle_delay_sec` (default 8) and `[compendium.books]` (`<library id> = "read"` or `"off"`); the agents' tables `[compendium.filing]` (`enabled`, `wait`, `every_n`, `allow`, `timeout_sec`) and `[compendium.historian]` (`interval`, `recap_after`, `overlap`). `[compendium.recall]` is checked and kept for M5c; see [The \[compendium\] keys](#the-compendium-keys) |
| `[caps."conn:model"]` | Your corrections to what rp-core believes about a model: `context_length`, `max_output`, `tools`, `prefill`, `mid_system`, `alternation`, `reasoning`, `samplers_accepted`, `stream_usage`, `max_in_flight`, `extra_body`, … Override only after checking (`rp-core probe` shows the current values) |
| `[prices."conn:model"]` | `in_per_m`, `out_per_m` (USD per million tokens) and `as_of` (a quoted date) for the cost in `/usage` |

Dates must be quoted strings (`as_of = "2026-10-26"`): a bare TOML date is refused. A broken file
makes the commands that read it (`new`, `chat`, `send`, `preview`, `probe`, `models`) exit with code
64 and name the file, the line and the key. `sessions`, `show` and `import` do not need it.

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
| `rp-core preview "$id" --draft "Hi"` | The request a reply to "Hi" would send; nothing is sent |

- **`--json`** prints events: `start`, then `text`… deltas (and `tool` events when the narrator looks
  something up), then `changed` and `done`, or `stopped` / `failed`. These are the events a UI will
  consume. In text mode the lookups are one line each on stderr.
- **The Director** on a session that has it on: `send` prints its line on stderr like a lookup
  (`⋯ director: planned — seeds +1 · chapter 1`, `reused`, `failed (<code>)`); with `--json` these are
  `director` events with `status` `planning`, `planned`, `reused` or `failed` (the code in `reason`).
- **The Compendium's agents** do not run in `send`, `preview` or `compact`: a one-shot command never
  starts work it cannot finish. The next `rp-core chat` or `tui` on the session files what is owed.
- **Piped input** to `chat` works as a script: each line waits for the previous answer. The
  background lane runs between the lines but does not hold the script: end it with `/memory wait`
  to have every answer filed before it exits.

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
  stream abruptly), `finish`, `tool` (a native tool call: `{"tool": {"name": "search_history",
  "args": {"query": "caravan"}}}`) and `replay`. Each process starts the script from its first line.
  The scripted model has no tools unless the file's first line gives it some, as capabilities over
  the defaults: `{"caps": {"tools": "native"}}` or `{"caps": {"tools": "prompted"}}` (a prompted
  model writes its calls as `<tool_call>…</tool_call>` text steps).

## Recording and replaying a chat

`--provider record:<file>` plays as usual, against your real connections, and appends every model
call to `<file>`: the request, the streamed answer and the server's raw response, one JSON line per
call. `--provider replay:<file>` plays those calls back without a network, a model or a bill.

```bash
printf 'Hello\nIs the lighthouse lit?\n/quit\n' | rp-core chat "$id" --provider record:calls.jsonl
```

```bash
id2=$(rp-core new --card mira.png --model ollama:magmell-16k:latest --no-chat)
```

```bash
printf 'Hello\nIs the lighthouse lit?\n/quit\n' | rp-core chat "$id2" --provider replay:calls.jsonl
```

- **Secrets.** API keys and header values become `[redacted]` before a line is written. Your story
  stays in the file, as it is in the session, so keep recordings where you keep sessions.
- **A changed request fails loudly.** On replay every request must match the recorded one exactly.
  If the preset, a lorebook, the card or a message differs, the answer fails with `replay_mismatch`
  and a short diff: the first message that differs, with the text around the first changed
  character. A piped chat then stops and exits with code 3, as `send` does, so a CI job notices;
  so does a chat that runs out of recorded calls ("the recording ran out of calls",
  `script_exhausted`; a piped `script:` chat says "the script ran out of calls").
- **Same config.toml and model.** A request is shaped for the model's capabilities. Replay takes them
  from the connection a call was recorded on, so replay with the `config.toml` and the model you
  recorded with. When it cannot, the mismatch ends with a note saying why (another model, or the
  connection missing from `config.toml`).
- **Stopped calls.** A call you stopped (or that timed out) while recording replays its text and
  then, in an interactive chat, waits for your Ctrl+C. Anywhere else (a piped chat, `send`) it fails
  at once with `replay_aborted`.
- **Randomness.** `{{random}}`, `{{roll}}`, dates and times, and lore entries with a probability below
  100 % change from run to run, so prompts that use them do not replay.
- **Order.** Each process plays the calls from the first line. To replay several answers, record
  and replay them in one process, as with the piped chat above.
- **Appending.** `record:` never truncates the file: a second run adds its calls after the first.
  Use a new file for a new recording.

## Where your data lives

Everything is under `~/.rp-core`. Change it with `--home <dir>` or `RP_CORE_HOME`; `--sandbox` uses
a temporary folder that is removed at exit.

```
~/.rp-core/
  config.toml          connections, roles, overrides, prices (no secrets)
  caps-cache.json      what `probe --write` learned (the catalog, and with --active the probe facts)
  library/characters/  imported cards in the native format
  library/presets/     imported presets
  library/lorebooks/   imported world info, lorebooks and Compendium books
  library/personas/    personas from imported RoleCall stories
  sessions/<id>.jsonl  one session = one append-only journal
  sessions/<id>.lock   held while a process has the session open
  sessions/<id>.requests/  with --keep-requests: every model request of each turn and of the agents
  exports/             RoleCall files written by /memory export --format compendium
  imports/<session>/   RoleCall's tracker, storyboard and Director files, with import --keep-raw
  logs/tui.log         what the full-screen TUI said and logged
```

A session file is plain JSONL that only ever grows. Everything in it stays recoverable: every swipe,
edit and hidden message is still there. Back it up by copying the file. With the Director on, each
answer's line also holds the Director's plan at that point (its state is at most 32 768 bytes). Your
notes, Compendium entries and edits of book entries are lines of the same journal, and so is the
agents' work: a `job` line before each call, then one `mem` line with what the pass wrote (or a
`job` line saying it failed).

A session imported from RoleCall is written in one go: its header names the RoleCall chat it came
from and the export's date (`imported`), and its first lines are the story's messages. Your own
turns follow as in any session.

### Compacting a session

While an answer streams, the journal gets checkpoints of its text, and each turn saves what it sent.
Only crash recovery reads those lines. `rp-core compact` removes them for finished turns:

```bash
rp-core compact s_0d042d8c
```

```
compacted s_0d042d8c: 89571 → 52056 bytes (36 lines removed)
```

That is a copy of the M4 live session (6 answers with the Director on). A second run says
`(nothing to remove)`.

- **What stays:** the story, its versions and the Director's plans, byte for byte. The file keeps its
  mode and its modification time. A session with nothing to remove is left alone.
- **Safe to run:** the session is opened first (an interrupted answer is recovered), and the new file
  replaces the old one in one step. It is refused (exit 5) while another process has the session open
  or wrote to it meanwhile (`session_locked`), while an answer waits for a decision (`turn_open`), and
  when recovery just set aside the text of an interrupted answer it could not save (`draft_recovered`:
  the draft is shown; run compact again).
- **`--json`** prints `{"sessionId", "before", "after", "removed"}` on stdout (sizes in bytes), plus
  `"kept"` when some lines had to stay so that the reader sees the same story.

## Troubleshooting

| You see | What it means | Do |
|---|---|---|
| `context_length_exceeded … only 2048 are available (window 4096 …)` | The card plus your message do not fit the window | Give the model a bigger window ([details](#the-context-window-the-one-thing-to-get-right)) and set `context_length`; or lower `--max-tokens`. Then `/r` |
| notice `context_truncated_by_server` | The server cut the prompt: its real window is smaller than rp-core thinks | Set `[caps."conn:model"] context_length` to the server's window |
| answers stop mid-sentence, status says `length` | The reply hit the token cap | `/c` continues; raise `--max-tokens` for new sessions |
| `no_connection` | The session's binding names a connection that is not in `config.toml` | Check the connection name, or `/model narrator <conn:model>` |
| `model_not_found` | The server has no model by the name the session is bound to (not pulled, or a typo) | `rp-core models <conn>` lists what it has; `/model narrator <conn>:<model>` in the chat switches. `[roles]` in `config.toml` only sets new sessions |
| `session_locked` | Another process has the session open | Close the other chat. A lock left by a crashed process is taken over automatically |
| `the server refused the API key` / `key_unavailable` | Wrong key, unset `key_env`, or a failing `key_cmd` | Check the variable or command; `--debug` shows the server's words, redacted |
| `/e` opens vi and keys do nothing | A terminal editor inside the chat in a terminal like Warp | Unset `$EDITOR` to edit in place, or use a graphical editor ([details](#using-an-editor)) |
| The first answer takes several seconds | The server is loading the model | Normal; later answers start fast |
| The character answers in English to a Russian message | The card and the model, not rp-core | Write the card in Russian, or say so in the first message or in `/note` |
| `⋯ director: failed (undecodable)` | The Director's plan was cut off at its reply limit or its JSON was broken, also after the correction. The answer still came, without a directive | One now and then is harmless: the next turn plans again. On every turn the model does not manage the plan's format: give the Director a larger model (`/model director <conn:model>`), or `/director off` |
| `⋯ director: failed (no_room)` and notice `director_no_room` | The Director's window cannot hold its shortened prompt and 600 tokens for a plan; nothing was sent | Give its model a bigger window and set `context_length` ([Small windows](#small-windows)); 4 096 is too small |
| `⋯ director: failed (timeout)` | The Director did not answer within `timeout_sec` (default 660 s on a local server, 180 s on a remote one) | Raise `timeout_sec` under `[director]` for new sessions; check that the model is not loading or spilling to the CPU (`ollama ps`) |
| `the Compendium is off for this session` | The session was made before M5a, or `/memory off` was used. Entries are kept but not sent | `/memory on` |
| `warning: s_…: the story does not fit its narrator …` after `rp-core import` | The imported story's preset, card and lore need more than the narrator's window leaves; every turn would be refused (before the Director's calls) | A narrator with a larger window and its `context_length` set (`/model narrator <conn:model>`), or `/preset builtin` ([details](#when-the-story-does-not-fit)) |
| `import failed: … already imported as s_…` | That RoleCall chat is a session already | `rp-core chat s_…` continues it; `--new` imports it once more; `--chat all` imports the chats not imported yet |
| A Compendium entry the message names is not in the block | Every significant word of its name must be in one message, matched by its roots; the block also has an entry limit and a budget | `/trace` names each pick and each cut; add an alias the story uses (`/memory edit`) |
| notice `library_entry_missing` | You changed a book's entry in this session, and the entry or its book is gone | Add the book back (`/lore add <id>`): the change applies again |
| `⋯ memory: filing #7 parked after 3 failed attempts` | Every attempt of that pass failed: a timeout, a server error, or an answer that held nothing the reader could use | `--debug` shows the server's words; `/memory retry #7` runs it again. `parked: it does not fit the recorder's window [no_room]`: give the recorder a bigger window or another model ([The recorder](#the-recorder-their-model)) |
| notice `memory_backlog`, or `memory_starved` | Answers come faster than the recorder files them, or turns keep taking the server away from a pass | A separate connection for the recorder (`/model recorder <conn:model>`), a second slot on the server, or a larger `every_n` under `[compendium.filing]` (new sessions). `/memory wait` lets it catch up |
| `the background lane cannot run: …` (`/memory wait`), notice `recorder_unavailable` | The recorder's connection is not in `config.toml`, so nothing runs | `/model recorder <conn:model>` with a connection you have, or add the connection |
| The historian writes English summaries of a story in another language | A small model does not follow the general language line | Set `language` under `[compendium]` for new sessions. A story in Cyrillic, Greek, CJK, Arabic, Hebrew or Thai script is named without it ([details](#the-language-they-write-in)) |
| A piped chat ends before its last answers are filed | The background lane never holds the process | End the script with `/memory wait`; otherwise the next `chat` on the session files them |
| `rp-core tui needs a terminal; use rp-core chat` (exit 64) | `tui` or `new --tui` was run with stdin or stdout not a terminal (a pipe or a script) | Run it in a terminal window, or use `rp-core chat` |
| TUI: white text on a white background, or text missing on a light theme | An early build of the TUI drew text in OpenTUI's bright white | Update rp-core. The TUI now takes every colour from the terminal's theme ([Colours](#colours)) |
| TUI: text cannot be selected, or a selection does not reach the clipboard | The mouse is on (the default), so a plain drag is the TUI's own selection, copied with OSC 52; some terminals (GNOME Terminal, other VTE ones) ignore OSC 52, and there the status row says so | Hold Shift while you drag for the terminal's own selection, or press F3 to turn the mouse off ([details](#mouse-selecting-and-copying)) |
| TUI: the wheel moves the cursor in the input instead of scrolling | The mouse is off (F3), and the terminal sends the wheel as ↑ / ↓ | Clear the input (Esc): with an empty input ↑ / ↓ scroll the chat. Or press F3 to turn the mouse on |
| TUI: hotkeys do nothing on a Russian layout | They should work: the TUI matches Ctrl+letter by the key, not the letter. It accepts the Latin key, the base key that terminals with the kitty keyboard protocol report, and, without it, the letter's place on the standard ЙЦУКЕН layout (Ctrl+К is Ctrl+R) | If one still does nothing, type its command instead (`/r`, `/c`, `/e`, `/director show`). Arrows, PgUp/PgDn and F1–F3 do not depend on the layout |
| TUI: Shift+Enter sends instead of starting a new line | The terminal does not report Shift+Enter apart from Enter | Use Alt+Enter or Ctrl+J; the left pane shows the newline key that works |

Add `--debug` to any command to see raw server errors and stack traces on stderr; secrets are
redacted.

## Command reference

| Command | What it does |
|---|---|
| `init [--json]` | Writes the starter `config.toml` unless one exists; prints its path |
| `new --card <file\|library id> [--model conn:model] [--preset <id\|file>] [--lore <id\|file>]… [--max-tokens n] [--persona <json>] [--title t] [--tui \| --no-chat] [--json] [--keep-requests] [--provider …]` | Imports the card (and the preset and lorebook files) and creates a session; opens the chat on a terminal (`--tui`: the full-screen TUI), else prints the id (`--json`: `{sessionId, title, greetings}`) |
| `chat <session> [--keep-requests] [--provider …]` | The chat on a session (lock and crash recovery first) |
| `tui <session> [--keep-requests] [--provider …]` | The same chat full-screen: models, chat and agents side by side ([details](#the-full-screen-tui)). Needs a terminal on stdin and stdout, else exit 64 |
| `import <file> [--as name] [--json]` | Imports a card, a SillyTavern preset, world info, a character_book or a RoleCall Compendium export into the library; prints its id |
| `import <chat.jsonl> --card <library id> [--persona <file>] [--model conn:model] [--as title] [--dry-run] [--new] [--json]` | Imports a SillyTavern solo chat as a session, with its swipes and selected version ([details](#importing-a-sillytavern-chat)) |
| `import <story.rolecall> [--chat main\|all\|<prefix>[,…]] [--model conn:model] [--compendium on\|off] [--as title] [--dry-run] [--new] [--keep-raw] [--json]` | Imports a RoleCall story export: its library items, then one session per chosen chat (the main one by default); prints a line per item and session, the warnings and the hints ([details](#continuing-a-rolecall-story)) |
| `send <session> [text] [--kind reply\|swipe\|continue] [--guidance t] [--json] [--provider …]` | One turn. `reply` needs text (`-` reads stdin); `swipe` and `continue` take none |
| `preview <session> [--draft t] [--turn id] [--wire] [--verdicts] [--json] [--provider …]` | The request a turn would send, never sent: the next turn's, a reply to a draft, or a past answer's |
| `probe [conn[:model]] [--active] [--write] [--json]` | The server's catalog: kind, models, windows, slots (advice only) and the caps a model gets; `--active` also tries one model with a few tiny calls ([details](#active-probes)); `--write` stores what was learned |
| `models <conn> [--json]` | The connection's model ids |
| `sessions [--json]` | Sessions, newest first |
| `show <session> [--json]` | The active path with markers `[interrupted]`, `[stopped]`, `[hidden]`, `[edited]`. Never takes the lock |
| `compact <session> [--json]` | Shrinks the session's journal: drops the checkpoint and request lines of finished turns; the story and the Director's plans stay ([details](#compacting-a-session)) |

**`--provider`** takes `script:<file>` (a scripted fake model), `record:<file>` or `replay:<file>`
([details](#recording-and-replaying-a-chat)).

**`--keep-requests`** writes every model request of each turn, and of the Compendium's agents, to
`<home>/sessions/<session>.requests/` ([details](#keeping-the-requests)).

**`RP_CORE_LANE=manual`** in the environment makes `chat` and `tui` run the Compendium's background
work only at `/memory wait` (the tests set it). The default, `auto`, runs it between turns
([details](#when-they-run)); `send`, `preview` and `compact` never run it.

**Global flags** may go anywhere on the line: `--home <dir>`, `--sandbox`, `--debug`, `--help`
(also `rp-core help <command>`) and `--version`.

**Output channels.** stdout carries only the product: the answer text, streamed and ending with a
newline. With `--json` it carries events as JSONL instead: the session's open events first
(`recovered`, `notice`), then the turn's. Everything meant for humans goes to stderr.

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | done |
| `1` | other error (unreadable card, script or recording, a refused import, a missing session for `show`, unreachable server for `probe`/`models`) |
| `2` | stopped |
| `3` | failed; also a piped `chat` under `--provider script:` or `replay:` in which an answer failed |
| `4` | conflict |
| `5` | refused before the turn opened (`send`, `chat` and `preview` on a missing session: `session_not_found`), or a preview that cannot be built (`--turn` naming no message: `not_found`), or a `compact` that cannot run (`session_locked`, `turn_open`, `draft_recovered`, `session_not_found`); stderr ends with `{"type":"refusal","code":…,"message":…}` |
| `64` | usage or `config.toml` error |
| `130`, `143` | SIGINT, SIGTERM |
| `129`, `131`, … | `tui` only: SIGHUP (the terminal closed), SIGQUIT and the other exit signals, 128 + the signal's number |

## Development

**Checks:**

| Command | What it runs |
|---|---|
| `bun test` | The full suite: 5717 tests in 306 files (5713 pass); the 3 live tests below are skipped without `RP_CORE_LIVE=1`, and the real-export check without `RP_CORE_RC_EXPORT`. Three timing tests can fail on a busy machine; run alone, they pass |
| `bun test test/tui` | The full-screen TUI (279 tests in 17 files, about 12 seconds) on a headless OpenTUI renderer with a scripted model: the layout at several widths, typing and streaming, Ctrl+C, every slash command, hotkeys (also on a Russian layout), the mouse and copying, colours, signals and the lock, and the Compendium agents' blocks. The frame-time checks run only with `RP_CORE_PERF=1` |
| `bun test test/demo-m4` | The M4 demos on a scripted model (5 tests, a few seconds): 30 turns with chapters, arcs, seeds and hidden arcs; swipe reuse, `/regen` and rollback; a broken plan on a small window; 300 verbose Russian turns under the state cap. They print what they did ([`docs/M4-DEMO.md`](M4-DEMO.md)) |
| `bun test test/demo-m5a` | The M5a demo on a scripted model (9 tests, about a second): the real CLI imports a RoleCall Compendium, writes an entry in an editor, sends its brief in the block, edits a book entry as an overlay, swipes, rewinds and forks, exports and imports again, and keeps the Director's request with `[COMPENDIUM CONTEXT]`. It prints the transcript ([`docs/M5A-DEMO.md`](M5A-DEMO.md)) |
| `bun test test/demo-m5b` | The M5b demo on a scripted model (16 tests in 3 files, about 7 seconds): the real CLI, with the background lane in auto mode, files answers once they are accepted (also from fenced or loosely shaped JSON), takes a swipe's entries off the path and brings them back, files an edited answer again, undoes and refiles a pass, runs the historian twice, shows the `{{recap}}` slot once trimming starts and keeps it while the cut holds, and after a `kill -9` during filing reopens with exactly one record per pass. It prints the transcript ([`docs/M5B-DEMO.md`](M5B-DEMO.md)) |
| `bun test test/{sched,lane,filing,historian,recap,fold,language,repl}-m5b` | M5b's own tests besides the demo (447 tests in 38 files, a few seconds), on scripted models and fake clocks: the scheduler (37) and the background lane (70: preemption without an attempt, the idle wait, retries, parking, recovery after a crash), the filing prompts against Bunraku's text, reading and staging (85), the historian (100), the `{{recap}}` slot (66), the fold with the agents' rows (38), the language names (3) and the REPL's commands and lines (48). 64 more sit beside older tests: `test/memory/fold-m5b*.test.ts`, `test/structured/{review-m5b,ruling-k}.test.ts`, `test/session/fork-recap.test.ts`, `test/cli/lane-m5b.test.ts` and `test/tui/lane-*.test.ts` |
| `bun test test/rcimport` | The RoleCall story import (135 tests in 5 files, a few seconds) on a synthetic export built in memory by `test/rcimport/kit.ts` (every name and line in it invented): the ZIP reader on good and hostile archives, the converters, RoleCall's reasoning splitter (also in linear time on texts that made RoleCall's own regexes quadratic), the Director's state, and the CLI end to end, 1 200 messages in about a tenth of a second. `RP_CORE_RC_EXPORT=<file> bun test test/rcimport/zip.test.ts` adds one read-only check that your own export opens and matches its manifest; nothing of it is printed or kept. `test/engine-fit` and `test/repl/preview-imported.test.ts` (8 more) cover a turn that cannot fit and `/preview n` on an imported answer |
| `RP_CORE_SKIP_SLOW=1 bun test` | Without the ~30 s fetch long-pause tests |
| `bunx tsc --noEmit -p .` | The typecheck |
| `RP_CORE_LIVE=1 bun test test/adapter/live-ollama.test.ts` | One short call to a real Ollama. Set the model with `RP_CORE_OLLAMA_MODEL` and the URL with `RP_CORE_OLLAMA_URL` |
| `RP_CORE_LIVE=1 bun test test/live/m3-ollama.test.ts` | The M3 demo question on a real Ollama with prompted or native tools (up to 3 tries of 3 calls). Set the model with `RP_CORE_OLLAMA_M3_MODEL` (default `magmell-16k:latest`), its window with `RP_CORE_OLLAMA_CTX` (default 16384), the transport with `RP_CORE_OLLAMA_TOOLS` (`prompted`, the default, or `native`), the reply cap with `RP_CORE_OLLAMA_MAX_TOKENS` (default 300; a thinking model's thinking counts against it) and the URL with `RP_CORE_OLLAMA_URL`. A thinking model with native tools: `RP_CORE_LIVE=1 RP_CORE_OLLAMA_M3_MODEL=gemma4:26b RP_CORE_OLLAMA_CTX=4096 RP_CORE_OLLAMA_TOOLS=native RP_CORE_OLLAMA_MAX_TOKENS=1024 bun test test/live/m3-ollama.test.ts` |
| `RP_CORE_LIVE=1 RP_CORE_CLOUD_URL=… bun test test/live/m3-cloud.test.ts` | The same M3 demo on a hosted API (OpenRouter, DeepSeek, …). It costs money: at most 9 answered calls, each prompt under the window minus the reply reserve (12 288 tokens with the defaults); a request refused with 429/5xx is retried once. It reads the server's model list first (free), as `probe --write` does, so a refused key stops it before any paid call. Set the base URL with `RP_CORE_CLOUD_URL` (as `base_url` in `config.toml`; the test is skipped without it), the model id with `RP_CORE_CLOUD_MODEL`, and the *name* of the variable that holds the key with `RP_CORE_CLOUD_KEY_ENV` (never the key itself). Optional: `RP_CORE_CLOUD_CTX` (default 16384, smaller than the chat, so the history is trimmed and the history tools are offered), `RP_CORE_CLOUD_TOOLS` (`native`, the default, or `prompted`), `RP_CORE_CLOUD_MAX_TOKENS` (default 4096; a thinking model's thinking counts), `RP_CORE_CLOUD_TIMEOUT_MS` (default 30 minutes). The logged transcript has the answers, the lookups and the usage (with the cost, when the API reports it); see [`docs/M3-DEMO.md`](M3-DEMO.md#on-a-hosted-model) |
| `bun tools/fixtures/seed-innkeeper.ts [--home <dir>] [--model conn:model] [--max-tokens n] [--max-rounds n] [--compendium off\|on]` | Puts the M3 demo chat (199 messages, no model called) into a home as a new session, to play the demo by hand in `rp-core chat`; the connection must be in that home's `config.toml` ([`docs/M3-DEMO.md`](M3-DEMO.md#how-to-rerun)). The session's Compendium is off unless `--compendium on`, so the chat does not open with 98 answers to file; `/memory on` in the chat files only what comes after it |

**Temporary files.** The test run makes one temporary folder under `$TMPDIR` (else `/tmp`) and points
`RP_CORE_HOME` and `TMPDIR` inside it, so the homes, sessions and child processes of every test land
there, and no test touches `~/.rp-core`. The folder is removed when the run ends. If `/tmp` is a small
RAM disk, give the run another place: `TMPDIR=$HOME/.cache bun test` (the counts above come from such a
run).

**Code layout:**

| Folder | Holds |
|---|---|
| `src/engine` | Turns, the Director's call before the narrator, the narrator's tool loop, recovery, scheduling with priorities, the Compendium's background lane (`lane.ts`) |
| `src/session` | The journal, tree and views |
| `src/prompt` | Assembly, macros, shaping, budget |
| `src/providers` | Transport, the openai-chat adapter, capability data, the scripted, recording and replay providers |
| `src/formats` | Cards, presets, world info, RoleCall Compendium files, RoleCall story exports (with a small ZIP reader), library |
| `src/lore` | Lorebook activation: keys, timers, recursion, groups, budget |
| `src/tools` | The narrator's tools, their arguments, prompted calls and leak recovery |
| `src/text` | Word folding and light stemming for search and note keys |
| `src/agents` | The Story Director (`agents/director`), the agents' structured calls (`agents/structured.ts`), and the Compendium (`agents/compendium`: the fold of its journal lines, merge, render, tree, the selector and the block, the Director's world snapshot, export, the filing agent, the historian and the `{{recap}}` slot) |
| `src/config` | Config and keys |
| `src/cli` | Commands and the chat; the full-screen TUI in `src/cli/tui` |

The design and its decisions (D-1…D-195; the M4 ones are D-98…D-124, the TUI's D-125…D-139, M5a's
D-140…D-169, M5b's D-170…D-184, the RoleCall story import's D-185…D-195) are in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md). The
milestone demos with transcripts and timings are [`docs/M1A-DEMO.md`](M1A-DEMO.md),
[`docs/M1B-DEMO.md`](M1B-DEMO.md), [`docs/M2-DEMO.md`](M2-DEMO.md),
[`docs/M3-DEMO.md`](M3-DEMO.md), [`docs/M4-DEMO.md`](M4-DEMO.md),
[`docs/M5A-DEMO.md`](M5A-DEMO.md) and [`docs/M5B-DEMO.md`](M5B-DEMO.md). How rp-core differs
from RoleCall and SillyTavern on purpose: [`docs/PARITY-RC.md`](PARITY-RC.md),
[`docs/COMPENDIUM-DEVIATIONS.md`](COMPENDIUM-DEVIATIONS.md) (the Compendium, for Chi's review) and
[`test/golden/st/README.md`](../test/golden/st/README.md).

**Ported code.** Code taken from RoleCall and Bunraku keeps its copyright headers and is listed in
[`PROVENANCE.md`](../PROVENANCE.md).

**Contributing.** Sign off every commit (`git commit -s`, Developer Certificate of Origin). Before
the first outside contribution, the RoleCall team signs `docs/TEAM-LICENSING.md` (ARCHITECTURE.md
§2, D-34).

## Licence

AGPL-3.0-or-later. See [`LICENSE`](../LICENSE).
