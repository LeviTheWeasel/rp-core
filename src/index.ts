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
  PreviewOptions,
  PreviewResult,
  RefusalCode,
  RunTurnOptions,
  SessionHandle,
  TurnHandle,
  TurnOutcome,
  GateAnswer,
} from './engine/api.ts';
export type { HostHooks, HookCtx, Placement } from './engine/hooks.ts';
export { HostHookError } from './engine/hooks.ts';
export type { RecordStore, Lease } from './session/port.ts';
export { FileRecordStore, MemoryRecordStore } from './session/port.ts';
export type { SessionStore } from './session/backend.ts';
export { FileSessionStore, MemorySessionStore } from './session/backend.ts';
export type { AsyncEngineHandle, AsyncSessionHandle } from './engine/record-engine.ts';
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
  ToolTraceRow,
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
  Replay,
  StreamEv,
  ToolSpec,
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

// M3: tools and search. The built-in tools and their types (the narrator's loop offers them; a host
// can run them itself, e.g. for its own search UI), what SessionHandle.search returns, the notes
// (SessionHandle.notes and the memory* verbs), lore verdicts (PreviewResult.verdicts) and the
// active probe the CLI's `probe --active` runs.
export type { Tool, ToolCall, ToolCallOutcome, ToolCtx, ToolOutput } from './tools/types.ts';
export { DEFAULT_TOOL_OUTPUT } from './tools/types.ts';
export { HISTORY_TOOLS, LORE_TOOLS, toolSpecs } from './tools/builtin/index.ts';
export type { HistoryHit, HistorySearch } from './tools/builtin/history.ts';
export type { CEntry, CompendiumView, MemEntry, MemOp } from './agents/compendium/types.ts';
export type { LoreVerdict } from './lore/engine.ts';
export { ACTIVE_PROBE_MAX_CALLS, ACTIVE_PROBE_MAX_TOKENS, ACTIVE_PROBE_TOKENS, runActiveProbes } from './providers/probe-active.ts';
export type { ActiveProbeInput, ActiveProbeResult, ProbeName, ProbeObservation, ProbeVerdict } from './providers/probe-active.ts';
