import type {
  Authorization,
  AuthorizationAcceptParams,
  StoredAuthorization,
} from "../../lib/authorization.ts";
import { authorizationSigningPayload } from "../../lib/authorization.ts";
import { createTerms } from "../../lib/terms.ts";
import { admitsAgents, loadPolicy } from "../../lib/policy.ts";
import {
  effectiveStatus,
  revokeDelegation,
  verifyRequestSignature,
} from "../../lib/delegation.ts";
import { invalid, notFound, forbidden } from "../../lib/errors.ts";
import { id, now, sha } from "../../lib/store.ts";
import { emitEvent } from "../../lib/events.ts";
import { ownsOrigin, requireType } from "../auth.ts";
import { list, metadata, obj, pageQuery, str } from "../params.ts";
import { paginate } from "../envelope.ts";
import type { Ctx, Router } from "../router.ts";
import { ownAgentClaims } from "./terms.ts";
import { createDelegationForRequest } from "./delegations.ts";

// Serializes accept/revoke in the single-process reference server. A production
// store must use a transaction/unique authorization->delegation constraint.
const locks = new Map<string, Promise<void>>();
async function exclusive<T>(
  ctx: Ctx,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const k = `${ctx.store.dir}:${key}`,
    before = locks.get(k) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = before.then(() => next);
  locks.set(k, tail);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(k) === tail) locks.delete(k);
  }
}
function visible(ctx: Ctx, a: Authorization) {
  return (
    (ctx.principal!.account.type === "operator" &&
      a.operator === ctx.principal!.account.operator) ||
    ownsOrigin(ctx.principal!, a.origin)
  );
}
export async function loadAuthorization(ctx: Ctx, key: string) {
  const a = await ctx.store.get<StoredAuthorization>("authorizations", key);
  if (!a || !visible(ctx, a)) throw notFound("authorization", key);
  // Recover a completed issuance if the process stopped before saving its link.
  const d = a.delegation
    ? await ctx.store.getDelegation(a.delegation)
    : (await ctx.store.listDelegations()).find(
        (d) =>
          d.metadata.authorization === a.id &&
          d.operator === a.operator &&
          d.terms === a.terms,
      );
  if (d) {
    a.delegation = d.id;
    a.status = effectiveStatus(d);
    a.expires_at = d.expires_at;
    a.acceptance_hash = d.metadata.authorization_acceptance;
  } else if (a.status === "pending_consent" && a.expires_at < now())
    a.status = "expired";
  return a;
}
const load = loadAuthorization;
function output(a: StoredAuthorization): Authorization {
  const { terms, delegation, acceptance_hash, ...publicFields } = a;
  return publicFields;
}
export function authorizationRoutes(r: Router) {
  r.add("POST", "/v1/authorizations", async (ctx) => {
    requireType(ctx.principal!, "operator");
    const agent = str(ctx.body, "agent", true)!,
      origin = str(ctx.body, "origin", true)!.toLowerCase();
    const { claims, operator } = await ownAgentClaims(ctx, agent);
    const policy = await loadPolicy(ctx.store, ctx.root, origin);
    if (!admitsAgents(policy))
      throw invalid(
        "origin_not_participating",
        "The institution does not admit agents.",
        "origin",
      );
    const subject = str(ctx.body, "subject", true)!,
      intent = str(ctx.body, "intent", true)!;
    const terms = await createTerms(
      ctx.store,
      claims,
      policy,
      list(ctx.body, "scopes", true)!,
      metadata(ctx.body),
    );
    const a: StoredAuthorization = {
      id: id("auth"),
      object: "authorization",
      created: now(),
      livemode: ctx.store.livemode,
      metadata: metadata(ctx.body),
      status: "pending_consent",
      agent,
      operator: operator.sub,
      origin,
      subject,
      intent,
      terms: terms.id,
      delegation: null,
      expires_at: terms.expires_at,
      consent: {
        revision: sha(JSON.stringify(terms)),
        scopes: terms.scopes,
        constraints: terms.constraints,
        disclosures: terms.disclosures,
        max_age_s: terms.max_age_s,
      },
    };
    await ctx.store.put("authorizations", a.id, a);
    await emitEvent(ctx.store, "authorization.created", output(a), {
      id: ctx.requestId,
    });
    return output(a);
  });
  r.add("GET", "/v1/authorizations/:id", async (ctx) =>
    output(await load(ctx, ctx.params.id!)),
  );
  // Operator-only material for browser connection; never shown in customer UI.
  r.add("GET", "/v1/authorizations/:id/connection", async (ctx) => {
    requireType(ctx.principal!, "operator");
    const a = await load(ctx, ctx.params.id!);
    if (a.status !== "active" || !a.delegation)
      throw invalid("authorization_inactive", `Authorization is ${a.status}.`);
    const d = (await ctx.store.getDelegation(a.delegation))!;
    const agent = await ctx.store.getAgentObject(a.agent);
    const operator = await ctx.store.getOperatorObject(a.operator);
    if (!agent || agent.status !== "active" || !operator)
      throw invalid("agent_deactivated", "The agent is unavailable.");
    return {
      authorization: a.id,
      delegation: d.certificate,
      agent: agent.certificate,
      operator: operator.certificate,
    };
  });
  r.add("GET", "/v1/authorizations", async (ctx) => {
    const rows = (
      await ctx.store.list<StoredAuthorization>("authorizations")
    ).filter(
      (a) =>
        visible(ctx, a) &&
        ["agent", "origin", "subject"].every(
          (k) =>
            !ctx.query.get(k) ||
            a[k as "agent" | "origin" | "subject"] === ctx.query.get(k),
        ),
    );
    const refreshed = await Promise.all(rows.map((a) => load(ctx, a.id)));
    return paginate(
      refreshed
        .filter(
          (a) =>
            !ctx.query.get("status") || a.status === ctx.query.get("status"),
        )
        .map(output),
      "/v1/authorizations",
      pageQuery(ctx.query),
    );
  });
  r.add("POST", "/v1/authorizations/:id/accept", (ctx) =>
    exclusive(ctx, ctx.params.id!, async () => {
      requireType(ctx.principal!, "operator");
      const a = await load(ctx, ctx.params.id!);
      if (a.operator !== ctx.principal!.account.operator)
        throw notFound("authorization", a.id);
      const acceptance = obj<Record<string, unknown>>(
        ctx.body,
        "acceptance",
        true,
      )!;
      const p: AuthorizationAcceptParams = {
        revision: str(ctx.body, "revision", true)!,
        acceptance: {
          acknowledged: list(acceptance, "acknowledged", true)!,
          viewed: list(acceptance, "viewed", true)!,
          channel: str(acceptance, "channel", true)!,
          accepted_at: str(acceptance, "accepted_at", true)!,
          ...(acceptance.copies_sent_to
            ? { copies_sent_to: str(acceptance, "copies_sent_to", true)! }
            : {}),
        },
        site_session: str(ctx.body, "site_session"),
        attestations: list(ctx.body, "attestations"),
      };
      if (!Number.isFinite(Date.parse(p.acceptance.accepted_at)))
        throw invalid(
          "invalid_acceptance",
          "accepted_at must be a valid timestamp.",
          "acceptance.accepted_at",
        );
      if (p.revision !== a.consent.revision)
        throw invalid(
          "consent_revision_mismatch",
          "Acceptance must reference the exact displayed consent revision.",
          "revision",
        );
      const { agent } = await ownAgentClaims(ctx, a.agent);
      const payload = authorizationSigningPayload(a.id, p),
        hash = sha(payload);
      await verifyRequestSignature(
        payload,
        str(ctx.body, "signature", true)!,
        agent.public_key as never,
      );
      if (a.status === "active") {
        if (a.acceptance_hash !== hash)
          throw invalid(
            "authorization_already_accepted",
            "An accepted authorization is immutable. Request a new authorization.",
          );
        return output(a);
      }
      if (a.status !== "pending_consent")
        throw invalid(
          "authorization_not_pending",
          `Authorization is ${a.status}. Request fresh consent.`,
        );
      const d = await createDelegationForRequest({
        ...ctx,
        body: {
          agent: a.agent,
          origin: a.origin,
          subject: a.subject,
          intent: a.intent,
          terms: a.terms,
          acceptance: { ...p.acceptance, terms: a.terms },
          site_session: p.site_session,
          attestations: p.attestations,
          metadata: { authorization: a.id, authorization_acceptance: hash },
        },
      });
      a.delegation = d.id;
      a.status = "active";
      a.expires_at = d.expires_at;
      a.acceptance_hash = hash;
      await ctx.store.put("authorizations", a.id, a);
      await emitEvent(ctx.store, "authorization.accepted", output(a), {
        id: ctx.requestId,
      });
      return output(a);
    }),
  );
  r.add("POST", "/v1/authorizations/:id/revoke", (ctx) =>
    exclusive(ctx, ctx.params.id!, async () => {
      const a = await load(ctx, ctx.params.id!);
      if (a.status === "revoked") return output(a);
      if (a.status === "expired") throw forbidden("Authorization has expired.");
      const by =
        ctx.principal!.account.type === "site"
          ? "site"
          : str(ctx.body, "by") === "consumer"
            ? "consumer"
            : "operator";
      if (a.delegation) await revokeDelegation(ctx.store, a.delegation, by);
      a.status = "revoked";
      a.revoked_by = by;
      a.revoked_at = now();
      await ctx.store.put("authorizations", a.id, a);
      await emitEvent(ctx.store, "authorization.revoked", output(a), {
        id: ctx.requestId,
      });
      return output(a);
    }),
  );
}
