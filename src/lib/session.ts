import type { Handoff, SessionRecord } from "../types.ts";
import { notFound } from "./errors.ts";
import { createHandoff } from "./handoff.ts";
import type { KeyFile } from "./keys.ts";
import { handoffConfigFor, loadPolicy } from "./policy.ts";
import { Store } from "./store.ts";
import { downgradeSession } from "./verify.ts";

export interface UseResult {
  session: SessionRecord;
  handoff?: Handoff;
  statusHeader?: string;
  handoffHeader?: string;
}

/** Record that a bound session exercised a scope. A handoff scope creates a handoff; a scope outside the grant downgrades the session. */
export async function useScope(store: Store, root: KeyFile, sessionId: string, scope: string): Promise<UseResult> {
  const s = await store.getSession(sessionId);
  if (!s) throw notFound("session", sessionId);
  if (s.plane !== "agent" || !s.agent || !("scopes" in s.agent)) {
    const reason = s.agent && "reason" in s.agent ? s.agent.reason : "not_bound";
    return { session: s, statusHeader: `Foil-Agent-Status: downgraded; reason=${reason}` };
  }
  if (!s.agent.scopes.includes(scope)) {
    await downgradeSession(store, s, "scope_violation", `session exercised ${scope}, which is outside its grant`);
    return { session: s, statusHeader: "Foil-Agent-Status: downgraded; reason=scope_violation" };
  }
  const policy = await loadPolicy(store, root, s.origin);
  if (policy && handoffConfigFor(policy, scope)) {
    const handoff = await createHandoff(store, root, { sessionId, scope, by: "foil" });
    const fresh = (await store.getSession(sessionId))!;
    return { session: fresh, handoff, handoffHeader: `Foil-Agent-Handoff: required; id=${handoff.id}` };
  }
  if (!s.agent.scopes_used.includes(scope)) s.agent.scopes_used.push(scope);
  await store.putSession(s);
  return { session: s, statusHeader: "Foil-Agent-Status: bound" };
}
