/** Public site metadata. Discovery locates a service; it does not authorize it. */
export const DISCOVERY_VERSION = "2026-09-17";
export const DISCOVERY_API_VERSION = "2026-09-15";
export const DISCOVERY_PATH = "/.well-known/aap";
const MAX_BYTES = 32 * 1024;

export interface DiscoveryProfile {
  object: "aap_discovery";
  version: typeof DISCOVERY_VERSION;
  origin: string;
  api_version: typeof DISCOVERY_API_VERSION;
  api_base: string;
  capabilities: ("authorizations" | "customer_actions")[];
  endpoints: { authorizations: string; customer_actions: string };
  jwks_uri: string;
}

export interface DiscoveryOptions {
  /** Explicit development opt-in; permits HTTP only on literal loopback/localhost. */
  allowLocal?: boolean;
}

function url(value: unknown, opts: DiscoveryOptions): URL {
  if (typeof value !== "string") throw new Error("Discovery URLs must be strings.");
  const u = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.username || u.password || u.search || u.hash || (u.protocol !== "https:" && !(opts.allowLocal && local && u.protocol === "http:"))) {
    throw new Error("Discovery requires HTTPS URLs without credentials, queries, or fragments (explicit loopback development excepted).");
  }
  if (!opts.allowLocal && local) throw new Error("Local discovery requires allowLocal.");
  return u;
}

export function discoveryOrigin(value: unknown, opts: DiscoveryOptions = {}): string {
  const u = url(value, opts);
  if (u.pathname !== "/") throw new Error("Discovery requires an origin, not a page URL.");
  return u.origin;
}

/** Generate a static document to publish on the site's own origin. */
export function createDiscoveryProfile(input: { origin: string; apiBase: string }, opts: DiscoveryOptions = {}): DiscoveryProfile {
  const origin = discoveryOrigin(input.origin, opts);
  const base = url(input.apiBase, opts);
  if (base.pathname !== "/") throw new Error("The reference AAP API base must be an origin.");
  const api = base.origin;
  return {
    object: "aap_discovery", version: DISCOVERY_VERSION, origin,
    api_version: DISCOVERY_API_VERSION, api_base: api,
    capabilities: ["authorizations", "customer_actions"],
    endpoints: {
      authorizations: `${api}/v1/authorizations`, customer_actions: `${api}/v1/customer_actions`,
    },
    jwks_uri: `${api}/.well-known/foil-root`,
  };
}

/** Reject incompatible or ambiguous metadata; return only the supported public fields. */
export function validateDiscoveryProfile(value: unknown, expectedOrigin?: string, opts: DiscoveryOptions = {}): DiscoveryProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid AAP discovery document.");
  const p = value as Record<string, unknown>;
  if (p.object !== "aap_discovery" || p.version !== DISCOVERY_VERSION || p.api_version !== DISCOVERY_API_VERSION) throw new Error("Unsupported AAP discovery or API version.");
  const origin = discoveryOrigin(p.origin, opts);
  if (expectedOrigin && origin !== discoveryOrigin(expectedOrigin, opts)) throw new Error("Discovery origin does not match the site requested.");
  if (!Array.isArray(p.capabilities)
    || p.capabilities.some(c => !["authorizations", "customer_actions"].includes(c))
    || new Set(p.capabilities).size !== p.capabilities.length
    || !p.capabilities.includes("authorizations") || !p.capabilities.includes("customer_actions")) {
    throw new Error("Unsupported AAP discovery capabilities.");
  }
  const profile = createDiscoveryProfile({ origin, apiBase: p.api_base as string }, opts);
  if (!p.endpoints || typeof p.endpoints !== "object" || Array.isArray(p.endpoints)) throw new Error("Missing AAP discovery endpoints.");
  const endpoints = p.endpoints as Record<string, unknown>;
  if (Object.keys(endpoints).length !== Object.keys(profile.endpoints).length
    || Object.entries(profile.endpoints).some(([k, v]) => endpoints[k] !== v)
    || p.jwks_uri !== profile.jwks_uri) {
    throw new Error("Discovery endpoints must match the advertised API service and capabilities.");
  }
  return profile;
}

/** No bearer tokens, cookies, redirect following, key fetching, or configuration changes. */
export async function discover(origin: string, opts: DiscoveryOptions & { fetch?: typeof fetch } = {}): Promise<DiscoveryProfile> {
  const site = discoveryOrigin(origin, opts);
  const response = await (opts.fetch ?? fetch)(`${site}${DISCOVERY_PATH}`, {
    method: "GET", headers: { accept: "application/json" }, credentials: "omit", redirect: "error",
    referrerPolicy: "no-referrer", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || response.redirected) {
    await response.body?.cancel();
    throw new Error(`AAP discovery failed (${response.status}).`);
  }
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel();
    throw new Error("AAP discovery must return application/json.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty AAP discovery response.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("AAP discovery exceeds 32 KiB.");
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return validateDiscoveryProfile(JSON.parse(new TextDecoder().decode(bytes)), site, opts);
}
