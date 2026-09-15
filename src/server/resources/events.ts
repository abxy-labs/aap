import { notFound } from "../../lib/errors.ts";
import { paginate } from "../envelope.ts";
import { pageQuery } from "../params.ts";
import type { Router } from "../router.ts";

export function eventRoutes(r: Router): void {
  r.add("GET", "/v1/events/:id", async (ctx) => {
    const e = await ctx.store.getEvent(ctx.params.id!);
    if (!e) throw notFound("event", ctx.params.id!);
    return e;
  });

  r.add("GET", "/v1/events", async (ctx) => {
    const types = [...ctx.query.getAll("types[]"), ...(ctx.query.get("type") ? [ctx.query.get("type")!] : []), ...(ctx.query.get("types")?.split(",") ?? [])].filter(Boolean);
    const all = (await ctx.store.listEvents()).filter((e) => !types.length || types.includes(e.type));
    return paginate(all, "/v1/events", pageQuery(ctx.query));
  });
}
