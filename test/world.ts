import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueAgent, issueOperator, verifyAgent, verifyOperator } from "../src/lib/certs.ts";
import { issueChallenge, verifyChallenge } from "../src/lib/challenge.ts";
import { createDelegation } from "../src/lib/delegation.ts";
import { buildHeader, signGrant } from "../src/lib/grant.ts";
import { generateKeyFile, type Alg, type KeyFile } from "../src/lib/keys.ts";
import { loadPolicy, setPolicy, type PolicyInput } from "../src/lib/policy.ts";
import { Store, id } from "../src/lib/store.ts";
import { createTerms } from "../src/lib/terms.ts";
import { verifyPresentation } from "../src/lib/verify.ts";
import type { AgentClaims, DelegationClaims, DisclosureBundle, OperatorClaims, StoredDelegation } from "../src/types.ts";
import { DEMO_BUNDLE } from "../src/cli/demo.ts";

export const ORIGIN = "bank.example";

export interface World {
  store: Store;
  root: KeyFile;
  operatorKey: KeyFile;
  operatorCert: string;
  operator: OperatorClaims;
  agentKey: KeyFile;
  agentCert: string;
  agent: AgentClaims;
  bundle: DisclosureBundle;
}

export async function makeWorld(policy: Partial<PolicyInput> = {}, keys: { alg?: Alg; agentAlg?: Alg } = {}): Promise<World> {
  const store = new Store(join(tmpdir(), `aap-test-${id("w")}`));
  const root = await generateKeyFile();
  await store.init(root);
  const operatorKey = await generateKeyFile(keys.alg ?? "ES256");
  const operatorCert = await issueOperator(root, { id: "op_test", key: operatorKey.public, vetting: "standard", sessionHandling: "test", profile: { asn: ["AS1"] } });
  await store.putOperator("op_test", operatorCert);
  const operator = await verifyOperator(operatorCert, root.public);
  const agentKey = await generateKeyFile(keys.agentAlg ?? keys.alg ?? "ES256");
  const agentCert = await issueAgent(operatorKey, "op_test", {
    id: "ag_test",
    name: "test-agent",
    key: agentKey.public,
    ceiling: { scopes: ["accounts:read", "transactions:read", "payments:initiate"], constraints: { currency: "usd", max_amount: 50000, payees: "existing_only" } },
  });
  const agent = await verifyAgent(agentCert, operator);
  await store.putAgent("ag_test", agentCert);
  await setPolicy(store, root, {
    origin: ORIGIN,
    tier: "transact",
    constraints: { currency: "usd", max_amount: 20000 },
    disclosures: DEMO_BUNDLE as DisclosureBundle,
    evidence: { read: "asserted", transact: "observed" },
    handoffs: [{ scope: "payments:initiate", mode: "approve", url: "https://bank.example/agent/confirm?aap_handoff={id}" }],
    maxAgeS: 30 * 86400,
    disclose: { operator: true, agent: true },
    ...policy,
  });
  return { store, root, operatorKey, operatorCert, operator, agentKey, agentCert, agent, bundle: DEMO_BUNDLE as DisclosureBundle };
}

export async function makeTerms(w: World, scopes = ["accounts:read", "payments:initiate"]) {
  const policy = (await loadPolicy(w.store, w.root, ORIGIN))!;
  return createTerms(w.store, w.agent, policy, scopes);
}

export async function makeDelegation(w: World, opts: { scopes?: string[]; siteSession?: string | null; now?: Date } = {}) {
  const scopes = opts.scopes ?? ["accounts:read", "payments:initiate"];
  const terms = await makeTerms(w, scopes);
  let siteSession: string | undefined;
  if (opts.siteSession !== null) {
    siteSession = opts.siteSession ?? "sess_human";
    await w.store.putSiteSession({ id: siteSession, origin: ORIGIN, human: true, known_device: true, created_at: new Date(Date.now() - 60_000).toISOString() });
  }
  const d = await createDelegation(w.store, w.root, {
    agent: w.agent,
    operator: w.operator,
    origin: ORIGIN,
    subject: "usr_1",
    scopes,
    terms: terms.id,
    intent: "test",
    acceptance: { terms: terms.id, acknowledged: ["esign", "share"], viewed: ["esign", "privacy"], channel: "test", accepted_at: new Date().toISOString(), copies_sent_to: "email" },
    siteSession,
    now: opts.now,
  });
  return { stored: d, claims: d.claims, terms };
}

export async function makePresentation(w: World, dl: { stored: StoredDelegation; claims: DelegationClaims }, opts: { scopes?: string[]; nonce?: string; agentKey?: KeyFile; fullChain?: boolean } = {}) {
  let nonce = opts.nonce;
  if (!nonce) {
    const ch = await verifyChallenge((await issueChallenge(w.store, w.root, ORIGIN))!, w.root.public);
    nonce = ch.nonce;
  }
  const grant = await signGrant(opts.agentKey ?? w.agentKey, w.agent, dl.claims, { sessionRef: "sess_1", intent: "test", scopes: opts.scopes, nonce });
  const chain = opts.fullChain === false ? {} : { delegation: dl.stored.certificate, agent: w.agentCert, operator: w.operatorCert };
  return buildHeader({ grant, chain });
}

export async function verifyAt(w: World, header: string, sessionId = "sess_agent", extra: { asn?: string; ja4?: string; now?: Date } = {}) {
  return verifyPresentation(w.store, w.root, { header, origin: ORIGIN, sessionId, asn: extra.asn ?? "AS1", ja4: extra.ja4, now: extra.now });
}
