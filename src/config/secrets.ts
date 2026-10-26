// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// API keys (ARCHITECTURE.md §13, D-20, D-73). Keys come only from key_env or key_cmd (spawned without a
// shell, 10 s timeout), live in process memory, and never reach session files, traces, events, logs or
// argv. Reference only: Bunraku src/kit/keystore/backends/linux-secret.ts, spawn-collect.ts (semantics).
// CONTRACT FILE (M1b): signatures are fixed; the config agent implements the bodies.
//
// Taken from the Bunraku reference as semantics, not code: the command runs with stdout and stderr
// piped and no shell; stdout is the secret, trimmed; stderr is read only so the child can never block
// on a full pipe, and is thrown away. Added here: a hard timeout that kills the child (a locked keyring
// can hold secret-tool forever, D-73), and errors that never quote what the command printed (it may
// echo a prompt or the secret itself). The command runs in its own process group, and a timeout kills
// the whole group (a wrapper script, `sh -c …`, `pass` → gpg), not only the direct child. A key with a
// character an HTTP header cannot carry (an invisible U+200B pasted along with it, a space, a line
// break) is refused here with a fixed message: sent on, fetch would reject the header and quote it,
// key and all, in its error.

import { ProviderError } from '../providers/types.ts';

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
  /**
   * Add a secret that did not come through resolve() (header values read from env by
   * buildConnections, D-53) so scrub() covers it too. Optional: hosts may bring their own resolver.
   */
  remember?(secret: string): void;
}

/** What the injected runner reports. `exitCode` is null when the process died from a signal. */
export interface RunResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  /** stdout went past MAX_STDOUT_BYTES (it was cut there): whatever it is, it is not a key. */
  overflow?: boolean;
}

export type SecretRunner = (argv: string[], timeoutMs: number) => Promise<RunResult>;

/** D-73: a key command gets 10 s. */
export const KEY_CMD_TIMEOUT_MS = 10_000;

/** A key is a short token; anything past this is not a key and is not kept in memory. */
const MAX_STDOUT_BYTES = 64 * 1024;

export function createSecretResolver(deps: {
  env: Record<string, string | undefined>;
  /** Injected for tests; default Bun.spawn with stdout/stderr piped, no shell. */
  run?: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number | null; stdout: string; timedOut: boolean }>;
  timeoutMs?: number;
}): SecretResolver {
  const run = deps.run ?? spawnRunner;
  const timeoutMs = deps.timeoutMs ?? KEY_CMD_TIMEOUT_MS;
  // In-flight and successful lookups, by spec. A failed lookup is forgotten, so the next call tries
  // again (the user may have unlocked the keyring or exported the variable in the meantime), while
  // concurrent callers still share one child process.
  const memo = new Map<string, Promise<string | null>>();
  const secrets = new Set<string>();

  const lookup = async (spec: SecretSpec): Promise<string | null> => {
    if (spec.keyEnv !== undefined) {
      const value = deps.env[spec.keyEnv];
      if (value === undefined || value.trim() === '') {
        throw unavailable(spec.conn, `environment variable ${spec.keyEnv} (key_env) is not set`);
      }
      const key = value.trim();
      if (!isHeaderSafeKey(key)) {
        throw unavailable(spec.conn, `environment variable ${spec.keyEnv} (key_env) holds ${UNSAFE_KEY}`);
      }
      secrets.add(key);
      return key;
    }
    if (spec.keyCmd !== undefined) {
      const argv = spec.keyCmd;
      if (argv.length === 0 || argv[0] === '') throw unavailable(spec.conn, 'key_cmd is empty');
      let r: RunResult;
      try {
        r = await run([...argv], timeoutMs);
      } catch (err) {
        // The spawn error may carry argv; only its code and the program name are repeated.
        const code = (err as { code?: unknown } | null)?.code;
        const why = typeof code === 'string' ? ` (${code})` : '';
        throw unavailable(spec.conn, `key_cmd could not start ${programName(argv[0]!)}${why}`);
      }
      if (r.timedOut) {
        throw unavailable(spec.conn, `key_cmd ${programName(argv[0]!)} timed out after ${seconds(timeoutMs)} and was killed`);
      }
      if (r.exitCode !== 0) {
        const status = r.exitCode === null ? 'was killed by a signal' : `exited with status ${r.exitCode}`;
        throw unavailable(spec.conn, `key_cmd ${programName(argv[0]!)} ${status}`);
      }
      if (r.overflow) throw unavailable(spec.conn, `key_cmd ${programName(argv[0]!)} printed more than ${MAX_STDOUT_BYTES / 1024} KiB (expected only the key)`);
      const key = r.stdout.trim();
      if (key === '') throw unavailable(spec.conn, `key_cmd ${programName(argv[0]!)} exited with status 0 but printed nothing`);
      // A key is one line. Several lines usually mean a prompt or a banner came along; sending that as
      // a header would fail in fetch with an error that may quote it.
      if (/[\r\n]/.test(key)) {
        throw unavailable(spec.conn, `key_cmd ${programName(argv[0]!)} printed more than one line (expected only the key)`);
      }
      if (!isHeaderSafeKey(key)) throw unavailable(spec.conn, `key_cmd ${programName(argv[0]!)} printed ${UNSAFE_KEY}`);
      secrets.add(key);
      return key;
    }
    return null;
  };

  return {
    resolve(spec: SecretSpec): Promise<string | null> {
      const id = JSON.stringify([spec.conn, spec.keyEnv ?? null, spec.keyCmd ?? null]);
      const hit = memo.get(id);
      if (hit) return hit;
      const p = lookup(spec);
      memo.set(id, p);
      p.catch(() => {
        if (memo.get(id) === p) memo.delete(id);
      });
      return p;
    },
    known(): string[] {
      return [...secrets];
    },
    remember(secret: string): void {
      if (secret !== '') secrets.add(secret);
    },
  };
}

/** Replace every known secret (length >= 6) in text with '[redacted]'. */
export function scrub(text: string, secrets: readonly string[]): string {
  // Longest first, so a secret that contains another one is replaced whole.
  const list = [...new Set(secrets)].filter((s) => s.length >= 6).sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of list) if (out.includes(s)) out = out.split(s).join('[redacted]');
  return out;
}

/**
 * An API key as a header can carry it: visible ASCII only (0x21–0x7E). API keys are tokens; anything
 * else (a space, U+200B, a non-breaking space, a smart quote) was pasted along with the key.
 */
export function isHeaderSafeKey(key: string): boolean {
  return key !== '' && /^[\x21-\x7e]+$/.test(key);
}

/**
 * A header value from the environment (D-53) as fetch can send it: printable ASCII, inner spaces
 * allowed (an X-Title may be words), no leading or trailing space, no control or non-ASCII character.
 */
export function isHeaderSafeValue(value: string): boolean {
  return value !== '' && /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value);
}

/** Why a key is refused, without a word of the key itself. */
const UNSAFE_KEY =
  'a character an HTTP header cannot carry (a space or line break inside it, or an invisible or non-ASCII character, often pasted along with the key); the value is not shown';

// ---- internals ---------------------------------------------------------------------------------

function unavailable(conn: string, why: string): ProviderError {
  return new ProviderError({ category: 'auth', code: 'key_unavailable', message: `connection '${conn}': ${why}` });
}

/** The program's base name only: argv[0] may be a path, and the rest of argv is never repeated. */
function programName(argv0: string): string {
  const base = argv0.split(/[\\/]/).pop() ?? argv0;
  return `'${base}'`;
}

function seconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/** SIGKILL to the child's whole process group (it leads one: spawned detached); the child alone if that fails. */
function killGroup(proc: { pid: number; kill(signal?: number | NodeJS.Signals): void }): void {
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * The default runner: Bun.spawn with argv as given (no shell), stdin closed, stdout and stderr piped,
 * in a process group of its own (detached). On timeout the whole group is killed with SIGKILL, so a
 * wrapper's children die with it (`sh -c 'sleep 30'`, `pass` → gpg), and the call returns at once,
 * without waiting for the pipes. A command still running when rp-core exits is killed the same way.
 */
export async function spawnRunner(argv: string[], timeoutMs: number): Promise<RunResult> {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true });
  // Detached, the group no longer gets the terminal's Ctrl+C with rp-core: it is killed on exit instead.
  const onExit = (): void => killGroup(proc);
  process.once('exit', onExit);
  void proc.exited.then(
    () => process.off('exit', onExit),
    () => process.off('exit', onExit),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const work = (async () => {
    const [out] = await Promise.all([readCapped(proc.stdout), drain(proc.stderr)]);
    const exitCode = await proc.exited;
    return { ...out, exitCode: proc.signalCode ? null : exitCode };
  })();
  try {
    const r = await Promise.race([work, timeout]);
    if (r === 'timeout') {
      killGroup(proc);
      work.catch(() => {});
      return { exitCode: null, stdout: '', timedOut: true };
    }
    return r.overflow
      ? { exitCode: r.exitCode, stdout: r.stdout, timedOut: false, overflow: true }
      : { exitCode: r.exitCode, stdout: r.stdout, timedOut: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** stdout as text, at most MAX_STDOUT_BYTES (the rest is read and dropped so the child can finish). */
async function readCapped(stream: ReadableStream<Uint8Array>): Promise<{ stdout: string; overflow: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of stream) {
    const room = MAX_STDOUT_BYTES - size;
    if (chunk.byteLength > room) overflow = true;
    if (room <= 0) continue;
    const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    chunks.push(part);
    size += part.byteLength;
  }
  return { stdout: new TextDecoder().decode(Buffer.concat(chunks)), overflow };
}

/** Read and discard (stderr may echo prompts; it is never kept). */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const _ of stream) void _;
}
