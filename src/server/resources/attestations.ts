import type { Attestation, IssuerObject } from "../../types.ts";
import { acceptAttestation, agentSigningKey, effectiveAttestationStatus, operatorSigningKey, refreshDelegationEvidence } from "../../lib/attestations.ts";
import { verifyAgent, verifyOperator } from "../../lib/certs.ts";
import { effectiveStatus } from "../../lib/delegation.ts";
import { forbidden, invalid, notFound } from "../../lib/errors.ts";
import { emitEvent } from "../../lib/events.ts";
import { loadPolicy } from "../../lib/policy.ts";
import { now } from "../../lib/store.ts";
import { ownsOrigin } from "../auth.ts";
import { paginate, present } from "../envelope.ts";
import { pageQuery, str } from "../params.ts";
import type { Ctx, Router } from "../router.ts";
import { loadDelegation } from "./delegations.ts";

function notFoundDelegation(id: string): never {
  throw notFound("delegation", id);
}

function canSee(ctx: Ctx, a: Attestation): boolean {
  const acct = ctx.principal!.account;
  if (ownsOrigin(ctx.principal!, a.origin)) return true;
  if (acct.type === "issuer") return a.submitted_by === "issuer";
  return acct.type === "operator";
}

async function load(ctx: Ctx, id: string): Promise<Attestation> {
  const a = await ctx.store.getAttestation(id);
  if (!a || !canSee(ctx, a)) throw notFound("attestation", id);
  const status = effectiveAttestationStatus(a);
  if (status !== a.status) {
    a.status = status;
    await ctx.store.putAttestation(a);
    await refreshDelegationEvidence(ctx.store, a.delegation);
  }
  return a;
}

/** Submit a credential against a delegation. Operators pass through what they hold; issuers post their own. */
export async function submitAttestation(ctx: Ctx, delegationId: string, credential: string): Promise<Attestation> {
  const acct = ctx.principal!.account;
  // An issuer is given the delegation id by the site, so holding it is what lets the issuer post against it.
  // It still cannot read the delegation; only the attestation it creates comes back.
  const d = acct.type === "issuer"
    ? (await ctx.store.getDelegation(delegationId)) ?? notFoundDelegation(delegationId)
    : await loadDelegation(ctx, delegationId);
  if (effectiveStatus(d) !== "active") throw invalid("delegation_inactive", `Delegation ${d.id} is ${effectiveStatus(d)}.`, "delegation");
  const policy = await loadPolicy(ctx.store, ctx.root, d.origin);
  if (!policy) throw invalid("origin_not_participating", `${d.origin} does not admit agents.`, "delegation");

  let submittedBy: Attestation["submitted_by"];
  if (acct.type === "operator") {
    if (d.operator !== acct.operator) throw notFound("delegation", delegationId);
    submittedBy = "operator";
  } else if (acct.type === "issuer") {
    submittedBy = "issuer";
  } else {
    if (!ownsOrigin(ctx.principal!, d.origin)) throw forbidden(`Your account does not own the origin ${d.origin}.`);
    submittedBy = "site";
  }

  // A policy that admits "operator" as an issuer accepts credentials signed by the delegation's own operator key.
  let operatorKey;
  let agentKey;
  if (policy.attestations?.issuers.includes("operator")) {
    const op = await ctx.store.getOperatorObject(d.operator);
    if (op) {
      const operatorClaims = await verifyOperator(op.certificate, ctx.root.public);
      operatorKey = operatorSigningKey(operatorClaims);
      const ag = await ctx.store.getAgentObject(d.agent);
      if (ag) agentKey = agentSigningKey(await verifyAgent(ag.certificate, operatorClaims));
    }
  }

  const a = await acceptAttestation(ctx.store, {
    delegation: d,
    policy,
    credential,
    submittedBy,
    issuerAccount: acct.type === "issuer" ? acct.issuer ?? null : null,
    operatorKey,
    agentKey,
  });
  await emitEvent(ctx.store, "attestation.created", a, { id: ctx.requestId, idempotency_key: ctx.idempotencyKey ?? undefined });
  return a;
}

export function attestationRoutes(r: Router): void {
  r.add("POST", "/v1/delegations/:id/attestations", async (ctx) =>
    submitAttestation(ctx, ctx.params.id!, str(ctx.body, "credential", true)!));

  r.add("GET", "/v1/attestations/:id", async (ctx) => load(ctx, ctx.params.id!));

  r.add("GET", "/v1/attestations", async (ctx) => {
    const q = ctx.query;
    const all = (await ctx.store.listAttestations()).filter((a) => canSee(ctx, a));
    const filtered = all.filter((a) =>
      (!q.get("delegation") || a.delegation === q.get("delegation")) &&
      (!q.get("origin") || a.origin === q.get("origin")!.toLowerCase()) &&
      (!q.get("issuer") || a.issuer === q.get("issuer")) &&
      (!q.get("status") || effectiveAttestationStatus(a) === q.get("status")),
    ).map((a) => ({ ...a, status: effectiveAttestationStatus(a) }));
    return paginate(filtered, "/v1/attestations", pageQuery(ctx.query));
  });

  r.add("POST", "/v1/attestations/:id/revoke", async (ctx) => {
    const a = await load(ctx, ctx.params.id!);
    const acct = ctx.principal!.account;
    const mine = ownsOrigin(ctx.principal!, a.origin) || (acct.type === "issuer" && !!acct.issuer);
    if (!mine) throw forbidden("Only the site or the issuing provider can revoke an attestation.");
    if (a.status === "revoked") return a;
    a.status = "revoked";
    a.revoked_at = now();
    a.revoked_by = acct.type;
    await ctx.store.putAttestation(a);
    await refreshDelegationEvidence(ctx.store, a.delegation);
    await emitEvent(ctx.store, "attestation.revoked", a, { id: ctx.requestId });
    return a;
  });

  r.add("GET", "/v1/issuers/:id", async (ctx) => {
    const i = await ctx.store.getIssuer(ctx.params.id!);
    if (!i) throw notFound("issuer", ctx.params.id!);
    return present(i as unknown as IssuerObject);
  });

  r.add("GET", "/v1/issuers", async (ctx) => {
    const all = (await ctx.store.listIssuers()).map((i) => ({ ...i, created: i.created, id: i.id }));
    return paginate(all, "/v1/issuers", pageQuery(ctx.query));
  });
}
