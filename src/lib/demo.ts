import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueAgent, issueOperator, verifyAgent, verifyOperator } from "./certs.ts";
import { issueChallenge, verifyChallenge } from "./challenge.ts";
import { createDelegation, revokeDelegation, verifyDelegation } from "./delegation.ts";
import { directory } from "./directory.ts";
import { buildHeader, signGrant } from "./grant.ts";
import { generateKeyFile } from "./keys.ts";
import { loadPolicy, setPolicy } from "./policy.ts";
import { completeHandoff, useScope, verifyResponse } from "./session.ts";
import { Store, id } from "./store.ts";
import { computeTerms } from "./terms.ts";
import { verifyPresentation } from "./verify.ts";
import type { DisclosureBundle } from "../types.ts";

export const DEMO_BUNDLE: DisclosureBundle = {
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

function step(n: number, title: string) {
  console.log(`\n${n}. ${title}`);
}
function show(label: string, v: unknown) {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  console.log(`   ${label}${s.includes("\n") ? "\n" + s.replace(/^/gm, "   ") : " " + s}`);
}
function short(jwt: string): string {
  return jwt.length > 60 ? `${jwt.slice(0, 28)}…${jwt.slice(-16)} (${jwt.length} chars)` : jwt;
}

export async function runDemo(opts: { keep?: boolean; store?: string } = {}): Promise<void> {
  const dir = opts.store ?? join(tmpdir(), `aap-demo-${id("x")}`);
  const store = new Store(dir);
  const root = await generateKeyFile();
  await store.init(root);
  console.log(`Agent Admission Protocol demo. Store: ${dir}`);

  step(1, "Foil vets an operator and issues its certificate");
  const operatorKey = await generateKeyFile();
  const operatorCert = await issueOperator(root, { id: "op_7a1d", key: operatorKey.public, vetting: "standard", sessionHandling: "encrypted at rest, deleted at session end", profile: { asn: ["AS14618", "AS16509"] } });
  await store.putOperator("op_7a1d", operatorCert);
  show("operator certificate:", short(operatorCert));

  step(2, "The operator issues an agent certificate under its own key, with no call to Foil");
  const agentKey = await generateKeyFile();
  const agentCert = await issueAgent(operatorKey, "op_7a1d", {
    id: "ag_9c4e",
    name: "bill-pay-assistant",
    key: agentKey.public,
    ceiling: { scopes: ["accounts:read", "transactions:read", "payments:initiate"], constraints: { max_amount: { value: 500, currency: "USD" }, payees: "existing_only" } },
  });
  const operator = await verifyOperator(operatorCert, root.public);
  const agent = await verifyAgent(agentCert, operator);
  show("agent certificate:", short(agentCert));
  show("ceiling:", agent.ceiling);

  step(3, "The site configures a policy; Foil signs it as a versioned statement");
  const policy = await setPolicy(store, root, {
    origin: "bank.example",
    tier: "transact",
    constraints: { max_amount: { value: 200, currency: "USD" }, max_count: 5 },
    disclosures: DEMO_BUNDLE,
    evidence: { read: "asserted", transact: "observed" },
    handoff: ["payments:initiate"],
    maxAgeS: 30 * 86400,
    disclose: { operator: true, agent: true },
  });
  show("policy:", { origin: policy.origin, version: policy.version });

  step(4, "The agent app fetches the terms the consumer must be shown");
  const policyClaims = (await loadPolicy(store, root, "bank.example"))!;
  const { terms, etag } = computeTerms(agent, policyClaims, ["accounts:read", "payments:initiate"]);
  show("etag:", etag);
  show("scopes:", terms.scopes);
  show("constraints:", terms.constraints);
  show("acknowledgements:", terms.disclosures?.acknowledgements);

  step(5, "The consumer accepts in the app's own channel; the app posts the delegation, signed with the agent key");
  await store.putSiteSession({ id: "fs_2b81", origin: "bank.example", human: true, known_device: true, created_at: new Date(Date.now() - 240_000).toISOString() });
  const delegation = await createDelegation(store, root, {
    agent,
    operator,
    origin: "bank.example",
    subject: "usr_41b",
    scopes: ["accounts:read", "payments:initiate"],
    intent: "Pay monthly bills",
    acceptance: { terms: etag, acknowledged: ["esign", "share"], viewed: ["esign", "privacy"], channel: "imessage", accepted_at: new Date().toISOString(), copies_sent_to: "email" },
    siteSession: "fs_2b81",
  });
  show("delegation:", { id: delegation.id, scopes: delegation.claims.scopes, constraints: delegation.claims.constraints, expires_at: new Date(delegation.claims.exp * 1000).toISOString() });
  show("record:", delegation.claims.record);

  step(6, "The SDK's telemetry response carries a Foil-signed challenge for this origin");
  const challengeJwt = (await issueChallenge(store, root, "bank.example"))!;
  const challenge = await verifyChallenge(challengeJwt, root.public);
  show("Foil-Agent-Challenge:", short(challengeJwt));
  show("operator verified it against the root key; nonce:", challenge.nonce);

  step(7, "The agent signs a grant over the challenge and the browser attaches it on Foil telemetry only");
  const dl = await verifyDelegation(delegation.jwt, root.public);
  const grant = await signGrant(agentKey, agent, dl, { sessionRef: "sess_19c2", intent: "Pay September electric bill", nonce: challenge.nonce });
  const header = buildHeader({ grant, chain: { delegation: delegation.jwt, agent: agentCert, operator: operatorCert } });
  show("Foil-Agent-Grant:", short(header));

  step(8, "Foil verifies the chain, applies the current policy, and binds the grant to the session");
  const result = await verifyPresentation(store, root, { header, origin: "bank.example", sessionId: "fs_9d02", asn: "AS14618" });
  show(result.statusHeader, "");
  if (result.handoffScopes) show("scopes that will require the consumer:", result.handoffScopes);

  step(9, "The site reads the verification response on the call it already makes");
  show("GET /v1/sessions/fs_9d02:", verifyResponse(result.session));

  step(10, "The session uses a read scope, then reaches a scope the policy marks for handoff");
  const r1 = await useScope(store, root, "fs_9d02", "accounts:read");
  show(r1.statusHeader ?? "", "");
  const r2 = await useScope(store, root, "fs_9d02", "payments:initiate");
  show(r2.handoffHeader ?? "", "");
  const done = await completeHandoff(store, "fs_9d02", "payments:initiate");
  show("after the consumer completes it on the site, observed evidence now includes:", (done.agent as { delegation: { observed: unknown } }).delegation.observed);

  step(11, "A second session presents the same grant and both are downgraded");
  const replay = await verifyPresentation(store, root, { header, origin: "bank.example", sessionId: "fs_0000", asn: "AS14618" });
  show(replay.statusHeader, "");
  show("GET /v1/sessions/fs_9d02 now:", (await store.getSession("fs_9d02"))!.decision);

  step(12, "The site revokes the delegation; a fresh grant under it is refused");
  await revokeDelegation(store, delegation.id, "site");
  const challenge2 = await verifyChallenge((await issueChallenge(store, root, "bank.example"))!, root.public);
  const grant2 = await signGrant(agentKey, agent, dl, { sessionRef: "sess_20aa", intent: "Pay water bill", nonce: challenge2.nonce });
  const after = await verifyPresentation(store, root, { header: buildHeader({ grant: grant2, chain: {} }), origin: "bank.example", sessionId: "fs_1111", asn: "AS14618" });
  show(after.statusHeader, "");

  step(13, "The directory lists participating origins as hashes");
  show("directory:", await directory(store, root));

  if (!opts.keep && !opts.store) {
    await store.destroy();
    console.log(`\nDone. Temporary store removed. Pass --keep to inspect it.`);
  } else {
    console.log(`\nDone. Store kept at ${dir}.`);
  }
}
