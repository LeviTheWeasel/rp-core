// Test preload (bunfig.toml): every test process gets its own temporary RP_CORE_HOME so no test
// can touch the real ~/.rp-core. Tests that need an isolated home create their own with tmpHome().
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'bun:test';

const root = mkdtempSync(join(tmpdir(), 'rp-core-test-'));
process.env.RP_CORE_HOME = root;
process.env.RP_CORE_TEST = '1';

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
