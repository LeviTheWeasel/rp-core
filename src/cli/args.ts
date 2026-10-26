// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Strict command-line parsing for the CLI (ARCHITECTURE.md §19.2 cli/main.ts: "строгий разбор
// флагов"). Zero dependencies and pure: argv in, flags and positionals out, or a UsageError.
//
// Rules, chosen so a typo fails loudly instead of being taken as text:
// - `--name value` and `--name=value`; boolean flags refuse `=value`;
// - an unknown flag, a repeated flag or a missing value is an error, except that a 'list' flag
//   (`--lore a --lore b`) collects every value in order;
// - `--` ends the flags (everything after it is positional), a lone `-` is positional;
// - a value may start with `-` (guidance or a title can), but not with `--` + a known flag name,
//   which almost always means the value was forgotten.

/** A command-line mistake: printed with the command's usage, exit code 64. */
export class UsageError extends Error {
  /** The command whose usage should be shown, when known. */
  readonly command: string | undefined;
  constructor(message: string, command?: string) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
  }
}

/** 'list': a string flag that may be given more than once; its values are kept in order. */
export type FlagKind = 'bool' | 'string' | 'list';

/** Flag name (without dashes) → kind. Short aliases map a single letter to a long name. */
export interface FlagSpec {
  flags: Readonly<Record<string, FlagKind>>;
  short?: Readonly<Record<string, string>>;
}

export interface Parsed {
  /** bool → true, string → the value, list → every value in order. */
  flags: Record<string, string | true | string[]>;
  positionals: string[];
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Parse `argv` against `spec`. With `stopAtPositional`, parsing stops at the first positional and
 * the rest is returned untouched in `positionals` (used to find the command after global flags).
 */
export function parseArgs(argv: readonly string[], spec: FlagSpec, opts: { stopAtPositional?: boolean; command?: string } = {}): Parsed {
  const flags: Record<string, string | true | string[]> = {};
  const positionals: string[] = [];
  const fail = (msg: string): never => {
    throw new UsageError(msg, opts.command);
  };
  const looksLikeKnownFlag = (s: string): boolean => {
    if (!s.startsWith('--')) return false;
    const name = s.slice(2).split('=')[0] ?? '';
    return hasOwn(spec.flags, name);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      if (opts.stopAtPositional) {
        positionals.push(...argv.slice(i));
        break;
      }
      positionals.push(arg);
      continue;
    }

    let name: string;
    let inline: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    } else {
      // Short flags: exactly one letter (-h); bundling (-abc) is not supported on purpose.
      const letter = arg.slice(1);
      const long = spec.short && letter.length === 1 && hasOwn(spec.short, letter) ? spec.short[letter] : undefined;
      if (long === undefined) fail(`unknown flag ${arg}`);
      name = long!;
    }

    if (name === '' || !hasOwn(spec.flags, name)) fail(`unknown flag --${name}`);
    const kind = spec.flags[name];
    if (hasOwn(flags, name) && kind !== 'list') fail(`--${name} given twice`);
    const put = (value: string): void => {
      if (kind !== 'list') flags[name] = value;
      else flags[name] = [...((flags[name] as string[] | undefined) ?? []), value];
    };
    if (kind === 'bool') {
      if (inline !== undefined) fail(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    if (inline !== undefined) {
      put(inline);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || looksLikeKnownFlag(value) || value === '--') fail(`--${name} needs a value`);
    put(value!);
    i++;
  }
  return { flags, positionals };
}

/** The string value of a flag, or undefined. */
export function str(p: Parsed, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === 'string' ? v : undefined;
}

/** Every value of a 'list' flag, in order ([] when absent). */
export function list(p: Parsed, name: string): string[] {
  const v = p.flags[name];
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
}

/** Whether a boolean flag was given. */
export function bool(p: Parsed, name: string): boolean {
  return p.flags[name] === true;
}
