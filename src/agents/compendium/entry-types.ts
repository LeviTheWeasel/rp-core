// Ported from Bunraku:src/core/compendium/types.ts, entry-types.ts and filing-schema.ts:33 (identityField)
// @702d8120 (the eleven entry types, their labels, SPEC, REQUIRED_FIELDS, parseStructured); the nested
// shapes in NESTED from RoleCall:apps/rc/src/lib/ai/dm-stream/tools/compendium-definitions.ts:1945-2757
// @fb8dc623e (the Remember_* tool schemas).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What each entry type's `data` may hold at its top level, and the kind of each field (ARCHITECTURE.md
// §5.8). Reading is lenient and keeps everything: parseStructured never drops a field; it reports known
// fields holding the wrong kind of value and missing required fields. Rejecting is the writer's job.
// Changes from Bunraku: the UI theme tokens and the By Type `section` labels are dropped (no UI here);
// identityField moved in from filing-schema.ts; LITE_FIELDS (§7.4.3) and NESTED (prompts only) are new.
// CONTRACT FILE (M5a): the lead owns it.

import { ENTRY_TYPES, type EntryType, type Rec } from './types.ts';

export interface EntryTypeInfo {
  /** The word for one entry: "Character". */
  label: string;
  /** The tree bucket (RoleCall tv-tree-typed.ts:64-76): "Cast". */
  bucket: string;
}

export const ENTRY_TYPE_INFO: Readonly<Record<EntryType, EntryTypeInfo>> = {
  character: { label: 'Character', bucket: 'Cast' },
  location: { label: 'Location', bucket: 'Places' },
  item: { label: 'Item', bucket: 'Items' },
  power: { label: 'Power', bucket: 'Powers' },
  organization: { label: 'Organization', bucket: 'Organizations' },
  event: { label: 'Event', bucket: 'Events' },
  plot: { label: 'Plot', bucket: 'Plots' },
  threat: { label: 'Threat', bucket: 'Threats' },
  worldbuilding: { label: 'Worldbuilding', bucket: 'Worldbuilding' },
  summary: { label: 'Summary', bucket: 'Narrative' },
  creature: { label: 'Creature', bucket: 'Bestiary' },
};

export const isEntryType = (value: unknown): value is EntryType =>
  typeof value === 'string' && (ENTRY_TYPES as readonly string[]).includes(value);

// Kinds: s string, n number, b boolean, a array, o object, so string or object, e(a|b) one of the listed strings.
const SPEC: Record<EntryType, string> = {
  character: 'name:s description:s aliases:a role:e(protagonist|antagonist|ally|rival|neutral|background|deity|player_character) species:s age:s pronouns:s physical:o personality:o background:o current_state:o arc:o relationships:a memories:a tier:s notable_stats:so powers:a possessions:a affiliations:a voice:o skills:a languages:a family:o reputation:s likes:a dislikes:a strengths:a weaknesses:a minor_facts:a death_details:o',
  location: 'name:s description:s type:e(city|town|village|settlement|building|room|dungeon|wilderness|region|realm|plane) parent_location:s physical:o inhabitants:o points_of_interest:a current_state:o connected_to:a atmosphere:o history:s climate:s dangers:a local_laws:a architecture:s notable_items:a controlling_faction:s minor_facts:a',
  item: 'name:s description:s type:e(weapon|armor|tool|consumable|artifact|document|key|treasure|mundane|magical|relic) physical:o abilities:a drawbacks:a current_owner:s current_location:s provenance:s significance:s condition:e(pristine|good|damaged|broken|destroyed|lost|unknown) tier:s value:s linked_powers:a activation:o required_wielder:s set_pieces:a legend:s minor_facts:a',
  organization: 'name:s description:s type:e(guild|faction|government|religion|family|cult|military|criminal|academic|mercantile|secret_society) leader:s members:a size:s goals:a methods:a beliefs:a allies:a enemies:a territory:a headquarters:s current_state:o founded:o history:s symbols:o hierarchy:a recruitment:s subsidiaries:a reputation:s strengths:a weaknesses:a minor_facts:a',
  event: 'name:s description:s type:e(battle|ceremony|discovery|betrayal|reunion|departure|death|transformation|political|personal|supernatural) when:s where:s participants:a outcome:s significance:e(trivial|notable|major|pivotal) consequences:a related_plots:a cause:s witnesses:a items_involved:a phases:a how_remembered:s',
  plot: 'name:s description:s type:e(main_quest|side_quest|character_arc|mystery|romance|political|personal_goal|background_thread) status:e(not_started|active|stalled|escalating|resolved|failed|abandoned) central_characters:a key_locations:a involved_organizations:a goal:s obstacles:a stakes:s current_progress:s recent_developments:a next_steps:s parent_plot:s themes:a stakes_per_character:so foreshadowing_planted:a structure_beat:s',
  threat: 'name:s description:s nature:e(physical|social|supernatural|political|environmental|psychological|existential) scope:e(personal|local|regional|national|global|cosmic) severity:e(minor|notable|major|catastrophic|extinction_level) status:e(dormant|stirring|active|imminent|in_progress|averted|realized) source:o what_happens_if_unaddressed:s affected_targets:a counters:a weaknesses:a who_can_stop_it:a clues_revealed:a current_progress:s timeline:s knowledge_level:e(secret|rumored|public|common_knowledge) spread_mechanics:s tier:s',
  worldbuilding: 'topic:s category:s description:s key_facts:a rules:a exceptions:a applies_to:a origin:s related_to:a examples:a embodied_by:a',
  summary: 'title:s tagline:s summary:s parent_plot:s create_plot:o participants:a involved_locations:a significance:e(minor|moderate|major|pivotal) messages_covered:n turn_range:o key_moments:a consequences:a mood:e(light|comedic|tense|tragic|triumphant|melancholy|horrific|hopeful) pov_character:s foreshadowing_introduced:a',
  creature: 'name:s tagline:s image_url:s classification:s rarity:e(common|uncommon|rare|legendary|mythical|unique) disposition:e(docile|cautious|neutral|aggressive|territorial|predatory) knowledge_level:e(unknown|rumored|observed|studied|mastered) description:s appearance:s habitat:s diet:s lifespan:s traits:a behaviors:a abilities:a ecology:o known_locations:a weaknesses:a cultural_significance:s tier:s bonded_to:s bond_type:e(owned|contracted|partnered|parasitic|bound|awakened|wild|summoned) linked_power:s reproduction:s social_structure:e(solitary|pack|hive|tribe|herd|swarm|colonial|symbiotic) intelligence:e(mindless|animal|cunning|sapient|hyperintelligent|cosmic) variants:a combat_tactics:s drops:a tameable:b taming_method:s strengths:a minor_facts:a',
  power: 'name:s tagline:s description:s category:e(attack|defense|utility|healing|summoning|transformation|passive|ritual|knowledge|social|crafting|mobility|movement|special) mastery:e(nascent|learning|competent|mastered|legendary|reality_warping) source:e(innate|learned|gifted|awakened|stolen|inherited|acquired) tier:s users:a prerequisites:a cost:s range:s duration:s requirements:a limitations:a drawbacks:a effects:a variants:a parent_power:s related_powers:a lineage:s origin:s notable_uses:a',
};

/** Fields an entry of this type must carry (RoleCall's `required`). */
export const REQUIRED_FIELDS: Readonly<Record<EntryType, readonly string[]>> = {
  character: ['name'],
  location: ['name'],
  item: ['name'],
  organization: ['name'],
  event: ['name'],
  plot: ['name'],
  threat: ['name'],
  worldbuilding: ['topic', 'category', 'description'],
  summary: ['title', 'summary'],
  creature: ['name'],
  power: ['name'],
};

/** The field that names an entry of this type (Bunraku filing-schema.ts:33). */
export function identityField(type: EntryType): 'name' | 'title' | 'topic' {
  return type === 'summary' ? 'title' : type === 'worldbuilding' ? 'topic' : 'name';
}

/** Identity fields an incoming `file` never overwrites when the entry already has one (D-144). */
export const IDENTITY_KEEP: readonly string[] = ['name', 'title', 'topic'];

export type Kind = 's' | 'n' | 'b' | 'a' | 'o' | 'so' | { oneOf: readonly string[] };

const FIELDS = Object.fromEntries(
  Object.entries(SPEC).map(([type, spec]) => [
    type,
    new Map(
      spec.split(' ').map((pair): [string, Kind] => {
        const [name, kind] = pair.split(':') as [string, string];
        return [name, kind.startsWith('e(') ? { oneOf: kind.slice(2, -1).split('|') } : (kind as Kind)];
      }),
    ),
  ]),
) as Record<EntryType, Map<string, Kind>>;

/** The field names this type knows, in SPEC order (the render's section order). */
export const knownFields = (type: EntryType): string[] => [...FIELDS[type].keys()];

/** The kind of one known field, or undefined. */
export const fieldKind = (type: EntryType, field: string): Kind | undefined => FIELDS[type].get(field);

export interface FieldIssue {
  field: string;
  expected: string;
}

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

const matches = (value: unknown, kind: Kind): boolean => {
  if (typeof kind === 'object') return typeof value === 'string' && kind.oneOf.includes(value);
  switch (kind) {
    case 's':
      return typeof value === 'string';
    case 'n':
      return typeof value === 'number' && Number.isFinite(value);
    case 'b':
      return typeof value === 'boolean';
    case 'a':
      return Array.isArray(value);
    case 'o':
      return isRecord(value);
    case 'so':
      return typeof value === 'string' || isRecord(value);
  }
};

export const describeKind = (kind: Kind): string =>
  typeof kind === 'object'
    ? `one of ${kind.oneOf.join(', ')}`
    : { s: 'text', n: 'a number', b: 'true or false', a: 'a list', o: 'an object', so: 'text or an object' }[kind];

export interface ParsedStructured {
  /** The data exactly as stored, unknown fields included. */
  data: Rec;
  /** Fields that are unknown to this type, kept and shown. */
  extras: string[];
  /** Known fields holding the wrong kind of value. */
  issues: FieldIssue[];
  /** Required fields that are absent or blank. */
  missing: string[];
}

/** Blank: undefined, null or a whitespace-only string (D-148). */
export const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Checks data against its type without changing or dropping anything. A null or undefined field counts as absent. */
export function parseStructured(type: EntryType, data: Rec): ParsedStructured {
  const fields = FIELDS[type];
  const extras: string[] = [];
  const issues: FieldIssue[] = [];
  for (const [field, value] of Object.entries(data)) {
    const kind = fields.get(field);
    if (kind === undefined) extras.push(field);
    else if (value !== null && value !== undefined && !matches(value, kind)) issues.push({ field, expected: describeKind(kind) });
  }
  return { data, extras, issues, missing: REQUIRED_FIELDS[type].filter((f) => isBlank(data[f])) };
}

/**
 * §7.4.3: the fields the lite profile asks for and the `/memory new` template holds (69 fields; `*`
 * required). `summary` has none: filing never writes summaries (the template uses SUMMARY_TEMPLATE).
 * Nested shapes are in NESTED.
 */
export const LITE_FIELDS: Readonly<Record<Exclude<EntryType, 'summary'>, readonly string[]>> = {
  character: ['name', 'aliases', 'description', 'role', 'current_state', 'relationships', 'memories'],
  location: ['name', 'aliases', 'description', 'type', 'parent_location', 'current_state', 'connected_to'],
  item: ['name', 'aliases', 'description', 'current_owner', 'current_location', 'condition', 'abilities'],
  power: ['name', 'aliases', 'description', 'users', 'cost', 'limitations'],
  organization: ['name', 'aliases', 'description', 'leader', 'members', 'goals', 'allies', 'enemies'],
  event: ['name', 'description', 'when', 'where', 'participants', 'outcome', 'significance', 'consequences'],
  plot: ['name', 'description', 'status', 'goal', 'stakes', 'current_progress', 'next_steps', 'central_characters'],
  threat: ['name', 'description', 'severity', 'status', 'what_happens_if_unaddressed', 'who_can_stop_it'],
  worldbuilding: ['topic', 'category', 'description', 'key_facts', 'rules'],
  creature: ['name', 'aliases', 'description', 'habitat', 'disposition', 'abilities', 'weaknesses'],
};

/** The `/memory new summary` template (D-160). */
export const SUMMARY_TEMPLATE: readonly string[] = ['title', 'summary', 'significance', 'participants'];

export interface NestedShape {
  /** Field → kind, as in SPEC. */
  fields: Readonly<Record<string, Kind>>;
  /** Fields an item must carry: RoleCall's `required`, plus rp-core's memory rule (`a|b` = one of them, D-82). */
  required: readonly string[];
}

const nested = (spec: string, required: readonly string[]): NestedShape => ({
  fields: Object.fromEntries(
    spec.split(' ').map((pair): [string, Kind] => {
      const [name, kind] = pair.split(':') as [string, string];
      return [name, kind.startsWith('e(') ? { oneOf: kind.slice(2, -1).split('|') } : (kind as Kind)];
    }),
  ),
  required,
});

/**
 * RoleCall's nested forms the prompts name (filing M5b, the `/memory new` help line now). Keys are
 * `<type>.<field>`; an array field's shape is its item's. Reading never enforces them (D-82).
 */
export const NESTED: Readonly<Record<string, NestedShape>> = {
  'character.current_state': nested('status:e(alive|dead|missing|transformed|imprisoned|unknown) location:s condition:s', []),
  'character.relationships': nested('with:s nature:e(ally|enemy|romantic|family|mentor|rival|unknown) status:e(active|past|strained|unknown) notes:s', ['with', 'nature']),
  'character.memories': nested(
    'what_happened:s tagline:s when:s where:s with:a interpretation:s emotional_weight:e(trivial|notable|formative|defining) emotion:s changed_belief:s changed_behavior:s source_summary:s is_secret:b',
    ['what_happened', 'changed_belief|changed_behavior'],
  ),
  'character.affiliations': nested('org:s role:s since:s status:e(active|former|honorary|exiled|secret)', ['org']),
  'character.powers': nested('name:s mastery:s notes:s acquired:s source:s', ['name']),
  'location.current_state': nested('status:e(normal|under_attack|destroyed|abandoned|occupied|sealed|hidden) accessibility:s recent_changes:s', []),
};

const SENTENCE_END = /[.!?…](?=\s|$)/u;

/**
 * CEntry.tagline (D-151): an explicit non-blank `data.tagline` (any type) wins; else the first sentence
 * of `description` (a summary: of `summary`), at most 80 chars, cut at a word boundary with '…'; else ''.
 */
export function deriveTagline(type: EntryType | null, data: Rec): string {
  if (typeof data.tagline === 'string' && data.tagline.trim() !== '') return data.tagline.trim();
  const source = type === 'summary' ? data.summary : data.description;
  if (typeof source !== 'string') return '';
  const text = source.trim().replace(/\s+/gu, ' ');
  if (text === '') return '';
  const end = text.search(SENTENCE_END);
  const first = end >= 0 ? text.slice(0, end + 1) : text;
  const cps = Array.from(first);
  if (cps.length <= 80) return first;
  const cut = cps.slice(0, 79).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/u, '')}…`;
}
