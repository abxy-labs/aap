import type { AgentBlock, DowngradeReason, Handoff, SessionRecord } from "../../types.ts";
import { issueChallenge } from "../../lib/challenge.ts";
import { invalid, notFound } from "../../lib/errors.ts";
import { EVENT_TYPES, emitEvent, type EventType } from "../../lib/events.ts";
import { buildDisplay, completeHandoff, linkHandoff } from "../../lib/handoff.ts";
import { decode } from "../../lib/jwt.ts";
import { useScope } from "../../lib/session.ts";
import { id, iso, now } from "../../lib/store.ts";
import { baseSession, verifyPresentation } from "../../lib/verify.ts";
import { ownsOrigin, requireTestMode } from "../auth.ts";
import { present } from "../envelope.ts";
import { bool, list, num, obj, str } from "../params.ts";
import type { Ctx, Router } from "../router.ts";
import { loadHandoff } from "./handoffs.ts";
import { loadSession } from "./sessions.ts";

/** Fixed-outcome agents, the equivalent of test card numbers. Any presentation naming one produces that outcome. */
export const TEST_AGENTS: Record<string, { outcome: "bound" | "requires_handoff" | DowngradeReason; description: string }> = {
  ag_test_bound: { outcome: "bound", description: "Binds on the agent plane with the requested scopes." },
  ag_test_requires_handoff: { outcome: "requires_handoff", description: "Binds, then immediately requires a handoff on payments:initiate in approve mode." },
  ag_test_chain_invalid: { outcome: "chain_invalid", description: "Downgraded: a signature in the chain does not verify." },
  ag_test_challenge_invalid: { outcome: "challenge_invalid", description: "Downgraded: the grant was not signed over a challenge for this origin." },
  ag_test_revoked: { outcome: "delegation_revoked", description: "Downgraded: the delegation was revoked." },
  ag_test_expired: { outcome: "delegation_expired", description: "Downgraded: the delegation passed its maximum age." },
  ag_test_policy_denied: { outcome: "policy_denied", description: "Downgraded: the site's policy does not admit this agent." },
  ag_test_replayed: { outcome: "grant_replayed", description: "Downgraded: the grant was presented by another session." },
  ag_test_operator_mismatch: { outcome: "operator_mismatch", description: "Downgraded: the session does not look like the operator's infrastructure." },
  ag_test_evidence_insufficient: { outcome: "evidence_insufficient", description: "Downgraded: the tier requires observed evidence the delegation lacks." },
  ag_test_scope_violation: { outcome: "scope_violation", description: "Downgraded: the session exercised a scope outside its grant." },
};

function fixtureBlock(agentId: string, scopes: string[]): AgentBlock {
  const t = now();
  return {
    id: agentId, name: "test-agent", operator: "op_test", grant: id("gr"), intent: "Test presentation",
    scopes, scopes_used: [], constraints: { currency: "usd", max_amount: 20000, payees: "existing_only" },
    delegation: {
      id: "dl_test", issuer: "foil", policy_version: 0, created_at: iso(t - 600), expires_at: iso(t + 30 * 86400), record: "dr_test",
      asserted: { terms: "trm_test", acknowledged: ["esign", "share"], channel: "test" }, observed: null, attested: [], presented: null,
    },
    handoff: null, approvals: [],
  };
}

async function fixturePresentation(ctx: Ctx, agentId: string, origin: string, sessionId: string, scopes: string[]): Promise<{ session: SessionRecord; handoff?: Handoff }> {
  const def = TEST_AGENTS[agentId]!;
  const nowD = new Date();
  const session = baseSession(ctx.store, sessionId, origin, nowD);
  session.operator_id = ctx.principal!.account.operator ?? "op_test";
  if (def.outcome === "bound" || def.outcome === "requires_handoff") {
    const block = fixtureBlock(agentId, scopes);
    Object.assign(session, { plane: "agent", status: "active", decision: { verdict: "allow", plane: "agent" }, agent: block, grant_jti: block.grant, delegation_id: "dl_test", bound_at: nowD.toISOString() });
    await ctx.store.putSession(session);
    if (def.outcome === "requires_handoff") {
      const hoId = id("ho");
      const context = { amount: 14210, currency: "usd", payee: "Pacific Power", memo: "September electric" };
      const h: Handoff = {
        id: hoId, object: "handoff", created: now(), livemode: false, metadata: {}, status: "pending", mode: "approve",
        session: session.id, delegation: "dl_test", agent: agentId, operator: session.operator_id!, origin, scope: "payments:initiate", context,
        display: buildDisplay({ scope: "payments:initiate", context, agentName: "test-agent", origin, mode: "approve" }),
        url: null, code: "TST-000", expires_at: now() + 900, completed_at: null, completed_by: null, result: null, linked_session: null, canceled_by: null,
      };
      if (!block.scopes.includes("payments:initiate")) block.scopes.push("payments:initiate");
      block.handoff = hoId;
      session.status = "requires_handoff";
      session.next_action = { type: "handoff", handoff: hoId };
      await ctx.store.putHandoff(h);
      await ctx.store.putSession(session);
      await emitEvent(ctx.store, "session.bound", present(session), { id: ctx.requestId });
      await emitEvent(ctx.store, "handoff.created", h, { id: ctx.requestId });
      return { session, handoff: h };
    }
    await emitEvent(ctx.store, "session.bound", present(session), { id: ctx.requestId });
    return { session };
  }
  session.agent = { grant: id("gr"), reason: def.outcome, message: def.description };
  await ctx.store.putSession(session);
  await emitEvent(ctx.store, "session.downgraded", present(session), { id: ctx.requestId });
  return { session };
}

async function consumerSession(ctx: Ctx, input: { origin: string; human?: boolean; known_device?: boolean; age?: number; device?: string; id?: string }): Promise<SessionRecord> {
  const createdAt = new Date(Date.now() - (input.age ?? 0) * 1000).toISOString();
  return ctx.store.putSiteSession({ id: input.id ?? id("sess"), origin: input.origin, human: input.human ?? true, known_device: input.known_device ?? false, created_at: createdAt, device: input.device ?? "mobile" });
}

function fixtureFor(type: EventType, origin: string): unknown {
  const t = now();
  const session = { ...present({ ...baseSession({ livemode: false } as never, id("sess"), origin, new Date()), plane: "agent", status: "active", decision: { verdict: "allow", plane: "agent" }, agent: fixtureBlock("ag_test_bound", ["accounts:read"]) }) };
  const context = { amount: 14210, currency: "usd", payee: "Pacific Power" };
  const handoff: Handoff = {
    id: id("ho"), object: "handoff", created: t, livemode: false, metadata: {}, status: "pending", mode: "approve", session: session.id, delegation: "dl_test", agent: "ag_test_bound", operator: "op_test",
    origin, scope: "payments:initiate", context, display: buildDisplay({ scope: "payments:initiate", context, agentName: "test-agent", origin, mode: "approve" }),
    url: null, code: "TST-000", expires_at: t + 900, completed_at: null, completed_by: null, result: null, linked_session: null, canceled_by: null,
  };
  const delegation = { id: id("dl"), object: "delegation", created: t, livemode: false, metadata: {}, status: "active", agent: "ag_test_bound", operator: "op_test", origin, subject: "usr_test", scopes: ["accounts:read"], constraints: {}, terms: "trm_test", issuer: "foil", intent: "test", policy_version: 1, expires_at: t + 30 * 86400, revoked_at: null, revoked_by: null, record: "dr_test", certificate: "" };
  switch (type) {
    case "delegation.revoked": return { ...delegation, status: "revoked", revoked_at: t, revoked_by: "site" };
    case "delegation.expired": return { ...delegation, status: "expired", expires_at: t - 1 };
    case "delegation.created": return delegation;
    case "session.bound": return session;
    case "session.scope_used": return { ...session, agent: { ...(session.agent as AgentBlock), scopes_used: ["accounts:read"] } };
    case "session.downgraded": return { ...session, plane: "bot", status: "downgraded", decision: { verdict: "block", plane: "bot" }, agent: { grant: id("gr"), reason: "grant_replayed" } };
    case "handoff.created": return handoff;
    case "handoff.completed": return { ...handoff, status: "completed", completed_at: t, completed_by: { session: id("sess"), human: true, known_device: true, device: "mobile", cloud_environment: false } };
    case "handoff.canceled": return { ...handoff, status: "canceled", canceled_by: "operator" };
    case "handoff.expired": return { ...handoff, status: "expired", expires_at: t - 1 };
    default: return { id: id("obj"), object: type.split(".")[0], created: t, livemode: false };
  }
}

export function testHelperRoutes(r: Router): void {
  r.add("GET", "/v1/test_helpers/agents", async (ctx) => {
    requireTestMode(ctx.principal!);
    return { object: "list", url: "/v1/test_helpers/agents", has_more: false, data: Object.entries(TEST_AGENTS).map(([id, v]) => ({ object: "test_agent", id, ...v })) };
  });

  r.add("POST", "/v1/test_helpers/sessions", async (ctx) => {
    requireTestMode(ctx.principal!);
    const origin = str(ctx.body, "origin", true)!.toLowerCase();
    const s = await consumerSession(ctx, { origin, human: bool(ctx.body, "human") ?? true, known_device: bool(ctx.body, "known_device") ?? false, age: num(ctx.body, "age"), device: str(ctx.body, "device") });
    return present(s);
  });

  r.add("POST", "/v1/test_helpers/challenges", async (ctx) => {
    requireTestMode(ctx.principal!);
    const origin = str(ctx.body, "origin", true)!.toLowerCase();
    const jwt = await issueChallenge(ctx.store, ctx.root, origin);
    if (!jwt) throw invalid("origin_not_participating", `${origin} does not admit agents, so no challenge is issued for it.`, "origin");
    const claims = decode<{ nonce: string; exp: number }>(jwt).claims;
    return { object: "challenge", origin, nonce: claims.nonce, expires_at: claims.exp, jwt, header: `Foil-Agent-Challenge: ${jwt}` };
  });

  r.add("POST", "/v1/test_helpers/presentations", async (ctx) => {
    requireTestMode(ctx.principal!);
    const origin = str(ctx.body, "origin", true)!.toLowerCase();
    const sessionId = str(ctx.body, "session") ?? id("sess");
    const agent = str(ctx.body, "agent");
    if (agent) {
      if (!TEST_AGENTS[agent]) throw invalid("parameter_invalid", `Unknown test agent '${agent}'. List them with GET /v1/test_helpers/agents.`, "agent");
      const { session, handoff } = await fixturePresentation(ctx, agent, origin, sessionId, list(ctx.body, "scopes") ?? ["accounts:read"]);
      return { ...present(session), ...(handoff ? { handoff } : {}) };
    }
    const header = (str(ctx.body, "header", true)!).replace(/^Foil-Agent-Grant:\s*/i, "");
    const result = await verifyPresentation(ctx.store, ctx.root, { header, origin, sessionId, asn: str(ctx.body, "asn"), ja4: str(ctx.body, "ja4") });
    if (result.session.plane === "agent" && ctx.principal!.account.operator && result.session.operator_id !== ctx.principal!.account.operator && !ownsOrigin(ctx.principal!, origin)) {
      // an operator may only present its own chain
      throw invalid("presentation_not_yours", "The chain in this presentation belongs to another operator.", "header");
    }
    await emitEvent(ctx.store, result.session.plane === "agent" ? "session.bound" : "session.downgraded", present(result.session), { id: ctx.requestId });
    return { ...present(result.session), status_header: result.statusHeader, ...(result.narrowed ? { narrowed: result.narrowed } : {}), ...(result.handoffs ? { handoff_scopes: result.handoffs.map((h) => h.scope) } : {}) };
  });

  r.add("POST", "/v1/test_helpers/sessions/:id/use", async (ctx) => {
    requireTestMode(ctx.principal!);
    await loadSession(ctx, ctx.params.id!);
    const scope = str(ctx.body, "scope", true)!;
    const r2 = await useScope(ctx.store, ctx.root, ctx.params.id!, scope);
    if (r2.handoff) await emitEvent(ctx.store, "handoff.created", r2.handoff, { id: ctx.requestId });
    else if (r2.session.plane === "agent") await emitEvent(ctx.store, "session.scope_used", present(r2.session), { id: ctx.requestId });
    else await emitEvent(ctx.store, "session.downgraded", present(r2.session), { id: ctx.requestId });
    return { ...present(r2.session), ...(r2.handoff ? { handoff: r2.handoff } : {}), status_header: r2.statusHeader ?? r2.handoffHeader };
  });

  r.add("POST", "/v1/test_helpers/handoffs/:id/link", async (ctx) => {
    requireTestMode(ctx.principal!);
    const h = await loadHandoff(ctx, ctx.params.id!);
    const sessionId = str(ctx.body, "session") ?? (await consumerSession(ctx, { origin: h.origin, known_device: bool(ctx.body, "known_device") ?? true })).id;
    return linkHandoff(ctx.store, h.id, sessionId);
  });

  r.add("POST", "/v1/test_helpers/handoffs/:id/complete", async (ctx) => {
    requireTestMode(ctx.principal!);
    const h = await loadHandoff(ctx, ctx.params.id!);
    const sessionId = str(ctx.body, "session") ?? (h.linked_session ?? (await consumerSession(ctx, { origin: h.origin, known_device: bool(ctx.body, "known_device") ?? true })).id);
    const cs = await ctx.store.getSession(sessionId);
    if (!cs) throw notFound("session", sessionId);
    const outcome = str(ctx.body, "outcome");
    const result = obj(ctx.body, "result") ?? (outcome ? { outcome } : null);
    const done = await completeHandoff(ctx.store, h.id, { sessionId, result });
    await emitEvent(ctx.store, "handoff.completed", done, { id: ctx.requestId });
    return done;
  });

  r.add("POST", "/v1/test_helpers/events", async (ctx) => {
    requireTestMode(ctx.principal!);
    const type = str(ctx.body, "type", true)! as EventType;
    if (!(EVENT_TYPES as readonly string[]).includes(type)) throw invalid("parameter_invalid", `Unknown event type '${type}'.`, "type");
    const origin = str(ctx.body, "origin") ?? ctx.principal!.account.origins[0] ?? "bank.test";
    const object = obj(ctx.body, "data") ?? fixtureFor(type, origin);
    return emitEvent(ctx.store, type, object, { id: ctx.requestId });
  });
}
