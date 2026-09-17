import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiscoveryProfile, discover, validateDiscoveryProfile } from "../src/lib/discovery.ts";
import { Store } from "../src/lib/store.ts";
import { Aap, API_VERSION } from "../src/sdk/index.ts";
import { createApp, type App } from "../src/server/app.ts";

const origin = "https://bank.example";
const apiBase = "https://aap.example";
const profile = createDiscoveryProfile({ origin, apiBase });
const mock = (body: unknown, status = 200, headers = { "content-type": "application/json" }) => (async (_u: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers })) as typeof fetch;

describe("public discovery", () => {
  let dir: string;
  let app: App;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "aap-discovery-"));
    app = await createApp(new Store(join(dir, "store")), { discovery: profile });
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test("publishes only explicit public metadata on the configured institution origin", async () => {
    const response = await app.fetch(new Request(`${origin}/.well-known/aap`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(profile);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(profile.api_version).toBe(API_VERSION);
    expect(profile.capabilities).not.toContain("credential_presentations");
    expect(profile.endpoints.credential_verifications).toBeUndefined();
    expect((await app.fetch(new Request(`${apiBase}/.well-known/aap`))).status).toBe(404);
    const defaultApp = await createApp(new Store(join(dir, "default")));
    expect((await defaultApp.fetch(new Request(`${origin}/.well-known/aap`))).status).toBe(404);
  });

  test("GET/HEAD and conditional caching work without authentication", async () => {
    const first = await app.fetch(new Request(`${origin}/.well-known/aap`));
    const etag = first.headers.get("etag")!;
    for (const tag of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const response = await app.fetch(new Request(`${origin}/.well-known/aap`, { headers: { "if-none-match": tag } }));
      expect(response.status).toBe(304);
      expect(await response.text()).toBe("");
    }
    expect((await app.fetch(new Request(`${origin}/.well-known/aap`, { headers: { "if-none-match": '"old"' } }))).status).toBe(200);
    expect(await (await app.fetch(new Request(`${origin}/.well-known/aap`, { method: "HEAD" }))).text()).toBe("");
    expect((await app.fetch(new Request(`${origin}/.well-known/aap`, { method: "POST" }))).status).toBe(405);
  });

  test("SDK discovers without forwarding credentials or switching hosts/trust", async () => {
    const calls: Request[] = [];
    let options: RequestInit | undefined;
    const aap = new Aap("sk_test_do_not_forward", { apiBase, fetch: (async (u, init) => {
      options = init;
      const req = new Request(u, init);
      calls.push(req);
      return app.fetch(req);
    }) as typeof fetch });
    expect(await aap.discover(origin)).toEqual(profile);
    expect(calls).toHaveLength(1); // does not dereference jwks_uri or any endpoint
    expect(calls[0]!.headers.has("authorization")).toBe(false);
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect(options?.referrerPolicy).toBe("no-referrer");
    expect(aap.apiBase).toBe(apiBase);
    expect(aap.apiKey).toBe("sk_test_do_not_forward");
  });

  test("discovery feeds the normal authenticated terms flow without enabling participation", async () => {
    const transport = (async (u, init) => app.fetch(new Request(u, init))) as typeof fetch;
    const found = await discover(origin, { fetch: transport });
    const anon = new Aap(null, { apiBase: found.api_base, fetch: transport });
    await expect(anon.request("POST", "/v1/terms", {})).rejects.toMatchObject({ status: 401 });
    const op = await anon.accounts.create({ type: "operator", name: "Example operator" });
    const operator = new Aap(op.keys.test, { apiBase: found.api_base, fetch: transport, keys: anon.keys });
    const agent = await operator.agents.create({ name: "Assistant", ceiling: { scopes: ["accounts:read"], constraints: {} } });
    // Merely publishing discovery neither opts the institution in nor changes policy.
    await expect(operator.terms.create({ agent: agent.id, origin, scopes: ["accounts:read"] })).rejects.toMatchObject({ code: "origin_not_participating" });
    const account = await anon.accounts.create({ type: "site", name: "Example bank" });
    const site = new Aap(account.keys.test, { apiBase: found.api_base, fetch: transport });
    await site.policies.create({ origin, tier: "read" });
    const terms = await operator.terms.create({ agent: agent.id, origin, scopes: ["accounts:read"] });
    expect(terms.origin).toBe(origin);
    expect((await operator.delegations.list()).data).toHaveLength(0); // consent still required
    await expect(operator.credentialVerifications.create({ delegation: "dlg_missing", credential_subject: "urn:customer:test" })).rejects.toMatchObject({ status: 403 });
    expect((await site.policies.list()).data[0]!.credentials).toBeNull();
  });

  test("credential support is advertised explicitly, not required", () => {
    const withCredentials = createDiscoveryProfile({ origin, apiBase, credentials: true });
    expect(validateDiscoveryProfile(withCredentials, origin)).toEqual(withCredentials);
    expect(withCredentials.capabilities).toContain("credential_presentations");
    expect(withCredentials.endpoints.credential_verifications).toBe(`${apiBase}/v1/credential_verifications`);
    expect(JSON.stringify(withCredentials)).not.toContain("trusted_issuers");
  });

  test("ignores unknown top-level data and validates configured profiles before serving", async () => {
    expect(validateDiscoveryProfile({ ...profile, private_key: "never publish me", trusted_issuers: ["not trusted"] })).toEqual(profile);
    await expect(createApp(new Store(join(dir, "invalid")), { discovery: { ...profile, version: "future" } as never })).rejects.toThrow();
  });

  test("caps chunked response bytes and cancels oversized streams", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(4096)); },
      cancel() { cancelled = true; },
    });
    const transport = (async (_u: string | URL | Request, _init?: RequestInit) => new Response(stream, { headers: { "content-type": "application/json" } })) as typeof fetch;
    await expect(discover(origin, { fetch: transport })).rejects.toThrow("32 KiB");
    expect(cancelled).toBe(true);
  });

  test("rejects malformed, mismatched, incompatible, and misleading profiles", async () => {
    for (const bad of [null, [], {}, { ...profile, version: "future" }, { ...profile, api_version: "future" }, { ...profile, origin: "https://other.example" }, { ...profile, capabilities: ["anything"] }, { ...profile, capabilities: ["delegations", "handoffs", "handoffs"] }, { ...profile, jwks_uri: "https://evil.example/keys" }, { ...profile, endpoints: { ...profile.endpoints, terms: "https://evil.example/terms" } }, { ...profile, endpoints: { ...profile.endpoints, credential_verifications: `${apiBase}/v1/credential_verifications` } }]) {
      await expect(discover(origin, { fetch: mock(bad) })).rejects.toThrow();
    }
  });

  test("requires HTTPS and an origin; local HTTP is explicit and loopback only", async () => {
    for (const bad of ["http://bank.example", "https://user:pass@bank.example", `${origin}/page`, `${origin}?x=1`, `${origin}#x`, "file:///etc/passwd", "http://127.0.0.1:4010"]) {
      await expect(discover(bad, { fetch: mock(profile) })).rejects.toThrow();
    }
    expect(() => createDiscoveryProfile({ origin: "http://bank.example", apiBase }, { allowLocal: true })).toThrow();
    const local = createDiscoveryProfile({ origin: "http://127.0.0.1:4010", apiBase: "http://localhost:4020" }, { allowLocal: true });
    expect(await discover(local.origin, { fetch: mock(local), allowLocal: true })).toEqual(local);
  });

  test("fails closed on missing, redirect, non-JSON, malformed JSON, and oversized responses", async () => {
    for (const fetch of [mock({}, 404), mock({}, 302), mock(profile, 200, { "content-type": "text/html" }), mock("x".repeat(32769)), (async (_u: string | URL | Request, _init?: RequestInit) => new Response("not json", { headers: { "content-type": "application/json" } })) as typeof globalThis.fetch]) {
      await expect(discover(origin, { fetch })).rejects.toThrow();
    }
    let signal: AbortSignal | null | undefined;
    await discover(origin, { fetch: (async (_u, init) => { signal = init?.signal; return new Response(JSON.stringify(profile), { headers: { "content-type": "application/json" } }); }) as typeof fetch });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("CLI generates and retrieves profiles without a login; never overwrites files", async () => {
    const run = async (...args: string[]) => {
      const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], { env: { ...process.env, AAP_CONFIG_DIR: join(dir, "no-login"), AAP_API_KEY: "sk_test_must_not_be_used" }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, exit };
    };
    const path = join(dir, "aap.json");
    expect((await run("discovery", "create", "--origin", origin, "--api-base", apiBase, "--out", path)).exit).toBe(0);
    expect(await Bun.file(path).json()).toEqual(profile);
    expect((await run("discovery", "create", "--origin", origin, "--api-base", apiBase, "--out", path)).exit).not.toBe(0);
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      expect(req.headers.has("authorization")).toBe(false);
      expect(new URL(req.url).pathname).toBe("/.well-known/aap");
      const local = createDiscoveryProfile({ origin: new URL(req.url).origin, apiBase }, { allowLocal: true });
      return Response.json(local);
    } });
    const port = server.port;
    try {
      const response = await run("discovery", "retrieve", `http://127.0.0.1:${server.port}`, "--allow-local");
      expect(response.exit).toBe(0);
      expect(JSON.parse(response.stdout).api_base).toBe(apiBase);
    } finally { server.stop(true); }

    // Exercise the documented create -> serve -> retrieve CLI workflow as well.
    const localOrigin = `http://127.0.0.1:${port}`;
    const localPath = join(dir, "local-aap.json");
    expect((await run("discovery", "create", "--origin", localOrigin, "--api-base", localOrigin, "--credentials", "--out", localPath, "--allow-local")).exit).toBe(0);
    const proc = Bun.spawn([process.execPath, "src/cli.ts", "serve", "--port", String(port), "--store", join(dir, "cli-store"), "--discovery", localPath, "--allow-local"], { stdout: "ignore", stderr: "pipe" });
    try {
      let ready = false;
      for (let i = 0; i < 50; i++) {
        try { ready = (await fetch(`${localOrigin}/.well-known/aap`)).ok; } catch { /* server starting */ }
        if (ready) break;
        await Bun.sleep(20);
      }
      expect(ready).toBe(true);
      const response = await run("discovery", "retrieve", localOrigin, "--allow-local");
      expect(response.exit).toBe(0);
      expect(JSON.parse(response.stdout)).toEqual(await Bun.file(localPath).json());
      expect(await Bun.file(join(dir, "no-login", "config.json")).exists()).toBe(false);
    } finally { proc.kill(); await proc.exited; }
  });
});
