# rp-core

Headless roleplay agent core in TypeScript on Bun: an append-only session tree, a turn state machine
with crash recovery, pure prompt assembly with SillyTavern semantics, and provider adapters. A REPL
and a `--stdio` JSONL protocol sit on top; other UIs (Bunraku first) embed it as a library.

Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (Russian). Licence: AGPL-3.0-or-later.
Contributions: DCO sign-off (`git commit -s`) plus the team agreement in `docs/TEAM-LICENSING.md` (D-34).

Status: milestone **M1b** — local RP in the terminal: the openai-chat adapter (llama.cpp, Ollama,
LM Studio, koboldcpp, vLLM, OpenRouter, DeepSeek…), capability records and the catalog probe,
`config.toml` with keys from the environment or a key command, and the REPL. The live demo against a
local Ollama, with its transcript and timings: [`docs/M1B-DEMO.md`](docs/M1B-DEMO.md); the M1a demo
(scripted provider, crash recovery, fold timing): [`docs/M1A-DEMO.md`](docs/M1A-DEMO.md).

```bash
bun install
bun test
```

## Usage (M1b)

```bash
alias rp-core='bun src/cli/main.ts'

rp-core init                               # writes ~/.rp-core/config.toml (never overwrites); prints its path
$EDITOR ~/.rp-core/config.toml             # [connections.ollama] base_url = "http://127.0.0.1:11434", [roles] narrator
rp-core models ollama                      # the model ids the server has
rp-core probe ollama:<model> --write       # server kind, windows, slots, the caps rp-core will use; --write keeps them
rp-core new --card card.png --model ollama:<model>   # on a terminal the chat opens right away
rp-core chat <session>                     # reopen it later (recovers an answer cut by a crash)
```

`config.toml` (§13) holds connections, the default roles of new sessions, `[caps."conn:model"]`
overrides (e.g. `context_length = 16384` when Ollama's `num_ctx` is not in the model's Modelfile) and
`[prices."conn:model"]` for the cost in `/usage`. It holds no secrets: a key comes from `key_env`
(an environment variable) or `key_cmd` (a command such as `secret-tool lookup …`, run without a
shell). A broken file is exit 64 with the file and the key path.

**In the chat** a line is your message; `/help` lists the commands: `/r` swipe (`/regen <hint>` a
guided one), `/[` `/]` browse swipes, `/c` continue, `/e [n]` edit (in place, or in `$EDITOR` when set), `/hide n`,
`/rewind n`, `/tails`, `/goto <id>`, `/fork [n]`, `/model [role] conn:model`, `/note`, `/think`,
`/show`, `/usage`, `/trace`, `/sessions`, `/open`, `/quit`. Ctrl+C stops an answer and keeps what
arrived (even with text typed meanwhile; that text comes back at the prompt); at the prompt it clears
the typed line, and twice at an empty prompt quits. A line typed during an answer waits for it. Piped stdin is
a script: `printf 'Hi\n/r\n/quit\n' | rp-core chat <session>` runs each line after the previous answer.

**One-shot and scripts.** `send` runs one turn on the session's bindings and prints it (`--json`:
events as JSONL). `--provider script:<file>` replaces every role with a scripted provider (JSONL, one
model call per line, each a JSON array of steps `{"text": …}`, `{"reasoning": …}`, `{"delay": ms}`,
`{"error": {"code": …}}`, `{"cut": true}`, `{"finish": …}`, `{"usage": {…}}`); `new`, `chat` and
`send` take it, so everything runs without a model too.

```bash
id=$(rp-core new --card card.png --model ollama:<model> --max-tokens 300 --no-chat)
rp-core send "$id" "Hi there"              # streams the answer
rp-core send "$id" --kind swipe            # a sibling answer
rp-core send "$id" --kind continue         # extends the last answer
rp-core send "$id" "Hi" --json             # events, one JSON per line
rp-core show "$id"                         # the active path: role · id · swipe i/n · [markers]
rp-core sessions                           # newest first
```

| Command | What it does |
|---|---|
| `init [--json]` | Writes the commented starter `config.toml` into the home unless one exists; prints its path |
| `new --card <file\|library id> [--model conn:model] [--max-tokens n] [--persona <json>] [--title t] [--no-chat] [--json] [--provider script:<f>]` | Imports the card (PNG or JSON, CCv2/V3), creates a session from `config.toml`'s defaults with the card's greetings; opens the chat on a terminal, else prints the id (`--json`: `{sessionId, title, greetings}`). A `--model` connection must exist in `config.toml` |
| `chat <session> [--provider script:<f>]` | The REPL on a session (lock + recovery first) |
| `import <file> [--as name] [--json]` | Detects and imports a card into the library, prints its library id |
| `send <session> [text] [--kind reply\|swipe\|continue] [--guidance t] [--json] [--provider script:<f>]` | Runs one turn. `reply` (default) needs text (`-` reads stdin); `swipe` and `continue` take none; `--guidance` is for swipe only |
| `probe [conn[:model]] [--write] [--json]` | Asks the server(s) for the catalog: kind, models, context windows, slots (advice only), the caps a model gets; `--write` stores it in `caps-cache.json` (never over a good row: nothing is stored when the server refused the key, or said nothing). Exit 1 when a server did not answer or refused the key |
| `models <conn> [--json]` | Lists the connection's model ids |
| `sessions [--json]` | Lists sessions |
| `show <session> [--json]` | Prints the active path (`--json`: the `MessageView[]` path). Never takes the lock |

Global flags, anywhere on the line: `--home <dir>` (else `$RP_CORE_HOME`, else `~/.rp-core`),
`--sandbox` (a temporary home removed at exit), `--debug` (raw failures and stack traces on stderr;
in `chat`, the server's own words as dim lines), `--help`, `--version`.

**Secrets and server errors** (§13). Keys never reach session files, events or output: a failed call
reads `the server refused the API key (HTTP 401)` and the like, a fixed sentence per code. The server's
own words (they may quote your prompt, or echo the key back) are printed only with `--debug`, with every
known key and header value replaced by `[redacted]`. A key with a character a header cannot carry (an
invisible U+200B pasted along with it) is refused as `key_unavailable` without showing it. A header
variable (`headers = { "X-Title" = "VAR" }`) that is not set fails only that connection's calls.

**Channels.** stdout carries only the product: the answer text (streamed, ending with a newline) or,
with `--json`, events as JSONL — the session's open events first (`recovered`, `notice`), then the
turn's (`start`, `text`…, `changed`, `done`/`stopped`/`failed`). Text deltas are coalesced every
40 ms / 768 chars. Everything for humans goes to stderr.

**Exit codes** (§12.3): `0` done, `2` stopped, `3` failed, `4` conflict, `5` refused before the turn
opened (stderr then ends with `{"type":"refusal","code":…,"message":…}`), `1` other errors (an
unreadable card or script, a missing session for `show`, an unreachable server for `probe`/`models`),
`64` usage and `config.toml` errors, `130`/`143` SIGINT/SIGTERM.

**Failures and signals.** A failure after text arrived keeps the partial answer, marked
`[interrupted]` (`onError: 'keep'`). The first Ctrl+C stops the turn and commits what arrived as
`[stopped]` (exit 2); a second one quits at once. SIGTERM closes the session with the partial text
kept (exit 143). After a crash (`kill -9`), `show` hints at the unfinished turn, and the next `send`
or `chat` recovers it: its first event is `recovered`, and the answer appears as `[interrupted]` with
the text that was checkpointed (at most ~1 s or 400 chars is lost).
