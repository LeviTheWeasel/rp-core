// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The TUI's entry (TUI decisions T-2): main.ts loads this module with a dynamic import only for
// `rp-core tui` and `rp-core new --tui`, so no other command, test or library user loads OpenTUI's
// native library.

export { cmdTui, runTui, NEEDS_TERMINAL, type TuiArgs } from './run.ts';
