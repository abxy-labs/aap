#!/usr/bin/env bun
import { UsageError, bool, list, num, parseArgs, str } from "./lib/args.ts";
import { issueAgent, issueOperator, verifyAgent, verifyOperator } from "./lib/certs.ts";
import { issueChallenge, verifyChallenge } from "./lib/challenge.ts";
import { createDelegation, revokeDelegation, signRequest, verifyDelegation, verifyRequestSignature } from "./lib/delegation.ts";
import { directory } from "./lib/directory.ts";
import { buildHeader, signGrant } from "./lib/grant.ts";
import { decode } from "./lib/jwt.ts";
import { ALGS, generateKeyFile, readKeyFile, readPublicJwk, type Alg } from "./lib/keys.ts";
import { loadPolicy, setPolicy } from "./lib/policy.ts";
import { completeHandoff, useScope, verifyResponse } from "./lib/session.ts";
import { Store } from "./lib/store.ts";
import { computeTerms } from "./lib/terms.ts";
import { verifyPresentation } from "./lib/verify.ts";
import { runDemo } from "./lib/demo.ts";
import type { Acceptance, Attestation, Constraints, CredentialPolicy, DisclosureBundle, Evidence, Tier } from "./types.ts";

const HELP = `aap - Agent Admission Protocol reference implementation

Usage: aap <command> [options]

Store (simulated Foil)
  init [--store DIR] [--force]            Create a store with a Foil root key
  root                                    Print the root public key
  directory                               Hashed list of origins whose policy admits agents

Keys and certificates
  keygen --out FILE [--alg ES256|EdDSA]   Generate a key pair. EdDSA keys are the kind Web Bot Auth uses
  operator issue ...                      Foil issues an operator certificate
  agent issue ...                         An operator issues an agent certificate

Site policy
  policy set --origin O --tier T ...      Configure and sign a site's policy
  policy show --origin O                  Print the current policy statement

Delegation
  terms --agent-cert F --origin O --scopes a,b       What the consumer must be shown
  delegation create ...                   Create a delegation from a signed acceptance
  delegation show ID                      Status, claims, and record
  delegation revoke ID [--by WHO]         Revoke; every grant under it stops

Session
  challenge --origin O                    Foil issues a challenge for a participating origin
  challenge verify JWT                    Operator checks a challenge against the root key
  grant sign ...                          Agent signs a per-session grant over a challenge
  present --grant F --delegation F --agent-cert F --operator-cert F   Build the header value
  verify --header V --origin O --session ID [--asn A] [--ja4 J]      Foil verifies and binds
  session use ID --scope S                Record an exercised scope
  site session-record --id ID --origin O [--human] [--known-device] [--age-s N]
  site session ID                         GET /v1/sessions/{id}
  site handoff-complete ID --scope S      POST /v1/sessions/{id}/handoff

Other
  inspect FILE|JWT                        Decode any protocol object without verifying it
  demo [--keep]                           Run the whole lifecycle in a temporary store

Run "aap <command> --help" for the options of one command.`;

const COMMAND_HELP: Record<string, string> = {
  "operator issue": `aap operator issue --id ID --key PUBLIC_KEY_FILE --vetting LEVEL --session-handling TEXT [--attestations FILE] [--asn A,B] [--ja4 X,Y] [--days N] --out FILE`,
  keygen: `aap keygen --out FILE [--alg ES256|EdDSA]`,
  "agent issue": `aap agent issue --operator-cert FILE --operator-key FILE --id ID --name NAME --key PUBLIC_KEY_FILE --scopes a,b [--max-amount N] [--max-total N] [--currency USD] [--max-count N] [--payees existing_only|any] [--days N] --out FILE`,
  "policy set": `aap policy set --origin O --tier observe|read|manage|transact|none [--allow-operators a,b|any] [--allow-agents a,b|any] [--deny-agents a,b] [--max-amount N] [--max-total N] [--currency USD] [--max-count N] [--payees existing_only|any] [--disclosures FILE] [--credentials FILE] [--evidence read=asserted,transact=observed] [--handoff s1,s2] [--max-age-days N] [--disclose operator,agent]`,
  "delegation create": `aap delegation create --agent-cert FILE --operator-cert FILE --agent-key FILE --origin O --subject S --scopes a,b --intent TEXT --acceptance FILE [--site-session ID] --out FILE`,
  "grant sign": `aap grant sign --agent-key FILE --agent-cert FILE --delegation FILE --session-ref REF --intent TEXT [--scopes a,b] --challenge JWT|FILE [--ttl-s N] --out FILE`,
  verify: `aap verify (--header VALUE | --header-file FILE) --origin O --session ID [--asn A] [--ja4 J]`,
};

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, sub, ...rest] = positional;
  if (!cmd || cmd === "help" || flags.help === true && !sub) {
    if (cmd && COMMAND_HELP[cmd]) { console.log(COMMAND_HELP[cmd]); return 0; }
    console.log(HELP);
    return 0;
  }
  const key2 = `${cmd} ${sub ?? ""}`.trim();
  if (flags.help === true) {
    console.log(COMMAND_HELP[key2] ?? COMMAND_HELP[cmd] ?? HELP);
    return 0;
  }
  const store = Store.resolve(str(flags, "store"));

  switch (cmd) {
    case "init": {
      if ((await store.exists()) && !bool(flags, "force")) throw new UsageError(`store already exists at ${store.dir}; pass --force to replace it`);
      if (bool(flags, "force")) await store.destroy();
      const root = await generateKeyFile();
      await store.init(root);
      out({ store: store.dir, root_kid: root.kid });
      return 0;
    }
    case "root": {
      const root = await store.root();
      out({ keys: [root.public] });
      return 0;
    }
    case "keygen": {
      const alg = (str(flags, "alg") ?? "ES256") as Alg;
      if (!ALGS.includes(alg)) throw new UsageError("--alg must be ES256 or EdDSA");
      const kf = await generateKeyFile(alg);
      const path = str(flags, "out", true)!;
      await Bun.write(path, JSON.stringify(kf, null, 2));
      out({ out: path, kid: kf.kid, alg: kf.alg, public: kf.public });
      return 0;
    }
    case "operator": {
      if (sub !== "issue") throw new UsageError("usage: aap operator issue ...");
      const root = await store.root();
      const key = await readPublicJwk(str(flags, "key", true)!);
      const asn = list(flags, "asn");
      const ja4 = list(flags, "ja4");
      const attPath = str(flags, "attestations");
      const attestations = attPath ? ((await Bun.file(attPath).json()) as Attestation[]) : [];
      if (!Array.isArray(attestations) || attestations.some((a) => !a.type || !a.issuer)) throw new UsageError("--attestations must be a JSON array of objects with type and issuer");
      const jwt = await issueOperator(root, {
        id: str(flags, "id", true)!,
        key,
        vetting: str(flags, "vetting") ?? "standard",
        sessionHandling: str(flags, "session-handling") ?? "unspecified",
        attestations,
        ...(asn || ja4 ? { profile: { ...(asn ? { asn } : {}), ...(ja4 ? { ja4 } : {}) } } : {}),
        days: num(flags, "days"),
      });
      await store.putOperator(str(flags, "id", true)!, jwt);
      return emit(flags, jwt, { operator: str(flags, "id") });
    }
    case "agent": {
      if (sub !== "issue") throw new UsageError("usage: aap agent issue ...");
      const operatorCert = await readText(str(flags, "operator-cert", true)!);
      const operatorKey = await readKeyFile(str(flags, "operator-key", true)!);
      const root = await store.root();
      const operator = await verifyOperator(operatorCert, root.public);
      if ((operator.key as { x?: string }).x !== operatorKey.public.x) {
        throw new UsageError("operator key does not match the operator certificate");
      }
      const key = await readPublicJwk(str(flags, "key", true)!);
      const jwt = await issueAgent(operatorKey, operator.sub, {
        id: str(flags, "id", true)!,
        name: str(flags, "name") ?? str(flags, "id", true)!,
        key,
        ceiling: { scopes: list(flags, "scopes") ?? [], constraints: constraintsFrom(flags) },
        days: num(flags, "days"),
      });
      return emit(flags, jwt, { agent: str(flags, "id") });
    }
    case "policy": {
      const root = await store.root();
      const origin = str(flags, "origin", true)!;
      if (sub === "show") {
        const p = await loadPolicy(store, root, origin);
        if (!p) throw new UsageError(`no policy for ${origin}`);
        out(p);
        return 0;
      }
      if (sub !== "set") throw new UsageError("usage: aap policy set|show --origin O ...");
      const disclosuresPath = str(flags, "disclosures");
      const disclosures = disclosuresPath ? ((await Bun.file(disclosuresPath).json()) as DisclosureBundle) : null;
      const credentialsPath = str(flags, "credentials");
      const credentials = credentialsPath ? ((await Bun.file(credentialsPath).json()) as CredentialPolicy) : null;
      const evidence: Partial<Record<Tier, Evidence>> = {};
      const levels = ["asserted", "observed", "presented", "site"];
      for (const pair of list(flags, "evidence") ?? []) {
        const [t, e] = pair.split("=");
        if (!t || !e || !levels.includes(e)) throw new UsageError(`--evidence entries look like tier=asserted|observed|presented|site (got ${pair})`);
        evidence[t as Tier] = e as Evidence;
      }
      const disclose = list(flags, "disclose") ?? [];
      const allowOps = str(flags, "allow-operators");
      const allowAgents = str(flags, "allow-agents");
      const maxAgeDays = num(flags, "max-age-days");
      const stored = await setPolicy(store, root, {
        origin,
        tier: (str(flags, "tier", true) as Tier | "none"),
        allowOperators: allowOps === undefined || allowOps === "any" ? "any" : allowOps.split(",").map((s) => s.trim()),
        allowAgents: allowAgents === undefined || allowAgents === "any" ? "any" : allowAgents.split(",").map((s) => s.trim()),
        denyAgents: list(flags, "deny-agents") ?? [],
        constraints: constraintsFrom(flags),
        disclosures,
        evidence,
        handoff: list(flags, "handoff") ?? [],
        ...(maxAgeDays !== undefined ? { maxAgeS: maxAgeDays * 86400 } : {}),
        disclose: { operator: disclose.includes("operator"), agent: disclose.includes("agent") },
        credentials,
      });
      out({ origin: stored.origin, version: stored.version, policy: stored.jwt });
      return 0;
    }
    case "terms": {
      const root = await store.root();
      const agentCert = await readText(str(flags, "agent-cert", true)!);
      const origin = str(flags, "origin", true)!;
      const agent = await agentFromCert(store, agentCert);
      const policy = await loadPolicy(store, root, origin);
      if (!policy || policy.tier === "none") { out({ participates: false }); return 0; }
      const { terms, etag } = computeTerms(agent, policy, list(flags, "scopes") ?? agent.ceiling.scopes);
      out({ etag, ...terms });
      return 0;
    }
    case "delegation": {
      const root = await store.root();
      if (sub === "show") {
        const id = rest[0] ?? str(flags, "id", true)!;
        const d = await store.getDelegation(id);
        if (!d) throw new UsageError(`delegation ${id} not found`);
        out({ id: d.id, status: d.status, revoked_at: d.revoked_at, revoked_by: d.revoked_by, claims: d.claims, certificate: d.jwt });
        return 0;
      }
      if (sub === "revoke") {
        const id = rest[0] ?? str(flags, "id", true)!;
        const d = await revokeDelegation(store, id, str(flags, "by") ?? "site");
        out({ id: d.id, status: d.status, revoked_at: d.revoked_at, revoked_by: d.revoked_by });
        return 0;
      }
      if (sub !== "create") throw new UsageError("usage: aap delegation create|show|revoke ...");
      const agentCert = await readText(str(flags, "agent-cert", true)!);
      const operatorCert = await readText(str(flags, "operator-cert", true)!);
      const agentKey = await readKeyFile(str(flags, "agent-key", true)!);
      const operator = await verifyOperator(operatorCert, root.public);
      const agent = await verifyAgent(agentCert, operator);
      const acceptance = (await Bun.file(str(flags, "acceptance", true)!).json()) as Acceptance;
      const body = {
        agent: agent.sub,
        origin: str(flags, "origin", true)!,
        subject: str(flags, "subject", true)!,
        scopes: list(flags, "scopes") ?? agent.ceiling.scopes,
        intent: str(flags, "intent") ?? "",
        acceptance,
        site_session: str(flags, "site-session"),
      };
      // Operator side: sign the request with the agent key. Foil side: verify it, then issue.
      const signature = await signRequest(body, agentKey);
      await verifyRequestSignature(body, signature, agent.key as never);
      const d = await createDelegation(store, root, {
        agent,
        operator,
        origin: body.origin,
        subject: body.subject,
        scopes: body.scopes,
        intent: body.intent,
        acceptance,
        siteSession: body.site_session,
      });
      const outPath = str(flags, "out");
      if (outPath) await Bun.write(outPath, d.jwt);
      out({ delegation: d.id, expires_at: new Date(d.claims.exp * 1000).toISOString(), scopes: d.claims.scopes, constraints: d.claims.constraints, record: d.claims.record, ...(outPath ? { out: outPath } : { certificate: d.jwt }) });
      return 0;
    }
    case "site": {
      const root = await store.root();
      if (sub === "session-record") {
        const ageS = num(flags, "age-s") ?? 0;
        const s = { id: str(flags, "id", true)!, origin: str(flags, "origin", true)!, human: bool(flags, "human"), known_device: bool(flags, "known-device"), created_at: new Date(Date.now() - ageS * 1000).toISOString() };
        await store.putSiteSession(s);
        out(s);
        return 0;
      }
      if (sub === "session") {
        const id = rest[0] ?? str(flags, "id", true)!;
        const s = await store.getSession(id);
        if (!s) throw new UsageError(`session ${id} not found`);
        out(verifyResponse(s));
        return 0;
      }
      if (sub === "handoff-complete") {
        const id = rest[0] ?? str(flags, "id", true)!;
        const s = await completeHandoff(store, id, str(flags, "scope", true)!);
        out(verifyResponse(s));
        return 0;
      }
      void root;
      throw new UsageError("usage: aap site session-record|session|handoff-complete ...");
    }
    case "challenge": {
      const root = await store.root();
      if (sub === "verify") {
        const jwt = await readJwtOrFile(rest[0] ?? str(flags, "jwt", true)!);
        out(await verifyChallenge(jwt, root.public));
        return 0;
      }
      const origin = str(flags, "origin", true)!;
      const jwt = await issueChallenge(store, root, origin);
      if (!jwt) { out({ origin, challenge: null, note: "origin does not admit agents; no challenge is issued" }); return 0; }
      return emit(flags, jwt, { origin, header: `Foil-Agent-Challenge: ${jwt}` });
    }
    case "grant": {
      if (sub !== "sign") throw new UsageError("usage: aap grant sign ...");
      const root = await store.root();
      const agentKey = await readKeyFile(str(flags, "agent-key", true)!);
      const agentCert = await readText(str(flags, "agent-cert", true)!);
      const agent = await agentFromCert(store, agentCert);
      const delegationJwt = await readText(str(flags, "delegation", true)!);
      const delegation = await verifyDelegation(delegationJwt, root.public);
      const challengeJwt = await readJwtOrFile(str(flags, "challenge", true)!);
      const challenge = await verifyChallenge(challengeJwt, root.public);
      if (challenge.origin !== delegation.origin) throw new UsageError(`challenge is for ${challenge.origin} but the delegation is for ${delegation.origin}`);
      const jwt = await signGrant(agentKey, agent, delegation, {
        sessionRef: str(flags, "session-ref", true)!,
        intent: str(flags, "intent") ?? delegation.intent,
        scopes: list(flags, "scopes"),
        nonce: challenge.nonce,
        ttlS: num(flags, "ttl-s"),
      });
      return emit(flags, jwt, { grant: decode(jwt).claims });
    }
    case "present": {
      const header = buildHeader({
        grant: await readText(str(flags, "grant", true)!),
        chain: {
          delegation: await readText(str(flags, "delegation", true)!),
          agent: await readText(str(flags, "agent-cert", true)!),
          operator: await readText(str(flags, "operator-cert", true)!),
        },
      });
      const outPath = str(flags, "out");
      if (outPath) { await Bun.write(outPath, header); out({ out: outPath }); return 0; }
      console.log(`Foil-Agent-Grant: ${header}`);
      return 0;
    }
    case "verify": {
      const root = await store.root();
      let header = str(flags, "header");
      const headerFile = str(flags, "header-file");
      if (!header && headerFile) header = (await Bun.file(headerFile).text()).trim();
      if (!header) throw new UsageError("--header or --header-file is required");
      header = header.replace(/^Foil-Agent-Grant:\s*/i, "");
      const result = await verifyPresentation(store, root, {
        header,
        origin: str(flags, "origin", true)!,
        sessionId: str(flags, "session", true)!,
        asn: str(flags, "asn"),
        ja4: str(flags, "ja4"),
      });
      console.log(result.statusHeader);
      out({ ...(result.narrowed ? { narrowed: result.narrowed } : {}), ...(result.handoffScopes ? { handoff_scopes: result.handoffScopes } : {}), ...verifyResponse(result.session) as object });
      return result.session.decision.plane === "agent" ? 0 : 2;
    }
    case "session": {
      if (sub !== "use") throw new UsageError("usage: aap session use ID --scope S");
      const root = await store.root();
      const id = rest[0] ?? str(flags, "id", true)!;
      const r = await useScope(store, root, id, str(flags, "scope", true)!);
      if (r.statusHeader) console.log(r.statusHeader);
      if (r.handoffHeader) console.log(r.handoffHeader);
      out(verifyResponse(r.session));
      return r.session.decision.plane === "agent" ? 0 : 2;
    }
    case "directory": {
      const root = await store.root();
      out(await directory(store, root));
      return 0;
    }
    case "inspect": {
      const jwt = await readJwtOrFile(sub ?? str(flags, "jwt", true)!);
      const d = decode(jwt);
      out({ header: d.header, claims: d.claims });
      return 0;
    }
    case "demo": {
      await runDemo({ keep: bool(flags, "keep"), store: str(flags, "store") });
      return 0;
    }
    default:
      throw new UsageError(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

function constraintsFrom(flags: Record<string, string | boolean>): Constraints {
  const c: Constraints = {};
  const currency = str(flags, "currency") ?? "USD";
  const a = num(flags, "max-amount");
  if (a !== undefined) c.max_amount = { value: a, currency };
  const t = num(flags, "max-total");
  if (t !== undefined) c.max_total = { value: t, currency };
  const n = num(flags, "max-count");
  if (n !== undefined) c.max_count = n;
  const p = str(flags, "payees");
  if (p !== undefined) {
    if (p !== "existing_only" && p !== "any") throw new UsageError("--payees must be existing_only or any");
    c.payees = p;
  }
  const ttl = num(flags, "ttl-s");
  if (ttl !== undefined) c.ttl_s = ttl;
  return c;
}

async function agentFromCert(store: Store, agentCert: string) {
  const root = await store.root();
  const { claims } = decode<{ iss: string }>(agentCert);
  const op = await store.getOperator(claims.iss);
  if (!op) throw new UsageError(`operator ${claims.iss} is not registered with this store`);
  const operator = await verifyOperator(op.jwt, root.public);
  return verifyAgent(agentCert, operator);
}

async function readText(path: string): Promise<string> {
  const f = Bun.file(path);
  if (!(await f.exists())) throw new UsageError(`file not found: ${path}`);
  return (await f.text()).trim();
}

async function readJwtOrFile(v: string): Promise<string> {
  if (v.split(".").length === 3 && !(await Bun.file(v).exists())) return v.trim();
  return readText(v);
}

async function emit(flags: Record<string, string | boolean>, jwt: string, extra: Record<string, unknown>): Promise<number> {
  const outPath = str(flags, "out");
  if (outPath) {
    await Bun.write(outPath, jwt);
    out({ ...extra, out: outPath });
  } else {
    out({ ...extra, jwt });
  }
  return 0;
}

function out(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err instanceof UsageError ? msg : `error: ${msg}`);
    process.exit(1);
  },
);
