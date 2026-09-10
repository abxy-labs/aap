import { afterAll, describe, expect, test } from "bun:test";
import { ORIGIN, makeDelegation, makePresentation, makeWorld, verifyAt } from "./world.ts";
import { completeHandoff, useScope, verifyResponse } from "../src/lib/session.ts";
import { directory, hashOrigin } from "../src/lib/directory.ts";
import { computeTerms } from "../src/lib/terms.ts";
import { loadPolicy, setPolicy } from "../src/lib/policy.ts";
import { issueChallenge } from "../src/lib/challenge.ts";
import type { AgentBlock } from "../src/types.ts";

describe("lifecycle", () => {
  const worlds: Awaited<ReturnType<typeof makeWorld>>[] = [];
  afterAll(async () => { for (const w of worlds) await w.store.destroy(); });

  test("terms are intersected and carry plain-language strings", async () => {
    const w = await makeWorld(); worlds.push(w);
    const policy = (await loadPolicy(w.store, w.root, ORIGIN))!;
    const { terms, etag } = computeTerms(w.agent, policy, ["accounts:read", "payments:initiate", "transfers:initiate"]);
    expect(terms.scopes.map((s) => s.id)).toEqual(["accounts:read", "payments:initiate"]);
    expect(terms.constraints.max_amount).toEqual({ value: 200, currency: "USD" });
    expect(terms.constraints.payees).toBe("existing_only");
    expect(terms.scopes[1]!.text).toContain("$200");
    expect(terms.disclosures!.acknowledgements[1]!.text).toContain("test-agent");
    expect(etag).toMatch(/^t_[0-9a-f]{8}$/);
  });

  test("full flow binds a session and the site reads the agent block", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    expect(dl.claims.scopes).toEqual(["accounts:read", "payments:initiate"]);
    expect(dl.claims.record.observed?.human).toBe(true);
    const header = await makePresentation(w, dl);
    const r = await verifyAt(w, header);
    expect(r.statusHeader).toBe("Foil-Agent-Status: bound");
    expect(r.session.decision).toEqual({ verdict: "allow", plane: "agent" });
    const block = r.session.agent as AgentBlock;
    expect(block.id).toBe("ag_test");
    expect(block.operator).toBe("op_test");
    expect(block.scopes).toEqual(["accounts:read", "payments:initiate"]);
    expect(block.constraints.max_amount).toEqual({ value: 200, currency: "USD" });
    expect(block.delegation.policy_version).toBe(1);
    expect(block.delegation.observed?.site_session).toBe("fs_human");
    expect(r.handoffScopes).toEqual(["payments:initiate"]);
    const resp = verifyResponse((await w.store.getSession("fs_agent"))!) as { decision: unknown };
    expect(resp.decision).toEqual({ verdict: "allow", plane: "agent" });
  });

  test("scopes used are recorded and handoff scopes route to the consumer", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    await verifyAt(w, await makePresentation(w, dl));
    const r1 = await useScope(w.store, w.root, "fs_agent", "accounts:read");
    expect(r1.statusHeader).toBe("Foil-Agent-Status: bound");
    expect((r1.session.agent as AgentBlock).scopes_used).toEqual(["accounts:read"]);
    const r2 = await useScope(w.store, w.root, "fs_agent", "payments:initiate");
    expect(r2.handoffHeader).toBe("Foil-Agent-Handoff: required; scope=payments:initiate");
    expect((r2.session.agent as AgentBlock).handoff).toBe("payments:initiate");
    const done = await completeHandoff(w.store, "fs_agent", "payments:initiate");
    expect((done.agent as AgentBlock).handoff).toBeNull();
    expect((done.agent as AgentBlock).delegation.observed?.handoffs).toEqual(["payments:initiate"]);
  });

  test("a grant may narrow the delegation and the policy is re-applied at bind", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    const header = await makePresentation(w, dl, { scopes: ["accounts:read"] });
    const r = await verifyAt(w, header);
    expect((r.session.agent as AgentBlock).scopes).toEqual(["accounts:read"]);
    // tighten the policy: a later presentation of the full delegation is narrowed
    await setPolicy(w.store, w.root, { origin: ORIGIN, tier: "read", evidence: { read: "asserted" } });
    const r2 = await verifyAt(w, await makePresentation(w, dl), "fs_agent2");
    expect(r2.statusHeader).toBe("Foil-Agent-Status: bound");
    expect((r2.session.agent as AgentBlock).scopes).toEqual(["accounts:read"]);
    expect(r2.narrowed).toEqual(["payments:initiate"]);
    expect((r2.session.agent as AgentBlock).id).toBeUndefined();
  });

  test("a presentation without the chain works once Foil has seen it", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    await verifyAt(w, await makePresentation(w, dl), "fs_first");
    const r = await verifyAt(w, await makePresentation(w, dl, { fullChain: false }), "fs_second");
    expect(r.statusHeader).toBe("Foil-Agent-Status: bound");
  });

  test("challenges are only issued for participating origins and the directory hashes them", async () => {
    const w = await makeWorld(); worlds.push(w);
    expect(await issueChallenge(w.store, w.root, "other.example")).toBeNull();
    await setPolicy(w.store, w.root, { origin: "closed.example", tier: "none" });
    expect(await issueChallenge(w.store, w.root, "closed.example")).toBeNull();
    const d = await directory(w.store, w.root);
    expect(d.hashed_origins).toEqual([hashOrigin(ORIGIN)]);
  });
});
