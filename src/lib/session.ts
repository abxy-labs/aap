import type { SessionRecord } from "../types.ts";
import type { KeyFile } from "./keys.ts";
import { loadPolicy } from "./policy.ts";
import { Store } from "./store.ts";
import { handoffFor } from "./verify.ts";

export interface UseResult {
  session: SessionRecord;
  statusHeader?: string;
  handoffHeader?: string;
}

/** Record that a bound session exercised a scope. Outside the grant, the session is downgraded. */
export async function useScope(store: Store, root: KeyFile, sessionId: string, scope: string): Promise<UseResult> {
  const s = await store.getSession(sessionId);
  if (!s) throw new Error(`session ${sessionId} not found`);
  if (s.decision.plane !== "agent" || !s.agent || !("scopes" in s.agent)) {
    return { session: s, statusHeader: `Foil-Agent-Status: downgraded; reason=${"reason" in (s.agent ?? {}) ? (s.agent as { reason: string }).reason : "not_bound"}` };
  }
  if (!s.agent.scopes.includes(scope)) {
    s.decision = { verdict: "block", plane: "bot" };
    s.agent = { grant: s.agent.grant, reason: "scope_violation" };
    await store.putSession(s);
    return { session: s, statusHeader: "Foil-Agent-Status: downgraded; reason=scope_violation" };
  }
  if (!s.agent.scopes_used.includes(scope)) s.agent.scopes_used.push(scope);
  const policy = await loadPolicy(store, root, s.origin);
  const handoff = policy ? handoffFor(policy, [scope]) : [];
  if (handoff.length) {
    s.agent.handoff = scope;
    await store.putSession(s);
    return { session: s, handoffHeader: `Foil-Agent-Handoff: required; scope=${scope}` };
  }
  await store.putSession(s);
  return { session: s, statusHeader: "Foil-Agent-Status: bound" };
}

/** POST /v1/sessions/{id}/handoff: the site reports that the consumer completed the step. */
export async function completeHandoff(store: Store, sessionId: string, scope: string): Promise<SessionRecord> {
  const s = await store.getSession(sessionId);
  if (!s) throw new Error(`session ${sessionId} not found`);
  if (!s.agent || !("scopes" in s.agent)) throw new Error(`session ${sessionId} is not on the agent plane`);
  if (s.agent.handoff !== scope) throw new Error(`session ${sessionId} is not waiting on a handoff for ${scope}`);
  s.agent.handoff = null;
  const d = s.delegation_id ? await store.getDelegation(s.delegation_id) : null;
  if (d) {
    const observed = d.claims.record.observed ?? { site_session: "", human: true, known_device: false, age_s: 0 };
    observed.handoffs = [...(observed.handoffs ?? []), scope];
    d.claims.record.observed = observed;
    await store.putDelegation(d);
    await store.putRecord(d.claims.record);
    s.agent.delegation.observed = observed;
  }
  await store.putSession(s);
  return s;
}

/** GET /v1/sessions/{id}: what the site reads. */
export function verifyResponse(s: SessionRecord): unknown {
  return { decision: s.decision, agent: s.agent };
}
