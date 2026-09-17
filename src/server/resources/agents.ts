import type { AgentClaims, AgentObject } from "../../types.ts";
import { verifyAgent, verifyOperator } from "../../lib/certs.ts";
import { invalid, notFound } from "../../lib/errors.ts";
import { emitEvent } from "../../lib/events.ts";
import { now } from "../../lib/store.ts";
import { requireType } from "../auth.ts";
import { paginate, present } from "../envelope.ts";
import { metadata, pageQuery, str } from "../params.ts";
import type { Ctx, Router } from "../router.ts";

async function ownAgent(ctx: Ctx, agentId: string): Promise<AgentObject> {
  const a = await ctx.store.getAgentObject(agentId);
  if (!a || a.operator !== ctx.principal!.account.operator) throw notFound("agent", agentId);
  return a;
}

export function agentRoutes(r: Router): void {
  r.add("POST", "/v1/agents", async (ctx) => {
    requireType(ctx.principal!, "operator");
    const { store, root, body, principal } = ctx;
    const certificate = str(body, "certificate", true)!;
    const operatorObj = await store.getOperatorObject(principal!.account.operator!);
    if (!operatorObj) throw invalid("operator_missing", "This account has no operator certificate.");
    const operator = await verifyOperator(operatorObj.certificate, root.public);
    let claims: AgentClaims;
    try {
      claims = await verifyAgent(certificate, operator);
    } catch (e) {
      throw invalid("invalid_certificate", `The agent certificate did not verify against your operator certificate: ${e instanceof Error ? e.message : String(e)}`, "certificate");
    }
    if (!/^ag_[A-Za-z0-9]+$/.test(claims.sub)) throw invalid("invalid_certificate", "The agent id in the certificate must look like ag_… .", "certificate");
    if (await store.getAgentObject(claims.sub)) throw invalid("agent_exists", `Agent ${claims.sub} already exists.`, "certificate");
    const agent: AgentObject = {
      id: claims.sub, object: "agent", created: now(), livemode: store.livemode, metadata: metadata(body),
      operator: operator.sub, name: claims.name, status: "active", public_key: claims.key, ceiling: claims.ceiling, certificate, expires_at: claims.exp,
    };
    await store.putAgentObject(agent);
    await emitEvent(store, "agent.created", agent, { id: ctx.requestId, idempotency_key: ctx.idempotencyKey ?? undefined });
    return agent;
  });

  r.add("GET", "/v1/agents/:id", async (ctx) => {
    const a = await ctx.store.getAgentObject(ctx.params.id!);
    if (!a) throw notFound("agent", ctx.params.id!);
    return present(a);
  });

  r.add("GET", "/v1/agents", async (ctx) => {
    const all = await ctx.store.listAgents();
    const mine = ctx.principal!.account.type === "operator" ? all.filter((a) => a.operator === ctx.principal!.account.operator) : all.filter((a) => a.status === "active");
    const status = ctx.query.get("status");
    return paginate(mine.filter((a) => !status || a.status === status).map(present), "/v1/agents", pageQuery(ctx.query));
  });

  r.add("POST", "/v1/agents/:id", async (ctx) => {
    requireType(ctx.principal!, "operator");
    const a = await ownAgent(ctx, ctx.params.id!);
    if (ctx.body.metadata !== undefined) a.metadata = { ...a.metadata, ...metadata(ctx.body) };
    await ctx.store.putAgentObject(a);
    return a;
  });

  r.add("POST", "/v1/agents/:id/deactivate", async (ctx) => {
    requireType(ctx.principal!, "operator");
    const a = await ownAgent(ctx, ctx.params.id!);
    if (a.status === "deactivated") throw invalid("agent_already_deactivated", `Agent ${a.id} is already deactivated.`);
    a.status = "deactivated";
    await ctx.store.putAgentObject(a);
    await emitEvent(ctx.store, "agent.deactivated", a, { id: ctx.requestId });
    return a;
  });
}
