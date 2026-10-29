import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_TEMPLATE, loadConfig } from '../../src/config/config.ts';
import { tmpHome } from '../helpers.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { currentConfig } from '../../src/session/fold.ts';
import { tuiRig, type TuiRig } from './kit.ts';

let rig: TuiRig | null = null;
afterEach(async () => { if (rig) await rig.close(); rig = null; });

test('F4 lists connection models and Enter changes the narrator in this session', async () => {
  const fetcher = (async () => new Response(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] }), {
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  rig = await tuiRig([], { catalog: { baseUrl: 'https://models.example/v1', fetch: fetcher } });
  await rig.until('Hello, Levi');
  await rig.type('draft');
  await rig.setup.mockInput.pressKeys(['F4']);
  const picker = await rig.until('beta');
  expect(picker).toContain('Choose narrator model');
  expect(picker).toContain('alt');
  expect(picker).toContain('script');
  rig.setup.mockInput.pressArrow('down');
  rig.setup.mockInput.pressEnter();
  const changed = await rig.gone('Choose narrator model');
  expect(changed).toContain('alt:beta');
  expect(rig.input()).toBe('draft');
  await rig.setup.mockInput.pressKeys(['F4']);
  await rig.until('Choose narrator model');
  rig.setup.mockInput.pressEscape();
  await rig.gone('Choose narrator model');
});

test('closing the picker keeps an unsent draft; connections without catalogs are explained', async () => {
  rig = await tuiRig([]);
  await rig.until('Hello, Levi');
  await rig.type('unsent draft');
  await rig.setup.mockInput.pressKeys(['F4']);
  const picker = await rig.until('no model catalog');
  expect(picker).toContain('alt');
  expect(picker).toContain('script');
  rig.setup.mockInput.pressEscape();
  await rig.gone('Choose narrator model');
  expect(rig.input()).toBe('unsent draft');
});

test('F9 connects OpenRouter from F4, keeps the key private, and filters its models', async () => {
  const secret = 'sk-or-test-private';
  const authorizations: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization') ?? '');
    return new Response(JSON.stringify({ data: [
    { id: 'vendor/nebula' }, { id: 'vendor/other' },
    ] }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  rig = await tuiRig([], { catalog: { baseUrl: 'https://models.example/v1', fetch: fetcher } });
  await rig.until('Hello, Levi');
  await rig.type('draft');
  await rig.setup.mockInput.pressKeys(['F4']);
  await rig.until('Choose narrator model');
  await rig.setup.mockInput.pressKeys(['F9']);
  await rig.until('Connect OpenRouter');
  rig.setup.renderer.keyInput.processPaste(new TextEncoder().encode(secret));
  expect(await rig.frame()).not.toContain(secret);
  expect(rig.input()).toBe('draft');
  rig.setup.mockInput.pressEnter();
  await rig.until('openrouter');
  const config = readFileSync(join(rig.home, 'config.toml'), 'utf8');
  expect(config).toContain('[connections.openrouter]');
  expect(config).toContain('key_env = "OPENROUTER_API_KEY"');
  expect(config).not.toContain(secret);
  expect(loadConfig(rig.home).connections.openrouter?.keyEnv).toBe('OPENROUTER_API_KEY');
  expect(authorizations).toContain(`Bearer ${secret}`);
  await rig.type('openrouter nebula');
  const filtered = await rig.until('vendor/nebula');
  expect(filtered).not.toContain('vendor/other');
  rig.setup.mockInput.pressEnter();
  await rig.gone('Choose narrator model');
  await rig.until('openrouter:vendor/nebula');
  const { header, entries } = readSessionFile(rig.home, rig.session.id);
  expect(currentConfig(header, entries).roles.narrator).toEqual({ conn: 'openrouter', model: 'vendor/nebula' });
  expect(rig.input()).toBe('draft');
});

test('invalid or cancelled OpenRouter key stays out of the config and chat', async () => {
  rig = await tuiRig([]);
  await rig.until('Hello, Levi');
  await rig.type('draft');
  await rig.setup.mockInput.pressKeys(['F4']);
  await rig.setup.mockInput.pressKeys(['F9']);
  await rig.until('Connect OpenRouter');
  await rig.type('bad key');
  rig.setup.mockInput.pressEnter();
  const error = await rig.until('Invalid API key');
  expect(error).not.toContain('bad key');
  expect(existsSync(join(rig.home, 'config.toml'))).toBe(false);
  rig.setup.mockInput.pressEscape();
  await rig.gone('Connect OpenRouter');
  rig.setup.mockInput.pressEscape();
  await rig.gone('Choose narrator model');
  expect(rig.input()).toBe('draft');
});

test('F9 uses an existing OpenRouter config without adding a duplicate table', async () => {
  const home = tmpHome('rp-core-openrouter-');
  const file = join(home, 'config.toml');
  writeFileSync(file, CONFIG_TEMPLATE);
  const before = readFileSync(file, 'utf8');
  const fetcher = (async () => new Response(JSON.stringify({ data: [{ id: 'vendor/model' }] }), {
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  rig = await tuiRig([], { home, rpConfig: loadConfig(home), catalog: { baseUrl: 'https://models.example/v1', fetch: fetcher } });
  await rig.until('Hello, Levi');
  await rig.setup.mockInput.pressKeys(['F4']);
  await rig.setup.mockInput.pressKeys(['F9']);
  await rig.type('sk-or-another-secret');
  rig.setup.mockInput.pressEnter();
  await rig.until('openrouter');
  expect(readFileSync(file, 'utf8')).toBe(before);
  rig.setup.mockInput.pressEscape();
});
