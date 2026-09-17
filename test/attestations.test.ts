import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_BUNDLE } from "../src/cli/demo.ts";
import { generateKeyFile, type KeyFile } from "../src/lib/keys.ts";
import { Store, id } from "../src/lib/store.ts";
import { Aap, AapError, credentialBody, issueCredential } from "../src/sdk/index.ts";
import { createApp, type App } from "../src/server/app.ts";
import type { AgentBlock, AgentObject, DelegationObject } from "../src/types.ts";

const ORIGIN = "bank.example";
const PROVIDER = "https://identity.example";

let app: App;
let store: Store;
let anon: Aap;
let operator: Aap;
let site: Aap;
let provider: Aap;
let providerKey: KeyFile;
let agent: AgentObject;

function clientFor(key: string | null): Aap {
  return new Aap(key, { apiBase: "http://aap.test", fetch: ((url: string | URL | Request, init?: RequestInit) => app.fetch(new Request(url, init))) as typeof fetch });
}

/** A site that requires an accepted attestation before read-tier scopes. */
async function setPolicy(extra: Record<string, unknown> = {}) {
  return site.policies.create({
    origin: ORIGIN, tier: "transact",
    constraints: { currency: "usd", max_amount: 20000 },
    disclosures: DEMO_BUNDLE,
    evidence: { read: "attested", transact: "attested" },
    attestations: { issuers: [PROVIDER_ID, "operator"], types: ["EmailControlCredential"], claims: ["email_verified"] },
    disclose: ["operator", "agent"],
    ...extra,
  });
}

let PROVIDER_ID = "";

async function makeDelegation(scopes = ["accounts:read"], attestations?: string[]) {
  const terms = await operator.terms.create({ agent: agent.id, origin: ORIGIN, scopes });
  return operator.delegations.create({
    agent: agent.id, origin: ORIGIN, subject: `usr_${id("s")}`, terms: terms.id, intent: "Check balances",
    acceptance: { terms: terms.id, acknowledged: ["esign", "share"], viewed: ["esign", "privacy"], channel: "test", accepted_at: new Date().toISOString(), copies_sent_to: "email" },
    ...(attestations ? { attestations } : {}),
  });
}

async function providerCredential(d: DelegationObject, claims: Record<string, string | number | boolean> = { email_verified: true, method: "email_link" }, validForS = 86400) {
  return issueCredential(credentialBody({
    issuer: PROVIDER, type: "EmailControlCredential", subject: operator.credentials.subject(d), claims,
    validUntil: new Date(Date.now() + validForS * 1000),
  }), providerKey);
}

async function bind(d: DelegationObject, sessionId?: string) {
  const ch = await operator.test.challenges.create({ origin: ORIGIN });
  const { grant } = await operator.grants.sign({ delegation: d, challenge: ch.jwt, sessionRef: "sess_ref", intent: "Check balances" });
  const header = await operator.presentations.build({ grant, delegation: d });
  return operator.test.presentations.create({ origin: ORIGIN, header, asn: "AS14618", session: sessionId });
}

beforeAll(async () => {
  store = new Store(join(tmpdir(), `aap-att-${id("t")}`));
  app = await createApp(store);
  anon = clientFor(null);
  const op = await anon.accounts.create({ type: "operator", name: "Example Browser Co", asn: ["AS14618"] });
  operator = clientFor(op.keys.test);
  operator.keys.operator = anon.keys.operator;
  const st = await anon.accounts.create({ type: "site", name: "Example Bank" });
  site = clientFor(st.keys.test);
  providerKey = await generateKeyFile();
  const pr = await anon.accounts.create({ type: "issuer", name: "Identity Co", url: PROVIDER, public_keys: [providerKey.public] });
  PROVIDER_ID = pr.issuer!.id;
  provider = clientFor(pr.keys.test);
  agent = await operator.agents.create({ name: "balance-assistant", ceiling: { scopes: ["accounts:read", "transactions:read", "payments:initiate"], constraints: { currency: "usd", max_amount: 50000 } } });
  await setPolicy();
});

afterAll(async () => { await store.destroy(); });

describe("issuers", () => {
  test("an issuer account registers a name, an https identifier, and public keys", async () => {
    const i = await site.issuers.retrieve(PROVIDER_ID);
    expect(i).toMatchObject({ object: "issuer", url: PROVIDER, status: "active" });
    expect(i.public_keys[0]!.kid).toBe(providerKey.kid);
    expect(JSON.stringify(i)).not.toContain('"d"');
    expect((await operator.issuers.list()).data.some((x) => x.id === PROVIDER_ID)).toBe(true);
  });

  test("registration refuses a private key or a non-https identifier", async () => {
    const bad = await anon.accounts.create({ type: "issuer", name: "Bad", url: PROVIDER, public_keys: [providerKey.private] }).then(() => null, (e) => e as AapError);
    expect(bad!.code).toBe("parameter_invalid");
    const worse = await anon.accounts.create({ type: "issuer", name: "Bad", url: "http://identity.example", public_keys: [providerKey.public] }).then(() => null, (e) => e as AapError);
    expect(worse!.param).toBe("url");
  });
});

describe("a provider posts its own attestation", () => {
  test("verified, recorded on the delegation, and enough to bind", async () => {
    const d = await makeDelegation();
    const refused = await bind(d, "sess_none");
    expect(refused.status_header).toBe("Foil-Agent-Status: downgraded; reason=evidence_insufficient");

    const a = await provider.attestations.create(d.id, { credential: await providerCredential(d) });
    expect(a).toMatchObject({ object: "attestation", status: "active", issuer: PROVIDER, type: "EmailControlCredential", submitted_by: "issuer", holder_bound: false });
    expect(a.subject).toBe(operator.credentials.subject(d));
    // Only the claims the site's policy names are kept.
    expect(a.claims).toEqual({ email_verified: true });

    const bound = await bind(d, "sess_ok");
    expect(bound.status_header).toBe("Foil-Agent-Status: bound");
    const block = (await site.sessions.retrieve("sess_ok")).agent as AgentBlock;
    expect(block.delegation.attested[0]).toMatchObject({ attestation: a.id, issuer: PROVIDER, type: "EmailControlCredential", holder_bound: false });
    expect((await site.delegations.retrieve(d.id, { expand: ["record"] }) as unknown as { record: { attested: unknown[] } }).record.attested).toHaveLength(1);
  });

  test("the site and the issuer can revoke; the operator cannot", async () => {
    const d = await makeDelegation();
    const a = await provider.attestations.create(d.id, { credential: await providerCredential(d) });
    await bind(d, "sess_rev");
    expect((await operator.attestations.revoke(a.id).then(() => null, (e) => e as AapError))!.type).toBe("permission_error");
    const revoked = await site.attestations.revoke(a.id);
    expect(revoked).toMatchObject({ status: "revoked", revoked_by: "site" });
    const used = await operator.test.sessions.use("sess_rev", { scope: "accounts:read" });
    expect(used.status).toBe("downgraded");
    expect((used.agent as { reason: string }).reason).toBe("evidence_insufficient");
    expect((await bind(d, "sess_rev2")).status_header).toBe("Foil-Agent-Status: downgraded; reason=evidence_insufficient");
  });
});

describe("an operator passes a credential through", () => {
  test("attached to the delegation it creates, signed by the agent's own key", async () => {
    const d0 = await makeDelegation();
    // The application verified the consumer's email itself and states it under its agent key.
    const credential = await operator.credentials.issueForDelegation(d0, {
      issuer: PROVIDER, type: "EmailControlCredential", claims: { email_verified: true }, validUntil: new Date(Date.now() + 86_400_000),
    });
    // Signed by the agent key but naming the identity provider, so it is checked against that provider's
    // registered keys only, and fails. A credential cannot be signed by one accepted issuer while naming another.
    const wrongIssuer = await operator.attestations.create(d0.id, { credential }).then(() => null, (e) => e as AapError);
    expect(wrongIssuer!.code).toBe("credential_invalid");

    // Naming the agent itself works, because the site's policy admits "operator", which covers its agents.
    const d = await makeDelegation();
    const own = await operator.credentials.issueForDelegation(d, {
      issuer: agent.id, type: "EmailControlCredential", claims: { email_verified: true }, validUntil: new Date(Date.now() + 86_400_000),
    });
    const a = await operator.attestations.create(d.id, { credential: own });
    expect(a).toMatchObject({ submitted_by: "operator", issuer: agent.id });
    expect((await bind(d, "sess_op")).status_header).toBe("Foil-Agent-Status: bound");
  });

  test("attached inline when the delegation is created, and covered by the request signature", async () => {
    const terms = await operator.terms.create({ agent: agent.id, origin: ORIGIN, scopes: ["accounts:read"] });
    const subject = `usr_${id("s")}`;
    const operatorId = (await operator.account.retrieve()).operator!.id;
    const credential = await issueCredential(credentialBody({
      issuer: PROVIDER, type: "EmailControlCredential", subject: `urn:aap:subject:${operatorId}:${subject}`,
      claims: { email_verified: true }, validUntil: new Date(Date.now() + 86_400_000),
    }), providerKey);
    const d = await operator.delegations.create({
      agent: agent.id, origin: ORIGIN, subject, terms: terms.id, intent: "Check balances",
      acceptance: { terms: terms.id, acknowledged: ["esign", "share"], viewed: ["esign", "privacy"], channel: "test", accepted_at: new Date().toISOString(), copies_sent_to: "email" },
      attestations: [credential],
    });
    const listed = await operator.attestations.list({ delegation: d.id });
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]!.submitted_by).toBe("operator");
    expect((await bind(d, "sess_inline")).status_header).toBe("Foil-Agent-Status: bound");
  });
});

describe("what is refused", () => {
  test("a forged signature, an unregistered issuer, and the wrong subject", async () => {
    const d = await makeDelegation();
    const other = await generateKeyFile();
    const forged = await issueCredential(credentialBody({
      issuer: PROVIDER, type: "EmailControlCredential", subject: operator.credentials.subject(d), claims: { email_verified: true }, validUntil: new Date(Date.now() + 3600_000),
    }), other);
    expect((await provider.attestations.create(d.id, { credential: forged }).then(() => null, (e) => e as AapError))!.code).toBe("credential_invalid");

    const stranger = await issueCredential(credentialBody({
      issuer: "https://stranger.example", type: "EmailControlCredential", subject: operator.credentials.subject(d), claims: { email_verified: true }, validUntil: new Date(Date.now() + 3600_000),
    }), providerKey);
    expect((await provider.attestations.create(d.id, { credential: stranger }).then(() => null, (e) => e as AapError))!.code).toBe("issuer_not_accepted");

    const elsewhere = await makeDelegation();
    const mismatched = await providerCredential(elsewhere);
    expect((await provider.attestations.create(d.id, { credential: mismatched }).then(() => null, (e) => e as AapError))!.code).toBe("attestation_subject_mismatch");
  });

  test("a credential signed by one accepted issuer cannot name another", async () => {
    const d = await makeDelegation();
    const operatorId = (await operator.account.retrieve()).operator!.id;
    // Signed with the provider's key, but naming the operator, which the policy also accepts.
    const crossed = await issueCredential(credentialBody({
      issuer: operatorId, type: "EmailControlCredential", subject: operator.credentials.subject(d), claims: { email_verified: true }, validUntil: new Date(Date.now() + 3600_000),
    }), providerKey);
    expect((await provider.attestations.create(d.id, { credential: crossed }).then(() => null, (e) => e as AapError))!.code).toBe("credential_invalid");
  });

  test("a type the site does not accept, a missing claim, and an expired credential", async () => {
    const d = await makeDelegation();
    const wrongType = await issueCredential(credentialBody({
      issuer: PROVIDER, type: "PhoneControlCredential", subject: operator.credentials.subject(d), claims: { email_verified: true }, validUntil: new Date(Date.now() + 3600_000),
    }), providerKey);
    expect((await provider.attestations.create(d.id, { credential: wrongType }).then(() => null, (e) => e as AapError))!.code).toBe("attestation_type_not_accepted");

    const noClaim = await providerCredential(d, { method: "email_link" });
    expect((await provider.attestations.create(d.id, { credential: noClaim }).then(() => null, (e) => e as AapError))!.code).toBe("attestation_claims_missing");

    const expired = await issueCredential(credentialBody({
      issuer: PROVIDER, type: "EmailControlCredential", subject: operator.credentials.subject(d),
      claims: { email_verified: true }, validFrom: new Date(Date.now() - 7200_000), validUntil: new Date(Date.now() - 3600_000),
    }), providerKey);
    expect((await provider.attestations.create(d.id, { credential: expired }).then(() => null, (e) => e as AapError))!.code).toBe("credential_invalid");
  });

  test("an attestation older than the site's max_age_s stops satisfying the policy", async () => {
    const d = await makeDelegation();
    const old = await issueCredential(credentialBody({
      issuer: PROVIDER, type: "EmailControlCredential", subject: operator.credentials.subject(d), claims: { email_verified: true },
      validFrom: new Date(Date.now() - 7200_000), validUntil: new Date(Date.now() + 86_400_000),
    }), providerKey);
    await provider.attestations.create(d.id, { credential: old });
    expect((await bind(d, "sess_fresh")).status_header).toBe("Foil-Agent-Status: bound");
    await setPolicy({ attestations: { issuers: [PROVIDER_ID, "operator"], types: ["EmailControlCredential"], claims: ["email_verified"], max_age_s: 60 } });
    expect((await bind(d, "sess_stale")).status_header).toBe("Foil-Agent-Status: downgraded; reason=evidence_insufficient");
    await setPolicy();
  });

  test("a site that accepts no attestations refuses submissions", async () => {
    const d = await makeDelegation();
    await setPolicy({ attestations: null, evidence: { read: "asserted" } });
    expect((await provider.attestations.create(d.id, { credential: await providerCredential(d) }).then(() => null, (e) => e as AapError))!.code).toBe("attestations_not_accepted");
    // Without a required tier the same delegation binds with no attestation at all.
    expect((await bind(d, "sess_plain")).status_header).toBe("Foil-Agent-Status: bound");
    await setPolicy();
  });

  test("an expired delegation refuses new attestations", async () => {
    const d = await makeDelegation();
    await site.delegations.revoke(d.id);
    expect((await provider.attestations.create(d.id, { credential: await providerCredential(d) }).then(() => null, (e) => e as AapError))!.code).toBe("delegation_inactive");
  });
});

describe("privacy and events", () => {
  test("no raw credential, unnamed claim, or personal value is stored or emitted", async () => {
    const d = await makeDelegation();
    const credential = await providerCredential(d, { email_verified: true, email: "someone@example.com", method: "email_link" });
    const a = await provider.attestations.create(d.id, { credential });
    expect(a.claims).toEqual({ email_verified: true });
    const serialized = JSON.stringify(a);
    expect(serialized).not.toContain("someone@example.com");
    expect(serialized).not.toContain(credential.slice(0, 40));
    const events = await site.events.list({ type: "attestation.created", limit: 5 });
    expect(JSON.stringify(events)).not.toContain("someone@example.com");
    expect(events.data[0]!.type).toBe("attestation.created");
    await bind(d, "sess_priv");
    const block = (await site.sessions.retrieve("sess_priv")).agent as AgentBlock;
    expect(JSON.stringify(block)).not.toContain("someone@example.com");
  });
});
