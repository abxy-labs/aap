import type { AgentClaims, PolicyClaims, TermsObject } from "../types.ts";
import { formatAmount, intersectConstraints } from "./constraints.ts";
import { invalid } from "./errors.ts";
import { VOCABULARY, intersect, validate, withinTier } from "./scopes.ts";
import { Store, id, now } from "./store.ts";

export const TERMS_TTL_S = 3600;

export type TermsBody = Omit<TermsObject, "id" | "object" | "created" | "livemode" | "metadata" | "expires_at">;

/** What the consumer must be shown for this agent at this origin, intersected with the ceiling and the policy. */
export function computeTerms(agent: AgentClaims, policy: PolicyClaims, requested: string[]): TermsBody {
  const unknown = validate(requested);
  if (unknown.length) throw invalid("unknown_scope", `Unknown scopes: ${unknown.join(", ")}.`, "scopes");
  const scopes = withinTier(intersect(requested, agent.ceiling.scopes), policy.tier);
  const constraints = intersectConstraints(agent.ceiling.constraints, policy.constraints);
  return {
    agent: agent.sub,
    origin: policy.sub,
    policy_version: policy.version,
    scopes: scopes.map((s) => ({ id: s, text: describeScope(s, agent.name, constraints) })),
    constraints,
    max_age_s: policy.max_age_s,
    evidence: policy.evidence,
    disclosures: policy.disclosures ? substitute(policy.disclosures, agent.name, policy.max_age_s) : null,
  };
}

export async function createTerms(store: Store, agent: AgentClaims, policy: PolicyClaims, requested: string[], metadata: Record<string, string> = {}): Promise<TermsObject> {
  const body = computeTerms(agent, policy, requested);
  if (body.scopes.length === 0) {
    throw invalid("no_permitted_scopes", "No requested scope is permitted by both the agent's ceiling and the site's policy.", "scopes");
  }
  const created = now();
  const obj: TermsObject = { id: id("trm"), object: "terms", created, livemode: store.livemode, metadata, ...body, expires_at: created + TERMS_TTL_S };
  await store.putTerms(obj);
  return obj;
}

function describeScope(scope: string, agentName: string, c: TermsBody["constraints"]): string {
  const base = VOCABULARY[scope]?.text ?? scope;
  if (scope === "payments:initiate" || scope === "transfers:initiate") {
    const parts: string[] = [base];
    if (c.max_amount !== undefined) parts.push(`up to ${formatAmount(c.max_amount, c.currency)} each`);
    if (c.max_total !== undefined) parts.push(`and ${formatAmount(c.max_total, c.currency)} in total`);
    if (c.payees === "existing_only" && scope === "payments:initiate") parts.push("to payees you already have");
    return parts.join(" ");
  }
  return base.replace("{agent}", agentName);
}

function substitute(bundle: NonNullable<TermsBody["disclosures"]>, agentName: string, maxAgeS: number): NonNullable<TermsBody["disclosures"]> {
  const days = Math.round(maxAgeS / 86400);
  return {
    ...bundle,
    acknowledgements: bundle.acknowledgements.map((a) => ({ ...a, text: a.text.replace("{agent}", agentName).replace("{days}", String(days)) })),
  };
}
