import type { JWK } from "jose";
import { issueAgent, verifyOperator } from "../lib/certs.ts";
import { verifyChallenge } from "../lib/challenge.ts";
import { discover, type DiscoveryOptions } from "../lib/discovery.ts";
import { delegationSigningPayload, signRequest, verifyDelegation } from "../lib/delegation.ts";
import { constructEvent } from "../lib/events.ts";
import { buildHeader, signGrant } from "../lib/grant.ts";
import { decode } from "../lib/jwt.ts";
import { generateKeyFile, type Alg, type KeyFile } from "../lib/keys.ts";
import { id as newId } from "../lib/store.ts";
import type {
  Acceptance, Account, AgentClaims, AgentObject, Ceiling, CredentialVerification, DelegationClaims, DelegationObject, EventObject, Handoff, OperatorObject,
  PolicyObject, SessionRecord, TermsObject, WebhookEndpoint,
} from "../types.ts";

export const DEFAULT_API_BASE = "http://127.0.0.1:4010";
export const API_VERSION = "2026-09-15";

export interface ListResponse<T> {
  object: "list";
  url: string;
  has_more: boolean;
  data: T[];
}

export interface Keyring {
  operator?: KeyFile;
  agents: Record<string, KeyFile>;
}

export interface AapOptions {
  apiBase?: string;
  apiVersion?: string;
  keys?: Partial<Keyring>;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  idempotencyKey?: string;
  expand?: string[];
}

export class AapError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string,
    public readonly code: string,
    message: string,
    public readonly param?: string,
    public readonly requestId?: string,
    public readonly docUrl?: string,
  ) {
    super(message);
  }
}

type Params = Record<string, unknown>;

export interface DelegationCreateParams {
  agent: string;
  origin: string;
  subject: string;
  terms: string;
  acceptance: Acceptance;
  scopes?: string[];
  intent?: string;
  site_session?: string | null;
  metadata?: Record<string, string>;
}

export interface GrantSignParams {
  delegation: DelegationObject | string;
  challenge: string;
  sessionRef: string;
  intent?: string;
  scopes?: string[];
  ttlS?: number;
}

/** Client for the Agent Admission Protocol API. Signing keys stay local; only signed objects are sent. */
export class Aap {
  readonly apiBase: string;
  readonly apiVersion: string;
  readonly keys: Keyring;
  private readonly fetchImpl: typeof fetch;
  private rootKeys: JWK[] | null = null;
  private operatorCache: OperatorObject | null = null;
  private agentCache = new Map<string, AgentObject>();

  constructor(public readonly apiKey: string | null, opts: AapOptions = {}) {
    this.apiBase = (opts.apiBase ?? process.env.AAP_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.apiVersion = opts.apiVersion ?? API_VERSION;
    this.keys = { agents: {}, ...opts.keys };
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get livemode(): boolean {
    return !!this.apiKey?.startsWith("sk_live_");
  }

  /** Public discovery only. Never forwards this client's API key or changes its service. */
  discover(origin: string, opts: DiscoveryOptions = {}) {
    return discover(origin, { ...opts, fetch: this.fetchImpl });
  }

  async request<T>(method: string, path: string, params: Params = {}, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.apiBase + path);
    const headers: Record<string, string> = { "aap-version": this.apiVersion, accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let body: string | undefined;
    if (method === "GET" || method === "DELETE") {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(`${k}[]`, String(x)));
        else url.searchParams.set(k, String(v));
      }
      for (const e of opts.expand ?? []) url.searchParams.append("expand[]", e);
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ ...params, ...(opts.expand ? { expand: opts.expand } : {}) });
      headers["idempotency-key"] = opts.idempotencyKey ?? newId("idem");
    }
    const res = await this.fetchImpl(url, { method, headers, body });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new AapError(res.status, "api_error", "invalid_response", `The API returned a non-JSON response (${res.status}).`, undefined, res.headers.get("request-id") ?? undefined);
    }
    if (!res.ok) {
      const e = (json as { error?: { type: string; code: string; message: string; param?: string; doc_url?: string; request_id?: string } }).error;
      throw new AapError(res.status, e?.type ?? "api_error", e?.code ?? "unknown", e?.message ?? `Request failed with ${res.status}.`, e?.param, e?.request_id, e?.doc_url);
    }
    return json as T;
  }

  private get<T>(path: string, params: Params = {}, opts: RequestOptions = {}) { return this.request<T>("GET", path, params, opts); }
  private post<T>(path: string, params: Params = {}, opts: RequestOptions = {}) { return this.request<T>("POST", path, params, opts); }

  // ---------------------------------------------------------------- accounts
  readonly accounts = {
    /** Reference-server onboarding. For an operator, generates a signing key when none is given and keeps it in `keys.operator`. */
    create: async (params: { type: "operator" | "site"; name: string; key?: KeyFile; alg?: Alg; vetting?: string; session_handling?: string; attestations?: unknown[]; asn?: string[]; ja4?: string[] }) => {
      let key = params.key;
      if (params.type === "operator" && !key) key = await generateKeyFile(params.alg ?? "ES256");
      if (key) this.keys.operator = key;
      const { key: _k, alg: _a, ...rest } = params;
      return this.post<{ account: Account; keys: { test: string; live: string }; operator?: OperatorObject }>("/v1/accounts", { ...rest, ...(key ? { public_key: key.public } : {}) });
    },
  };

  readonly account = {
    retrieve: () => this.get<Account & { operator?: OperatorObject }>("/v1/account"),
  };

  // ---------------------------------------------------------------- agents
  readonly agents = {
    /** Signs an agent certificate with the operator key and registers it. A signing key is generated when none is given and kept in `keys.agents`. */
    create: async (params: { name: string; ceiling: Ceiling; key?: KeyFile; alg?: Alg; days?: number; metadata?: Record<string, string> }, opts?: RequestOptions) => {
      const operatorKey = this.keys.operator;
      if (!operatorKey) throw new AapError(0, "invalid_request_error", "operator_key_missing", "No operator signing key is configured. Pass keys.operator when constructing the client.");
      const account = await this.account.retrieve();
      if (!account.operator) throw new AapError(0, "invalid_request_error", "not_an_operator", "This account is not an operator account.");
      const agentKey = params.key ?? (await generateKeyFile(params.alg ?? "ES256"));
      const agentId = newId("ag");
      const certificate = await issueAgent(operatorKey, account.operator.id, { id: agentId, name: params.name, key: agentKey.public, ceiling: params.ceiling, days: params.days });
      const agent = await this.post<AgentObject>("/v1/agents", { certificate, metadata: params.metadata ?? {} }, opts);
      this.keys.agents[agent.id] = agentKey;
      return agent;
    },
    retrieve: (id: string, opts?: RequestOptions) => this.get<AgentObject>(`/v1/agents/${id}`, {}, opts),
    list: (params: Params = {}) => this.get<ListResponse<AgentObject>>("/v1/agents", params),
    update: (id: string, params: Params) => this.post<AgentObject>(`/v1/agents/${id}`, params),
    deactivate: (id: string) => this.post<AgentObject>(`/v1/agents/${id}/deactivate`),
  };

  // ---------------------------------------------------------------- policies
  readonly policies = {
    create: (params: Params, opts?: RequestOptions) => this.post<PolicyObject>("/v1/policies", params, opts),
    retrieve: (id: string) => this.get<PolicyObject>(`/v1/policies/${id}`),
    list: (params: Params = {}) => this.get<ListResponse<PolicyObject>>("/v1/policies", params),
  };

  // ---------------------------------------------------------------- terms
  readonly terms = {
    create: (params: { agent: string; origin: string; scopes?: string[]; metadata?: Record<string, string> }, opts?: RequestOptions) => this.post<TermsObject>("/v1/terms", params, opts),
    retrieve: (id: string) => this.get<TermsObject>(`/v1/terms/${id}`),
  };

  // ---------------------------------------------------------------- delegations
  readonly delegations = {
    /** Signs the request with the agent's key, then posts it. */
    create: async (params: DelegationCreateParams, opts?: RequestOptions) => {
      const key = this.keys.agents[params.agent];
      if (!key) throw new AapError(0, "invalid_request_error", "agent_key_missing", `No signing key is configured for agent ${params.agent}.`);
      const { metadata, ...body } = params;
      const signature = await signRequest(delegationSigningPayload({ ...body, site_session: body.site_session ?? null }), key);
      return this.post<DelegationObject>("/v1/delegations", { ...body, signature, metadata: metadata ?? {} }, opts);
    },
    retrieve: (id: string, opts?: RequestOptions) => this.get<DelegationObject>(`/v1/delegations/${id}`, {}, opts),
    list: (params: Params = {}, opts?: RequestOptions) => this.get<ListResponse<DelegationObject>>("/v1/delegations", params, opts),
    revoke: (id: string, params: Params = {}) => this.post<DelegationObject>(`/v1/delegations/${id}/revoke`, params),
  };

  // ---------------------------------------------------------------- sessions
  /** Institution-only verification. Issuer signing remains offline. */
  readonly credentialVerifications = {
    create: (params: { delegation: string; credential_subject: string }, opts?: RequestOptions) => this.post<CredentialVerification>("/v1/credential_verifications", params, opts),
    retrieve: (id: string) => this.get<CredentialVerification>(`/v1/credential_verifications/${id}`),
    complete: (id: string, params: { presentation: string }, opts?: RequestOptions) => this.post<CredentialVerification>(`/v1/credential_verifications/${id}/complete`, params, opts),
    revoke: (id: string) => this.post<CredentialVerification>(`/v1/credential_verifications/${id}/revoke`),
  };

  // ---------------------------------------------------------------- sessions
  readonly sessions = {
    retrieve: (id: string, opts?: RequestOptions) => this.get<SessionRecord>(`/v1/sessions/${id}`, {}, opts),
    list: (params: Params = {}, opts?: RequestOptions) => this.get<ListResponse<SessionRecord>>("/v1/sessions", params, opts),
  };

  // ---------------------------------------------------------------- handoffs
  readonly handoffs = {
    create: (params: { session: string; scope: string; context?: Record<string, unknown>; metadata?: Record<string, string> }, opts?: RequestOptions) => this.post<Handoff>("/v1/handoffs", params, opts),
    retrieve: (id: string, opts?: RequestOptions) => this.get<Handoff>(`/v1/handoffs/${id}`, {}, opts),
    list: (params: Params = {}, opts?: RequestOptions) => this.get<ListResponse<Handoff>>("/v1/handoffs", params, opts),
    update: (id: string, params: Params) => this.post<Handoff>(`/v1/handoffs/${id}`, params),
    complete: (id: string, params: { session?: string; result?: Record<string, unknown> } = {}) => this.post<Handoff>(`/v1/handoffs/${id}/complete`, params),
    cancel: (id: string) => this.post<Handoff>(`/v1/handoffs/${id}/cancel`),
    /** Poll until the handoff is completed, canceled, or expired, or the timeout passes. */
    wait: async (id: string, opts: { timeout?: number; interval?: number } = {}): Promise<Handoff> => {
      const deadline = Date.now() + (opts.timeout ?? 900) * 1000;
      const interval = (opts.interval ?? 1) * 1000;
      for (;;) {
        const h = await this.handoffs.retrieve(id);
        if (h.status !== "pending" || Date.now() >= deadline) return h;
        await new Promise((r) => setTimeout(r, interval));
      }
    },
  };

  // ---------------------------------------------------------------- events and webhooks
  readonly events = {
    retrieve: (id: string) => this.get<EventObject>(`/v1/events/${id}`),
    list: (params: Params = {}) => this.get<ListResponse<EventObject>>("/v1/events", params),
  };

  readonly webhookEndpoints = {
    create: (params: { url: string; enabled_events?: string[]; description?: string; metadata?: Record<string, string> }) => this.post<WebhookEndpoint>("/v1/webhook_endpoints", params),
    retrieve: (id: string) => this.get<WebhookEndpoint>(`/v1/webhook_endpoints/${id}`),
    list: (params: Params = {}) => this.get<ListResponse<WebhookEndpoint>>("/v1/webhook_endpoints", params),
    update: (id: string, params: Params) => this.post<WebhookEndpoint>(`/v1/webhook_endpoints/${id}`, params),
    del: (id: string) => this.request<{ id: string; deleted: true }>("DELETE", `/v1/webhook_endpoints/${id}`),
  };

  readonly webhooks = {
    constructEvent: (body: string, signatureHeader: string | null, secret: string, toleranceS = 300): EventObject => constructEvent(body, signatureHeader, secret, toleranceS),
  };

  readonly directory = {
    list: () => this.get<ListResponse<{ object: "directory_entry"; hash: string }>>("/v1/directory"),
  };

  // ---------------------------------------------------------------- local helpers
  async rootKey(): Promise<JWK> {
    if (!this.rootKeys) {
      const res = await this.fetchImpl(`${this.apiBase}/.well-known/foil-root`);
      const body = (await res.json()) as { keys: JWK[] };
      this.rootKeys = body.keys;
    }
    return this.rootKeys[0]!;
  }

  readonly challenges = {
    /** Verify a challenge against the root key before answering it. */
    verify: async (jwt: string) => verifyChallenge(jwt, await this.rootKey()),
  };

  readonly grants = {
    /** Sign a per-session grant with the agent's key. Never contacts the API beyond loading the delegation when an id is given. */
    sign: async (params: GrantSignParams): Promise<{ grant: string; delegation: DelegationObject }> => {
      const delegation = typeof params.delegation === "string" ? await this.delegations.retrieve(params.delegation) : params.delegation;
      const key = this.keys.agents[delegation.agent];
      if (!key) throw new AapError(0, "invalid_request_error", "agent_key_missing", `No signing key is configured for agent ${delegation.agent}.`);
      const challenge = await this.challenges.verify(params.challenge);
      if (challenge.origin !== delegation.origin) throw new AapError(0, "invalid_request_error", "challenge_origin_mismatch", `The challenge is for ${challenge.origin} but the delegation is for ${delegation.origin}.`);
      const claims = decode<DelegationClaims>(delegation.certificate).claims;
      const grant = await signGrant(key, { sub: delegation.agent } as AgentClaims, claims, {
        sessionRef: params.sessionRef, intent: params.intent ?? delegation.intent, scopes: params.scopes, nonce: challenge.nonce, ttlS: params.ttlS,
      });
      return { grant, delegation };
    },
  };

  readonly presentations = {
    /** Build the Foil-Agent-Grant header value, with the full chain. */
    build: async (params: { grant: string; delegation: DelegationObject | string }): Promise<string> => {
      const delegation = typeof params.delegation === "string" ? await this.delegations.retrieve(params.delegation) : params.delegation;
      let agent = this.agentCache.get(delegation.agent);
      if (!agent) {
        agent = await this.agents.retrieve(delegation.agent);
        this.agentCache.set(agent.id, agent);
      }
      if (!this.operatorCache) {
        const acct = await this.account.retrieve();
        if (!acct.operator) throw new AapError(0, "invalid_request_error", "not_an_operator", "Only an operator account can build a presentation.");
        this.operatorCache = acct.operator;
      }
      return buildHeader({ grant: params.grant, chain: { delegation: delegation.certificate, agent: agent.certificate, operator: this.operatorCache.certificate } });
    },
  };

  readonly chain = {
    /** Verify a delegation certificate against the root key, offline apart from fetching the root once. */
    verify: async (delegation: DelegationObject | string): Promise<DelegationClaims> => {
      const cert = typeof delegation === "string" ? delegation : delegation.certificate;
      return verifyDelegation(cert, await this.rootKey());
    },
    verifyOperator: async (certificate: string) => verifyOperator(certificate, await this.rootKey()),
  };

  // ---------------------------------------------------------------- test helpers
  readonly test = {
    agents: { list: () => this.get<ListResponse<{ id: string; outcome: string; description: string }>>("/v1/test_helpers/agents") },
    sessions: {
      create: (params: { origin: string; human?: boolean; known_device?: boolean; age?: number; device?: string }) => this.post<SessionRecord>("/v1/test_helpers/sessions", params),
      use: (id: string, params: { scope: string }) => this.post<SessionRecord & { handoff?: Handoff; status_header?: string }>(`/v1/test_helpers/sessions/${id}/use`, params),
    },
    challenges: { create: (params: { origin: string }) => this.post<{ object: "challenge"; origin: string; nonce: string; expires_at: number; jwt: string; header: string }>("/v1/test_helpers/challenges", params) },
    presentations: {
      create: (params: { origin: string; header?: string; agent?: string; session?: string; asn?: string; ja4?: string; scopes?: string[] }) =>
        this.post<SessionRecord & { status_header?: string; narrowed?: string[]; handoff_scopes?: string[]; handoff?: Handoff }>("/v1/test_helpers/presentations", params),
    },
    handoffs: {
      link: (id: string, params: { session?: string; known_device?: boolean } = {}) => this.post<Handoff>(`/v1/test_helpers/handoffs/${id}/link`, params),
      complete: (id: string, params: { session?: string; outcome?: string; result?: Record<string, unknown>; known_device?: boolean } = {}) => this.post<Handoff>(`/v1/test_helpers/handoffs/${id}/complete`, params),
    },
    events: { trigger: (type: string, params: { origin?: string; data?: Record<string, unknown> } = {}) => this.post<EventObject>("/v1/test_helpers/events", { type, ...params }) },
  };
}

export type { KeyFile } from "../lib/keys.ts";
export { discover, createDiscoveryProfile, validateDiscoveryProfile } from "../lib/discovery.ts";
export type { DiscoveryProfile, DiscoveryOptions } from "../lib/discovery.ts";
export { generateKeyFile, readKeyFile } from "../lib/keys.ts";
export { issueCredential, presentCredential, VC_CONTEXT } from "../lib/credentials.ts";
export type { CredentialPolicy, CredentialTrust, CredentialVerification } from "../types.ts";
