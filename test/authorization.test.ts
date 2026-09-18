import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store.ts";
import { createApp } from "../src/server/app.ts";
import { Aap } from "../src/sdk/index.ts";
import type { Authorization } from "../src/lib/authorization.ts";
import { generateKeyFile } from "../src/lib/keys.ts";
import { issueAgent } from "../src/lib/certs.ts";

let store: Store, site: Aap, operator: Aap, stranger: Aap, agent: string;
beforeEach(async () => {
  store = new Store(await mkdtemp(join(tmpdir(), "aap-authorization-")));
  const app = await createApp(store);
  const client = (key: string | null) =>
    new Aap(key, {
      apiBase: "http://aap.test",
      fetch: ((u, init) => app.fetch(new Request(u, init))) as typeof fetch,
    });
  const anon = client(null);
  const op = await anon.accounts.create({
    type: "operator",
    name: "Example operator",
  });
  operator = client(op.keys.test);
  operator.keys.operator = anon.keys.operator;
  site = client(
    (await anon.accounts.create({ type: "site", name: "Example bank" })).keys
      .test,
  );
  stranger = client(
    (await anon.accounts.create({ type: "operator", name: "Another operator" }))
      .keys.test,
  );
  agent = (
    await operator.agents.create({
      name: "Account assistant",
      ceiling: {
        scopes: ["accounts:read", "transactions:read"],
        constraints: {},
      },
    })
  ).id;
  await site.policies.create({
    origin: "bank.example",
    scopes: ["accounts:read"],
    disclosures: {
      bundle: "account-2026-09",
      presentation: "app",
      documents: [
        {
          id: "terms",
          title: "Terms",
          url: "https://bank.example/terms",
          format: "text/html",
          render: "full",
          sha256: "a".repeat(64),
        },
      ],
      acknowledgements: [
        { id: "authorize", text: "I authorize access to my account balance." },
      ],
      retain: "none",
    },
  });
});
afterEach(async () => {
  await store.destroy();
});
const request = () =>
  operator.authorizations.create({
    agent,
    origin: "bank.example",
    subject: "customer_8e3a1b7c29f4",
    intent: "Read my account balance",
    scopes: ["accounts:read"],
  });
const acceptance = (a: Authorization) => ({
  revision: a.consent.revision,
  acceptance: {
    acknowledged: ["authorize"],
    viewed: ["terms"],
    channel: "in_app",
    accepted_at: new Date().toISOString(),
  },
});

test("one public lifecycle, without legacy aliases or policy tiers", async () => {
  for (const path of ["/v1/terms", "/v1/delegations", "/v1/handoffs"])
    await expect(operator.request("POST", path)).rejects.toMatchObject({
      code: "unknown_endpoint",
    });
  await expect(
    site.policies.create({ origin: "bank.example", tier: "read" }),
  ).rejects.toMatchObject({ param: "tier" });
  const a = await request();
  expect(a.status).toBe("pending_consent");
  await expect(
    operator.test.browser.connect({ authorization: a.id }),
  ).rejects.toMatchObject({ code: "authorization_inactive" });
  await operator.authorizations.accept(a.id, acceptance(a));
  const session = await operator.test.browser.connect({ authorization: a.id });
  expect(session.plane).toBe("agent");
  expect(session.agent).toHaveProperty("authorization.id", a.id);
  await site.authorizations.revoke(a.id);
  expect(
    (await operator.test.sessions.use(session.id, { scope: "accounts:read" }))
      .status,
  ).toBe("downgraded");
});
test("scope list never admits siblings in the same former tier", async () => {
  await expect(
    operator.authorizations.create({
      agent,
      origin: "bank.example",
      subject: "customer_8e3a1b7c29f4",
      intent: "Read transactions",
      scopes: ["transactions:read"],
    }),
  ).rejects.toMatchObject({ code: "no_permitted_scopes" });
});
test("consent is immutable, revision-bound and checked before issuance", async () => {
  const a = await request(),
    p = acceptance(a);
  await expect(
    operator.authorizations.accept(a.id, { ...p, revision: "wrong" }),
  ).rejects.toMatchObject({ code: "consent_revision_mismatch" });
  await expect(
    operator.authorizations.accept(a.id, {
      ...p,
      acceptance: { ...p.acceptance, acknowledged: [] },
    }),
  ).rejects.toMatchObject({ code: "acknowledgements_missing" });
  await expect(
    operator.authorizations.accept(a.id, {
      ...p,
      acceptance: { ...p.acceptance, viewed: [] },
    }),
  ).rejects.toMatchObject({ code: "documents_not_viewed" });
  await operator.authorizations.accept(a.id, p);
  await expect(
    operator.authorizations.accept(a.id, {
      ...p,
      acceptance: { ...p.acceptance, channel: "different" },
    }),
  ).rejects.toMatchObject({ code: "authorization_already_accepted" });
});
test("repeated and concurrent acceptance create one signed authorization", async () => {
  const a = await request(),
    p = acceptance(a);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => operator.authorizations.accept(a.id, p)),
  );
  expect(results.every((r) => r.id === a.id && r.status === "active")).toBe(
    true,
  );
  expect(await store.listDelegations()).toHaveLength(1);
});
test("a changed policy requires fresh customer consent", async () => {
  const a = await request();
  await site.policies.create({
    origin: "bank.example",
    scopes: ["accounts:read"],
    max_age_s: 60,
  });
  await expect(
    operator.authorizations.accept(a.id, acceptance(a)),
  ).rejects.toMatchObject({ code: "terms_stale" });
  expect(await store.listDelegations()).toHaveLength(0);
});
test.each(["deactivated", "expired"])("acceptance replay survives an %s agent but cannot issue new access", async state => {
  const a = await request(), pending = await request(), p = acceptance(a);
  await operator.authorizations.accept(a.id, p);
  if (state === "deactivated") await operator.agents.deactivate(agent);
  else {
    const saved = (await store.getAgentObject(agent))!;
    saved.certificate = await issueAgent(operator.keys.operator!, saved.operator, {
      id: saved.id, name: saved.name, key: saved.public_key, ceiling: saved.ceiling,
      now: new Date(Date.now() - 2 * 86400_000), days: 1,
    });
    saved.expires_at = Math.floor(Date.now() / 1000) - 86400;
    await store.putAgentObject(saved);
  }
  expect((await operator.authorizations.accept(a.id, p)).status).toBe("active");
  await expect(operator.authorizations.accept(pending.id, acceptance(pending))).rejects.toBeDefined();
  await expect(operator.authorizations.accept(a.id, { ...p, acceptance: { ...p.acceptance, channel: "changed" } }))
    .rejects.toMatchObject({ code: "authorization_already_accepted" });
  const original = operator.keys.agents[agent]!;
  operator.keys.agents[agent] = await generateKeyFile();
  await expect(operator.authorizations.accept(a.id, p)).rejects.toMatchObject({ code: "invalid_signature" });
  operator.keys.agents[agent] = original;
  expect(await store.listDelegations()).toHaveLength(1);
  await site.authorizations.revoke(a.id);
  await expect(operator.authorizations.accept(a.id, p)).rejects.toBeDefined();
});
test("another operator cannot read, accept, revoke, or connect an authorization", async () => {
  const a = await request();
  for (const [method, suffix] of [
    ["GET", ""],
    ["POST", "/accept"],
    ["POST", "/revoke"],
    ["GET", "/connection"],
  ])
    await expect(
      stranger.request(method!, `/v1/authorizations/${a.id}${suffix}`),
    ).rejects.toMatchObject({ status: 404 });
});
test("browser connection rejects a challenge for a different institution before presenting", async () => {
  const a = await request();
  await operator.authorizations.accept(a.id, acceptance(a));
  await site.policies.create({
    origin: "other.example",
    scopes: ["accounts:read"],
  });
  let presented = false;
  await expect(
    operator
      .browser({
        challenge: async () =>
          (await operator.test.challenges.create({ origin: "other.example" }))
            .jwt,
        present: async () => {
          presented = true;
          throw new Error("must not present");
        },
      })
      .connect({ authorization: a.id }),
  ).rejects.toMatchObject({ code: "challenge_origin_mismatch" });
  expect(presented).toBe(false);
});

test("revocation prevents customer-action completion and new requests", async () => {
  const a = await request();
  await operator.authorizations.accept(a.id, acceptance(a));
  const session = await operator.test.browser.connect({ authorization: a.id });
  const action = await operator.customerActions.create({
    session: session.id,
    scope: "accounts:read",
  });
  expect(action.authorization).toBe(a.id);
  expect(action).not.toHaveProperty("delegation");
  const human = await site.test.sessions.create({
    origin: "bank.example",
    human: true,
  });
  await site.authorizations.revoke(a.id);
  await expect(
    site.customerActions.complete(action.id, { session: human.id }),
  ).rejects.toMatchObject({ code: "authorization_inactive" });
  await expect(
    operator.customerActions.create({
      session: session.id,
      scope: "accounts:read",
    }),
  ).rejects.toMatchObject({ code: "authorization_inactive" });
  expect((await site.customerActions.retrieve(action.id)).status).toBe(
    "pending",
  );
  expect(
    (await operator.test.sessions.use(session.id, { scope: "accounts:read" }))
      .status,
  ).toBe("downgraded");
});
