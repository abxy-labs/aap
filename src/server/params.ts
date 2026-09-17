import { invalid } from "../lib/errors.ts";

type Body = Record<string, unknown>;

export function str(body: Body, name: string, required = false): string | undefined {
  const v = body[name];
  if (v === undefined || v === null) {
    if (required) throw invalid("parameter_missing", `Missing required parameter: ${name}.`, name);
    return undefined;
  }
  if (typeof v !== "string") throw invalid("parameter_invalid", `Parameter ${name} must be a string.`, name);
  return v;
}

export function num(body: Body, name: string, required = false): number | undefined {
  const v = body[name];
  if (v === undefined || v === null) {
    if (required) throw invalid("parameter_missing", `Missing required parameter: ${name}.`, name);
    return undefined;
  }
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw invalid("parameter_invalid", `Parameter ${name} must be a number.`, name);
  return n;
}

export function bool(body: Body, name: string): boolean | undefined {
  const v = body[name];
  if (v === undefined || v === null) return undefined;
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  throw invalid("parameter_invalid", `Parameter ${name} must be true or false.`, name);
}

export function list(body: Body, name: string, required = false): string[] | undefined {
  const v = body[name];
  if (v === undefined || v === null) {
    if (required) throw invalid("parameter_missing", `Missing required parameter: ${name}.`, name);
    return undefined;
  }
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw invalid("parameter_invalid", `Parameter ${name} must be a list of strings.`, name);
}

export function obj<T = Record<string, unknown>>(body: Body, name: string, required = false): T | undefined {
  const v = body[name];
  if (v === undefined || v === null) {
    if (required) throw invalid("parameter_missing", `Missing required parameter: ${name}.`, name);
    return undefined;
  }
  if (typeof v !== "object" || Array.isArray(v)) throw invalid("parameter_invalid", `Parameter ${name} must be an object.`, name);
  return v as T;
}

export function metadata(body: Body): Record<string, string> {
  const m = obj(body, "metadata") ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v !== "string") throw invalid("parameter_invalid", `metadata.${k} must be a string.`, "metadata");
    if (k.length > 40 || v.length > 500) throw invalid("parameter_invalid", "metadata keys are at most 40 characters and values at most 500.", "metadata");
    out[k] = v;
  }
  return out;
}

export function pageQuery(q: URLSearchParams): { limit?: number; starting_after?: string; ending_before?: string } {
  const limit = q.get("limit");
  return {
    ...(limit ? { limit: Number(limit) } : {}),
    ...(q.get("starting_after") ? { starting_after: q.get("starting_after")! } : {}),
    ...(q.get("ending_before") ? { ending_before: q.get("ending_before")! } : {}),
  };
}
