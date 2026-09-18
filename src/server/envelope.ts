import { ApiError } from "../lib/errors.ts";
import type { Store } from "../lib/store.ts";

export const API_VERSION = "2026-09-15";
export const DOCS_BASE = "https://docs.usefoil.com/aap";

export interface ListResult<T> {
  object: "list";
  url: string;
  has_more: boolean;
  data: T[];
}

export interface PageQuery {
  limit?: number;
  starting_after?: string;
  ending_before?: string;
}

/** Cursor pagination over an array already sorted newest first. */
export function paginate<T extends { id: string; created: number }>(items: T[], url: string, q: PageQuery): ListResult<T> {
  const limit = Math.min(Math.max(q.limit ?? 10, 1), 100);
  let sorted = [...items].sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
  if (q.starting_after) {
    const i = sorted.findIndex((x) => x.id === q.starting_after);
    if (i === -1) throw new ApiError(400, "invalid_request_error", "resource_missing", `No such object: '${q.starting_after}'.`, "starting_after");
    sorted = sorted.slice(i + 1);
  } else if (q.ending_before) {
    const i = sorted.findIndex((x) => x.id === q.ending_before);
    if (i === -1) throw new ApiError(400, "invalid_request_error", "resource_missing", `No such object: '${q.ending_before}'.`, "ending_before");
    sorted = sorted.slice(Math.max(0, i - limit), i);
    return { object: "list", url, has_more: i - limit > 0, data: sorted };
  }
  return { object: "list", url, has_more: sorted.length > limit, data: sorted.slice(0, limit) };
}

export function errorBody(e: ApiError, requestId: string): unknown {
  return {
    error: {
      type: e.type,
      code: e.code,
      message: e.message,
      ...(e.param ? { param: e.param } : {}),
      doc_url: `${DOCS_BASE}/errors#${e.code}`,
      request_id: requestId,
    },
  };
}

const PREFIX_COLLECTIONS: Record<string, string> = {
  ag: "agents", pol: "policies", trm: "terms", dl: "delegations", dr: "records", sess: "sessions", ca: "customer_actions", auth: "authorizations", evt: "events", we: "webhook_endpoints",
};

/** Replace id-valued fields with the objects they name, for each dotted path requested. */
export async function expand(store: Store, obj: unknown, paths: string[]): Promise<unknown> {
  if (!paths.length || !obj || typeof obj !== "object") return obj;
  const out = structuredClone(obj) as Record<string, unknown>;
  for (const path of paths) {
    const segments = path.split(".");
    await expandPath(store, out, segments);
  }
  return out;
}

async function expandPath(store: Store, obj: Record<string, unknown>, segments: string[]): Promise<void> {
  const [head, ...rest] = segments;
  if (!head) return;
  if (head === "data" && Array.isArray(obj.data)) {
    for (const item of obj.data as Record<string, unknown>[]) await expandPath(store, item, rest);
    return;
  }
  const v = obj[head];
  if (typeof v === "string") {
    const resolved = await resolveId(store, v);
    if (resolved) obj[head] = resolved;
  }
  const next = obj[head];
  if (rest.length && next && typeof next === "object") await expandPath(store, next as Record<string, unknown>, rest);
}

export async function resolveId(store: Store, id: string): Promise<Record<string, unknown> | null> {
  const prefix = id.split("_")[0] ?? "";
  const collection = PREFIX_COLLECTIONS[prefix];
  if (!collection) {
    if (prefix === "op") {
      const o = await store.getOperatorObject(id);
      return o ? (o as unknown as Record<string, unknown>) : null;
    }
    return null;
  }
  const found = await store.get<Record<string, unknown>>(collection, id);
  return found ? present(found) : null;
}

/** Strip fields that never leave the server. */
export function present<T>(obj: T): T {
  if (!obj || typeof obj !== "object") return obj;
  const o = { ...(obj as Record<string, unknown>) };
  delete o.claims;
  if (o.object === "customer_action") delete o.delegation;
  if (o.object === "authorization") {
    delete o.terms;
    delete o.delegation;
    delete o.acceptance_hash;
  }
  if (o.object === "webhook_endpoint") delete o.secret;
  if (o.object === "session") {
    delete o.operator_id;
    delete o.grant_jti;
    delete o.delegation_id;
    delete o.human;
    delete o.created_at;
  }
  return o as T;
}
