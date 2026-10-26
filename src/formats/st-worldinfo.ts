// Ported from Bunraku:src/formats/_shared/character-book-decode.ts@702d8120,
// Bunraku:src/formats/_shared/lore-enums.ts@702d8120, Bunraku:src/formats/sillytavern/lorebook.ts@702d8120
// and SillyBunny:public/scripts/world-info.js@3021edcae (parseDecorators, KNOWN_DECORATORS).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend; parseDecorators and KNOWN_DECORATORS Copyright (C)
// the SillyTavern contributors; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SillyTavern world info and card character_book → core.lorebook/1 (ARCHITECTURE.md §10.5, §19.8).
// ONE stPosition() with the real ST enum (world-info.js 880-889): 0 before, 1 after, 2 note_before
// (AN top), 3 note_after (AN bottom), 4 at depth, 5 examples_before, 6 examples_after, 7 outlet.
// RoleCall and Bunraku both map 2/3 to examples: do not port that bug.
//
// Behaviour reference (facts, not code): SillyBunny public/scripts/world-info.js convertCharacterBook,
// newWorldInfoEntryDefinition and world-info-character-book.js normalizeWorldInfoPosition (AGPL-3.0);
// parseDecorators is ported from world-info.js (AGPL-3.0). Book-level scan_depth /
// recursive_scanning ride extras: ST never applies them (its world_info_depth / _recursive are global).
// Not ported from Bunraku: its 2/3 → examples position map, scanDepth defaults 100/4, order→priority
// renames, "Entry N" invented titles and every other stamped default.

import type { ChatRole, Imported, LoreBook, LoreEntry, LorePosition } from './native.ts';
import { unwrapLorebookV3 } from './kind-markers.ts';
import {
  compact,
  isRecord,
  joinPath,
  nonBlank,
  optBool,
  optCount,
  optNum,
  optStr,
  uniqueIds,
  WarningSink,
  type Rec,
} from './wire.ts';

/** ST's DEFAULT_DEPTH, used when an at-depth entry carries no depth (world-info.js). */
const ST_DEFAULT_DEPTH = 4;

const ROLE_BY_ST: Record<number, ChatRole> = { 0: 'system', 1: 'user', 2: 'assistant' };

/** The real ST position enum; an unknown number falls back to `after`, as ST's normaliser does. */
export function stPosition(
  position: number,
  extra?: { depth?: number; role?: number; outletName?: string },
): LorePosition {
  switch (position) {
    case 0:
      return 'before';
    case 1:
      return 'after';
    case 2:
      return 'note_before';
    case 3:
      return 'note_after';
    case 4: {
      const d = extra?.depth;
      const depth = d !== undefined && Number.isFinite(d) ? Math.max(0, Math.trunc(d)) : ST_DEFAULT_DEPTH;
      const role = extra?.role === undefined ? undefined : ROLE_BY_ST[extra.role];
      return role ? { depth, role } : { depth };
    }
    case 5:
      return 'examples_before';
    case 6:
      return 'examples_after';
    case 7:
      return { outlet: extra?.outletName ?? '' };
    default:
      return 'after';
  }
}

/**
 * Raw wire position → ST enum number, or undefined when unrecognisable. Accepts the enum numbers,
 * numeric strings and the CC/ST string aliases (`before_char`, `after_char`, `at_depth`, ...).
 */
export function coerceStPosition(raw: unknown): number | undefined {
  const inEnum = (n: number): number | undefined => (Number.isInteger(n) && n >= 0 && n <= 7 ? n : undefined);
  if (typeof raw === 'number') return inEnum(raw);
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  if (/^-?\d+$/.test(v)) return inEnum(Number(v));
  switch (v) {
    case 'before':
    case 'before_char':
    case 'before character':
      return 0;
    case 'after':
    case 'after_char':
    case 'after character':
      return 1;
    case 'an_top':
    case 'author_note_top':
      return 2;
    case 'an_bottom':
    case 'author_note_bottom':
      return 3;
    case 'at_depth':
    case 'depth':
      return 4;
    case 'em_top':
    case 'examples_top':
      return 5;
    case 'em_bottom':
    case 'examples_bottom':
      return 6;
    case 'outlet':
      return 7;
    default:
      return undefined;
  }
}

/** ST role enum (0 system, 1 user, 2 assistant), also accepting numeric strings and role names. */
export function coerceStRole(raw: unknown): number | undefined {
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'system') return 0;
    if (v === 'user') return 1;
    if (v === 'assistant') return 2;
  }
  const n = optNum(raw);
  return n === 0 || n === 1 || n === 2 ? n : undefined;
}

/** ST selective logic: 0 and_any, 1 not_all, 2 not_any, 3 and_all. */
const LOGIC_BY_ST: Record<number, NonNullable<LoreEntry['logic']>> = {
  0: 'and_any',
  1: 'not_all',
  2: 'not_any',
  3: 'and_all',
};

/** ST `group` is comma-separated: an entry may sit in several inclusion groups [D-70]. */
export function splitGroups(raw: string): string[] {
  return raw
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g !== '');
}

/** ST's KNOWN_DECORATORS (world-info.js): the only ones it honours. */
const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'];

/**
 * SillyTavern's parseDecorators (world-info.js), applied to every entry: when the content starts
 * with '@@', every leading '@@' line is stripped, known or not ('@@@x' is the fallback for an
 * unknown decorator just before it), and the rest is joined with '\n'. Returns the known decorators
 * as ST lists them, the content ST sends, and the stripped lines as written.
 */
export function parseDecorators(content: string): { decorators: string[]; content: string; stripped: string[] } {
  if (!content.startsWith('@@')) return { decorators: [], content, stripped: [] };
  const lines = content.split(/\r?\n/);
  const decorators: string[] = [];
  let fallbacked = false;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.startsWith('@@')) break;
    if (line.startsWith('@@@') && !fallbacked) continue;
    const data = line.startsWith('@@@') ? line.slice(1) : line;
    if (KNOWN_DECORATORS.some((k) => data.startsWith(k))) {
      decorators.push(data);
      fallbacked = false;
    } else fallbacked = true;
  }
  return { decorators, content: lines.slice(i).join('\n'), stripped: lines.slice(0, i) };
}

/** A key written as `/pattern/flags` is a regex in both ST and core (§10.2). */
const isRegexKey = (k: string): boolean => /^\/[\s\S]+\/[a-z]*$/.test(k.trim());

// ---- leftover classification -------------------------------------------------------------------

type ActiveCheck = (v: unknown) => boolean;
const isTrue: ActiveCheck = (v) => v === true;
const nonEmptyString: ActiveCheck = (v) => typeof v === 'string' && v.trim() !== '';
const nonEmptyArray: ActiveCheck = (v) => Array.isArray(v) && v.length > 0;
const truthyDelay: ActiveCheck = (v) => v === true || (typeof v === 'number' && v > 0);
const activeFilter: ActiveCheck = (v) =>
  isRecord(v) && (nonEmptyArray(v.names) || nonEmptyArray(v.tags));

/**
 * Fields ST acts on but rp-core does not (yet). They ride `extras`; a warning is raised only when the
 * value would actually change ST's behaviour, so template defaults (`vectorized: false`) stay quiet.
 */
const NOT_HONOURED: Record<string, { active: ActiveCheck; what: string }> = {};
const notHonoured = (names: string[], active: ActiveCheck, what: string): void => {
  for (const n of names) NOT_HONOURED[n] = { active, what };
};
notHonoured(['vectorized'], isTrue, 'vector-search activation');
notHonoured(['group_override', 'groupOverride'], isTrue, 'group override');
notHonoured(['use_group_scoring', 'useGroupScoring'], isTrue, 'group scoring');
notHonoured(['delay_until_recursion', 'delayUntilRecursion'], truthyDelay, 'delay until recursion');
notHonoured(['automation_id', 'automationId'], nonEmptyString, 'automation id');
notHonoured(['character_filter', 'characterFilter'], activeFilter, 'character filter');
notHonoured(['characterFilterNames', 'characterFilterTags'], nonEmptyArray, 'character filter');
notHonoured(['triggers'], nonEmptyArray, 'generation-type triggers');
notHonoured(['agent_blacklisted', 'agentBlacklisted'], isTrue, 'agent blacklist');
for (const [snake, camel, label] of [
  ['match_persona_description', 'matchPersonaDescription', 'persona description'],
  ['match_character_description', 'matchCharacterDescription', 'character description'],
  ['match_character_personality', 'matchCharacterPersonality', 'character personality'],
  ['match_character_depth_prompt', 'matchCharacterDepthPrompt', 'character depth prompt'],
  ['match_scenario', 'matchScenario', 'scenario'],
  ['match_creator_notes', 'matchCreatorNotes', 'creator notes'],
] as const) {
  notHonoured([snake, camel], isTrue, `scanning the ${label}`);
}

/**
 * Known fields kept in extras without a warning: cosmetic UI state, or settings ST itself ignores in
 * that combination (secondary keys without `selective`, probability with `useProbability:false`,
 * depth/role/outlet of an entry that is not at depth/outlet).
 */
const SILENT = new Set([
  'display_index',
  'displayIndex',
  'addMemo',
  'add_memo',
  'use_regex',
  'priority',
  'secondary_keys',
  'keysecondary',
  'selectiveLogic',
  'selective_logic',
  'depth',
  'role',
  'outlet_name',
  'outletName',
  'probability',
  'useProbability',
  'use_probability',
  'name',
  'characterFilterExclude',
]);

// ---- entry mapping -----------------------------------------------------------------------------

type Dialect = 'book' | 'wi';

/**
 * Reads named fields from an entry's homes and remembers what it consumed, so whatever is left over
 * lands in `extras` for round-trips. A CCv2 entry has two homes (top level and `extensions`, which
 * ST's convertCharacterBook reads first); a WI entry has one.
 */
class Fields {
  private readonly usedTop = new Set<string>();
  private readonly usedExt = new Set<string>();
  constructor(
    readonly top: Rec,
    readonly ext: Rec,
  ) {}

  /** First non-null value, `extensions` before top level; consumes every listed name in both homes. */
  take(...names: string[]): unknown {
    return this.lookup(names, [
      [this.ext, this.usedExt],
      [this.top, this.usedTop],
    ]);
  }

  /** Same, top level first (ST reads `case_sensitive` this way round). */
  takeTopFirst(...names: string[]): unknown {
    return this.lookup(names, [
      [this.top, this.usedTop],
      [this.ext, this.usedExt],
    ]);
  }

  /** Look without consuming. */
  peek(...names: string[]): unknown {
    for (const home of [this.ext, this.top]) {
      for (const n of names) if (home[n] !== undefined && home[n] !== null) return home[n];
    }
    return undefined;
  }

  consumeTop(name: string): void {
    this.usedTop.add(name);
  }

  leftovers(): { top: Rec; ext: Rec } {
    const pick = (home: Rec, used: Set<string>): Rec =>
      Object.fromEntries(Object.entries(home).filter(([k]) => !used.has(k)));
    return { top: pick(this.top, this.usedTop), ext: pick(this.ext, this.usedExt) };
  }

  private lookup(names: string[], homes: [Rec, Set<string>][]): unknown {
    let found: unknown;
    for (const [home, used] of homes) {
      for (const n of names) {
        if (!(n in home)) continue;
        used.add(n);
        const v = home[n];
        if (found === undefined && v !== null && v !== undefined) found = v;
      }
    }
    return found;
  }
}

/** Keys list: strings only, blank keys dropped (they would match everything in a substring scan). */
function readKeys(raw: unknown, path: string, star: string, sink: WarningSink): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    sink.fold('invalid_value', path, star, 'keys are not a list; ST drops them, so does rp-core');
    return [];
  }
  return raw.filter((k): k is string => typeof k === 'string' && k.trim() !== '');
}

interface EntryCtx {
  dialect: Dialect;
  /** Path of this entry, e.g. `data.character_book.entries[3]` or `entries.12`. */
  path: string;
  /** Wildcard path for folded warnings, e.g. `data.character_book.entries[*]`. */
  star: string;
  fallbackId: string;
  sink: WarningSink;
}

function mapEntry(raw: Rec, c: EntryCtx): LoreEntry {
  const ext = c.dialect === 'book' && isRecord(raw.extensions) ? raw.extensions : {};
  const f = new Fields(raw, ext);
  if (c.dialect === 'book') f.consumeTop('extensions'); // its leftovers become extras.extensions
  const at = (field: string, inExt = false): [string, string] => [
    joinPath(inExt ? joinPath(c.path, 'extensions') : c.path, field),
    joinPath(inExt ? joinPath(c.star, 'extensions') : c.star, field),
  ];

  // id: the source's own id/uid, else its position; never a random UUID.
  const rawId = f.take(c.dialect === 'book' ? 'id' : 'uid');
  const id =
    typeof rawId === 'number' || (typeof rawId === 'string' && rawId.trim() !== '') ? String(rawId) : c.fallbackId;

  const keys = readKeys(f.take('keys', 'key'), ...at('keys'), c.sink);

  // selective: a CCv2 entry is selective only when it says so (convertCharacterBook `|| false`);
  // a WI file entry missing the field gets ST's template default `true` (addMissingWorldInfoFields).
  const sel = f.take('selective');
  const selective = c.dialect === 'wi' ? sel !== false : sel === true;
  let keepSelective = false;
  const rawSecondary = f.peek('secondary_keys', 'keysecondary');
  // A list or nothing; anything else ST resets to [] when it loads the book (world-info.js "Fixing
  // invalid keysecondary") — dropped here too, but said, as for the primary keys.
  if (rawSecondary !== undefined && rawSecondary !== null && !Array.isArray(rawSecondary)) {
    c.sink.fold('invalid_value', ...at('secondary_keys'), 'secondary keys are not a list; ST drops them, so does rp-core');
  }
  const secondaryAll = Array.isArray(rawSecondary) ? readKeys(rawSecondary, ...at('secondary_keys'), c.sink) : [];
  let secondary: string[] | undefined;
  let logic: LoreEntry['logic'];
  if (secondaryAll.length === 0 || selective) {
    // Empty lists are template noise; with `selective` the keys are honoured. Either way consume them.
    f.take('secondary_keys', 'keysecondary');
    const rawLogic = f.take('selectiveLogic', 'selective_logic');
    if (secondaryAll.length > 0) {
      secondary = secondaryAll;
      const n = optNum(rawLogic);
      logic = n === undefined ? undefined : LOGIC_BY_ST[n];
      if (rawLogic !== undefined && logic === undefined) {
        c.sink.fold('invalid_value', ...at('selectiveLogic', c.dialect === 'book'), `unknown selectiveLogic ${JSON.stringify(rawLogic)}; ST treats it as AND ANY`);
      }
    }
  }
  // else: secondary keys without `selective` are ignored by ST too; they stay in extras silently,
  // and so does `selective` itself, so a reverse export cannot switch them on.
  else keepSelective = sel !== undefined;

  const comment = nonBlank(f.take('comment'));
  const altName = nonBlank(f.peek('name'));
  if (comment === undefined || altName === undefined || altName === comment) f.take('name');
  const title = comment ?? altName;

  const rawContent = f.take('content');
  let content = optStr(rawContent) ?? '';
  if (rawContent !== undefined && typeof rawContent !== 'string') {
    c.sink.fold('invalid_value', ...at('content'), 'content is not a string; imported as empty');
  }
  // Decorators, as ST reads them: stripped from the content; @@activate fires the entry without a
  // key (like constant), @@dont_activate never lets it fire (like disabled); the rest are dropped.
  const deco = parseDecorators(content);
  content = deco.content;
  const activate = deco.decorators.includes('@@activate');
  const dontActivate = !activate && deco.decorators.includes('@@dont_activate');
  const dropped = deco.stripped.filter((line) => {
    const data = line.startsWith('@@@') ? line.slice(1) : line;
    return data !== '@@activate' && data !== '@@dont_activate';
  });
  if (dropped.length > 0) {
    c.sink.fold('not_honoured', ...at('content'), 'decorators other than @@activate / @@dont_activate (@@depth, @@role, ...) are ignored and stripped from the content, as SillyTavern does; kept in extras.decorators');
  }

  const enabledRaw = optBool(f.take('enabled'));
  const disable = optBool(f.take('disable'));
  const enabledRead =
    c.dialect === 'wi'
      ? disable !== undefined
        ? !disable
        : enabledRaw
      : enabledRaw ?? (disable !== undefined ? !disable : undefined);
  const enabled = dontActivate ? false : enabledRead;

  const constantRead = optBool(f.take('constant'));
  const constant = activate ? true : constantRead;
  const order = optNum(f.take('insertion_order', 'order'));

  // Position: CCv2 keeps the precise ST slot in extensions.position and a coarse before_char/after_char
  // at the top; the precise one wins. A missing position defaults like ST: `after` for a card book
  // (normalizeCharacterBookPosition), `before` (0) for a WI file (entry template).
  const candidates: [unknown, string, string][] =
    c.dialect === 'book'
      ? [
          [ext.position, ...at('position', true)],
          [raw.position, ...at('position')],
        ]
      : [[raw.position, ...at('position')]];
  f.take('position');
  let st: number | undefined;
  for (const [v, p, s] of candidates) {
    if (v === undefined || v === null) continue;
    const n = coerceStPosition(v);
    if (n === undefined) {
      c.sink.fold('invalid_value', p, s, `unknown position ${JSON.stringify(v)}`);
      continue;
    }
    st = n;
    break;
  }
  st ??= c.dialect === 'book' ? 1 : 0;
  let position: LorePosition;
  if (st === 4) {
    const rawRole = f.take('role');
    const role = coerceStRole(rawRole);
    if (rawRole !== undefined && role === undefined) {
      c.sink.fold('invalid_value', ...at('role', c.dialect === 'book'), `unknown role ${JSON.stringify(rawRole)}; using system`);
    }
    position = stPosition(4, { depth: optNum(f.take('depth')), role });
  } else if (st === 7) {
    const outletName = optStr(f.take('outlet_name', 'outletName')) ?? '';
    if (outletName.trim() === '') {
      c.sink.fold('empty_outlet', ...at('outlet_name', c.dialect === 'book'), 'outlet position without an outlet name; the entry goes nowhere, as in ST');
    }
    position = stPosition(7, { outletName });
  } else {
    position = stPosition(st);
  }

  // probability is only live with useProbability (ST default true); otherwise both stay in extras.
  let probability: number | undefined;
  if (f.peek('useProbability', 'use_probability') !== false) {
    f.take('useProbability', 'use_probability');
    const p = optNum(f.take('probability'));
    if (p !== undefined) probability = Math.min(100, Math.max(0, p));
  }

  const rawGroup = f.take('group', 'group_name');
  const groupList = typeof rawGroup === 'string' ? splitGroups(rawGroup) : [];
  const groups = groupList.length > 0 ? groupList : undefined;

  const entry: LoreEntry = compact({
    id,
    title,
    content,
    enabled,
    constant,
    keys,
    secondary,
    logic,
    position,
    order,
    probability,
    groups,
    groupWeight: optNum(f.take('group_weight', 'groupWeight')),
    scanDepth: optCount(f.take('scan_depth', 'scanDepth')),
    caseSensitive: optBool(f.takeTopFirst('case_sensitive', 'caseSensitive')),
    wholeWords: optBool(f.take('match_whole_words', 'matchWholeWords')),
    preventRecursion: optBool(f.take('prevent_recursion', 'preventRecursion')),
    excludeRecursion: optBool(f.take('exclude_recursion', 'excludeRecursion')),
    ignoreBudget: optBool(f.take('ignore_budget', 'ignoreBudget')),
    sticky: optCount(f.take('sticky')),
    cooldown: optCount(f.take('cooldown')),
    delay: optCount(f.take('delay')),
  } satisfies LoreEntry);

  // ST's use_regex is inert upstream but SillyBunny turns plain keys into regexes with it.
  if (raw.use_regex === true && [...keys, ...(secondary ?? [])].some((k) => !isRegexKey(k))) {
    c.sink.fold('not_honoured', ...at('use_regex'), 'use_regex is not honoured: keys are literal unless written /re/flags');
  }
  const left = f.leftovers();
  classifyLeftovers(left.top, c, false);
  classifyLeftovers(left.ext, c, true);
  const extras: Rec = { ...left.top };
  if (keepSelective) extras.selective = sel;
  if (deco.stripped.length > 0) {
    extras.decorators = deco.stripped;
    // What the entry said before the decorators set it, for a reverse export.
    if (activate && constantRead !== undefined) extras.constant = constantRead;
    if (dontActivate && enabledRead !== undefined) extras.enabled = enabledRead;
  }
  if (Object.keys(left.ext).length > 0) extras.extensions = left.ext;
  if (Object.keys(extras).length > 0) entry.extras = extras;
  return entry;
}

function classifyLeftovers(left: Rec, c: EntryCtx, inExt: boolean): void {
  const base = inExt ? joinPath(c.path, 'extensions') : c.path;
  const star = inExt ? joinPath(c.star, 'extensions') : c.star;
  for (const [k, v] of Object.entries(left)) {
    const rule = NOT_HONOURED[k];
    if (rule) {
      if (rule.active(v)) c.sink.fold('not_honoured', joinPath(base, k), joinPath(star, k), `${rule.what} is not honoured; kept in extras`);
      continue;
    }
    if (SILENT.has(k) || (c.dialect === 'wi' && k === 'extensions')) continue;
    c.sink.fold('unknown_field', joinPath(base, k), joinPath(star, k), `unknown field "${k}" kept in extras`);
  }
}

// ---- books -------------------------------------------------------------------------------------

/** Book-level keys a CCv2 book or ST WI file may carry that rp-core keeps silently in extras. */
const SILENT_BOOK = new Set(['description', 'token_budget', 'extensions', 'originalData', 'spec', 'spec_version']);

/**
 * Book-level scan settings. SillyTavern never reads them: convertCharacterBook copies the entries
 * only (an entry's own extensions.scan_depth is read), and its global world_info_depth (2) and
 * world_info_recursive (on) apply to every world. So they ride extras, unapplied; a value that would
 * change the scan if it were applied is named in one warning. A native core.lorebook may still set
 * scanDepth / recursive.
 */
const BOOK_SCAN = ['scan_depth', 'recursive_scanning'];
const ST_SCAN_DEPTH = 2;

function bookScanWarning(raw: Rec, prefix: string, sink: WarningSink): void {
  const depth = optCount(raw.scan_depth);
  const parts: string[] = [];
  if (depth !== undefined && depth !== ST_SCAN_DEPTH) parts.push(`scan_depth ${depth}`);
  if (raw.recursive_scanning === false) parts.push('recursive_scanning false');
  if (parts.length === 0) return;
  sink.add(
    'not_honoured',
    joinPath(prefix, parts[0]!.split(' ')[0]!),
    `the book's ${parts.join(' and ')} ${parts.length === 1 ? 'is' : 'are'} ignored by SillyTavern, which scans every world at its global depth 2 with recursion on; rp-core does the same (kept in extras)`,
  );
}

function bookExtras(raw: Rec, consumed: string[], prefix: string, sink: WarningSink): Rec | undefined {
  const extras: Rec = {};
  for (const [k, v] of Object.entries(raw)) {
    if (consumed.includes(k)) continue;
    extras[k] = v;
    if (!SILENT_BOOK.has(k) && !BOOK_SCAN.includes(k)) sink.add('unknown_field', joinPath(prefix, k), `unknown book field "${k}" kept in extras`);
  }
  bookScanWarning(raw, prefix, sink);
  return Object.keys(extras).length > 0 ? extras : undefined;
}

/**
 * characterBookToLoreBook with warning paths rooted at `prefix` (e.g. `data.character_book` inside
 * a card). Exported for card.ts; the contract entry point below roots paths at the book itself.
 */
export function characterBookAt(book: unknown, fallbackName: string, prefix: string): Imported<LoreBook> {
  const sink = new WarningSink();
  const b = unwrapLorebookV3(book);
  if (!isRecord(b)) {
    sink.add('invalid_value', prefix || '$', 'character_book is not an object; imported as an empty book');
    return { value: { name: fallbackName, match: 'literal', entries: [] }, warnings: sink.list() };
  }
  const entriesPath = joinPath(prefix, 'entries');
  const rawEntries: unknown[] = Array.isArray(b.entries) ? b.entries : [];
  if (!Array.isArray(b.entries)) sink.add('invalid_value', entriesPath, 'character_book has no entries list');
  const entries: LoreEntry[] = [];
  rawEntries.forEach((e, i) => {
    const path = joinPath(entriesPath, i);
    if (!isRecord(e)) {
      sink.add('invalid_value', path, 'entry is not an object; skipped');
      return;
    }
    entries.push(mapEntry(e, { dialect: 'book', path, star: `${entriesPath}[*]`, fallbackId: String(i), sink }));
  });
  // Book-level scan_depth / recursive_scanning ride extras: SillyTavern ignores them (bookExtras).
  const value: LoreBook = compact({
    name: nonBlank(b.name) ?? fallbackName,
    match: 'literal' as const,
    entries: uniqueIds(entries),
    extras: bookExtras(b, ['name', 'entries'], prefix, sink),
  });
  return { value, warnings: sink.list() };
}

/** CCv2/V3 `character_book` (entries array; extensions.position etc.) → LoreBook with match 'literal'. */
export function characterBookToLoreBook(book: unknown, fallbackName: string): Imported<LoreBook> {
  return characterBookAt(book, fallbackName, '');
}

/** ST world info file ({entries: {uid: entry}}) → LoreBook with match 'literal'. M2 consumer, cheap now. */
export function worldInfoToLoreBook(json: unknown, fallbackName: string): Imported<LoreBook> {
  const sink = new WarningSink();
  if (!isRecord(json) || !isRecord(json.entries)) {
    sink.add('invalid_value', 'entries', 'not a world info file (no entries object); imported as an empty book');
    return { value: { name: fallbackName, match: 'literal', entries: [] }, warnings: sink.list() };
  }
  const entries: LoreEntry[] = [];
  for (const [key, e] of Object.entries(json.entries)) {
    const path = joinPath('entries', key);
    if (!isRecord(e)) {
      sink.add('invalid_value', path, 'entry is not an object; skipped');
      continue;
    }
    entries.push(mapEntry(e, { dialect: 'wi', path, star: 'entries.*', fallbackId: key, sink }));
  }
  const value: LoreBook = compact({
    name: nonBlank(json.name) ?? fallbackName,
    match: 'literal' as const,
    entries: uniqueIds(entries),
    extras: bookExtras(json, ['name', 'entries'], '', sink),
  });
  return { value, warnings: sink.list() };
}
