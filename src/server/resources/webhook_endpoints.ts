import type { WebhookEndpoint } from "../../types.ts";
import { invalid, notFound } from "../../lib/errors.ts";
import { EVENT_TYPES, newWebhookSecret } from "../../lib/events.ts";
import { id, now } from "../../lib/store.ts";
import { paginate, present } from "../envelope.ts";
import { list, metadata, pageQuery, str } from "../params.ts";
import type { Ctx, Router } from "../router.ts";

function validateEvents(events: string[]): void {
  const bad = events.filter((e) => e !== "*" && !(EVENT_TYPES as readonly string[]).includes(e));
  if (bad.length) throw invalid("parameter_invalid", `Unknown event types: ${bad.join(", ")}.`, "enabled_events");
}

async function own(ctx: Ctx, wid: string): Promise<WebhookEndpoint> {
  const w = await ctx.store.getWebhookEndpoint(wid);
  if (!w || w.metadata.__account !== ctx.principal!.account.id) throw notFound("webhook_endpoint", wid);
  return w;
}

function pub(w: WebhookEndpoint): WebhookEndpoint {
  const { __account: _a, ...metadata } = w.metadata;
  return present({ ...w, metadata });
}

export function webhookRoutes(r: Router): void {
  r.add("POST", "/v1/webhook_endpoints", async (ctx) => {
    const url = str(ctx.body, "url", true)!;
    if (!/^https?:\/\//.test(url)) throw invalid("parameter_invalid", "url must be an http(s) URL.", "url");
    const enabled = list(ctx.body, "enabled_events") ?? ["*"];
    validateEvents(enabled);
    const w: WebhookEndpoint = {
      id: id("we"), object: "webhook_endpoint", created: now(), livemode: ctx.store.livemode,
      metadata: { ...metadata(ctx.body), __account: ctx.principal!.account.id },
      url, enabled_events: enabled, status: "enabled", description: str(ctx.body, "description") ?? null, secret: newWebhookSecret(),
    };
    await ctx.store.putWebhookEndpoint(w);
    const { __account: _a, ...md } = w.metadata;
    return { ...w, metadata: md };
  });

  r.add("GET", "/v1/webhook_endpoints/:id", async (ctx) => pub(await own(ctx, ctx.params.id!)));

  r.add("GET", "/v1/webhook_endpoints", async (ctx) => {
    const mine = (await ctx.store.listWebhookEndpoints()).filter((w) => w.metadata.__account === ctx.principal!.account.id).map(pub);
    return paginate(mine, "/v1/webhook_endpoints", pageQuery(ctx.query));
  });

  r.add("POST", "/v1/webhook_endpoints/:id", async (ctx) => {
    const w = await own(ctx, ctx.params.id!);
    if (ctx.body.url !== undefined) w.url = str(ctx.body, "url")!;
    if (ctx.body.enabled_events !== undefined) { const ev = list(ctx.body, "enabled_events")!; validateEvents(ev); w.enabled_events = ev; }
    if (ctx.body.status !== undefined) { const s = str(ctx.body, "status")!; if (s !== "enabled" && s !== "disabled") throw invalid("parameter_invalid", "status must be enabled or disabled.", "status"); w.status = s; }
    if (ctx.body.description !== undefined) w.description = str(ctx.body, "description") ?? null;
    if (ctx.body.metadata !== undefined) w.metadata = { ...w.metadata, ...metadata(ctx.body), __account: ctx.principal!.account.id };
    await ctx.store.putWebhookEndpoint(w);
    return pub(w);
  });

  r.add("DELETE", "/v1/webhook_endpoints/:id", async (ctx) => {
    await own(ctx, ctx.params.id!);
    await ctx.store.delWebhookEndpoint(ctx.params.id!);
    return { id: ctx.params.id!, object: "webhook_endpoint", deleted: true };
  });
}
