import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { KeyFile } from "./keys.ts";
import type { DelegationClaims, DelegationRecord, SessionRecord } from "../types.ts";

export interface StoredDelegation {
  id: string;
  jwt: string;
  claims: DelegationClaims;
  status: "active" | "revoked";
  revoked_at?: string;
  revoked_by?: string;
}

export interface StoredPolicy {
  origin: string;
  version: number;
  jwt: string;
}

export interface StoredChallenge {
  nonce: string;
  origin: string;
  jwt: string;
  exp: number;
}

export interface SiteSession {
  id: string;
  origin: string;
  human: boolean;
  known_device: boolean;
  created_at: string;
}

export interface BoundGrant {
  jti: string;
  session: string;
}

export class Store {
  constructor(public readonly dir: string) {}

  static resolve(flag?: string): Store {
    return new Store(flag ?? process.env.AAP_STORE ?? join(process.cwd(), ".aap"));
  }

  private path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  async exists(): Promise<boolean> {
    return Bun.file(this.path("root.json")).exists();
  }

  async init(root: KeyFile): Promise<void> {
    for (const d of ["operators", "agents", "policies", "delegations", "challenges", "sessions", "site-sessions", "grants"]) {
      await mkdir(this.path(d), { recursive: true });
    }
    await Bun.write(this.path("root.json"), JSON.stringify(root, null, 2));
  }

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  async root(): Promise<KeyFile> {
    const f = Bun.file(this.path("root.json"));
    if (!(await f.exists())) throw new Error(`no store at ${this.dir}; run "aap init" first`);
    return f.json();
  }

  private async write(rel: string, value: unknown): Promise<void> {
    await mkdir(join(this.dir, rel, ".."), { recursive: true });
    await Bun.write(this.path(rel), JSON.stringify(value, null, 2));
  }

  private async read<T>(rel: string): Promise<T | null> {
    const f = Bun.file(this.path(rel));
    if (!(await f.exists())) return null;
    return f.json() as Promise<T>;
  }

  private safe(id: string): string {
    return id.replace(/[^A-Za-z0-9._:-]/g, "_");
  }

  // operators
  putOperator(id: string, jwt: string) { return this.write(`operators/${this.safe(id)}.json`, { id, jwt }); }
  getOperator(id: string) { return this.read<{ id: string; jwt: string }>(`operators/${this.safe(id)}.json`); }

  // agents seen
  putAgent(id: string, jwt: string) { return this.write(`agents/${this.safe(id)}.json`, { id, jwt }); }
  getAgent(id: string) { return this.read<{ id: string; jwt: string }>(`agents/${this.safe(id)}.json`); }

  // policies
  putPolicy(p: StoredPolicy) { return this.write(`policies/${this.safe(p.origin)}.json`, p); }
  getPolicy(origin: string) { return this.read<StoredPolicy>(`policies/${this.safe(origin)}.json`); }
  async listPolicies(): Promise<StoredPolicy[]> {
    const out: StoredPolicy[] = [];
    for (const f of await this.ls("policies")) out.push((await this.read<StoredPolicy>(`policies/${f}`))!);
    return out;
  }

  // delegations
  putDelegation(d: StoredDelegation) { return this.write(`delegations/${this.safe(d.id)}.json`, d); }
  getDelegation(id: string) { return this.read<StoredDelegation>(`delegations/${this.safe(id)}.json`); }
  async listDelegations(): Promise<StoredDelegation[]> {
    const out: StoredDelegation[] = [];
    for (const f of await this.ls("delegations")) out.push((await this.read<StoredDelegation>(`delegations/${f}`))!);
    return out;
  }
  getRecord(id: string) { return this.read<DelegationRecord>(`records/${this.safe(id)}.json`); }
  putRecord(r: DelegationRecord) { return this.write(`records/${this.safe(r.id)}.json`, r); }

  // challenges
  putChallenge(c: StoredChallenge) { return this.write(`challenges/${this.safe(c.nonce)}.json`, c); }
  getChallenge(nonce: string) { return this.read<StoredChallenge>(`challenges/${this.safe(nonce)}.json`); }

  // sessions
  putSession(s: SessionRecord) { return this.write(`sessions/${this.safe(s.id)}.json`, s); }
  getSession(id: string) { return this.read<SessionRecord>(`sessions/${this.safe(id)}.json`); }

  // site sessions (simulated consumer sessions at a site)
  putSiteSession(s: SiteSession) { return this.write(`site-sessions/${this.safe(s.id)}.json`, s); }
  getSiteSession(id: string) { return this.read<SiteSession>(`site-sessions/${this.safe(id)}.json`); }

  // grant bindings
  putGrantBinding(b: BoundGrant) { return this.write(`grants/${this.safe(b.jti)}.json`, b); }
  getGrantBinding(jti: string) { return this.read<BoundGrant>(`grants/${this.safe(jti)}.json`); }

  private async ls(dir: string): Promise<string[]> {
    try {
      return (await readdir(this.path(dir))).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
  }
}

export function id(prefix: string): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}
