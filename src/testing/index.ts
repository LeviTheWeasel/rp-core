// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Test helpers exported as `rp-core/testing` (M9 grows this: record/replay, RecordStore conformance).

export { createScriptedProvider, parseScript, parseScriptFile, scriptCapsWith, hashRequest, SCRIPT_CAPS } from '../providers/scripted.ts';
export type { ScriptCall, ScriptStep, ScriptedProvider } from '../providers/scripted.ts';
export { checkRecordStoreConformance, MemoryRecordStore, FileRecordStore } from '../session/port.ts';
export type { RecordStore, Lease } from '../session/port.ts';
