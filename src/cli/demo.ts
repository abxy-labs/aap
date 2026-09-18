import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, id } from "../lib/store.ts";
import { Aap } from "../sdk/index.ts";
import { startServer } from "../server/app.ts";

function step(n: number, title: string) {
  console.log(`\n${n}. ${title}`);
}
function show(label: string, v: unknown) {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  console.log(`   ${label}${s.includes("\n") ? "\n" + s.replace(/^/gm, "   ") : " " + s}`);
}

// Illustrative document URLs/digests, not hosted legal documents.
export const DEMO_BUNDLE = {
  bundle: "linking-v4",
  presentation: "app",
  gates: ["accounts:read", "transactions:read", "payments:initiate"],
  documents: [
    { id: "esign", title: "Consent to electronic records", url: "https://bank.example/legal/electronic-records-v4", format: "text/markdown", sha256: "3f2a6405a7e22b918490336674ebde5909f7b437b0ad14b5a5ff06e1f66a4b2d", render: "full" },
    { id: "privacy", title: "Privacy notice", url: "https://bank.example/legal/privacy-v4.pdf", format: "application/pdf", sha256: "9c17aa0c5e048a11b00409c9af8ce5a20d66705e98605884d45d141bb0d13794", render: "link" },
  ],
  acknowledgements: [
    { id: "esign", text: "I agree to receive these documents electronically" },
    { id: "share", text: "I authorize {agent} to access my accounts as described for {days} days" },
  ],
  retain: "copy_required",
};

/** Run the whole lifecycle against an in-process server, as an operator and a site would through the SDK. */
export async function runDemo(opts: { store?: string; keep?: boolean } = {}): Promise<void> {
  const dir = opts.store ?? join(tmpdir(), `aap-demo-${id("x")}`);
  const server = await startServer({ store: new Store(dir), port: 0 });
  console.log(`Agent Admission Protocol demo. API ${server.url}, store ${dir}`);
  try {
    step(1, "The operator is vetted and receives an operator certificate and API keys");
    const anon = new Aap(null, { apiBase: server.url });
    const opAcct = await anon.accounts.create({ type: "operator", name: "Example Browser Co", session_handling: "encrypted at rest, deleted at session end", asn: ["AS14618"] });
    const operator = new Aap(opAcct.keys.test, { apiBase: server.url, keys: { operator: anon.keys.operator } });
    show("operator:", { id: opAcct.operator!.id, account: opAcct.account.id, test_key: opAcct.keys.test.slice(0, 12) + "…" });

    step(2, "The operator registers an agent. The certificate is signed locally with the operator key");
    const agent = await operator.agents.create({
      name: "bill-pay-assistant",
      ceiling: { scopes: ["accounts:read", "transactions:read", "payments:initiate"], constraints: { currency: "usd", max_amount: 50000, payees: "existing_only" } },
    });
    show("agent:", { id: agent.id, name: agent.name, ceiling: agent.ceiling });

    step(3, "The site sets a policy");
    const siteAcct = await anon.accounts.create({ type: "site", name: "Example Bank" });
    const site = new Aap(siteAcct.keys.test, { apiBase: server.url });
    const policy = await site.policies.create({
      origin: "bank.example",
      scopes: ["accounts:read", "transactions:read", "payments:initiate"],
      constraints: { currency: "usd", max_amount: 20000, max_count: 5 },
      disclosures: DEMO_BUNDLE,
      advanced: { evidence: { "payments:initiate": "observed" } },
      customer_actions: [{ scope: "payments:initiate", mode: "approve", url: "https://bank.example/agent/confirm?aap_customer_action={id}" }],
      disclose: ["operator", "agent"],
    });
    show("policy:", { id: policy.id, origin: policy.origin, version: policy.version, scopes: policy.scopes });

    step(4, "Request authorization and display its consent details to the customer");
    const authorization = await operator.authorizations.create({
      agent: agent.id, origin: "bank.example", subject: "customer_7Rk2mV8p",
      intent: "Pay September electric bill", scopes: ["accounts:read", "payments:initiate"],
    });
    show("consent:", authorization.consent);

    step(5, "The customer accepts the exact revision shown in the app");
    const live = await site.test.sessions.create({ origin: "bank.example", known_device: true, age: 240 });
    await operator.authorizations.accept(authorization.id, {
      revision: authorization.consent.revision,
      acceptance: { acknowledged: ["esign", "share"], viewed: ["esign", "privacy"], channel: "in_app", accepted_at: new Date().toISOString(), copies_sent_to: "email" },
      site_session: live.id,
    });

    step(6, "Connect the browser; the SDK verifies the challenge and signs locally");
    const session = await operator.test.browser.connect({ authorization: authorization.id, asn: "AS14618" });
    show("session:", { id: session.id, status: session.status, plane: session.plane });

    step(7, "The site reads the session on the verification call it already makes");
    show(`GET /v1/sessions/${session.id}:`, await site.sessions.retrieve(session.id));

    step(8, "The agent prepares a payment and requests a customer action before acting");
    const customer_action = await operator.customerActions.create({ session: session.id, scope: "payments:initiate", context: { amount: 14210, currency: "usd", payee: "Pacific Power", memo: "September electric" } });
    show("customer_action:", { id: customer_action.id, status: customer_action.status, mode: customer_action.mode, url: customer_action.url, code: customer_action.code });
    show("display.message:", customer_action.display.message);
    show("session.next_action:", (await operator.sessions.retrieve(session.id)).next_action);

    step(9, "The consumer opens the link on their own device and confirms; the site completes the customer action");
    const waiting = operator.customerActions.wait(customer_action.id, { timeout: 30, interval: 0.2 });
    await site.test.customerActions.link(customer_action.id);
    const completed = await site.customerActions.complete(customer_action.id, { result: { confirmed: true } });
    show("customer_action:", { status: completed.status, completed_by: completed.completed_by });
    const done = await waiting;
    show("operator's wait() returned:", { status: done.status });
    show("session.agent.approvals:", ((await site.sessions.retrieve(session.id)).agent as { approvals: unknown }).approvals);

    step(10, "Revoke authorization; existing sessions can no longer exercise its scopes");
    await site.authorizations.revoke(authorization.id);
    show("revoked session:", await operator.test.sessions.use(session.id, { scope: "accounts:read" }));

    step(11, "Events were recorded for every step");
    const events = await site.events.list({ limit: 20 });
    show("types:", events.data.map((e) => e.type).reverse());
  } finally {
    server.stop();
    if (!opts.keep && !opts.store) await new Store(dir).destroy();
    console.log(opts.keep || opts.store ? `\nDone. Store kept at ${dir}.` : "\nDone. Temporary store removed. Pass --keep to inspect it.");
  }
}
