/**
 * [FND-06] Minimal CLI flag parser for the tools: --name value, --name=value, --flag (boolean).
 * Unknown flags throw so typos never silently run a 2,000-match soak with defaults.
 */
export type FlagType = 'number' | 'string' | 'boolean';
export type FlagSpec = Record<string, FlagType>;
export type FlagValues = Record<string, number | string | boolean | undefined>;

export interface ParsedArgs {
  flags: FlagValues;
  positionals: string[];
}

export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const flags: FlagValues = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    const type = spec[name];
    if (type === undefined) throw new Error(`unknown flag --${name} (known: ${Object.keys(spec).map((k) => `--${k}`).join(' ')})`);
    if (type === 'boolean') {
      flags[name] = eq >= 0 ? a.slice(eq + 1) !== 'false' : true;
      continue;
    }
    let raw: string | undefined;
    if (eq >= 0) raw = a.slice(eq + 1);
    else raw = argv[++i];
    if (raw === undefined) throw new Error(`flag --${name} needs a value`);
    if (type === 'number') {
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error(`flag --${name} needs a number, got "${raw}"`);
      flags[name] = v;
    } else flags[name] = raw;
  }
  return { flags, positionals };
}

export function num(f: FlagValues, name: string, dflt: number): number {
  const v = f[name];
  return typeof v === 'number' ? v : dflt;
}

export function str(f: FlagValues, name: string, dflt: string): string {
  const v = f[name];
  return typeof v === 'string' ? v : dflt;
}

export function bool(f: FlagValues, name: string): boolean {
  return f[name] === true;
}
