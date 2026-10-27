# TUI polish 2 (Levi's look in Warp, 27.10): contract

Two complaints: "/director show does not show the hook and the directive in full" and "italic text
still shows the asterisks".

## 1. /director show prints the last directive in full (line REPL and TUI, ON PURPOSE)

Files: src/cli/repl-render.ts (renderDirector, DirectorShow), src/cli/repl.ts (director()).

- The one-line `directiveSummary` (every text field cut to 30–40 chars) is gone. The last directive
  is now printed exactly as the narrator got it: `renderDirective(record.directive)` (the
  `[DIRECTOR CONSTRAINTS - BINDING THIS TURN]` … `[/DIRECTOR CONSTRAINTS]` block of
  src/agents/director/render.ts; record.directive is the one after enrich and the persona filter),
  under a heading line, heading and every line of the block dim (blank lines bare), no indent (so a
  copy is the exact text). The rest of /director show is unchanged.
- Headings:
  - planned: `last directive (turn N, as sent):`
  - a swipe that reused a plan: `last directive (turn N, reused from <reply>, as sent):`
  - the record sent none (a failed plan): `last directive (turn M, as sent on <reply>; turn N sent none):`
    with the block of the nearest record above it on the path that planned one (new
    `DirectorShow.sentBefore`, found by repl.ts `sentBefore(tree, from)`: directorAt from each
    record's parent up);
  - no such record on the path but the state keeps one: `last directive (turn M, as the Director
    wrote it; turn N sent none):` + renderDirective of `state.lastDirective` (authored: before
    enrich and the filter);
  - nothing: `no directive yet` (as before);
  - a directive that renders '' : `<heading>: empty (the narrator got no Director block)`.
- This changes the line REPL's /director show output. Tests changed for it:
  test/repl/m4-render.test.ts (rich state now pins the whole block; failed / reused tests; the
  `directiveSummary` describe removed; new: long fields never cut, empty directive, colour) and
  test/repl/m4-flows.test.ts (the head's block in full; new: a failed turn at the head shows a2's
  sent directive, not the state's authored copy). test/cli-m4 pinned nothing of it (fixtures only).
- Not touched (another agent's files): README.md:1098 and docs/M4-DEMO.md:253/329 still show the old
  one-line `last directive (turn 4, as sent) mood "…" · goal "…"` sample output.

## 2. The TUI's chat drops the asterisks of *italic* (TUI only; createProseStyler unchanged)

File: src/cli/tui/turn-view.ts (createChatStyler, visibleText); repl-render.ts exports
OPEN_QUOTES / CLOSE_QUOTES (values unchanged) for it.

- createChatStyler is now self-contained (no longer wraps createProseStyler) and renders the REPL's
  look as markdown: `*action*` italic without its asterisks, `**bold**` as before, speech inside an
  action plain again (same SGR as the REPL: italic off before the opening quote, on after the
  closing one), and `*emphasis*` inside speech italic (the REPL keeps it plain with asterisks).
- What toggles italic (flanking, like bold): a `*` opens a span before a non-blank character unless
  a letter/digit is right before it; it closes the open span after a non-blank character unless a
  letter/digit follows it. Anything else is a LITERAL asterisk: drawn, toggling nothing (`5 * 3`,
  `5*3`, `f*ck`, `* item`, a lone `*` at the end, `*he says f*ck*` keeps the inner one). The REPL
  italicised the rest of the line after such a `*`; the chat does not.
- `***x***` = italic + bold, no asterisks; `***` / `****` / `a ** b` literal (no toggles now).
  A newline ends bold, action and emphasis; the end of speech ends its emphasis. Unclosed spans lose
  their opening `*` (as an unclosed `**` already did): streaming cannot look ahead.
- Streaming: runs are still held until the next character, so any split == the whole text; flush()
  (a side line) decides as if nothing followed (an opener is drawn as a literal `*`, a closer
  closes). seed() for a continue: held literals are not drawn again, held markers only restyle.
  `…last words` use visibleText (both kinds of markers dropped); cards, archive blocks and the
  repaint on done use proseChunks: all go through the same styler.

Tests changed on purpose (they pinned `*…*` on screen): test/tui/polish-chat.test.ts (styler +
chat describes rewritten: italic markers, literal asterisks, emphasis in speech, `***`, splits incl.
literals, held / flush / seed of `*`, last words, a continue inside an action repainting the
original card, streamed literals); stream, transcript, colors and e2e tests (expected rows / spans
without the action's asterisks). New: test/tui/polish2.test.ts (Ctrl+D in the TUI: the whole block,
a 120-char hook and the setting uncut, dim).
- Supersedes T-17's "a lone `*` still italic" (.notes/tui-decisions.md, not edited here).

## Checks
- Every new/changed test was run against a copy with the original renderDirector and the original
  createChatStyler: 38 fail there (all the changed/new ones); guards (any split, REPL unchanged,
  `**bold**`, side line) pass on both.
- `bunx tsc --noEmit -p .` clean; full suite (TMPDIR=~/.cache) 4536 pass, 3 skip, 0 fail.
