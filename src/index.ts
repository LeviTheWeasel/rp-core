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
