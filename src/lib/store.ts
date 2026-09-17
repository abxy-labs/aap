import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { KeyFile } from "./keys.ts";
import type {
  Account, AgentObject, ApiKeyRecord, DelegationRecord, EventObject, Handoff, OperatorObject,
  PolicyObject, SessionRecord, StoredDelegation, TermsObject, WebhookEndpoint,
} from "../types.ts";

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
  device?: string;
}

export interface BoundGrant {
  jti: string;
  session: string;
}

export interface IdempotencyRecord {
  request_hash: string;
  status: number;
  body: unknown;
  created: number;
}

/**
 * A directory of JSON files that stands in for Foil's database. Objects live under
 * `test/` or `live/` by mode; accounts, keys, operators, and the root key are shared.
 */
export class Store {
  constructor(public readonly rootDir: string, public readonly livemode = false) {}

  get dir(): string {
    return join(this.rootDir, this.livemode ? "live" : "test");
  }

  mode(livemode: boolean): Store {
    return new Store(this.rootDir, livemode);
  }

  static resolve(flag?: string): Store {
    return new Store(flag ?? process.env.AAP_STORE ?? join(process.cwd(), ".aap"));
  }

  async exists(): Promise<boolean> {
    return Bun.file(join(this.rootDir, "root.json")).exists();
  }

  async init(root: KeyFile): Promise<void> {
    await mkdir(join(this.rootDir, "test"), { recursive: true });
    await mkdir(join(this.rootDir, "live"), { recursive: true });
    await mkdir(join(this.rootDir, "shared"), { recursive: true });
    await Bun.write(join(this.rootDir, "root.json"), JSON.stringify(root, null, 2));
  }

  async destroy(): Promise<void> {
    await rm(this.rootDir, { recursive: true, force: true });
  }

  async root(): Promise<KeyFile> {
    const f = Bun.file(join(this.rootDir, "root.json"));
    if (!(await f.exists())) throw new Error(`no store at ${this.rootDir}; run "aap serve" or "aap init" first`);
    return f.json();
  }

  private safe(id: string): string {
    return id.replace(/[^A-Za-z0-9._:-]/g, "_");
  }

  private base(shared: boolean): string {
    return shared ? join(this.rootDir, "shared") : this.dir;
  }

  async put(collection: string, id: string, value: unknown, shared = false): Promise<void> {
    const dir = join(this.base(shared), collection);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, `${this.safe(id)}.json`), JSON.stringify(value, null, 2));
  }

  async get<T>(collection: string, id: string, shared = false): Promise<T | null> {
    const f = Bun.file(join(this.base(shared), collection, `${this.safe(id)}.json`));
    if (!(await f.exists())) return null;
    return f.json() as Promise<T>;
  }

  async del(collection: string, id: string, shared = false): Promise<void> {
    await rm(join(this.base(shared), collection, `${this.safe(id)}.json`), { force: true });
  }

  async list<T>(collection: string, shared = false): Promise<T[]> {
    let files: string[];
    try {
      files = (await readdir(join(this.base(shared), collection))).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const f of files) out.push((await Bun.file(join(this.base(shared), collection, f)).json()) as T);
    return out;
  }

  // shared
  putAccount(a: Account) { return this.put("accounts", a.id, a, true); }
  getAccount(id: string) { return this.get<Account>("accounts", id, true); }
  listAccounts() { return this.list<Account>("accounts", true); }
  putKey(k: ApiKeyRecord) { return this.put("keys", k.hash, k, true); }
  getKey(hash: string) { return this.get<ApiKeyRecord>("keys", hash, true); }
  putOperatorObject(o: OperatorObject) { return this.put("operators", o.id, o, true); }
  getOperatorObject(id: string) { return this.get<OperatorObject>("operators", id, true); }
  listOperators() { return this.list<OperatorObject>("operators", true); }

  /** Adapter used by verification: the operator certificate by id. */
  async getOperator(id: string): Promise<{ id: string; jwt: string } | null> {
    const o = await this.getOperatorObject(id);
    return o ? { id: o.id, jwt: o.certificate } : null;
  }
  async putOperator(id: string, jwt: string): Promise<void> {
    const existing = await this.getOperatorObject(id);
    if (existing) return;
    await this.putOperatorObject({
      id, object: "operator", created: Math.floor(Date.now() / 1000), account: null, name: id,
      vetting: "unknown", session_handling: "unknown", attestations: [], public_key: {}, certificate: jwt, expires_at: 0,
    });
  }

  // agents
  putAgentObject(a: AgentObject) { return this.put("agents", a.id, a); }
  getAgentObject(id: string) { return this.get<AgentObject>("agents", id); }
  listAgents() { return this.list<AgentObject>("agents"); }
  /** Adapter used by verification: the agent certificate by id. */
  async getAgent(id: string): Promise<{ id: string; jwt: string } | null> {
    const a = await this.getAgentObject(id);
    return a ? { id: a.id, jwt: a.certificate } : null;
  }
  async putAgent(id: string, jwt: string): Promise<void> {
    const existing = await this.getAgentObject(id);
    if (existing) return;
    await this.put("agents", id, { id, object: "agent", created: Math.floor(Date.now() / 1000), livemode: this.livemode, metadata: {}, operator: "", name: id, status: "active", public_key: {}, ceiling: { scopes: [], constraints: {} }, certificate: jwt, expires_at: 0 });
  }

  // policies
  putPolicy(p: PolicyObject) { return this.put("policies", p.id, p); }
  getPolicyObject(id: string) { return this.get<PolicyObject>("policies", id); }
  listPolicies() { return this.list<PolicyObject>("policies"); }
  async getPolicy(origin: string): Promise<PolicyObject | null> {
    const all = (await this.listPolicies()).filter((p) => p.origin === origin);
    if (!all.length) return null;
    return all.sort((a, b) => b.version - a.version)[0]!;
  }

  // terms
  putTerms(t: TermsObject) { return this.put("terms", t.id, t); }
  getTerms(id: string) { return this.get<TermsObject>("terms", id); }

  // delegations
  putDelegation(d: StoredDelegation) { return this.put("delegations", d.id, d); }
  getDelegation(id: string) { return this.get<StoredDelegation>("delegations", id); }
  listDelegations() { return this.list<StoredDelegation>("delegations"); }
  putRecord(r: DelegationRecord) { return this.put("records", r.id, r); }
  getRecord(id: string) { return this.get<DelegationRecord>("records", id); }

  // challenges
  putChallenge(c: StoredChallenge) { return this.put("challenges", c.nonce, c); }
  getChallenge(nonce: string) { return this.get<StoredChallenge>("challenges", nonce); }

  // sessions
  putSession(s: SessionRecord) { return this.put("sessions", s.id, s); }
  getSession(id: string) { return this.get<SessionRecord>("sessions", id); }
  listSessions() { return this.list<SessionRecord>("sessions"); }
  /** A consumer's own session at a site, as Foil observed it. */
  async getSiteSession(id: string): Promise<SiteSession | null> {
    const s = await this.getSession(id);
    if (!s || s.plane !== "human") return null;
    return { id: s.id, origin: s.origin, human: true, known_device: s.known_device ?? false, created_at: s.created_at ?? new Date(s.created * 1000).toISOString(), device: s.device };
  }
  async putSiteSession(s: SiteSession): Promise<SessionRecord> {
    const rec: SessionRecord = {
      id: s.id, object: "session", created: Math.floor(new Date(s.created_at).getTime() / 1000), livemode: this.livemode, metadata: {},
      origin: s.origin, plane: s.human ? "human" : "bot", status: s.human ? "active" : "downgraded",
      decision: { verdict: s.human ? "allow" : "block", plane: s.human ? "human" : "bot" },
      agent: null, next_action: null, human: s.human, known_device: s.known_device, created_at: s.created_at, ...(s.device ? { device: s.device } : {}),
    };
    await this.putSession(rec);
    return rec;
  }

  // grant bindings
  putGrantBinding(b: BoundGrant) { return this.put("grants", b.jti, b); }
  getGrantBinding(jti: string) { return this.get<BoundGrant>("grants", jti); }

  // handoffs
  putHandoff(h: Handoff) { return this.put("handoffs", h.id, h); }
  getHandoff(id: string) { return this.get<Handoff>("handoffs", id); }
  listHandoffs() { return this.list<Handoff>("handoffs"); }

  // events and webhooks
  putEvent(e: EventObject) { return this.put("events", e.id, e); }
  getEvent(id: string) { return this.get<EventObject>("events", id); }
  listEvents() { return this.list<EventObject>("events"); }
  putWebhookEndpoint(w: WebhookEndpoint) { return this.put("webhook_endpoints", w.id, w); }
  getWebhookEndpoint(id: string) { return this.get<WebhookEndpoint>("webhook_endpoints", id); }
  listWebhookEndpoints() { return this.list<WebhookEndpoint>("webhook_endpoints"); }
  delWebhookEndpoint(id: string) { return this.del("webhook_endpoints", id); }

  // idempotency
  putIdempotency(account: string, key: string, r: IdempotencyRecord) { return this.put("idempotency", `${account}_${sha(key)}`, r); }
  getIdempotency(account: string, key: string) { return this.get<IdempotencyRecord>("idempotency", `${account}_${sha(key)}`); }
}

let lastMs = 0;
let counter = 0;

/** Opaque ids that sort by creation time, so lists page in a stable order. */
export function id(prefix: string): string {
  const ms = Date.now();
  if (ms === lastMs) counter++;
  else { lastMs = ms; counter = 0; }
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const time = ms.toString(36).padStart(9, "0") + counter.toString(36).padStart(2, "0");
  return `${prefix}_${time}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function sha(s: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(s);
  return h.digest("hex");
}
