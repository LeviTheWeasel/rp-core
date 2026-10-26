# M1b provenance — caps agent

Rows for PROVENANCE.md "Ported files" (same columns). Commits: `702d8120` = Bunraku
`702d81201120a6b90eb29a783a77c60ffdebc374`, `fb8dc623e` = RoleCall/VAUDEVILLE
`fb8dc623e6beb24083f5105c828462e89fc66ce3`.

| Core file | Source | Commit | Verdict | What changed |
|---|---|---|---|---|
| `src/providers/probe.ts` | Bunraku:src/kit/providers/models.ts (`modelsUrlLadder`, `parseModelsPayload`, the ladder walk of `openAICompatModels`) | 702d8120 | adapt | Requests through `http.guardedFetch` (same origin, manual redirects) with a 5 s per-request timeout instead of a bare fetch; a failed rung becomes a note, only "nothing answered" throws `unreachable`; 401/403 still stops the ladder. Context sniffing drops `max_tokens` (an output limit on several catalogs) and adds vLLM `max_model_len`; entries keep `owned_by` and the raw record. `formatContext`/`compactCount` and AI SDK types not ported. Added: server detection (owned_by, /props, /api/version, /api/extra/version, LM Studio /api/v1 and /api/v0 models), per-server readers, `serverRootOf`. |
| `src/providers/probe.ts` | RoleCall:apps/rc/src/lib/models/fetcher.ts (`parseCapabilities`, lines 110-135; authors Coneja-Chibi, NemoVonNirgend) | fb8dc623e | adapt | `supported_parameters` → `Partial<ModelCaps>` (`openRouterCaps`): tools/tool_choice → native tools + auto/none, structured_outputs → json_schema (confirmedBy host), reasoning/include_reasoning → effort control, sampler names → `samplers.accepted`; plus `context_length` and `top_provider.max_completion_tokens`. Modality, moderation and the boolean-flag record not kept. |
| `test/caps/probe.test.ts` | Bunraku:src/kit/providers/models.test.ts | 702d8120 | adapt | parseModelsPayload and modelsUrlLadder cases kept (expectations on `{id, contextLength}`); `formatContext` cases dropped; added max_tokens/max_model_len, trailing-slash and serverRootOf cases. The mock-server cases are new. |
| `src/providers/caps-data/hosts.json` | Bunraku:src/kit/providers/spokes/{openrouter,nanogpt,deepseek,openai,mistral,groq}.ts (scene params), src/stage/params/dialects.ts (OPENAI_PARAMS, stop 4), src/core/tokens/cache.ts (DeepSeek 64-token cache, OpenAI 1024); RoleCall:apps/rc/src/lib/providers/adapters/openai.ts lines 170-370 (OpenRouter provider.allow_fallbacks, no volatile metadata; Gemini compat 400s, VVS-383); SillyTavern via RoleCall:apps/rc/src/lib/providers/definitions.ts (NanoGPT samplerSupport) | 702d8120 / fb8dc623e | reference | Facts only, as JSON rows with `as_of` and `src` [D-54]. Local-server rows (llama.cpp, Ollama, LM Studio, koboldcpp, vLLM) come from the servers' own docs/source (URLs in each row), re-checked 2026-10-26: llama.cpp tools/server/README.md, docs.ollama.com/api/openai-compatibility, lmstudio.ai openai-compat + REST list docs, koboldcpp.py (transform_genparams, generate, /api/extra/*), OpenRouter usage-accounting and models docs. |
| `src/providers/caps-data/models.json` | SillyTavern via RoleCall:apps/rc/src/lib/providers/adapters/reasoning-effort.ts (OPENAI_REASONING_EFFORT_MODELS, OPENAI_FIXED_REASONING_EFFORT, applyOpenAIReasoningModelShape, mapOpenAIReasoningEffort; RoleCall's own: modelRequiresClaudeDefaultSampling / AlwaysOnThinking, DeepSeek `thinking` shape VVS-254); RoleCall:apps/rc/src/lib/providers/adapters/openai.ts (reasoner/v4 tool_choice refusal, no stop on o-series/gpt-5, Claude system rule); VAUDEVILLE:packages/managed-ai/src/reasoning-facts.ts (grok-4.5 on OpenRouter, Kimi K2 thinking on NanoGPT: mandatory reasoning), packages/managed-ai/src/contracts/gemini-safety.ts (OpenRouter Gemini safety_settings vocabulary) | fb8dc623e | reference | Regexes over model ids turned into data globs with `as_of`/`src`; scoped by `servers` where the fact belongs to one route. Not ported: the regex tables themselves, RoleCall's optimistic defaults, `thinking: disabled` on Claude 5. Qwen3/Mistral/Gemma template facts from the model cards / chat templates (URLs in rows). |

Fresh code (no row): `src/providers/caps.ts` — only the ideas "no field → off" (Bunraku
openai-compatible-request.ts, spoke.ts) and "unknown → do not send, never send a disable"
(managed-ai reasoning-facts.ts); `test/caps/caps.test.ts`.

Not used (as §19.4 says): RoleCall `tool-call-test.ts` (forced tool), Bunraku `known-context.ts`,
RoleCall `models.ts` (stale context tables).

## Real Ollama check (one read-only run, 2026-10-26)

`GET http://127.0.0.1:11434/v1/models` → 200, `{"object":"list","data":[…]}` with 24 models, each
`{id, object:"model", created, owned_by}`; `owned_by` is the namespace (`library`, `bartowski`), no
context field.

`POST /api/show {"model":"hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M"}` → 200 with keys
`modelfile, parameters, template, details, model_info, capabilities, modified_at`:
- `capabilities: ["completion"]` (no tools, no thinking);
- `parameters`: two `stop` lines (`<|im_start|>`, `<|im_end|>`), **no `num_ctx`**;
- `details`: family llama, 12.2B, Q5_K_M, gguf;
- `model_info`: `general.architecture: "llama"`, `llama.context_length: 1024000` (Mistral Nemo's trained window);
- `template`: a legacy `.System`/`.Prompt` ChatML template.

Consequence built into probe.ts: the trained 1 024 000 is not reported as contextLength (Ollama runs
/v1 at its num_ctx); fetchCatalog leaves the window unset for this model and notes how to set it.
No pull/delete/create/run was made; no other endpoint of the real server was touched.
