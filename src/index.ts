// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Public API of rp-core (ARCHITECTURE.md §4, §12.1).

export { Engine } from './engine/engine.ts';
export { Refusal } from './engine/api.ts';
export type {
  Connection,
  CreateSessionInput,
  EngineHandle,
  EngineOptions,
  RefusalCode,
  RunTurnOptions,
  SessionHandle,
  TurnHandle,
  TurnOutcome,
} from './engine/api.ts';
export type { Event, EventBody, EventType, Notice } from './protocol/events.ts';
export { TERMINAL_EVENTS } from './protocol/events.ts';
export type { MessageView, PathView } from './session/view.ts';
export type {
  Block,
  Binding,
  Entry,
  Generation,
  SessionConfig,
  SessionHeader,
  Trace,
  TurnKind,
  VarsDiff,
} from './session/entries.ts';
export { DEFAULT_SESSION_CONFIG } from './session/entries.ts';
export type { Character, LoreBook, LoreEntry, Persona, Preset, Samplers } from './formats/native.ts';
export { BUILTIN_PRESET } from './formats/native.ts';
export type {
  ModelCaps,
  ModelRequest,
  PromptMsg,
  Provider,
  StreamEv,
  Usage,
} from './providers/types.ts';
export { ProviderError } from './providers/types.ts';
export { createScriptedProvider, parseScript, SCRIPT_CAPS } from './providers/scripted.ts';
export type { ScriptCall, ScriptStep, ScriptedProvider } from './providers/scripted.ts';

// M1b: OpenAI-compatible connections, capability records, the catalog probe and config.toml, so a
// host can build the same connections the CLI does (or its own, with its own keys).
export { createOpenAIChatProvider } from './providers/openai-chat.ts';
export type { OpenAIChatOptions } from './providers/openai-chat.ts';
export { resolveCaps } from './providers/caps.ts';
export type { CapsInput } from './providers/caps.ts';
export { fetchCatalog, listModels, readCapsCache, writeCapsCache } from './providers/probe.ts';
export type { CapsCacheRow, CatalogInfo } from './providers/probe.ts';
export { buildConnections, CONFIG_TEMPLATE, ConfigError, configPath, loadConfig, parseConfig } from './config/config.ts';
export type { ConnectionConfig, PriceRow, RpConfig } from './config/config.ts';
export { createSecretResolver, scrub } from './config/secrets.ts';
export type { SecretResolver, SecretSpec } from './config/secrets.ts';
