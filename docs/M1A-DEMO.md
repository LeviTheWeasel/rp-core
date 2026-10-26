# M1a demo — transcript

Milestone M1a ("turn core on the scripted provider", ARCHITECTURE.md §15) ends with a demo a person
can run. This is that demo, run by hand on 2026-10-26 in a throwaway home, plus the two measurements
§15 and §19.2 ask for (fold time for 10k messages, `fsync` on a directory fd under Bun).

Environment: Bun 1.3.14, Linux 7.0.0-38-generic (x86_64), home on tmpfs; the `fsync` check was
repeated on ext4. No network: every turn runs on `--provider script:<file>`.

## What the demo shows

| §15 demo point | Where in the transcript | Result |
|---|---|---|
| `rp-core new --card <png>` | §1 | Seraphina.png (a PNG with both `ccv3` and `chara` chunks; `ccv3` wins) imported with its embedded book, session created with its greeting; the two import warnings go to stderr |
| `rp-core send <id> "…" --json --provider script:…` prints the turn's events | §2 | `start` → `text`… (offsets 0, 10, 25) → `changed` → `done` with the committed MessageView; exit 0 |
| `--kind swipe` gives a sibling | §3 | new answer `c3ec9e90` has the same parent `181d9a2c` as the old one; `swipe 2/2` |
| `--kind continue` appends | §4 | one `edit` (`changed.change = "edit"`), same message id, text = old text + addition |
| `kill -9` mid slow answer → next open reports `recovered`, answer shown `[interrupted]` with the partial text | §5 | killed after 3 `chk` lines; `show` (no lock) hints at the unfinished turn; the next `send` emits `recovered{outcome: interrupted}` first; the answer `7cae33f1` is on the path as `[interrupted]` with the 74 checkpointed chars, its gen names the model (from `prep`) and its trace is `partial` |
| a recovered swipe is a sibling, not a child | §6 | recovered `f1758bdb` has parent `8614dc50`, the same as the answer it replaced (`f530dfc4`, `swipe 2/2`); `f530dfc4` has no children |
| locks of dead processes | §5, §6, end | the `.lock` left by each SIGKILLed process is detected as stale (dead pid on this host) and replaced by the next open; nothing is left behind at the end |

Loss on a crash is bounded by the checkpoint cadence (1 s or 400 chars, §6.2 step 8): in §5 the
killed process had printed 74 chars and all 74 were recovered; in §6 it had printed 78 and 74 were
recovered (the last word arrived after the last `chk`). CI runs the same scenarios as processes:
`test/cli/send.test.ts` (events, swipe, continue, exit codes) and `test/cli/crash.test.ts` (`kill -9`
during a reply and during a swipe; SIGINT → stopped; SIGTERM → partial kept); recovery of a crashed
continue is covered in-process by `test/engine/recover.test.ts`.

## Measurements

**Fold of 10k messages.** A journal of 10 501 messages (10 001 on the active path, every tenth answer
with a swipe sibling and a vars diff, ~300-char answers, 3.5 MiB), written through the real log; three
runs, wall time on this machine:

| step | time |
|---|---|
| `openSessionLog` (read, split by LF, parse + guard every line, build the index) | 28–33 ms |
| `foldView` cold (first call) | 20–23 ms |
| `foldView` warm, median of 9 (min) | 10.3–11.2 ms (7.7–8.6 ms) |
| `Engine.open` + `engine.session(id)` + `view()` (lock, recovery scan, fold) | 51–55 ms |
| `rp-core show <id> --json` as a process (Bun start-up included) | 105–106 ms |

The unit benchmark in `test/session/fold.test.ts` (10 001 messages, short texts) prints the same
order: foldView median 9–10 ms, `openSessionLog` of 10 201 entries 36–38 ms. Its assertion is a loose
500 ms ceiling, so CI catches a regression by an order of magnitude, not jitter.

**`fsync` on a directory fd under Bun.** Works. `openSync(dir, 'r')` + `fsyncSync(fd)` succeeds on
Bun 1.3.14 / Linux 7.0 on both tmpfs and ext4; `strace -e trace=openat,fsync,fdatasync` shows the
real syscalls (`openat(…, O_RDONLY) = 11`, `fsync(11) = 0`), and `fdatasyncSync` on a file issues
`fdatasync(…) = 0`. `session/log.ts` `fsyncDir` returns `true`. It still swallows errors by design
(a filesystem that refuses a directory fsync must not fail a create), and is called after creating
a session and after a fork, both through `publishNewJournal` (the whole first state, header plus
greetings and head, goes to a temp file, is fsynced and hard-linked into place); the library writer
(`formats/library.ts`) has its own variant that rethrows unexpected errors.

## Re-run after the review fixes (2026-10-26)

The script below was run again, unchanged, after the M1a review fixes. The transcript is the same
as the one recorded here except for ids, timestamps, pids, `ms` values and how many text deltas
the killed swipe process printed before its SIGKILL (16 this time, 17 below): every step, event
sequence, exit code, version number and recovery outcome matched. Two crash checks from the review
were repeated by hand as well:

- **Creation under fault injection** (`strace -e inject=fsync:signal=SIGKILL:when=N` on `rp-core
  new --card v3-full.json`, a 3-greeting card): a kill before the link leaves no session at all
  (only a hidden `.s_….new.tmp` file, which nothing lists); any later kill leaves the complete
  session, all three greetings with the head on greeting 1/3. Before the fix a kill could leave a
  listed session without greetings, or with the head on the last written one.
- **A stolen lock** (a `send` suspended with SIGSTOP for 41 s, another `send` meanwhile, then
  SIGCONT): the resumed process now ends with `failed{category: conflict, code: session_locked}`
  and exit 3, handing its whole answer back as the draft, and writes nothing more; the journal reads
  back clean (no skipped lines). Before the fix it printed `done`, exited 0, and its lines were
  dropped on every later open as `seq … does not follow …`.

## The script

Self-contained (it writes its scripted-provider files), needs `bun` and `jq`:
`bash demo.sh [workdir]`. The `rp-core` in the transcript is `bun src/cli/main.ts`; the home comes
from `RP_CORE_HOME`.

```bash
#!/usr/bin/env bash
# M1a demo (ARCHITECTURE.md §15), run by hand in a throwaway home. Prints a transcript of every
# command and its output (stderr merged). Needs bun and jq. Usage: bash demo.sh [workdir]
set -u
ROOT=${ROOT:-$HOME/Documents/AI/rp-core}
WORK=${1:-$(mktemp -d)}
mkdir -p "$WORK" && cd "$WORK"
export RP_CORE_HOME="$PWD/home"
rm -rf home slow-*.out
cp "$ROOT/test/fixtures/cards/Seraphina.png" .
RP=(bun "$ROOT/src/cli/main.ts")

# Scripted provider files: one model call per line, a JSON array of steps.
cat > reply.jsonl <<'EOF'
[{"text":"Seraphina "},{"delay":60},{"text":"smiles softly. "},{"delay":60},{"text":"\"You're safe here, traveller.\""}]
EOF
cat > swipe.jsonl <<'EOF'
[{"text":"Seraphina "},{"delay":60},{"text":"tilts her head. "},{"delay":60},{"text":"\"Rest now; the forest keeps watch.\""}]
EOF
cat > continue.jsonl <<'EOF'
[{"text":" She sets a cup of "},{"delay":60},{"text":"warm tea beside you."}]
EOF
# 36 words, 200 ms apart: a ~7 s answer.
words="The glade grows quiet as Seraphina begins her tale of the old forest , of the spirits that sleep beneath its roots and the long night when the shadows first came down from the northern hills"
printf '%s\n' $words | jq -R '{text: (. + " ")}, {delay: 200}' | jq -cs . > slow.jsonl

# Print the command, run it, print the exit code.
run() { echo "\$ rp-core $*"; "${RP[@]}" "$@" 2>&1; echo "[exit $?]"; echo; }
# The active path, one line per message (the greeting's full text is long).
path() {
  echo "\$ rp-core show $1 --json | jq …   # role, id, parent, swipe i/n, [finish], text"
  "${RP[@]}" show "$1" --json | jq -r '.[] | "\(.role[0:4]) \(.id) parent=\(.parent // "-") swipe \(.swipe.index+1)/\(.swipe.count) \(if .gen.finish and .gen.finish != "end" then "[" + .gen.finish + "] " else "" end)\(if .gen.kind == "greeting" then "(greeting) " else "" end)| \([.blocks[] | select(.k=="text") | .text] | join("") | gsub("\n"; " ") | .[0:70])"'
  echo
}
chk_count() { grep -c '"t":"chk"' "home/sessions/$1.jsonl" || true; }
# A slow scripted send in the background; once 3 chk lines are on disk (~3 s at the default 1 s
# cadence) it is killed with SIGKILL: the process dies mid-answer, lock and open turn stay behind.
crash() {
  local id=$1 out=$2; shift 2
  local before; before=$(chk_count "$id")
  echo "\$ rp-core send $id $* --json --provider script:slow.jsonl > $out &"
  "${RP[@]}" send "$id" "$@" --json --provider script:slow.jsonl > "$out" 2>&1 &
  local pid=$!
  until [ "$(chk_count "$id")" -ge $((before + 3)) ]; do sleep 0.05; done
  echo "\$ kill -9 $pid    # after $(( $(chk_count "$id") - before )) chk lines"
  kill -9 "$pid"
  wait "$pid" 2>/dev/null
  echo "[exit $? = 128+SIGKILL]"
  echo "\$ cat $out    # what the killed process had printed"
  cat "$out"
  echo
  echo "\$ ls home/sessions"
  ls home/sessions
  echo
}

echo "## 1. new --card"
echo "\$ rp-core new --card Seraphina.png"
id=$("${RP[@]}" new --card Seraphina.png 2>new.err); code=$?
echo "$id"; cat new.err; echo "[exit $code]"; echo

echo "## 2. reply, events as JSONL"
run send "$id" "Where am I?" --json --provider script:reply.jsonl
path "$id"

echo "## 3. swipe: a sibling of the answer"
run send "$id" --kind swipe --json --provider script:swipe.jsonl
path "$id"

echo "## 4. continue: appends to the answer"
run send "$id" --kind continue --json --provider script:continue.jsonl
path "$id"

echo "## 5. kill -9 in the middle of a slow reply"
crash "$id" slow-reply.out "Tell me about the forest."
echo "\$ rp-core show $id >/dev/null   # stderr: show takes no lock and recovers nothing, it hints"
"${RP[@]}" show "$id" 2>&1 >/dev/null; echo
echo "# the next send opens the session (lock + recovery): its first event is 'recovered'"
run send "$id" "Please, go on." --json --provider script:reply.jsonl
path "$id"
echo "\$ rp-core show $id | grep -A100 …   # text form, from the 2nd user message on"
"${RP[@]}" show "$id" 2>&1 | grep -B1 -A100 'Tell me about the forest'; echo
echo "# the recovered msg line in the journal: gen names the model from prep, trace is partial"
grep '"t":"msg"' "home/sessions/$id.jsonl" | jq -c 'select(.gen.finish=="interrupted") | {id, parent, turn, gen, partial: .trace.partial, text: .blocks[0].text}'
echo

echo "## 6. kill -9 in the middle of a slow swipe"
old=$("${RP[@]}" show "$id" --json | jq -r '.[-1].id')
oldparent=$("${RP[@]}" show "$id" --json | jq -r '.[-1].parent')
echo "# the answer being swiped: $old (parent $oldparent)"
crash "$id" slow-swipe.out --kind swipe
run send "$id" "Thank you." --json --provider script:reply.jsonl
path "$id"
echo "# assistant messages under $oldparent: the recovered swipe sits beside the answer it replaced"
grep '"t":"msg"' "home/sessions/$id.jsonl" | jq -c --arg old "$old" --arg p "$oldparent" \
  'select(.role=="assistant" and .parent==$p) | {id, parent, finish: .gen.finish, replaced: (.id==$old)}'
echo "# children of the replaced answer $old (the recovered swipe must not be one):"
kids=$(grep '"t":"msg"' "home/sessions/$id.jsonl" | jq -c --arg old "$old" 'select(.parent==$old) | {id, role}')
echo "${kids:-(none)}"
echo

run sessions
echo "\$ ls home/sessions   # the dead processes' locks were stale and replaced, then released"
ls home/sessions
```

## Transcript

stdout and stderr merged; stderr lines start with `rp-core:`. Long `done` lines are as printed.

```text
## 1. new --card
$ rp-core new --card Seraphina.png
s_dc733a6c
rp-core: warning: use_regex is not honoured: keys are literal unless written /re/flags (4 entries) (data.character_book.entries[*].use_regex)
rp-core: warning: linked world book "Eldoria" is not part of the card; import it separately (data.extensions.world)
rp-core: created session s_dc733a6c "Seraphina" with 1 greeting (card imported as library character seraphina)
[exit 0]

## 2. reply, events as JSONL
$ rp-core send s_dc733a6c Where am I? --json --provider script:reply.jsonl
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:25.613Z","type":"start","turnId":"t_5b8d1f8e","kind":"reply","messageId":"39843208","parentId":"181d9a2c"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:25.621Z","type":"text","turnId":"t_5b8d1f8e","delta":"Seraphina ","offset":0}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:25.682Z","type":"text","turnId":"t_5b8d1f8e","delta":"smiles softly. ","offset":10}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:25.744Z","type":"text","turnId":"t_5b8d1f8e","delta":"\"You're safe here, traveller.\"","offset":25}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:25.745Z","type":"changed","version":6,"change":"msg","id":"39843208"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:25.746Z","type":"done","turnId":"t_5b8d1f8e","message":{"id":"39843208","parent":"181d9a2c","role":"assistant","blocks":[{"k":"text","text":"Seraphina smiles softly. \"You're safe here, traveller.\""}],"hidden":false,"edited":false,"swipe":{"index":0,"count":1},"gen":{"kind":"model","connection":"script","model":"default","finish":"end","ms":132,"ttftMs":1,"transport":"none","rounds":1,"preset":{"name":"builtin","hash":"1d30d6d53d07d30e"},"route":[{"model":"script:default","status":"ok"}]}}}
[exit 0]

$ rp-core show s_dc733a6c --json | jq …   # role, id, parent, swipe i/n, [finish], text
assi 2be03c56 parent=- swipe 1/1 (greeting) | *You wake with a start, recalling the events that led you deep into th
user 181d9a2c parent=2be03c56 swipe 1/1 | Where am I?
assi 39843208 parent=181d9a2c swipe 1/1 | Seraphina smiles softly. "You're safe here, traveller."

## 3. swipe: a sibling of the answer
$ rp-core send s_dc733a6c --kind swipe --json --provider script:swipe.jsonl
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:25.851Z","type":"start","turnId":"t_1f1ff9bd","kind":"swipe","messageId":"c3ec9e90","parentId":"181d9a2c"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:25.860Z","type":"text","turnId":"t_1f1ff9bd","delta":"Seraphina ","offset":0}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:25.920Z","type":"text","turnId":"t_1f1ff9bd","delta":"tilts her head. ","offset":10}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:25.982Z","type":"text","turnId":"t_1f1ff9bd","delta":"\"Rest now; the forest keeps watch.\"","offset":26}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:25.983Z","type":"changed","version":10,"change":"msg","id":"c3ec9e90"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:25.983Z","type":"done","turnId":"t_1f1ff9bd","message":{"id":"c3ec9e90","parent":"181d9a2c","role":"assistant","blocks":[{"k":"text","text":"Seraphina tilts her head. \"Rest now; the forest keeps watch.\""}],"hidden":false,"edited":false,"swipe":{"index":1,"count":2},"gen":{"kind":"model","connection":"script","model":"default","finish":"end","ms":131,"ttftMs":1,"transport":"none","rounds":1,"preset":{"name":"builtin","hash":"1d30d6d53d07d30e"},"route":[{"model":"script:default","status":"ok"}]}}}
[exit 0]

$ rp-core show s_dc733a6c --json | jq …   # role, id, parent, swipe i/n, [finish], text
assi 2be03c56 parent=- swipe 1/1 (greeting) | *You wake with a start, recalling the events that led you deep into th
user 181d9a2c parent=2be03c56 swipe 1/1 | Where am I?
assi c3ec9e90 parent=181d9a2c swipe 2/2 | Seraphina tilts her head. "Rest now; the forest keeps watch."

## 4. continue: appends to the answer
$ rp-core send s_dc733a6c --kind continue --json --provider script:continue.jsonl
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:26.081Z","type":"start","turnId":"t_a24b1e06","kind":"continue","messageId":"c3ec9e90","parentId":"181d9a2c"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:26.089Z","type":"text","turnId":"t_a24b1e06","delta":" She sets a cup of ","offset":0}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:26.149Z","type":"text","turnId":"t_a24b1e06","delta":"warm tea beside you.","offset":19}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:26.150Z","type":"changed","version":14,"change":"edit","id":"c3ec9e90"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:26.150Z","type":"done","turnId":"t_a24b1e06","message":{"id":"c3ec9e90","parent":"181d9a2c","role":"assistant","blocks":[{"k":"text","text":"Seraphina tilts her head. \"Rest now; the forest keeps watch.\" She sets a cup of warm tea beside you."}],"hidden":false,"edited":false,"swipe":{"index":1,"count":2},"gen":{"kind":"model","connection":"script","model":"default","finish":"end","ms":70,"ttftMs":1,"transport":"none","rounds":1,"preset":{"name":"builtin","hash":"1d30d6d53d07d30e"},"route":[{"model":"script:default","status":"ok"}]}}}
[exit 0]

$ rp-core show s_dc733a6c --json | jq …   # role, id, parent, swipe i/n, [finish], text
assi 2be03c56 parent=- swipe 1/1 (greeting) | *You wake with a start, recalling the events that led you deep into th
user 181d9a2c parent=2be03c56 swipe 1/1 | Where am I?
assi c3ec9e90 parent=181d9a2c swipe 2/2 | Seraphina tilts her head. "Rest now; the forest keeps watch." She sets

## 5. kill -9 in the middle of a slow reply
$ rp-core send s_dc733a6c Tell me about the forest. --json --provider script:slow.jsonl > slow-reply.out &
$ kill -9 1835939    # after 3 chk lines
[exit 137 = 128+SIGKILL]
$ cat slow-reply.out    # what the killed process had printed
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:26.254Z","type":"start","turnId":"t_8a65cb05","kind":"reply","messageId":"7cae33f1","parentId":"e57ddb5a"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:26.261Z","type":"text","turnId":"t_8a65cb05","delta":"The ","offset":0}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:26.462Z","type":"text","turnId":"t_8a65cb05","delta":"glade ","offset":4}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:26.662Z","type":"text","turnId":"t_8a65cb05","delta":"grows ","offset":10}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:26.863Z","type":"text","turnId":"t_8a65cb05","delta":"quiet ","offset":16}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:27.063Z","type":"text","turnId":"t_8a65cb05","delta":"as ","offset":22}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:27.265Z","type":"text","turnId":"t_8a65cb05","delta":"Seraphina ","offset":25}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:27.465Z","type":"text","turnId":"t_8a65cb05","delta":"begins ","offset":35}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:27.665Z","type":"text","turnId":"t_8a65cb05","delta":"her ","offset":42}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:27.866Z","type":"text","turnId":"t_8a65cb05","delta":"tale ","offset":46}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:28.066Z","type":"text","turnId":"t_8a65cb05","delta":"of ","offset":51}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:28.266Z","type":"text","turnId":"t_8a65cb05","delta":"the ","offset":54}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:28.467Z","type":"text","turnId":"t_8a65cb05","delta":"old ","offset":58}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:28.667Z","type":"text","turnId":"t_8a65cb05","delta":"forest ","offset":62}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:28.868Z","type":"text","turnId":"t_8a65cb05","delta":", ","offset":69}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:29.068Z","type":"text","turnId":"t_8a65cb05","delta":"of ","offset":71}

$ ls home/sessions
s_dc733a6c.jsonl
s_dc733a6c.lock

$ rp-core show s_dc733a6c >/dev/null   # stderr: show takes no lock and recovers nothing, it hints
rp-core: hint: 1 interrupted turn (74 chars of partial text) not shown yet: the next `rp-core send` on this session recovers them, keeping partial text marked [interrupted]

# the next send opens the session (lock + recovery): its first event is 'recovered'
$ rp-core send s_dc733a6c Please, go on. --json --provider script:reply.jsonl
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:29.390Z","type":"recovered","turnId":"t_8a65cb05","outcome":"interrupted"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:29.392Z","type":"start","turnId":"t_f99c09bd","kind":"reply","messageId":"f530dfc4","parentId":"8614dc50"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:29.400Z","type":"text","turnId":"t_f99c09bd","delta":"Seraphina ","offset":0}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:29.460Z","type":"text","turnId":"t_f99c09bd","delta":"smiles softly. ","offset":10}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:29.522Z","type":"text","turnId":"t_f99c09bd","delta":"\"You're safe here, traveller.\"","offset":25}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:29.525Z","type":"changed","version":26,"change":"msg","id":"f530dfc4"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:29.527Z","type":"done","turnId":"t_f99c09bd","message":{"id":"f530dfc4","parent":"8614dc50","role":"assistant","blocks":[{"k":"text","text":"Seraphina smiles softly. \"You're safe here, traveller.\""}],"hidden":false,"edited":false,"swipe":{"index":0,"count":1},"gen":{"kind":"model","connection":"script","model":"default","finish":"end","ms":133,"ttftMs":1,"transport":"none","rounds":1,"preset":{"name":"builtin","hash":"1d30d6d53d07d30e"},"route":[{"model":"script:default","status":"ok"}]}}}
[exit 0]

$ rp-core show s_dc733a6c --json | jq …   # role, id, parent, swipe i/n, [finish], text
assi 2be03c56 parent=- swipe 1/1 (greeting) | *You wake with a start, recalling the events that led you deep into th
user 181d9a2c parent=2be03c56 swipe 1/1 | Where am I?
assi c3ec9e90 parent=181d9a2c swipe 2/2 | Seraphina tilts her head. "Rest now; the forest keeps watch." She sets
user e57ddb5a parent=c3ec9e90 swipe 1/1 | Tell me about the forest.
assi 7cae33f1 parent=e57ddb5a swipe 1/1 [interrupted] | The glade grows quiet as Seraphina begins her tale of the old forest ,
user 8614dc50 parent=7cae33f1 swipe 1/1 | Please, go on.
assi f530dfc4 parent=8614dc50 swipe 1/1 | Seraphina smiles softly. "You're safe here, traveller."

$ rp-core show s_dc733a6c | grep -A100 …   # text form, from the 2nd user message on
user · e57ddb5a
  Tell me about the forest.

assistant · 7cae33f1 · swipe 1/1 · [interrupted]
  The glade grows quiet as Seraphina begins her tale of the old forest , of 

user · 8614dc50
  Please, go on.

assistant · f530dfc4 · swipe 1/1
  Seraphina smiles softly. "You're safe here, traveller."

(1 other branch off this path)

# the recovered msg line in the journal: gen names the model from prep, trace is partial
{"id":"7cae33f1","parent":"e57ddb5a","turn":"t_8a65cb05","gen":{"kind":"model","finish":"interrupted","connection":"script","model":"default"},"partial":true,"text":"The glade grows quiet as Seraphina begins her tale of the old forest , of "}

## 6. kill -9 in the middle of a slow swipe
# the answer being swiped: f530dfc4 (parent 8614dc50)
$ rp-core send s_dc733a6c --kind swipe --json --provider script:slow.jsonl > slow-swipe.out &
$ kill -9 1836282    # after 3 chk lines
[exit 137 = 128+SIGKILL]
$ cat slow-swipe.out    # what the killed process had printed
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:29.805Z","type":"start","turnId":"t_95b7725a","kind":"swipe","messageId":"f1758bdb","parentId":"8614dc50"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:29.813Z","type":"text","turnId":"t_95b7725a","delta":"The ","offset":0}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:30.013Z","type":"text","turnId":"t_95b7725a","delta":"glade ","offset":4}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:30.214Z","type":"text","turnId":"t_95b7725a","delta":"grows ","offset":10}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:30.414Z","type":"text","turnId":"t_95b7725a","delta":"quiet ","offset":16}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:30.615Z","type":"text","turnId":"t_95b7725a","delta":"as ","offset":22}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:30.817Z","type":"text","turnId":"t_95b7725a","delta":"Seraphina ","offset":25}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:31.017Z","type":"text","turnId":"t_95b7725a","delta":"begins ","offset":35}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:31.217Z","type":"text","turnId":"t_95b7725a","delta":"her ","offset":42}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:31.418Z","type":"text","turnId":"t_95b7725a","delta":"tale ","offset":46}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:31.618Z","type":"text","turnId":"t_95b7725a","delta":"of ","offset":51}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:31.818Z","type":"text","turnId":"t_95b7725a","delta":"the ","offset":54}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:32.019Z","type":"text","turnId":"t_95b7725a","delta":"old ","offset":58}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:32.219Z","type":"text","turnId":"t_95b7725a","delta":"forest ","offset":62}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:32.420Z","type":"text","turnId":"t_95b7725a","delta":", ","offset":69}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:32.620Z","type":"text","turnId":"t_95b7725a","delta":"of ","offset":71}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:32.820Z","type":"text","turnId":"t_95b7725a","delta":"the ","offset":74}

$ ls home/sessions
s_dc733a6c.jsonl
s_dc733a6c.lock

$ rp-core send s_dc733a6c Thank you. --json --provider script:reply.jsonl
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:32.916Z","type":"recovered","turnId":"t_95b7725a","outcome":"interrupted"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:32.918Z","type":"start","turnId":"t_423280ba","kind":"reply","messageId":"c46845a7","parentId":"faf471c0"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:32.926Z","type":"text","turnId":"t_423280ba","delta":"Seraphina ","offset":0}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:32.988Z","type":"text","turnId":"t_423280ba","delta":"smiles softly. ","offset":10}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:33.048Z","type":"text","turnId":"t_423280ba","delta":"\"You're safe here, traveller.\"","offset":25}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:33.049Z","type":"changed","version":37,"change":"msg","id":"c46845a7"}
{"sessionId":"s_dc733a6c","ts":"2026-10-26T07:26:33.050Z","type":"done","turnId":"t_423280ba","message":{"id":"c46845a7","parent":"faf471c0","role":"assistant","blocks":[{"k":"text","text":"Seraphina smiles softly. \"You're safe here, traveller.\""}],"hidden":false,"edited":false,"swipe":{"index":0,"count":1},"gen":{"kind":"model","connection":"script","model":"default","finish":"end","ms":131,"ttftMs":1,"transport":"none","rounds":1,"preset":{"name":"builtin","hash":"1d30d6d53d07d30e"},"route":[{"model":"script:default","status":"ok"}]}}}
[exit 0]

$ rp-core show s_dc733a6c --json | jq …   # role, id, parent, swipe i/n, [finish], text
assi 2be03c56 parent=- swipe 1/1 (greeting) | *You wake with a start, recalling the events that led you deep into th
user 181d9a2c parent=2be03c56 swipe 1/1 | Where am I?
assi c3ec9e90 parent=181d9a2c swipe 2/2 | Seraphina tilts her head. "Rest now; the forest keeps watch." She sets
user e57ddb5a parent=c3ec9e90 swipe 1/1 | Tell me about the forest.
assi 7cae33f1 parent=e57ddb5a swipe 1/1 [interrupted] | The glade grows quiet as Seraphina begins her tale of the old forest ,
user 8614dc50 parent=7cae33f1 swipe 1/1 | Please, go on.
assi f1758bdb parent=8614dc50 swipe 2/2 [interrupted] | The glade grows quiet as Seraphina begins her tale of the old forest ,
user faf471c0 parent=f1758bdb swipe 1/1 | Thank you.
assi c46845a7 parent=faf471c0 swipe 1/1 | Seraphina smiles softly. "You're safe here, traveller."

# assistant messages under 8614dc50: the recovered swipe sits beside the answer it replaced
{"id":"f530dfc4","parent":"8614dc50","finish":"end","replaced":true}
{"id":"f1758bdb","parent":"8614dc50","finish":"interrupted","replaced":false}
# children of the replaced answer f530dfc4 (the recovered swipe must not be one):
(none)

$ rp-core sessions
s_dc733a6c  2026-10-26T07:26:33.048Z  Seraphina
[exit 0]

$ ls home/sessions   # the dead processes' locks were stale and replaced, then released
s_dc733a6c.jsonl
```
