import type { CustomerAction } from "../../types.ts";
import { notFound } from "../../lib/errors.ts";
import { emitEvent } from "../../lib/events.ts";
import {
  cancelCustomerAction,
  completeCustomerAction,
  createCustomerAction,
  getCustomerAction,
  updateCustomerAction,
} from "../../lib/customer-action.ts";
import { ownsOrigin, requireType } from "../auth.ts";
import { paginate, present } from "../envelope.ts";
import { metadata, obj, pageQuery, str } from "../params.ts";
import type { Ctx, Router } from "../router.ts";
import { loadSession } from "./sessions.ts";

function canSee(ctx: Ctx, h: CustomerAction): boolean {
  const acct = ctx.principal!.account;
  return (
    (acct.type === "operator" && h.operator === acct.operator) ||
    ownsOrigin(ctx.principal!, h.origin)
  );
}

export async function loadCustomerAction(
  ctx: Ctx,
  id: string,
): Promise<CustomerAction> {
  const before = await ctx.store.getCustomerAction(id);
  if (!before || !canSee(ctx, before)) throw notFound("customer_action", id);
  const h = await getCustomerAction(ctx.store, id);
  if (before.status === "pending" && h.status === "expired")
    await emitEvent(ctx.store, "customer_action.expired", h, {
      id: ctx.requestId,
    });
  return present(h);
}

export function customerActionRoutes(r: Router): void {
  r.add("POST", "/v1/customer_actions", async (ctx) => {
    requireType(ctx.principal!, "operator");
    const sessionId = str(ctx.body, "session", true)!;
    await loadSession(ctx, sessionId);
    const h = await createCustomerAction(ctx.store, ctx.root, {
      sessionId,
      scope: str(ctx.body, "scope", true)!,
      context: obj(ctx.body, "context") ?? {},
      metadata: metadata(ctx.body),
    });
    await emitEvent(ctx.store, "customer_action.created", h, {
      id: ctx.requestId,
      idempotency_key: ctx.idempotencyKey ?? undefined,
    });
    return present(h);
  });

  r.add("GET", "/v1/customer_actions/:id", async (ctx) =>
    present(await loadCustomerAction(ctx, ctx.params.id!)),
  );

  r.add("GET", "/v1/customer_actions", async (ctx) => {
    const q = ctx.query;
    const all = (await ctx.store.listCustomerActions()).filter((h) =>
      canSee(ctx, h),
    );
    const filtered = all.filter(
      (h) =>
        (!q.get("session") || h.session === q.get("session")) &&
        (!q.get("origin") || h.origin === q.get("origin")!.toLowerCase()) &&
        (!q.get("status") || h.status === q.get("status")),
    );
    return paginate(
      filtered.map(present),
      "/v1/customer_actions",
      pageQuery(ctx.query),
    );
  });

  r.add("POST", "/v1/customer_actions/:id", async (ctx) => {
    await loadCustomerAction(ctx, ctx.params.id!);
    const patch: { url?: string | null; metadata?: Record<string, string> } =
      {};
    if (ctx.body.url !== undefined) {
      requireType(ctx.principal!, "site");
      patch.url = ctx.body.url === null ? null : str(ctx.body, "url");
    }
    if (ctx.body.metadata !== undefined) patch.metadata = metadata(ctx.body);
    return present(
      await updateCustomerAction(ctx.store, ctx.params.id!, patch),
    );
  });

  r.add("POST", "/v1/customer_actions/:id/complete", async (ctx) => {
    requireType(ctx.principal!, "site");
    await loadCustomerAction(ctx, ctx.params.id!);
    const h = await completeCustomerAction(ctx.store, ctx.params.id!, {
      sessionId: str(ctx.body, "session"),
      result: obj(ctx.body, "result") ?? null,
    });
    await emitEvent(ctx.store, "customer_action.completed", h, {
      id: ctx.requestId,
    });
    return present(h);
  });

  r.add("POST", "/v1/customer_actions/:id/cancel", async (ctx) => {
    await loadCustomerAction(ctx, ctx.params.id!);
    const h = await cancelCustomerAction(
      ctx.store,
      ctx.params.id!,
      ctx.principal!.account.type,
    );
    await emitEvent(ctx.store, "customer_action.canceled", h, {
      id: ctx.requestId,
    });
    return present(h);
  });
}
