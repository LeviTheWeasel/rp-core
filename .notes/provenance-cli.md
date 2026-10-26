# Provenance — cli agent (M1a)

No code was ported. Every file under src/cli/ is fresh (§19.2 verdict "fresh" for cli/main.ts,
cli/oneshot.ts, cli/signals.ts, cli/render.ts). Kintsu K4 (Bunraku docs/KINTSU-PLAN.md) was used only
as a specification (exit codes 0/2/3/4/5, `--provider script:`, `--sandbox`), and Bunraku's
`src/cli-io.ts` only as the style of strict flag parsing (unknown flag, duplicate, missing value are
errors); its `hookExit` (exit on the first SIGINT) is the anti-pattern signals.ts avoids.

| Core file | Source | Commit | Verdict | What changed |
|---|---|---|---|---|
