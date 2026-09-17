import { afterAll, describe, expect, test } from "bun:test";
import { ORIGIN, makeDelegation, makePresentation, makeWorld, verifyAt } from "./world.ts";
import { loadPolicy, setPolicy } from "../src/lib/policy.ts";
import type { AgentBlock } from "../src/types.ts";

describe("optional credential compatibility", () => {
  const worlds: Awaited<ReturnType<typeof makeWorld>>[] = [];
  afterAll(async () => { for (const w of worlds) await w.store.destroy(); });

  test("a delegation names its issuer and carries an empty presented block", async () => {
    const w = await makeWorld(); worlds.push(w);
    const dl = await makeDelegation(w);
    expect(dl.claims.issuer).toBe("foil");
    expect(dl.stored.issuer).toBe("foil");
    expect(dl.claims.record.presented).toBeNull();
    const r = await verifyAt(w, await makePresentation(w, dl));
    const block = r.session.agent as AgentBlock;
    expect(block.delegation.issuer).toBe("foil");
    expect(block.delegation.presented).toBeNull();
  });

  test("a policy carries no credential requirements by default and round-trips them when set", async () => {
    const w = await makeWorld(); worlds.push(w);
    expect((await loadPolicy(w.store, w.root, ORIGIN))!.credentials).toBeNull();
    await setPolicy(w.store, w.root, { origin: ORIGIN, tier: "read", credentials: { types: ["mdl"], issuers: ["dmv.ca.gov"], claims: ["age_over_18"] } });
    expect((await loadPolicy(w.store, w.root, ORIGIN))!.credentials).toEqual({ types: ["mdl"], issuers: ["dmv.ca.gov"], claims: ["age_over_18"] });
  });

  test("a tier that requires presented evidence is refused until a presentation exists", async () => {
    const w = await makeWorld({ evidence: { read: "asserted", transact: "presented" } }); worlds.push(w);
    const dl = await makeDelegation(w);
    expect((( await verifyAt(w, await makePresentation(w, dl))).session.agent as { reason?: string }).reason).toBe("evidence_insufficient");
    expect((await verifyAt(w, await makePresentation(w, dl, { scopes: ["accounts:read"] }), "sess_read")).statusHeader).toBe("Foil-Agent-Status: bound");
  });
});
