import type { JWK } from "jose";
import type { Attestation, AttestationPolicy, AttestedEvidence, PolicyClaims, StoredDelegation, Tier } from "../types.ts";
import { SUBJECT_PREFIX, checkAgainstPolicy, retainedClaims, verifyCredential, type IssuerKey } from "./credentials.ts";
import { invalid } from "./errors.ts";
import { decode } from "./jwt.ts";
import { tierOf } from "./scopes.ts";
import { Store, id, now } from "./store.ts";
import type { AgentClaims, OperatorClaims } from "../types.ts";

/** The subject an issuer names in a credential for this delegation. */
export function delegationSubject(d: { operator: string; subject: string }): string {
  return `${SUBJECT_PREFIX}${d.operator}:${d.subject}`;
}

export interface AcceptInput {
  delegation: StoredDelegation;
  policy: PolicyClaims;
  credential: string;
  submittedBy: Attestation["submitted_by"];
  /** For an issuer account, its issuer id, so the credential must name that issuer. */
  issuerAccount?: string | null;
  /** The operator's key and its agent's key, when the policy admits "operator" as an issuer. */
  operatorKey?: JWK & { kid: string };
  agentKey?: JWK & { kid: string };
  now?: number;
}

/** Resolve the keys a credential may be signed with, from the site's policy and the registry. */
async function candidateKeys(store: Store, policy: AttestationPolicy, delegation: StoredDelegation, operatorKey?: JWK & { kid: string }, agentKey?: JWK & { kid: string }): Promise<IssuerKey[]> {
  const keys: IssuerKey[] = [];
  for (const name of policy.issuers) {
    // "operator" admits the delegation's own operator and the agent acting under it, which is how an
    // application states a check it performed itself.
    if (name === "operator") {
      if (operatorKey) keys.push({ issuer: delegation.operator, key: operatorKey });
      if (agentKey) keys.push({ issuer: delegation.agent, key: agentKey });
      continue;
    }
    const issuer = await store.getIssuer(name);
    if (!issuer || issuer.status !== "active") continue;
    for (const key of issuer.public_keys) keys.push({ issuer: issuer.url, key });
  }
  return keys;
}

/** Verify a credential and record it against the delegation. */
export async function acceptAttestation(store: Store, input: AcceptInput): Promise<Attestation> {
  const t = input.now ?? now();
  const policy = input.policy.attestations;
  if (!policy) throw invalid("attestations_not_accepted", `${input.delegation.origin} does not accept attestations. The site must configure them first.`, "credential");
  const keys = await candidateKeys(store, policy, input.delegation, input.operatorKey, input.agentKey);
  if (!keys.length) throw invalid("no_trusted_issuer", "No issuer this site accepts has a registered key.", "credential");

  const vc = await verifyCredential(input.credential, keys, t);
  if (input.issuerAccount) {
    const account = await store.getIssuer(input.issuerAccount);
    if (!account || account.url !== vc.issuer) throw invalid("issuer_mismatch", "The credential names a different issuer than the account submitting it.", "credential");
  }
  checkAgainstPolicy(vc, policy, delegationSubject(input.delegation), t);

  const a: Attestation = {
    id: id("att"), object: "attestation", created: t, livemode: store.livemode, metadata: {},
    status: "active",
    delegation: input.delegation.id,
    origin: input.delegation.origin,
    issuer: vc.issuer,
    type: vc.type,
    subject: vc.subject,
    claims: retainedClaims(vc, policy),
    issued_at: vc.issued_at,
    valid_until: vc.valid_until,
    verified_at: t,
    submitted_by: input.submittedBy,
    holder_bound: false,
    revoked_at: null,
    revoked_by: null,
  };
  await store.putAttestation(a);
  await refreshDelegationEvidence(store, input.delegation.id, t);
  return a;
}

export function effectiveAttestationStatus(a: Attestation, t = now()): Attestation["status"] {
  if (a.status === "revoked") return "revoked";
  return a.valid_until <= t ? "expired" : "active";
}

export function toEvidence(a: Attestation): AttestedEvidence {
  return { attestation: a.id, issuer: a.issuer, type: a.type, claims: a.claims, holder_bound: false, issued_at: a.issued_at, valid_until: a.valid_until, verified_at: a.verified_at };
}

/** Active attestations for a delegation, newest first. */
export async function activeAttestations(store: Store, delegation: string, t = now()): Promise<Attestation[]> {
  return (await store.listAttestations())
    .filter((a) => a.delegation === delegation && effectiveAttestationStatus(a, t) === "active")
    .sort((a, b) => b.verified_at - a.verified_at);
}

/** Copy the current attestation summaries into the delegation record. */
export async function refreshDelegationEvidence(store: Store, delegation: string, t = now()): Promise<AttestedEvidence[]> {
  const evidence = (await activeAttestations(store, delegation, t)).map(toEvidence);
  const d = await store.getDelegation(delegation);
  if (d) {
    d.claims.record.attested = evidence;
    await store.putDelegation(d);
    await store.putRecord(d.claims.record);
  }
  return evidence;
}

/** Whether the delegation carries an attestation that satisfies the site's policy. */
export async function satisfiesAttested(store: Store, delegation: string, policy: PolicyClaims, t = now()): Promise<AttestedEvidence | null> {
  const p = policy.attestations;
  if (!p) return null;
  for (const a of await activeAttestations(store, delegation, t)) {
    if (!p.types.includes(a.type)) continue;
    if (p.claims.some((c) => !(c in a.claims))) continue;
    if (p.max_age_s !== undefined && t - a.issued_at > p.max_age_s) continue;
    return toEvidence(a);
  }
  return null;
}

/** The tiers in use that the site's policy requires attested evidence for. */
export function attestedTiers(scopes: string[], policy: PolicyClaims): Tier[] {
  const tiers = new Set<Tier>();
  for (const s of scopes) {
    const tier = tierOf(s);
    if (tier && policy.evidence[tier] === "attested") tiers.add(tier);
  }
  return [...tiers];
}

/** The operator's public key from its certificate, for policies that admit the delegation's own operator as an issuer. */
export function operatorSigningKey(operator: OperatorClaims): (JWK & { kid: string }) | undefined {
  const key = operator.key as JWK & { kid?: string };
  return key?.kid ? (key as JWK & { kid: string }) : undefined;
}

/** The agent's public key, for an application that signs its own checks. */
export function agentSigningKey(agent: AgentClaims): (JWK & { kid: string }) | undefined {
  const key = agent.key as JWK & { kid?: string };
  return key?.kid ? (key as JWK & { kid: string }) : undefined;
}

export function decodeIssuer(credential: string): string | null {
  try {
    return (decode<{ issuer?: string }>(credential).claims.issuer as string) ?? null;
  } catch {
    return null;
  }
}
