// The M3 demo chat (README.md here): loaders and a seeding helper for tests (not a test file itself).
// A seeded session is built through the public engine API only: createSession from the card and the
// persona (the greeting is #1), then send + runTurn per exchange, answered by an in-process provider
// that replies with the fixture's text. No model call, no network.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine, type EngineSeams } from '../../../../src/engine/engine.ts';
import type { Connection, EngineHandle, EngineOptions, SessionHandle } from '../../../../src/engine/api.ts';
import { parseCardObject } from '../../../../src/formats/card.ts';
import { validatePersona, type Character, type Persona } from '../../../../src/formats/native.ts';
import { createScriptedProvider, SCRIPT_CAPS } from '../../../../src/providers/scripted.ts';
import type { ModelCaps, ModelRequest, Provider, ProviderEnv, StreamEv } from '../../../../src/providers/types.ts';
import type { Binding, DeepPartial, SessionConfig } from '../../../../src/session/entries.ts';
import { fakeClock, fakeRandom } from '../../../helpers.ts';

export const INNKEEPER_DIR = import.meta.dir;

/** Message #200 of the demo (ARCHITECTURE.md §15). Not in the fixture: tests send it. */
export const INNKEEPER_QUESTION = 'как, по словам трактирщицы, звали её брата?';
/** The answer: the brother's name, as #5 writes it (nominative). */
export const INNKEEPER_BROTHER = 'Тихон';
/** 1-based number of the only message that names the brother («…с младшим братом — его зовут Тихон…»). */
export const INNKEEPER_MENTION = 5;
/** The demo's note (§15 "a /memory add note with key «брат» fires on «брата»"). */
export const INNKEEPER_NOTE = { title: 'Брат Марфы', keys: ['брат'], content: 'Младшего брата Марфы зовут Тихон.' } as const;

/** Default id of the seeding connection (innkeeperConnection) and the model its answers record. */
export const SEED_CONNECTION = 'innkeeper';
export const SEED_MODEL = 'fixture';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface InnkeeperFixture {
  /** card.json as stored (a CCv2 card). */
  card: unknown;
  /** The card imported (formats/card.ts). */
  character: Character;
  persona: Persona;
  /** 199 messages, #1 the greeting (assistant), then user/assistant pairs. */
  messages: ChatMessage[];
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(INNKEEPER_DIR, name), 'utf8')) as unknown;
}

let cached: InnkeeperFixture | undefined;

/** The fixture files, parsed and imported once per process. Treat the result as read-only. */
export function loadInnkeeper(): InnkeeperFixture {
  if (cached) return cached;
  const card = readJson('card.json');
  const character = parseCardObject(card).value;
  const checked = validatePersona(readJson('persona.json'));
  if (!checked.ok) throw new Error(`persona.json: ${checked.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
  const { messages } = readJson('chat.json') as { messages: ChatMessage[] };
  cached = { card, character, persona: checked.value, messages };
  return cached;
}

const textOf = (blocks: readonly { k: string; text?: string }[]): string =>
  blocks.reduce((s, b) => (b.k === 'text' ? s + (b.text ?? '') : s), '');

/**
 * A provider that answers a request whose LAST user message is a fixture user message with the
 * fixture's next message (one text delta, finish 'end', no usage). Any other request goes to `then`,
 * or fails with 'script_exhausted' when there is none. Stateless: one instance can seed any number of
 * sessions, and `then` can answer the turns that follow (e.g. the #200 question).
 */
export function innkeeperProvider(then?: Provider): Provider {
  const { messages } = loadInnkeeper();
  const replies = new Map<string, string>();
  for (let i = 1; i + 1 < messages.length; i += 2) replies.set(messages[i]!.text, messages[i + 1]!.text);
  const replyTo = (req: ModelRequest): string | undefined => {
    const last = req.messages.findLast((m) => m.role === 'user');
    if (!last) return undefined;
    const text = textOf(last.blocks);
    const exact = replies.get(text);
    if (exact !== undefined) return exact;
    // A preset may wrap the user message: accept the one fixture message it contains.
    for (const [user, reply] of replies) if (text.includes(user)) return reply;
    return undefined;
  };
  return {
    stream(req: ModelRequest, env: ProviderEnv): AsyncIterable<StreamEv> {
      const reply = replyTo(req);
      if (reply !== undefined) return createScriptedProvider([{ steps: [{ text: reply }] }]).stream(req, env);
      if (then) return then.stream(req, env);
      const message = 'innkeeper fixture: the last user message is not a fixture message';
      return createScriptedProvider([{ steps: [{ error: { code: 'script_exhausted', message } }] }]).stream(req, env);
    },
  };
}

/** An in-process connection on innkeeperProvider (SCRIPT_CAPS, tools off, unless `caps` says otherwise). */
export function innkeeperConnection(id = SEED_CONNECTION, opts: { caps?: ModelCaps; then?: Provider } = {}): Connection {
  return { id, provider: innkeeperProvider(opts.then), caps: opts.caps ?? SCRIPT_CAPS, origin: `script:${id}`, local: true };
}

export interface SeedOptions {
  /** The engine's connection whose provider is an innkeeperProvider. Default 'innkeeper'. */
  connection?: string;
  /** The model the seeded answers record (gen.model). Default 'fixture'. */
  model?: string;
  /** Seed messages #1..#upTo (odd, 1..199): the greeting and (upTo − 1) / 2 exchanges. Default 199. */
  upTo?: number;
  /** More session config (deep-merged); roles.narrator is the seeding binding while seeding. */
  config?: DeepPartial<SessionConfig>;
  /** The narrator binding left on the session afterwards (one config entry). Default: the seeding one. */
  narrator?: Binding;
  title?: string;
}

/** The binding the session gets at creation: the seeding connection, with opts.config's other settings. */
function seedConfig(opts: SeedOptions): DeepPartial<SessionConfig> {
  const narrator: Binding = { conn: opts.connection ?? SEED_CONNECTION, model: opts.model ?? SEED_MODEL };
  return { ...opts.config, roles: { ...opts.config?.roles, narrator } };
}

/**
 * Create a session from the fixture's card and persona and fill it with messages #1..#upTo, then
 * check the path against the fixture. Returns the open handle; the caller closes it.
 */
export async function seedInnkeeper(engine: Pick<EngineHandle, 'createSession'>, opts: SeedOptions = {}): Promise<SessionHandle> {
  const { character, persona, messages } = loadInnkeeper();
  const upTo = opts.upTo ?? messages.length;
  if (!Number.isInteger(upTo) || upTo < 1 || upTo > messages.length || upTo % 2 === 0) {
    throw new Error(`upTo must be odd, 1..${messages.length}; got ${upTo}`);
  }
  const s = engine.createSession({ character, persona, config: seedConfig(opts), title: opts.title ?? 'Сонный гусь' });
  for (let i = 1; i < upTo; i += 2) {
    const turn = s.submit({ text: messages[i]!.text, expectedVersion: s.version() });
    for await (const _ of turn.events) {
      // drained: the events are not needed, the outcome is
    }
    const out = await turn.result;
    if (out.type !== 'done') throw new Error(`seeding #${i + 2} did not finish: ${JSON.stringify(out)}`);
  }
  if (opts.narrator) s.configure({ roles: { narrator: opts.narrator } });
  // The path must be the fixture, byte for byte (the engine must not have trimmed or rewritten text).
  const path = s.view().path;
  const bad = path.findIndex((m, i) => m.role !== messages[i]?.role || textOf(m.blocks) !== messages[i]?.text);
  if (path.length !== upTo || bad >= 0) throw new Error(`seeded path differs from the fixture (length ${path.length}, first difference at #${bad + 1})`);
  return s;
}

/** seedInnkeeper, then close the session so the caller can open it (engine.session(id)). Returns its id. */
export async function seedInnkeeperSession(engine: Pick<EngineHandle, 'createSession'>, opts: SeedOptions = {}): Promise<string> {
  const s = await seedInnkeeper(engine, opts);
  await s.close();
  return s.id;
}

/**
 * Seed into `home` with an engine of its own (fake clock and random bytes, so the session file is the
 * same on every run; checkpoints off), then close it. For tests that open their own engine, or spawn
 * the CLI, on that home afterwards. Returns the session id.
 */
export async function seedInnkeeperHome(home: string, opts: SeedOptions & { engine?: Partial<EngineOptions> & EngineSeams } = {}): Promise<string> {
  const id = opts.connection ?? SEED_CONNECTION;
  const engine = await Engine.open({
    home,
    connections: { [id]: innkeeperConnection(id) },
    clock: fakeClock(),
    random: fakeRandom(200),
    timeZone: 'UTC',
    checkpoint: { chars: 1e9, ms: 1e9, datasyncMs: 1e9 },
    ...opts.engine,
  });
  try {
    return await seedInnkeeperSession(engine, opts);
  } finally {
    await engine.close();
  }
}
