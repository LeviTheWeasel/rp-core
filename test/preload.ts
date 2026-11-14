// Test preload (bunfig.toml): every test process gets its own temporary RP_CORE_HOME so no test
// can touch the real ~/.rp-core. Tests that need an isolated home create their own with tmpHome().
// TMPDIR points inside the same root, so every directory a test makes under tmpdir() (tmpHome, the
// CLI and REPL rigs, child processes) goes away with it: /tmp is often a RAM-backed tmpfs, and
// thousands of leftover homes per run filled it up.
// RP_CORE_LANE=manual (M5b, the lead's ruling G): engines opened by tests, and CLIs they spawn, never
// start a Compendium lane task by themselves; the M5b tests opt in (EngineOptions.lane, memoryWait).
// RP_CORE_RECALL=lexical (M5c, D-207): the recall mode default is lexical, so the scripted tests and
// spawned CLIs written before recall make no recall calls; the M5c tests opt in (a mode in the
// session's config, EngineSeams.recall 'config', or RP_CORE_RECALL=auto in a child's environment).
// RP_CORE_SERVER_INFO=off (M5d, D-210): engines and probes never ask a local server what it is, so the
// tests' mock servers see only the requests they did before; the M5d tests opt in
// (EngineOptions.serverInfo 'auto', CatalogArgs.serverInfo 'auto').
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'bun:test';

const root = mkdtempSync(join(tmpdir(), 'rp-core-test-'));
const tmp = join(root, 'tmp');
mkdirSync(tmp);
process.env.RP_CORE_HOME = root;
process.env.RP_CORE_TEST = '1';
process.env.RP_CORE_LANE = 'manual';
process.env.RP_CORE_RECALL = 'lexical';
process.env.RP_CORE_SERVER_INFO = 'off';
// RP_CORE_BENCH_SALT='' (M5d): bench ttft's prompts carry no random salt, so its output is the same every run.
process.env.RP_CORE_BENCH_SALT = '';
process.env.TMPDIR = tmp;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
