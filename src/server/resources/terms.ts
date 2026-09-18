import { verifyAgent, verifyOperator } from "../../lib/certs.ts";
import { invalid, notFound } from "../../lib/errors.ts";
import type { Ctx } from "../router.ts";
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
