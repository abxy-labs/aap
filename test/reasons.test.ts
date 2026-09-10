import { afterAll, describe, expect, test } from "bun:test";
import { ORIGIN, makeDelegation, makePresentation, makeWorld, verifyAt } from "./world.ts";
import { useScope } from "../src/lib/session.ts";
import { revokeDelegation, createDelegation } from "../src/lib/delegation.ts";
import { setPolicy, loadPolicy } from "../src/lib/policy.ts";
import { generateKeyFile } from "../src/lib/keys.ts";
import { signGrant } from "../src/lib/grant.ts";
import { computeTerms } from "../src/lib/terms.ts";
import { issueAgent } from "../src/lib/certs.ts";

function reason(r: { session: { agent: unknown } }): string | undefined {
  return (r.session.agent as { reason?: string } | null)?.reason;
}

describe("downgrade reasons", () => {
  const worlds: Awaited<ReturnType<typeof makeWorld>>[] = [];
  afterAll(async () => { for (const w of worlds) await w.store.destroy(); });

  test("chain_invalid: grant signed by a key that is not the agent's", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    const other = await generateKeyFile();
    const r = await verifyAt(w, await makePresentation(w, dl, { agentKey: other }));
    expect(r.statusHeader).toBe("Foil-Agent-Status: downgraded; reason=chain_invalid");
    expect(r.session.decision.plane).toBe("bot");
  });

  test("chain_invalid: delegation for a different origin", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    const header = await makePresentation(w, dl);
    const r = await (await import("../src/lib/verify.ts")).verifyPresentation(w.store, w.root, { header, origin: "other.example", sessionId: "s", asn: "AS1" });
    expect(reason(r)).toBe("chain_invalid");
  });

  test("challenge_invalid: grant signed over a nonce Foil never issued", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    const r = await verifyAt(w, await makePresentation(w, dl, { nonce: "deadbeef" }));
    expect(reason(r)).toBe("challenge_invalid");
  });

  test("delegation_revoked", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    await revokeDelegation(w.store, dl.claims.sub, "consumer");
    const r = await verifyAt(w, await makePresentation(w, dl));
    expect(reason(r)).toBe("delegation_revoked");
  });

  test("delegation_expired", async () => {
    const w = await makeWorld({ maxAgeS: 60 }); worlds.push(w);
    const dl = await makeDelegation(w, { now: new Date(Date.now() - 120_000) });
    const r = await verifyAt(w, await makePresentation(w, dl));
    expect(reason(r)).toBe("delegation_expired");
  });

  test("policy_denied: agent denied by name, then origin closed", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    await setPolicy(w.store, w.root, { origin: ORIGIN, tier: "transact", denyAgents: ["ag_test"], evidence: { transact: "observed" } });
    const r = await verifyAt(w, await makePresentation(w, dl));
    expect(reason(r)).toBe("policy_denied");
    await setPolicy(w.store, w.root, { origin: ORIGIN, tier: "none" });
    const r2 = await verifyAt(w, await makePresentation(w, dl, { nonce: "x" }), "fs_b");
    // no challenge can be issued for a closed origin, so the nonce is invalid before policy is reached
    expect(reason(r2)).toBe("challenge_invalid");
  });

  test("grant_replayed: the second session is refused and the first is downgraded", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    const header = await makePresentation(w, dl);
    const first = await verifyAt(w, header, "fs_one");
    expect(first.session.decision.plane).toBe("agent");
    const second = await verifyAt(w, header, "fs_two");
    expect(reason(second)).toBe("grant_replayed");
    const one = (await w.store.getSession("fs_one"))!;
    expect(one.decision.plane).toBe("bot");
    expect(reason({ session: one })).toBe("grant_replayed");
  });

  test("operator_mismatch: session network outside the operator profile", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    const r = await verifyAt(w, await makePresentation(w, dl), "fs", { asn: "AS999" });
    expect(reason(r)).toBe("operator_mismatch");
  });

  test("scope_violation: exercising a scope outside the grant", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    await verifyAt(w, await makePresentation(w, dl, { scopes: ["accounts:read"] }));
    const r = await useScope(w.store, w.root, "fs_agent", "payments:initiate");
    expect(r.statusHeader).toBe("Foil-Agent-Status: downgraded; reason=scope_violation");
    expect(r.session.decision.plane).toBe("bot");
  });

  test("evidence_insufficient: transact tier requires an observed link", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w, { siteSession: null });
    expect(dl.claims.record.observed).toBeNull();
    const r = await verifyAt(w, await makePresentation(w, dl));
    expect(reason(r)).toBe("evidence_insufficient");
    // read tier on the same delegation is fine
    const r2 = await verifyAt(w, await makePresentation(w, dl, { scopes: ["accounts:read"] }), "fs_read");
    expect(r2.statusHeader).toBe("Foil-Agent-Status: bound");
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

  test("delegation creation checks the terms etag, acknowledgements, viewed documents, and site-only bundles", async () => {
    const w = await makeWorld(); worlds.push(w);
    const policy = (await loadPolicy(w.store, w.root, ORIGIN))!;
    const { etag } = computeTerms(w.agent, policy, ["accounts:read"]);
    const base = { agent: w.agent, operator: w.operator, origin: ORIGIN, subject: "u", scopes: ["accounts:read"], intent: "i" };
    const ok = { terms: etag, acknowledged: ["esign", "share"], viewed: ["esign", "privacy"], channel: "c", accepted_at: "now", copies_sent_to: "email" };
    await expect(createDelegation(w.store, w.root, { ...base, acceptance: { ...ok, terms: "t_stale" } })).rejects.toThrow(/terms/);
    await expect(createDelegation(w.store, w.root, { ...base, acceptance: { ...ok, acknowledged: ["esign"] } })).rejects.toThrow(/acknowledgements/);
    await expect(createDelegation(w.store, w.root, { ...base, acceptance: { ...ok, viewed: ["privacy"] } })).rejects.toThrow(/rendered in full/);
    await expect(createDelegation(w.store, w.root, { ...base, acceptance: { ...ok, copies_sent_to: undefined } })).rejects.toThrow(/retained copy/);
    await setPolicy(w.store, w.root, { origin: ORIGIN, tier: "read", disclosures: { ...w.bundle, presentation: "site" } });
    const p2 = (await loadPolicy(w.store, w.root, ORIGIN))!;
    const t2 = computeTerms(w.agent, p2, ["accounts:read"]);
    await expect(createDelegation(w.store, w.root, { ...base, acceptance: { ...ok, terms: t2.etag } })).rejects.toThrow(/completed on the site/);
  });
});
