# Provenance — storage agent (M1a)

No code was ported. All storage files are fresh code (§19.2 verdicts: `session/*` fresh).

`protocol/jsonl.ts` is marked "adapt" from `BR:src/kit/mcp/connections.ts` `readLines` in §19.2,
but nothing was copied: Bunraku's `readLines` decodes chunks with a streaming decoder and splits the
decoded string, while D-36 asks for an explicit byte-level LF splitter (and file splitting with a
torn tail and byte offsets), so the module was written from scratch. Only the idea "one decoder
per stream" is shared. No port header, no table rows.

| core file | source repo:path | commit | port/adapt | what changed |
|---|---|---|---|---|
