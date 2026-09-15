import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_BUNDLE } from "../src/cli/demo.ts";
import { flushDeliveries } from "../src/lib/events.ts";
import { Store, id } from "../src/lib/store.ts";
import { Aap, AapError } from "../src/sdk/index.ts";
import { createApp, type App } from "../src/server/app.ts";
import type { AgentBlock, AgentObject, DelegationObject, PolicyObject, TermsObject } from "../src/types.ts";

const ORIGIN = "bank.example";

let app: App;
let store: Store;
let anon: Aap;
let operator: Aap;
let site: Aap;
let liveOperator: Aap;
let agent: AgentObject;
let policy: PolicyObject;

function clientFor(key: string | null): Aap {
  return new Aap(key, { apiBase: "http://aap.test", fetch: ((url: string | URL | Request, init?: RequestInit) => app.fetch(new Request(url, init))) as typeof fetch });
}

async function acceptTerms(scopes = ["accounts:read", "payments:initiate"], opts: { siteSession?: string | null } = {}) {
  const terms = await operator.terms.create({ agent: agent.id, origin: ORIGIN, scopes });
  const live = opts.siteSession === null ? null : opts.siteSession ?? (await site.test.sessions.create({ origin: ORIGIN, known_device: true, age: 120 })).id;
  const delegation = await operator.delegations.create({
    agent: agent.id, origin: ORIGIN, subject: "usr_41b", terms: terms.id, intent: "Pay bills",
    acceptance: { terms: terms.id, acknowledged: ["esign", "share"], viewed: ["esign", "privacy"], channel: "test", accepted_at: new Date().toISOString(), copies_sent_to: "email" },
    site_session: live,
  });
  return { terms, delegation };
}

async function bind(delegation: DelegationObject, sessionId?: string) {
  const ch = await operator.test.challenges.create({ origin: ORIGIN });
  const { grant } = await operator.grants.sign({ delegation, challenge: ch.jwt, sessionRef: "sess_ref", intent: "Pay September electric bill" });
  const header = await operator.presentations.build({ grant, delegation });
  return operator.test.presentations.create({ origin: ORIGIN, header, asn: "AS14618", session: sessionId });
}

beforeAll(async () => {
  store = new Store(join(tmpdir(), `aap-api-${id("t")}`));
  app = await createApp(store);
  anon = clientFor(null);
  const op = await anon.accounts.create({ type: "operator", name: "Example Browser Co", asn: ["AS14618"], attestations: [{ type: "kya", issuer: "network.example", ref: "kya_1" }] });
  operator = clientFor(op.keys.test);
  operator.keys.operator = anon.keys.operator;
  liveOperator = clientFor(op.keys.live);
  liveOperator.keys.operator = anon.keys.operator;
  const st = await anon.accounts.create({ type: "site", name: "Example Bank" });
  site = clientFor(st.keys.test);
  agent = await operator.agents.create({ name: "bill-pay-assistant", ceiling: { scopes: ["accounts:read", "transactions:read", "payments:initiate", "application:write", "identity:verify"], constraints: { currency: "usd", max_amount: 50000, payees: "existing_only" } } });
  policy = await site.policies.create({
    origin: ORIGIN, tier: "transact",
    constraints: { currency: "usd", max_amount: 20000, max_count: 5 },
    disclosures: DEMO_BUNDLE,
    evidence: { read: "asserted", transact: "observed" },
    handoffs: [
      { scope: "payments:initiate", mode: "approve", url: "https://bank.example/agent/confirm?aap_handoff={id}" },
      { scope: "identity:verify", url: "https://bank.example/apply/verify?aap_handoff={id}", expires_in: 86400 },
    ],
    disclose: ["operator", "agent"],
  });
});

afterAll(async () => { await store.destroy(); });

describe("conventions", () => {
  test("objects carry id, object, created, livemode, metadata", async () => {
    expect(agent).toMatchObject({ object: "agent", livemode: false, metadata: {} });
    expect(agent.id).toMatch(/^ag_/);
    expect(typeof agent.created).toBe("number");
    expect(policy).toMatchObject({ object: "policy", origin: ORIGIN, version: 1 });
    expect(policy.id).toMatch(/^pol_/);
  });

  test("errors have type, code, message, param, doc_url, and a request id", async () => {
    const err = await operator.terms.create({ agent: "ag_missing", origin: ORIGIN }).then(() => { throw new Error("expected an error"); }, (e) => e as AapError);
    expect(err).toBeInstanceOf(AapError);
    expect(err.status).toBe(404);
    expect(err.type).toBe("invalid_request_error");
    expect(err.code).toBe("resource_missing");
    expect(err.requestId).toMatch(/^req_/);
    expect(err.docUrl).toContain("#resource_missing");
    const missing = await operator.terms.create({ origin: ORIGIN } as never).then(() => { throw new Error("expected an error"); }, (e) => e as AapError);
    expect(missing.code).toBe("parameter_missing");
    expect(missing.param).toBe("agent");
  });

  test("authentication and permission errors", async () => {
    const bad = clientFor("sk_test_nope");
    expect((await bad.account.retrieve().then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).type).toBe("authentication_error");
    const noKey = clientFor(null);
    expect((await noKey.account.retrieve().then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).status).toBe(401);
    const wrongType = await site.terms.create({ agent: agent.id, origin: ORIGIN }).then(() => { throw new Error("expected an error"); }, (e) => e as AapError);
    expect(wrongType.type).toBe("permission_error");
    expect(wrongType.status).toBe(403);
  });

  test("unknown endpoints, wrong methods, and unknown API versions", async () => {
    expect((await operator.request("GET", "/v1/nothing").then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).code).toBe("unknown_endpoint");
    expect((await operator.request("DELETE", "/v1/agents").then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).status).toBe(405);
    const old = new Aap(operator.apiKey, { apiBase: "http://aap.test", apiVersion: "2020-01-01", fetch: ((u: string | URL | Request, i?: RequestInit) => app.fetch(new Request(u, i))) as typeof fetch });
    expect((await old.account.retrieve().then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).code).toBe("invalid_api_version");
  });

  test("idempotency keys replay the first response and reject reuse with different parameters", async () => {
    const key = `idem_${id("k")}`;
    const a = await operator.terms.create({ agent: agent.id, origin: ORIGIN, scopes: ["accounts:read"] }, { idempotencyKey: key });
    const b = await operator.terms.create({ agent: agent.id, origin: ORIGIN, scopes: ["accounts:read"] }, { idempotencyKey: key });
    expect(b.id).toBe(a.id);
    const err = await operator.terms.create({ agent: agent.id, origin: ORIGIN, scopes: ["transactions:read"] }, { idempotencyKey: key }).then(() => { throw new Error("expected an error"); }, (e) => e as AapError);
    expect(err.type).toBe("idempotency_error");
  });

  test("lists paginate newest first with cursors", async () => {
    for (let i = 0; i < 4; i++) await operator.terms.create({ agent: agent.id, origin: ORIGIN, scopes: ["accounts:read"] });
    const page1 = await operator.delegations.list({ limit: 2 });
    expect(page1.object).toBe("list");
    const events1 = await operator.events.list({ limit: 3 });
    expect(events1.data.length).toBe(3);
    expect(events1.has_more).toBe(true);
    const events2 = await operator.events.list({ limit: 3, starting_after: events1.data[2]!.id });
    expect(events2.data[0]!.id).not.toBe(events1.data[0]!.id);
    expect(events1.data[0]!.created).toBeGreaterThanOrEqual(events1.data[2]!.created);
  });

  test("expand inlines referenced objects", async () => {
    const { delegation } = await acceptTerms();
    const d = (await operator.delegations.retrieve(delegation.id, { expand: ["record", "agent"] })) as unknown as { record: { object: string }; agent: { object: string } };
    expect(d.record.object).toBe("delegation_record");
    expect(d.agent.object).toBe("agent");
    const plain = await operator.delegations.retrieve(delegation.id);
    expect(typeof plain.record).toBe("string");
  });

  test("test helpers are refused with a live key", async () => {
    const err = await liveOperator.test.challenges.create({ origin: ORIGIN }).then(() => { throw new Error("expected an error"); }, (e) => e as AapError);
    expect(err.status).toBe(403);
  });
});

describe("lifecycle through the API", () => {
  test("terms, delegation, presentation, session", async () => {
    const { terms, delegation } = await acceptTerms();
    expect(terms.object).toBe("terms");
    expect(terms.scopes[1]!.text).toBe("Make payments up to $200 each to payees you already have");
    expect(delegation).toMatchObject({ object: "delegation", status: "active", issuer: "foil", agent: agent.id, origin: ORIGIN });
    expect(delegation.constraints).toEqual({ currency: "usd", max_amount: 20000, max_count: 5, payees: "existing_only" });
    expect(delegation.certificate.split(".").length).toBe(3);
    const session = await bind(delegation);
    expect(session.status_header).toBe("Foil-Agent-Status: bound");
    expect(session).toMatchObject({ object: "session", plane: "agent", status: "active" });
    expect(session.handoff_scopes).toEqual(["payments:initiate"]);
    const seen = await site.sessions.retrieve(session.id);
    expect((seen.agent as AgentBlock).id).toBe(agent.id);
    expect((seen.agent as AgentBlock).delegation.observed?.human).toBe(true);
    const mine = await operator.sessions.retrieve(session.id);
    expect(mine.id).toBe(session.id);
    // the site cannot read another origin's delegation, the operator can read its own
    const other = await anon.accounts.create({ type: "site", name: "Other" });
    const otherSite = clientFor(other.keys.test);
    expect((await otherSite.delegations.retrieve(delegation.id).then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).status).toBe(404);
    expect((await site.delegations.list({ origin: ORIGIN })).data.some((d) => d.id === delegation.id)).toBe(true);
  });

  test("chain verifies offline against the root key", async () => {
    const { delegation } = await acceptTerms();
    const claims = await operator.chain.verify(delegation);
    expect(claims.sub).toBe(delegation.id);
    expect(claims.policy_version).toBe(1);
  });

  test("scope use, replay, revoke", async () => {
    const { delegation } = await acceptTerms();
    const session = await bind(delegation);
    const used = await operator.test.sessions.use(session.id, { scope: "accounts:read" });
    expect((used.agent as AgentBlock).scopes_used).toEqual(["accounts:read"]);
    const ch = await operator.test.challenges.create({ origin: ORIGIN });
    const { grant } = await operator.grants.sign({ delegation, challenge: ch.jwt, sessionRef: "x" });
    const header = await operator.presentations.build({ grant, delegation });
    await operator.test.presentations.create({ origin: ORIGIN, header, asn: "AS14618", session: "sess_a" });
    const replay = await operator.test.presentations.create({ origin: ORIGIN, header, asn: "AS14618", session: "sess_b" });
    expect(replay.status_header).toBe("Foil-Agent-Status: downgraded; reason=grant_replayed");
    expect((await site.sessions.retrieve("sess_a")).status).toBe("downgraded");
    const revoked = await site.delegations.revoke(delegation.id);
    expect(revoked.status).toBe("revoked");
    expect(revoked.revoked_by).toBe("site");
    const after = await bind(delegation, "sess_after");
    expect(after.status_header).toBe("Foil-Agent-Status: downgraded; reason=delegation_revoked");
    expect((await operator.delegations.revoke(delegation.id).then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).code).toBe("delegation_already_revoked");
  });

  test("deactivating an agent downgrades its later presentations", async () => {
    const a2 = await operator.agents.create({ name: "temp", ceiling: { scopes: ["accounts:read"], constraints: {} } });
    const terms = await operator.terms.create({ agent: a2.id, origin: ORIGIN, scopes: ["accounts:read"] });
    const d = await operator.delegations.create({ agent: a2.id, origin: ORIGIN, subject: "u", terms: terms.id, acceptance: { terms: terms.id, acknowledged: ["esign", "share"], viewed: ["esign", "privacy"], channel: "t", accepted_at: "now", copies_sent_to: "email" } });
    await operator.agents.deactivate(a2.id);
    expect((await operator.agents.retrieve(a2.id)).status).toBe("deactivated");
    const ch = await operator.test.challenges.create({ origin: ORIGIN });
    const { grant } = await operator.grants.sign({ delegation: d, challenge: ch.jwt, sessionRef: "x" });
    const r = await operator.test.presentations.create({ origin: ORIGIN, header: await operator.presentations.build({ grant, delegation: d }), asn: "AS14618" });
    expect(r.status_header).toBe("Foil-Agent-Status: downgraded; reason=agent_deactivated");
    expect((await operator.terms.create({ agent: a2.id, origin: ORIGIN }).then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).code).toBe("agent_deactivated");
  });
});

describe("handoffs", () => {
  test("approve mode: the agent asks with context, the consumer confirms on the site, the session gains an approval", async () => {
    const { delegation } = await acceptTerms();
    const session = await bind(delegation);
    const ho = await operator.handoffs.create({ session: session.id, scope: "payments:initiate", context: { amount: 14210, currency: "usd", payee: "Pacific Power" } });
    expect(ho).toMatchObject({ object: "handoff", status: "pending", mode: "approve", scope: "payments:initiate", origin: ORIGIN });
    expect(ho.url).toBe(`https://bank.example/agent/confirm?aap_handoff=${ho.id}`);
    expect(ho.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(ho.display.message).toBe("bill-pay-assistant wants to pay $142.10 to Pacific Power from your bank.example account. Confirm it on bank.example from your own device.");
    const s = await operator.sessions.retrieve(session.id);
    expect(s.status).toBe("requires_handoff");
    expect(s.next_action).toEqual({ type: "handoff", handoff: ho.id });
    // the site's landing page reads it, the SDK links the consumer's session, the site completes it
    const seen = await site.handoffs.retrieve(ho.id, { expand: ["delegation"] });
    expect((seen.delegation as unknown as { object: string }).object).toBe("delegation");
    const consumer = await site.test.sessions.create({ origin: ORIGIN, known_device: true, device: "mobile" });
    await site.test.handoffs.link(ho.id, { session: consumer.id });
    const waiting = operator.handoffs.wait(ho.id, { timeout: 5, interval: 0.05 });
    const done = await site.handoffs.complete(ho.id, { result: { confirmed: true } });
    expect(done.status).toBe("completed");
    expect(done.completed_by).toMatchObject({ session: consumer.id, human: true, device: "mobile", cloud_environment: false });
    expect((await waiting).status).toBe("completed");
    const after = await site.sessions.retrieve(session.id);
    expect(after.status).toBe("active");
    expect((after.agent as AgentBlock).approvals[0]).toMatchObject({ handoff: ho.id, scope: "payments:initiate", context: { amount: 14210, payee: "Pacific Power" } });
    expect((after.agent as AgentBlock).delegation.observed?.handoffs).toEqual(["payments:initiate"]);
    expect((await site.handoffs.complete(ho.id).then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).code).toBe("handoff_not_pending");
  });

  test("identity verification: handoff-only scope, complete mode, long expiry, result recorded", async () => {
    const { delegation } = await acceptTerms(["application:write", "identity:verify"]);
    const session = await bind(delegation);
    const ho = await operator.handoffs.create({ session: session.id, scope: "identity:verify", context: { application: "APP-88213" } });
    expect(ho.mode).toBe("complete");
    expect(ho.url).toBe(`https://bank.example/apply/verify?aap_handoff=${ho.id}`);
    expect(ho.expires_at - ho.created).toBe(86400);
    expect(ho.display.title).toBe("Verify your identity");
    expect(ho.display.message).toContain("this application");
    const done = await site.test.handoffs.complete(ho.id, { result: { outcome: "passed", provider: "idv", reference: "chk_91a2" } });
    expect(done.result).toEqual({ outcome: "passed", provider: "idv", reference: "chk_91a2" });
    expect((await operator.sessions.retrieve(session.id)).status).toBe("active");
  });

  test("the agent cannot complete its own handoff; trying downgrades the session", async () => {
    const { delegation } = await acceptTerms();
    const session = await bind(delegation);
    const ho = await operator.handoffs.create({ session: session.id, scope: "payments:initiate", context: { amount: 1, currency: "usd", payee: "x" } });
    const err = await site.handoffs.complete(ho.id, { session: session.id }).then(() => { throw new Error("expected an error"); }, (e) => e as AapError);
    expect(err.code).toBe("handoff_completed_by_agent");
    expect(err.status).toBe(403);
    expect((await site.sessions.retrieve(session.id)).status).toBe("downgraded");
    expect((await operator.handoffs.create({ session: session.id, scope: "payments:initiate" }).then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).code).toBe("session_not_agent");
  });

  test("cancel restores the session; a missing context in approve mode is refused; operators cannot complete", async () => {
    const { delegation } = await acceptTerms();
    const session = await bind(delegation);
    expect((await operator.handoffs.create({ session: session.id, scope: "payments:initiate" }).then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).code).toBe("context_missing");
    expect((await operator.handoffs.create({ session: session.id, scope: "transactions:read" }).then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).code).toBe("scope_not_granted");
    const ho = await operator.handoffs.create({ session: session.id, scope: "payments:initiate", context: { amount: 1, currency: "usd", payee: "x" } });
    expect((await operator.handoffs.complete(ho.id).then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).type).toBe("permission_error");
    const canceled = await operator.handoffs.cancel(ho.id);
    expect(canceled.status).toBe("canceled");
    expect((await operator.sessions.retrieve(session.id)).status).toBe("active");
    const listed = await site.handoffs.list({ session: session.id });
    expect(listed.data.map((h) => h.status)).toEqual(["canceled"]);
  });

  test("a site can set the URL after creation, for a vendor link", async () => {
    const { delegation } = await acceptTerms(["application:write", "identity:verify"]);
    const session = await bind(delegation);
    const ho = await operator.handoffs.create({ session: session.id, scope: "identity:verify" });
    const updated = await site.handoffs.update(ho.id, { url: "https://verify.vendor.example/i/abc" });
    expect(updated.url).toBe("https://verify.vendor.example/i/abc");
    expect((await operator.handoffs.update(ho.id, { url: "https://x.example" }).then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).type).toBe("permission_error");
  });
});

describe("test agents, events, and webhooks", () => {
  test("fixed-outcome test agents", async () => {
    const agents = await site.test.agents.list();
    expect(agents.data.map((a) => a.id)).toContain("ag_test_replayed");
    const bound = await site.test.presentations.create({ origin: ORIGIN, agent: "ag_test_bound", scopes: ["accounts:read", "transactions:read"] });
    expect(bound.plane).toBe("agent");
    expect((bound.agent as AgentBlock).scopes).toEqual(["accounts:read", "transactions:read"]);
    const replayed = await site.test.presentations.create({ origin: ORIGIN, agent: "ag_test_replayed" });
    expect(replayed.status).toBe("downgraded");
    expect((replayed.agent as { reason: string }).reason).toBe("grant_replayed");
    const needs = await site.test.presentations.create({ origin: ORIGIN, agent: "ag_test_requires_handoff" });
    expect(needs.status).toBe("requires_handoff");
    expect(needs.handoff?.mode).toBe("approve");
    const done = await site.test.handoffs.complete(needs.handoff!.id);
    expect(done.status).toBe("completed");
    expect((await site.sessions.retrieve(needs.id)).status).toBe("active");
  });

  test("events are recorded and webhooks are delivered with a verifiable signature", async () => {
    const received: { body: string; sig: string | null }[] = [];
    const receiver = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { received.push({ body: await req.text(), sig: req.headers.get("aap-signature") }); return new Response("ok"); } });
    try {
      const endpoint = await site.webhookEndpoints.create({ url: `http://127.0.0.1:${receiver.port}/hooks`, enabled_events: ["handoff.completed", "delegation.revoked"] });
      expect(endpoint.secret).toMatch(/^whsec_/);
      expect((await site.webhookEndpoints.retrieve(endpoint.id)).secret).toBeUndefined();
      const evt = await site.test.events.trigger("delegation.revoked");
      expect(evt.type).toBe("delegation.revoked");
      await site.test.events.trigger("agent.created"); // not subscribed
      await flushDeliveries();
      expect(received.length).toBe(1);
      const parsed = site.webhooks.constructEvent(received[0]!.body, received[0]!.sig, endpoint.secret!);
      expect(parsed.id).toBe(evt.id);
      expect(() => site.webhooks.constructEvent(received[0]!.body, received[0]!.sig, "whsec_wrong")).toThrow(/does not match/);
      expect(() => site.webhooks.constructEvent(received[0]!.body + " ", received[0]!.sig, endpoint.secret!)).toThrow(/does not match/);
      const fetched = await site.events.retrieve(evt.id);
      expect(fetched.pending_webhooks).toBe(0);
      await site.webhookEndpoints.del(endpoint.id);
      expect((await site.webhookEndpoints.retrieve(endpoint.id).then(() => { throw new Error("expected an error"); }, (e) => e as AapError)).status).toBe(404);
    } finally {
      receiver.stop(true);
    }
  });

  test("event list filters by type", async () => {
    const list = await operator.events.list({ type: "delegation.created", limit: 5 });
    expect(list.data.every((e) => e.type === "delegation.created")).toBe(true);
    expect(list.data.length).toBeGreaterThan(0);
  });
});
