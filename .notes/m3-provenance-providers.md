# M3 provenance — providers agent

| rp-core file | Source | Authors | Notes |
|---|---|---|---|
| src/providers/probe-active.ts | Fresh | the rp-core authors | Design from the lead's research note (m3-probe-deepseek.md §1). The probe texts (PROBE_TOOL, prompts, json schema) are new. RoleCall `apps/rc/src/lib/providers/tool-call-test.ts` @ fb8dc623e (Coneja-Chibi, 264/264 lines by blame; its last change c92479ec2 is after the 660a7d67a import, so the attribution is genuinely Chi's, not the import caveat) is the named anti-example only (forced tool_choice, stream:false, one round): nothing taken. |
| src/providers/openai-chat.ts (M3: replay event, echo placeholder, thinking-off guard) | Changes to the existing Bunraku port (header unchanged: Bunraku openai-compatible-*.ts @ 702d8120, Coneja-Chibi) | the rp-core authors | The one-space reasoning_content placeholder is an idea from upstream SillyTavern (Cohee, 9aff57c9c, "Add dummy reasoning_content for deepseek-reasoner tool calls #4857", seen in SillyBunny 3021edcae `src/endpoints/backends/chat-completions.js:1182,1221-1229`); no code taken; ST sends '' where rp-core sends ' ' (decisions C3). |
| src/providers/scripted.ts (argsText, replay step, parseScriptFile, scriptCapsWith) | Fresh | the rp-core authors | The caps first line follows the M3 test plan proposal. |
| src/providers/record.ts (replay event, exported passThrough) | Fresh | the rp-core authors | |
| src/providers/probe.ts (cache split) | Fresh (the catalog half keeps its M1b port header: Bunraku models.ts, RoleCall fetcher.ts) | the rp-core authors | |
| src/providers/caps.ts (LOCAL_SERVER_KINDS, checkCapsRows rule), caps-data/hosts.json | Fresh / data | the rp-core authors | §7.2: a local server's json_schema needs a probe or the user. |
| src/config/config.ts, src/cli/catalog.ts, src/cli/runtime.ts, src/testing/index.ts | Fresh | the rp-core authors | |
| test/adapter-m3/fixtures/gemini-tool-extra.sse | Hand-written | the rp-core authors | Shape after Gemini's OpenAI-compatible `extra_content.google.thought_signature` (as in the M1b parser test). |
| test/adapter-m3/*, test/probe-m3/* | Fresh | the rp-core authors | Mock behaviours follow the research note's server table (bg facts marked unverified there). |
