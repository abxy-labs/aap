import type { SessionRecord } from "../../types.ts";
import { notFound } from "../../lib/errors.ts";
import { ownsOrigin } from "../auth.ts";
import { paginate, present } from "../envelope.ts";
import { pageQuery } from "../params.ts";
import type { Ctx, Router } from "../router.ts";

export function canSeeSession(ctx: Ctx, s: SessionRecord): boolean {
  const acct = ctx.principal!.account;
  if (ownsOrigin(ctx.principal!, s.origin)) return true;
  return acct.type === "operator" && !!acct.operator && s.operator_id === acct.operator;
}

export async function loadSession(ctx: Ctx, id: string): Promise<SessionRecord> {
  const s = await ctx.store.getSession(id);
  if (!s || !canSeeSession(ctx, s)) throw notFound("session", id);
  return s;
}

export function sessionRoutes(r: Router): void {
  r.add("GET", "/v1/sessions/:id", async (ctx) => present(await loadSession(ctx, ctx.params.id!)));

  r.add("GET", "/v1/sessions", async (ctx) => {
    const q = ctx.query;
    const all = (await ctx.store.listSessions()).filter((s) => canSeeSession(ctx, s));
    const filtered = all.filter((s) =>
      (!q.get("origin") || s.origin === q.get("origin")!.toLowerCase()) &&
      (!q.get("status") || s.status === q.get("status")) &&
      (!q.get("plane") || s.plane === q.get("plane")),
    ).map(present);
    return paginate(filtered, "/v1/sessions", pageQuery(ctx.query));
  });
}
