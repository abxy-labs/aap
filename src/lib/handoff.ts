import type { AgentBlock, Handoff, HandoffMode, SessionRecord } from "../types.ts";
import { formatAmount } from "./constraints.ts";
import { ApiError, invalid, notFound } from "./errors.ts";
import type { KeyFile } from "./keys.ts";
import { handoffConfigFor, loadPolicy } from "./policy.ts";
import { VOCABULARY } from "./scopes.ts";
import { Store, id, now } from "./store.ts";
import { downgradeSession } from "./verify.ts";

export interface CreateHandoffInput {
  sessionId: string;
  scope: string;
  context?: Record<string, unknown>;
  metadata?: Record<string, string>;
  /** Who asked: the agent, with context, or Foil, because the session reached the scope without asking. */
  by?: "agent" | "foil";
}

function agentBlock(s: SessionRecord): AgentBlock | null {
  return s.plane === "agent" && s.agent && "scopes" in s.agent ? s.agent : null;
}

/** Mark a pending handoff expired once its window has passed. */
export function refreshStatus(h: Handoff): Handoff {
  if (h.status === "pending" && h.expires_at < now()) h.status = "expired";
  return h;
}

export async function getHandoff(store: Store, hoId: string): Promise<Handoff> {
  const h = await store.getHandoff(hoId);
  if (!h) throw notFound("handoff", hoId);
  const before = h.status;
  refreshStatus(h);
  if (h.status !== before) {
    await store.putHandoff(h);
    await restoreSession(store, h);
  }
  return h;
}

/** Create a handoff for a session, or return the pending one for the same scope. */
export async function createHandoff(store: Store, root: KeyFile, input: CreateHandoffInput): Promise<Handoff> {
  const s = await store.getSession(input.sessionId);
  if (!s) throw notFound("session", input.sessionId);
  const block = agentBlock(s);
  if (!block) throw invalid("session_not_agent", "Handoffs can only be created for sessions on the agent plane.", "session");
  if (!block.scopes.includes(input.scope)) throw invalid("scope_not_granted", `Scope ${input.scope} is not in this session's grant.`, "scope");
  if (!VOCABULARY[input.scope]) throw invalid("unknown_scope", `Unknown scope '${input.scope}'.`, "scope");

  for (const h of await store.listHandoffs()) {
    if (h.session === s.id && h.scope === input.scope && refreshStatus(h).status === "pending") return h;
  }

  const policy = await loadPolicy(store, root, s.origin);
  if (!policy) throw invalid("origin_not_participating", `${s.origin} does not admit agents.`, "session");
  const cfg = { ...(handoffConfigFor(policy, input.scope) ?? { scope: input.scope, mode: "complete" as HandoffMode, url: null, expires_in: 900 }) };

  const context = input.context ?? {};
  const def = VOCABULARY[input.scope]?.context;
  if (cfg.mode === "approve" && def) {
    const missing = def.required.filter((k) => !(k in context));
    if (missing.length) {
      // A session that reached the scope without asking has nothing specific to approve, so the consumer completes the step on the site instead.
      if (input.by === "foil") cfg.mode = "complete";
      else throw invalid("context_missing", `Handoffs on ${input.scope} in approve mode need context fields: ${missing.join(", ")}.`, "context");
    }
  }
  if ("amount" in context && (!Number.isInteger(context.amount) || (context.amount as number) < 0)) {
    throw invalid("invalid_context", "context.amount must be a non-negative integer in the minor unit of the currency.", "context.amount");
  }

  const delegation = s.delegation_id ? await store.getDelegation(s.delegation_id) : null;
  if (!delegation) throw invalid("session_not_agent", "The session has no delegation.", "session");
  const agentObj = await store.getAgentObject(delegation.agent);
  const hoId = id("ho");
  const code = makeCode();
  const created = now();
  const h: Handoff = {
    id: hoId,
    object: "handoff",
    created,
    livemode: store.livemode,
    metadata: input.metadata ?? {},
    status: "pending",
    mode: cfg.mode,
    session: s.id,
    delegation: delegation.id,
    agent: delegation.agent,
    operator: delegation.operator,
    origin: s.origin,
    scope: input.scope,
    context,
    display: buildDisplay({ scope: input.scope, context, agentName: agentObj?.name ?? delegation.agent, origin: s.origin, mode: cfg.mode }),
    url: cfg.url ? cfg.url.replace("{id}", hoId).replace("{code}", code) : null,
    code,
    expires_at: created + cfg.expires_in,
    completed_at: null,
    completed_by: null,
    result: null,
    linked_session: null,
    canceled_by: null,
  };
  await store.putHandoff(h);
  s.status = "requires_handoff";
  s.next_action = { type: "handoff", handoff: hoId };
  block.handoff = hoId;
  await store.putSession(s);
  return h;
}

/** Attach the consumer's own session at the site to a pending handoff. The SDK does this from the handoff id in the page URL. */
export async function linkHandoff(store: Store, hoId: string, consumerSessionId: string): Promise<Handoff> {
  const h = await getHandoff(store, hoId);
  if (h.status !== "pending") throw invalid("handoff_not_pending", `Handoff ${hoId} is ${h.status}.`, "id");
  const cs = await store.getSession(consumerSessionId);
  if (!cs) throw notFound("session", consumerSessionId);
  if (cs.origin !== h.origin) throw invalid("session_origin_mismatch", `Session ${cs.id} is at ${cs.origin}, not ${h.origin}.`, "session");
  if (cs.plane !== "human") throw invalid("session_not_human", `Session ${cs.id} was not scored human, so it cannot be linked to a handoff.`, "session");
  h.linked_session = cs.id;
  await store.putHandoff(h);
  return h;
}

export interface CompleteInput {
  sessionId?: string;
  result?: Record<string, unknown> | null;
}

/** The site reports that the consumer completed the step. */
export async function completeHandoff(store: Store, hoId: string, input: CompleteInput = {}): Promise<Handoff> {
  const h = await getHandoff(store, hoId);
  if (h.status !== "pending") throw invalid("handoff_not_pending", `Handoff ${hoId} is ${h.status} and cannot be completed.`, "id");
  const consumerId = input.sessionId ?? h.linked_session;
  if (!consumerId) {
    throw invalid("handoff_not_linked", "No consumer session is linked to this handoff. Pass session, or complete it from a page that runs the SDK with the handoff id in its URL.", "session");
  }
  const cs = await store.getSession(consumerId);
  if (!cs) throw notFound("session", consumerId);
  const agentSession = await store.getSession(h.session);
  if (cs.id === h.session || cs.plane !== "human") {
    if (agentSession) await downgradeSession(store, agentSession, "handoff_completed_by_agent", `handoff ${hoId} was completed from session ${cs.id}, which is not a human session`);
    throw new ApiError(403, "permission_error", "handoff_completed_by_agent", `Handoff ${hoId} can only be completed by the consumer's own session. Session ${cs.id} is not a human session, and the agent session has been downgraded.`, "session");
  }
  if (cs.origin !== h.origin) throw invalid("session_origin_mismatch", `Session ${cs.id} is at ${cs.origin}, not ${h.origin}.`, "session");

  const t = now();
  h.status = "completed";
  h.completed_at = t;
  h.linked_session = cs.id;
  h.completed_by = { session: cs.id, human: true, known_device: cs.known_device ?? false, device: cs.device ?? "unknown", cloud_environment: false };
  h.result = input.result ?? null;
  await store.putHandoff(h);

  const d = await store.getDelegation(h.delegation);
  if (d) {
    const observed = d.claims.record.observed ?? { site_session: cs.id, human: true, known_device: cs.known_device ?? false, age_s: 0 };
    observed.handoffs = [...(observed.handoffs ?? []), h.scope];
    d.claims.record.observed = observed;
    await store.putDelegation(d);
    await store.putRecord(d.claims.record);
    if (agentSession) {
      const block = agentBlock(agentSession);
      if (block) block.delegation.observed = observed;
    }
  }
  if (agentSession) {
    const block = agentBlock(agentSession);
    if (block) {
      block.handoff = null;
      if (h.mode === "approve") block.approvals.push({ handoff: h.id, scope: h.scope, context: h.context, approved_at: t, expires_at: t + 3600 });
      agentSession.status = "active";
      agentSession.next_action = null;
      await store.putSession(agentSession);
    }
  }
  return h;
}

export async function cancelHandoff(store: Store, hoId: string, by: string): Promise<Handoff> {
  const h = await getHandoff(store, hoId);
  if (h.status !== "pending") throw invalid("handoff_not_pending", `Handoff ${hoId} is ${h.status} and cannot be canceled.`, "id");
  h.status = "canceled";
  h.canceled_by = by;
  await store.putHandoff(h);
  await restoreSession(store, h);
  return h;
}

async function restoreSession(store: Store, h: Handoff): Promise<void> {
  const s = await store.getSession(h.session);
  const block = s ? agentBlock(s) : null;
  if (!s || !block || block.handoff !== h.id) return;
  block.handoff = null;
  s.status = "active";
  s.next_action = null;
  await store.putSession(s);
}

export async function updateHandoff(store: Store, hoId: string, patch: { url?: string | null; metadata?: Record<string, string> }): Promise<Handoff> {
  const h = await getHandoff(store, hoId);
  if (patch.url !== undefined) {
    if (patch.url && !/^https:\/\//.test(patch.url)) throw invalid("invalid_url", "url must be an https URL.", "url");
    h.url = patch.url;
  }
  if (patch.metadata) h.metadata = { ...h.metadata, ...patch.metadata };
  await store.putHandoff(h);
  return h;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!);
  return `${chars.slice(0, 3).join("")}-${chars.slice(3).join("")}`;
}

export function buildDisplay(input: { scope: string; context: Record<string, unknown>; agentName: string; origin: string; mode: HandoffMode }): { title: string; message: string } {
  const { scope, context, agentName, origin, mode } = input;
  const amount = typeof context.amount === "number" ? formatAmount(context.amount, typeof context.currency === "string" ? context.currency : "usd") : null;
  const where = "Confirm it on " + origin + " from your own device.";
  switch (scope) {
    case "payments:initiate": {
      const payee = typeof context.payee === "string" ? ` to ${context.payee}` : "";
      const what = amount ? `pay ${amount}${payee}` : `make a payment${payee}`;
      return { title: "Confirm a payment", message: `${agentName} wants to ${what} from your ${origin} account. ${mode === "approve" ? where : `Complete it on ${origin} from your own device.`}` };
    }
    case "transfers:initiate": {
      const what = amount ? `move ${amount}` : "move money";
      const path = typeof context.from === "string" && typeof context.to === "string" ? ` from ${context.from} to ${context.to}` : "";
      return { title: "Confirm a transfer", message: `${agentName} wants to ${what}${path} at ${origin}. ${where}` };
    }
    case "payees:write": {
      const payee = typeof context.payee === "string" ? ` ${context.payee}` : "";
      return { title: "Confirm a new payee", message: `${agentName} wants to add${payee} as a payee at ${origin}. ${where}` };
    }
    case "identity:verify": {
      const subject = typeof context.application === "string" ? "this application" : "this request";
      return { title: "Verify your identity", message: `${origin} needs to verify your identity before ${subject} can continue. Open the link on your phone, have your ID ready, and be prepared to take a short video.` };
    }
    default: {
      const text = VOCABULARY[scope]?.text;
      const step = text ? text.charAt(0).toLowerCase() + text.slice(1) : "a step";
      return { title: `Finish this step on ${origin}`, message: `${agentName} reached a step at ${origin} that you need to complete yourself: ${step}. Open ${origin} from your own device to continue.` };
    }
  }
}
