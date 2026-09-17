import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, importJWK, SignJWT } from "jose";
import { issueCredential, presentCredential, VC_CONTEXT } from "../src/lib/credentials.ts";
import { generateKeyFile, type KeyFile } from "../src/lib/keys.ts";
import { Store } from "../src/lib/store.ts";
import { TYP, decode, sign } from "../src/lib/jwt.ts";
import type { PolicyClaims } from "../src/types.ts";
import { Aap } from "../src/sdk/index.ts";
import { createApp } from "../src/server/app.ts";
import type { CredentialPolicy, CredentialVerification, DelegationObject } from "../src/types.ts";

const ORIGIN = "bank.example";
const SUBJECT = "urn:uuid:bdc85448-f06d-4522-afeb-d9e411910ea1";
const context = {
  EmailControlCredential: "https://example.org/credentials/v1/EmailControlCredential",
  email: "https://schema.org/email", verified: "https://example.org/credentials/v1/verified",
  method: "https://example.org/credentials/v1/method", checkedAt: "https://example.org/credentials/v1/checkedAt",
};
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function setup(issuer = "https://identity.example") {
  const dir = await mkdtemp(join(tmpdir(), "aap-vc-")); dirs.push(dir);
  const store = new Store(dir);
  let app = await createApp(store);
  const client = (key: string | null) => new Aap(key, { apiBase: "http://aap.test", fetch: ((url: string | URL | Request, init?: RequestInit) => app.fetch(new Request(url, init))) as typeof fetch });
  const anon = client(null);
  const o = await anon.accounts.create({ type: "operator", name: "Assistant company" });
  const operator = client(o.keys.test); operator.keys.operator = anon.keys.operator;
  const s = await anon.accounts.create({ type: "site", name: "Institution" });
  const site = client(s.keys.test);
  const other = client((await anon.accounts.create({ type: "site", name: "Other institution" })).keys.test);
  const issuerKey = await generateKeyFile();
  const credentials: CredentialPolicy = { types: ["EmailControlCredential"], issuers: [issuer], claims: ["email", "verified", "method"], trust: [
    { issuer, type: "EmailControlCredential", key: issuerKey.public as never, context, claims: { verified: true, method: "email_link" }, max_age_s: 600 },
  ] };
  const policy = { origin: ORIGIN, tier: "read", evidence: { read: "presented" }, credentials };
  await site.policies.create(policy);
  const agent = await operator.agents.create({ name: "Assistant", ceiling: { scopes: ["accounts:read"], constraints: {} } });
  const terms = await operator.terms.create({ agent: agent.id, origin: ORIGIN });
  const delegation = await operator.delegations.create({ agent: agent.id, origin: ORIGIN, subject: "application_42", terms: terms.id,
    acceptance: { terms: terms.id, acknowledged: [], viewed: [], channel: "test", accepted_at: new Date().toISOString() } });
  const request = () => site.credentialVerifications.create({ delegation: delegation.id, credential_subject: SUBJECT });
  const body = () => { const n = Math.floor(Date.now() / 1000); return {
    "@context": [VC_CONTEXT, context], id: `urn:uuid:${crypto.randomUUID()}`, type: ["VerifiableCredential", "EmailControlCredential"], issuer,
    validFrom: new Date(n * 1000).toISOString(), validUntil: new Date((n + 600) * 1000).toISOString(),
    credentialSubject: { id: SUBJECT, email: "user@example.net", verified: true, method: "email_link", checkedAt: new Date(n * 1000).toISOString() },
  }; };
  const signed = async (v: CredentialVerification) => presentCredential(await issueCredential(body(), issuerKey), v, issuerKey);
  const bind = async (d: DelegationObject = delegation) => {
    const ch = await operator.test.challenges.create({ origin: ORIGIN });
    const { grant } = await operator.grants.sign({ delegation: d, challenge: ch.jwt, sessionRef: crypto.randomUUID() });
    const header = await operator.presentations.build({ grant, delegation: d });
    return operator.test.presentations.create({ origin: ORIGIN, header });
  };
  return { dir, store, app, site, operator, other, issuerKey, credentials, policy, body, request, signed, bind, delegation,
    live: client(s.keys.live), restart: async () => { app = await createApp(new Store(dir)); } };
}

async function rawSign(body: object, key: KeyFile, typ: string, extra: object = {}) {
  return new SignJWT(body as never).setProtectedHeader({ alg: "ES256", typ, kid: key.kid, ...extra }).sign(await importJWK(key.private, "ES256"));
}

describe("optional W3C business credentials", () => {
  for (const issuer of ["https://identity.example", "https://assistant.example"]) {
    test(`end to end: ${issuer}, required only by institution policy`, async () => {
      const w = await setup(issuer);
      expect((await w.bind()).plane).toBe("bot");
      const req = await w.request();
      const vp = await w.signed(req);
      const accepted = await w.site.credentialVerifications.complete(req.id, { presentation: vp });
      expect(accepted.status).toBe("verified");
      expect(accepted.evidence?.holder_bound).toBe(false);
      expect(accepted.evidence?.claims).toEqual({});
      await w.restart(); // Disk persistence, not a process-local allow cache.
      const bound = await w.bind();
      expect(bound.plane).toBe("agent");
      expect((await w.site.test.sessions.use(bound.id, { scope: "accounts:read" })).plane).toBe("agent");
      const serialized = JSON.stringify([bound, accepted, await w.operator.delegations.retrieve(w.delegation.id, { expand: ["record"] }), await w.site.events.list(), w.app.logs()]);
      expect(serialized).not.toContain("user@example.net");
      expect(serialized).not.toContain(vp);
      expect(await Bun.file(join(w.dir, "test", "credential_verifications", `${req.id}.json`)).text()).not.toContain("user@example.net");
      const events = (await w.site.events.list({ type: "credential_verification.verified" })).data;
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(SUBJECT);
      expect(JSON.stringify(events)).not.toContain(req.nonce);
      expect((await w.operator.events.list({ type: "credential_verification.verified" })).data).toHaveLength(0);
      await expect(w.other.events.retrieve(events[0]!.id)).rejects.toThrow();
      await w.site.credentialVerifications.revoke(req.id);
      expect((await w.site.test.sessions.use(bound.id, { scope: "accounts:read" })).plane).toBe("bot");
      expect((await w.bind()).plane).toBe("bot");
      // Turning off the requirement restores the baseline protocol, no attestation required.
      await w.site.policies.create({ origin: ORIGIN, tier: "read" });
      expect((await w.bind()).plane).toBe("agent");
    });
  }

  test("verification is opt-in even when an acceptance policy is configured", async () => {
    const w = await setup();
    await w.site.policies.create({ ...w.policy, evidence: { read: "asserted" } });
    expect((await w.bind()).plane).toBe("agent");
  });

  test("one-use request, concurrent completion, safe idempotency retry, and isolation", async () => {
    const w = await setup(), req = await w.request();
    const vp = await w.signed(req);
    for (const client of [w.operator, w.other, w.live]) {
      await expect(client.credentialVerifications.retrieve(req.id)).rejects.toThrow();
      await expect(client.credentialVerifications.complete(req.id, { presentation: vp })).rejects.toThrow();
      await expect(client.credentialVerifications.revoke(req.id)).rejects.toThrow();
    }
    await expect(w.other.credentialVerifications.create({ delegation: w.delegation.id, credential_subject: SUBJECT })).rejects.toThrow();
    const outcomes = await Promise.allSettled([1, 2].map(i => w.site.credentialVerifications.complete(req.id, { presentation: vp }, { idempotencyKey: `finish-${i}` })));
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const winner = outcomes.findIndex(r => r.status === "fulfilled") + 1;
    expect((await w.site.credentialVerifications.complete(req.id, { presentation: vp }, { idempotencyKey: `finish-${winner}` })).status).toBe("verified");
    await expect(w.site.credentialVerifications.complete(req.id, { presentation: vp })).rejects.toThrow();
    const next = await w.request();
    await expect(w.site.credentialVerifications.complete(next.id, { presentation: vp })).rejects.toThrow();
    // Failed attempts do not consume the legitimate request.
    expect((await w.site.credentialVerifications.complete(next.id, { presentation: await w.signed(next) })).status).toBe("verified");
  });

  test("expiry, policy changes, and delegation revocation are rechecked", async () => {
    const w = await setup();
    const req = await w.request();
    const vp = await w.signed(req);
    await w.site.policies.create(w.policy);
    await expect(w.site.credentialVerifications.complete(req.id, { presentation: vp })).rejects.toThrow();
    const fresh = await w.request();
    await w.site.credentialVerifications.complete(fresh.id, { presentation: await w.signed(fresh) });
    const bound = await w.bind();
    const v = (await w.store.getCredentialVerification(fresh.id))!;
    v.evidence!.expires_at = Date.now() / 1000 - 1;
    await w.store.putCredentialVerification(v);
    expect((await w.site.test.sessions.use(bound.id, { scope: "accounts:read" })).plane).toBe("bot");
    expect((await w.bind()).plane).toBe("bot");
    const expired = await w.request();
    const expiredVp = await w.signed(expired);
    await w.store.putCredentialVerification({ ...expired, expires_at: 1 });
    await expect(w.site.credentialVerifications.complete(expired.id, { presentation: expiredVp })).rejects.toThrow();
    const revoked = await w.request();
    await w.operator.delegations.revoke(w.delegation.id);
    await expect(w.site.credentialVerifications.complete(revoked.id, { presentation: await w.signed(revoked) })).rejects.toThrow();
  });

  test("concurrent identical idempotency keys cannot poison the successful completion", async () => {
    const w = await setup(), req = await w.request(), presentation = await w.signed(req);
    await Promise.allSettled([1, 2].map(() => w.site.credentialVerifications.complete(req.id, { presentation }, { idempotencyKey: "same-request" })));
    expect((await w.site.credentialVerifications.complete(req.id, { presentation }, { idempotencyKey: "same-request" })).status).toBe("verified");
  });

  test("a held request lock fails closed and is retryable after release", async () => {
    const w = await setup(), req = await w.request(), presentation = await w.signed(req);
    let unlock!: () => void;
    let ready!: () => void;
    const started = new Promise<void>(r => { ready = r; });
    const waiting = new Promise<void>(r => { unlock = r; });
    const writer = w.store.withCredentialLock(req.id, async () => { ready(); await waiting; });
    await started;
    try {
      await expect(w.site.credentialVerifications.complete(req.id, { presentation }, { idempotencyKey: "retry-lock" })).rejects.toMatchObject({ code: "credential_busy", status: 409 });
      expect((await w.site.credentialVerifications.retrieve(req.id)).status).toBe("pending");
      expect((await w.bind()).plane).toBe("bot");
    } finally { unlock(); await writer; }
    expect((await w.site.credentialVerifications.complete(req.id, { presentation }, { idempotencyKey: "retry-lock" })).status).toBe("verified");
  });

  test("mixed-tier grants cannot bypass a lower tier's credential requirement", async () => {
    const w = await setup();
    await w.site.policies.create({ ...w.policy, tier: "transact", evidence: { read: "presented", transact: "asserted" } });
    const agent = await w.operator.agents.create({ name: "Mixed", ceiling: { scopes: ["accounts:read", "payments:initiate"], constraints: {} } });
    const terms = await w.operator.terms.create({ agent: agent.id, origin: ORIGIN });
    const d = await w.operator.delegations.create({ agent: agent.id, origin: ORIGIN, subject: "application_42", terms: terms.id,
      acceptance: { terms: terms.id, acknowledged: [], viewed: [], channel: "test", accepted_at: new Date().toISOString() } });
    expect((await w.bind(d)).plane).toBe("bot");
  });

  test("a changed trust policy invalidates previously accepted evidence", async () => {
    const w = await setup(), req = await w.request();
    await w.site.credentialVerifications.complete(req.id, { presentation: await w.signed(req) });
    const s = await w.bind();
    await w.site.policies.create(w.policy);
    expect((await w.site.test.sessions.use(s.id, { scope: "accounts:read" })).plane).toBe("bot");
    expect((await w.bind()).plane).toBe("bot");
  });

  test("exact policy binding survives a reference-store version collision", async () => {
    const w = await setup(), req = await w.request(), pending = await w.request();
    const vp = await w.signed(pending);
    await w.site.credentialVerifications.complete(req.id, { presentation: await w.signed(req) });
    const p = (await w.store.getPolicy(ORIGIN))!;
    const claims = decode<PolicyClaims>(p.statement).claims;
    claims.credentials!.trust![0]!.claims.method = "stricter_method";
    // Model two policy writes receiving the same version, without changing that version.
    p.statement = await sign(claims as never, w.app.root.private, TYP.policy);
    await w.store.putPolicy(p);
    await expect(w.site.credentialVerifications.complete(pending.id, { presentation: vp })).rejects.toThrow();
    expect((await w.bind()).plane).toBe("bot");
  });

  test("verification cannot be transferred to another delegation", async () => {
    const w = await setup(), req = await w.request();
    await w.site.credentialVerifications.complete(req.id, { presentation: await w.signed(req) });
    const d = await w.operator.delegations.create({ agent: w.delegation.agent, origin: ORIGIN, subject: "another-applicant", terms: w.delegation.terms,
      acceptance: { terms: w.delegation.terms, acknowledged: [], viewed: [], channel: "test", accepted_at: new Date().toISOString() } });
    expect((await w.bind(d)).plane).toBe("bot");
  });

  test("rejects forged VC/VPs, wrong audience, subject, nonce, method, claims, context, and unsupported status", async () => {
    const w = await setup(), req = await w.request();
    const vp = decodeJwt(await w.signed(req));
    const badKey = await generateKeyFile();
    const badBodies: Record<string, unknown>[] = [];
    const mutate = (f: (b: ReturnType<typeof w.body>) => void) => { const b = w.body(); f(b); badBodies.push(b); };
    mutate(b => { b.credentialSubject.id = "urn:uuid:someone-else"; });
    mutate(b => { b.credentialSubject.verified = false; });
    mutate(b => { b.credentialSubject.method = "self_reported"; });
    mutate(b => { delete (b.credentialSubject as Record<string, unknown>).email; });
    mutate(b => { b.issuer = "https://untrusted.example"; });
    mutate(b => { b.credentialSubject.checkedAt = new Date(Date.now() - 700_000).toISOString(); });
    mutate(b => { b.validUntil = new Date(Date.now() - 1000).toISOString(); });
    mutate(b => { b.validUntil = new Date(Date.now() + 7200_000).toISOString(); });
    mutate(b => { b.validFrom = "2026-02-30T00:00:00Z"; });
    mutate(b => { b["@context"] = [VC_CONTEXT, { ...context, email: "https://attacker.example/different" }]; });
    badBodies.push({ ...w.body(), credentialStatus: { id: "https://status.example/1", type: "BitstringStatusListEntry" } });
    const denied: string[] = [];
    for (const b of badBodies) {
      const vc = await rawSign(b, w.issuerKey, "vc+jwt");
      denied.push(await rawSign({ ...vp, verifiableCredential: [{ "@context": [VC_CONTEXT], type: ["EnvelopedVerifiableCredential"], id: "data:application/vc+jwt," + vc }] }, w.issuerKey, "vp+jwt"));
    }
    denied.push(await rawSign({ ...vp, aud: "https://other.example" }, w.issuerKey, "vp+jwt"));
    denied.push(await rawSign({ ...vp, nonce: crypto.randomUUID() }, w.issuerKey, "vp+jwt"));
    denied.push(await rawSign({ ...vp, exp: Math.floor(Date.now() / 1000) - 1 }, w.issuerKey, "vp+jwt"));
    denied.push(await rawSign(vp, badKey, "vp+jwt", { kid: w.issuerKey.kid }));
    denied.push(await rawSign(vp, w.issuerKey, "JWT"));
    denied.push(await rawSign(vp, w.issuerKey, "vp+jwt", { jku: "http://127.0.0.1/private" }));
    const badVc = await rawSign(w.body(), badKey, "vc+jwt", { kid: w.issuerKey.kid });
    denied.push(await rawSign({ ...vp, verifiableCredential: [{ "@context": [VC_CONTEXT], type: ["EnvelopedVerifiableCredential"], id: "data:application/vc+jwt," + badVc }] }, w.issuerKey, "vp+jwt"));
    denied.push("garbage", "a".repeat(33_000));
    for (const presentation of denied) await expect(w.site.credentialVerifications.complete(req.id, { presentation })).rejects.toThrow();
    expect((await w.site.credentialVerifications.retrieve(req.id)).status).toBe("pending");
    expect((await w.bind()).plane).toBe("bot");
  });

  test("policy validation rejects private keys, weak algorithms, and unsafe vocabulary", async () => {
    const w = await setup();
    for (const mutate of [
      (p: CredentialPolicy) => { p.trust![0]!.key = w.issuerKey.private as never; },
      (p: CredentialPolicy) => { p.trust![0]!.max_age_s = 86400; },
      (p: CredentialPolicy) => { p.trust![0]!.context.id = "https://evil.example/id"; },
      (p: CredentialPolicy) => { p.trust![0]!.issuer = "https://other.example"; },
      (p: CredentialPolicy) => { p.trust![0]!.key.alg = "HS256"; },
    ]) {
      const p = structuredClone(w.credentials); mutate(p);
      await expect(w.site.policies.create({ ...w.policy, credentials: p })).rejects.toThrow();
    }
  });

  test("offline CLI signs standard tokens without exposing them or overwriting files", async () => {
    const w = await setup(), req = await w.request();
    const key = join(w.dir, "issuer.json"), body = join(w.dir, "body.json"), request = join(w.dir, "request.json");
    await Bun.write(key, JSON.stringify(w.issuerKey)); await Bun.write(body, JSON.stringify(w.body())); await Bun.write(request, JSON.stringify(req));
    const vc = join(w.dir, "vc.jwt"), vp = join(w.dir, "vp.jwt");
    const run = async (args: string[]) => {
      const p = Bun.spawn([process.execPath, "src/cli.ts", ...args], { stdout: "pipe", stderr: "pipe" });
      return { code: await p.exited, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() };
    };
    const issue = ["credentials", "issue", "--key", key, "--body", "@" + body, "--out", vc];
    const generated = join(w.dir, "new-issuer.json");
    expect((await run(["keys", "generate", "--out", generated])).code).toBe(0);
    expect((await stat(generated)).mode & 0o777).toBe(0o600);
    expect((await run(["keys", "generate", "--out", generated])).code).toBe(1);
    const first = await run(issue); expect(first.code).toBe(0); expect(first.stdout).not.toContain("user@example.net");
    expect((await stat(vc)).mode & 0o777).toBe(0o600);
    const original = await Bun.file(vc).text();
    expect((await run(issue)).code).toBe(1); expect(await Bun.file(vc).text()).toBe(original);
    const present = await run(["credentials", "present", "--key", key, "--credential", vc, "--request", request, "--out", vp]);
    expect(present.code).toBe(0); expect((await stat(vp)).mode & 0o777).toBe(0o600);
    expect((await w.site.credentialVerifications.complete(req.id, { presentation: await Bun.file(vp).text() })).status).toBe("verified");
  });

  for (const mode of [[], ["--first-party"]]) {
    test(`complete CLI walkthrough ${mode[0] ?? "specialist"}`, async () => {
      const p = Bun.spawn([process.execPath, "examples/credentials.ts", ...mode], { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout.match(/PASS:/g)).toHaveLength(4);
    }, 15_000);
  }
});
