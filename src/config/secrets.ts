// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// API keys (ARCHITECTURE.md §13, D-20, D-73). Keys come only from key_env or key_cmd (spawned without a
// shell, 10 s timeout), live in process memory, and never reach session files, traces, events, logs or
// argv. Reference only: Bunraku src/kit/keystore/backends/linux-secret.ts, spawn-collect.ts (semantics).
// CONTRACT FILE (M1b): signatures are fixed; the config agent implements the bodies.

export interface SecretSpec {
  /** Connection id, for error messages. */
  conn: string;
  keyEnv?: string;
  keyCmd?: string[];
}

export interface SecretResolver {
  /**
   * Resolve once and memoise per spec. No key configured → null. key_env unset/empty or key_cmd non-zero
   * exit / timeout / empty stdout → ProviderError {category:'auth', code:'key_unavailable'} whose message
   * names the connection and the exit status but NEVER includes stdout/stderr.
   */
  resolve(spec: SecretSpec): Promise<string | null>;
  /** Every secret value resolved so far (for scrub). */
  known(): string[];
}

export function createSecretResolver(deps: {
  env: Record<string, string | undefined>;
  /** Injected for tests; default Bun.spawn with stdout/stderr piped, no shell. */
  run?: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number | null; stdout: string; timedOut: boolean }>;
  timeoutMs?: number;
}): SecretResolver {
  void deps;
  throw new Error('not implemented: createSecretResolver');
}

/** Replace every known secret (length >= 6) in text with '[redacted]'. */
export function scrub(text: string, secrets: readonly string[]): string {
  void text; void secrets;
  throw new Error('not implemented: scrub');
}
