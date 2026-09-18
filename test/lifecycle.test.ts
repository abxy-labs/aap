import { afterAll, describe, expect, test } from "bun:test";
import { ORIGIN, makeDelegation, makePresentation, makeTerms, makeWorld, verifyAt } from "./world.ts";
import { useScope } from "../src/lib/session.ts";
import { completeCustomerAction, createCustomerAction } from "../src/lib/customer-action.ts";
import { directory, hashOrigin } from "../src/lib/directory.ts";
import { setPolicy } from "../src/lib/policy.ts";
import { issueChallenge } from "../src/lib/challenge.ts";
import type { AgentBlock } from "../src/types.ts";

describe("lifecycle", () => {
  const worlds: Awaited<ReturnType<typeof makeWorld>>[] = [];
  afterAll(async () => { for (const w of worlds) await w.store.destroy(); });

  test("terms are an object, intersected, with plain-language strings and an expiry", async () => {
    const w = await makeWorld(); worlds.push(w);
    const terms = await makeTerms(w, ["accounts:read", "payments:initiate", "transfers:initiate"]);
    expect(terms.id).toMatch(/^trm_/);
    expect(terms.object).toBe("terms");
    expect(terms.scopes.map((s) => s.id)).toEqual(["accounts:read", "payments:initiate"]);
    expect(terms.constraints).toEqual({ currency: "usd", max_amount: 20000, payees: "existing_only" });
    expect(terms.scopes[1]!.text).toBe("Make payments up to $200 each to payees you already have");
    expect(terms.disclosures!.acknowledgements[1]!.text).toContain("test-agent");
    expect(terms.expires_at).toBeGreaterThan(terms.created);
  });

  test("full flow binds a session and the site reads the agent block", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    expect(dl.stored.object).toBe("delegation");
    expect(dl.stored.status).toBe("active");
    expect(dl.claims.scopes).toEqual(["accounts:read", "payments:initiate"]);
    expect(dl.claims.record.observed?.human).toBe(true);
    const r = await verifyAt(w, await makePresentation(w, dl));
    expect(r.statusHeader).toBe("Foil-Agent-Status: bound");
    expect(r.session.status).toBe("active");
    expect(r.session.decision).toEqual({ verdict: "allow", plane: "agent" });
    const block = r.session.agent as AgentBlock;
    expect(block.id).toBe("ag_test");
    expect(block.operator).toBe("op_test");
    expect(block.constraints.max_amount).toBe(20000);
    expect(block.authorization.policy_version).toBe(1);
    expect(block.authorization.observed?.site_session).toBe("sess_human");
    expect(block.approvals).toEqual([]);
    expect(r.customer_actions?.map((h) => h.scope)).toEqual(["payments:initiate"]);
  });

  test("scope use is recorded and a customer_action scope creates a customer_action the consumer completes", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    await verifyAt(w, await makePresentation(w, dl));
    const r1 = await useScope(w.store, w.root, "sess_agent", "accounts:read");
    expect(r1.statusHeader).toBe("Foil-Agent-Status: bound");
    expect((r1.session.agent as AgentBlock).scopes_used).toEqual(["accounts:read"]);
    const r2 = await useScope(w.store, w.root, "sess_agent", "payments:initiate");
    expect(r2.customer_actionHeader).toMatch(/^Foil-Agent-CustomerAction: required; id=ca_/);
    expect(r2.session.status).toBe("requires_customer_action");
    expect(r2.session.next_action).toEqual({ type: "customer_action", customer_action: r2.customer_action!.id });
    // reached without context, so there is nothing to approve: the consumer completes the step on the site
    expect(r2.customer_action!.mode).toBe("complete");
    expect(r2.customer_action!.url).toBe(`https://bank.example/agent/confirm?aap_customer_action=${r2.customer_action!.id}`);
    // creating again for the same scope returns the pending one
    const again = await createCustomerAction(w.store, w.root, { sessionId: "sess_agent", scope: "payments:initiate", context: { amount: 1, currency: "usd", payee: "x" } });
    expect(again.id).toBe(r2.customer_action!.id);
    await w.store.putSiteSession({ id: "sess_phone", origin: ORIGIN, human: true, known_device: true, created_at: new Date().toISOString(), device: "mobile" });
    const done = await completeCustomerAction(w.store, r2.customer_action!.id, { sessionId: "sess_phone", result: { confirmed: true } });
    expect(done.status).toBe("completed");
    expect(done.completed_by?.session).toBe("sess_phone");
    const s = (await w.store.getSession("sess_agent"))!;
    expect(s.status).toBe("active");
    expect(s.next_action).toBeNull();
    expect((s.agent as AgentBlock).customer_action).toBeNull();
    expect((s.agent as AgentBlock).approvals).toEqual([]);
    expect((s.agent as AgentBlock).authorization.observed?.customer_actions).toEqual(["payments:initiate"]);
    // an agent that asks first, with context, gets approve mode and an approval on completion
    const asked = await createCustomerAction(w.store, w.root, { sessionId: "sess_agent", scope: "payments:initiate", context: { amount: 14210, currency: "usd", payee: "Pacific Power" }, by: "agent" });
    expect(asked.mode).toBe("approve");
    expect(asked.display.message).toContain("$142.10 to Pacific Power");
    const approved = await completeCustomerAction(w.store, asked.id, { sessionId: "sess_phone" });
    const s2 = (await w.store.getSession("sess_agent"))!;
    expect((s2.agent as AgentBlock).approvals[0]).toMatchObject({ customer_action: approved.id, scope: "payments:initiate", context: { amount: 14210 } });
  });

  test("a grant may narrow the delegation and the policy is re-applied at bind", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    const r = await verifyAt(w, await makePresentation(w, dl, { scopes: ["accounts:read"] }));
    expect((r.session.agent as AgentBlock).scopes).toEqual(["accounts:read"]);
    await setPolicy(w.store, w.root, { origin: ORIGIN, scopes: ["accounts:read", "transactions:read"], evidence: { "accounts:read": "asserted" } });
    const r2 = await verifyAt(w, await makePresentation(w, dl), "sess_agent2");
    expect(r2.statusHeader).toBe("Foil-Agent-Status: bound");
    expect((r2.session.agent as AgentBlock).scopes).toEqual(["accounts:read"]);
    expect(r2.narrowed).toEqual(["payments:initiate"]);
    expect((r2.session.agent as AgentBlock).id).toBeUndefined();
  });

  test("a presentation without the chain works once Foil has seen it", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    await verifyAt(w, await makePresentation(w, dl), "sess_first");
    const r = await verifyAt(w, await makePresentation(w, dl, { fullChain: false }), "sess_second");
    expect(r.statusHeader).toBe("Foil-Agent-Status: bound");
  });

  test("challenges are only issued for participating origins and the directory hashes them", async () => {
    const w = await makeWorld(); worlds.push(w);
    expect(await issueChallenge(w.store, w.root, "other.example")).toBeNull();
    await setPolicy(w.store, w.root, { origin: "closed.example", scopes: [] });
    expect(await issueChallenge(w.store, w.root, "closed.example")).toBeNull();
    const d = await directory(w.store);
    expect(d.data.map((x) => x.hash)).toEqual([hashOrigin(ORIGIN)]);
  });
});
