import type { KeyFile } from "./keys.ts";
import { admitsAgents, loadPolicy } from "./policy.ts";
import { Store } from "./store.ts";

export async function directory(store: Store, root: KeyFile): Promise<{ hashed_origins: string[] }> {
  const out: string[] = [];
  for (const p of await store.listPolicies()) {
    const claims = await loadPolicy(store, root, p.origin);
    if (admitsAgents(claims)) out.push(hashOrigin(p.origin));
  }
  return { hashed_origins: out.sort() };
}

export function hashOrigin(origin: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(origin.toLowerCase());
  return h.digest("hex");
}
