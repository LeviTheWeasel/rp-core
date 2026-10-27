// Test preload (bunfig.toml): every test process gets its own temporary RP_CORE_HOME so no test
// can touch the real ~/.rp-core. Tests that need an isolated home create their own with tmpHome().
// TMPDIR points inside the same root, so every directory a test makes under tmpdir() (tmpHome, the
// CLI and REPL rigs, child processes) goes away with it: /tmp is often a RAM-backed tmpfs, and
// thousands of leftover homes per run filled it up.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'bun:test';

const root = mkdtempSync(join(tmpdir(), 'rp-core-test-'));
const tmp = join(root, 'tmp');
mkdirSync(tmp);
process.env.RP_CORE_HOME = root;
process.env.RP_CORE_TEST = '1';
process.env.TMPDIR = tmp;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
