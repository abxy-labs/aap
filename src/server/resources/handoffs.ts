import type { Handoff } from "../../types.ts";
import { notFound } from "../../lib/errors.ts";
import { emitEvent } from "../../lib/events.ts";
import { cancelHandoff, completeHandoff, createHandoff, getHandoff, updateHandoff } from "../../lib/handoff.ts";
import { ownsOrigin, requireType } from "../auth.ts";
import { paginate } from "../envelope.ts";
import { metadata, obj, pageQuery, str } from "../params.ts";
import type { Ctx, Router } from "../router.ts";
import { loadSession } from "./sessions.ts";

function canSee(ctx: Ctx, h: Handoff): boolean {
  const acct = ctx.principal!.account;
  return (acct.type === "operator" && h.operator === acct.operator) || ownsOrigin(ctx.principal!, h.origin);
}

export async function loadHandoff(ctx: Ctx, id: string): Promise<Handoff> {
  const before = await ctx.store.getHandoff(id);
  if (!before || !canSee(ctx, before)) throw notFound("handoff", id);
  const h = await getHandoff(ctx.store, id);
  if (before.status === "pending" && h.status === "expired") await emitEvent(ctx.store, "handoff.expired", h, { id: ctx.requestId });
  return h;
}

export function handoffRoutes(r: Router): void {
  r.add("POST", "/v1/handoffs", async (ctx) => {
    requireType(ctx.principal!, "operator");
    const sessionId = str(ctx.body, "session", true)!;
    await loadSession(ctx, sessionId);
    const h = await createHandoff(ctx.store, ctx.root, {
      sessionId,
      scope: str(ctx.body, "scope", true)!,
      context: obj(ctx.body, "context") ?? {},
      metadata: metadata(ctx.body),
    });
    await emitEvent(ctx.store, "handoff.created", h, { id: ctx.requestId, idempotency_key: ctx.idempotencyKey ?? undefined });
    return h;
  });

  r.add("GET", "/v1/handoffs/:id", async (ctx) => loadHandoff(ctx, ctx.params.id!));

  r.add("GET", "/v1/handoffs", async (ctx) => {
    const q = ctx.query;
    const all = (await ctx.store.listHandoffs()).filter((h) => canSee(ctx, h));
    const filtered = all.filter((h) =>
      (!q.get("session") || h.session === q.get("session")) &&
      (!q.get("origin") || h.origin === q.get("origin")!.toLowerCase()) &&
      (!q.get("status") || h.status === q.get("status")),
    );
    return paginate(filtered, "/v1/handoffs", pageQuery(ctx.query));
  });

  r.add("POST", "/v1/handoffs/:id", async (ctx) => {
    await loadHandoff(ctx, ctx.params.id!);
    const patch: { url?: string | null; metadata?: Record<string, string> } = {};
    if (ctx.body.url !== undefined) {
      requireType(ctx.principal!, "site");
      patch.url = ctx.body.url === null ? null : str(ctx.body, "url");
    }
    if (ctx.body.metadata !== undefined) patch.metadata = metadata(ctx.body);
    return updateHandoff(ctx.store, ctx.params.id!, patch);
  });

  r.add("POST", "/v1/handoffs/:id/complete", async (ctx) => {
    requireType(ctx.principal!, "site");
    await loadHandoff(ctx, ctx.params.id!);
    const h = await completeHandoff(ctx.store, ctx.params.id!, { sessionId: str(ctx.body, "session"), result: obj(ctx.body, "result") ?? null });
    await emitEvent(ctx.store, "handoff.completed", h, { id: ctx.requestId });
    return h;
  });

  r.add("POST", "/v1/handoffs/:id/cancel", async (ctx) => {
    await loadHandoff(ctx, ctx.params.id!);
    const h = await cancelHandoff(ctx.store, ctx.params.id!, ctx.principal!.account.type);
    await emitEvent(ctx.store, "handoff.canceled", h, { id: ctx.requestId });
    return h;
  });
}
