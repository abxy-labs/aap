import type { Principal } from "./auth.ts";
import type { KeyFile } from "../lib/keys.ts";
import type { Store } from "../lib/store.ts";

export interface Ctx {
  req: Request;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  principal: Principal | null;
  store: Store;
  root: KeyFile;
  requestId: string;
  idempotencyKey: string | null;
  expand: string[];
}

export type Handler = (ctx: Ctx) => Promise<unknown>;

export interface Route {
  method: string;
  pattern: string;
  auth: "required" | "none";
  handler: Handler;
  status?: number;
}

export class Router {
  private routes: (Route & { regex: RegExp; keys: string[] })[] = [];

  add(method: string, pattern: string, handler: Handler, opts: { auth?: "required" | "none"; status?: number } = {}): void {
    const keys: string[] = [];
    const regex = new RegExp("^" + pattern.replace(/:([a-z_]+)/g, (_, k: string) => { keys.push(k); return "([^/]+)"; }) + "$");
    this.routes.push({ method, pattern, handler, auth: opts.auth ?? "required", status: opts.status, regex, keys });
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]!); });
      return { route: r, params };
    }
    return null;
  }

  allowed(path: string): string[] {
    return this.routes.filter((r) => r.regex.test(path)).map((r) => r.method);
  }
}
