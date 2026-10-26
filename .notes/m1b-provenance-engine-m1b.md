# M1b provenance — engine-m1b

No code was ported in this step. New files `src/engine/cost.ts` and `src/engine/ema.ts` are fresh
(rp-core authors); the existing port headers of turn.ts, recover.ts and route.ts are unchanged and
still accurate (their M1b additions are fresh code calling `tools/leaks.ts` and `prompt/tokens.ts`).
