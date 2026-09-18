import type { CustomerAction, SessionRecord } from "../types.ts";
import { notFound } from "./errors.ts";
import { attestedScopes, satisfiesAttested } from "./attestations.ts";
import { createCustomerAction } from "./customer-action.ts";
import type { KeyFile } from "./keys.ts";
import {
  customerActionConfigFor,
  loadPolicy,
  permittedScopes,
} from "./policy.ts";
import { effectiveStatus } from "./delegation.ts";
import { Store } from "./store.ts";
import { downgradeSession } from "./verify.ts";

export interface UseResult {
  session: SessionRecord;
  customer_action?: CustomerAction;
  statusHeader?: string;
  customer_actionHeader?: string;
}

/** Record that a bound session exercised a scope. A customer_action scope creates a customer_action; a scope outside the grant downgrades the session. */
export async function useScope(
  store: Store,
  root: KeyFile,
  sessionId: string,
  scope: string,
): Promise<UseResult> {
  const s = await store.getSession(sessionId);
  if (!s) throw notFound("session", sessionId);
  if (s.plane !== "agent" || !s.agent || !("scopes" in s.agent)) {
    const reason =
      s.agent && "reason" in s.agent ? s.agent.reason : "not_bound";
    return {
      session: s,
      statusHeader: `Foil-Agent-Status: downgraded; reason=${reason}`,
    };
  }
  if (!s.agent.scopes.includes(scope)) {
    await downgradeSession(
      store,
      s,
      "scope_violation",
      `session exercised ${scope}, which is outside its grant`,
    );
    return {
      session: s,
      statusHeader: "Foil-Agent-Status: downgraded; reason=scope_violation",
    };
  }
  const policy = await loadPolicy(store, root, s.origin);
  const delegation = s.delegation_id
    ? await store.getDelegation(s.delegation_id)
    : null;
  if (!delegation || effectiveStatus(delegation) !== "active") {
    const reason =
      delegation && effectiveStatus(delegation) === "expired"
        ? "delegation_expired"
        : "delegation_revoked";
    await downgradeSession(
      store,
      s,
      reason,
      "Authorization is no longer active.",
    );
    return {
      session: s,
      statusHeader: `Foil-Agent-Status: downgraded; reason=${reason}`,
    };
  }
  if (!policy || !permittedScopes([scope], policy).length) {
    await downgradeSession(
      store,
      s,
      "policy_denied",
      "This scope is no longer admitted.",
    );
    return {
      session: s,
      statusHeader: "Foil-Agent-Status: downgraded; reason=policy_denied",
    };
  }
  if (policy && s.delegation_id && attestedScopes([scope], policy).length) {
    const evidence = await satisfiesAttested(store, s.delegation_id, policy);
    if (!evidence) {
      await downgradeSession(
        store,
        s,
        "evidence_insufficient",
        `${scope} requires an attestation this site accepts, and none on this delegation is current`,
      );
      return {
        session: s,
        statusHeader:
          "Foil-Agent-Status: downgraded; reason=evidence_insufficient",
      };
    }
    s.agent.authorization.attested = [
      evidence,
      ...s.agent.authorization.attested.filter(
        (e) => e.attestation !== evidence.attestation,
      ),
    ];
  }
  if (policy && customerActionConfigFor(policy, scope)) {
    const customer_action = await createCustomerAction(store, root, {
      sessionId,
      scope,
      by: "foil",
    });
    const fresh = (await store.getSession(sessionId))!;
    return {
      session: fresh,
      customer_action,
      customer_actionHeader: `Foil-Agent-CustomerAction: required; id=${customer_action.id}`,
    };
  }
  if (!s.agent.scopes_used.includes(scope)) s.agent.scopes_used.push(scope);
  await store.putSession(s);
  return { session: s, statusHeader: "Foil-Agent-Status: bound" };
}
