# M2 provenance — cli agent

No code was ported. Every file written or changed by the cli agent in M2 is fresh rp-core code
(header `SPDX-License-Identifier: AGPL-3.0-or-later` / `Copyright (C) 2026 the rp-core authors`):

| File | Kind |
|---|---|
| src/cli/refs.ts | new (preset / lorebook refs for /preset, /lore add, new --preset/--lore; book rows, entry titles) |
| src/cli/preview.ts | new (`rp-core preview`) |
| src/cli/provider.ts | rewritten (script:, record:, replay:) |
| src/cli/{args,main,commands,repl,repl-commands,repl-render,render,runtime,oneshot}.ts | changed |
| test/fixtures/cli-m2/{Lighthouse,Harbor}.json | hand-written fixtures in SillyTavern's file shapes (no ST content copied) |

Facts used (not code): SillyTavern's data folder names `OpenAI Settings` and `worlds`
(SillyBunny src/constants.js@3021edcae), quoted in README.md only.
