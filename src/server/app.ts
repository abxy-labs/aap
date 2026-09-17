import { ApiError } from "../lib/errors.ts";
import { DISCOVERY_PATH, validateDiscoveryProfile, type DiscoveryProfile } from "../lib/discovery.ts";
import { generateKeyFile } from "../lib/keys.ts";
import type { KeyFile } from "../lib/keys.ts";
import { Store, id, sha } from "../lib/store.ts";
import { authenticate, type Principal } from "./auth.ts";
import { API_VERSION, errorBody, expand } from "./envelope.ts";
import { accountRoutes } from "./resources/accounts.ts";
import { agentRoutes } from "./resources/agents.ts";
import { delegationRoutes } from "./resources/delegations.ts";
import { directoryRoutes } from "./resources/directory.ts";
import { eventRoutes } from "./resources/events.ts";
import { handoffRoutes } from "./resources/handoffs.ts";
import { policyRoutes } from "./resources/policies.ts";
import { sessionRoutes } from "./resources/sessions.ts";
import { termsRoutes } from "./resources/terms.ts";
import { testHelperRoutes } from "./resources/test_helpers.ts";
import { webhookRoutes } from "./resources/webhook_endpoints.ts";
import { Router } from "./router.ts";

export interface LogEntry {
  seq: number;
  id: string;
  time: number;
  method: string;
  path: string;
  status: number;
  ms: number;
  account: string | null;
  livemode: boolean | null;
  error?: string;
}

export interface App {
  fetch(req: Request): Promise<Response>;
  logs(after?: number, limit?: number): LogEntry[];
  store: Store;
  root: KeyFile;
}

export interface AppOptions {
  /** Explicit institution profile. Omitted on shared APIs unless deliberately configured. */
  discovery?: DiscoveryProfile;
  allowLocalDiscovery?: boolean;
}

/** Build the reference API over a store. Creates the root key on first use. */
export async function createApp(baseStore: Store, opts: AppOptions = {}): Promise<App> {
  const discovery = opts.discovery ? validateDiscoveryProfile(opts.discovery, undefined, { allowLocal: opts.allowLocalDiscovery }) : null;
  const discoveryBody = discovery ? JSON.stringify(discovery, null, 2) : null;
  const discoveryEtag = discoveryBody ? `"${sha(discoveryBody)}"` : "";
  if (!(await baseStore.exists())) await baseStore.init(await generateKeyFile());
  const root = await baseStore.root();
  const router = new Router();
  accountRoutes(router);
  agentRoutes(router);
  policyRoutes(router);
  termsRoutes(router);
  delegationRoutes(router);
  sessionRoutes(router);
  handoffRoutes(router);
  eventRoutes(router);
  webhookRoutes(router);
  directoryRoutes(router);
  testHelperRoutes(router);
  router.add("GET", "/v1/health", async () => ({ object: "health", status: "ok", api_version: API_VERSION }), { auth: "none" });
  router.add("GET", "/.well-known/foil-root", async () => ({ keys: [root.public] }), { auth: "none" });

  const logs: LogEntry[] = [];
  let seq = 0;

  function json(body: unknown, status: number, requestId: string, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { "content-type": "application/json", "request-id": requestId, "aap-version": API_VERSION, ...extra },
    });
  }

  async function handle(req: Request): Promise<Response> {
    const started = performance.now();
    const requestId = id("req");
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    let principal: Principal | null = null;
    let status = 200;
    let errorCode: string | undefined;
    let idempotency: { store: Store; account: string; key: string; requestHash: string } | null = null;
    try {
      if (path === DISCOVERY_PATH && discovery && url.origin === discovery.origin) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          status = 405;
          return new Response(null, { status, headers: { allow: "GET, HEAD" } });
        }
        const headers = { "content-type": "application/json", "cache-control": "public, max-age=300", etag: discoveryEtag, "access-control-allow-origin": "*" };
        const tags = req.headers.get("if-none-match")?.split(",").map(v => v.trim().replace(/^W\//, ""));
        if (tags?.includes(discoveryEtag) || tags?.includes("*")) {
          status = 304;
          return new Response(null, { status, headers });
        }
        return new Response(req.method === "HEAD" ? null : discoveryBody, { status: 200, headers });
      }
      if (path === "/v1/dev/logs" && req.method === "GET") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return json({ object: "list", data: logs.filter((l) => l.seq > after).slice(-limit) }, 200, requestId);
      }
      const requested = req.headers.get("aap-version");
      if (requested && requested !== API_VERSION) {
        throw new ApiError(400, "invalid_request_error", "invalid_api_version", `Unknown API version '${requested}'. This server speaks ${API_VERSION}.`);
      }
      const match = router.match(req.method, path);
      if (!match) {
        const allowed = router.allowed(path);
        if (allowed.length) throw new ApiError(405, "invalid_request_error", "method_not_allowed", `${req.method} is not allowed on ${path}. Allowed: ${allowed.join(", ")}.`);
        throw new ApiError(404, "invalid_request_error", "unknown_endpoint", `Unrecognized request URL (${req.method}: ${path}).`);
      }
      let body: Record<string, unknown> = {};
      const raw = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
      if (raw) {
        const ct = req.headers.get("content-type") ?? "";
        try {
          if (ct.includes("application/x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(raw));
          else body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          throw new ApiError(400, "invalid_request_error", "invalid_json", "The request body is not valid JSON.");
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_request_error", "invalid_json", "The request body must be a JSON object.");
      }
      let store = baseStore;
      if (match.route.auth === "required") {
        principal = await authenticate(baseStore, req);
        store = baseStore.mode(principal.livemode);
      }
      const idempotencyKey = req.method === "POST" ? req.headers.get("idempotency-key") : null;
      const requestHash = sha(`${req.method} ${path} ${raw}`);
      if (idempotencyKey && principal) {
        const prior = await store.getIdempotency(principal.account.id, idempotencyKey);
        if (prior) {
          if (prior.request_hash !== requestHash) {
            throw new ApiError(400, "idempotency_error", "idempotency_key_reused", `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${idempotencyKey}'.`);
          }
          status = prior.status;
          return json(prior.body, prior.status, requestId, { "idempotent-replayed": "true" });
        }
        idempotency = { store, account: principal.account.id, key: idempotencyKey, requestHash };
      }
      const expandPaths = [...url.searchParams.getAll("expand[]"), ...(url.searchParams.get("expand")?.split(",") ?? []), ...((body.expand as string[] | undefined) ?? [])].filter(Boolean);
      delete body.expand;
      const result = await match.route.handler({ req, params: match.params, query: url.searchParams, body, principal, store, root, requestId, idempotencyKey, expand: expandPaths });
      const expanded = await expand(store, result, expandPaths);
      status = match.route.status ?? 200;
      if (idempotency) {
        await idempotency.store.putIdempotency(idempotency.account, idempotency.key, { request_hash: idempotency.requestHash, status, body: expanded, created: Math.floor(Date.now() / 1000) });
      }
      return json(expanded, status, requestId);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, "api_error", "internal_error", e instanceof Error ? e.message : String(e));
      status = err.status;
      errorCode = err.code;
      if (!(e instanceof ApiError)) console.error(`[${requestId}]`, e);
      const body = errorBody(err, requestId);
      if (idempotency) {
        await idempotency.store.putIdempotency(idempotency.account, idempotency.key, { request_hash: idempotency.requestHash, status, body, created: Math.floor(Date.now() / 1000) });
      }
      return json(body, err.status, requestId);
    } finally {
      logs.push({ seq: ++seq, id: requestId, time: Date.now(), method: req.method, path, status, ms: Math.round(performance.now() - started), account: principal?.account.id ?? null, livemode: principal?.livemode ?? null, ...(errorCode ? { error: errorCode } : {}) });
      if (logs.length > 2000) logs.splice(0, logs.length - 2000);
    }
  }

  return { fetch: handle, logs: (after = 0, limit = 100) => logs.filter((l) => l.seq > after).slice(-limit), store: baseStore, root };
}

export interface RunningServer {
  url: string;
  port: number;
  app: App;
  stop(): void;
}

export async function startServer(opts: { store: Store; port?: number; hostname?: string } & AppOptions): Promise<RunningServer> {
  const app = await createApp(opts.store, opts);
  const server = Bun.serve({ port: opts.port ?? 4010, hostname: opts.hostname ?? "127.0.0.1", fetch: (req) => app.fetch(req) });
  return { url: `http://${opts.hostname ?? "127.0.0.1"}:${server.port}`, port: server.port ?? 0, app, stop: () => server.stop(true) };
}
