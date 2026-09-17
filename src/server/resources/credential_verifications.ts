import { credentialPolicyHash, verifyCredentialPresentation } from "../../lib/credentials.ts";
import { effectiveStatus } from "../../lib/delegation.ts";
import { invalid, notFound } from "../../lib/errors.ts";
import { emitEvent, type EventType } from "../../lib/events.ts";
import { loadPolicy } from "../../lib/policy.ts";
import { id, now } from "../../lib/store.ts";
import type { CredentialVerification } from "../../types.ts";
import { requireOrigin, requireType } from "../auth.ts";
import { str } from "../params.ts";
import type { Ctx, Router } from "../router.ts";

async function load(ctx: Ctx): Promise<CredentialVerification> {
  requireType(ctx.principal!, "site");
  const v = await ctx.store.getCredentialVerification(ctx.params.id!);
  if (!v || !ctx.principal!.account.origins.includes(v.origin)) throw notFound("credential_verification", ctx.params.id!);
  return v;
}

async function notify(ctx: Ctx, v: CredentialVerification, type: EventType) {
  // Institution-only event: no nonce, subject mapping, raw token, or personal claims.
  await emitEvent(ctx.store, type, { id: v.id, object: v.object, origin: v.origin, delegation: v.delegation, status: v.status },
    { id: ctx.requestId, idempotency_key: ctx.idempotencyKey ?? undefined });
}

export function credentialVerificationRoutes(r: Router): void {
  r.add("POST", "/v1/credential_verifications", async ctx => {
    requireType(ctx.principal!, "site");
    const delegation = str(ctx.body, "delegation", true)!;
    const d = await ctx.store.getDelegation(delegation);
    if (!d || !ctx.principal!.account.origins.includes(d.origin)) throw notFound("delegation", delegation);
    const p = await loadPolicy(ctx.store, ctx.root, d.origin);
    if (effectiveStatus(d) !== "active") throw invalid("delegation_inactive", "Delegation is not active.");
    if (!p?.credentials?.trust?.length) throw invalid("credential_policy_missing", "Configure explicit issuer trust before requesting credentials.");
    const subject = str(ctx.body, "credential_subject", true)!;
    if (subject.length > 512 || !/^[a-z][a-z0-9+.-]*:\S+$/i.test(subject)) throw invalid("invalid_subject", "credential_subject must be the issuer's absolute subject identifier, mapped by the institution to this delegation.");
    const v: CredentialVerification = {
      id: id("cv"), object: "credential_verification", created: now(), livemode: ctx.store.livemode, metadata: {},
      delegation, origin: d.origin, credential_subject: subject, policy_version: p.version,
      policy_hash: credentialPolicyHash(p),
      audience: `https://${d.origin}`, nonce: crypto.randomUUID(), expires_at: now() + 300,
      status: "pending", evidence: null,
    };
    await ctx.store.putCredentialVerification(v);
    await notify(ctx, v, "credential_verification.created");
    return v;
  });
  r.add("GET", "/v1/credential_verifications/:id", load);
  r.add("POST", "/v1/credential_verifications/:id/complete", async ctx => {
    await load(ctx); // Authorize before acquiring any lock.
    return ctx.store.withCredentialLock(ctx.params.id!, async () => {
      const v = await load(ctx);
      requireOrigin(ctx.principal!, v.origin);
      const p = await loadPolicy(ctx.store, ctx.root, v.origin);
      const d = await ctx.store.getDelegation(v.delegation);
      if (!d || effectiveStatus(d) !== "active") throw invalid("delegation_inactive", "Delegation is not active.");
      if (v.status !== "pending" || v.expires_at <= now()) throw invalid("credential_request_consumed", "Request is consumed or expired. Create a fresh request.");
      if (!p?.credentials || p.version !== v.policy_version || credentialPolicyHash(p) !== v.policy_hash) throw invalid("credential_policy_changed", "Policy changed. Create a fresh request.");
      const evidence = await verifyCredentialPresentation(str(ctx.body, "presentation", true)!, v, p.credentials);
      v.status = "verified";
      v.evidence = evidence;
      await ctx.store.putCredentialVerification(v);
      await notify(ctx, v, "credential_verification.verified");
      return v;
    });
  });
  r.add("POST", "/v1/credential_verifications/:id/revoke", async ctx => {
    await load(ctx);
    return ctx.store.withCredentialLock(ctx.params.id!, async () => {
      const v = await load(ctx);
      if (v.status === "revoked") return v;
      v.status = "revoked";
      await ctx.store.putCredentialVerification(v);
      await notify(ctx, v, "credential_verification.revoked");
      return v;
    });
  });
}
