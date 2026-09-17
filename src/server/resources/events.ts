import { notFound } from "../../lib/errors.ts";
import { eventAccountIds } from "../../lib/events.ts";
import { paginate } from "../envelope.ts";
import { pageQuery } from "../params.ts";
import type { Router } from "../router.ts";

export function eventRoutes(r: Router): void {
  r.add("GET", "/v1/events/:id", async (ctx) => {
    const e = await ctx.store.getEvent(ctx.params.id!);
    if (!e || !(await eventAccountIds(ctx.store, e)).has(ctx.principal!.account.id)) throw notFound("event", ctx.params.id!);
    return e;
  });

  r.add("GET", "/v1/events", async (ctx) => {
    const types = [...ctx.query.getAll("types[]"), ...(ctx.query.get("type") ? [ctx.query.get("type")!] : []), ...(ctx.query.get("types")?.split(",") ?? [])].filter(Boolean);
    const candidates = (await ctx.store.listEvents()).filter((e) => !types.length || types.includes(e.type));
    const visible = await Promise.all(candidates.map(async (event) =>
      (await eventAccountIds(ctx.store, event)).has(ctx.principal!.account.id) ? event : null,
    ));
    const all = visible.filter((event) => event !== null);
    return paginate(all, "/v1/events", pageQuery(ctx.query));
  });
}
