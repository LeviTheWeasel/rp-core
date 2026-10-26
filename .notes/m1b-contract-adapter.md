# M1b contract notes — adapter (providers/openai-chat.ts)

No exported signature was changed. Additions inside the owned file: `createChatReader(req)` (the parser
plus `done`, `output`, `finished` and `replay()`; `createChatParser` returns it) and the `ChatReader`
interface. What other agents should know, and where the file reads or departs from a doc comment:

## Contract gaps (need an architect decision; nothing was changed outside my file)

1. **No replay channel in StreamEv.** §8.1 says unknown tool-call keys (`extra_content.google.
   thought_signature`) and OpenRouter `reasoning_details` are kept "в replay", and `AssistantResult.replay`
   exists, but no StreamEv carries them and `Provider.stream` only yields StreamEv. The parser keeps them
   (`createChatReader(req).replay()` → `Replay[]` of kinds `reasoning_details` and `tool_extra`, payload of
   tool_extra = `{[callId]: {unknownKeys}}`), and `buildChatRequest` renders both kinds back from
   `PromptMsg.replay` (matched on connection + model). For M3 the engine needs a way to get them from a
   stream: suggestion `{t:'replay', r: Replay}` emitted just before `finish`.
2. **OpenRouter `session_id`** (§8.4 "provider.allow_fallbacks:false и session_id") cannot be sent:
   ModelRequest has no session id (and `callKey` is per call). hosts.json sends only
   `provider.allow_fallbacks`. Needs a field (e.g. `ModelRequest.sessionId?`) or an engine-level extraBody.
3. **DeepSeek `prefix: true` needs the beta base URL.** DeepSeek's chat prefix completion is documented
   under `https://api.deepseek.com/beta`; hosts.json sets `prefill:'prefix-flag'` for api.deepseek.com
   whatever the path. If the user's base_url is `https://api.deepseek.com`, a prefilled request may be
   refused. Either the config template should use `/beta`, or the DeepSeek row should say prefill
   'none' unless the path is /beta (caps agent / config agent).
4. **Templates that open `<think>` in the prompt** (Qwen3 2507 Thinking, some R1 distills): the splitter
   supports `startInside`, but ModelCaps has no flag for it, so the first reasoning of such a model goes out
   as text until `</think>` (which is then dropped). Suggest `caps.reasoning.startsInside?: boolean`.
5. **`applyOverrides(...).ignored` is lost** inside the adapter (no notice channel from a provider). The
   config agent can compute the same list once at load (`applyOverrides({}, {}, overrides).ignored`) and
   warn there.

## Behaviour choices inside the contract

6. **Finish is held until [DONE] / EOF** (task text: "emitted at the end, after usage"). Consequence: a
   server that sends `finish_reason` and then stalls without [DONE] for longer than the engine's idle
   timeout (120 s) makes the call look like a timeout, not a finished answer. A body that *breaks* after
   the finish is handled: the adapter yields usage+finish first, then the break as an error (narrate.ts
   records it as `tailError`).
7. **Event indices:** text, reasoning and reasoning_end use `i: 0` (as the scripted provider); tool events
   use a slot number in start order (0, 1, …), independent of the server's `index` (gaps closed).
   `reasoning_end` is emitted when reasoning is followed by text or a tool call, and before the finish if
   reasoning was last.
8. **Tool call ids:** a call starts (`tool_start`) once it has a name and an id; a named call without an id
   gets one more fragment's chance, then a synthesised id `call_<callKey sanitised>_<slot>` (deterministic,
   within wire.ts SAFE_ID). Tool events go out at finish_reason time at the latest (`tool_end` for every
   started call); a truncated stream never sends `tool_end` for a half call.
9. **tool_choice 'none' on a server with `toolChoiceHonored:false`** (Ollama, and every pessimistic
   record) sends no tools at all: that is the only way to say "no calls" there. tool_choice is sent only
   when `caps.toolChoice` lists it; `parallel_tool_calls:true` only for `'send-true'` (`'param'` servers
   already default to parallel).
10. **Samplers:** `stop` and `max_tokens` are not samplers: `fixed:true` drops every sampler but keeps
    `stop` (when 'stop' is in `accepted`) and `caps.maxTokensField` (always, from `req.maxTokens`). `stop`
    = `req.stop ?? req.samplers.stop`, blanks and repeats removed, sliced to `stopMax`, renamed through
    `samplers.wire.stop` if a row ever sets it. Only `top_p: 0` is treated as "off"; a 0 penalty is sent.
11. **Reasoning control:** `'auto'`/unset sends nothing. `effort`: `reasoning_effort` only for values in
    `reasoning.efforts`; `'none'` not in the list → `offShape` when `canDisable`. `toggle`: `'none'` →
    `offShape` (or `chat_template_kwargs.enable_thinking:false`) when `canDisable`; low/medium/high →
    `chat_template_kwargs.enable_thinking:true` when offShape is absent or is that switch, nothing when
    the off switch is another field (DeepSeek V4 `thinking`, on by default). Order: body → `caps.extraBody`
    → reasoning control (deep-merged) → connection overrides.
12. **DeepSeek echo:** `reasoning_content` (or `reasoning` when `reasoning.output` is 'reasoning') on every
    assistant message that has raw reasoning blocks, only when the request carries tool traffic (native
    tools sent, or tool_call blocks in history) — "all-with-tools". Only `kind` raw/undefined reasoning is
    echoed. Filtering reasoning of other models stays the engine's job (§8.4).
13. **Errors:** everything is an error event, nothing thrown, except an abort (the signal's reason is
    thrown, also between two events of one chunk). In-stream errors: status from `status`/numeric `code`
    (OpenRouter puts the upstream status there) → the HTTP table; else code/type names; unknown →
    `overloaded` (category server); a context-length message → `context_length_exceeded`. A dated
    Retry-After is read against the response's Date header and dropped when there is none.
14. **200 application/json** bodies are accepted: `{error}` → error event; a whole completion (a server
    that ignored `stream:true`) is fed to the parser as one chunk + [DONE].
15. **Usage:** one `usage` event at the end (the last report; servers that repeat cumulative usage are
    fine). OpenAI shape + `prompt_tokens_details.cache_write_tokens` (OpenRouter) +
    `prompt_cache_hit_tokens` (DeepSeek); llama.cpp `timings` (inputTotal = prompt_n + cache_n,
    inputCacheRead = cache_n) fill what `usage` lacks. `{}` → no event.
16. **Live check (2026-10-26):** the user's Ollama `/v1/chat/completions` now reports
    `usage.prompt_tokens_details.cached_tokens` in the `choices:[]` usage chunk, so Ollama usage carries
    `inputCacheRead` (the Ollama fixture follows the real stream shape).
