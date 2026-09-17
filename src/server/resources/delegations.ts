import type { Acceptance, StoredDelegation } from "../../types.ts";
import { verifyOperator } from "../../lib/certs.ts";
import { createDelegation, delegationSigningPayload, effectiveStatus, revokeDelegation, verifyRequestSignature } from "../../lib/delegation.ts";
import { forbidden, notFound } from "../../lib/errors.ts";
import { emitEvent } from "../../lib/events.ts";
import { acceptAttestation, agentSigningKey, operatorSigningKey } from "../../lib/attestations.ts";
import { loadPolicy } from "../../lib/policy.ts";
import { ownsOrigin, requireType } from "../auth.ts";
import { paginate, present } from "../envelope.ts";
import { list, metadata, obj, pageQuery, str } from "../params.ts";
import type { Ctx, Router } from "../router.ts";
import { ownAgentClaims } from "./terms.ts";

function canSee(ctx: Ctx, d: StoredDelegation): boolean {
  const acct = ctx.principal!.account;
  return (acct.type === "operator" && d.operator === acct.operator) || ownsOrigin(ctx.principal!, d.origin);
}

export async function loadDelegation(ctx: Ctx, id: string): Promise<StoredDelegation> {
  const d = await ctx.store.getDelegation(id);
  if (!d || !canSee(ctx, d)) throw notFound("delegation", id);
  const status = effectiveStatus(d);
  if (status !== d.status) {
    d.status = status;
    await ctx.store.putDelegation(d);
    if (status === "expired") await emitEvent(ctx.store, "delegation.expired", present(d), { id: ctx.requestId });
  }
  return d;
}

export function delegationRoutes(r: Router): void {
  r.add("POST", "/v1/delegations", async (ctx) => {
    requireType(ctx.principal!, "operator");
    const { store, root, body } = ctx;
    const agentId = str(body, "agent", true)!;
    const { agent, claims, operator } = await ownAgentClaims(ctx, agentId);
    const acceptance = obj<Acceptance>(body, "acceptance", true)!;
    const signature = str(body, "signature", true)!;
    const req = {
      agent: agentId,
      origin: str(body, "origin", true)!.toLowerCase(),
      subject: str(body, "subject", true)!,
      scopes: list(body, "scopes"),
      terms: str(body, "terms", true)!,
      intent: str(body, "intent") ?? "",
      acceptance,
      site_session: str(body, "site_session") ?? null,
      attestations: list(body, "attestations") ?? null,
    };
    await verifyRequestSignature(delegationSigningPayload(req), signature, agent.public_key as never);
    const d = await createDelegation(store, root, {
      agent: claims,
      operator,
      origin: req.origin,
      subject: req.subject,
      scopes: req.scopes,
      terms: req.terms,
      intent: req.intent,
      acceptance,
      siteSession: req.site_session ?? undefined,
      metadata: metadata(body),
    });
    // Credentials the operator already holds ride along with the delegation, so a site needs no separate exchange.
    for (const credential of req.attestations ?? []) {
      const policy = (await loadPolicy(store, root, req.origin))!;
      const admitsOperator = policy.attestations?.issuers.includes("operator") ?? false;
      const operatorKey = admitsOperator ? operatorSigningKey(operator) : undefined;
      const agentKey = admitsOperator ? agentSigningKey(claims) : undefined;
      const a = await acceptAttestation(store, { delegation: d, policy, credential, submittedBy: "operator", operatorKey, agentKey });
      await emitEvent(store, "attestation.created", a, { id: ctx.requestId });
    }
    const created = (await store.getDelegation(d.id))!;
    await emitEvent(store, "delegation.created", present(created), { id: ctx.requestId, idempotency_key: ctx.idempotencyKey ?? undefined });
    return present(created);
  });

  r.add("GET", "/v1/delegations/:id", async (ctx) => present(await loadDelegation(ctx, ctx.params.id!)));

  r.add("GET", "/v1/delegations", async (ctx) => {
    const q = ctx.query;
    const all = (await ctx.store.listDelegations()).filter((d) => canSee(ctx, d));
    const filtered = all.filter((d) =>
      (!q.get("agent") || d.agent === q.get("agent")) &&
      (!q.get("origin") || d.origin === q.get("origin")!.toLowerCase()) &&
      (!q.get("subject") || d.subject === q.get("subject")) &&
      (!q.get("status") || effectiveStatus(d) === q.get("status")),
    ).map((d) => present({ ...d, status: effectiveStatus(d) }));
    return paginate(filtered, "/v1/delegations", pageQuery(ctx.query));
  });

  r.add("POST", "/v1/delegations/:id/revoke", async (ctx) => {
    const d = await loadDelegation(ctx, ctx.params.id!);
    if (d.status === "expired") throw forbidden(`Delegation ${d.id} has already expired.`);
    const by = ctx.principal!.account.type === "site" ? "site" : (str(ctx.body, "by") === "consumer" ? "consumer" : "operator");
    const revoked = await revokeDelegation(ctx.store, d.id, by);
    await emitEvent(ctx.store, "delegation.revoked", present(revoked), { id: ctx.requestId });
    return present(revoked);
  });
}
