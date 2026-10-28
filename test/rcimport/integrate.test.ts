// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The RoleCall story import end to end (.notes/rcimport-decisions.md D-185…D-194): `rp-core import
// <file.rolecall>` spawned as a user runs it, and the same path in process (cmdImport, planStoryImport,
// sessionJournal), on the synthetic export of kit.ts only. What lands: the library items (deduped,
// reused on a re-import), one session per chat (main by default; --chat all skips the exact copy,
// imports the detached run, makes the matching branch a fork), swipes as siblings with RoleCall's
// active one on the path, the reasoning split, the greeting, the head, the Director's records, the
// lorebooks attached, the Compendium's enable moment, and the size budget (1 200 messages).
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { directorAt } from '../../src/agents/director/state.ts';
import { CliError, cmdImport, type ImportArgs } from '../../src/cli/commands.ts';
import { StagedWrites } from '../../src/cli/import-story.ts';
import { UsageError } from '../../src/cli/args.ts';
import { memoryChannel } from '../../src/cli/io.ts';
import { loadRuntime, type Runtime } from '../../src/cli/runtime.ts';
import { Engine } from '../../src/engine/engine.ts';
import { enableMoment } from '../../src/engine/lane.ts';
import type { EngineHandle } from '../../src/engine/api.ts';
import { validateLoreBook, validatePreset, type LoreBook, type Preset } from '../../src/formats/native.ts';
import { planStoryImport, rcSessionId, sessionJournal, type StoryImportPlan } from '../../src/formats/rolecall-import.ts';
import { parseStory, type StoryBundle } from '../../src/formats/rolecall-story.ts';
import { readZip } from '../../src/formats/zip.ts';
import type { Entry, MsgEntry } from '../../src/session/entries.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { buildTree, pathTo, swipeSiblings } from '../../src/session/tree.ts';
import { run } from '../cli/kit.ts';
import { scriptConn } from '../engine/kit.ts';
import { tmpHome } from '../helpers.ts';
import { buildStory, writeZip, type StoryExport, type StoryExportOptions } from './kit.ts';

type Rec = Record<string, unknown>;

/** The export written to a file of its own (the home's parent folder holds it). */
function exportFile(opts: StoryExportOptions = {}, name = 'story.rolecall'): { file: string; story: StoryExport } {
  const story = buildStory(opts);
  const dir = tmpHome('rp-core-rc-file-');
  const file = join(dir, name);
  writeFileSync(file, story.bytes);
  return { file, story };
}

/** cmdImport in process, stdout and stderr kept; a CliError / UsageError becomes its exit code. */
async function imp(home: string, file: string, story: ImportArgs['story'] = {}, more: Partial<ImportArgs> = {}): Promise<{ code: number; out: string; err: string }> {
  const out = memoryChannel();
  const err = memoryChannel();
  try {
    const code = await cmdImport({ home, file, json: false, io: { out, err }, story, ...more });
    return { code, out: out.text(), err: err.text() };
  } catch (e) {
    if (e instanceof CliError) return { code: e.exitCode, out: out.text(), err: `${err.text()}${e.message}\n` };
    if (e instanceof UsageError) return { code: 64, out: out.text(), err: `${err.text()}${e.message}\n` };
    throw e;
  }
}

function bundleOf(story: StoryExport): StoryBundle {
  const r = parseStory(readZip(story.bytes).filter((m) => m.name !== 'story.jsonl').map((m) => ({ name: m.name, data: m.bytes })));
  if (!r.ok) throw new Error(r.why);
  return r.value;
}

const listDir = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);
const libraryFiles = (home: string, kind: string): string[] => listDir(join(home, 'library', kind));
const msgs = (entries: readonly Entry[]): MsgEntry[] => entries.filter((e): e is MsgEntry => e.t === 'msg');
const textOf = (m: { blocks?: { k: string; text?: string }[] }): string => (m.blocks ?? []).filter((b) => b.k === 'text').map((b) => b.text ?? '').join('');
const reasoningOf = (m: { blocks?: { k: string; text?: string }[] }): string => (m.blocks ?? []).filter((b) => b.k === 'reasoning').map((b) => b.text ?? '').join('');

/** The RoleCall message lines of a chat in the export. */
function rcLines(story: StoryExport, dir: string): Rec[] {
  const f = story.files.find((x) => x.name === `${dir}/messages.jsonl`)!;
  return f.data
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Rec);
}

async function engineFor(home: string): Promise<EngineHandle> {
  const { conn } = scriptConn('script', []);
  return Engine.open({ home, connections: { script: conn }, lane: 'manual', timeZone: 'UTC' });
}

describe('rp-core import <file.rolecall> (spawned)', () => {
  test('a dry run writes nothing; the import writes the library and the main session; a second import is refused; --new imports again', async () => {
    const { file, story } = exportFile();
    const home = join(tmpHome('rp-core-rc-'), 'home');

    const dry = await run(['import', file, '--dry-run', '--home', home]);
    expect(dry.code).toBe(0);
    expect(dry.stderr).toContain('dry run: nothing was written');
    expect(dry.stdout).toContain(`session   ${rcSessionId(story.facts.chats.main!.id)}`);
    expect(existsSync(home)).toBe(false);

    const r = await run(['import', file, '--home', home]);
    expect(r.code).toBe(0);
    const id = rcSessionId(story.facts.chats.main!.id);
    expect(r.stdout.split('\n').filter((l) => l.startsWith('session'))).toHaveLength(1);
    expect(r.stdout).toMatch(/^character +tavik-ashvale +new +"Tavik Ashvale"/m);
    expect(r.stderr).toContain(`rp-core chat ${id}`);
    expect(listDir(join(home, 'sessions'))).toEqual([`${id}.jsonl`]);

    const show = await run(['show', id, '--home', home]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('Harbor Nights');

    const again = await run(['import', file, '--home', home]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(`already imported as ${id}`);

    const fresh = await run(['import', file, '--new', '--home', home]);
    expect(fresh.code).toBe(0);
    expect(fresh.stdout).toMatch(/^character +tavik-ashvale +same/m);
    expect(fresh.stdout).not.toContain('-2 ');
    const sessions = listDir(join(home, 'sessions')).filter((f) => f.endsWith('.jsonl'));
    expect(sessions).toEqual([`${id}.jsonl`, `${rcSessionId(story.facts.chats.main!.id, 2)}.jsonl`].sort());
    expect(libraryFiles(home, 'lorebooks')).toHaveLength(3);
  });

  test("RoleCall's account backup and a bare story.jsonl are refused with a reason; story flags on a card are a usage error", async () => {
    const home = tmpHome('rp-core-rc-');
    const dir = tmpHome('rp-core-rc-file-');
    const backup = join(dir, 'account.rolecall');
    writeFileSync(backup, JSON.stringify({ format: 'rolecall-backup', version: 1, user: { user_id: 'u' } }));
    const b = await run(['import', backup, '--home', home]);
    expect(b.code).toBe(1);
    expect(b.stderr).toContain("RoleCall's account backup");
    const jsonl = join(dir, 'story.jsonl');
    writeFileSync(jsonl, `${JSON.stringify({ kind: 'manifest', format: 'rolecall-story', version: 1 })}\n{"kind":"chat"}\n`);
    const j = await run(['import', jsonl, '--home', home]);
    expect(j.code).toBe(1);
    expect(j.stderr).toContain('import the .rolecall export it came from');
    const card = join(dir, 'card.json');
    writeFileSync(card, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Vera', description: 'A sailor.', first_mes: 'Ahoy.' } }));
    const c = await run(['import', card, '--chat', 'all', '--home', home]);
    expect(c.code).toBe(64);
    expect(c.stderr).toContain('--chat: only for a RoleCall story export');
  });
});

describe('the import in process', () => {
  test('main only by default: one session, its header and config', async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    const r = await imp(home, file);
    expect(r.code).toBe(0);
    const id = rcSessionId(story.facts.chats.main!.id);
    const { header } = readSessionFile(home, id);
    expect(header.imported).toEqual({ from: 'rolecall', chat: story.facts.chats.main!.id, exportedAt: story.facts.exportedAt });
    expect(header.title).toBe('Harbor Nights');
    expect(header.config.compendium.enabled).toBe(false);
    expect(header.config.director).toMatchObject({ enabled: true, style: 'the-chronicler' });
    // The narrator follows config.toml (none here): RoleCall's model ids are not stored.
    expect(header.config.roles.narrator).toEqual({ conn: 'script', model: 'default' });
    expect(JSON.stringify(header.config)).not.toContain('rolecall:');
  });

  test('the persona and the preset land in the session; the copy carries the chat\'s own settings', async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    expect((await imp(home, file)).code).toBe(0);
    const { header } = readSessionFile(home, rcSessionId(story.facts.chats.main!.id));
    expect(header.cast.persona?.name).toBe(story.facts.persona.name);
    expect(header.cast.persona?.description).toContain('<');
    expect(header.cast.character.name).toBe(story.facts.character.name);
    expect(header.config.preset).toBe('quill-lantern-v2-1-harbor-nights');
    const copy = JSON.parse(readFileSync(join(home, 'library', 'presets', 'quill-lantern-v2-1-harbor-nights.json'), 'utf8')) as Preset;
    const plain = JSON.parse(readFileSync(join(home, 'library', 'presets', 'quill-lantern-v2-1.json'), 'utf8')) as Preset;
    expect(validatePreset(copy).ok).toBe(true);
    expect(copy.name).toBe('Quill & Lantern v2.1 (Harbor Nights)');
    // The main chat's toggles (facts.preset.mainOverrides) are applied to the copy only.
    for (const [ident, on] of Object.entries(story.facts.preset.mainOverrides)) {
      const block = copy.blocks.find((b) => b.id === ident);
      if (block) expect(block.enabled).toBe(on);
    }
    expect(plain.samplers).not.toEqual(copy.samplers);
    expect(libraryFiles(home, 'personas')).toEqual(['wren-calder.json']);
  });

  test('swipes are siblings in swipe order; the path follows RoleCall\'s active swipes; the first message is the greeting', async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    expect((await imp(home, file)).code).toBe(0);
    const f = story.facts;
    const { entries } = readSessionFile(home, rcSessionId(f.chats.main!.id));
    const tree = buildTree(entries);
    const path = pathTo(tree, tree.head);
    const lines = rcLines(story, f.chats.main!.dir);
    expect(path).toHaveLength(f.chats.main!.messages);
    const byId = new Map(msgs(entries).map((m) => [m.id, m]));
    path.forEach((id, i) => {
      const m = byId.get(id)!;
      const siblings = swipeSiblings(tree, id);
      expect(siblings).toHaveLength(f.chats.main!.swipeCounts[i]!);
      expect(siblings.indexOf(id)).toBe(f.chats.main!.active[i]!);
      expect(m.role).toBe(f.chats.main!.roles[i]!);
      // The visible text is RoleCall's content without its reasoning.
      if (!reasoningOf(m)) expect(textOf(m)).toBe(lines[i]!.content as string);
    });
    // The custom opener is the greeting, not the card's first message.
    const first = byId.get(path[0]!)!;
    expect(first.gen).toEqual({ kind: 'greeting' });
    expect(textOf(first)).not.toBe(f.character.firstMes);
    // An older swipe stays active: three versions, the first on the path.
    const two = path[f.features.activeNotLast]!;
    expect(swipeSiblings(tree, two).indexOf(two)).toBe(0);
    expect(swipeSiblings(tree, two)).toHaveLength(3);
  });

  test('inline reasoning is split as RoleCall strips it: an unclosed <think> and a closed one', async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    expect((await imp(home, file)).code).toBe(0);
    const f = story.facts;
    const { entries } = readSessionFile(home, rcSessionId(f.chats.main!.id));
    const tree = buildTree(entries);
    const path = pathTo(tree, tree.head);
    const byId = new Map(msgs(entries).map((m) => [m.id, m]));
    for (const i of [f.features.unclosedThink, f.features.closedThink]) {
      const m = byId.get(path[i]!)!;
      expect(reasoningOf(m)).not.toBe('');
      expect(textOf(m)).not.toContain('<think>');
      expect(textOf(m)).not.toContain('</think>');
      expect(textOf(m).trim()).not.toBe('');
    }
  });

  test("the head is the last message's active version; a head entry moves it when a later swipe was written last", () => {
    const story = buildStory({ messages: 22 });
    const bundle = bundleOf(story);
    const main = bundle.chats.find((c) => c.id === bundle.mainChatId)!;
    // Message 21 has two swipes, the last active; make the first one RoleCall's choice.
    const last = main.messages[main.messages.length - 1]!;
    const swipes = last.swipes as Rec[];
    expect(swipes).toHaveLength(2);
    last.content = swipes[0]!.content;
    const plan = planStoryImport(bundle);
    const s = plan.sessions[0]!;
    const j = sessionJournal(s, { id: s.id, now: '2026-10-28T00:00:00.000Z', lorebooks: [] });
    const kinds = j.entries.map((e) => e.t);
    expect(kinds.slice(-2)).toEqual(['head', 'config']);
    const entries = j.entries.map((e, i) => ({ ...e, seq: i + 1 })) as Entry[];
    const tree = buildTree(entries);
    expect(tree.head).toBe(s.head);
    expect(swipeSiblings(tree, s.head).indexOf(s.head)).toBe(0);
  });

  test("the Director's records sit on the head reply and the reply before it; directorAt at the head reads RoleCall's state", async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    expect((await imp(home, file)).code).toBe(0);
    const f = story.facts;
    const { entries } = readSessionFile(home, rcSessionId(f.chats.main!.id));
    const tree = buildTree(entries);
    const path = pathTo(tree, tree.head);
    const withDir = msgs(entries).filter((m) => m.dir !== undefined);
    expect(withDir.map((m) => m.id)).toEqual([path[9]!, path[11]!]);
    const at = directorAt(tree, tree.head);
    expect(at.from).toBe(path[11]);
    expect(at.record?.turn).toBe(f.chats.main!.users);
    expect(at.state.arcs.length).toBeGreaterThan(0);
    expect(at.state.chapters.length).toBeGreaterThan(0);
    // A replan of the head reply starts from the reply before it: the same state one turn earlier.
    const before = directorAt(tree, path[10]!);
    expect(before.from).toBe(path[9]);
    expect(before.record?.turn).toBe(f.chats.main!.users - 1);
    expect(before.record?.directive).toBeUndefined();
  });

  test('lorebooks: identical books once, attached in RoleCall\'s order; consumed rows disabled; [Arc] rows seed the Compendium', async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    expect((await imp(home, file)).code).toBe(0);
    const f = story.facts;
    expect(libraryFiles(home, 'lorebooks')).toEqual(['ashvale-saga-compendium.json', 'ashvale-saga.json', 'harbor-atlas.json']);
    const id = rcSessionId(f.chats.main!.id);
    const { header } = readSessionFile(home, id);
    expect(header.config.lorebooks).toEqual(['harbor-atlas', 'ashvale-saga', 'ashvale-saga-compendium']);
    const comp = JSON.parse(readFileSync(join(home, 'library', 'lorebooks', 'ashvale-saga-compendium.json'), 'utf8')) as LoreBook;
    expect(validateLoreBook(comp).ok).toBe(true);
    const consumed = comp.entries.filter((e) => f.compendium.consumedIds.includes(e.id));
    expect(consumed).toHaveLength(f.compendium.consumed);
    expect(consumed.every((e) => e.enabled === false)).toBe(true);

    // Untyped [Arc] rows are arcs (the typed plot one is a typed entry); the twin saga is read once.
    const arcRows = header.config.lorebooks.flatMap((b) => (JSON.parse(readFileSync(join(home, 'library', 'lorebooks', `${b}.json`), 'utf8')) as LoreBook).entries.filter((e) => e.meta?.arc !== undefined));
    expect(arcRows.length).toBe(f.saga.arcRows + f.compendium.arcRows - 1);
    const engine = await engineFor(home);
    try {
      const s = engine.session(id);
      const arcs = s.memoryList({ type: 'arc' });
      expect(arcs.length).toBe(arcRows.length);
      expect(arcs.every((a) => typeof a.origin === 'object')).toBe(true);
      expect(s.memoryList().some((r) => r.type !== 'arc' && r.type !== 'note')).toBe(true);
      await s.close();
    } finally {
      await engine.close();
    }
  });

  test('the Compendium is turned on after the imported past: the enable moment is the closing config entry and nothing is owed', async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    expect((await imp(home, file)).code).toBe(0);
    const id = rcSessionId(story.facts.chats.main!.id);
    const { header, entries } = readSessionFile(home, id);
    const last = entries[entries.length - 1]!;
    expect(last).toMatchObject({ t: 'config', patch: { compendium: { enabled: true } } });
    expect(enableMoment(header, entries, buildTree(entries))).toBe(last.seq);
    const engine = await engineFor(home);
    try {
      const s = engine.session(id);
      const status = s.memoryStatus();
      expect(status.queued).toEqual([]);
      expect(status.backlog).toBe(0);
      expect(status.parked).toEqual([]);
      expect(status.running).toBeUndefined();
      const view = s.view();
      expect(view.head).toBe(buildTree(entries).head);
      const p = s.preview();
      if (!p.ok) throw new Error(`${p.code}: ${p.message}`);
      // The head is an answer: the next turn would be a swipe of it.
      expect(p.kind).toBe('swipe');
      expect(p.messages.length).toBeGreaterThan(story.facts.chats.main!.messages);
      await s.close();
    } finally {
      await engine.close();
    }
    // --compendium off: no closing entry, the header keeps it off.
    const home2 = tmpHome('rp-core-rc-');
    expect((await imp(home2, file, { compendium: 'off' })).code).toBe(0);
    const off = readSessionFile(home2, id);
    expect(off.entries.some((e) => e.t === 'config')).toBe(false);
    expect(off.header.config.compendium.enabled).toBe(false);
    expect((await imp(home2, file, { compendium: 'maybe', fresh: true })).code).toBe(64);
  });

  test('--chat all: the exact copy is skipped, the detached run is its own session, the matching branch is a fork of main', async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    const r = await imp(home, file, { chat: 'all' });
    expect(r.code).toBe(0);
    const f = story.facts;
    expect(r.err).toContain(`skipped chat ${f.chats.duplicate!.id.slice(0, 8)}`);
    const ids = ['main', 'branch', 'detached'].map((k) => rcSessionId(f.chats[k as 'main']!.id));
    expect(listDir(join(home, 'sessions')).filter((x) => x.endsWith('.jsonl'))).toEqual(ids.map((i) => `${i}.jsonl`).sort());
    expect(existsSync(join(home, 'sessions', `${rcSessionId(f.chats.duplicate!.id)}.jsonl`))).toBe(false);

    const main = readSessionFile(home, ids[0]!);
    const branch = readSessionFile(home, ids[1]!);
    const detached = readSessionFile(home, ids[2]!);
    const mainPath = pathTo(buildTree(main.entries), buildTree(main.entries).head);
    const bpi = f.chats.branch!.branchPointIndex!;
    expect(branch.header.fork).toEqual({ from: ids[0]!, at: mainPath[bpi - 1]! });
    const branchPath = pathTo(buildTree(branch.entries), buildTree(branch.entries).head);
    expect(branchPath.slice(0, bpi)).toEqual(mainPath.slice(0, bpi));
    expect(branchPath).toHaveLength(f.chats.branch!.messages);
    expect(branch.header.title).toBe('Harbor Nights · Take 2');
    expect(branch.header.config.director.enabled).toBe(false);

    expect(detached.header.fork).toBeUndefined();
    const dPath = pathTo(buildTree(detached.entries), buildTree(detached.entries).head);
    expect(dPath).toHaveLength(f.chats.detached!.messages);
    const dFirst = msgs(detached.entries).find((m) => m.id === dPath[0])!;
    expect(textOf(dFirst)).toBe(f.character.firstMes);
    // Each chat with its own settings gets its own preset copy.
    expect(new Set([main, branch, detached].map((s) => s.header.config.preset)).size).toBe(3);
  });

  test('--chat <prefix> picks a chat; an unknown or ambiguous prefix is refused', async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    const det = story.facts.chats.detached!.id;
    expect((await imp(home, file, { chat: det.slice(0, 6) })).code).toBe(0);
    expect(listDir(join(home, 'sessions')).filter((x) => x.endsWith('.jsonl'))).toEqual([`${rcSessionId(det)}.jsonl`]);
    const none = await imp(home, file, { chat: 'zzzz' });
    expect(none.code).toBe(1);
    expect(none.err).toContain('no chat of the export');
    // Two chats whose ids share a prefix: the prefix alone is refused.
    const bundle = bundleOf(story);
    const main = story.facts.chats.main!.id;
    bundle.chats.find((c) => c.id === det)!.id = `${main.slice(0, 8)}-0000-4000-8000-000000000000`;
    expect(() => planStoryImport(bundle, { chat: main.slice(0, 8) })).toThrow(/give more of it/);
  });

  test('a re-import reuses equal library items; an equal book from another export of the same story is reused, not -2', async () => {
    const one = exportFile();
    const two = exportFile({ seed: 'kit-again' });
    const home = tmpHome('rp-core-rc-');
    expect((await imp(home, one.file)).code).toBe(0);
    const before = ['characters', 'personas', 'presets', 'lorebooks'].map((k) => libraryFiles(home, k));
    const r = await imp(home, two.file);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^lorebook +harbor-atlas +(same|reused)/m);
    expect(r.out).toMatch(/^lorebook +ashvale-saga-compendium +(same|reused)/m);
    expect(libraryFiles(home, 'lorebooks')).toEqual(before[3]!);
    expect(libraryFiles(home, 'lorebooks').some((x) => /-2\.json$/.test(x))).toBe(false);
    // The second story's session uses the reused books.
    const { header } = readSessionFile(home, rcSessionId(two.story.facts.chats.main!.id));
    expect(header.config.lorebooks).toEqual(['harbor-atlas', 'ashvale-saga', 'ashvale-saga-compendium']);
  });

  test('--as names the story; --keep-raw copies the raw RoleCall files; --model needs a configured connection', async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    writeFileSync(join(home, 'config.toml'), '[connections.local]\nbase_url = "http://127.0.0.1:8080"\n');
    const bad = await imp(home, file, { model: 'nowhere:m' }, { rt: () => loadRt(home) });
    expect(bad.code).toBe(64);
    expect(bad.err).toContain('no connection "nowhere"');
    const r = await imp(home, file, { model: 'local:m1', keepRaw: true }, { as: 'Saltmark', rt: () => loadRt(home) });
    expect(r.code).toBe(0);
    const id = rcSessionId(story.facts.chats.main!.id);
    const { header } = readSessionFile(home, id);
    expect(header.title).toBe('Saltmark');
    expect(header.config.roles.narrator).toEqual({ conn: 'local', model: 'm1' });
    expect(header.config.preset).toBe('quill-lantern-v2-1-saltmark');
    expect(listDir(join(home, 'imports', id))).toEqual(['dm-context.json', 'storyboard.json', 'tracker.json']);
  });

  test('--json prints the plan as one object; a ZIP that is not a story export is refused by the generic import', async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    const r = await imp(home, file, { dryRun: true }, { json: true });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { dryRun: boolean; library: { kind: string; state: string }[]; sessions: { id: string; messages: number; director: { turn?: number } }[]; warnings: { code: string; count: number }[] };
    expect(j.dryRun).toBe(true);
    expect(j.library.map((i) => i.kind)).toEqual(['character', 'persona', 'preset', 'preset', 'lorebook', 'lorebook', 'lorebook']);
    expect(j.sessions).toHaveLength(1);
    expect(j.sessions[0]).toMatchObject({ id: rcSessionId(story.facts.chats.main!.id), messages: story.facts.chats.main!.messages, director: { turn: story.facts.chats.main!.users } });
    expect(j.warnings.every((w) => w.count >= 1)).toBe(true);
    expect(existsSync(join(home, 'library'))).toBe(false);

    const zipFile = join(tmpHome('rp-core-rc-file-'), 'other.zip');
    writeFileSync(zipFile, writeZip([{ name: 'readme.txt', data: 'hello' }]));
    const z = await imp(home, zipFile);
    expect(z.code).toBe(1);
    expect(z.err).toContain('the only archive rp-core imports is a RoleCall story export');
    // A zip with a manifest of another format reaches the story importer, which names the format.
    const other = join(tmpHome('rp-core-rc-file-'), 'other.rolecall');
    writeFileSync(other, writeZip([{ name: 'manifest.json', data: JSON.stringify({ format: 'rolecall-story-package-staged' }) }]));
    expect((await imp(home, other)).err).toContain('rolecall-story-package-staged');
  });

  test('the warnings are grouped once each; the plan names what is not carried', () => {
    const { story } = exportFile();
    const plan: StoryImportPlan = planStoryImport(bundleOf(story), { chat: 'all' });
    const codes = new Set(plan.warnings.map((w) => w.code));
    for (const c of ['rc_tracker', 'rc_storyboard', 'rc_chat_summary', 'rc_modules', 'rc_hidden_unavailable', 'rc_book_duplicate', 'rc_book_consumed', 'rc_preset_missing']) expect(codes).toContain(c);
    expect(plan.warnings.filter((w) => w.code === 'rc_tracker')).toHaveLength(1);
    expect(plan.skipped).toEqual([{ chatId: story.facts.chats.duplicate!.id, why: `its messages equal chat ${story.facts.chats.branch!.id.slice(0, 8)}'s` }]);
  });
});

describe('size (D-193)', () => {
  test('a 1 200-message export imports in ≤ 3 s and opens in ≤ 500 ms', async () => {
    const { file, story } = exportFile({ messages: 1200 });
    const home = tmpHome('rp-core-rc-');
    const t0 = performance.now();
    const r = await imp(home, file);
    const importMs = performance.now() - t0;
    expect(r.code).toBe(0);
    expect(importMs).toBeLessThanOrEqual(3000);
    const id = rcSessionId(story.facts.chats.main!.id);
    const engine = await engineFor(home);
    try {
      const t1 = performance.now();
      const s = engine.session(id);
      const view = s.view();
      const status = s.memoryStatus();
      const openMs = performance.now() - t1;
      expect(view.path).toHaveLength(1200);
      expect(status.backlog).toBe(0);
      expect(openMs).toBeLessThanOrEqual(500);
      await s.close();
    } finally {
      await engine.close();
    }
  });
});

/** The export with its members edited, written to a file of its own. */
function rezipped(story: StoryExport, edit: (files: { name: string; data: string }[]) => { name: string; data: string }[], name = 'story.rolecall'): string {
  const file = join(tmpHome('rp-core-rc-file-'), name);
  writeFileSync(file, writeZip(edit(story.files.map((f) => ({ ...f })))));
  return file;
}

/** config.toml with one connection whose model has this window; nothing listens on its port. */
function tinyConfig(home: string, window: number): void {
  writeFileSync(join(home, 'config.toml'), `[connections.local]\nbase_url = "http://127.0.0.1:9"\n\n[roles]\nnarrator = "local:m1"\n\n[caps."local:m1"]\ncontext_length = ${window}\n`);
}

type JsonWarning = { code: string; message: string; count: number; paths: string[]; subjects?: string[] };

describe('the review fixes (robust#1, #6; ux#3…#8; D-195; fidelity#4)', () => {
  test('robust#1: the writes are all or nothing: a --keep-raw copy that cannot be written leaves nothing behind, and a plain retry imports every chat', async () => {
    const { file } = exportFile();
    const home = tmpHome('rp-core-rc-');
    writeFileSync(join(home, 'imports'), 'a file where the folder goes');
    const r = await imp(home, file, { chat: 'all', keepRaw: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain('import failed: cannot write');
    expect(r.err).toContain('nothing was imported');
    // No session, no library item, no temp file, no folder the run made.
    expect(listDir(home)).toEqual(['imports']);
    const again = await imp(home, file, { chat: 'all' });
    expect(again.code).toBe(0);
    expect(listDir(join(home, 'sessions')).filter((f) => f.endsWith('.jsonl'))).toHaveLength(3);
  });

  test('robust#1: a place taken before the end undoes what was published, keeps what was there, and leaves no temp file', () => {
    const root = tmpHome('rp-core-rc-staged-');
    const before = join(root, 'lib', 'kept.json');
    mkdirSync(join(root, 'lib'));
    writeFileSync(before, 'old');
    const mtime = statSync(before).mtimeMs;
    const w = new StagedWrites();
    w.file(join(root, 'lib', 'a.json'), 'A');
    w.file(join(root, 'new', 'deep', 'b.jsonl'), 'B');
    w.folder(join(root, 'raw', 's_1'), [{ name: 'x.json', data: new TextEncoder().encode('{}') }]);
    w.file(join(root, 'lib', 'kept.json'), 'C');
    expect(listDir(join(root, 'lib')).filter((f) => !f.startsWith('.'))).toEqual(['kept.json']);
    expect(() => w.publish()).toThrow(/kept\.json appeared while importing/);
    w.discard();
    expect(listDir(root)).toEqual(['lib']);
    expect(listDir(join(root, 'lib'))).toEqual(['kept.json']);
    expect(readFileSync(before, 'utf8')).toBe('old');
    expect(statSync(before).mtimeMs).toBe(mtime);
  });

  test('robust#1: a failed import never touches the library items it would reuse', async () => {
    const one = exportFile();
    const home = tmpHome('rp-core-rc-');
    expect((await imp(home, one.file)).code).toBe(0);
    const lib = ['characters', 'personas', 'presets', 'lorebooks'].flatMap((k) => libraryFiles(home, k).map((f) => join(home, 'library', k, f)));
    const stamp = (): string[] => lib.map((f) => `${f} ${statSync(f).mtimeMs} ${readFileSync(f, 'utf8').length}`);
    const was = stamp();
    const two = exportFile({ seed: 'kit-again' });
    writeFileSync(join(home, 'imports'), 'in the way');
    const r = await imp(home, two.file, { keepRaw: true });
    expect(r.code).toBe(1);
    expect(stamp()).toEqual(was);
    expect(['characters', 'personas', 'presets', 'lorebooks'].flatMap((k) => libraryFiles(home, k).map((f) => join(home, 'library', k, f)))).toEqual(lib);
    expect(listDir(join(home, 'sessions')).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
  });

  test("robust#6: a refusal keeps the parser's reasons: unreadable chats, a chat without messages, an unreadable card", async () => {
    const { story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    const noChat = rezipped(story, (fs) => fs.map((f) => (f.name.endsWith('/chat.json') ? { ...f, data: '{"id": ' } : f)));
    const a = await imp(home, noChat);
    expect(a.code).toBe(1);
    expect(a.err).toContain('the export holds no chat');
    expect(a.err).toMatch(/chat\.json: not valid JSON \(/);
    const main = story.facts.chats.main!;
    const noLines = rezipped(story, (fs) => fs.filter((f) => f.name !== `${main.dir}/messages.jsonl`));
    const b = await imp(home, noLines);
    expect(b.code).toBe(1);
    expect(b.err).toContain(`chat ${main.id.slice(0, 8)}: it has no message`);
    expect(b.err).toContain(`${main.dir}/messages.jsonl: the chat has no messages.jsonl`);
    const badCard = rezipped(story, (fs) => fs.map((f) => (f.name === story.facts.character.card ? { ...f, data: '{"spec": "chara_card_v3", "data": 7}' } : f)));
    const c = await imp(home, badCard);
    expect(c.code).toBe(1);
    expect(c.err).toContain(`the character card ${story.facts.character.card} cannot be read (the character card could not be read: `);
    expect(listDir(home)).toEqual([]);
  });

  test('ux#3: warnings name the session or library item they are about, in text and in --json', async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    const f = story.facts;
    const main = rcSessionId(f.chats.main!.id);
    const branch = rcSessionId(f.chats.branch!.id);
    const detached = rcSessionId(f.chats.detached!.id);
    const j = await imp(home, file, { chat: 'all', dryRun: true }, { json: true });
    expect(j.code).toBe(0);
    const ws = (JSON.parse(j.out) as { warnings: JsonWarning[] }).warnings;
    const own = ws.filter((w) => w.code === 'rc_preset_overrides' && w.message.startsWith("the chat's own settings"));
    expect(own.map((w) => w.subjects)).toEqual([[main], [branch], [detached]]);
    const gen = ws.find((w) => w.code === 'not_honoured' && w.message.startsWith("the chat's generation settings"))!;
    expect(gen.subjects).toEqual([main, branch, detached]);
    expect(ws.find((w) => w.code === 'rc_book_consumed')!.subjects).toEqual(['lorebook ashvale-saga-compendium']);
    expect(ws.find((w) => w.code === 'rc_book_duplicate')!.subjects).toEqual(['lorebook ashvale-saga']);
    expect(ws.filter((w) => w.code.startsWith('rc_director') || w.message.includes('(D-61)')).every((w) => w.subjects?.length === 1 && w.subjects[0] !== branch)).toBe(true);
    expect(ws.every((w) => w.paths.length >= 1)).toBe(true);
    const t = await imp(home, file, { chat: 'all', dryRun: true });
    expect(t.err).toContain(`warning: ${branch}: the chat's own settings are applied`);
    expect(t.err).toContain(`warning: ${main}, ${branch}, ${detached}: the chat's generation settings`);
    expect(t.err).not.toMatch(/the chat's generation settings[^\n]*\(×/);
  });

  test('ux#4: session lines show the chat id; --chat takes MAIN and main among prefixes; refusals list the chats', async () => {
    const { file, story } = exportFile();
    const f = story.facts;
    const home = tmpHome('rp-core-rc-');
    const all = await imp(home, file, { chat: 'all', dryRun: true });
    expect(all.out).toContain(`chat ${f.chats.main!.id.slice(0, 8)} · ${f.chats.main!.messages} messages`);
    expect(all.out).toContain(`chat ${f.chats.detached!.id.slice(0, 8)} · ${f.chats.detached!.messages} messages`);
    expect(all.err).toContain(`skipped chat ${f.chats.duplicate!.id.slice(0, 8)} "Take 2": its messages equal`);
    expect((await imp(home, file, { chat: 'MAIN', dryRun: true })).out).toContain(`session   ${rcSessionId(f.chats.main!.id)}`);
    const two = await imp(home, file, { chat: `main,${f.chats.detached!.id.slice(0, 6).toUpperCase()}`, dryRun: true });
    expect(two.code).toBe(0);
    expect(two.out.split('\n').filter((l) => l.startsWith('session'))).toHaveLength(2);
    const mixed = await imp(home, file, { chat: 'All,main' });
    expect(mixed.code).toBe(1);
    expect(mixed.err).toContain('--chat all already takes every chat; give it alone');
    const none = await imp(home, file, { chat: 'zzzz' });
    expect(none.err).toContain(`${f.chats.main!.id.slice(0, 8)} "Harbor Nights" (${f.chats.main!.messages} messages)`);
    // Two chats whose ids share a prefix: both are listed with their titles.
    const main8 = f.chats.main!.id.slice(0, 8);
    const amb = rezipped(story, (fs) =>
      fs.map((x) => (x.name === `${f.chats.detached!.dir}/chat.json` ? { ...x, data: x.data.replace(f.chats.detached!.id, `${main8}-0000-4000-8000-000000000000`) } : x)),
    );
    const r = await imp(home, amb, { chat: main8.slice(0, 4) });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`--chat ${main8.slice(0, 4)}: 2 chats have an id starting so: ${main8} "Harbor Nights" (${f.chats.main!.messages} messages), ${main8} (${f.chats.detached!.messages} messages); give more of it`);
  });

  test('ux#5: after the main chat, --chat all imports the rest (main skipped with a line) and links the branch to the main session', async () => {
    const { file, story } = exportFile();
    const f = story.facts;
    const home = tmpHome('rp-core-rc-');
    const main = rcSessionId(f.chats.main!.id);
    expect((await imp(home, file)).code).toBe(0);
    const refused = await imp(home, file);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`already imported as ${main}`);
    expect(refused.err).toContain('--chat all imports the chats not imported yet');
    const r = await imp(home, file, { chat: 'all' });
    expect(r.code).toBe(0);
    expect(r.err).toContain(`skipped chat ${f.chats.main!.id.slice(0, 8)} "Harbor Nights": already imported as ${main}`);
    expect(r.out).not.toContain(`session   ${main}`);
    expect(listDir(join(home, 'sessions')).filter((x) => x.endsWith('.jsonl'))).toHaveLength(3);
    const mainJ = readSessionFile(home, main);
    const mainPath = pathTo(buildTree(mainJ.entries), buildTree(mainJ.entries).head);
    const branch = readSessionFile(home, rcSessionId(f.chats.branch!.id));
    expect(branch.header.fork).toEqual({ from: main, at: mainPath[f.chats.branch!.branchPointIndex! - 1]! });
    expect(r.out).toContain(`fork of ${main}`);
    // Everything imported: --chat all is refused as a whole, without the --chat all hint.
    const done = await imp(home, file, { chat: 'all' });
    expect(done.code).toBe(1);
    expect(done.err).toContain('already imported as');
    expect(done.err).not.toContain('--chat all imports');
    // The branch alone, after main: its fork is linked too.
    const home2 = tmpHome('rp-core-rc-');
    expect((await imp(home2, file)).code).toBe(0);
    expect((await imp(home2, file, { chat: f.chats.branch!.id.slice(0, 6) })).code).toBe(0);
    expect(readSessionFile(home2, rcSessionId(f.chats.branch!.id)).header.fork?.from).toBe(main);
  });

  test('ux#6: a path that cannot be read says so, story flags or not', async () => {
    const home = tmpHome('rp-core-rc-');
    const missing = join(tmpHome('rp-core-rc-file-'), 'typo.rolecall');
    const r = await imp(home, missing, { chat: 'all', dryRun: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`import failed: cannot read ${missing}`);
    expect(r.err).not.toContain('only for a RoleCall story export');
  });

  test('ux#7: a ZIP without a manifest at its top is refused in plain words', async () => {
    const home = tmpHome('rp-core-rc-');
    const { story } = exportFile();
    const flat = rezipped(story, (fs) => fs.filter((x) => x.name !== 'manifest.json'), 'broken.rolecall');
    const a = await imp(home, flat, { chat: 'all' });
    expect(a.code).toBe(1);
    expect(a.err).toContain('broken.rolecall: a ZIP archive with no manifest.json at its top');
    expect(a.err).not.toContain('with `rp-core import');
    const nested = rezipped(story, (fs) => fs.map((x) => ({ ...x, name: `story/${x.name}` })), 'repacked.rolecall');
    expect((await imp(home, nested)).err).toContain('(one is inside story/: the archive was repacked)');
  });

  test('ux#8: --keep-raw says what it kept and where; the not-carried lines point there', async () => {
    const { file, story } = exportFile();
    const home = tmpHome('rp-core-rc-');
    const id = rcSessionId(story.facts.chats.main!.id);
    const r = await imp(home, file, { keepRaw: true });
    expect(r.code).toBe(0);
    expect(r.err).toContain(`kept tracker.json, storyboard.json, dm-context.json of ${id} in ${join(home, 'imports', id)}`);
    expect(r.err).not.toContain('--keep-raw keeps a copy');
    expect(r.err).toContain(`(a copy is in ${join(home, 'imports')}/)`);
    const j = await imp(home, file, { keepRaw: true, fresh: true, dryRun: true }, { json: true });
    const kept = (JSON.parse(j.out) as { kept: { session: string; dir: string; files: string[] }[] }).kept;
    expect(kept).toEqual([{ session: rcSessionId(story.facts.chats.main!.id, 2), dir: join(home, 'imports', rcSessionId(story.facts.chats.main!.id, 2)), files: ['tracker.json', 'storyboard.json', 'dm-context.json'] }]);
  });

  test('D-195: an imported story whose next request cannot fit the narrator gets a warning with the numbers; one that fits gets none', async () => {
    const { file, story } = exportFile();
    const id = rcSessionId(story.facts.chats.main!.id);
    const small = tmpHome('rp-core-rc-');
    tinyConfig(small, 1024);
    const r = await imp(small, file, {}, { rt: () => loadRt(small) });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(new RegExp(`warning: ${id}: the story does not fit its narrator local:m1: its next request needs about \\d+ tokens, but only 512 are available \\(window 1024 - reply reserve 512\\)`));
    expect(r.err).toContain('/model in the chat, --model when importing');
    expect(r.err).toContain('/preset builtin');
    // The check wrote nothing: the journal is what the import planned, and no lock is left.
    expect(listDir(join(small, 'sessions'))).toEqual([`${id}.jsonl`]);
    const j = await imp(small, file, { fresh: true }, { json: true, rt: () => loadRt(small) });
    expect((JSON.parse(j.out) as { warnings: JsonWarning[] }).warnings.find((w) => w.code === 'context_length_exceeded')?.subjects).toEqual([rcSessionId(story.facts.chats.main!.id, 2)]);
    const big = tmpHome('rp-core-rc-');
    tinyConfig(big, 200_000);
    const ok = await imp(big, file, {}, { rt: () => loadRt(big) });
    expect(ok.code).toBe(0);
    expect(ok.err).not.toContain('does not fit');
    expect(ok.err).not.toContain('could not be checked');
  });

  test("fidelity#4: one line says where the Compendium starts and which turns RoleCall's summaries leave out", async () => {
    const { file, story } = exportFile();
    const f = story.facts;
    const id = rcSessionId(f.chats.main!.id);
    const home = tmpHome('rp-core-rc-');
    const plain = await imp(home, file, { dryRun: true });
    expect(plain.err).toContain(`warning: ${id}: the Compendium starts after the imported ${f.chats.main!.users} turns: it files and summarises new turns only`);
    expect((await imp(home, file, { dryRun: true, compendium: 'off' })).err).not.toContain('the Compendium starts');
    // A RoleCall summary row of the main chat up to turn 3.
    const atlas = f.books.world!.path;
    const summed = rezipped(story, (fs) =>
      fs.map((x) => {
        if (x.name !== atlas) return x;
        const book = JSON.parse(x.data) as { entries: Rec[] };
        const row = { ...book.entries[0]!, id: '0b5e6d1c-5a4e-4f7a-9c2d-3e1f00000001', title: 'Summary of the opening', content: 'The first turns, told short.', triggers: [], metadata: { chatId: f.chats.main!.id, source: 'tv_summary', turnNumber: 3 } };
        return { ...x, data: JSON.stringify({ ...book, entries: [...book.entries, row] }) };
      }),
    );
    const r = await imp(home, summed, { dryRun: true });
    expect(r.err).toContain(`RoleCall's summaries in the lorebooks reach turn 3, so turns 4–${f.chats.main!.users} are summarised nowhere`);
  });
});

function loadRt(home: string): Runtime {
  return loadRuntime(home, {});
}
