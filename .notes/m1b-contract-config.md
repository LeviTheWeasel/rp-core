# Contract notes — config agent (M1b)

Owned: `src/config/config.ts`, `src/config/secrets.ts`, `test/config/`. No fixed signature changed.

## Additive changes (my files)

- `ConnectionConfig.cacheTtl?: '5m' | '1h'` — the §13 example has `cache_ttl = "1h"` on the anthropic
  connection; accepted (anthropic only) and kept for M7 instead of being refused or dropped.
- `SecretResolver.remember?(secret)` (optional) — buildConnections feeds header values read from env
  (D-53 headers may carry credentials) so `scrub(text, secrets.known())` covers them too.
- New exports: `buildConnectionsWith(cfg, deps, impl: ConnectionBuilders)` + `ConnectionBuilders`
  (buildConnections with originOf / isLocalOrigin / resolveCaps / createProvider injected; tests use it);
  secrets: `RunResult` (adds optional `overflow`), `SecretRunner`, `KEY_CMD_TIMEOUT_MS`, `spawnRunner`.

## Behaviour the CLI / engine agents should know

- `buildConnections` can throw `ConfigError` (a `headers` env variable unset or empty), not only
  `loadConfig` / `parseConfig`. Path `connections.<id>.headers.<Name>`; the message names the variable.
- TOML syntax errors: `ConfigError.path` is `line N` (not a key path); message `line N: ...`.
- Bindings in `[roles]` and the table names of `[caps."c:m"]` / `[prices."c:m"]` must name a connection
  declared in `[connections]` (typos fail at load, not mid-turn).
- `capsCache` rows go to `resolveCaps` as `probe` (§8.2 source 4: the `rp-core probe` cache); the row's
  `server` (else any row of the same connection) as `server`; `catalog` is not passed. `capsFor` is
  memoised per model for the life of the Connection.
- `resolveKey()` is lazy; failures are NOT memoised (the user may export the variable / unlock the
  keyring and retry), concurrent calls share one child process.
- `[compendium]` is kept as written, i.e. snake_case (`idle_delay_sec`, `recall.grace_sec`, ...):
  M5 must map it onto the camelCase `CompendiumConfig` of §7.4.9 (or change `parseCompendium`).
- anthropic / gemini connections without `base_url` default to `https://api.anthropic.com` /
  `https://generativelanguage.googleapis.com` (so the §13 example parses); openai-chat requires it.
- `[director]` also takes `timeout_sec` (1–3600) → `director.timeoutSec`, a SessionConfig field.
- Refused at parse rather than silently ignored later by `applyOverrides`: protected headers
  (`PROTECTED_HEADERS` from wire.ts) in `headers`, protected body keys in `extra_body` /
  `exclude_body` (connection and caps). `key_env` together with `key_cmd`; `api_version` / `cache_ttl`
  on a non-anthropic connection.
- Because wire.ts protects `api-key` / `x-goog-api-key`, Azure-style `api-key` header auth cannot be
  configured in M1b (fine for now; note for whoever adds Azure).

## Bun.TOML.parse 1.3.14 (checked by hand)

- A date/time literal as a plain value throws "Expected key but found -" (D-73), but inside an inline
  table or array it is silently mangled: `{ d = 2026-01-01 }` → `{ d: 2026, "01": 1 }`,
  `[2026-01-01]` → `[2026, 1, 1]`. config.ts therefore refuses date/time literals with a lexical pass
  (comments removed, strings blanked) before parsing.
- `inf` / `nan` come back as the strings "inf" / "nan", `-inf` as `0` → refused by the same pass.
- A leading BOM makes it drop the first key silently → stripped before parsing.
- `"""` keeps the newline right after the opening delimiter (TOML trims it) — left as is.
- A bare key starting like a date (`2026-almanac = 1`) is a parse error; a table redefined twice is
  accepted (merged).
