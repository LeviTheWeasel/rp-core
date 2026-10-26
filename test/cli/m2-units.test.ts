// M2 CLI units in process: repeatable flags, --provider record:/replay: attached to a runtime, and
// the refs /preset, /lore add, new --preset and new --lore accept.
import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { list, parseArgs, str, UsageError } from '../../src/cli/args.ts';
import { prepareProvider, recordingConnections, replayConnection, ScriptFileError } from '../../src/cli/provider.ts';
import { addLoreId, bookRows, entryTitles, expandHome, RefError, resolveLoreRef, resolvePresetRef } from '../../src/cli/refs.ts';
import { loadRuntime } from '../../src/cli/runtime.ts';
import type { Connection } from '../../src/engine/api.ts';
import { saveToLibrary } from '../../src/formats/library.ts';
import { importFile } from '../../src/formats/import.ts';
import { BUILTIN_PRESET } from '../../src/formats/native.ts';
import type { RecordedCall } from '../../src/providers/record.ts';
import { createScriptedProvider, SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import type { ModelRequest, StreamEv } from '../../src/providers/types.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { cmdPreview } from '../../src/cli/preview.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { engineOptions } from '../../src/cli/runtime.ts';
import { Engine } from '../../src/engine/engine.ts';
import { LEVI, MIRA } from '../engine/kit.ts';

const ROOT = join(import.meta.dir, '..', '..');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'cli-m2');
const PRESET = join(FIXTURES, 'Lighthouse.json');
const HARBOR = join(FIXTURES, 'Harbor.json');
const CARD = join(ROOT, 'test', 'fixtures', 'cards', 'v3-full.json');

describe('list flags', () => {
  test('a list flag collects every value in order; string flags still refuse a repeat', () => {
    const spec = { flags: { lore: 'list', preset: 'string', json: 'bool' } } as const;
    const p = parseArgs(['--lore', 'a', '--preset=p', '--lore=b c', '--json', '--lore', 'a'], spec);
    expect(list(p, 'lore')).toEqual(['a', 'b c', 'a']);
    expect(str(p, 'preset')).toBe('p');
    expect(str(p, 'lore')).toBeUndefined();
    expect(list(parseArgs([], spec), 'lore')).toEqual([]);
    expect(list(p, 'preset')).toEqual(['p']);
    expect(() => parseArgs(['--preset', 'a', '--preset', 'b'], spec)).toThrow('--preset given twice');
    expect(() => parseArgs(['--lore'], spec)).toThrow(UsageError);
    expect(() => parseArgs(['--lore', '--json'], spec)).toThrow('--lore needs a value');
  });
});

/** A runtime over a config.toml with one openai-chat connection (nothing is fetched). */
function runtimeWithMock(env: Record<string, string> = {}) {
  const home = tmpHome('rp-core-m2u-');
  writeFileSync(
    join(home, 'config.toml'),
    '[connections.mock]\nbase_url = "http://127.0.0.1:9"\nkey_env = "RP_K"\nheaders = { "X-Org" = "RP_ORG" }\n[caps."mock:m"]\ncontext_length = 32768\nmid_system = "as-user"\n',
  );
  return { home, rt: loadRuntime(home, env) };
}

const req = (text: string): ModelRequest =>
  ({
    model: { connection: 'mock', model: 'm' },
    caps: SCRIPT_CAPS,
    messages: [{ role: 'user', src: 'history', blocks: [{ k: 'text', text }] }],
    maxTokens: 10,
    samplers: {},
    signal: new AbortController().signal,
  }) as unknown as ModelRequest;

async function drain(it: AsyncIterable<StreamEv>): Promise<StreamEv[]> {
  const out: StreamEv[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('--provider record:', () => {
  test('every config connection is wrapped; id, caps, origin, key resolution and wire() stay', () => {
    const { home, rt } = runtimeWithMock({ RP_K: 'sk-unit-secret-1', RP_ORG: 'org-unit-secret' });
    const before = rt.connections.mock!;
    const file = join(home, 'rec.jsonl');
    const prepared = prepareProvider(`record:${file}`, 'send');
    expect(readFileSync(file, 'utf8')).toBe(''); // created now, so a bad path fails early
    prepared.attach(rt);
    const after = rt.connections.mock!;
    expect(rt.provider).toBeUndefined();
    expect(after.provider).not.toBe(before.provider);
    expect(after.id).toBe('mock');
    expect(after.origin).toBe(before.origin);
    expect(after.local).toBe(before.local);
    expect(after.capsFor!('m')).toEqual(before.capsFor!('m'));
    expect(after.resolveKey).toBe(before.resolveKey);
    expect(typeof after.provider.wire).toBe('function');
    expect(after.provider.wire!(req('hi')).url).toContain('/chat/completions');
  });

  test('a call goes through and lands as one scrubbed line; the secrets come from the runtime', async () => {
    const home = tmpHome('rp-core-m2u-');
    const file = join(home, 'rec.jsonl');
    const inner = createScriptedProvider([{ steps: [{ text: 'token org-unit-secret ok' }] }]);
    const conns: Record<string, Connection> = { a: { id: 'a', provider: inner, caps: SCRIPT_CAPS, origin: 'script:a', local: true } };
    const wrapped = recordingConnections(conns, file, () => ['org-unit-secret']);
    const evs = await drain(wrapped.a!.provider.stream(req('hello'), { fetch: globalThis.fetch, key: null } as never));
    expect(evs.some((e) => e.t === 'text')).toBe(true);
    const lines = readFileSync(file, 'utf8').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');
    const call = JSON.parse(lines[0]!) as RecordedCall;
    expect(call.model).toEqual({ connection: 'a', model: 'm' });
    expect(lines[0]).not.toContain('org-unit-secret');
    expect(lines[0]).toContain('[redacted]');
  });

  test('an unwritable recording path fails at once', () => {
    expect(() => prepareProvider('record:/nonexistent-dir-rp-core/x.jsonl')).toThrow(ScriptFileError);
  });
});

describe('--provider replay:', () => {
  const call = (connection: string | undefined, model: string): RecordedCall => ({
    v: 1,
    requestHash: '0123456789abcdef',
    request: { messages: [], maxTokens: 1, samplers: {} },
    model: { ...(connection ? { connection } : {}), model },
    events: [],
  });

  test('caps of the connection a call was recorded on, when config.toml still has it; else SCRIPT_CAPS', () => {
    const { rt } = runtimeWithMock();
    const conn = replayConnection('r.jsonl', [call('mock', 'm'), call('gone', 'x')], () => rt.connections);
    expect(conn.id).toBe('replay');
    expect(conn.origin).toMatch(/^replay:\/.*r\.jsonl$/);
    expect(conn.capsFor!('m')).toEqual(rt.connections.mock!.capsFor!('m'));
    expect(conn.capsFor!('m').midSystem).toBe('as-user');
    expect(conn.capsFor!('m').contextLength).toBe(32768);
    expect(conn.capsFor!('x')).toBe(SCRIPT_CAPS);
    expect(conn.caps).toEqual(rt.connections.mock!.capsFor!('m'));
    expect(conn.local).toBe(rt.connections.mock!.local);

    const bare = replayConnection('r.jsonl', [call(undefined, 'm')]);
    expect(bare.caps).toBe(SCRIPT_CAPS);
    expect(bare.capsFor!('m')).toBe(SCRIPT_CAPS);
    expect(bare.local).toBe(true);
  });

  test('attach makes it the override; a script stays a script', () => {
    const { home, rt } = runtimeWithMock();
    const file = join(home, 'r.jsonl');
    writeFileSync(file, `${JSON.stringify(call('mock', 'm'))}\n`);
    prepareProvider(`replay:${file}`).attach(rt);
    expect(rt.provider?.id).toBe('replay');
    expect(typeof rt.connections.mock!.provider.wire).toBe('function'); // untouched
    const s = runtimeWithMock().rt;
    prepareProvider(`script:${join(ROOT, 'test', 'fixtures', 'scripts', 'reply.jsonl')}`).attach(s);
    expect(s.provider?.id).toBe('script');
    expect(() => prepareProvider(`replay:${join(home, 'none.jsonl')}`)).toThrow('cannot read recording');
  });
});

describe('preset and lorebook refs', () => {
  test("'builtin', a file (imported), then its library id; a card is not a preset", () => {
    const home = tmpHome('rp-core-m2u-');
    expect(resolvePresetRef(home, 'builtin')).toEqual({ id: 'builtin', value: BUILTIN_PRESET });
    const fromFile = resolvePresetRef(home, PRESET);
    expect(fromFile.id).toBe('lighthouse');
    expect(fromFile.imported?.path).toBe(join(home, 'library', 'presets', 'lighthouse.json'));
    expect(fromFile.imported?.warnings).toHaveLength(1);
    const byId = resolvePresetRef(home, 'lighthouse');
    expect(byId.imported).toBeUndefined();
    expect(byId.value).toEqual(fromFile.value);
    expect(() => resolvePresetRef(home, CARD)).toThrow(RefError);
    expect(() => resolvePresetRef(home, CARD)).toThrow('expected a preset');
    expect(() => resolvePresetRef(home, 'other')).toThrow('(the library has: builtin, lighthouse)');
    expect(() => resolvePresetRef(home, 'dir/none.json')).toThrow('no such file: dir/none.json');
    expect(() => resolvePresetRef(home, '../escape')).toThrow(RefError);
    expect(() => resolvePresetRef(home, '  ')).toThrow('which preset?');
  });

  test('a broken library entry is refused before the session points at it', () => {
    const home = tmpHome('rp-core-m2u-');
    saveToLibrary(home, 'presets', 'broken', { name: 'broken', blocks: 'nope' });
    expect(() => resolvePresetRef(home, 'broken')).toThrow('library preset broken is invalid');
    saveToLibrary(home, 'lorebooks', 'bad', { name: 'bad' });
    expect(() => resolveLoreRef(home, 'bad')).toThrow('library lorebook bad is invalid');
  });

  test('lorebooks: a world info file, a card with a book, ~ expansion', () => {
    const home = tmpHome('rp-core-m2u-');
    const book = resolveLoreRef(home, HARBOR);
    expect(book).toMatchObject({ id: 'harbor', value: { name: 'Harbor' } });
    expect(book.value.entries).toHaveLength(3);
    const fromCard = resolveLoreRef(home, CARD);
    expect(fromCard.value.name).toBe("Alice's World");
    expect(() => resolveLoreRef(home, PRESET)).toThrow('expected a lorebook');

    const fakeHome = tmpHome('rp-core-m2u-home-');
    mkdirSync(join(fakeHome, 'w'));
    copyFileSync(HARBOR, join(fakeHome, 'w', 'Harbor.json'));
    expect(expandHome('~/w/Harbor.json', { HOME: fakeHome })).toBe(join(fakeHome, 'w', 'Harbor.json'));
    expect(expandHome('~other/x', { HOME: fakeHome })).toBe('~other/x');
    expect(expandHome('~/x', {})).toBe('~/x');
    expect(resolveLoreRef(home, '~/w/Harbor.json', { HOME: fakeHome }).id).toBe('harbor');
  });

  test('book rows in scan order and entry titles', () => {
    const home = tmpHome('rp-core-m2u-');
    resolveLoreRef(home, HARBOR);
    const cast = {
      character: { name: 'C', description: '', greetings: [], book: { name: 'Card book', entries: [{ id: 'x', title: 'X', content: 'x', keys: [], position: 'before' as const, enabled: false }] } },
      persona: { name: 'P', description: '', book: { name: 'Mine', entries: [] } },
    };
    expect(bookRows(home, cast, ['harbor', 'ghost'])).toEqual([
      { key: '@persona', owner: 'persona', name: 'Mine', entries: 0, disabled: 0 },
      { key: '@card', owner: 'card', name: 'Card book', entries: 1, disabled: 1 },
      { key: 'harbor', owner: 'session', name: 'Harbor', entries: 3, disabled: 1 },
      { key: 'ghost', owner: 'session', problem: 'missing from the library' },
    ]);
    const titles = entryTitles(home, cast, ['harbor']);
    expect(titles.get('@card:x')).toBe('X');
    expect(titles.get('harbor:1')).toBe('Evening fog');
    // the card's own book named like a session book is not read (a world is read once, ST)
    const same = { ...cast, character: { ...cast.character, book: { ...cast.character.book, name: 'Harbor' } } };
    expect(bookRows(home, same, ['harbor'])[1]).toEqual({ key: '@card', owner: 'card', name: 'Harbor', entries: 1, disabled: 1, shadowedBy: 'harbor' });
  });

  test('two session books with one name: the later is read, the earlier is marked (and the card book follows the one read)', () => {
    const home = tmpHome('rp-core-m2u-');
    resolveLoreRef(home, HARBOR);
    const copy = join(tmpHome('rp-core-src-'), 'Harbor.json');
    writeFileSync(copy, readFileSync(HARBOR, 'utf8').replace('nine years', 'ten years'));
    expect(resolveLoreRef(home, copy).id).toBe('harbor-2');
    const cast = { character: { name: 'C', description: '', greetings: [], book: { name: 'Harbor', entries: [] } } };
    const rows = bookRows(home, cast, ['harbor', 'harbor-2']);
    expect(rows.map((r) => [r.key, r.shadowedBy])).toEqual([
      ['@card', 'harbor-2'],
      ['harbor', 'harbor-2'],
      ['harbor-2', undefined],
    ]);
    // and the list a session gets when the copy is added: it takes the old one's place
    expect(addLoreId(home, ['harbor', 'x'], 'harbor-2', ' Harbor ')).toEqual({ ids: ['harbor-2', 'x'], replaced: 'harbor' });
    expect(addLoreId(home, ['x'], 'harbor', 'Harbor')).toEqual({ ids: ['x', 'harbor'] });
    expect(addLoreId(home, ['harbor'], 'other', '')).toEqual({ ids: ['harbor', 'other'] });
  });
});

// Regression: a preset saved under the id 'builtin' (Builtin.json, or --as builtin) could never be
// selected ('builtin' always resolves to the built-in layout) and /preset listed builtin twice.
describe("the preset id 'builtin' is reserved", () => {
  test('a preset named Builtin, or imported --as builtin, is saved as builtin-2, builtin-3; lorebooks may use the name', () => {
    const home = tmpHome('rp-core-m2u-');
    const dir = tmpHome('rp-core-src-');
    const file = join(dir, 'Builtin.json');
    copyFileSync(PRESET, file);
    const named = importFile(home, file, { expect: 'preset' });
    expect(named.id).toBe('builtin-2');
    expect(resolvePresetRef(home, 'builtin-2').value.name).toBe('Builtin');
    const as = importFile(home, PRESET, { as: 'builtin', expect: 'preset' });
    expect(as.id).toBe('builtin-3');
    // 'builtin' itself still names the built-in layout.
    expect(resolvePresetRef(home, 'builtin').value).toBe(BUILTIN_PRESET);
    expect(saveToLibrary(home, 'presets', 'BUILTIN', { name: 'x', blocks: [] }).id).toBe('builtin-4');
    expect(saveToLibrary(home, 'lorebooks', 'Builtin', { name: 'Builtin', entries: [] }).id).toBe('builtin');
  });

  test('an old library builtin.json is never offered as an id', () => {
    const home = tmpHome('rp-core-m2u-');
    mkdirSync(join(home, 'library', 'presets'), { recursive: true });
    writeFileSync(join(home, 'library', 'presets', 'builtin.json'), JSON.stringify({ ...BUILTIN_PRESET, name: 'Old' }));
    expect(() => resolvePresetRef(home, 'nowhere')).toThrow('(the library has: builtin)');
  });
});

describe('rp-core preview (in process)', () => {
  const seams = { clock: fakeClock(), random: fakeRandom(3), timeZone: 'UTC' };
  async function sessionOn(home: string, rt: ReturnType<typeof loadRuntime>, lorebooks: string[]): Promise<string> {
    const engine = await Engine.open({ ...engineOptions(rt), ...seams });
    const s = engine.createSession({ character: MIRA, persona: LEVI, config: { roles: { narrator: { conn: 'mock', model: 'm' } }, lorebooks } });
    await engine.close();
    void home;
    return s.id;
  }

  // Regression: --wire printed the body and dropped every notice (preview_inputs_changed among them).
  test('--wire: stdout stays the JSON body; the notices and the verdicts go to stderr', async () => {
    const { home, rt } = runtimeWithMock({ RP_K: 'sk-unit-secret-1' });
    const id = await sessionOn(home, rt, ['gone']);
    const out = memoryChannel();
    const err = memoryChannel();
    const code = await cmdPreview({ home, sessionId: id, draft: 'Hello', wire: true, verdicts: true, json: false, io: { out, err }, rt, engine: seams });
    expect(code).toBe(0);
    const body = JSON.parse(out.text()) as { model: string; messages: unknown[] };
    expect(body.model).toBe('m');
    expect(err.text()).toContain('rp-core: POST http://127.0.0.1:9/v1/chat/completions\n');
    expect(err.text()).toMatch(/rp-core: warn: The lorebook 'gone' is skipped.*\(lorebook_missing\)\n/);
    expect(err.text()).toContain('lore verdicts:\nno lore entries to test');
  });

  // Regression: a session with only its greeting was refused with no word on what to do.
  test('a session with only its greeting: the refusal says to use --draft; the refusal line stays last', async () => {
    const { home, rt } = runtimeWithMock({ RP_K: 'sk-unit-secret-1' });
    const id = await sessionOn(home, rt, []);
    const out = memoryChannel();
    const err = memoryChannel();
    const code = await cmdPreview({ home, sessionId: id, wire: false, verdicts: false, json: false, io: { out, err }, rt, engine: seams });
    expect(code).toBe(5);
    const lines = err.text().trim().split('\n');
    expect(lines).toContain('rp-core: nothing to build yet: use --draft "text" to preview a reply to that text');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: 'refusal', code: 'nothing_to_swipe' });
  });
});
