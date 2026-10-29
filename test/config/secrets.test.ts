// API keys from key_env / key_cmd, and scrub (§13, D-20, D-73).
import { describe, expect, test } from 'bun:test';
import { createSecretResolver, scrub, spawnRunner, type RunResult } from '../../src/config/secrets.ts';
import { ProviderError } from '../../src/providers/types.ts';

/** The ProviderError a resolve rejects with (fails the test when it resolves). */
async function rejection(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected a rejection');
}

function expectKeyUnavailable(err: ProviderError): void {
  expect(err.code).toBe('key_unavailable');
  expect(err.category).toBe('auth');
  expect(err.status).toBeUndefined();
}

describe('key_env', () => {
  test('no key configured resolves to null', async () => {
    const r = createSecretResolver({ env: {} });
    expect(await r.resolve({ conn: 'local' })).toBeNull();
    expect(r.known()).toEqual([]);
  });

  test('present: the value (trimmed), remembered for scrub, memoised', async () => {
    const env: Record<string, string | undefined> = { OR_KEY: '  sk-or-test-value-1  ' };
    const r = createSecretResolver({ env });
    expect(await r.resolve({ conn: 'openrouter', keyEnv: 'OR_KEY' })).toBe('sk-or-test-value-1');
    env.OR_KEY = 'changed-later';
    expect(await r.resolve({ conn: 'openrouter', keyEnv: 'OR_KEY' })).toBe('sk-or-test-value-1');
    expect(r.known()).toEqual(['sk-or-test-value-1']);
  });

  test('missing or empty: key_unavailable naming the connection and the variable', async () => {
    for (const env of [{}, { OR_KEY: '' }, { OR_KEY: '   ' }]) {
      const err = await rejection(createSecretResolver({ env }).resolve({ conn: 'openrouter', keyEnv: 'OR_KEY' }));
      expectKeyUnavailable(err);
      expect(err.message).toBe("connection 'openrouter': environment variable OR_KEY (key_env) is not set");
    }
  });

  test('a failure is not memoised: exporting the variable later works', async () => {
    const env: Record<string, string | undefined> = {};
    const r = createSecretResolver({ env });
    await rejection(r.resolve({ conn: 'a', keyEnv: 'K' }));
    env.K = 'now-it-is-set';
    expect(await r.resolve({ conn: 'a', keyEnv: 'K' })).toBe('now-it-is-set');
  });

  test('a TUI-supplied key replaces a cached key and remains available only in memory', async () => {
    const env = { OR_KEY: 'old-key' };
    const r = createSecretResolver({ env });
    const spec = { conn: 'openrouter', keyEnv: 'OR_KEY' };
    expect(await r.resolve(spec)).toBe('old-key');
    r.provide!(spec, 'new-key');
    expect(await r.resolve(spec)).toBe('new-key');
    expect(env.OR_KEY).toBe('old-key');
    expect(scrub('new-key and old-key', r.known())).toBe('[redacted] and [redacted]');
    expect(() => r.provide!(spec, 'bad\nkey')).toThrow(ProviderError);
  });
});

describe('key_cmd (real processes, no shell of our own)', () => {
  test('success: stdout trimmed', async () => {
    const r = createSecretResolver({ env: {} });
    const key = await r.resolve({ conn: 'deepseek', keyCmd: ['sh', '-c', 'printf "  cmd-secret-value-42\\n\\n"'] });
    expect(key).toBe('cmd-secret-value-42');
    expect(r.known()).toEqual(['cmd-secret-value-42']);
  });

  test('argv is passed as-is: no shell expansion of the arguments', async () => {
    const r = createSecretResolver({ env: {} });
    expect(await r.resolve({ conn: 'a', keyCmd: ['printf', '%s', '$HOME;*'] })).toBe('$HOME;*');
  });

  test('exit 1: the status is named, stdout and stderr never are', async () => {
    const r = createSecretResolver({ env: {} });
    const err = await rejection(
      r.resolve({ conn: 'deepseek', keyCmd: ['sh', '-c', 'echo leaked-stdout-text; echo leaked-stderr-text >&2; exit 1'] }),
    );
    expectKeyUnavailable(err);
    expect(err.message).toBe("connection 'deepseek': key_cmd 'sh' exited with status 1");
    expect(err.message).not.toContain('leaked');
    expect(r.known()).toEqual([]);
  });

  test('timeout: the child is killed and the call returns promptly', async () => {
    const r = createSecretResolver({ env: {}, timeoutMs: 300 });
    const t0 = performance.now();
    const err = await rejection(r.resolve({ conn: 'kr', keyCmd: ['sh', '-c', 'sleep 5'] }));
    const took = performance.now() - t0;
    expectKeyUnavailable(err);
    expect(err.message).toBe("connection 'kr': key_cmd 'sh' timed out after 300 ms and was killed");
    expect(took).toBeLessThan(2500);
  });

  test('the default runner kills the process on timeout', async () => {
    const r = await spawnRunner(['sh', '-c', 'echo partial-secret; exec sleep 5'], 300);
    expect(r).toEqual({ exitCode: null, stdout: '', timedOut: true });
  });

  test('timeout kills the whole process group: a wrapper\'s children do not outlive it (review M1b)', async () => {
    // A unique marker so `ps` finds exactly this test's grandchild (sleep with an odd duration).
    const marker = `${31 + Math.floor(performance.now() % 1000) / 1000}`;
    const r = await spawnRunner(['sh', '-c', `echo prompt-on-stderr >&2; sleep ${marker}; echo sk-late`], 300);
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 100));
    const ps = Bun.spawnSync(['ps', '-eo', 'args']).stdout.toString();
    expect(ps.split('\n').some((l) => l.trim() === `sleep ${marker}`)).toBe(false);
  });

  test('a key with a character a header cannot carry is refused without a word of it (review M1b: fetch quoted it)', async () => {
    const zwsp = 'sk-test-SECRETKEY1234567890abcdef\u200b';
    for (const value of [zwsp, 'sk-one two', 'sk-\u00a0nbsp', '\u201csk-quoted\u201d']) {
      const r = createSecretResolver({ env: { K: value } });
      const err = await rejection(r.resolve({ conn: 'mock', keyEnv: 'K' }));
      expectKeyUnavailable(err);
      expect(err.message).toStartWith("connection 'mock': environment variable K (key_env) holds a character an HTTP header cannot carry");
      expect(err.message).not.toContain('SECRET');
      expect(err.message).not.toContain('sk-');
      expect(r.known()).toEqual([]);
    }
    const cmd = createSecretResolver({ env: {} });
    const err = await rejection(cmd.resolve({ conn: 'kc', keyCmd: ['sh', '-c', 'printf "sk-cmd-SECRET\\342\\200\\213"'] }));
    expect(err.message).toBe(
      "connection 'kc': key_cmd 'sh' printed a character an HTTP header cannot carry (a space or line break inside it, or an invisible or non-ASCII character, often pasted along with the key); the value is not shown",
    );
    // Surrounding whitespace is still trimmed away, as before.
    expect(await createSecretResolver({ env: { K: '  sk-fine-123456 \n' } }).resolve({ conn: 'x', keyEnv: 'K' })).toBe('sk-fine-123456');
  });

  test('empty stdout, several lines, a missing program: refused without echoing anything', async () => {
    const r = createSecretResolver({ env: {} });
    const empty = await rejection(r.resolve({ conn: 'a', keyCmd: ['sh', '-c', 'printf "   \\n"'] }));
    expect(empty.message).toBe("connection 'a': key_cmd 'sh' exited with status 0 but printed nothing");

    const lines = await rejection(r.resolve({ conn: 'a', keyCmd: ['sh', '-c', 'echo "Password for keyring:"; echo real-secret-xyz'] }));
    expect(lines.message).toBe("connection 'a': key_cmd 'sh' printed more than one line (expected only the key)");
    expect(lines.message).not.toContain('real-secret-xyz');

    const missing = await rejection(r.resolve({ conn: 'a', keyCmd: ['/nonexistent/dir/rp-core-no-such-tool', 'arg-that-must-not-leak'] }));
    expectKeyUnavailable(missing);
    expect(missing.message).toStartWith("connection 'a': key_cmd could not start 'rp-core-no-such-tool'");
    expect(missing.message).not.toContain('arg-that-must-not-leak');
    expect(missing.message).not.toContain('/nonexistent');
    expect(r.known()).toEqual([]);
  });
});

describe('key_cmd (injected runner)', () => {
  test('the runner gets a copy of argv and the 10 s default timeout', async () => {
    const calls: [string[], number][] = [];
    const argv = ['secret-tool', 'lookup', 'service', 'rp-core'];
    const r = createSecretResolver({
      env: {},
      run: async (a, t) => {
        calls.push([a, t]);
        return { exitCode: 0, stdout: 'keyring-value\n', timedOut: false };
      },
    });
    expect(await r.resolve({ conn: 'x', keyCmd: argv })).toBe('keyring-value');
    expect(calls).toEqual([[argv, 10_000]]);
    expect(calls[0]![0]).not.toBe(argv);
  });

  test('concurrent resolves share one child; a later one is memoised', async () => {
    let runs = 0;
    const r = createSecretResolver({
      env: {},
      run: async () => {
        runs++;
        await Bun.sleep(5);
        return { exitCode: 0, stdout: 'shared-value', timedOut: false };
      },
    });
    const spec = { conn: 'x', keyCmd: ['tool'] };
    const [a, b] = await Promise.all([r.resolve(spec), r.resolve(spec)]);
    expect([a, b]).toEqual(['shared-value', 'shared-value']);
    expect(await r.resolve(spec)).toBe('shared-value');
    expect(runs).toBe(1);
  });

  test('after a failure the next call runs the command again', async () => {
    const results: RunResult[] = [
      { exitCode: null, stdout: '', timedOut: true },
      { exitCode: 0, stdout: 'unlocked-now', timedOut: false },
    ];
    const r = createSecretResolver({ env: {}, run: async () => results.shift()! });
    const spec = { conn: 'x', keyCmd: ['secret-tool', 'lookup'] };
    const err = await rejection(r.resolve(spec));
    expect(err.message).toBe("connection 'x': key_cmd 'secret-tool' timed out after 10 s and was killed");
    expect(await r.resolve(spec)).toBe('unlocked-now');
  });

  test('killed by a signal, and an oversized output, are reported without the output', async () => {
    const r1 = createSecretResolver({ env: {}, run: async () => ({ exitCode: null, stdout: 'abc-secret', timedOut: false }) });
    expect((await rejection(r1.resolve({ conn: 'x', keyCmd: ['t'] }))).message).toBe("connection 'x': key_cmd 't' was killed by a signal");
    const r2 = createSecretResolver({
      env: {},
      run: async () => ({ exitCode: 0, stdout: 'abc-secret', timedOut: false, overflow: true }) as RunResult,
    });
    const big = await rejection(r2.resolve({ conn: 'x', keyCmd: ['t'] }));
    expect(big.message).toBe("connection 'x': key_cmd 't' printed more than 64 KiB (expected only the key)");
  });

  test('the runner throwing (spawn failed) keeps only the error code and program name', async () => {
    const r = createSecretResolver({
      env: {},
      run: async () => {
        throw Object.assign(new Error('spawn /opt/tools/get-key --token=abc failed'), { code: 'EACCES' });
      },
    });
    const err = await rejection(r.resolve({ conn: 'x', keyCmd: ['/opt/tools/get-key', '--token=abc'] }));
    expect(err.message).toBe("connection 'x': key_cmd could not start 'get-key' (EACCES)");
  });

  test('distinct specs resolve separately; key_env wins over nothing else', async () => {
    let runs = 0;
    const r = createSecretResolver({
      env: { K: 'env-secret-1' },
      run: async () => ({ exitCode: 0, stdout: `cmd-secret-${++runs}`, timedOut: false }),
    });
    expect(await r.resolve({ conn: 'a', keyCmd: ['t'] })).toBe('cmd-secret-1');
    expect(await r.resolve({ conn: 'b', keyCmd: ['t'] })).toBe('cmd-secret-2');
    expect(await r.resolve({ conn: 'c', keyEnv: 'K' })).toBe('env-secret-1');
    expect(r.known().sort()).toEqual(['cmd-secret-1', 'cmd-secret-2', 'env-secret-1']);
  });
});

describe('scrub', () => {
  test('replaces every known secret of 6+ characters, every occurrence', () => {
    expect(scrub('auth sk-abc123 failed; sk-abc123 again', ['sk-abc123'])).toBe('auth [redacted] failed; [redacted] again');
  });

  test('shorter secrets are left alone (too likely to hit ordinary text)', () => {
    expect(scrub('the key abc12 was wrong', ['abc12'])).toBe('the key abc12 was wrong');
  });

  test('longest first, so a secret containing another is replaced whole', () => {
    expect(scrub('x=secret-long-value', ['secret', 'secret-long-value'])).toBe('x=[redacted]');
  });

  test('regex characters in a secret are literal; nothing to replace leaves the text as is', () => {
    expect(scrub('k=a.b*c+d?(e)', ['a.b*c+d?(e)'])).toBe('k=[redacted]');
    expect(scrub('nothing here', ['sk-zzzzzz'])).toBe('nothing here');
    expect(scrub('nothing here', [])).toBe('nothing here');
  });

  test('remember() adds header values to what scrub knows', () => {
    const r = createSecretResolver({ env: {} });
    r.remember?.('header-secret-9');
    r.remember?.('');
    expect(r.known()).toEqual(['header-secret-9']);
    expect(scrub('sent header-secret-9', r.known())).toBe('sent [redacted]');
  });
});
