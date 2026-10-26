# M2 provenance — engine

No code was ported in this step. `src/engine/request.ts` is rp-core's own M1b code moved out of
`src/engine/turn.ts` (the window/reserve/assemble/shape half; turn.ts keeps its Bunraku port header
for the parts it ported), plus new M2 code (lorebook loading, per-entry regex notices). The preview,
the seed reservation and the EMA counter filter are new. No PROVENANCE.md row is needed.
