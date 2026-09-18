import type { JWK } from "jose";
import { issueAgent, verifyAgent, verifyOperator } from "../lib/certs.ts";
import {
  authorizationSigningPayload,
  type Authorization,
  type AuthorizationAcceptParams,
} from "../lib/authorization.ts";
import { verifyChallenge } from "../lib/challenge.ts";
import { delegationSubject } from "../lib/attestations.ts";
import {
  credentialBody,
  issueCredential,
  type CredentialBody,
} from "../lib/credentials.ts";
import { discover, type DiscoveryOptions } from "../lib/discovery.ts";
import { signRequest, verifyDelegation } from "../lib/delegation.ts";
import { constructEvent } from "../lib/events.ts";
import { buildHeader, signGrant } from "../lib/grant.ts";
import { generateKeyFile, type Alg, type KeyFile } from "../lib/keys.ts";
import { id as newId } from "../lib/store.ts";
import type {
  Account,
  AgentClaims,
  AgentObject,
  Attestation,
  Ceiling,
  DelegationClaims,
  DelegationObject,
  EventObject,
  CustomerAction,
  IssuerObject,
  OperatorObject,
  PolicyObject,
  SessionRecord,
  WebhookEndpoint,
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
  issuer?: KeyFile;
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

/** Implemented by the browser operator's network layer, not by a page script. */
export type Policy = Omit<
  PolicyObject,
  "evidence" | "attestations" | "credentials" | "statement"
> & {
  scopes: string[];
  advanced: {
    evidence: PolicyObject["evidence"];
    attestations: PolicyObject["attestations"];
  };
};
export interface BrowserTransport {
  challenge(origin: string): Promise<string>;
  present(input: {
    origin: string;
    header: string;
    session: string;
  }): Promise<SessionRecord>;
}

/** Client for the Agent Admission Protocol API. Signing keys stay local; only signed objects are sent. */
export class Aap {
  readonly apiBase: string;
  readonly apiVersion: string;
  readonly keys: Keyring;
  private readonly fetchImpl: typeof fetch;
  private rootKeys: JWK[] | null = null;

  constructor(
    public readonly apiKey: string | null,
    opts: AapOptions = {},
  ) {
    this.apiBase = (
      opts.apiBase ??
      process.env.AAP_API_BASE ??
      DEFAULT_API_BASE
    ).replace(/\/+$/, "");
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

  async request<T>(
    method: string,
    path: string,
    params: Params = {},
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(this.apiBase + path);
    const headers: Record<string, string> = {
      "aap-version": this.apiVersion,
      accept: "application/json",
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let body: string | undefined;
    if (method === "GET" || method === "DELETE") {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v))
          v.forEach((x) => url.searchParams.append(`${k}[]`, String(x)));
        else url.searchParams.set(k, String(v));
      }
      for (const e of opts.expand ?? []) url.searchParams.append("expand[]", e);
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify({
        ...params,
        ...(opts.expand ? { expand: opts.expand } : {}),
      });
      headers["idempotency-key"] = opts.idempotencyKey ?? newId("idem");
    }
    const res = await this.fetchImpl(url, { method, headers, body });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new AapError(
        res.status,
        "api_error",
        "invalid_response",
        `The API returned a non-JSON response (${res.status}).`,
        undefined,
        res.headers.get("request-id") ?? undefined,
      );
    }
    if (!res.ok) {
      const e = (
        json as {
          error?: {
            type: string;
            code: string;
            message: string;
            param?: string;
            doc_url?: string;
            request_id?: string;
          };
        }
      ).error;
      throw new AapError(
        res.status,
        e?.type ?? "api_error",
        e?.code ?? "unknown",
        e?.message ?? `Request failed with ${res.status}.`,
        e?.param,
        e?.request_id,
        e?.doc_url,
      );
    }
    return json as T;
  }

  private get<T>(path: string, params: Params = {}, opts: RequestOptions = {}) {
    return this.request<T>("GET", path, params, opts);
  }
  private post<T>(
    path: string,
    params: Params = {},
    opts: RequestOptions = {},
  ) {
    return this.request<T>("POST", path, params, opts);
  }

  // ---------------------------------------------------------------- accounts
  readonly accounts = {
    /** Reference-server onboarding. For an operator, generates a signing key when none is given and keeps it in `keys.operator`. */
    create: async (params: {
      type: Account["type"];
      name: string;
      key?: KeyFile;
      alg?: Alg;
      vetting?: string;
      session_handling?: string;
      attestations?: unknown[];
      asn?: string[];
      ja4?: string[];
      url?: string;
      public_keys?: unknown[];
    }) => {
      let key = params.key;
      if (params.type === "operator" && !key)
        key = await generateKeyFile(params.alg ?? "ES256");
      if (params.type === "issuer" && !key && !params.public_keys)
        key = await generateKeyFile(params.alg ?? "ES256");
      if (key && params.type === "operator") this.keys.operator = key;
      if (key && params.type === "issuer") this.keys.issuer = key;
      const { key: _k, alg: _a, ...rest } = params;
      const body: Params = { ...rest };
      if (key && params.type === "issuer" && !params.public_keys)
        body.public_keys = [key.public];
      else if (key && params.type === "operator") body.public_key = key.public;
      return this.post<{
        account: Account;
        keys: { test: string; live: string };
        operator?: OperatorObject;
        issuer?: IssuerObject;
      }>("/v1/accounts", body);
    },
  };

  readonly account = {
    retrieve: () =>
      this.get<Account & { operator?: OperatorObject }>("/v1/account"),
  };

  // ---------------------------------------------------------------- agents
  readonly agents = {
    /** Signs an agent certificate with the operator key and registers it. A signing key is generated when none is given and kept in `keys.agents`. */
    create: async (
      params: {
        name: string;
        ceiling: Ceiling;
        key?: KeyFile;
        alg?: Alg;
        days?: number;
        metadata?: Record<string, string>;
      },
      opts?: RequestOptions,
    ) => {
      const operatorKey = this.keys.operator;
      if (!operatorKey)
        throw new AapError(
          0,
          "invalid_request_error",
          "operator_key_missing",
          "No operator signing key is configured. Pass keys.operator when constructing the client.",
        );
      const account = await this.account.retrieve();
      if (!account.operator)
        throw new AapError(
          0,
          "invalid_request_error",
          "not_an_operator",
          "This account is not an operator account.",
        );
      const agentKey =
        params.key ?? (await generateKeyFile(params.alg ?? "ES256"));
      const agentId = newId("ag");
      const certificate = await issueAgent(operatorKey, account.operator.id, {
        id: agentId,
        name: params.name,
        key: agentKey.public,
        ceiling: params.ceiling,
        days: params.days,
      });
      const agent = await this.post<AgentObject>(
        "/v1/agents",
        { certificate, metadata: params.metadata ?? {} },
        opts,
      );
      this.keys.agents[agent.id] = agentKey;
      return agent;
    },
    retrieve: (id: string, opts?: RequestOptions) =>
      this.get<AgentObject>(`/v1/agents/${id}`, {}, opts),
    list: (params: Params = {}) =>
      this.get<ListResponse<AgentObject>>("/v1/agents", params),
    update: (id: string, params: Params) =>
      this.post<AgentObject>(`/v1/agents/${id}`, params),
    deactivate: (id: string) =>
      this.post<AgentObject>(`/v1/agents/${id}/deactivate`),
  };

  // ---------------------------------------------------------------- policies
  readonly policies = {
    create: (params: Params, opts?: RequestOptions) =>
      this.post<Policy>("/v1/policies", params, opts),
    retrieve: (id: string) => this.get<Policy>(`/v1/policies/${id}`),
    list: (params: Params = {}) =>
      this.get<ListResponse<Policy>>("/v1/policies", params),
  };

  readonly authorizations = {
    create: (
      params: {
        agent: string;
        origin: string;
        subject: string;
        intent: string;
        scopes: string[];
        metadata?: Record<string, string>;
      },
      opts?: RequestOptions,
    ) => this.post<Authorization>("/v1/authorizations", params, opts),
    retrieve: (id: string) =>
      this.get<Authorization>(`/v1/authorizations/${id}`),
    list: (params: Params = {}) =>
      this.get<ListResponse<Authorization>>("/v1/authorizations", params),
    accept: async (
      id: string,
      params: AuthorizationAcceptParams,
      opts?: RequestOptions,
    ) => {
      const authorization = await this.authorizations.retrieve(id);
      const key = this.keys.agents[authorization.agent];
      if (!key)
        throw new AapError(
          0,
          "invalid_request_error",
          "agent_key_missing",
          `No signing key is configured for agent ${authorization.agent}.`,
        );
      const signature = await signRequest(
        authorizationSigningPayload(id, params),
        key,
      );
      return this.post<Authorization>(
        `/v1/authorizations/${id}/accept`,
        { ...params, signature },
        opts,
      );
    },
    revoke: (id: string, params: Params = {}) =>
      this.post<Authorization>(`/v1/authorizations/${id}/revoke`, params),
  };

  browser(transport: BrowserTransport) {
    return {
      connect: async (params: {
        authorization: string;
        session?: string;
      }): Promise<SessionRecord> => {
        const authorization = await this.authorizations.retrieve(
          params.authorization,
        );
        const chain = await this.get<{
          delegation: string;
          agent: string;
          operator: string;
        }>(`/v1/authorizations/${authorization.id}/connection`);
        const key = this.keys.agents[authorization.agent];
        if (!key)
          throw new AapError(
            0,
            "invalid_request_error",
            "agent_key_missing",
            `No signing key is configured for agent ${authorization.agent}.`,
          );
        const claims = await verifyDelegation(
          chain.delegation,
          await this.rootKey(),
        );
        const operator = await verifyOperator(
          chain.operator,
          await this.rootKey(),
        );
        const agent = await verifyAgent(chain.agent, operator);
        if (
          agent.sub !== authorization.agent ||
          operator.sub !== authorization.operator ||
          claims.operator !== operator.sub
        )
          throw new AapError(
            0,
            "invalid_request_error",
            "chain_invalid",
            "Connection certificates do not match the authorization.",
          );
        const challenge = await verifyChallenge(
          await transport.challenge(authorization.origin),
          await this.rootKey(),
        );
        if (
          challenge.origin !== authorization.origin ||
          claims.origin !== authorization.origin ||
          claims.agent !== authorization.agent
        )
          throw new AapError(
            0,
            "invalid_request_error",
            "challenge_origin_mismatch",
            "Connection material does not match the authorization.",
          );
        const session = params.session ?? newId("sess");
        const grant = await signGrant(
          key,
          { sub: authorization.agent } as AgentClaims,
          claims,
          {
            sessionRef: session,
            intent: authorization.intent,
            nonce: challenge.nonce,
          },
        );
        return transport.present({
          origin: authorization.origin,
          session,
          header: buildHeader({ grant, chain }),
        });
      },
    };
  }

  // ---------------------------------------------------------------- attestations
  readonly attestations = {
    /** Submit a credential against a authorization. An operator passes one through; an issuer posts its own. */
    create: (
      authorization: string,
      params: { credential: string },
      opts?: RequestOptions,
    ) =>
      this.post<Attestation>(
        `/v1/authorizations/${authorization}/attestations`,
        params,
        opts,
      ),
    retrieve: (id: string) => this.get<Attestation>(`/v1/attestations/${id}`),
    list: (params: Params = {}) =>
      this.get<ListResponse<Attestation>>("/v1/attestations", params),
    revoke: (id: string) =>
      this.post<Attestation>(`/v1/attestations/${id}/revoke`),
  };

  readonly issuers = {
    retrieve: (id: string) => this.get<IssuerObject>(`/v1/issuers/${id}`),
    list: (params: Params = {}) =>
      this.get<ListResponse<IssuerObject>>("/v1/issuers", params),
  };

  /** Sign credentials with a local key. Nothing is sent. */
  readonly credentials = {
    /** The subject an issuer names for a authorization. */
    subject: (authorization: Pick<Authorization, "operator" | "subject">) =>
      delegationSubject(authorization),
    body: credentialBody,
    issue: (body: CredentialBody, key?: KeyFile) => {
      const signing = key ?? this.keys.issuer;
      if (!signing)
        throw new AapError(
          0,
          "invalid_request_error",
          "issuer_key_missing",
          "No issuer signing key is configured. Pass one, or set keys.issuer.",
        );
      return issueCredential(body, signing);
    },
    /** Sign a credential for a authorization with the agent's own key, for checks the application performed itself. */
    issueForAuthorization: async (
      authorization: Authorization,
      input: {
        issuer: string;
        type: string;
        claims: Record<string, string | number | boolean>;
        validUntil: Date;
        context?: string[];
      },
    ) => {
      const key = this.keys.agents[authorization.agent];
      if (!key)
        throw new AapError(
          0,
          "invalid_request_error",
          "agent_key_missing",
          `No signing key is configured for agent ${authorization.agent}.`,
        );
      return issueCredential(
        credentialBody({ ...input, subject: delegationSubject(authorization) }),
        key,
      );
    },
  };

  // ---------------------------------------------------------------- sessions
  readonly sessions = {
    retrieve: (id: string, opts?: RequestOptions) =>
      this.get<SessionRecord>(`/v1/sessions/${id}`, {}, opts),
    list: (params: Params = {}, opts?: RequestOptions) =>
      this.get<ListResponse<SessionRecord>>("/v1/sessions", params, opts),
  };

  // ---------------------------------------------------------------- customer_actions
  readonly customerActions = {
    create: (
      params: {
        session: string;
        scope: string;
        context?: Record<string, unknown>;
        metadata?: Record<string, string>;
      },
      opts?: RequestOptions,
    ) => this.post<CustomerAction>("/v1/customer_actions", params, opts),
    retrieve: (id: string, opts?: RequestOptions) =>
      this.get<CustomerAction>(`/v1/customer_actions/${id}`, {}, opts),
    list: (params: Params = {}, opts?: RequestOptions) =>
      this.get<ListResponse<CustomerAction>>(
        "/v1/customer_actions",
        params,
        opts,
      ),
    update: (id: string, params: Params) =>
      this.post<CustomerAction>(`/v1/customer_actions/${id}`, params),
    complete: (
      id: string,
      params: { session?: string; result?: Record<string, unknown> } = {},
    ) =>
      this.post<CustomerAction>(`/v1/customer_actions/${id}/complete`, params),
    cancel: (id: string) =>
      this.post<CustomerAction>(`/v1/customer_actions/${id}/cancel`),
    /** Poll until the customer_action is completed, canceled, or expired, or the timeout passes. */
    wait: async (
      id: string,
      opts: { timeout?: number; interval?: number } = {},
    ): Promise<CustomerAction> => {
      const deadline = Date.now() + (opts.timeout ?? 900) * 1000;
      const interval = (opts.interval ?? 1) * 1000;
      for (;;) {
        const h = await this.customerActions.retrieve(id);
        if (h.status !== "pending" || Date.now() >= deadline) return h;
        await new Promise((r) => setTimeout(r, interval));
      }
    },
  };

  // ---------------------------------------------------------------- events and webhooks
  readonly events = {
    retrieve: (id: string) => this.get<EventObject>(`/v1/events/${id}`),
    list: (params: Params = {}) =>
      this.get<ListResponse<EventObject>>("/v1/events", params),
  };

  readonly webhookEndpoints = {
    create: (params: {
      url: string;
      enabled_events?: string[];
      description?: string;
      metadata?: Record<string, string>;
    }) => this.post<WebhookEndpoint>("/v1/webhook_endpoints", params),
    retrieve: (id: string) =>
      this.get<WebhookEndpoint>(`/v1/webhook_endpoints/${id}`),
    list: (params: Params = {}) =>
      this.get<ListResponse<WebhookEndpoint>>("/v1/webhook_endpoints", params),
    update: (id: string, params: Params) =>
      this.post<WebhookEndpoint>(`/v1/webhook_endpoints/${id}`, params),
    del: (id: string) =>
      this.request<{ id: string; deleted: true }>(
        "DELETE",
        `/v1/webhook_endpoints/${id}`,
      ),
  };

  readonly webhooks = {
    constructEvent: (
      body: string,
      signatureHeader: string | null,
      secret: string,
      toleranceS = 300,
    ): EventObject => constructEvent(body, signatureHeader, secret, toleranceS),
  };

  readonly directory = {
    list: () =>
      this.get<ListResponse<{ object: "directory_entry"; hash: string }>>(
        "/v1/directory",
      ),
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

  readonly chain = {
    /** Verify a delegation certificate against the root key, offline apart from fetching the root once. */
    verify: async (
      delegation: DelegationObject | string,
    ): Promise<DelegationClaims> => {
      const cert =
        typeof delegation === "string" ? delegation : delegation.certificate;
      return verifyDelegation(cert, await this.rootKey());
    },
    verifyOperator: async (certificate: string) =>
      verifyOperator(certificate, await this.rootKey()),
  };

  // ---------------------------------------------------------------- test helpers
  readonly test = {
    browser: {
      connect: (params: {
        authorization: string;
        session?: string;
        asn?: string;
        ja4?: string;
      }) =>
        this.browser({
          challenge: async (origin) =>
            (await this.test.challenges.create({ origin })).jwt,
          present: (input) =>
            this.test.presentations.create({
              ...input,
              asn: params.asn,
              ja4: params.ja4,
            }),
        }).connect(params),
    },
    agents: {
      list: () =>
        this.get<
          ListResponse<{ id: string; outcome: string; description: string }>
        >("/v1/test_helpers/agents"),
    },
    sessions: {
      create: (params: {
        origin: string;
        human?: boolean;
        known_device?: boolean;
        age?: number;
        device?: string;
      }) => this.post<SessionRecord>("/v1/test_helpers/sessions", params),
      use: (id: string, params: { scope: string }) =>
        this.post<
          SessionRecord & {
            customer_action?: CustomerAction;
            status_header?: string;
          }
        >(`/v1/test_helpers/sessions/${id}/use`, params),
    },
    challenges: {
      create: (params: { origin: string }) =>
        this.post<{
          object: "challenge";
          origin: string;
          nonce: string;
          expires_at: number;
          jwt: string;
          header: string;
        }>("/v1/test_helpers/challenges", params),
    },
    presentations: {
      create: (params: {
        origin: string;
        header?: string;
        agent?: string;
        session?: string;
        asn?: string;
        ja4?: string;
        scopes?: string[];
      }) =>
        this.post<
          SessionRecord & {
            status_header?: string;
            narrowed?: string[];
            customer_action_scopes?: string[];
            customer_action?: CustomerAction;
          }
        >("/v1/test_helpers/presentations", params),
    },
    customerActions: {
      link: (
        id: string,
        params: { session?: string; known_device?: boolean } = {},
      ) =>
        this.post<CustomerAction>(
          `/v1/test_helpers/customer_actions/${id}/link`,
          params,
        ),
      complete: (
        id: string,
        params: {
          session?: string;
          outcome?: string;
          result?: Record<string, unknown>;
          known_device?: boolean;
        } = {},
      ) =>
        this.post<CustomerAction>(
          `/v1/test_helpers/customer_actions/${id}/complete`,
          params,
        ),
    },
    events: {
      trigger: (
        type: string,
        params: { origin?: string; data?: Record<string, unknown> } = {},
      ) =>
        this.post<EventObject>("/v1/test_helpers/events", { type, ...params }),
    },
  };
}

export type {
  Authorization,
  AuthorizationAcceptParams,
  AuthorizationAcceptance,
} from "../lib/authorization.ts";
export type { KeyFile } from "../lib/keys.ts";
export {
  discover,
  createDiscoveryProfile,
  validateDiscoveryProfile,
} from "../lib/discovery.ts";
export type { DiscoveryProfile, DiscoveryOptions } from "../lib/discovery.ts";
export { generateKeyFile, readKeyFile } from "../lib/keys.ts";
export {
  credentialBody,
  issueCredential,
  VC_CONTEXT,
  SUBJECT_PREFIX,
} from "../lib/credentials.ts";
export { delegationSubject } from "../lib/attestations.ts";
export type {
  Attestation,
  AttestationPolicy,
  AttestedEvidence,
  IssuerObject,
} from "../types.ts";
