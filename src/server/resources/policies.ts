import type {
  AttestationPolicy,
  DisclosureBundle,
  Evidence,
  CustomerActionConfig,
} from "../../types.ts";
import { forbidden, notFound, invalid } from "../../lib/errors.ts";
import { emitEvent } from "../../lib/events.ts";
import { setPolicy } from "../../lib/policy.ts";
import { requireType } from "../auth.ts";
import { paginate } from "../envelope.ts";
import { list, metadata, num, obj, pageQuery, str } from "../params.ts";
import type { Router } from "../router.ts";

export function publicPolicy(p: import("../../types.ts").PolicyObject) {
  const { evidence, attestations, credentials, statement, ...base } = p;
  return {
    ...base,
    scopes: p.scopes ?? [],
    advanced: { evidence, attestations },
  };
}

export function policyRoutes(r: Router): void {
  r.add("POST", "/v1/policies", async (ctx) => {
    requireType(ctx.principal!, "site");
    const { store, root, body, principal } = ctx;
    for (const key of [
      "tier",
      "handoffs",
      "evidence",
      "attestations",
      "credentials",
    ]) {
      if (body[key] !== undefined)
        throw invalid(
          "parameter_invalid",
          `${key} is not a policy parameter. Use scopes, customer_actions, and optional advanced evidence settings.`,
          key,
        );
    }
    const scopes = list(body, "scopes", true)!;
    if (
      body.customer_actions !== undefined &&
      (!Array.isArray(body.customer_actions) ||
        body.customer_actions.some(
          (action) =>
            !action || typeof action !== "object" || Array.isArray(action),
        ))
    ) {
      throw invalid(
        "parameter_invalid",
        "customer_actions must be an array of scope configurations.",
        "customer_actions",
      );
    }
    const advanced = obj<Record<string, unknown>>(body, "advanced") ?? {};
    const origin = str(body, "origin", true)!.toLowerCase();
    const account = principal!.account;
    if (!account.origins.includes(origin)) {
      for (const other of await store.listAccounts()) {
        if (other.id !== account.id && other.origins.includes(origin))
          throw forbidden(`The origin ${origin} belongs to another account.`);
      }
      account.origins.push(origin);
      await store.putAccount(account);
    }
    const allow =
      obj<{
        operators?: string[] | "any";
        agents?: string[] | "any";
        deny_agents?: string[];
      }>(body, "allow") ?? {};
    const disclose = list(body, "disclose") ?? [];
    const policy = await setPolicy(store, root, {
      origin,
      scopes,
      allowOperators: allow.operators ?? "any",
      allowAgents: allow.agents ?? "any",
      denyAgents: allow.deny_agents ?? [],
      constraints: obj(body, "constraints") ?? {},
      disclosures: obj<DisclosureBundle>(body, "disclosures") ?? null,
      evidence:
        obj<Partial<Record<string, Evidence>>>(advanced, "evidence") ?? {},
      customer_actions:
        (body.customer_actions as CustomerActionConfig[] | undefined) ?? [],
      maxAgeS: num(body, "max_age_s"),
      disclose: {
        operator: disclose.includes("operator"),
        agent: disclose.includes("agent"),
      },
      attestations: obj<AttestationPolicy>(advanced, "attestations") ?? null,
      credentials: null,
      metadata: metadata(body),
    });
    await emitEvent(store, "policy.created", publicPolicy(policy), {
      id: ctx.requestId,
      idempotency_key: ctx.idempotencyKey ?? undefined,
    });
    return publicPolicy(policy);
  });

  r.add("GET", "/v1/policies/:id", async (ctx) => {
    requireType(ctx.principal!, "site");
    const p = await ctx.store.getPolicyObject(ctx.params.id!);
    if (!p || !ctx.principal!.account.origins.includes(p.origin))
      throw notFound("policy", ctx.params.id!);
    return publicPolicy(p);
  });

  r.add("GET", "/v1/policies", async (ctx) => {
    requireType(ctx.principal!, "site");
    const origin = ctx.query.get("origin")?.toLowerCase();
    const mine = (await ctx.store.listPolicies()).filter(
      (p) =>
        ctx.principal!.account.origins.includes(p.origin) &&
        (!origin || p.origin === origin),
    );
    return paginate(
      mine.map(publicPolicy),
      "/v1/policies",
      pageQuery(ctx.query),
    );
  });
}
