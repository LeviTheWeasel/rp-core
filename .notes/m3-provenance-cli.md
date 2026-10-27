# M3 provenance — cli agent

No code was ported. Every file written or changed by the cli agent in M3 is fresh rp-core code
(header `SPDX-License-Identifier: AGPL-3.0-or-later` / `Copyright (C) 2026 the rp-core authors`):

| File | Kind |
|---|---|
| src/cli/repl-commands.ts | changed (/memory list/show/add/edit/retire/restore, /search, /probe --active, LATER table, /help) |
| src/cli/repl-render.ts | changed (banner tools word, status 'tools: off (prefill)', /trace rounds and tool rows, /preview tools line, /memory list and card, /search hits, the D-55 separator after a side line) |
| src/cli/render.ts | changed (toolArgsText, toolLine; tool lines in send's text mode) |
| src/cli/repl.ts | changed (the new commands, banner caps, status trace, note titles for /trace) |
| src/cli/{chat,main,preview,provider,runtime}.ts | changed (capsOf / probe wiring, `probe --active`, a script file's caps line, bindingCaps) |
| README.md | sections "Tools and search", "Notes", "Active probes" and M3 updates |
| test/repl/m3-{commands,render,flows}.test.ts, test/cli/m3.test.ts | new |
| test/repl/kit.ts, test/repl/{repl,commands,m2-commands}.test.ts, test/cli/m1b.test.ts | changed (caps option, fake SessionHandle verbs, M3 /help and later; a tool-free M1b send) |

The tool side-line format (`⋯ search_history "караван" → 2 hits`) and the banner `(tools: prompted)`
follow ARCHITECTURE.md §12.4's own example; the /search output follows the search_history result
lines of src/tools/builtin/history.ts (the builtins agent's port of RoleCall/Bunraku, credited there).
