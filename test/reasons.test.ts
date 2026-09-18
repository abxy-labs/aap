import { afterAll, describe, expect, test } from "bun:test";
import { ORIGIN, makeDelegation, makePresentation, makeTerms, makeWorld, verifyAt } from "./world.ts";
import { useScope } from "../src/lib/session.ts";
import { completeCustomerAction, createCustomerAction } from "../src/lib/customer-action.ts";
import { revokeDelegation, createDelegation } from "../src/lib/delegation.ts";
import { setPolicy } from "../src/lib/policy.ts";
import { generateKeyFile } from "../src/lib/keys.ts";
import { signGrant } from "../src/lib/grant.ts";
import { issueAgent } from "../src/lib/certs.ts";
import { verifyPresentation } from "../src/lib/verify.ts";

function reason(r: { session: { agent: unknown } }): string | undefined {
  return (r.session.agent as { reason?: string } | null)?.reason;
}

describe("downgrade reasons", () => {
  const worlds: Awaited<ReturnType<typeof makeWorld>>[] = [];
  afterAll(async () => { for (const w of worlds) await w.store.destroy(); });

  test("chain_invalid: grant signed by a key that is not the agent's", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    const r = await verifyAt(w, await makePresentation(w, dl, { agentKey: await generateKeyFile() }));
    expect(r.statusHeader).toBe("Foil-Agent-Status: downgraded; reason=chain_invalid");
    expect(r.session.status).toBe("downgraded");
  });

  test("chain_invalid: delegation for a different origin", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    const r = await verifyPresentation(w.store, w.root, { header: await makePresentation(w, dl), origin: "other.example", sessionId: "s", asn: "AS1" });
    expect(reason(r)).toBe("chain_invalid");
  });

  test("challenge_invalid: nonce Foil never issued", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    expect(reason(await verifyAt(w, await makePresentation(w, dl, { nonce: "deadbeef" })))).toBe("challenge_invalid");
  });

  test("delegation_revoked", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    await revokeDelegation(w.store, dl.claims.sub, "consumer");
    expect(reason(await verifyAt(w, await makePresentation(w, dl)))).toBe("delegation_revoked");
  });

  test("delegation_expired", async () => {
    const w = await makeWorld({ maxAgeS: 60 }); worlds.push(w);
    const dl = await makeDelegation(w, { now: new Date(Date.now() - 120_000) });
    expect(reason(await verifyAt(w, await makePresentation(w, dl)))).toBe("delegation_expired");
  });

  test("policy_denied: agent denied by name", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    await setPolicy(w.store, w.root, { origin: ORIGIN, scopes: ["accounts:read", "transactions:read", "payments:initiate"], denyAgents: ["ag_test"], evidence: { "payments:initiate": "observed" } });
    expect(reason(await verifyAt(w, await makePresentation(w, dl)))).toBe("policy_denied");
  });

  test("agent_deactivated", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    const a = (await w.store.getAgentObject("ag_test"))!;
    a.status = "deactivated";
    await w.store.putAgentObject(a);
    expect(reason(await verifyAt(w, await makePresentation(w, dl)))).toBe("agent_deactivated");
  });

  test("grant_replayed: the second session is refused and the first is downgraded", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    const header = await makePresentation(w, dl);
    expect((await verifyAt(w, header, "sess_one")).session.plane).toBe("agent");
    expect(reason(await verifyAt(w, header, "sess_two"))).toBe("grant_replayed");
    const one = (await w.store.getSession("sess_one"))!;
    expect(one.plane).toBe("bot");
    expect(reason({ session: one })).toBe("grant_replayed");
  });

  test("operator_mismatch", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    expect(reason(await verifyAt(w, await makePresentation(w, dl), "s", { asn: "AS999" }))).toBe("operator_mismatch");
  });

  test("scope_violation", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    await verifyAt(w, await makePresentation(w, dl, { scopes: ["accounts:read"] }));
    const r = await useScope(w.store, w.root, "sess_agent", "payments:initiate");
    expect(r.statusHeader).toBe("Foil-Agent-Status: downgraded; reason=scope_violation");
  });

  test("evidence_insufficient at transact, fine at read", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w, { siteSession: null });
    expect(dl.claims.record.observed).toBeNull();
    expect(reason(await verifyAt(w, await makePresentation(w, dl)))).toBe("evidence_insufficient");
    expect((await verifyAt(w, await makePresentation(w, dl, { scopes: ["accounts:read"] }), "sess_read")).statusHeader).toBe("Foil-Agent-Status: bound");
  });

  test("customer_action_completed_by_agent: completing from the agent's own session downgrades it", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    await verifyAt(w, await makePresentation(w, dl));
    const h = await createCustomerAction(w.store, w.root, { sessionId: "sess_agent", scope: "payments:initiate", context: { amount: 100, currency: "usd", payee: "x" } });
    await expect(completeCustomerAction(w.store, h.id, { sessionId: "sess_agent" })).rejects.toThrow(/customer_action_completed_by_agent|consumer's own session/);
    expect(reason({ session: (await w.store.getSession("sess_agent"))! })).toBe("customer_action_completed_by_agent");
  });
});

describe("issuance rules", () => {
  const worlds: Awaited<ReturnType<typeof makeWorld>>[] = [];
  afterAll(async () => { for (const w of worlds) await w.store.destroy(); });

  test("a grant cannot widen the delegation", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w, { scopes: ["accounts:read"] });
    await expect(signGrant(w.agentKey, w.agent, dl.claims, { sessionRef: "s", intent: "i", scopes: ["payments:initiate"], nonce: "n" })).rejects.toThrow(/narrow/);
  });

  test("an agent ceiling cannot include security:write", async () => {
    const w = await makeWorld(); worlds.push(w);
    await expect(issueAgent(w.operatorKey, "op_test", { id: "ag_bad", name: "bad", key: w.agentKey.public, ceiling: { scopes: ["security:write"], constraints: {} } })).rejects.toThrow(/never grantable/);
  });

  test("delegation creation checks the terms object, acknowledgements, viewed documents, copies, and site-only bundles", async () => {
    const w = await makeWorld(); worlds.push(w);
    const terms = await makeTerms(w, ["accounts:read"]);
    const base = { agent: w.agent, operator: w.operator, origin: ORIGIN, subject: "u", scopes: ["accounts:read"], terms: terms.id, intent: "i" };
    const ok = { terms: terms.id, acknowledged: ["esign", "share"], viewed: ["esign", "privacy"], channel: "c", accepted_at: "now", copies_sent_to: "email" };
    await expect(createDelegation(w.store, w.root, { ...base, terms: "trm_missing", acceptance: ok })).rejects.toThrow(/No such terms/);
    await expect(createDelegation(w.store, w.root, { ...base, acceptance: { ...ok, terms: "trm_other" } })).rejects.toThrow(/acceptance references/);
    await expect(createDelegation(w.store, w.root, { ...base, acceptance: { ...ok, acknowledged: ["esign"] } })).rejects.toThrow(/acknowledgements/);
    await expect(createDelegation(w.store, w.root, { ...base, acceptance: { ...ok, viewed: ["privacy"] } })).rejects.toThrow(/rendered in full/);
    await expect(createDelegation(w.store, w.root, { ...base, acceptance: { ...ok, copies_sent_to: undefined } })).rejects.toThrow(/retained copy/);
    await expect(createDelegation(w.store, w.root, { ...base, scopes: ["payments:initiate"], acceptance: ok })).rejects.toThrow(/not in the terms/);
    // policy changes after terms were created
    await setPolicy(w.store, w.root, { origin: ORIGIN, scopes: ["accounts:read", "transactions:read"] });
    await expect(createDelegation(w.store, w.root, { ...base, acceptance: ok })).rejects.toThrow(/policy .* changed/);
    // site-only bundle
    await setPolicy(w.store, w.root, { origin: ORIGIN, scopes: ["accounts:read", "transactions:read"], disclosures: { ...w.bundle, presentation: "site" } });
    const t2 = await makeTerms(w, ["accounts:read"]);
    await expect(createDelegation(w.store, w.root, { ...base, terms: t2.id, acceptance: { ...ok, terms: t2.id } })).rejects.toThrow(/completed on the site/);
  });
});
