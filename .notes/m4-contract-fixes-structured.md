# M4 review fixes — unit `structured` (D-121 item 4, D-122, D-123 empty-block rule)

Files touched: `src/agents/structured.ts`; new test file `test/structured/review-fixes.test.ts` (32 tests).
Earlier structured tests (the 20 probes of rolecall.md §5.4, envelopes, fences, reasoning, length, the corrective
pass and provider-error suites) are unchanged and all keep their results (probes 5 and 6 included: still
`missing_directive`). Every new fix test fails on the pre-fix `structured.ts` (checked in a scratch tree);
4 are regression pins that pass either way.

## Changes

- **D-121 item 4 (corrective pass maxTokens).** New export `correctionMaxTokens(maxTokens, echo, correction, count?)`
  = `floor(maxTokens − (count(echo) + count(correction) + 2 × MESSAGE_OVERHEAD_TOKENS))`. The first pass sends
  `input.maxTokens` unchanged; the corrective pass AND its §6.6 retry send the lowered value. If it is below the
  new export `AGENT_OUTPUT_FLOOR = 600`, no corrective call is sent and the first pass's failure is the result
  (code, attempts and calls of the first pass only). Without `input.count`, nothing changes (same maxTokens, no
  floor).
- **D-122 (transport_unsupported).** Only `transport === 'structured' && status 400 && code 'bad_request' &&
  !res.output && !error.afterOutput`. A 400 after text or reasoning, or one the adapter marks `afterOutput`, is
  `provider_error` (so no `caps.suggest` notice). Other statuses / codes were already `provider_error`.
- **D-123 (empty plan blocks).** In `findPlan`, a named plan-family block without an error whose arguments hold
  no plan is not a good block: an empty/whitespace body (`<plan></plan>`, `<plan/>`, `<plan />`), `{}`, an envelope
  `{"name":"plan"}` or with arguments `null` / `""` / `{}`, `<tool_call>{"name":"plan"}</tool_call>`,
  `commit_planning_round()`. The search goes on to later blocks, and such blocks never count as `extra block`
  (before or after the chosen block). Arguments that are present but undecodable are NOT empty (that block stays
  the plan → `undecodable`, as before).
  When no good block exists: (1) a whole object with `directive` is still taken (D-117), looked for in the whole
  text and, when there were empty blocks, also right after the last empty block (so `<plan>{}</plan> {"directive":…}`
  works); (2) else a broken block → `broken` (a cut-off block after an empty one now says `undecodable`, before it
  said `missing_directive`); (3) else (only empty blocks) → `Found{kind:'json', json:'{}', block:true, empty:true}`
  so read() says `missing_directive` (unchanged code for probes 5/6).
  Side effect (good): a `<plan></plan>` written inside the plan object's own string no longer hides the plan.
- `Found`'s json variant got an optional `empty?: true` (additive). `readAnswer` treats an empty-only result like
  "nothing found" for the reasoning search: a REAL plan in the reasoning replaces it (`ok_reasoning`); anything else
  in the reasoning (none, broken, another empty block) leaves the empty block → `missing_directive`.

## Deviations from section H (with reasons)

- "Message overhead" read as two messages (assistant echo + user correction) × `MESSAGE_OVERHEAD_TOKENS` (4).
- The floor lives in structured.ts as `AGENT_OUTPUT_FLOOR` (types.ts has no constant for it and is lead-owned).
- The reasoning search after an empty-only visible answer (above) is my reading of "the search continues"; it only
  ever turns a failure into a success.

## Needed in files I do not own

- **`test/demo-m4/swipes.test.ts:134`** (integrate unit) fails in the full run: `expect(dirReqs.map(r => r.maxTokens))
  .toEqual([1500, 1500])` now gets `[1500, 1391]`, because call.ts passes `count` and the corrective request is lowered
  as D-121 item 4 asks. The expectation should become `[1500, 1391]` (or be computed from the echo + correction).
- Lead (optional): move the 600 floor into `DIRECTOR_CALL` (types.ts) and have call.ts and structured.ts share it;
  call.ts can import `AGENT_OUTPUT_FLOOR` from structured.ts meanwhile.
