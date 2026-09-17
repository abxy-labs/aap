import type { Account, ApiKeyRecord } from "../types.ts";
import { forbidden, unauthenticated } from "../lib/errors.ts";
import { Store, id, now, sha } from "../lib/store.ts";

export interface Principal {
  account: Account;
  livemode: boolean;
  key: ApiKeyRecord;
}

function random(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createAccount(store: Store, input: { type: Account["type"]; name: string; operator?: string | null; issuer?: string | null }): Promise<{ account: Account; keys: { test: string; live: string } }> {
  const account: Account = { id: id("acct"), object: "account", created: now(), type: input.type, name: input.name, operator: input.operator ?? null, issuer: input.issuer ?? null, origins: [] };
  await store.putAccount(account);
  const keys = { test: `sk_test_${random(24)}`, live: `sk_live_${random(24)}` };
  for (const [mode, key] of Object.entries(keys)) {
    await store.putKey({ hash: sha(key), account: account.id, livemode: mode === "live", prefix: key.slice(0, 12), created: account.created });
  }
  return { account, keys };
}

export async function authenticate(store: Store, req: Request): Promise<Principal> {
  const header = req.headers.get("authorization") ?? "";
  let key = "";
  if (/^bearer /i.test(header)) key = header.slice(7).trim();
  else if (/^basic /i.test(header)) {
    try {
      key = atob(header.slice(6).trim()).split(":")[0] ?? "";
    } catch {
      key = "";
    }
  }
  if (!key) throw unauthenticated("No API key was provided. Send it as a bearer token in the Authorization header.");
  if (!/^sk_(test|live)_/.test(key)) throw unauthenticated("The API key is not in a recognized format. Keys begin with sk_test_ or sk_live_.");
  const rec = await store.getKey(sha(key));
  if (!rec) throw unauthenticated(`Invalid API key provided: ${key.slice(0, 12)}…`);
  const account = await store.getAccount(rec.account);
  if (!account) throw unauthenticated("The API key's account no longer exists.");
  return { account, livemode: rec.livemode, key: rec };
}

export function requireType(p: Principal, type: Account["type"]): void {
  if (p.account.type !== type) {
    throw forbidden(`This endpoint is for ${type} accounts. Your key belongs to a ${p.account.type} account.`);
  }
}

export function requireTestMode(p: Principal): void {
  if (p.livemode) throw forbidden("Test helpers are only available with a test mode key.");
}

export function ownsOrigin(p: Principal, origin: string): boolean {
  return p.account.type === "site" && p.account.origins.includes(origin);
}

export function requireOrigin(p: Principal, origin: string): void {
  if (!ownsOrigin(p, origin)) throw forbidden(`Your account does not own the origin ${origin}.`);
}
