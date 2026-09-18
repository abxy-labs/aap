import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_BUNDLE } from "../src/cli/demo.ts";
import { generateKeyFile, type KeyFile } from "../src/lib/keys.ts";
import { Store, id } from "../src/lib/store.ts";
import { Aap, AapError, credentialBody, issueCredential } from "../src/sdk/index.ts";
import { createApp, type App } from "../src/server/app.ts";
import type { AgentBlock, AgentObject, DelegationObject } from "../src/types.ts";

import type { Authorization } from "../src/lib/authorization.ts";
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
    origin: ORIGIN, scopes: ["accounts:read", "transactions:read", "payments:initiate"],
    constraints: { currency: "usd", max_amount: 20000 },
    disclosures: DEMO_BUNDLE,
    advanced: { evidence: { "accounts:read": "attested", "payments:initiate": "attested" },
    attestations: { issuers: [PROVIDER_ID, "operator"], types: ["EmailControlCredential"], claims: ["email_verified"] },
    ...extra },
    disclose: ["operator", "agent"],
  });
}

let PROVIDER_ID = "";

async function makeDelegation(scopes = ["accounts:read"], attestations?: string[]) {
  const a=await operator.authorizations.create({agent:agent.id,origin:ORIGIN,subject:`usr_${id("s")}`,intent:"Check balances",scopes});
  return accept(a,attestations);
}
function accept(a:Authorization,attestations?:string[]) {
  return operator.authorizations.accept(a.id,{revision:a.consent.revision,acceptance:{acknowledged:["esign","share"],viewed:["esign","privacy"],channel:"test",accepted_at:new Date().toISOString(),copies_sent_to:"email"},attestations});
}

async function providerCredential(d: Authorization, claims: Record<string, string | number | boolean> = { email_verified: true, method: "email_link" }, validForS = 86400) {
  return issueCredential(credentialBody({
    issuer: PROVIDER, type: "EmailControlCredential", subject: operator.credentials.subject(d), claims,
    validUntil: new Date(Date.now() + validForS * 1000),
  }), providerKey);
}

async function bind(d: Authorization, sessionId?: string) {
  return operator.test.browser.connect({authorization:d.id,session:sessionId,asn:"AS14618"}) as Promise<import("../src/types.ts").SessionRecord & {status_header?:string}>;
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
    expect(block.authorization.attested[0]).toMatchObject({ attestation: a.id, issuer: PROVIDER, type: "EmailControlCredential", holder_bound: false });
    expect((await site.attestations.list({authorization:d.id})).data).toHaveLength(1);
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
    const credential = await operator.credentials.issueForAuthorization(d0, {
      issuer: PROVIDER, type: "EmailControlCredential", claims: { email_verified: true }, validUntil: new Date(Date.now() + 86_400_000),
    });
    // Signed by the agent key but naming the identity provider, so it is checked against that provider's
    // registered keys only, and fails. A credential cannot be signed by one accepted issuer while naming another.
    const wrongIssuer = await operator.attestations.create(d0.id, { credential }).then(() => null, (e) => e as AapError);
    expect(wrongIssuer!.code).toBe("credential_invalid");

    // Naming the agent itself works, because the site's policy admits "operator", which covers its agents.
    const d = await makeDelegation();
    const own = await operator.credentials.issueForAuthorization(d, {
      issuer: agent.id, type: "EmailControlCredential", claims: { email_verified: true }, validUntil: new Date(Date.now() + 86_400_000),
    });
    const a = await operator.attestations.create(d.id, { credential: own });
    expect(a).toMatchObject({ submitted_by: "operator", issuer: agent.id });
    expect((await bind(d, "sess_op")).status_header).toBe("Foil-Agent-Status: bound");
  });

  test("attached inline when the delegation is created, and covered by the request signature", async () => {
    const subject = `usr_${id("s")}`;
    const operatorId = (await operator.account.retrieve()).operator!.id;
    const credential = await issueCredential(credentialBody({
      issuer: PROVIDER, type: "EmailControlCredential", subject: `urn:aap:subject:${operatorId}:${subject}`,
      claims: { email_verified: true }, validUntil: new Date(Date.now() + 86_400_000),
    }), providerKey);
    const a=await operator.authorizations.create({agent:agent.id,origin:ORIGIN,subject,intent:"Check balances",scopes:["accounts:read"]});
    const d=await accept(a,[credential]);
    const listed = await operator.attestations.list({ authorization: d.id });
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
    await setPolicy({ attestations: null, evidence: { "accounts:read": "asserted" } });
    expect((await provider.attestations.create(d.id, { credential: await providerCredential(d) }).then(() => null, (e) => e as AapError))!.code).toBe("attestations_not_accepted");
    // Without a required tier the same delegation binds with no attestation at all.
    expect((await bind(d, "sess_plain")).status_header).toBe("Foil-Agent-Status: bound");
    await setPolicy();
  });

  test("an expired delegation refuses new attestations", async () => {
    const d = await makeDelegation();
    await site.authorizations.revoke(d.id);
    expect((await provider.attestations.create(d.id, { credential: await providerCredential(d) }).then(() => null, (e) => e as AapError))!.code).toBe("delegation_inactive");
  });
});

describe("who can see and revoke", () => {
  test("an unrelated operator and an unrelated issuer cannot read an attestation", async () => {
    const d = await makeDelegation();
    const a = await provider.attestations.create(d.id, { credential: await providerCredential(d) });

    // A second operator, with its own agents and delegations, is not party to this one.
    const other = await anon.accounts.create({ type: "operator", name: "Other Browser Co" });
    const otherOperator = clientFor(other.keys.test);
    expect((await otherOperator.attestations.retrieve(a.id).then(() => null, (e) => e as AapError))!.status).toBe(404);
    expect((await otherOperator.attestations.list()).data.some((x) => x.id === a.id)).toBe(false);

    // A second provider did not sign it.
    const otherKey = await generateKeyFile();
    const otherIssuer = await anon.accounts.create({ type: "issuer", name: "Rival Identity", url: "https://rival.example", public_keys: [otherKey.public] });
    const rival = clientFor(otherIssuer.keys.test);
    expect((await rival.attestations.retrieve(a.id).then(() => null, (e) => e as AapError))!.status).toBe(404);
    expect((await rival.attestations.list()).data.some((x) => x.id === a.id)).toBe(false);

    // The parties to it can.
    expect((await site.attestations.retrieve(a.id)).id).toBe(a.id);
    expect((await operator.attestations.retrieve(a.id)).id).toBe(a.id);
    expect((await provider.attestations.retrieve(a.id)).id).toBe(a.id);
  });

  test("an issuer cannot revoke an attestation it did not sign", async () => {
    const d = await makeDelegation();
    const a = await provider.attestations.create(d.id, { credential: await providerCredential(d) });
    const otherKey = await generateKeyFile();
    const otherIssuer = await anon.accounts.create({ type: "issuer", name: "Rival Identity 2", url: "https://rival2.example", public_keys: [otherKey.public] });
    const rival = clientFor(otherIssuer.keys.test);
    // It cannot even see it, so revocation fails before the ownership check.
    expect((await rival.attestations.revoke(a.id).then(() => null, (e) => e as AapError))!.status).toBe(404);
    expect((await site.attestations.retrieve(a.id)).status).toBe("active");
    // The issuer that signed it can.
    expect((await provider.attestations.revoke(a.id)).revoked_by).toBe("issuer");
  });
});

describe("policy changes", () => {
  test("dropping an issuer stops its existing attestations from satisfying the policy", async () => {
    const d = await makeDelegation();
    await provider.attestations.create(d.id, { credential: await providerCredential(d) });
    expect((await bind(d, "sess_before")).status_header).toBe("Foil-Agent-Status: bound");

    // Same types and claims, but the provider is no longer accepted.
    await setPolicy({ attestations: { issuers: ["operator"], types: ["EmailControlCredential"], claims: ["email_verified"] } });
    expect((await bind(d, "sess_after")).status_header).toBe("Foil-Agent-Status: downgraded; reason=evidence_insufficient");

    // A bound session loses it at the next scope use too.
    await setPolicy();
    await bind(d, "sess_live");
    await setPolicy({ attestations: { issuers: ["operator"], types: ["EmailControlCredential"], claims: ["email_verified"] } });
    const used = await operator.test.sessions.use("sess_live", { scope: "accounts:read" });
    expect((used.agent as { reason: string }).reason).toBe("evidence_insufficient");
    await setPolicy();
  });
});

describe("inline attestations are all or nothing", () => {
  test("an invalid credential fails the request and writes no delegation", async () => {
    const subject = `usr_${id("s")}`;
    const operatorId = (await operator.account.retrieve()).operator!.id;
    const good = await issueCredential(credentialBody({
      issuer: PROVIDER, type: "EmailControlCredential", subject: `urn:aap:subject:${operatorId}:${subject}`,
      claims: { email_verified: true }, validUntil: new Date(Date.now() + 86_400_000),
    }), providerKey);
    const forged = await issueCredential(credentialBody({
      issuer: PROVIDER, type: "EmailControlCredential", subject: `urn:aap:subject:${operatorId}:${subject}`,
      claims: { email_verified: true }, validUntil: new Date(Date.now() + 86_400_000),
    }), await generateKeyFile());

    const authorization=await operator.authorizations.create({agent:agent.id,origin:ORIGIN,subject,intent:"Check balances",scopes:["accounts:read"]});
    const before = (await operator.authorizations.list({ status:"active", limit: 100 })).data.length;
    const attestationsBefore = (await operator.attestations.list({ limit: 100 })).data.length;
    const err=await accept(authorization,[good,forged]).then(()=>null,(e)=>e as AapError);
    expect(err!.code).toBe("credential_invalid");
    expect((await operator.authorizations.list({ status:"active", limit: 100 })).data.length).toBe(before);
    expect((await operator.attestations.list({ limit: 100 })).data.length).toBe(attestationsBefore);
  });
});

describe("issuer identity cannot be claimed by URL", () => {
  test("a second account cannot register a provider's identifier", async () => {
    const key = await generateKeyFile();
    const err = await anon.accounts.create({ type: "issuer", name: "Impostor", url: PROVIDER, public_keys: [key.public] })
      .then(() => null, (e) => e as AapError);
    expect(err!.code).toBe("issuer_url_taken");
    expect(err!.param).toBe("url");
  });

  test("an attestation records the registered issuer that verified it, and authorization uses that id", async () => {
    const d = await makeDelegation();
    const a = await provider.attestations.create(d.id, { credential: await providerCredential(d) });
    expect(a.issuer).toBe(PROVIDER);
    expect(a.issuer_account).toBe(PROVIDER_ID);

    // An account registered under a different URL cannot read or revoke it, even if it later
    // somehow presented the same URL: authorization is on the issuer record id.
    const key = await generateKeyFile();
    const rival = clientFor((await anon.accounts.create({ type: "issuer", name: "Elsewhere", url: "https://elsewhere.example", public_keys: [key.public] })).keys.test);
    expect((await rival.attestations.retrieve(a.id).then(() => null, (e) => e as AapError))!.status).toBe(404);
    expect((await rival.attestations.revoke(a.id).then(() => null, (e) => e as AapError))!.status).toBe(404);
    expect((await site.attestations.retrieve(a.id)).status).toBe("active");

    // Defense in depth: even if a duplicate URL existed despite the uniqueness check, holding it
    // grants nothing, because authorization is on the issuer record id, not the URL.
    const impostorAcct = await anon.accounts.create({ type: "issuer", name: "Impostor 2", url: "https://impostor.example", public_keys: [(await generateKeyFile()).public] });
    const impostorRecord = (await store.getIssuer(impostorAcct.issuer!.id))!;
    impostorRecord.url = PROVIDER;                 // the URL the real provider's attestations name
    await store.putIssuer(impostorRecord);
    const impostor = clientFor(impostorAcct.keys.test);
    expect((await impostor.attestations.retrieve(a.id).then(() => null, (e) => e as AapError))!.status).toBe(404);
    expect((await impostor.attestations.revoke(a.id).then(() => null, (e) => e as AapError))!.status).toBe(404);
    expect((await site.attestations.retrieve(a.id)).status).toBe("active");

    // An operator-signed attestation belongs to no issuer account.
    const own = await operator.credentials.issueForAuthorization(await makeDelegation(), {
      issuer: agent.id, type: "EmailControlCredential", claims: { email_verified: true }, validUntil: new Date(Date.now() + 86_400_000),
    });
    const d2 = await makeDelegation();
    const b = await operator.attestations.create(d2.id, {
      credential: await operator.credentials.issueForAuthorization(d2, {
        issuer: agent.id, type: "EmailControlCredential", claims: { email_verified: true }, validUntil: new Date(Date.now() + 86_400_000),
      }),
    });
    void own;
    expect(b.issuer_account).toBeNull();
    expect((await provider.attestations.retrieve(b.id).then(() => null, (e) => e as AapError))!.status).toBe(404);
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
    // The operator that holds the delegation is a party to the event, even though the attestation
    // names only the delegation.
    const operatorEvents = await operator.events.list({ type: "attestation.created", limit: 5 });
    expect(operatorEvents.data.some((e) => (e.data.object as { id: string }).id === a.id)).toBe(true);
    await bind(d, "sess_priv");
    const block = (await site.sessions.retrieve("sess_priv")).agent as AgentBlock;
    expect(JSON.stringify(block)).not.toContain("someone@example.com");
  });
});
