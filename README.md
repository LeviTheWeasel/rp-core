# rp-core

Headless roleplay agent core in TypeScript on Bun: an append-only session tree, a turn state machine
with crash recovery, pure prompt assembly with SillyTavern semantics, and provider adapters. A REPL
and a `--stdio` JSONL protocol sit on top; other UIs (Bunraku first) embed it as a library.

Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (Russian). Licence: AGPL-3.0-or-later.
Contributions: DCO sign-off (`git commit -s`) plus the team agreement in `docs/TEAM-LICENSING.md` (D-34).

Status: milestone **M1a** — turn core on the scripted provider. The demo, run by hand, with its
transcript and the 10k-message fold timing: [`docs/M1A-DEMO.md`](docs/M1A-DEMO.md).

```bash
bun install
bun test
bun src/cli/main.ts new --card path/to/card.png
bun src/cli/main.ts send <session> "Hello" --json --provider script:path/to/script.jsonl
```

## Usage (M1a)

M1a has no network providers yet: every turn runs on a **scripted provider** given with
`--provider script:<file>`. The script is JSONL, one model call per line, each a JSON array of
steps (`{"text": …}`, `{"reasoning": …}`, `{"delay": ms}`, `{"error": {"code": …}}`, `{"cut": true}`,
`{"finish": …}`, `{"usage": {…}}`). Every `send` replays the file from its first line.

```bash
alias rp-core='bun src/cli/main.ts'
echo '[{"text":"Hello, "},{"delay":200},{"text":"traveller."}]' > hello.jsonl

rp-core import card.png                    # → library/characters/<id>.json, prints the id
id=$(rp-core new --card card.png)          # import + new session; prints s_xxxxxxxx
rp-core send "$id" "Hi there" --provider script:hello.jsonl          # streams the answer
rp-core send "$id" --kind swipe --provider script:hello.jsonl        # a sibling answer
rp-core send "$id" --kind continue --provider script:hello.jsonl     # extends the last answer
rp-core send "$id" "Hi" --json --provider script:hello.jsonl         # events, one JSON per line
rp-core show "$id"                         # the active path: role · id · swipe i/n · [markers]
rp-core sessions                           # newest first
```

| Command | What it does |
|---|---|
| `new --card <file\|library id> [--persona <json>] [--model conn:model] [--title t] [--json]` | Imports the card (PNG or JSON, CCv2/V3), creates a session with the card's greetings, prints the id (`--json`: `{sessionId, title, greetings}`) |
| `import <file> [--as name] [--json]` | Detects and imports a card into the library, prints its library id |
| `send <session> [text] [--kind reply\|swipe\|continue] [--guidance t] [--json] [--provider script:<f>]` | Runs one turn. `reply` (default) needs text (`-` reads stdin); `swipe` and `continue` take none; `--guidance` is for swipe only |
| `sessions [--json]` | Lists sessions |
| `show <session> [--json]` | Prints the active path (`--json`: the `MessageView[]` path). Never takes the lock |

Global flags, anywhere on the line: `--home <dir>` (else `$RP_CORE_HOME`, else `~/.rp-core`),
`--sandbox` (a temporary home removed at exit), `--debug` (raw failures and stack traces on stderr),
`--help`, `--version`.

**Channels.** stdout carries only the product: the answer text (streamed, ending with a newline) or,
with `--json`, events as JSONL — the session's open events first (`recovered`, `notice`), then the
turn's (`start`, `text`…, `changed`, `done`/`stopped`/`failed`). Text deltas are coalesced every
40 ms / 768 chars. Everything for humans goes to stderr.

**Exit codes** (§12.3): `0` done, `2` stopped, `3` failed, `4` conflict, `5` refused before the turn
opened (stderr then ends with `{"type":"refusal","code":…,"message":…}`), `1` other errors (an
unreadable card or script, a missing session for `show`), `64` usage errors, `130`/`143` SIGINT/SIGTERM.

**Failures and signals.** A failure after text arrived keeps the partial answer, marked
`[interrupted]` (`onError: 'keep'`). The first Ctrl+C stops the turn and commits what arrived as
`[stopped]` (exit 2); a second one quits at once. SIGTERM closes the session with the partial text
kept (exit 143). After a crash (`kill -9`), `show` hints at the unfinished turn, and the next `send`
recovers it: its first event is `recovered`, and the answer appears as `[interrupted]` with the text
that was checkpointed (at most ~1 s or 400 chars is lost).
