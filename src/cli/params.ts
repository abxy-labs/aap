import type { FlagValue } from "../lib/args.ts";
import { UsageError } from "../lib/args.ts";

/** Leaf keys whose values are comma-separated lists. */
const ARRAY_KEYS = new Set([
  "scopes", "enabled_events", "acknowledged", "viewed", "expand", "types", "issuers", "claims",
  "deny_agents", "operators", "agents", "disclose", "gates",
]);

/** Leaf keys that look numeric but are strings. */
const STRING_KEYS = new Set([
  "subject", "id", "origin", "session", "agent", "delegation", "terms", "handoff", "name", "description", "url", "code", "ref",
  "application", "memo", "payee", "intent", "channel", "accepted_at", "copies_sent_to", "vetting", "session_handling", "type", "status",
  "starting_after", "ending_before", "from", "to", "outcome", "provider", "reference", "currency", "bundle", "title", "format", "sha256", "text",
]);

const GLOBAL = new Set(["api-key", "api-base", "profile", "live", "json", "expand", "idempotency-key", "api-version", "store", "port", "out", "quiet", "help", "h", "d", "data", "timeout", "interval", "forward-to", "events"]);

function convert(leaf: string, v: string | boolean): unknown {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (v.startsWith("@")) return JSON.parse(require("node:fs").readFileSync(v.slice(1), "utf8"));
  if (ARRAY_KEYS.has(leaf)) return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (/^-?\d+$/.test(v) && !STRING_KEYS.has(leaf)) return Number(v);
  return v;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    const key: string | number = /^\d+$/.test(seg) ? Number(seg) : seg;
    const isLast = i === path.length - 1;
    if (isLast) {
      (cur as Record<string | number, unknown>)[key] = value;
      return;
    }
    const nextSeg = path[i + 1]!;
    const container = (cur as Record<string | number, unknown>)[key];
    if (container === undefined || typeof container !== "object" || container === null) {
      (cur as Record<string | number, unknown>)[key] = /^\d+$/.test(nextSeg) ? [] : {};
    }
    cur = (cur as Record<string | number, unknown>)[key] as Record<string, unknown> | unknown[];
  }
}

/** Turn dotted flags into a nested request body. `--a.b x` becomes `{a:{b:"x"}}`; `--items.0.k v` builds an array. */
export function paramsFromFlags(flags: Record<string, FlagValue>, skip: Iterable<string> = []): Record<string, unknown> {
  const skipSet = new Set([...GLOBAL, ...skip]);
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(flags)) {
    if (skipSet.has(name)) continue;
    const path = name.replace(/-/g, "_").split(".");
    const leaf = path[path.length - 1]!;
    const value = Array.isArray(raw) ? raw.map((v) => convert(leaf, v)) : convert(leaf, raw);
    setPath(out, path, value);
  }
  const data = flags.data ?? flags.d;
  if (typeof data === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new UsageError("--data must be a JSON object");
    }
    Object.assign(out, parsed as Record<string, unknown>);
  }
  return out;
}

export function parseDuration(v: string | undefined, fallbackS: number): number {
  if (v === undefined) return fallbackS;
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(v.trim());
  if (!m) throw new UsageError(`cannot parse duration '${v}' (use 30s, 15m, 2h, 30d)`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms": return n / 1000;
    case "m": return n * 60;
    case "h": return n * 3600;
    case "d": return n * 86400;
    default: return n;
  }
}
