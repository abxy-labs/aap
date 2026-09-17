import type { Constraints, CredentialPolicy, DisclosureBundle, Evidence, HandoffConfig, HandoffMode, PolicyClaims, PolicyObject, Tier } from "../types.ts";
import { validateConstraints } from "./constraints.ts";
import { invalid } from "./errors.ts";
import { TYP, nowSeconds, sign, verify } from "./jwt.ts";
import type { KeyFile } from "./keys.ts";
import { TIERS, isHandoffOnly, tierOf, validate } from "./scopes.ts";
import { Store, id } from "./store.ts";

export interface PolicyInput {
  origin: string;
  tier: Tier | "none";
  allowOperators?: string[] | "any";
  allowAgents?: string[] | "any";
  denyAgents?: string[];
  constraints?: Constraints;
  disclosures?: DisclosureBundle | null;
  evidence?: Partial<Record<Tier, Evidence>>;
  handoffs?: HandoffConfig[];
  maxAgeS?: number;
  disclose?: { operator: boolean; agent: boolean };
  credentials?: CredentialPolicy | null;
  metadata?: Record<string, string>;
  now?: Date;
}

const EVIDENCE: Evidence[] = ["asserted", "observed", "presented", "site"];
const MODES: HandoffMode[] = ["approve", "complete"];

export async function setPolicy(store: Store, root: KeyFile, input: PolicyInput): Promise<PolicyObject> {
  if (input.tier !== "none" && !TIERS.includes(input.tier)) throw invalid("invalid_tier", `Unknown tier '${input.tier}'. Use observe, read, manage, transact, or none.`, "tier");
  if (input.tier === "control") throw invalid("invalid_tier", "The control tier cannot be a policy ceiling.", "tier");
  const constraints = input.constraints ?? {};
  const cErr = validateConstraints(constraints);
  if (cErr) throw invalid("invalid_constraints", cErr, "constraints");
  for (const [tier, ev] of Object.entries(input.evidence ?? {})) {
    if (!TIERS.includes(tier as Tier)) throw invalid("invalid_evidence", `Unknown tier '${tier}' in evidence.`, "evidence");
    if (!EVIDENCE.includes(ev as Evidence)) throw invalid("invalid_evidence", `Unknown evidence level '${ev}'. Use asserted, observed, presented, or site.`, "evidence");
  }
  const handoffs = input.handoffs ?? [];
  const unknown = validate(handoffs.map((h) => h.scope));
  if (unknown.length) throw invalid("unknown_scope", `Unknown scopes in handoffs: ${unknown.join(", ")}.`, "handoffs");
  for (const h of handoffs) {
    if (h.mode !== undefined && !MODES.includes(h.mode)) throw invalid("invalid_handoff", `Handoff mode for ${h.scope} must be approve or complete.`, "handoffs");
    if (isHandoffOnly(h.scope) && h.mode === "approve") throw invalid("invalid_handoff", `${h.scope} can only be completed by the consumer; its mode must be complete.`, "handoffs");
    if (h.url && !/^https:\/\//.test(h.url)) throw invalid("invalid_handoff", `Handoff url for ${h.scope} must be an https URL.`, "handoffs");
    if (h.expires_in !== undefined && (!Number.isInteger(h.expires_in) || h.expires_in < 60)) throw invalid("invalid_handoff", `Handoff expires_in for ${h.scope} must be at least 60 seconds.`, "handoffs");
  }
  const existing = await store.getPolicy(input.origin);
  const version = (existing?.version ?? 0) + 1;
  const claims: PolicyClaims = {
    iss: "foil",
    sub: input.origin,
    version,
    tier: input.tier,
    allow: {
      operators: input.allowOperators ?? "any",
      agents: input.allowAgents ?? "any",
      deny_agents: input.denyAgents ?? [],
    },
    constraints,
    disclosures: input.disclosures ?? null,
    evidence: input.evidence ?? {},
    handoffs,
    max_age_s: input.maxAgeS ?? 30 * 86400,
    disclose: input.disclose ?? { operator: false, agent: false },
    credentials: input.credentials ?? null,
    iat: nowSeconds(input.now),
  };
  const statement = await sign(claims as never, root.private, TYP.policy);
  const obj: PolicyObject = {
    id: id("pol"),
    object: "policy",
    created: claims.iat,
    livemode: store.livemode,
    metadata: input.metadata ?? {},
    origin: input.origin,
    version,
    tier: claims.tier,
    allow: claims.allow,
    constraints: claims.constraints,
    disclosures: claims.disclosures,
    evidence: claims.evidence,
    handoffs: claims.handoffs,
    max_age_s: claims.max_age_s,
    disclose: claims.disclose,
    credentials: claims.credentials,
    statement,
  };
  await store.putPolicy(obj);
  return obj;
}

export async function loadPolicy(store: Store, root: KeyFile, origin: string): Promise<PolicyClaims | null> {
  const p = await store.getPolicy(origin);
  if (!p) return null;
  const { claims } = await verify<PolicyClaims>(p.statement, root.public, TYP.policy);
  return claims;
}

export function admitsAgents(p: PolicyClaims | null): p is PolicyClaims {
  return !!p && p.tier !== "none";
}

export function operatorAllowed(p: PolicyClaims, operatorId: string): boolean {
  return p.allow.operators === "any" || p.allow.operators.includes(operatorId);
}

export function agentAllowed(p: PolicyClaims, agentId: string): boolean {
  if (p.allow.deny_agents.includes(agentId)) return false;
  return p.allow.agents === "any" || p.allow.agents.includes(agentId);
}

/** The handoff configuration that applies to a scope under a policy, or null when the agent may perform it. */
export function handoffConfigFor(policy: PolicyClaims, scope: string): Required<HandoffConfig> | null {
  const cfg = policy.handoffs.find((h) => h.scope === scope);
  if (isHandoffOnly(scope)) {
    return { scope, mode: "complete", url: cfg?.url ?? null, expires_in: cfg?.expires_in ?? 86400 };
  }
  if (cfg) return { scope, mode: cfg.mode ?? "complete", url: cfg.url ?? null, expires_in: cfg.expires_in ?? 900 };
  const t = tierOf(scope);
  if (t && policy.evidence[t] === "site") return { scope, mode: "complete", url: null, expires_in: 900 };
  return null;
}

export function handoffFor(policy: PolicyClaims, scopes: string[]): Required<HandoffConfig>[] {
  return scopes.map((s) => handoffConfigFor(policy, s)).filter((c): c is Required<HandoffConfig> => c !== null);
}
