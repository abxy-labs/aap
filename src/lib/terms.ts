import type { AgentClaims, PolicyClaims, Terms } from "../types.ts";
import { describeMoney, intersectConstraints } from "./constraints.ts";
import { VOCABULARY, intersect, validate, withinTier } from "./scopes.ts";

export function computeTerms(agent: AgentClaims, policy: PolicyClaims, requested: string[]): { terms: Terms; etag: string } {
  const unknown = validate(requested);
  if (unknown.length) throw new Error(`unknown scopes: ${unknown.join(", ")}`);
  const scopes = withinTier(intersect(requested, agent.ceiling.scopes), policy.tier);
  const constraints = intersectConstraints(agent.ceiling.constraints, policy.constraints);
  const terms: Terms = {
    policy_version: policy.version,
    scopes: scopes.map((id) => ({ id, text: describeScope(id, agent.name, constraints) })),
    constraints,
    max_age_s: policy.max_age_s,
    evidence: policy.evidence,
    disclosures: policy.disclosures ? substitute(policy.disclosures, agent.name, policy.max_age_s) : null,
  };
  return { terms, etag: etagOf(terms) };
}

export function etagOf(terms: Terms): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(terms));
  return "t_" + hasher.digest("hex").slice(0, 8);
}

function describeScope(id: string, agentName: string, c: Terms["constraints"]): string {
  const base = VOCABULARY[id]?.text ?? id;
  if (id === "payments:initiate" || id === "transfers:initiate") {
    const parts: string[] = [base];
    if (c.max_amount) parts.push(`up to ${describeMoney(c.max_amount)} each`);
    if (c.max_total) parts.push(`and ${describeMoney(c.max_total)} in total`);
    if (c.payees === "existing_only" && id === "payments:initiate") parts.push("to payees you already have");
    return parts.join(" ");
  }
  return base.replace("{agent}", agentName);
}

function substitute(bundle: NonNullable<Terms["disclosures"]>, agentName: string, maxAgeS: number): NonNullable<Terms["disclosures"]> {
  const days = Math.round(maxAgeS / 86400);
  return {
    ...bundle,
    acknowledgements: bundle.acknowledgements.map((a) => ({
      ...a,
      text: a.text.replace("{agent}", agentName).replace("{days}", String(days)),
    })),
  };
}
