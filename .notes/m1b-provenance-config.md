# Provenance — config agent (M1b)

No code was ported. `src/config/config.ts` is fresh (§19.8 "fresh") and `src/config/secrets.ts` is
written from the reference semantics only (§19.8 "reference"); neither carries a port header.

| Core file | Source | Commit | Verdict | What changed |
|---|---|---|---|---|
| `src/config/config.ts` | Bunraku:src/kit/providers/config.ts | 702d8120 | reference | Home-override pattern only, and that lives in cli/home.ts (`--home`, `RP_CORE_HOME`, `~/.rp-core`); config.ts just joins `config.toml`. Not taken: `ENV_PROVIDERS` (guessing a provider from familiar `*_API_KEY` variables) — keys come only from an explicit `key_env` / `key_cmd` (D-20, D-73); the vault path; `isProviderConfig`. |
| `src/config/secrets.ts` | Bunraku:src/kit/keystore/backends/linux-secret.ts, keychain-key.ts, spawn-collect.ts | 702d8120 | reference | Semantics only: the command runs as argv with no shell, stdout trimmed is the secret, stderr is collected but not surfaced. Not taken: the vault / AES key store, lock files and the "key made" marker; `linux-secret.ts`'s error text that quotes stderr (`secret-tool lookup exited N: <stderr>`) — rp-core errors name only the connection, the program's base name and the exit status. Added: 10 s timeout with SIGKILL that returns without waiting on pipes a grandchild may hold, a 64 KiB stdout cap, a one-line check, failures not memoised. |
