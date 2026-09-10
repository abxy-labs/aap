import type { JWK } from "jose";
import type { Acceptance, AgentClaims, DelegationClaims, DelegationRecord, ObservedEvidence, OperatorClaims } from "../types.ts";
import { TYP, nowSeconds, sign, verify } from "./jwt.ts";
import type { KeyFile } from "./keys.ts";
import { admitsAgents, agentAllowed, loadPolicy, operatorAllowed } from "./policy.ts";
import { Store, type StoredDelegation, id, iso } from "./store.ts";
import { computeTerms } from "./terms.ts";
import { isSubset, validate } from "./scopes.ts";
import { isAtLeastAsRestrictive } from "./constraints.ts";

export interface DelegationRequest {
  agent: AgentClaims;
  operator: OperatorClaims;
  origin: string;
  subject: string;
  scopes: string[];
  intent: string;
  acceptance: Acceptance;
  siteSession?: string;
  now?: Date;
}

/**
 * Foil's side of POST /v1/delegations. The request is assumed to have been
 * signature-checked against the agent key by the caller (see verifyRequestSignature).
 */
export async function createDelegation(store: Store, root: KeyFile, req: DelegationRequest): Promise<StoredDelegation> {
  const now = req.now ?? new Date();
  const policy = await loadPolicy(store, root, req.origin);
  if (!admitsAgents(policy)) throw new Error(`${req.origin} does not admit agents`);
  if (!operatorAllowed(policy, req.operator.sub)) throw new Error(`policy for ${req.origin} does not admit operator ${req.operator.sub}`);
  if (!agentAllowed(policy, req.agent.sub)) throw new Error(`policy for ${req.origin} does not admit agent ${req.agent.sub}`);
  const unknown = validate(req.scopes);
  if (unknown.length) throw new Error(`unknown scopes: ${unknown.join(", ")}`);

  const { terms, etag } = computeTerms(req.agent, policy, req.scopes);
  if (req.acceptance.terms !== etag) {
    throw new Error(`acceptance references terms ${req.acceptance.terms} but current terms are ${etag}; fetch terms again`);
  }
  if (terms.scopes.length === 0) throw new Error("no requested scope is permitted by the agent ceiling and the site policy");

  const bundle = terms.disclosures;
  if (bundle) {
    if (bundle.presentation === "site") {
      throw new Error(`disclosure bundle ${bundle.bundle} must be completed on the site and cannot be accepted in an app`);
    }
    const required = bundle.acknowledgements.map((a) => a.id);
    const missing = required.filter((a) => !req.acceptance.acknowledged.includes(a));
    if (missing.length) throw new Error(`acceptance is missing acknowledgements: ${missing.join(", ")}`);
    const mustView = bundle.documents.filter((d) => d.render === "full").map((d) => d.id);
    const unviewed = mustView.filter((d) => !req.acceptance.viewed.includes(d));
    if (unviewed.length) throw new Error(`documents that must be rendered in full were not viewed: ${unviewed.join(", ")}`);
    if (bundle.retain === "copy_required" && !req.acceptance.copies_sent_to) {
      throw new Error("bundle requires a retained copy; acceptance must state where copies were sent");
    }
  }

  let observed: ObservedEvidence | null = null;
  if (req.siteSession) {
    const s = await store.getSiteSession(req.siteSession);
    if (!s) throw new Error(`site session ${req.siteSession} is not known to Foil`);
    if (s.origin !== req.origin) throw new Error(`site session ${req.siteSession} is at ${s.origin}, not ${req.origin}`);
    if (!s.human) throw new Error(`site session ${req.siteSession} was not scored human`);
    const age = Math.max(0, Math.floor((now.getTime() - new Date(s.created_at).getTime()) / 1000));
    observed = { site_session: s.id, human: true, known_device: s.known_device, age_s: age };
  }

  const scopes = terms.scopes.map((s) => s.id);
  const iat = nowSeconds(now);
  const dlId = id("dl");
  const record: DelegationRecord = {
    id: id("dr"),
    asserted: {
      by: req.agent.sub,
      terms: etag,
      acknowledged: req.acceptance.acknowledged,
      viewed: req.acceptance.viewed,
      channel: req.acceptance.channel,
      accepted_at: req.acceptance.accepted_at,
      ...(req.acceptance.copies_sent_to ? { copies_sent_to: req.acceptance.copies_sent_to } : {}),
    },
    observed,
  };
  const claims: DelegationClaims = {
    iss: "foil",
    sub: dlId,
    agent: req.agent.sub,
    operator: req.operator.sub,
    origin: req.origin,
    subject: req.subject,
    scopes,
    constraints: terms.constraints,
    policy_version: policy.version,
    terms: etag,
    intent: req.intent,
    record,
    iat,
    exp: iat + policy.max_age_s,
    jti: dlId,
  };
  const jwt = await sign(claims as never, root.private, TYP.delegation);
  const stored: StoredDelegation = { id: dlId, jwt, claims, status: "active" };
  await store.putDelegation(stored);
  await store.putRecord(record);
  return stored;
}

export async function verifyDelegation(jwt: string, rootPublic: JWK, now?: Date): Promise<DelegationClaims> {
  const { claims } = await verify<DelegationClaims>(jwt, rootPublic, TYP.delegation, { now });
  if (claims.iss !== "foil" || !claims.sub || !claims.agent || !claims.origin) throw new Error("delegation certificate is malformed");
  return claims;
}

export function delegationWithinCeiling(d: DelegationClaims, agent: AgentClaims): boolean {
  return isSubset(d.scopes, agent.ceiling.scopes) && isAtLeastAsRestrictive(d.constraints, agent.ceiling.constraints);
}

export async function revokeDelegation(store: Store, dlId: string, by: string, now?: Date): Promise<StoredDelegation> {
  const d = await store.getDelegation(dlId);
  if (!d) throw new Error(`delegation ${dlId} not found`);
  d.status = "revoked";
  d.revoked_at = iso(nowSeconds(now));
  d.revoked_by = by;
  await store.putDelegation(d);
  return d;
}

/** Sign a delegation request body with the agent key, and verify one. */
export async function signRequest(body: unknown, agentKey: KeyFile): Promise<string> {
  return sign({ body_sha256: sha256(JSON.stringify(body)) }, agentKey.private, TYP.request);
}

export async function verifyRequestSignature(body: unknown, signature: string, agentPublic: JWK): Promise<void> {
  const { claims } = await verify<{ body_sha256: string }>(signature, agentPublic, TYP.request);
  if (claims.body_sha256 !== sha256(JSON.stringify(body))) throw new Error("delegation request signature does not match the body");
}

function sha256(s: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(s);
  return h.digest("hex");
}
