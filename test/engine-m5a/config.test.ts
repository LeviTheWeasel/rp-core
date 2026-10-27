// M5a D-158: [compendium] in config.toml maps snake_case to CompendiumConfig with range checks (the
// error names the dotted path); new sessions default to the Compendium on, stored headers keep what they
// hold, and configure refuses what the engine could not read.
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCompendium } from '../../src/agents/compendium/profile.ts';
import { ConfigError, parseConfig } from '../../src/config/config.ts';
import { DEFAULT_SESSION_CONFIG } from '../../src/session/entries.ts';
import { sessionsDir } from '../../src/session/log.ts';
import { traceOf } from '../engine-m3/kit.ts';
import { bookSession, calls, fullCaps, LANTERN, LEVI, MIRA, ok, putBook, refusalOf, rig, turnOf } from './kit.ts';

function errorOf(text: string): ConfigError {
  try {
    parseConfig(text, null);
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('expected a ConfigError');
}

describe('[compendium] (D-158)', () => {
  test('every table maps to camelCase; books map ids to read / off', () => {
    const cfg = parseConfig(
      [
        '[compendium]',
        'enabled = false',
        'profile = "lite"',
        'min_share = 0.25',
        'idle_delay_sec = 0',
        '[compendium.recall]',
        'mode = "lexical"',
        'max_entries = 12',
        'context_messages = 40',
        'timeout_sec = 25',
        '[compendium.filing]',
        'allow = ["character", "summary"]',
        'timeout_sec = 0',
        '[compendium.historian]',
        'interval = 0',
        '[compendium.books]',
        'lantern = "off"',
        '"old-tales" = "read"',
      ].join('\n'),
      null,
    );
    expect(cfg.sessionDefaults.compendium).toEqual({
      enabled: false,
      profile: 'lite',
      minShare: 0.25,
      idleDelaySec: 0,
      recall: { mode: 'lexical', maxEntries: 12, contextMessages: 40, timeoutSec: 25 },
      filing: { allow: ['character', 'summary'], timeoutSec: 0 },
      historian: { interval: 0 },
      books: { lantern: 'off', 'old-tales': 'read' },
    });
  });

  test('out of range, wrong kinds and unknown fields name the dotted path', () => {
    const cases: [string, string][] = [
      ['[compendium]\nmin_share = 1.5\n', 'compendium.min_share'],
      ['[compendium]\nprofile = "max"\n', 'compendium.profile'],
      ['[compendium]\nidle_delay_sec = 61\n', 'compendium.idle_delay_sec'],
      [`[compendium]\nlanguage = "${'я'.repeat(81)}"\n`, 'compendium.language'],
      ['[compendium]\nmax_attempts = 0\n', 'compendium.max_attempts'],
      ['[compendium]\nshare = 0.4\n', 'compendium.share'],
      ['[compendium.recall]\nmax_entries = 31\n', 'compendium.recall.max_entries'],
      ['[compendium.recall]\ncontext_messages = 3\n', 'compendium.recall.context_messages'],
      ['[compendium.recall]\non_swipe = "replan"\n', 'compendium.recall.on_swipe'],
      ['[compendium.recall]\nmin_entries = 21\n', 'compendium.recall.min_entries'],
      ['[compendium.filing]\nallow = ["npc"]\n', 'compendium.filing.allow'],
      ['[compendium.filing]\nevery_n = 0\n', 'compendium.filing.every_n'],
      ['[compendium.historian]\ninterval = 101\n', 'compendium.historian.interval'],
      ['[compendium.books]\nlantern = "maybe"\n', 'compendium.books.lantern'],
      ['[compendium]\nrecall = 3\n', 'compendium.recall'],
    ];
    for (const [text, path] of cases) expect([text, errorOf(text).path]).toEqual([text, path]);
  });

  test('new sessions: the Compendium on; a stored header keeps what it holds; configure checks it', async () => {
    expect(DEFAULT_SESSION_CONFIG.compendium).toEqual({ enabled: true });
    const r = await rig(calls());
    const fresh = r.engine.createSession({ character: MIRA, persona: LEVI });
    expect(fresh.header().config.compendium).toEqual({ enabled: true });
    const old = r.engine.createSession({ character: MIRA, persona: LEVI, config: { compendium: { enabled: false } } });
    const id = old.id;
    await old.close();
    const again = r.engine.session(id);
    expect(again.header().config.compendium).toEqual({ enabled: false });

    expect(refusalOf(() => fresh.configure({ compendium: { profile: 'max' as 'lite' } })).code).toBe('invalid_params');
    expect(refusalOf(() => fresh.configure({ compendium: { books: { lantern: 'maybe' as 'off' } } })).code).toBe('invalid_params');
    expect(refusalOf(() => fresh.configure({ compendium: { minShare: '0.4' as unknown as number } })).code).toBe('invalid_params');
    fresh.configure({ compendium: { profile: 'lite', books: { lantern: 'off' } } });
    await r.engine.close();
  });
});

describe('old headers and the on/off switch (review engine#3, engine#4; the lead\'s rulings)', () => {
  /** Replace the stored header's compendium table (what an M4 build wrote from config.toml). */
  function storeCompendium(home: string, id: string, compendium: unknown): void {
    const file = join(sessionsDir(home), `${id}.jsonl`);
    const lines = readFileSync(file, 'utf8').split('\n');
    const head = JSON.parse(lines[0]!) as { config: Record<string, unknown> };
    head.config.compendium = compendium;
    lines[0] = JSON.stringify(head);
    writeFileSync(file, lines.join('\n'));
  }

  test('a header holding M4-era values opens; bad values read as defaults, snake_case names are read', async () => {
    const r = await rig(calls(), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s0 = bookSession(r.engine, [id], { text: null });
    const sid = s0.id;
    await s0.close();
    storeCompendium(r.home, sid, {
      enabled: true,
      profile: 'Lite',
      min_share: 0.1,
      max_attempts: 5,
      idle_delay_sec: 99,
      books: { [id]: 'readonly' },
      recall: { on_miss: 'lexical', max_entries: 12, grace_sec: 2 },
      filing: { every_n: 2, timeout_sec: 60 },
      historian: { recap_after: 30 },
    });
    const s = r.engine.session(sid);
    const cfg = resolveCompendium(s.header().config.compendium);
    expect(cfg).toMatchObject({ enabled: true, profile: 'auto', minShare: 0.1, maxAttempts: 5, idleDelaySec: 8, books: {} });
    expect(cfg.recall).toMatchObject({ onMiss: 'lexical', maxEntries: 12, graceSec: 2 });
    expect(cfg.filing).toMatchObject({ everyN: 2, timeoutSec: 60 });
    expect(cfg.historian.recapAfter).toBe(30);
    // The book is read ('readonly' is no access the engine knows: the default 'read').
    expect(s.memoryList().map((x) => x.key)).toEqual([`lib:${id}:e1`, `lib:${id}:e2`]);
    // configure still works on top of it: only what the patch writes is checked.
    s.configure({ compendium: { enabled: false } });
    expect(s.memoryList()).toEqual([]);
    await r.engine.close();
  });

  test('a camelCase value wins over its snake_case name; out of range reads as the default', () => {
    expect(resolveCompendium({ enabled: true, minShare: 0.3, min_share: 0.9 }).minShare).toBe(0.3);
    expect(resolveCompendium({ enabled: true, maxAttempts: 11 }).maxAttempts).toBe(3);
    expect(resolveCompendium({ enabled: true, recall: { maxEntries: 31, minEntries: 2.5 } }).recall).toMatchObject({ minEntries: 0 });
    expect('maxEntries' in resolveCompendium({ enabled: true, recall: { maxEntries: 31 } }).recall).toBe(false);
    expect(resolveCompendium({ enabled: true, historian: { interval: -1 } }).historian.interval).toBe(20);
  });

  test('configure checks the compendium fields it writes with config.toml\'s ranges, in camelCase', async () => {
    const r = await rig(calls());
    const s = r.engine.createSession({ character: MIRA, persona: LEVI });
    const refused = (patch: unknown): string => refusalOf(() => s.configure({ compendium: patch } as never)).message;
    expect(refused({ minShare: 1.5 })).toBe('invalid config: compendium.minShare: must be a number from 0 to 1');
    expect(refused({ min_share: 0.2 })).toContain("compendium.min_share: unknown field (a session's config names it in camelCase)");
    expect(refused({ recall: { maxEntries: 31 } })).toContain('compendium.recall.maxEntries: must be 0 (by profile) or a whole number from 1 to 30');
    expect(refused({ filing: { allow: ['npc'] } })).toContain('compendium.filing.allow');
    expect(refused({ books: { lantern: 'maybe' } })).toContain('compendium.books.lantern: must be "read" or "off"');
    expect(refused({ share: 0.4 })).toContain('compendium.share');
    expect(refused({ enabled: null })).toContain('compendium.enabled: missing');
    s.configure({ compendium: { recall: { maxEntries: 0, onMiss: 'sync' }, historian: { recapAfter: 40 } } });
    s.configure({ compendium: { books: { lantern: 'off' } } });
    s.configure({ compendium: { books: { lantern: null } } } as never);
    expect(s.header().config.compendium).toEqual({ enabled: true });
    await r.engine.close();
  });

  test('configure({compendium: {enabled}}) switches the Compendium at once: list, preview block, the next turn', async () => {
    const r = await rig(calls([{ text: 'Мира кивает.' }], [{ text: 'Мира молчит.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    // A session made before M5a stored enabled:false.
    const s = bookSession(r.engine, [id], { config: { compendium: { enabled: false } } });
    expect(s.memoryList()).toEqual([]);
    const block = (p: ReturnType<typeof s.preview>): boolean => JSON.stringify(ok(p).messages).includes('[Retrieved World Knowledge]');
    expect(block(s.preview())).toBe(false);

    s.configure({ compendium: { enabled: true } });
    expect(s.memoryList().map((x) => x.key)).toEqual([`lib:${id}:e1`, `lib:${id}:e2`]);
    expect(block(s.preview())).toBe(true);
    const on = await turnOf(s);
    if (on.out.type !== 'done') throw new Error(on.out.type);
    expect(s.view().path.at(-1)!.id).toBe(on.out.message.id);
    expect(traceOf(r.home, s.id, on.out.message.id)?.compendium?.picks.map((p) => p.key)).toContain(`lib:${id}:e1`);

    s.configure({ compendium: { enabled: false } });
    expect(s.memoryList()).toEqual([]);
    const off = await turnOf(s, 'swipe');
    if (off.out.type !== 'done') throw new Error(off.out.type);
    expect(traceOf(r.home, s.id, off.out.message.id)?.compendium).toBeUndefined();
    await r.engine.close();
  });
});
