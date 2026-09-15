import { verifyAgent, verifyOperator } from "../../lib/certs.ts";
import { invalid, notFound } from "../../lib/errors.ts";
import { emitEvent } from "../../lib/events.ts";
import { admitsAgents, loadPolicy } from "../../lib/policy.ts";
import { createTerms } from "../../lib/terms.ts";
import { requireType } from "../auth.ts";
import { list, metadata, str } from "../params.ts";
import type { Ctx, Router } from "../router.ts";
import type { AgentClaims, AgentObject, OperatorClaims } from "../../types.ts";

/** Resolve an operator account's agent to its verified certificate claims. */
export async function ownAgentClaims(ctx: Ctx, agentId: string): Promise<{ agent: AgentObject; claims: AgentClaims; operator: OperatorClaims }> {
  const a = await ctx.store.getAgentObject(agentId);
  if (!a || a.operator !== ctx.principal!.account.operator) throw notFound("agent", agentId);
  if (a.status !== "active") throw invalid("agent_deactivated", `Agent ${agentId} is deactivated.`, "agent");
  const op = await ctx.store.getOperatorObject(a.operator);
  if (!op) throw invalid("operator_missing", "The agent's operator certificate is missing.");
  const operator = await verifyOperator(op.certificate, ctx.root.public);
  const claims = await verifyAgent(a.certificate, operator);
  return { agent: a, claims, operator };
}

export function termsRoutes(r: Router): void {
  r.add("POST", "/v1/terms", async (ctx) => {
    requireType(ctx.principal!, "operator");
    const { store, root, body } = ctx;
    const { claims } = await ownAgentClaims(ctx, str(body, "agent", true)!);
    const origin = str(body, "origin", true)!.toLowerCase();
    const policy = await loadPolicy(store, root, origin);
    if (!admitsAgents(policy)) throw invalid("origin_not_participating", `${origin} does not admit agents.`, "origin");
    const terms = await createTerms(store, claims, policy, list(body, "scopes") ?? claims.ceiling.scopes, metadata(body));
    await emitEvent(store, "terms.created", terms, { id: ctx.requestId });
    return terms;
  });

  r.add("GET", "/v1/terms/:id", async (ctx) => {
    requireType(ctx.principal!, "operator");
    const t = await ctx.store.getTerms(ctx.params.id!);
    if (!t) throw notFound("terms", ctx.params.id!);
    const a = await ctx.store.getAgentObject(t.agent);
    if (!a || a.operator !== ctx.principal!.account.operator) throw notFound("terms", ctx.params.id!);
    return t;
  });
}
