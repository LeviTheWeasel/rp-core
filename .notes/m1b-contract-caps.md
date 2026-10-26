# M1b contract notes — caps agent

Signatures of caps.ts and probe.ts are unchanged. Additive changes only:

- `CapsRow` gained three optional fields: `dialect?` (row applies to one dialect), `servers?`
  (models.json: row applies only to these server kinds; `'unknown'` = none known), `note?` (prose).
- `fetchCatalog` opts gained optional `timeoutMs` (default `PROBE_TIMEOUT_MS` = 5000; tests shrink it).
- New exports: caps.ts `CapsFile, HOST_ROWS, MODEL_ROWS, SAMPLER_NAMES, defaultMaxInFlight,
  resolveCapsWith, globMatch, checkCapsRows`; probe.ts `PROBE_TIMEOUT_MS, OLLAMA_SHOW_MAX, ModelEntry,
  parseModelsPayload, modelsUrlLadder, serverRootOf, openRouterCaps, ollamaShowCaps, capsCachePath`.

## What the data means (for the openai-chat adapter)

- `samplers.accepted` lists core `Samplers` names (formats/native.ts). `samplers.wire` maps a core name
  to the wire name: llama.cpp / LM Studio `repetition_penalty → repeat_penalty`, koboldcpp
  `repetition_penalty → rep_pen`, `typical_p → typical`, Mistral API `seed → random_seed`.
- `samplers.fixed: true` = send no tuning sampler. `accepted` still names `max_tokens` / `stop` where
  the model takes them; o-series and gpt-5 have `['max_tokens']` only (no stop).
- `reasoning.offShape` is the body fragment that turns thinking off when `canDisable` and the request
  asks `reasoning: 'none'`: Qwen3 on llama.cpp/vLLM `{chat_template_kwargs:{enable_thinking:false}}`,
  DeepSeek V4 `{thinking:{type:'disabled'}}`, gpt-5.1+ `{reasoning_effort:'none'}`, Ollama thinking
  models (catalog) `{reasoning_effort:'none'}`. `control:'effort'` + `efforts` lists allowed values.
- `reasoning.output` is one value: OpenRouter is `'reasoning_details'` (the replay field; `reasoning`
  arrives too), DeepSeek `'reasoning_content'`, Ollama thinking models `'reasoning'`, OpenAI `'none'`.
  `reasoning.tags` stays set on every record (the default list, `['<think>']` for Qwen3) so the
  splitter can always run; §8.4 says the reader dedups all known fields anyway.
- `streamUsage`: `'timings'` (llama.cpp: send no stream_options, read `timings` in the last chunk),
  `'always'` (OpenRouter: usage always arrives, stream_options is a deprecated no-op),
  `'stream_options'` (send `stream_options.include_usage`: Ollama, koboldcpp, vLLM, DeepSeek, OpenAI, Groq).
- `toolChoice: []` (deepseek-reasoner, deepseek-v4 on the DeepSeek API) = never send tool_choice.
- `extraBody` is deep-merged across rows: OpenRouter `{provider:{allow_fallbacks:false}}` plus, for
  Gemini there, `safety_settings`; llama.cpp `{cache_prompt:true}`.
- `prefill:'prefix-flag'` on api.deepseek.com only works with base_url `https://api.deepseek.com/beta`
  (DeepSeek Beta). Note: `chatCompletionsUrl` keeps only `/vN` paths, so `/beta` would become
  `/beta/v1/chat/completions` — worth checking in the adapter.

## For config / CLI

- `CatalogInfo.server` may be `'unknown'`; resolveCaps treats `''`/`'unknown'` as "not reported" (the
  local port guess applies), so a cache row's server can be passed through as is.
- maxInFlight is resolved inside resolveCaps: the connection's explicit value is final; otherwise
  1 local / 4 remote, which data sources may only LOWER. fetchCatalog never returns maxInFlight.
- fetchCatalog `slots` (llama.cpp total_slots or /slots, LM Studio `parallel`) and its notes are the
  input for `notice{slots_detected}`; capacity never follows them [D-84].
- `writeCapsCache` takes rows with `as_of` from the caller (injected clock; probe.ts reads no clock).
- Ollama: the trained context (`model_info.<arch>.context_length`, e.g. 1 024 000 for Mag-Mell) is NOT
  a contextLength. The window is `/api/ps` context_length when the model is loaded, else Modelfile
  `PARAMETER num_ctx`, else unknown (a note). With an unknown window the engine's local default
  (8192) can exceed Ollama's num_ctx, and Ollama truncates the prompt silently: the CLI/REPL may want
  to surface the probe note or a `[caps."conn:model"] contextLength` hint.
