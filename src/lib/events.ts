import type { EventObject, WebhookEndpoint } from "../types.ts";
import { invalid } from "./errors.ts";
import { Store, id, now } from "./store.ts";

export const EVENT_TYPES = [
  "agent.created", "agent.deactivated",
  "policy.created",
  "terms.created",
  "delegation.created", "delegation.revoked", "delegation.expired",
  "session.bound", "session.downgraded", "session.scope_used",
  "handoff.created", "handoff.completed", "handoff.canceled", "handoff.expired",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const pendingDeliveries = new Set<Promise<void>>();

export async function flushDeliveries(): Promise<void> {
  await Promise.allSettled([...pendingDeliveries]);
}

function matches(endpoint: WebhookEndpoint, type: string): boolean {
  return endpoint.status === "enabled" && (endpoint.enabled_events.includes("*") || endpoint.enabled_events.includes(type));
}

export async function emitEvent(store: Store, type: EventType, object: unknown, request: { id?: string; idempotency_key?: string } = {}): Promise<EventObject> {
  const endpoints = (await store.listWebhookEndpoints()).filter((e) => matches(e, type));
  const evt: EventObject = {
    id: id("evt"),
    object: "event",
    created: now(),
    livemode: store.livemode,
    type,
    data: { object },
    pending_webhooks: endpoints.length,
    request: { id: request.id ?? null, idempotency_key: request.idempotency_key ?? null },
  };
  await store.putEvent(evt);
  for (const endpoint of endpoints) {
    const p = deliver(store, endpoint, evt).catch(() => undefined);
    pendingDeliveries.add(p);
    void p.finally(() => pendingDeliveries.delete(p));
  }
  return evt;
}

async function deliver(store: Store, endpoint: WebhookEndpoint, evt: EventObject): Promise<void> {
  const body = JSON.stringify(evt);
  const secret = endpoint.secret ?? "";
  try {
    await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", "aap-signature": signatureHeader(secret, body), "aap-event-id": evt.id },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } finally {
    const current = await store.getEvent(evt.id);
    if (current) {
      current.pending_webhooks = Math.max(0, current.pending_webhooks - 1);
      await store.putEvent(current);
    }
  }
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  const h = new Bun.CryptoHasher("sha256", secret);
  h.update(`${timestamp}.${body}`);
  return h.digest("hex");
}

export function signatureHeader(secret: string, body: string, timestamp = now()): string {
  return `t=${timestamp},v1=${signPayload(secret, timestamp, body)}`;
}

/** Verify a webhook delivery and return the event. Throws when the signature is missing, wrong, or too old. */
export function constructEvent(body: string, header: string | null, secret: string, toleranceS = 300): EventObject {
  if (!header) throw invalid("webhook_signature_missing", "No AAP-Signature header was present.");
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) throw invalid("webhook_signature_invalid", "The AAP-Signature header is malformed.");
  if (Math.abs(now() - t) > toleranceS) throw invalid("webhook_signature_expired", "The webhook timestamp is outside the tolerance window.");
  const expected = signPayload(secret, t, body);
  if (expected.length !== v1.length || !timingSafeEqual(expected, v1)) throw invalid("webhook_signature_invalid", "The webhook signature does not match.");
  return JSON.parse(body) as EventObject;
}

function timingSafeEqual(a: string, b: string): boolean {
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function newWebhookSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "whsec_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
