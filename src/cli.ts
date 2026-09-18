#!/usr/bin/env bun
import { UsageError, all, bool, list, num, parseArgs, str, type FlagValue } from "./lib/args.ts";
import { verifyAgent, verifyOperator } from "./lib/certs.ts";
import { verifyChallenge } from "./lib/challenge.ts";
import { verifyDelegation } from "./lib/delegation.ts";
import { credentialBody, issueCredential } from "./lib/credentials.ts";
import { delegationSubject } from "./lib/attestations.ts";
import { createDiscoveryProfile, discover, validateDiscoveryProfile } from "./lib/discovery.ts";
import { decode } from "./lib/jwt.ts";
import { ALGS, generateKeyFile, readKeyFile, type Alg } from "./lib/keys.ts";
import { Store } from "./lib/store.ts";
import { Aap, AapError, DEFAULT_API_BASE } from "./sdk/index.ts";
import { startServer } from "./server/app.ts";
import { configDir, getProfile, loadConfig, loadKeyring, mask, saveConfig, saveKeyFile, type Profile } from "./cli/config.ts";
import { runDemo } from "./cli/demo.ts";
import { listen } from "./cli/listen.ts";
import { paramsFromFlags, parseDuration } from "./cli/params.ts";
import type { DelegationObject } from "./types.ts";

const HELP = `aap - Agent Admission Protocol command line

Usage: aap <resource> <verb> [id] [--field value] [--nested.field value]

Getting started
  login [--api-key K] [--live-key K] [--api-base URL]   Store an API key for this profile
  accounts create --type operator|site|issuer --name NAME   Reference-server onboarding; logs you in
  whoami                                               The account behind the current key
  serve [--port 4010] [--store DIR] [--discovery FILE] [--allow-local]  Run the reference API locally
  demo [--keep]                                        Run the whole lifecycle against an in-process API

Resources (create, retrieve, list, and the verbs shown)
  attestations    create --authorization ID --credential FILE|JWT  |  retrieve ID | list [--authorization ID] | revoke ID
  issuers         retrieve ID | list
  agents          create --name N --scopes a,b [--max-amount N] [--currency usd] [--payees existing_only]  |  retrieve ID | list | update ID | deactivate ID
  policies        create --origin O --scopes a,b [--customer-action scope=..,mode=..,url=..] [--disclosures @file.json] | retrieve ID | list
  authorizations  create --agent ID --origin O --subject S --intent TEXT --scopes a,b | accept ID --revision HASH --data '{"acceptance":{...}}' | retrieve ID | list | revoke ID
  sessions        retrieve ID | list [--origin O] [--status S]
  customer-actions create --session ID --scope S [--context.amount N ...]  |  retrieve ID | list | update ID | complete ID | cancel ID | wait ID [--timeout 15m]
  events          retrieve ID | list [--type T]
  webhook-endpoints  create --url U [--enabled-events a,b] | retrieve ID | list | update ID | delete ID
  directory       list
  discovery       create --origin URL --api-base URL [--out FILE] [--allow-local] (offline)
                  retrieve ORIGIN [--allow-local] (public, no login)

Local signing (nothing is sent to the API except reads)
  credentials issue --issuer URL --type T --subject URI --claims k=v,k=v --valid-for 30d --key FILE [--out FILE]
  credentials subject --authorization ID                           The subject an issuer names for an authorization
  keys generate --out FILE [--alg ES256|EdDSA]

Test mode helpers
  test browser connect --authorization ID [--asn AS14618]
  test agents list
  test sessions create --origin O [--known-device] [--age 240]      A consumer session Foil observed
  test challenges create --origin O
  test presentations create --origin O (--header-file F | --agent ag_test_bound) [--session ID] [--asn A]
  test sessions use ID --scope S
  test customer-actions link ID | complete ID [--outcome passed]
  listen --forward-to localhost:3000/webhooks [--events a,b]
  trigger EVENT_TYPE [--origin O]
  logs tail

Global flags: --api-key, --api-base, --profile, --live, --expand a,b, --idempotency-key, --api-version, -d '{"json":true}'
Values: --a.b sets nested fields, --items.0.k builds arrays, @file.json reads JSON from a file, a,b is a list for list fields.`;

type Flags = Record<string, FlagValue>;

function out(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
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

async function client(flags: Flags, opts: { auth?: boolean } = {}): Promise<{ aap: Aap; profileName: string; profile: Profile }> {
  const cfg = await loadConfig();
  const { name, profile } = getProfile(cfg, str(flags, "profile"));
  const apiBase = str(flags, "api-base") ?? process.env.AAP_API_BASE ?? profile.api_base ?? DEFAULT_API_BASE;
  let apiKey = str(flags, "api-key") ?? process.env.AAP_API_KEY ?? (bool(flags, "live") ? profile.live_key : profile.test_key) ?? null;
  if (opts.auth !== false && !apiKey) throw new UsageError(`no API key. Run "aap login --api-key sk_test_…" or "aap accounts create --type operator|site --name NAME" against a running "aap serve".`);
  if (opts.auth === false) apiKey = null;
  const keys = await loadKeyring(profile);
  return { aap: new Aap(apiKey, { apiBase, keys, apiVersion: str(flags, "api-version") }), profileName: name, profile };
}

function constraintsFrom(flags: Flags): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const currency = str(flags, "currency");
  if (currency) c.currency = currency;
  const a = num(flags, "max-amount");
  if (a !== undefined) c.max_amount = a;
  const t = num(flags, "max-total");
  if (t !== undefined) c.max_total = t;
  const n = num(flags, "max-count");
  if (n !== undefined) c.max_count = n;
  const p = str(flags, "payees");
  if (p !== undefined) c.payees = p;
  return c;
}

const CONSTRAINT_FLAGS = ["currency", "max-amount", "max-total", "max-count", "payees"];

function parseCustomerActionShorthand(v: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of v.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) { out.scope = part.trim(); continue; }
    const k = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    out[k] = k === "expires_in" ? Number(val) : val;
  }
  if (!out.scope) throw new UsageError(`--customer_action needs scope=...: got '${v}'`);
  return out;
}

async function resourceCommand(resource: string, verb: string | undefined, rest: string[], flags: Flags): Promise<number> {
  const { aap, profileName, profile } = await client(flags);
  const expand = list(flags, "expand");
  const idem = str(flags, "idempotency-key");
  const ro = { ...(expand ? { expand } : {}), ...(idem ? { idempotencyKey: idem } : {}) };
  const idArg = rest[0] ?? str(flags, "id");
  const needId = () => { if (!idArg) throw new UsageError(`${resource} ${verb} needs an id`); return idArg; };
  const params = () => paramsFromFlags(flags, ["id"]);

  switch (resource) {
    case "attestations": {
      if (verb === "create") {
        const credential = await readJwtOrFile(str(flags, "credential", true)!);
        out(await aap.attestations.create(str(flags, "authorization", true)!, { credential }, ro));
        return 0;
      }
      if (verb === "retrieve") { out(await aap.attestations.retrieve(needId())); return 0; }
      if (verb === "list") { out(await aap.attestations.list(params())); return 0; }
      if (verb === "revoke") { out(await aap.attestations.revoke(needId())); return 0; }
      break;
    }
    case "issuers": {
      if (verb === "retrieve") { out(await aap.issuers.retrieve(needId())); return 0; }
      if (verb === "list" || verb === undefined) { out(await aap.issuers.list(params())); return 0; }
      break;
    }
    case "agents": {
      if (verb === "create") {
        const scopes = list(flags, "scopes") ?? (params().ceiling as { scopes?: string[] } | undefined)?.scopes;
        if (!scopes?.length) throw new UsageError("--scopes is required");
        const keyPath = str(flags, "key");
        const key = keyPath ? await readKeyFile(keyPath) : undefined;
        const agent = await aap.agents.create({
          name: str(flags, "name", true)!, key, alg: str(flags, "alg") as Alg | undefined, days: num(flags, "days"),
          ceiling: { scopes, constraints: { ...((params().ceiling as { constraints?: Record<string, unknown> } | undefined)?.constraints ?? {}), ...constraintsFrom(flags) } },
          metadata: (params().metadata as Record<string, string> | undefined) ?? {},
        }, ro);
        const agentKey = aap.keys.agents[agent.id]!;
        const path = await saveKeyFile(profileName, "agent", agent.id, agentKey);
        const cfg = await loadConfig();
        const p = cfg.profiles[profileName] ?? {};
        p.keys = { ...p.keys, agents: { ...(p.keys?.agents ?? {}), [agent.id]: path } };
        cfg.profiles[profileName] = p;
        await saveConfig(cfg);
        out({ ...agent, signing_key: path });
        return 0;
      }
      if (verb === "retrieve") { out(await aap.agents.retrieve(needId(), ro)); return 0; }
      if (verb === "list") { out(await aap.agents.list(params())); return 0; }
      if (verb === "update") { out(await aap.agents.update(needId(), params())); return 0; }
      if (verb === "deactivate") { out(await aap.agents.deactivate(needId())); return 0; }
      break;
    }
    case "policies": {
      if (verb === "create") {
        const p = paramsFromFlags(flags, ["id", "customer-action", "allow-operators", "allow-agents", "deny-agents", "max-age-days", "evidence", ...CONSTRAINT_FLAGS]);
        const customer_actions = all(flags, "customer-action").map(parseCustomerActionShorthand);
        if (customer_actions.length) p.customer_actions = [...((p.customer_actions as unknown[]) ?? []), ...customer_actions];
        const allow: Record<string, unknown> = { ...((p.allow as Record<string, unknown>) ?? {}) };
        const ao = str(flags, "allow-operators"); if (ao) allow.operators = ao === "any" ? "any" : ao.split(",");
        const aa = str(flags, "allow-agents"); if (aa) allow.agents = aa === "any" ? "any" : aa.split(",");
        const da = list(flags, "deny-agents"); if (da) allow.deny_agents = da;
        if (Object.keys(allow).length) p.allow = allow;
        const ev = str(flags, "evidence");
        if (ev) p.advanced = { ...((p.advanced as Record<string,unknown>) ?? {}), evidence: Object.fromEntries(ev.split(",").map((pair) => { const [t, e] = pair.split("="); if (!t || !e) throw new UsageError("--evidence looks like accounts:read=asserted,payments:initiate=observed"); return [t.trim(), e.trim()]; })) };
        const days = num(flags, "max-age-days"); if (days !== undefined) p.max_age_s = days * 86400;
        const c = constraintsFrom(flags); if (Object.keys(c).length) p.constraints = { ...((p.constraints as Record<string, unknown>) ?? {}), ...c };
        out(await aap.policies.create(p, ro));
        return 0;
      }
      if (verb === "retrieve") { out(await aap.policies.retrieve(needId())); return 0; }
      if (verb === "list") { out(await aap.policies.list(params())); return 0; }
      break;
    }
    case "authorizations": {
      if (verb === "create") { out(await aap.authorizations.create(params() as never, ro)); return 0; }
      if (verb === "accept") { out(await aap.authorizations.accept(needId(), params() as never, ro)); return 0; }
      if (verb === "retrieve") { out(await aap.authorizations.retrieve(needId())); return 0; }
      if (verb === "list") { out(await aap.authorizations.list(params())); return 0; }
      if (verb === "revoke") { out(await aap.authorizations.revoke(needId(), params())); return 0; }
      break;
    }
    case "sessions": {
      if (verb === "retrieve") { out(await aap.sessions.retrieve(needId(), ro)); return 0; }
      if (verb === "list") { out(await aap.sessions.list(params(), ro)); return 0; }
      break;
    }
    case "customer-actions": {
      if (verb === "create") { out(await aap.customerActions.create(params() as never, ro)); return 0; }
      if (verb === "retrieve") { out(await aap.customerActions.retrieve(needId(), ro)); return 0; }
      if (verb === "list") { out(await aap.customerActions.list(params(), ro)); return 0; }
      if (verb === "update") { out(await aap.customerActions.update(needId(), params())); return 0; }
      if (verb === "complete") { out(await aap.customerActions.complete(needId(), params() as never)); return 0; }
      if (verb === "cancel") { out(await aap.customerActions.cancel(needId())); return 0; }
      if (verb === "wait") {
        const h = await aap.customerActions.wait(needId(), { timeout: parseDuration(str(flags, "timeout"), 900), interval: parseDuration(str(flags, "interval"), 1) });
        out(h);
        return h.status === "completed" ? 0 : 2;
      }
      break;
    }
    case "events": {
      if (verb === "retrieve") { out(await aap.events.retrieve(needId())); return 0; }
      if (verb === "list") { out(await aap.events.list(params())); return 0; }
      break;
    }
    case "webhook-endpoints":
    case "webhook_endpoints": {
      if (verb === "create") { out(await aap.webhookEndpoints.create(params() as never)); return 0; }
      if (verb === "retrieve") { out(await aap.webhookEndpoints.retrieve(needId())); return 0; }
      if (verb === "list") { out(await aap.webhookEndpoints.list(params())); return 0; }
      if (verb === "update") { out(await aap.webhookEndpoints.update(needId(), params())); return 0; }
      if (verb === "delete") { out(await aap.webhookEndpoints.del(needId())); return 0; }
      break;
    }
    case "directory": {
      if (verb === "list" || verb === undefined) { out(await aap.directory.list()); return 0; }
      break;
    }
    case "test": {
      const sub = verb;
      const v2 = rest[0];
      const id2 = rest[1] ?? str(flags, "id");
      const p = paramsFromFlags(flags, ["id", "header-file"]);
      if (sub === "browser" && v2 === "connect") { out(await aap.test.browser.connect(p as never)); return 0; }
      if (sub === "agents") { out(await aap.test.agents.list()); return 0; }
      if (sub === "sessions" && v2 === "create") { out(await aap.test.sessions.create(p as never)); return 0; }
      if (sub === "sessions" && v2 === "use") { if (!id2) throw new UsageError("test sessions use needs an id"); out(await aap.test.sessions.use(id2, p as never)); return 0; }
      if (sub === "challenges" && v2 === "create") { const c = await aap.test.challenges.create(p as never); const o = str(flags, "out"); if (o) { await Bun.write(o, c.jwt); out({ ...c, out: o }); } else out(c); return 0; }
      if (sub === "presentations" && v2 === "create") {
        const hf = str(flags, "header-file");
        if (hf) p.header = await readText(hf);
        const s = await aap.test.presentations.create(p as never);
        out(s);
        return s.plane === "agent" ? 0 : 2;
      }
      if (sub === "customer-actions" && v2 === "link") { if (!id2) throw new UsageError("test customer-actions link needs an id"); out(await aap.test.customerActions.link(id2, p as never)); return 0; }
      if (sub === "customer-actions" && v2 === "complete") { if (!id2) throw new UsageError("test customer-actions complete needs an id"); out(await aap.test.customerActions.complete(id2, p as never)); return 0; }
      throw new UsageError("usage: aap test agents list | sessions create|use | challenges create | presentations create | customer_actions link|complete");
    }
    default:
      void profile;
      throw new UsageError(`unknown command "${resource}"\n\n${HELP}`);
  }
  throw new UsageError(`unknown verb "${verb ?? ""}" for ${resource}`);
}

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, sub, ...rest] = positional;
  if (!cmd || cmd === "help" || flags.help === true || flags.h === true) { console.log(HELP); return 0; }

  switch (cmd) {
    case "login": {
      const cfg = await loadConfig();
      const name = str(flags, "profile") ?? cfg.current ?? "default";
      const p = cfg.profiles[name] ?? {};
      const key = str(flags, "api-key") ?? sub;
      if (key) { if (key.startsWith("sk_live_")) p.live_key = key; else p.test_key = key; }
      const liveKey = str(flags, "live-key"); if (liveKey) p.live_key = liveKey;
      const base = str(flags, "api-base"); if (base) p.api_base = base;
      if (!key && !liveKey && !base) throw new UsageError("usage: aap login --api-key sk_test_… [--live-key sk_live_…] [--api-base URL]");
      cfg.profiles[name] = p;
      cfg.current = name;
      await saveConfig(cfg);
      out({ profile: name, api_base: p.api_base ?? DEFAULT_API_BASE, test_key: mask(p.test_key), live_key: mask(p.live_key), config: configDir() });
      return 0;
    }
    case "logout": {
      const cfg = await loadConfig();
      const name = str(flags, "profile") ?? cfg.current;
      delete cfg.profiles[name];
      await saveConfig(cfg);
      out({ profile: name, removed: true });
      return 0;
    }
    case "config": {
      const cfg = await loadConfig();
      const { name, profile } = getProfile(cfg, str(flags, "profile"));
      out({ profile: name, api_base: profile.api_base ?? DEFAULT_API_BASE, account: profile.account, account_type: profile.account_type, test_key: mask(profile.test_key), live_key: mask(profile.live_key), keys: profile.keys, config: configDir() });
      return 0;
    }
    case "whoami": {
      const { aap } = await client(flags);
      out(await aap.account.retrieve());
      return 0;
    }
    case "serve": {
      const store = Store.resolve(str(flags, "store"));
      const discoveryFile = str(flags, "discovery");
      const allowLocalDiscovery = bool(flags, "allow-local");
      const discovery = discoveryFile ? validateDiscoveryProfile(JSON.parse(await readText(discoveryFile.replace(/^@/, ""))), undefined, { allowLocal: allowLocalDiscovery }) : undefined;
      const server = await startServer({ store, port: num(flags, "port") ?? 4010, discovery, allowLocalDiscovery });
      console.log(`aap reference API listening on ${server.url} (store ${store.rootDir})`);
      console.log(`Create an account: aap accounts create --type operator --name "Your Company" --api-base ${server.url}`);
      await new Promise(() => undefined);
      return 0;
    }
    case "discovery": {
      const opts = { allowLocal: bool(flags, "allow-local") };
      if (sub === "retrieve") {
        const origin = rest[0] ?? str(flags, "origin", true)!;
        out(await discover(origin, opts));
        return 0;
      }
      if (sub !== "create") throw new UsageError("usage: discovery create --origin URL --api-base URL [--out FILE] [--allow-local] | discovery retrieve ORIGIN");
      const profile = createDiscoveryProfile({ origin: str(flags, "origin", true)!, apiBase: str(flags, "api-base", true)! }, opts);
      const path = str(flags, "out");
      if (path) {
        await (await import("node:fs/promises")).writeFile(path, JSON.stringify(profile, null, 2) + "\n", { mode: 0o644, flag: "wx" });
        out({ out: path, publish_at: `${profile.origin}/.well-known/aap` });
      } else out(profile);
      return 0;
    }
    case "demo": {
      await runDemo({ store: str(flags, "store"), keep: bool(flags, "keep") });
      return 0;
    }
    case "accounts": {
      if (sub !== "create") throw new UsageError("usage: aap accounts create --type operator|site --name NAME [--key FILE] [--attestations @file.json] [--asn A,B]");
      const { aap, profileName } = await client(flags, { auth: false });
      const type = str(flags, "type", true)! as "operator" | "site" | "issuer";
      const keyPath = str(flags, "key");
      const key = keyPath ? await readKeyFile(keyPath) : undefined;
      const att = str(flags, "attestations");
      const res = await aap.accounts.create({
        type, name: str(flags, "name", true)!, key, alg: str(flags, "alg") as Alg | undefined,
        vetting: str(flags, "vetting"), session_handling: str(flags, "session-handling"),
        attestations: att ? JSON.parse(await readText(att.replace(/^@/, ""))) : undefined,
        asn: list(flags, "asn"), ja4: list(flags, "ja4"),
        // An issuer without --key gets a key pair generated and saved to its profile.
        ...(type === "issuer" ? { url: str(flags, "url", true)! } : {}),
      });
      const cfg = await loadConfig();
      const p = cfg.profiles[profileName] ?? {};
      p.api_base = aap.apiBase;
      p.test_key = res.keys.test;
      p.live_key = res.keys.live;
      p.account = res.account.id;
      p.account_type = type;
      if (aap.keys.operator) p.keys = { ...p.keys, operator: await saveKeyFile(profileName, "operator", res.operator?.id ?? "operator", aap.keys.operator) };
      if (aap.keys.issuer) p.keys = { ...p.keys, issuer: await saveKeyFile(profileName, "issuer", res.issuer?.id ?? "issuer", aap.keys.issuer) };
      cfg.profiles[profileName] = p;
      cfg.current = profileName;
      await saveConfig(cfg);
      out({ ...res, logged_in: { profile: profileName, api_base: p.api_base, signing_key: p.keys?.operator } });
      return 0;
    }
    case "credentials": {
      if (sub === "subject") {
        const { aap } = await client(flags);
        const d = await aap.authorizations.retrieve(str(flags, "authorization", true)!);
        out({ object: "credential_subject", subject: delegationSubject(d), delegation: d.id });
        return 0;
      }
      if (sub !== "issue") throw new UsageError("usage: aap credentials issue --issuer URL --type T --subject URI --claims k=v --valid-for 30d --key FILE [--out FILE] | aap credentials subject --authorization ID");
      const key = await readKeyFile(str(flags, "key", true)!);
      const claims: Record<string, string | number | boolean> = {};
      for (const pair of list(flags, "claims") ?? []) {
        const eq = pair.indexOf("=");
        if (eq === -1) throw new UsageError(`--claims entries look like name=value (got '${pair}')`);
        const name = pair.slice(0, eq).trim();
        const raw = pair.slice(eq + 1).trim();
        claims[name] = raw === "true" ? true : raw === "false" ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
      }
      let subject = str(flags, "subject");
      if (!subject) {
        const delegation = str(flags, "authorization");
        if (!delegation) throw new UsageError("--subject or --authorization is required");
        // An issuer account cannot read a delegation, so a provider is given the subject rather than deriving it.
        const d = await (await client(flags)).aap.authorizations.retrieve(delegation).catch((e: unknown) => {
          throw e instanceof AapError && e.code === "resource_missing"
            ? new UsageError(`cannot read ${delegation} with this account, so the subject cannot be derived. Pass --subject, which whoever asked for the check gives you.`)
            : e;
        });
        subject = delegationSubject(d);
      }
      const token = await issueCredential(credentialBody({
        issuer: str(flags, "issuer", true)!,
        type: str(flags, "type", true)!,
        subject,
        claims,
        context: list(flags, "context"),
        validUntil: new Date(Date.now() + parseDuration(str(flags, "valid-for"), 86400) * 1000),
      }), key);
      const path = str(flags, "out");
      if (path) {
        // A credential can carry personal data: write it with owner-only permissions and never overwrite.
        await (await import("node:fs/promises")).writeFile(path, token, { mode: 0o600, flag: "wx" });
        out({ object: "verifiable_credential", out: path, subject });
      } else out({ object: "verifiable_credential", credential: token, subject });
      return 0;
    }
    case "keys": {
      if (sub === "generate") {
        const alg = (str(flags, "alg") ?? "ES256") as Alg;
        if (!ALGS.includes(alg)) throw new UsageError("--alg must be ES256 or EdDSA");
        const kf = await generateKeyFile(alg);
        const path = str(flags, "out", true)!;
        await Bun.write(path, JSON.stringify(kf, null, 2));
        out({ out: path, kid: kf.kid, alg: kf.alg, public: kf.public });
        return 0;
      }
      if (sub === "list") {
        const cfg = await loadConfig();
        const { profile } = getProfile(cfg, str(flags, "profile"));
        out(profile.keys ?? {});
        return 0;
      }
      throw new UsageError("usage: aap keys generate --out FILE [--alg ES256|EdDSA] | aap keys list");
    }
    case "inspect": {
      const jwt = await readJwtOrFile(sub ?? str(flags, "jwt", true)!);
      out(decode(jwt));
      return 0;
    }
    case "listen": {
      const { aap } = await client(flags);
      await listen(aap, str(flags, "forward-to", true)!, list(flags, "events") ?? ["*"]);
      return 0;
    }
    case "trigger": {
      const { aap } = await client(flags);
      const type = sub ?? str(flags, "type", true)!;
      out(await aap.test.events.trigger(type, { origin: str(flags, "origin") }));
      return 0;
    }
    case "logs": {
      const { aap } = await client(flags, { auth: false });
      let after = 0;
      console.log(`Tailing request logs from ${aap.apiBase} (^C to quit)`);
      for (;;) {
        try {
          const res = await fetch(`${aap.apiBase}/v1/dev/logs?after=${after}`);
          const body = (await res.json()) as { data: { seq: number; id: string; method: string; path: string; status: number; ms: number; account: string | null; livemode: boolean | null; error?: string }[] };
          for (const l of body.data) {
            after = Math.max(after, l.seq);
            console.log(`${new Date().toISOString().slice(11, 19)}  [${l.status}] ${l.method} ${l.path} ${l.ms}ms ${l.account ?? "-"}${l.livemode === null ? "" : l.livemode ? " live" : " test"} [${l.id}]${l.error ? " " + l.error : ""}`);
          }
        } catch (e) {
          console.error(`cannot reach ${aap.apiBase}: ${e instanceof Error ? e.message : String(e)}`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    case "open": {
      const target = sub === "docs" ? `https://docs.usefoil.com/aap/${rest[0] ?? ""}` : `https://docs.usefoil.com/aap`;
      console.log(target);
      return 0;
    }
    default:
      return resourceCommand(cmd, sub, rest, flags);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof AapError) {
      console.error(`error: ${err.code}: ${err.message}${err.param ? ` (param: ${err.param})` : ""}${err.requestId ? ` [${err.requestId}]` : ""}`);
      process.exit(1);
    }
    console.error(err instanceof UsageError ? err.message : `error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
