// Ported from Bunraku:src/core/assembly/director.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (Coneja-Chibi: DIRECTOR_HEADER / FOOTER, renderDirective, NARRATOR_AUTHORITY) and
// Bunraku:src/core/director/directive.ts@702d8120 (sanitizeForPlayerCharacter, its English
// interiority verbs and its three patterns), whose texts are RoleCall's: RoleCall:apps/rc/src/lib/ai/
// dm-stream/DirectiveBuilder.ts@fb8dc623e (buildNarratorInjection, buildNarratorSystemAddition, the
// aliases of sanitizeDirectiveForPlayerCharacter; the tension line is NemoVonNirgend's).
// Copyright (C) 2026 Coneja-Chibi, NemoVonNirgend; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the narrator gets from the Story Director (ARCHITECTURE.md §7.3 "Delivery", D-65;
// .notes/m4-decisions.md D-105, D-106, D-112): the standing contract, the rendered directive, the
// preview stub, the persona filter, and the one-line summary of a planning turn. Pure.
//
// Port notes.
// - renderDirective: Bunraku's section order and texts. Changed: a text field that is only
//   whitespace counts as absent; the tension number is shown rounded and clamped to 0..10 (Bunraku
//   showed the raw value next to the rounded word); an unknown pacing value renders nothing.
// - contractText: NARRATOR_AUTHORITY (Bunraku's text: RoleCall's with hyphens for its dashes, the
//   header from the one DIRECTOR_HEADER) plus one line, never act, speak or decide for the persona,
//   and one line that keeps the story's language (D-120).
//   Placement (core block, every kind of turn) is prompt/assemble.ts's.
// - sanitizeForPlayerCharacter: Bunraku's fields and patterns, RoleCall's aliases. Changed (D-112,
//   decision A.5): names and texts are compared after foldText (NFKC, case, ё → е); word edges are
//   checked code point by code point with isLoreWordChar, never with a \p lookbehind (JavaScriptCore
//   reads one half of a surrogate pair there); a Russian verb, noun, lead and filler list (below);
//   Russian names are matched in their singular case forms; removals are reported as `skipped`; an
//   emptied list loses its key, an emptied include is removed; nothing removed → the same object.

import { charAt, charBefore, foldText, isLoreWordChar } from '../../text/normalize.ts';
import type { DirectorSeed, DirectorState, NarratorDirective, Pacing, Skip } from './types.ts';

// ---- the block ----------------------------------------------------------------------------------------

/** One header for the contract and the directive (decision A.4: the hyphen, as in Bunraku). */
export const DIRECTOR_HEADER = '[DIRECTOR CONSTRAINTS - BINDING THIS TURN]';
export const DIRECTOR_FOOTER = '[/DIRECTOR CONSTRAINTS]';

/** What the preview shows at depth 1 for a turn not yet planned [D-106]. */
export const STUB_DIRECTIVE = `${DIRECTOR_HEADER}\n(the Director plans this when the turn runs)\n${DIRECTOR_FOOTER}`;

const PACING: Readonly<Record<Pacing, string>> = {
  slow: 'Take your time. Let moments breathe. Descriptive, contemplative.',
  medium: 'Balanced pacing.',
  fast: 'Keep things moving. Punchy sentences. Action-oriented.',
  breakneck: 'Rapid fire. No pause. Urgent, breathless energy.',
};
const TENSION = ['calm', 'relaxed', 'mild', 'present', 'moderate', 'building', 'high', 'intense', 'critical', 'explosive'] as const;

// Framed as binding, not as hints: the header overrides any planning protocol the narrator may carry.
const PREAMBLE = [
  DIRECTOR_HEADER,
  'The following are non-negotiable scene constraints decided by the Story Director.',
  'They take precedence over any internal planning, director framework, or evaluation',
  'protocol you may otherwise apply to arc/callback/character-beat decisions.',
  'Your job is to render these constraints as excellent prose. Do NOT second-guess',
  'which arc to advance, which callback to weave in, or which character beat to hit -',
  'the Director has already made those decisions. Execute them.',
].join('\n');

const has = (s: string | undefined): s is string => typeof s === 'string' && s.trim() !== '';
const any = <T>(list: readonly T[] | undefined): list is readonly T[] => Array.isArray(list) && list.length > 0;

/** The directive as the narrator reads it, or '' when it says nothing. */
export function renderDirective(d: NarratorDirective): string {
  const sections: string[] = [];
  const mood: string[] = [];
  if (has(d.mood)) mood.push(`Mood: ${d.mood}`);
  if (d.pacing !== 'medium' && Object.hasOwn(PACING, d.pacing)) mood.push(`Pacing: ${PACING[d.pacing]}`);
  if (mood.length > 0) sections.push(mood.join('\n'));

  const scene = d.sceneGuidance;
  if (scene) {
    const lines = ['Scene Guidance:'];
    if (has(scene.setting)) lines.push(`  Setting: ${scene.setting}`);
    if (has(scene.atmosphere)) lines.push(`  Atmosphere: ${scene.atmosphere}`);
    if (typeof scene.tension_level === 'number' && Number.isFinite(scene.tension_level)) {
      const n = Math.min(10, Math.max(0, Math.round(scene.tension_level)));
      lines.push(`  Tension: ${TENSION[Math.max(0, n - 1)]} (${n}/10)`);
    }
    if (lines.length > 1) sections.push(lines.join('\n'));
  }

  const inc = d.include;
  const include: string[] = [];
  if (any(inc?.characters)) include.push(`  Characters: ${inc.characters.join(', ')}`);
  if (any(inc?.themes)) include.push(`  Themes to touch on: ${inc.themes.join(', ')}`);
  if (any(inc?.sensoryDetails)) include.push(`  Sensory emphasis: ${inc.sensoryDetails.join(', ')}`);
  if (any(inc?.foreshadowing)) include.push(`  Subtle details to weave in: ${inc.foreshadowing.join('; ')}`);
  if (include.length > 0) sections.push(['Include in this response:', ...include].join('\n'));

  const av = d.avoid;
  const avoid: string[] = [];
  if (any(av?.topics)) avoid.push(`  Topics: ${av.topics.join(', ')}`);
  if (any(av?.characters)) avoid.push(`  Keep offscreen: ${av.characters.join(', ')}`);
  if (any(av?.revelations)) avoid.push(`  Don't reveal: ${av.revelations.join(', ')}`);
  if (avoid.length > 0) sections.push(['Avoid in this response:', ...avoid].join('\n'));

  if (has(d.narrativeGoal)) sections.push(`Narrative Goal: ${d.narrativeGoal}`);
  if (any(d.arcDirections)) {
    sections.push(['Story Arc Directions:', ...d.arcDirections.map((a) => `  - "${a.arcName}" (${a.urgency}): ${a.instruction}`)].join('\n'));
  }
  if (any(d.callbacks)) {
    sections.push(['Callbacks to weave in:', ...d.callbacks.map((c) => `  - Reference "${c.reference}": ${c.instruction}`)].join('\n'));
  }
  if (any(d.characterBeats)) {
    sections.push(['Character Beats:', ...d.characterBeats.map((b) => `  - ${b.character}: ${b.beat}${has(b.motivation) ? ` (${b.motivation})` : ''}`)].join('\n'));
  }
  if (any(d.dialogueGuidance)) {
    sections.push(['Dialogue guidance:', ...d.dialogueGuidance.map((g) => `  ${g.character}: ${g.tone}${any(g.hints) ? ` (${g.hints.join(', ')})` : ''}`)].join('\n'));
  }
  if (has(d.endingHook)) sections.push(`[Ending: ${d.endingHook}]`);
  if (sections.length === 0) return '';
  return `${PREAMBLE}\n\n${sections.join('\n\n')}\n${DIRECTOR_FOOTER}`;
}

/** The standing authority contract (RoleCall buildNarratorSystemAddition, as Bunraku wrote it). */
export const NARRATOR_AUTHORITY = `## Story Director Authority - CONTRACTUAL

A block labeled ${DIRECTOR_HEADER} is injected into every
turn. Treat it as contractual, not advisory.

BINDING RULES:
1. If the constraints specify Arc Directions, you MUST advance those named
   storylines exactly as instructed. You do NOT get to decide which arc to
   progress - the Director has decided.
2. If the constraints specify Callbacks, you MUST weave them in. You do NOT
   get to decide which past event to reference - the Director has decided.
3. If the constraints specify Character Beats, you MUST hit them. You do NOT
   get to substitute a different emotional beat for a character.
4. If the constraints specify a Narrative Goal, the scene MUST work toward it.
5. Mood, pacing, and tone from the constraints override any default tendencies.
6. The "avoid" list is absolute - topics and revelations listed there do not
   appear in this turn, period.

WHAT YOU STILL DECIDE:
- The actual PROSE: sentence rhythm, word choice, imagery, dialogue phrasing.
- HOW the constraints are rendered - the *craft* is yours, the *what* is not.
- Character voice consistency within the beats you were given.
- Minor sensory details and environmental texture not specified.

WHAT YOU DO NOT DECIDE:
- Which arc to progress (Director decides)
- Which callback to surface (Director decides)
- Whether to resolve or delay a plot thread (Director decides)
- Whether to deliver a seed payoff (Director decides)

If a "framing grade" protocol or internal evaluation system tells you to pick
an arc to advance or decide what thread to pull - DEFER to the Director
Constraints block instead. The Director has already done that planning and
your job is to execute, not re-plan.

NEVER acknowledge the Director block or break the fourth wall. The reader
never sees it. You render clean prose that honors every constraint listed.`;

/**
 * The contract's last line [D-120]: the directive is English, the story may not be (a live run saw a
 * 12B narrator start mixing English into a Russian story from the first English directive on).
 */
export const LANGUAGE_LINE = 'Write the story in the language it is already written in; these constraints are in English only for you.';

/**
 * The contract for the core block [D-106]: NARRATOR_AUTHORITY plus one line for the persona (§7.3)
 * and, right after it, the language line (D-120). An empty name reads "the player"; whitespace in the
 * name is collapsed so the persona line stays one line.
 */
export function contractText(personaName: string): string {
  const who = personaName.replace(/\s+/g, ' ').trim() || 'the player';
  return `${NARRATOR_AUTHORITY}\n\nNEVER act, speak or decide for ${who}.\n${LANGUAGE_LINE}`;
}

// ---- the persona filter [D-112] -----------------------------------------------------------------------
//
// A text "claims" the persona's inner state when one of these holds around a mention of a name
// (every name and alias; a Russian one in any singular case form, see nameWord):
// - bare, the persona is the subject: NAME as written (the nominative) [≤ 3 FILLERS] VERB:
//   "Merlin realizes", "Елисей не знает", "Елисей вдруг понимает"; or the dative experiencer:
//   NAME in the dative [≤ 3 FILLERS] EXPERIENCER: "Елисею кажется", "Елисею страшно". Another case
//   before a verb is someone else's subject: "Брат Елисея думает" (the brother thinks) is kept;
// - verbed, an order to make the persona think: LEAD [≤ 2 words] NAME (any case) ('s)? [≤ 3 words]
//   VERB: "Have Merlin notice", "Заставь Елисея вспомнить", "Дай Елисею понять";
// - possessive, the persona's inner life: NAME('s|’s|s) NOUN_EN, or NAME('s) "inner"/"methodical" +
//   any word: "Merlin's thoughts"; NOUN_RU NAME (any case): "мысли Елисея", "страх Елисея".
// The words of a pattern are whole words (runs of isLoreWordChar code points) with only whitespace
// between them; a comma or any other mark breaks the chain, as Bunraku's \s+ did. All lists are
// compared with the folded word. Russian verbs are listed as explicit forms (present / future 3rd
// person, past, infinitive): normalizeTerm cuts no verb endings beyond the reflexive ones, so stems
// would not unite them. FILLERS are Russian only: the English bare pattern stays Bunraku's.
// Known false positives: a verbed order about someone of the persona's ("Have Merlin's brother
// decide", Bunraku's too; "Пусть брат Елисея решит"); Надежда or Любовь as an NPC right before the
// persona's name ("Надежда Елисея ждёт").
// Known misses: dative/genitive constructions with the noun after a verb ("сомнения мучают Елисея"),
// fleeting vowels in names (Павел/Павла, Лев/Льва), adjective names ("Хромой"), two-letter names
// (not inflected), "кажется" with a nominative name (kept on purpose: "Елисей кажется усталым" is a
// look, not a thought).

/** Bunraku's English interiority verbs (116 forms); staging verbs (find, place, enter, reach) are absent. */
const EN_VERBS = `
  think thinks thinking thought wonder wonders wondering wondered consider considers considering considered
  realize realizes realizing realized understand understands understanding understood recognize recognizes
  recognizing recognized know knows knowing knew suspect suspects suspecting suspected believe believes
  believing believed doubt doubts doubting doubted contemplate contemplates contemplating contemplated
  ponder ponders pondering pondered remember remembers remembering remembered recall recalls recalling
  recalled reminisce reminisces reminiscing reminisced notice notices noticing noticed sense senses sensing
  sensed perceive perceives perceiving perceived intuit intuits intuiting intuited feel feels feeling felt
  experience experiences experiencing experienced fear fears fearing feared want wants wanting wanted hope
  hopes hoping hoped trust trusts trusting trusted decide decides deciding decided choose chooses choosing
  chose process processes processing processed reflect reflects reflecting reflected`;

/**
 * Russian interiority verbs: cognition, memory, the inner side of perception, emotion, volition.
 * Present and perfective future in the 3rd person, past (m, f, pl), infinitive. Seeing and hearing
 * are absent, as in the English list.
 */
export const RU_INTERIORITY_VERBS: readonly string[] = words(`
  думает думают думал думала думали думать подумает подумают подумал подумала подумали подумать
  задумывается задумываются задумывался задумывалась задумывались задумываться
  задумается задумаются задумался задумалась задумались задуматься
  размышляет размышляют размышлял размышляла размышляли размышлять
  понимает понимают понимал понимала понимали понимать поймёт поймут понял поняла поняли понять
  осознаёт осознают осознавал осознавала осознавали осознавать осознает осознал осознала осознали осознать
  знает знают знал знала знали знать
  узнаёт узнают узнавал узнавала узнавали узнавать узнает узнал узнала узнали узнать
  догадывается догадываются догадывался догадывалась догадывались догадываться
  догадается догадаются догадался догадалась догадались догадаться
  верит верят верил верила верили верить поверит поверят поверил поверила поверили поверить
  подозревает подозревают подозревал подозревала подозревали подозревать
  сомневается сомневаются сомневался сомневалась сомневались сомневаться
  усомнится усомнятся усомнился усомнилась усомнились усомниться
  решает решают решал решала решали решать решит решат решил решила решили решить
  выбирает выбирают выбирал выбирала выбирали выбирать выберет выберут выбрал выбрала выбрали выбрать
  намерен намерена намерены
  помнит помнят помнил помнила помнили помнить
  вспоминает вспоминают вспоминал вспоминала вспоминали вспоминать вспомнит вспомнят вспомнил вспомнила вспомнили вспомнить
  замечает замечают замечал замечала замечали замечать заметит заметят заметил заметила заметили заметить
  чувствует чувствуют чувствовал чувствовала чувствовали чувствовать
  почувствует почувствуют почувствовал почувствовала почувствовали почувствовать
  ощущает ощущают ощущал ощущала ощущали ощущать ощутит ощутят ощутил ощутила ощутили ощутить
  предчувствует предчувствуют предчувствовал предчувствовала предчувствовали предчувствовать
  боится боятся боялся боялась боялись бояться испугается испугаются испугался испугалась испугались испугаться
  опасается опасаются опасался опасалась опасались опасаться
  надеется надеются надеялся надеялась надеялись надеяться
  хочет хотят хотел хотела хотели хотеть захочет захотят захотел захотела захотели захотеть
  желает желают желал желала желали желать
  мечтает мечтают мечтал мечтала мечтали мечтать
  любит любят любил любила любили любить полюбит полюбят полюбил полюбила полюбили полюбить
  ненавидит ненавидят ненавидел ненавидела ненавидели ненавидеть возненавидит возненавидел возненавидела возненавидеть
  жалеет жалеют жалел жалела жалели жалеть пожалеет пожалеют пожалел пожалела пожалели пожалеть
  сожалеет сожалеют сожалел сожалела сожалели сожалеть
  переживает переживают переживал переживала переживали переживать
  волнуется волнуются волновался волновалась волновались волноваться
  тревожится тревожатся тревожился тревожилась тревожились тревожиться
  доверяет доверяют доверял доверяла доверяли доверять
  скучает скучают скучал скучала скучали скучать
  грустит грустят грустил грустила грустили грустить
  злится злятся злился злилась злились злиться
  стыдится стыдятся стыдился стыдилась стыдились стыдиться
  радуется радуются радовался радовалась радовались радоваться
  удивляется удивляются удивлялся удивлялась удивлялись удивляться удивится удивятся удивился удивилась удивились удивиться
  колеблется колеблются колебался колебалась колебались колебаться`);

/** Russian words whose experiencer is in the dative ("Елисею кажется"): counted only after a dative name. */
const RU_EXPERIENCER = words(`
  кажется казалось покажется показалось хочется хотелось захочется захотелось
  снится снилось приснилось чудится чудилось почудилось
  страшно жаль стыдно грустно тоскливо обидно тревожно любопытно`);

/** Bunraku's possessive nouns ("Merlin's thoughts"). */
const EN_NOUNS = words(`
  thought thoughts mind thinking memory memories feeling feelings past interiority emotion emotions
  perspective consciousness introspection reflection reflections reverie intuition suspicion suspicions
  belief beliefs doubt doubts fear fears hope hopes desire desires`);
/** "Merlin's inner turmoil", "Merlin's methodical thinking": these take any next word. */
const EN_NOUN_HEADS = words('inner methodical');

/** Russian inner-state nouns, by declension: [stem, endings]; the forms are stem + ending. */
const RU_NOUN_DECLENSIONS: readonly (readonly [string, readonly string[]])[] = [
  ['страх гнев стыд разум', ['', 'а', 'у', 'ом', 'е', 'ы', 'ов', 'ам', 'ами', 'ах']],
  ['надежд мечт тревог догадк обид тоск душ', ['', 'а', 'ы', 'и', 'е', 'у', 'ой', 'ою', 'ам', 'ами', 'ах']],
  ['мысл памят ненавист ревност груст радост любов', ['ь', 'и', 'ью', 'ей', 'ям', 'ями', 'ях']],
  [
    'сомнени желани воспоминани подозрени убеждени намерени переживани ощущени сожалени сознани решени',
    ['е', 'я', 'ю', 'ем', 'и', 'й', 'ям', 'ями', 'ях'],
  ],
  ['чувств', ['', 'о', 'а', 'у', 'ом', 'е', 'ам', 'ами', 'ах']],
  ['эмоци интуици', ['я', 'и', 'ю', 'ей', 'й', 'ям', 'ями', 'ях']],
];
const RU_NOUNS = new Set([
  ...RU_NOUN_DECLENSIONS.flatMap(([stems, ends]) => words(stems).flatMap((s) => ends.map((e) => s + e))),
  'любви',
]);

/** Words that open an order to stage the persona's mind ("Have Merlin…", "Заставь Елисея…"). */
const LEADS = words(`
  have let make show push force prompt
  пусть пускай дай дайте дать позволь позвольте позволить заставь заставьте заставить
  покажи покажите показать помоги помогите помочь вынуди вынудите подтолкни подтолкните`);

/** Russian particles, adverbs and auxiliaries allowed between the name and the verb ("Елисей не знает"). */
const FILLERS = words(`
  не ни уже вдруг снова опять ещё всё наконец тоже также сразу давно долго молча тихо втайне
  внезапно явно медленно постепенно невольно смутно едва почти
  начинает начинают начал начала начали продолжает продолжают продолжал продолжала
  пытается пытаются пытался пыталась старается стараются старался старалась
  может могут мог могла могли должен должна будет будут`);

const VERBS = new Set([...words(EN_VERBS), ...RU_INTERIORITY_VERBS]);
const EXPERIENCER = new Set(RU_EXPERIENCER);
const NOUNS_EN = new Set(EN_NOUNS);
const NOUN_HEADS_EN = new Set(EN_NOUN_HEADS);
const LEAD_SET = new Set(LEADS);
const FILLER_SET = new Set(FILLERS);
const MAX_FILLERS = 3;

/** The folded words of a whitespace-separated list. */
function words(list: string): string[] {
  return list
    .split(/\s+/)
    .filter((w) => w !== '')
    .map(foldText);
}

const CYRILLIC_RE = /^\p{Script=Cyrillic}+$/u;
const SPACE_RE = /\s/;

/** Folded, whitespace collapsed: how a whole field is compared with a name. */
const nameKey = (s: string): string => foldText(s.trim()).replace(/\s+/g, ' ');

/** One word of a name: as written (folded), every form it is matched in, and which forms are datives. */
interface NameWord {
  base: string;
  forms: readonly string[];
  dative: ReadonlySet<string>;
}

/**
 * The forms a word of a name is found in. A Cyrillic word of ≥ 3 letters also in its singular case
 * forms, by its last letter (folded, so ё is е), the dative ones marked: й → й я ю ем е, dative ю
 * (Елисей); ь → ь я ю ем е и ью, dative ю и (Игорь, Любовь); а → а ы и е у ой ою, dative е (Мира,
 * Никита); я → я и е ю ей ею, dative е и (Илья, Мария); a consonant → the word, а у ом е ым, dative у
 * (Иван, Петров). No plural endings, so Иван never matches Иванов. Other words (Latin, other final
 * vowels, shorter) only as written.
 */
function nameWord(word: string): NameWord {
  const plain: NameWord = { base: word, forms: [word], dative: new Set() };
  if (word.length < 3 || !CYRILLIC_RE.test(word)) return plain;
  const last = word.slice(-1);
  let root = word.slice(0, -1);
  let ends: readonly string[];
  let dative: readonly string[];
  if (last === 'й') [ends, dative] = [['й', 'я', 'ю', 'ем', 'е'], ['ю']];
  else if (last === 'ь') [ends, dative] = [['ь', 'я', 'ю', 'ем', 'е', 'и', 'ью'], ['ю', 'и']];
  else if (last === 'а') [ends, dative] = [['а', 'ы', 'и', 'е', 'у', 'ой', 'ою'], ['е']];
  else if (last === 'я') [ends, dative] = [['я', 'и', 'е', 'ю', 'ей', 'ею'], ['е', 'и']];
  else if (!'еиоуыэю'.includes(last)) {
    root = word;
    [ends, dative] = [['', 'а', 'у', 'ом', 'е', 'ым'], ['у']];
  } else return plain;
  return { base: word, forms: [...new Set(ends.map((e) => root + e))], dative: new Set(dative.map((e) => root + e)) };
}

interface Persona {
  /** nameKey of every name: a beat, a line or an include entry for one of these is the persona's. */
  exact: ReadonlySet<string>;
  /** Each name as its words, for finding it in a text. */
  names: readonly (readonly NameWord[])[];
}

function personaOf(names: readonly string[]): Persona | null {
  const keys = [...new Set(names.filter((n) => typeof n === 'string').map(nameKey).filter((n) => n !== ''))];
  if (keys.length === 0) return null;
  return { exact: new Set(keys), names: keys.map((k) => k.split(' ').map(nameWord)) };
}

interface Mention {
  start: number;
  end: number;
  /** Every word as written: the name can be a subject. */
  nominative: boolean;
  /** The last word in a dative form (Елисею): the name can be an experiencer. */
  dative: boolean;
}

/** Where a name stands in the folded text: whole words only, word edges checked by code point. */
function mentions(text: string, name: readonly NameWord[]): Mention[] {
  const out: Mention[] = [];
  const first = name[0] as NameWord;
  const extend = (k: number, start: number, pos: number, nominative: boolean, dative: boolean): void => {
    if (k === name.length) {
      // The name ends here, or a possessive "s" follows it ("Merlins mind").
      const next = charAt(text, pos);
      if (isLoreWordChar(next) && !(next === 's' && !isLoreWordChar(charAt(text, pos + 1)))) return;
      out.push({ start, end: pos, nominative, dative });
      return;
    }
    const at = spaceEnd(text, pos);
    if (at === pos) return;
    const word = name[k] as NameWord;
    for (const f of word.forms) if (text.startsWith(f, at)) extend(k + 1, start, at + f.length, nominative && f === word.base, word.dative.has(f));
  };
  for (const f of first.forms) {
    for (let i = text.indexOf(f); i >= 0; i = text.indexOf(f, i + 1)) {
      if (!isLoreWordChar(charBefore(text, i))) extend(1, i, i + f.length, f === first.base, first.dative.has(f));
    }
  }
  return out;
}

function spaceEnd(text: string, i: number): number {
  let j = i;
  while (j < text.length && SPACE_RE.test(text.charAt(j))) j++;
  return j;
}

function spaceStart(text: string, i: number): number {
  let j = i;
  while (j > 0 && SPACE_RE.test(text.charAt(j - 1))) j--;
  return j;
}

interface Span {
  start: number;
  end: number;
  word: string;
}

/** The whole word after whitespace at `pos`; null when no whitespace or no word follows. */
function nextWord(text: string, pos: number): Span | null {
  const start = spaceEnd(text, pos);
  if (start === pos) return null;
  let end = start;
  for (let ch = charAt(text, end); isLoreWordChar(ch); ch = charAt(text, end)) end += ch.length;
  return end > start ? { start, end, word: text.slice(start, end) } : null;
}

/** The whole word before whitespace that ends at `pos`; null when no whitespace or no word precedes. */
function prevWord(text: string, pos: number): Span | null {
  const end = spaceStart(text, pos);
  if (end === pos) return null;
  let start = end;
  for (let ch = charBefore(text, start); isLoreWordChar(ch); ch = charBefore(text, start)) start -= ch.length;
  return start < end ? { start, end, word: text.slice(start, end) } : null;
}

/** Past an English possessive right after the name ('s, ’s or a bare s), else `pos` itself. */
function possessiveEnd(text: string, pos: number): number {
  if ((text.startsWith("'s", pos) || text.startsWith('’s', pos)) && !isLoreWordChar(charAt(text, pos + 2))) return pos + 2;
  if (text.charAt(pos) === 's' && !isLoreWordChar(charAt(text, pos + 1))) return pos + 1;
  return pos;
}

/** Does the text around this mention claim the persona's inner state (see the patterns above)? */
function claimsAt(text: string, m: Mention): boolean {
  // bare
  let w = nextWord(text, m.end);
  for (let k = 0; w !== null && k <= MAX_FILLERS; k++) {
    if ((m.nominative && VERBS.has(w.word)) || (m.dative && EXPERIENCER.has(w.word))) return true;
    if (!FILLER_SET.has(w.word)) break;
    w = nextWord(text, w.end);
  }
  // possessive, English
  const after = possessiveEnd(text, m.end);
  if (after > m.end) {
    const noun = nextWord(text, after);
    if (noun !== null && (NOUNS_EN.has(noun.word) || (NOUN_HEADS_EN.has(noun.word) && nextWord(text, noun.end) !== null))) return true;
  }
  // possessive, Russian
  const before = prevWord(text, m.start);
  if (before !== null && RU_NOUNS.has(before.word)) return true;
  // verbed: a lead at most three words back, a verb at most four words on
  let lead = false;
  for (let b = before, k = 0; b !== null && k < 3 && !lead; b = prevWord(text, b.start), k++) lead = LEAD_SET.has(b.word);
  if (!lead) return false;
  for (let v = nextWord(text, after), k = 0; v !== null && k < 4; v = nextWord(text, v.end), k++) if (VERBS.has(v.word)) return true;
  return false;
}

/** Does the text claim what the persona thinks, feels, notices, remembers or decides? */
function claims(text: string | undefined, p: Persona): boolean {
  if (!has(text)) return false;
  const folded = foldText(text);
  return p.names.some((name) => mentions(folded, name).some((m) => claimsAt(folded, m)));
}

/**
 * The directive without what belongs to the player [D-112]: the persona's character beats, dialogue
 * guidance and place in include.characters, and every arc direction, callback and beat that claims
 * the persona's inner state. `names` = the persona's name and aliases; none → the directive as is.
 * endingHook, narrativeGoal, sceneGuidance, avoid, arcName and reference are not filtered (Bunraku;
 * the planner checks the first two by "THE TEST"). Every removal is a `skipped` entry, why 'persona'.
 */
export function sanitizeForPlayerCharacter(d: NarratorDirective, names: readonly string[]): { directive: NarratorDirective; skipped: Skip[] } {
  const p = personaOf(names);
  if (p === null) return { directive: d, skipped: [] };
  const skipped: Skip[] = [];
  const isPersona = (s: string | undefined): boolean => typeof s === 'string' && p.exact.has(nameKey(s));
  /** The list without the dropped entries (each skipped), undefined when emptied, the same list when untouched. */
  const keep = <T>(list: readonly T[] | undefined, path: string, drop: (x: T) => boolean): T[] | undefined => {
    if (!Array.isArray(list)) return list as T[] | undefined;
    const kept: T[] = [];
    list.forEach((x, i) => {
      if (drop(x)) skipped.push({ path: `${path}[${i}]`, why: 'persona' });
      else kept.push(x);
    });
    if (kept.length === list.length) return list as T[];
    return kept.length > 0 ? kept : undefined;
  };

  const out: NarratorDirective = { ...d };
  const set = <K extends 'characterBeats' | 'dialogueGuidance' | 'include' | 'arcDirections' | 'callbacks'>(key: K, value: NarratorDirective[K]): void => {
    if (value === undefined) delete out[key];
    else out[key] = value;
  };
  if (d.characterBeats) {
    set('characterBeats', keep(d.characterBeats, 'directive.characterBeats', (b) => isPersona(b.character) || claims(b.beat, p) || claims(b.motivation, p)));
  }
  if (d.dialogueGuidance) set('dialogueGuidance', keep(d.dialogueGuidance, 'directive.dialogueGuidance', (g) => isPersona(g.character)));
  if (d.include?.characters) {
    const characters = keep(d.include.characters, 'directive.include.characters', isPersona);
    if (characters !== d.include.characters) {
      const { characters: _gone, ...rest } = d.include;
      const include = characters ? { ...rest, characters } : rest;
      set('include', Object.values(include).some((v) => any(v)) ? include : undefined);
    }
  }
  if (d.arcDirections) set('arcDirections', keep(d.arcDirections, 'directive.arcDirections', (a) => claims(a.instruction, p)));
  if (d.callbacks) set('callbacks', keep(d.callbacks, 'directive.callbacks', (c) => claims(c.instruction, p)));
  return skipped.length === 0 ? { directive: d, skipped } : { directive: out, skipped };
}

// ---- the event summary [D-105] ------------------------------------------------------------------------

/** Deep equality of JSON-shaped values (key order ignored). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * What a planning turn changed, for `planned{summary}` / `reused{summary}`:
 * `arcs +1 ~2 · seeds +1 ~1 -1 · hidden +1 ~1 · chapter 2`, only the non-zero parts; 'no changes' when
 * none. +N: ids new in `next`; arcs ~N: arcs in both whose stages, status or next beat changed; seeds
 * ~N: seeds in both with a newer reinforcement and not paid off now (D-123); seeds -N: seeds unpaid in
 * `prev` that `next` has paid off or no longer has; hidden ~N: hidden arcs in both with a new last
 * clue, a new last stage or another status (D-123: surfaced and resolved ones included); chapter N:
 * the chapter that became current (by number; from the id 'chapter-N' when the chapter is not in the
 * list). Lists fitState only shortened (their last entry kept) are not a change.
 */
export function summaryOf(prev: DirectorState, next: DirectorState): string {
  const parts: string[] = [];
  const group = (label: string, counts: readonly (readonly [string, number])[]): void => {
    const shown = counts.filter(([, n]) => n > 0).map(([sign, n]) => `${sign}${n}`);
    if (shown.length > 0) parts.push(`${label} ${shown.join(' ')}`);
  };

  const prevArcs = new Map(prev.arcs.map((a) => [a.id, a]));
  let arcsNew = 0;
  let arcsChanged = 0;
  for (const a of next.arcs) {
    const before = prevArcs.get(a.id);
    if (before === undefined) arcsNew++;
    else if (before.status !== a.status || !same(before.stages, a.stages) || !same(before.nextBeat, a.nextBeat)) arcsChanged++;
  }
  group('arcs', [['+', arcsNew], ['~', arcsChanged]]);

  const prevSeeds = new Map(prev.seeds.map((s) => [s.id, s]));
  const nextSeeds = new Map(next.seeds.map((s) => [s.id, s]));
  const seedsNew = next.seeds.filter((s) => !prevSeeds.has(s.id)).length;
  const newest = (s: DirectorSeed): number => s.reinforcements[s.reinforcements.length - 1]?.turn ?? -1;
  const seedsReinforced = next.seeds.filter((s) => {
    const before = prevSeeds.get(s.id);
    return before !== undefined && !s.payoffDelivered && newest(s) > newest(before);
  }).length;
  const seedsGone = prev.seeds.filter((s) => !s.payoffDelivered && (nextSeeds.get(s.id)?.payoffDelivered ?? true)).length;
  group('seeds', [['+', seedsNew], ['~', seedsReinforced], ['-', seedsGone]]);

  const prevHidden = new Map(prev.invisibleArcs.map((h) => [h.id, h]));
  let hiddenNew = 0;
  let hiddenChanged = 0;
  for (const h of next.invisibleArcs) {
    const before = prevHidden.get(h.id);
    if (before === undefined) hiddenNew++;
    else if (before.status !== h.status || !same(before.playerClues.at(-1), h.playerClues.at(-1)) || !same(before.stages.at(-1), h.stages.at(-1))) hiddenChanged++;
  }
  group('hidden', [['+', hiddenNew], ['~', hiddenChanged]]);

  const chapterId = next.currentChapterId;
  if (chapterId !== undefined && chapterId !== prev.currentChapterId) {
    const number = next.chapters.find((c) => c.id === chapterId)?.number ?? Number(/^chapter-(\d+)$/.exec(chapterId)?.[1]);
    if (Number.isFinite(number)) parts.push(`chapter ${number}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'no changes';
}
