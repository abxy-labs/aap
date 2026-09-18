/**
 * Both ways a credential reaches a site: an identity provider posts its own, and an agent
 * application states a check it performed itself. Run: bun examples/attestations.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_BUNDLE } from "../src/cli/demo.ts";
import { generateKeyFile } from "../src/lib/keys.ts";
import { Store, id } from "../src/lib/store.ts";
import { Aap, credentialBody, issueCredential } from "../src/sdk/index.ts";
import { startServer } from "../src/server/app.ts";
import type { AgentBlock, SessionRecord } from "../src/types.ts";

import type { Authorization } from "../src/lib/authorization.ts";

const dir = join(tmpdir(), `aap-attestations-${id("x")}`);
const server = await startServer({ store: new Store(dir), port: 0 });
const client = (key: string | null) => new Aap(key, { apiBase: server.url });
const show = (label: string, v: unknown) => console.log(`   ${label} ${typeof v === "string" ? v : JSON.stringify(v)}`);
const step = (n: number, t: string) => console.log(`\n${n}. ${t}`);

try {
  console.log(`Attestations. API ${server.url}`);

  step(1, "An identity provider registers as an issuer with its public key");
  const anon = client(null);
  const providerKey = await generateKeyFile();
  const registered = await anon.accounts.create({ type: "issuer", name: "Identity Co", url: "https://identity.example", public_keys: [providerKey.public] });
  const provider = client(registered.keys.test);
  show("issuer:", { id: registered.issuer!.id, url: registered.issuer!.url });

  step(2, "An operator and a site onboard, and the site says which attestations it accepts");
  const opAcct = await anon.accounts.create({ type: "operator", name: "Example Browser Co", asn: ["AS14618"] });
  const operator = client(opAcct.keys.test);
  operator.keys.operator = anon.keys.operator;
  const siteAcct = await anon.accounts.create({ type: "site", name: "Example Bank" });
  const site = client(siteAcct.keys.test);
  const agent = await operator.agents.create({ name: "balance-assistant", ceiling: { scopes: ["accounts:read"], constraints: {} } });
  await site.policies.create({
    origin: "bank.example", scopes: ["accounts:read"], disclosures: DEMO_BUNDLE, disclose: ["operator", "agent"],
    advanced: { evidence: { "accounts:read": "attested" },
    attestations: { issuers: [registered.issuer!.id, "operator"], types: ["EmailControlCredential"], claims: ["email_verified"], max_age_s: 30 * 86400 } },
  });
  show("policy accepts:", { issuers: ["identity.example", "the authorization's own operator"], types: ["EmailControlCredential"], required: ["email_verified"] });

  const makeAuthorization = async (subject: string, attestations?: string[]): Promise<Authorization> => {
    const a=await operator.authorizations.create({agent:agent.id,origin:"bank.example",subject,intent:"Check balances",scopes:["accounts:read"]});
    return operator.authorizations.accept(a.id,{revision:a.consent.revision,acceptance:{acknowledged:["esign","share"],viewed:["esign","privacy"],channel:"in_app",accepted_at:new Date().toISOString(),copies_sent_to:"email"},attestations});
  };
  const bind=(a:Authorization,session:string)=>operator.test.browser.connect({authorization:a.id,session,asn:"AS14618"}) as Promise<SessionRecord & {status_header?:string}>;

  step(3, "Without an attestation the session is refused");
  const plain = await makeAuthorization("usr_plain");
  show((await bind(plain, "sess_plain")).status_header ?? "", "");

  step(4, "The provider posts its credential against the authorization");
  const subject = provider.credentials.subject(plain);
  show("subject the issuer names:", subject);
  const credential = await issueCredential(credentialBody({
    issuer: "https://identity.example", type: "EmailControlCredential", subject,
    claims: { email_verified: true, email: "someone@example.com", method: "email_link" },
    validUntil: new Date(Date.now() + 30 * 86400_000),
  }), providerKey);
  const attestation = await provider.attestations.create(plain.id, { credential });
  show("attestation:", { id: attestation.id, issuer: attestation.issuer, type: attestation.type, claims: attestation.claims, submitted_by: attestation.submitted_by });
  show("the email address was discarded:", !JSON.stringify(attestation).includes("someone@example.com"));

  step(5, "The session binds, and the site sees the attestation on the authorization");
  show((await bind(plain, "sess_ok")).status_header ?? "", "");
  show("session:", ((await site.sessions.retrieve("sess_ok")).agent as AgentBlock).authorization.attested);

  step(6, "An application that checked the email itself attaches its own credential when it accepts the authorization");
  // The subject is derived from the operator and its own id for the end user, both known before authorization is accepted.
  const operatorId = (await operator.account.retrieve()).operator!.id;
  const own = await issueCredential(credentialBody({
    issuer: agent.id, type: "EmailControlCredential",
    subject: operator.credentials.subject({ operator: operatorId, subject: "usr_inline" }),
    claims: { email_verified: true }, validUntil: new Date(Date.now() + 30 * 86400_000),
  }), operator.keys.agents[agent.id]!);
  const inline = await makeAuthorization("usr_inline", [own]);
  show("authorization accepted with the credential attached:", inline.id);
  const attached = await operator.attestations.list({ authorization: inline.id });
  show("recorded:", { issuer: attached.data[0]!.issuer, submitted_by: attached.data[0]!.submitted_by });

  step(7, "The site revokes it, and the session stops");
  await bind(inline, "sess_first");
  await site.attestations.revoke(attached.data[0]!.id);
  const used = await operator.test.sessions.use("sess_first", { scope: "accounts:read" });
  show(used.status_header ?? "", "");
} finally {
  server.stop();
  await new Store(dir).destroy();
  console.log("\nDone.");
}
