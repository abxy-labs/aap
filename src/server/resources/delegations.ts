import type { Acceptance, Attestation, StoredDelegation } from "../../types.ts";
import type { DelegationShape } from "../../lib/attestations.ts";
import { createDelegation, effectiveStatus } from "../../lib/delegation.ts";
import { invalid, notFound } from "../../lib/errors.ts";
import { emitEvent } from "../../lib/events.ts";
import {
  agentSigningKey,
  operatorSigningKey,
  prepareAttestation,
  recordAttestations,
} from "../../lib/attestations.ts";
import { loadPolicy } from "../../lib/policy.ts";
import { ownsOrigin, requireType } from "../auth.ts";
import { present } from "../envelope.ts";
import { list, metadata, obj, str } from "../params.ts";
import type { Ctx } from "../router.ts";
import { ownAgentClaims } from "./terms.ts";

function canSee(ctx: Ctx, d: StoredDelegation): boolean {
  const acct = ctx.principal!.account;
  return (
    (acct.type === "operator" && d.operator === acct.operator) ||
    ownsOrigin(ctx.principal!, d.origin)
  );
}

export async function loadDelegation(
  ctx: Ctx,
  id: string,
): Promise<StoredDelegation> {
  const d = await ctx.store.getDelegation(id);
  if (!d || !canSee(ctx, d)) throw notFound("delegation", id);
  const status = effectiveStatus(d);
  if (status !== d.status) {
    d.status = status;
    await ctx.store.putDelegation(d);
  }
  return d;
}

export async function createDelegationForRequest(ctx: Ctx) {
  requireType(ctx.principal!, "operator");
  const { store, root, body } = ctx;
  const agentId = str(body, "agent", true)!;
  const { agent, claims, operator } = await ownAgentClaims(ctx, agentId);
  const acceptance = obj<Acceptance>(body, "acceptance", true)!;
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

  // Credentials the operator already holds ride along with the delegation, so a site needs no
  // separate exchange. They are verified against a delegation that does not exist yet, so an
  // invalid one fails the request before anything is written.
  const credentials = req.attestations ?? [];
  let prepared: Attestation[] = [];
  if (credentials.length) {
    const policy = await loadPolicy(store, root, req.origin);
    if (!policy)
      throw invalid(
        "origin_not_participating",
        `${req.origin} does not admit agents.`,
        "origin",
      );
    const admitsOperator =
      policy.attestations?.issuers.includes("operator") ?? false;
    const pending: DelegationShape = {
      id: "",
      agent: agentId,
      operator: operator.sub,
      origin: req.origin,
      subject: req.subject,
    };
    prepared = await Promise.all(
      credentials.map((credential) =>
        prepareAttestation(store, {
          delegation: pending,
          policy,
          credential,
          submittedBy: "operator",
          operatorKey: admitsOperator
            ? operatorSigningKey(operator)
            : undefined,
          agentKey: admitsOperator ? agentSigningKey(claims) : undefined,
        }),
      ),
    );
  }

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
  if (prepared.length) {
    for (const a of prepared) a.delegation = d.id;
    await recordAttestations(store, d.id, prepared);
    for (const a of prepared)
      await emitEvent(store, "attestation.created", a, { id: ctx.requestId });
  }
  const created = (await store.getDelegation(d.id))!;

  return present(created);
}
