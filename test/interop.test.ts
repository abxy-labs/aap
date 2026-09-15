import { afterAll, describe, expect, test } from "bun:test";
import { makeDelegation, makePresentation, makeWorld, verifyAt } from "./world.ts";
import { generateKeyFile, algOf, readKeyFile } from "../src/lib/keys.ts";
import { issueOperator, verifyOperator } from "../src/lib/certs.ts";
import { decode } from "../src/lib/jwt.ts";
import type { AgentBlock } from "../src/types.ts";

describe("interoperability", () => {
  const worlds: Awaited<ReturnType<typeof makeWorld>>[] = [];
  afterAll(async () => { for (const w of worlds) await w.store.destroy(); });

  test("Ed25519 keys sign and verify the whole chain", async () => {
    const w = await makeWorld({}, { alg: "EdDSA" }); worlds.push(w);
    expect(w.agentKey.public.kty).toBe("OKP");
    const dl = await makeDelegation(w);
    const header = await makePresentation(w, dl);
    expect(decode(header.split(";")[0]!).header.alg).toBe("EdDSA");
    const r = await verifyAt(w, header);
    expect(r.statusHeader).toBe("Foil-Agent-Status: bound");
    expect((r.session.agent as AgentBlock).scopes).toEqual(["accounts:read", "payments:initiate"]);
  });

  test("a chain can mix key algorithms", async () => {
    const w = await makeWorld({}, { alg: "EdDSA", agentAlg: "ES256" }); worlds.push(w);
    const dl = await makeDelegation(w);
    expect((await verifyAt(w, await makePresentation(w, dl))).statusHeader).toBe("Foil-Agent-Status: bound");
  });

  test("algOf recognizes both key types and rejects others", async () => {
    expect(algOf((await generateKeyFile("ES256")).public)).toBe("ES256");
    expect(algOf((await generateKeyFile("EdDSA")).public)).toBe("EdDSA");
    expect(() => algOf({ kty: "RSA", n: "x", e: "AQAB" })).toThrow(/unsupported/);
  });

  test("operator certificates carry third-party attestations", async () => {
    const w = await makeWorld(); worlds.push(w);
    const key = await generateKeyFile("EdDSA");
    const jwt = await issueOperator(w.root, { id: "op_att", key: key.public, vetting: "standard", sessionHandling: "test", attestations: [{ type: "kya", issuer: "network.example", ref: "kya_7f3a" }] });
    expect((await verifyOperator(jwt, w.root.public)).attestations).toEqual([{ type: "kya", issuer: "network.example", ref: "kya_7f3a" }]);
  });

  test("a bare private JWK file is read with its algorithm inferred", async () => {
    const w = await makeWorld(); worlds.push(w);
    const kf = await generateKeyFile("EdDSA");
    const path = `${w.store.dir}/bare.json`;
    await Bun.write(path, JSON.stringify(kf.private));
    const read = await readKeyFile(path);
    expect(read.alg).toBe("EdDSA");
    expect(read.public.d).toBeUndefined();
  });
});
