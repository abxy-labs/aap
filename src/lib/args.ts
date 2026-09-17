export type FlagValue = string | boolean | (string | boolean)[];

export interface Parsed {
  positional: string[];
  flags: Record<string, FlagValue>;
}

/** Parse `--name value`, `--name=value`, bare `--name` (true), and repeated flags (collected into a list). */
export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};
  const push = (name: string, value: string | boolean) => {
    const prev = flags[name];
    if (prev === undefined) flags[name] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else flags[name] = [prev, value];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) { push(a.slice(2, eq), a.slice(eq + 1)); continue; }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !(next.startsWith("--") && next.length > 2)) { push(name, next); i++; }
      else push(name, true);
    } else if (a.startsWith("-") && a.length === 2) {
      const name = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) { push(name, next); i++; }
      else push(name, true);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function last(v: FlagValue | undefined): string | boolean | undefined {
  if (Array.isArray(v)) return v[v.length - 1];
  return v;
}

export function str(flags: Record<string, FlagValue>, name: string, required = false): string | undefined {
  const v = last(flags[name]);
  if (v === undefined || v === true) {
    if (required) throw new UsageError(`--${name} is required`);
    return undefined;
  }
  return String(v);
}

export function all(flags: Record<string, FlagValue>, name: string): string[] {
  const v = flags[name];
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
}

export function list(flags: Record<string, FlagValue>, name: string): string[] | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function num(flags: Record<string, FlagValue>, name: string): number | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
  return n;
}

export function bool(flags: Record<string, FlagValue>, name: string): boolean {
  const v = last(flags[name]);
  return v === true || v === "true";
}

export class UsageError extends Error {}
