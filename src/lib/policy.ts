import type { Constraints, DisclosureBundle, Evidence, PolicyClaims, Tier } from "../types.ts";
import { TYP, decode, nowSeconds, sign, verify } from "./jwt.ts";
import type { KeyFile } from "./keys.ts";
import { Store, type StoredPolicy } from "./store.ts";
import { TIERS, validate } from "./scopes.ts";

export interface PolicyInput {
  origin: string;
  tier: Tier | "none";
  allowOperators?: string[] | "any";
  allowAgents?: string[] | "any";
  denyAgents?: string[];
  constraints?: Constraints;
  disclosures?: DisclosureBundle | null;
  evidence?: Partial<Record<Tier, Evidence>>;
  handoff?: string[];
  maxAgeS?: number;
  disclose?: { operator: boolean; agent: boolean };
  now?: Date;
}

export async function setPolicy(store: Store, root: KeyFile, input: PolicyInput): Promise<StoredPolicy> {
  if (input.tier !== "none" && !TIERS.includes(input.tier)) throw new Error(`unknown tier ${input.tier}`);
  if (input.tier === "control") throw new Error("control tier cannot be a policy ceiling");
  const unknown = validate(input.handoff ?? []);
  if (unknown.length) throw new Error(`unknown handoff scopes: ${unknown.join(", ")}`);
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
    constraints: input.constraints ?? {},
    disclosures: input.disclosures ?? null,
    evidence: input.evidence ?? {},
    handoff: input.handoff ?? [],
    max_age_s: input.maxAgeS ?? 30 * 86400,
    disclose: input.disclose ?? { operator: false, agent: false },
    iat: nowSeconds(input.now),
  };
  const jwt = await sign(claims as never, root.private, TYP.policy);
  const stored = { origin: input.origin, version, jwt };
  await store.putPolicy(stored);
  return stored;
}

export async function loadPolicy(store: Store, root: KeyFile, origin: string): Promise<PolicyClaims | null> {
  const p = await store.getPolicy(origin);
  if (!p) return null;
  const { claims } = await verify<PolicyClaims>(p.jwt, root.public, TYP.policy);
  return claims;
}

export function decodePolicy(jwt: string): PolicyClaims {
  return decode<PolicyClaims>(jwt).claims;
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
