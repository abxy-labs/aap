import { Store } from "./store.ts";

/** Hashed origins whose current policy admits agents. */
export async function directory(store: Store): Promise<{ object: "list"; data: { object: "directory_entry"; hash: string }[]; has_more: false; url: string }> {
  const latest = new Map<string, { version: number; scopes: string[] }>();
  for (const p of await store.listPolicies()) {
    const cur = latest.get(p.origin);
    if (!cur || p.version > cur.version) latest.set(p.origin, { version: p.version, scopes: p.scopes });
  }
  const data = [...latest.entries()].filter(([, v]) => v.scopes.length > 0).map(([origin]) => ({ object: "directory_entry" as const, hash: hashOrigin(origin) })).sort((a, b) => a.hash.localeCompare(b.hash));
  return { object: "list", data, has_more: false, url: "/v1/directory" };
}

export function hashOrigin(origin: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(origin.toLowerCase());
  return h.digest("hex");
}
