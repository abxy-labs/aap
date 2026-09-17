import type { JWK } from "jose";
import type { Acceptance, AgentClaims, DelegationClaims, DelegationRecord, ObservedEvidence, OperatorClaims, StoredDelegation } from "../types.ts";
import { isAtLeastAsRestrictive } from "./constraints.ts";
import { ApiError, invalid, notFound } from "./errors.ts";
import { TYP, nowSeconds, sign, verify } from "./jwt.ts";
import type { KeyFile } from "./keys.ts";
import { admitsAgents, agentAllowed, loadPolicy, operatorAllowed } from "./policy.ts";
import { isSubset, validate } from "./scopes.ts";
import { Store, id, now as nowS, sha } from "./store.ts";

export interface DelegationRequest {
  agent: AgentClaims;
  operator: OperatorClaims;
  origin: string;
  subject: string;
  scopes?: string[];
  terms: string;
  intent: string;
  acceptance: Acceptance;
  siteSession?: string;
  metadata?: Record<string, string>;
  now?: Date;
}

/** The fields an operator signs when it posts a delegation request. Order matters. */
export function delegationSigningPayload(body: {
  agent: string; origin: string; subject: string; scopes?: string[]; terms: string; intent?: string; acceptance: Acceptance; site_session?: string | null; attestations?: string[] | null;
}): string {
  return JSON.stringify({
    agent: body.agent,
    origin: body.origin,
    subject: body.subject,
    scopes: body.scopes ?? null,
    terms: body.terms,
    intent: body.intent ?? "",
    acceptance: body.acceptance,
    site_session: body.site_session ?? null,
    attestations: body.attestations ?? null,
  });
}

export async function createDelegation(store: Store, root: KeyFile, req: DelegationRequest): Promise<StoredDelegation> {
  const now = req.now ?? new Date();
  const policy = await loadPolicy(store, root, req.origin);
  if (!admitsAgents(policy)) throw invalid("origin_not_participating", `${req.origin} does not admit agents.`, "origin");
  if (!operatorAllowed(policy, req.operator.sub)) throw invalid("operator_not_admitted", `The policy for ${req.origin} does not admit operator ${req.operator.sub}.`, "agent");
  if (!agentAllowed(policy, req.agent.sub)) throw invalid("agent_not_admitted", `The policy for ${req.origin} does not admit agent ${req.agent.sub}.`, "agent");

  const terms = await store.getTerms(req.terms);
  if (!terms) throw notFound("terms", req.terms);
  if (terms.agent !== req.agent.sub || terms.origin !== req.origin) throw invalid("terms_mismatch", `Terms ${terms.id} were created for a different agent or origin.`, "terms");
  if (terms.expires_at < nowSeconds(now)) throw invalid("terms_expired", `Terms ${terms.id} expired at ${terms.expires_at}. Create new terms and present them again.`, "terms");
  if (terms.policy_version !== policy.version) throw invalid("terms_stale", `The policy for ${req.origin} changed since terms ${terms.id} were created. Create new terms and present them again.`, "terms");
  if (req.acceptance.terms !== terms.id) throw invalid("acceptance_terms_mismatch", `The acceptance references terms ${req.acceptance.terms} but the request names ${terms.id}.`, "acceptance");

  const permitted = terms.scopes.map((s) => s.id);
  const scopes = req.scopes ?? permitted;
  const unknown = validate(scopes);
  if (unknown.length) throw invalid("unknown_scope", `Unknown scopes: ${unknown.join(", ")}.`, "scopes");
  if (!isSubset(scopes, permitted)) {
    throw invalid("scopes_not_in_terms", `Scopes not in the terms the consumer accepted: ${scopes.filter((s) => !permitted.includes(s)).join(", ")}.`, "scopes");
  }

  const bundle = terms.disclosures;
  if (bundle) {
    if (bundle.presentation === "site") {
      throw invalid("disclosures_site_only", `Disclosure bundle ${bundle.bundle} must be completed on the site and cannot be accepted in an application.`, "acceptance");
    }
    const required = bundle.acknowledgements.map((a) => a.id);
    const missing = required.filter((a) => !req.acceptance.acknowledged.includes(a));
    if (missing.length) throw invalid("acknowledgements_missing", `The acceptance is missing acknowledgements: ${missing.join(", ")}.`, "acceptance.acknowledged");
    const mustView = bundle.documents.filter((d) => d.render === "full").map((d) => d.id);
    const unviewed = mustView.filter((d) => !req.acceptance.viewed.includes(d));
    if (unviewed.length) throw invalid("documents_not_viewed", `Documents that must be rendered in full were not viewed: ${unviewed.join(", ")}.`, "acceptance.viewed");
    if (bundle.retain === "copy_required" && !req.acceptance.copies_sent_to) {
      throw invalid("copy_required", "The bundle requires a retained copy. The acceptance must state where copies were sent.", "acceptance.copies_sent_to");
    }
  }

  let observed: ObservedEvidence | null = null;
  if (req.siteSession) {
    const s = await store.getSiteSession(req.siteSession);
    if (!s) throw invalid("site_session_unknown", `Session ${req.siteSession} is not a consumer session Foil has observed.`, "site_session");
    if (s.origin !== req.origin) throw invalid("site_session_origin", `Session ${req.siteSession} is at ${s.origin}, not ${req.origin}.`, "site_session");
    if (!s.human) throw invalid("site_session_not_human", `Session ${req.siteSession} was not scored human.`, "site_session");
    const age = Math.max(0, Math.floor((now.getTime() - new Date(s.created_at).getTime()) / 1000));
    observed = { site_session: s.id, human: true, known_device: s.known_device, age_s: age };
  }

  const iat = nowSeconds(now);
  const dlId = id("dl");
  const record: DelegationRecord = {
    id: id("dr"),
    object: "delegation_record",
    asserted: {
      by: req.agent.sub,
      terms: terms.id,
      acknowledged: req.acceptance.acknowledged,
      viewed: req.acceptance.viewed,
      channel: req.acceptance.channel,
      accepted_at: req.acceptance.accepted_at,
      ...(req.acceptance.copies_sent_to ? { copies_sent_to: req.acceptance.copies_sent_to } : {}),
    },
    observed,
    attested: [],
    presented: null,
  };
  const claims: DelegationClaims = {
    iss: "foil",
    sub: dlId,
    issuer: "foil",
    agent: req.agent.sub,
    operator: req.operator.sub,
    origin: req.origin,
    subject: req.subject,
    scopes,
    constraints: terms.constraints,
    policy_version: policy.version,
    terms: terms.id,
    intent: req.intent,
    record,
    iat,
    exp: iat + policy.max_age_s,
    jti: dlId,
  };
  const certificate = await sign(claims as never, root.private, TYP.delegation);
  const stored: StoredDelegation = {
    id: dlId,
    object: "delegation",
    created: iat,
    livemode: store.livemode,
    metadata: req.metadata ?? {},
    status: "active",
    agent: claims.agent,
    operator: claims.operator,
    origin: claims.origin,
    subject: claims.subject,
    scopes: claims.scopes,
    constraints: claims.constraints,
    terms: claims.terms,
    issuer: claims.issuer,
    intent: claims.intent,
    policy_version: claims.policy_version,
    expires_at: claims.exp,
    revoked_at: null,
    revoked_by: null,
    record: record.id,
    certificate,
    claims,
  };
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

/** The delegation's status as of now, marking expiry lazily. */
export function effectiveStatus(d: StoredDelegation): StoredDelegation["status"] {
  if (d.status === "revoked") return "revoked";
  if (d.expires_at < nowS()) return "expired";
  return "active";
}

export async function revokeDelegation(store: Store, dlId: string, by: string, now?: Date): Promise<StoredDelegation> {
  const d = await store.getDelegation(dlId);
  if (!d) throw notFound("delegation", dlId);
  if (d.status === "revoked") throw new ApiError(400, "invalid_request_error", "delegation_already_revoked", `Delegation ${dlId} was already revoked.`);
  d.status = "revoked";
  d.revoked_at = nowSeconds(now);
  d.revoked_by = by;
  await store.putDelegation(d);
  return d;
}

export async function signRequest(payload: string, agentKey: KeyFile): Promise<string> {
  return sign({ body_sha256: sha(payload) }, agentKey.private, TYP.request);
}

export async function verifyRequestSignature(payload: string, signature: string, agentPublic: JWK): Promise<void> {
  let claims: { body_sha256: string };
  try {
    claims = (await verify<{ body_sha256: string }>(signature, agentPublic, TYP.request)).claims;
  } catch (e) {
    throw invalid("invalid_signature", `The request signature did not verify against the agent's key: ${e instanceof Error ? e.message : String(e)}`, "signature");
  }
  if (claims.body_sha256 !== sha(payload)) throw invalid("invalid_signature", "The request signature does not match the request body.", "signature");
}
