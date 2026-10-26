# M2 provenance — prompt agent

| Core file | Source | Commit | Verdict | What changed |
|---|---|---|---|---|
| `src/prompt/assemble/lore.ts` | SillyBunny:public/scripts/world-info.js (checkWorldInfo prompt building ~5692–5785, normalizeWorldInfoKey use ~459), public/scripts/openai.js (`formatWorldInfo`), public/script.js (EM entries through `parseMesExamples`, outlet extension prompts, `getMaxPromptTokens` as the WI budget base), public/scripts/authors-note.js (`DEFAULT_DEPTH` 4, `getDefaultRole` system, interval 1) — SillyTavern behaviour | 3021edcae | reference | Facts only, fresh code: wi_format on before/after only; outlets unwrapped; EM entries as example dialogue with `<START>` implied and the before side in descending order; AN top/bottom wrap `${top}\n${note}\n${bottom}` minus edge newlines, at ST's default note place when no note is set; macros in keys (identity only here, ST runs full substituteParams). Not mirrored: ST merging same-depth WI into one message (D-47), the AN interval, ST's trim of extension prompts for a note without AN lore. |
| `src/prompt/budget.ts` (`loreBudget`) | SillyBunny:public/scripts/world-info.js checkWorldInfo (`Math.round(world_info_budget * maxContext / 100) \|\| 1`), public/script.js (`getMaxPromptTokens`) — SillyTavern behaviour | 3021edcae | reference | Formula only; `world_info_budget_cap` not ported (no setting). |
| `src/prompt/assemble/slots.ts` (`renderSlot`, `fillSlots` example seams) | SillyBunny:public/scripts/openai.js `formatWorldInfo` — SillyTavern behaviour | 3021edcae | reference | Blank-format rule and before/after-only scope; the newline seam around example slots is the core's (ST builds example messages instead). |

Fresh, no rows: `src/prompt/tokens.ts` O200K_COUNTER (gpt-tokenizer used as a dependency, MIT;
lazy require and memo are the core's), `src/prompt/assemble.ts` M2 wiring, tests in
`test/prompt-m2/*` (scenarios written against the ST facts above, no code copied).
