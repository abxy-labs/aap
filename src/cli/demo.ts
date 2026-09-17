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

export const DEMO_BUNDLE = {
  bundle: "linking-v4",
  presentation: "app",
  gates: ["accounts:read", "transactions:read", "payments:initiate"],
  documents: [
    { id: "esign", title: "Consent to electronic records", url: "https://cdn.usefoil.com/d/esign-v4.md", format: "text/markdown", sha256: "3f2a…", render: "full" },
    { id: "privacy", title: "Privacy notice", url: "https://cdn.usefoil.com/d/privacy-v4.pdf", format: "application/pdf", sha256: "9c17…", render: "link" },
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
      tier: "transact",
      constraints: { currency: "usd", max_amount: 20000, max_count: 5 },
      disclosures: DEMO_BUNDLE,
      evidence: { read: "asserted", transact: "observed" },
      handoffs: [{ scope: "payments:initiate", mode: "approve", url: "https://bank.example/agent/confirm?aap_handoff={id}" }],
      disclose: ["operator", "agent"],
    });
    show("policy:", { id: policy.id, origin: policy.origin, version: policy.version, tier: policy.tier });

    step(4, "The agent app fetches the terms the consumer must be shown");
    const terms = await operator.terms.create({ agent: agent.id, origin: "bank.example", scopes: ["accounts:read", "payments:initiate"] });
    show("terms:", { id: terms.id, scopes: terms.scopes, constraints: terms.constraints, acknowledgements: terms.disclosures?.acknowledgements });

    step(5, "The consumer accepts in the app's own channel. The operator posts the delegation, signed with the agent key");
    const live = await site.test.sessions.create({ origin: "bank.example", known_device: true, age: 240 });
    const delegation = await operator.delegations.create({
      agent: agent.id, origin: "bank.example", subject: "usr_41b", terms: terms.id, intent: "Pay monthly bills",
      acceptance: { terms: terms.id, acknowledged: ["esign", "share"], viewed: ["esign", "privacy"], channel: "imessage", accepted_at: new Date().toISOString(), copies_sent_to: "email" },
      site_session: live.id,
      metadata: { task: "monthly-bills" },
    });
    show("delegation:", { id: delegation.id, status: delegation.status, scopes: delegation.scopes, constraints: delegation.constraints, expires_at: delegation.expires_at });

    step(6, "The SDK's telemetry response carries a challenge; the agent signs a grant over it and the browser presents the chain");
    const challenge = await operator.test.challenges.create({ origin: "bank.example" });
    const { grant } = await operator.grants.sign({ delegation, challenge: challenge.jwt, sessionRef: "sess_19c2", intent: "Pay September electric bill" });
    const header = await operator.presentations.build({ grant, delegation });
    show("Foil-Agent-Grant:", header.slice(0, 40) + "… (" + header.length + " chars)");

    step(7, "Foil verifies the chain and binds the grant to the session");
    const session = await operator.test.presentations.create({ origin: "bank.example", header, asn: "AS14618" });
    show(session.status_header ?? "", "");
    show("session:", { id: session.id, status: session.status, plane: session.plane, scopes: (session.agent as { scopes: string[] }).scopes });

    step(8, "The site reads the session on the verification call it already makes");
    show(`GET /v1/sessions/${session.id}:`, await site.sessions.retrieve(session.id));

    step(9, "The agent prepares a payment and asks for a handoff before acting");
    const handoff = await operator.handoffs.create({ session: session.id, scope: "payments:initiate", context: { amount: 14210, currency: "usd", payee: "Pacific Power", memo: "September electric" } });
    show("handoff:", { id: handoff.id, status: handoff.status, mode: handoff.mode, url: handoff.url, code: handoff.code });
    show("display.message:", handoff.display.message);
    show("session.next_action:", (await operator.sessions.retrieve(session.id)).next_action);

    step(10, "The consumer opens the link on their own device and confirms; the site completes the handoff");
    const waiting = operator.handoffs.wait(handoff.id, { timeout: 30, interval: 0.2 });
    await site.test.handoffs.link(handoff.id);
    const completed = await site.handoffs.complete(handoff.id, { result: { confirmed: true } });
    show("handoff:", { status: completed.status, completed_by: completed.completed_by });
    const done = await waiting;
    show("operator's wait() returned:", { status: done.status });
    show("session.agent.approvals:", ((await site.sessions.retrieve(session.id)).agent as { approvals: unknown }).approvals);

    step(11, "A second session presents the same grant and both are downgraded");
    const replay = await operator.test.presentations.create({ origin: "bank.example", header, asn: "AS14618" });
    show(replay.status_header ?? "", "");
    show(`GET /v1/sessions/${session.id} now:`, (await site.sessions.retrieve(session.id)).decision);

    step(12, "The site revokes the delegation; a fresh grant under it is refused");
    await site.delegations.revoke(delegation.id);
    const ch2 = await operator.test.challenges.create({ origin: "bank.example" });
    const { grant: grant2 } = await operator.grants.sign({ delegation, challenge: ch2.jwt, sessionRef: "sess_20aa", intent: "Pay water bill" });
    const after = await operator.test.presentations.create({ origin: "bank.example", header: grant2, asn: "AS14618" });
    show(after.status_header ?? "", "");

    step(13, "Events were recorded for every step");
    const events = await site.events.list({ limit: 20 });
    show("types:", events.data.map((e) => e.type).reverse());
  } finally {
    server.stop();
    if (!opts.keep && !opts.store) await new Store(dir).destroy();
    console.log(opts.keep || opts.store ? `\nDone. Store kept at ${dir}.` : "\nDone. Temporary store removed. Pass --keep to inspect it.");
  }
}
