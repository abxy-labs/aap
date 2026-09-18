import type {
  AttestationPolicy,
  Constraints,
  CredentialPolicy,
  DisclosureBundle,
  Evidence,
  CustomerActionConfig,
  CustomerActionMode,
  PolicyClaims,
  PolicyObject,
} from "../types.ts";
import { validateConstraints } from "./constraints.ts";
import { validateAttestationPolicy } from "./credentials.ts";
import { invalid } from "./errors.ts";
import { TYP, nowSeconds, sign, verify } from "./jwt.ts";
import type { KeyFile } from "./keys.ts";
import { isCustomerActionOnly, validate, intersect } from "./scopes.ts";
import { Store, id } from "./store.ts";

export interface PolicyInput {
  origin: string;
  scopes: string[];
  allowOperators?: string[] | "any";
  allowAgents?: string[] | "any";
  denyAgents?: string[];
  constraints?: Constraints;
  disclosures?: DisclosureBundle | null;
  evidence?: Partial<Record<string, Evidence>>;
  customer_actions?: CustomerActionConfig[];
  maxAgeS?: number;
  disclose?: { operator: boolean; agent: boolean };
  attestations?: AttestationPolicy | null;
  credentials?: CredentialPolicy | null;
  metadata?: Record<string, string>;
  now?: Date;
}

const EVIDENCE: Evidence[] = [
  "asserted",
  "observed",
  "attested",
  "presented",
  "site",
];
const MODES: CustomerActionMode[] = ["approve", "complete"];

export async function setPolicy(
  store: Store,
  root: KeyFile,
  input: PolicyInput,
): Promise<PolicyObject> {
  validateAttestationPolicy(input.attestations);
  if (validate(input.scopes).length || input.scopes.includes("security:write"))
    throw invalid(
      "invalid_scopes",
      "Policy scopes must be known, grantable scopes.",
      "scopes",
    );
  const constraints = input.constraints ?? {};
  const cErr = validateConstraints(constraints);
  if (cErr) throw invalid("invalid_constraints", cErr, "constraints");
  for (const [scope, ev] of Object.entries(input.evidence ?? {})) {
    if (!input.scopes.includes(scope))
      throw invalid(
        "invalid_evidence",
        `Evidence scope ${scope} is not in policy scopes.`,
        "advanced.evidence",
      );
    if (!EVIDENCE.includes(ev as Evidence))
      throw invalid(
        "invalid_evidence",
        `Unknown evidence level '${ev}'. Use asserted, observed, presented, or site.`,
        "evidence",
      );
  }
  const customer_actions = input.customer_actions ?? [];
  const unknown = validate(customer_actions.map((h) => h.scope));
  if (unknown.length)
    throw invalid(
      "unknown_scope",
      `Unknown scopes in customer_actions: ${unknown.join(", ")}.`,
      "customer_actions",
    );
  for (const h of customer_actions) {
    if (h.mode !== undefined && !MODES.includes(h.mode))
      throw invalid(
        "invalid_customer_action",
        `CustomerAction mode for ${h.scope} must be approve or complete.`,
        "customer_actions",
      );
    if (isCustomerActionOnly(h.scope) && h.mode === "approve")
      throw invalid(
        "invalid_customer_action",
        `${h.scope} can only be completed by the consumer; its mode must be complete.`,
        "customer_actions",
      );
    if (h.url && !/^https:\/\//.test(h.url))
      throw invalid(
        "invalid_customer_action",
        `CustomerAction url for ${h.scope} must be an https URL.`,
        "customer_actions",
      );
    if (
      h.expires_in !== undefined &&
      (!Number.isInteger(h.expires_in) || h.expires_in < 60)
    )
      throw invalid(
        "invalid_customer_action",
        `CustomerAction expires_in for ${h.scope} must be at least 60 seconds.`,
        "customer_actions",
      );
  }
  const existing = await store.getPolicy(input.origin);
  const version = (existing?.version ?? 0) + 1;
  const claims: PolicyClaims = {
    iss: "foil",
    sub: input.origin,
    version,
    scopes: [...new Set(input.scopes)],
    allow: {
      operators: input.allowOperators ?? "any",
      agents: input.allowAgents ?? "any",
      deny_agents: input.denyAgents ?? [],
    },
    constraints,
    disclosures: input.disclosures ?? null,
    evidence: input.evidence ?? {},
    customer_actions,
    max_age_s: input.maxAgeS ?? 30 * 86400,
    disclose: input.disclose ?? { operator: false, agent: false },
    attestations: input.attestations ?? null,
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
    scopes: claims.scopes,
    allow: claims.allow,
    constraints: claims.constraints,
    disclosures: claims.disclosures,
    evidence: claims.evidence,
    customer_actions: claims.customer_actions,
    max_age_s: claims.max_age_s,
    disclose: claims.disclose,
    attestations: claims.attestations,
    credentials: claims.credentials,
    statement,
  };
  await store.putPolicy(obj);
  return obj;
}

/** Only explicitly listed scopes are admitted. */
export function permittedScopes(
  scopes: string[],
  policy: PolicyClaims,
): string[] {
  return intersect(scopes, policy.scopes);
}

export async function loadPolicy(
  store: Store,
  root: KeyFile,
  origin: string,
): Promise<PolicyClaims | null> {
  const p = await store.getPolicy(origin);
  if (!p) return null;
  const { claims } = await verify<PolicyClaims>(
    p.statement,
    root.public,
    TYP.policy,
  );
  return claims;
}

export function admitsAgents(p: PolicyClaims | null): p is PolicyClaims {
  return !!p && p.scopes.length > 0;
}

export function operatorAllowed(p: PolicyClaims, operatorId: string): boolean {
  return p.allow.operators === "any" || p.allow.operators.includes(operatorId);
}

export function agentAllowed(p: PolicyClaims, agentId: string): boolean {
  if (p.allow.deny_agents.includes(agentId)) return false;
  return p.allow.agents === "any" || p.allow.agents.includes(agentId);
}

/** The customer_action configuration that applies to a scope under a policy, or null when the agent may perform it. */
export function customerActionConfigFor(
  policy: PolicyClaims,
  scope: string,
): Required<CustomerActionConfig> | null {
  const cfg = policy.customer_actions.find((h) => h.scope === scope);
  if (isCustomerActionOnly(scope)) {
    return {
      scope,
      mode: "complete",
      url: cfg?.url ?? null,
      expires_in: cfg?.expires_in ?? 86400,
    };
  }
  if (cfg)
    return {
      scope,
      mode: cfg.mode ?? "complete",
      url: cfg.url ?? null,
      expires_in: cfg.expires_in ?? 900,
    };
  if (policy.evidence[scope] === "site")
    return { scope, mode: "complete", url: null, expires_in: 900 };
  return null;
}

export function customerActionsFor(
  policy: PolicyClaims,
  scopes: string[],
): Required<CustomerActionConfig>[] {
  return scopes
    .map((s) => customerActionConfigFor(policy, s))
    .filter((c): c is Required<CustomerActionConfig> => c !== null);
}
