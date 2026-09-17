import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, SignJWT } from "jose";
import type { JWK } from "jose";
import type { CredentialPolicy, CredentialTrust, CredentialVerification, PolicyClaims, PresentedEvidence } from "../types.ts";
import { invalid } from "./errors.ts";
import type { KeyFile } from "./keys.ts";
import { sha, type Store } from "./store.ts";

export const VC_CONTEXT = "https://www.w3.org/ns/credentials/v2";
/** Bind to exact policy contents too: the reference store does not serialize policy version allocation. */
export const credentialPolicyHash = (policy: PolicyClaims) => sha(JSON.stringify(policy));
const VC_DATA = "data:application/vc+jwt,";
const MAX_TOKEN = 32_768;
const MAX_LIFETIME = 3600;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function fail(message: string): never { throw invalid("credential_invalid", message, "presentation"); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uri = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9+.-]*:\S+$/i.test(v);
const https = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try { const u = new URL(v); return u.protocol === "https:" && !!u.hostname && !u.username && !u.password && !u.hash; } catch { return false; }
};
function same(a: unknown, b: unknown): boolean {
  if (object(a) && object(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => own(b, k) && same(a[k], b[k]));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  return a === b;
}
function timestamp(v: unknown): number {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)) return fail("Expected a UTC date-time.");
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== v.slice(0, 19)) return fail("Invalid date-time.");
  return ms / 1000;
}
function fields(v: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k))) fail("Unsupported field in this credential profile.");
}
function publicKey(key: unknown): key is JWK & { kid: string } {
  return object(key) && key.kty === "EC" && key.crv === "P-256" && typeof key.x === "string" && typeof key.y === "string"
    && typeof key.kid === "string" && !!key.kid && Object.keys(key).every(k => ["kty", "crv", "x", "y", "kid", "alg", "use", "key_ops", "ext"].includes(k))
    && (key.alg === undefined || key.alg === "ES256") && (key.use === undefined || key.use === "sig")
    && (key.key_ops === undefined || same(key.key_ops, ["verify"]));
}

/** Validate trust configuration before it can be signed into a site's policy. */
export async function validateCredentialPolicy(p: CredentialPolicy | null | undefined): Promise<void> {
  if (p == null) return;
  const err = () => invalid("invalid_credential_policy", "Use explicit types, issuers, claims and ES256 trust rules with pinned contexts and a maximum age of 1–3600 seconds.", "credentials");
  if (!object(p) || ![p.types, p.issuers, p.claims].every(a => Array.isArray(a) && a.length > 0 && a.length <= 32 && a.every(v => typeof v === "string" && !!v))) throw err();
  if (p.trust === undefined) return; // Legacy configuration remains fail-closed, never trusted implicitly.
  if (!Array.isArray(p.trust) || p.trust.length === 0 || p.trust.length > 32) throw err();
  for (const r of p.trust) {
    if (!object(r) || !https(r.issuer) || !p.issuers.includes(r.issuer) || !p.types.includes(r.type) || r.type === "VerifiableCredential"
      || !publicKey(r.key) || !object(r.context) || !object(r.claims) || !Number.isInteger(r.max_age_s) || r.max_age_s < 1 || r.max_age_s > MAX_LIFETIME) throw err();
    const reserved = ["@context", "id", "type", "issuer", "credentialSubject", "validFrom", "validUntil", "name", "description", "holder", "verifiableCredential", "credentialStatus", "credentialSchema", "evidence", "termsOfUse", "refreshService", "renderMethod", "relatedResource", "confidenceMethod", "proof", "__proto__", "constructor", "prototype"];
    if (!Object.keys(r.context).length || Object.entries(r.context).some(([k, v]) => reserved.includes(k) || k.startsWith("@") || !uri(v))
      || !own(r.context, r.type) || !own(r.context, "checkedAt")
      || [...p.claims, ...Object.keys(r.claims)].some(k => !own(r.context, k) || k === r.type || k === "checkedAt")
      || Object.values(r.claims).some(v => !["string", "number", "boolean"].includes(typeof v) || (typeof v === "number" && !Number.isFinite(v)))) throw err();
    try { await importJWK(r.key as JWK, "ES256"); } catch { throw err(); }
  }
}

function validateBody(body: unknown, now: number): asserts body is Record<string, unknown> {
  if (!object(body)) fail("Credential must be an object.");
  fields(body, ["@context", "id", "type", "issuer", "validFrom", "validUntil", "credentialSubject"]);
  if (!Array.isArray(body["@context"]) || body["@context"].length !== 2 || body["@context"][0] !== VC_CONTEXT || !object(body["@context"][1])
    || !Array.isArray(body.type) || body.type.length !== 2 || body.type[0] !== "VerifiableCredential" || typeof body.type[1] !== "string"
    || !https(body.issuer) || !uri(body.id) || !object(body.credentialSubject) || !uri(body.credentialSubject.id)) fail("Unsupported VC Data Model 2.0 profile.");
  const from = timestamp(body.validFrom), until = timestamp(body.validUntil);
  const checked = timestamp(body.credentialSubject.checkedAt);
  if (from > now || until <= now || until <= from || until - from > MAX_LIFETIME || checked > from || checked > now) fail("Credential is expired, future-dated, or exceeds the one-hour lifetime.");
  for (const [k, v] of Object.entries(body.credentialSubject)) {
    if (k !== "id" && (!own(body["@context"][1], k) || !["string", "number", "boolean"].includes(typeof v))) fail("All subject claims must be flat, defined terms.");
  }
}

/** Offline issuer-managed signing; the private key never goes to the API. */
export async function issueCredential(body: unknown, key: KeyFile, now = Date.now() / 1000): Promise<string> {
  validateBody(body, now);
  if (key.alg !== "ES256") fail("This profile supports ES256 only.");
  const token = await new SignJWT(body).setProtectedHeader({ alg: "ES256", typ: "vc+jwt", kid: key.kid }).sign(await importJWK(key.private, "ES256"));
  if (token.length > MAX_TOKEN) fail("Credential is too large.");
  return token;
}

/** Organization-held presentation, not customer wallet proof. No new attestation envelope. */
export async function presentCredential(credential: string, request: CredentialVerification, key: KeyFile): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (credential.length > MAX_TOKEN || !request || !https(request.audience) || typeof request.nonce !== "string" || !request.nonce || !Number.isInteger(request.expires_at)) fail("Invalid credential/request.");
  const body = decodeJwt(credential);
  validateBody(body, now);
  if (key.alg !== "ES256" || request.status !== "pending" || request.expires_at <= now || body.credentialSubject && (body.credentialSubject as Record<string, unknown>).id !== request.credential_subject) fail("Credential/request mismatch or expired request.");
  const token = await new SignJWT({
    "@context": [VC_CONTEXT], type: ["VerifiablePresentation"], holder: body.issuer,
    verifiableCredential: [{ "@context": [VC_CONTEXT], type: ["EnvelopedVerifiableCredential"], id: VC_DATA + credential }],
    nonce: request.nonce,
  }).setProtectedHeader({ alg: "ES256", typ: "vp+jwt", kid: key.kid }).setAudience(request.audience)
    .setIssuedAt(now).setExpirationTime(Math.min(now + 300, request.expires_at)).sign(await importJWK(key.private, "ES256"));
  if (token.length > MAX_TOKEN) fail("Presentation is too large.");
  return token;
}

async function verified(token: string, rule: CredentialTrust, typ: string, now: number) {
  if (typeof token !== "string" || token.length > MAX_TOKEN) fail("Credential or presentation is too large.");
  const h = decodeProtectedHeader(token);
  if (h.alg !== "ES256" || ![typ, `application/${typ}`].includes(h.typ ?? "") || h.kid !== rule.key.kid
    || Object.keys(h).some(k => !["alg", "typ", "kid"].includes(k))) fail("Unexpected signing header.");
  return (await jwtVerify(token, await importJWK(rule.key as JWK, "ES256"), { algorithms: ["ES256"], currentDate: new Date(now * 1000) })).payload;
}

export async function verifyCredentialPresentation(token: string, request: CredentialVerification, p: CredentialPolicy, now = Date.now() / 1000): Promise<PresentedEvidence> {
  try {
    if (typeof token !== "string" || token.length > MAX_TOKEN || request.expires_at <= now || request.status !== "pending") fail("Expired or consumed verification request.");
    const hint = decodeJwt(token);
    const rules = p.trust?.filter(r => r.issuer === hint.holder && p.issuers.includes(r.issuer) && p.types.includes(r.type)) ?? [];
    for (const rule of rules) {
      try {
        const vp = await verified(token, rule, "vp+jwt", now);
        fields(vp, ["@context", "type", "holder", "verifiableCredential", "nonce", "aud", "iat", "exp"]);
        if (!same(vp["@context"], [VC_CONTEXT]) || !same(vp.type, ["VerifiablePresentation"]) || vp.holder !== rule.issuer
          || vp.aud !== request.audience || vp.nonce !== request.nonce || !Number.isInteger(vp.iat) || !Number.isInteger(vp.exp)
          || vp.iat! > now || vp.iat! < request.created || vp.exp! > request.expires_at || vp.exp! - vp.iat! > 300
          || !Array.isArray(vp.verifiableCredential) || vp.verifiableCredential.length !== 1) fail("Invalid presentation bindings.");
        const envelope = vp.verifiableCredential[0];
        if (!object(envelope)) fail("Expected enveloped credential.");
        fields(envelope, ["@context", "type", "id"]);
        if (!same(envelope["@context"], [VC_CONTEXT]) || !same(envelope.type, ["EnvelopedVerifiableCredential"]) || typeof envelope.id !== "string" || !envelope.id.startsWith(VC_DATA)) fail("Expected a vc+jwt data URI.");
        const vc = await verified(envelope.id.slice(VC_DATA.length), rule, "vc+jwt", now);
        validateBody(vc, now);
        const subject = vc.credentialSubject as Record<string, unknown>;
        if (vc.issuer !== rule.issuer || !same(vc.type, ["VerifiableCredential", rule.type]) || !same(vc["@context"], [VC_CONTEXT, rule.context])
          || subject.id !== request.credential_subject || p.claims.some(k => !own(subject, k))
          || Object.entries(rule.claims).some(([k, v]) => subject[k] !== v)) fail("Credential does not satisfy institution policy.");
        const expires = Math.min(timestamp(vc.validUntil), timestamp(subject.checkedAt) + rule.max_age_s);
        if (expires <= now) fail("Credential check is too old.");
        // No personal claims or VC/VP tokens leave this verifier or enter a grant/event.
        return { type: rule.type, issuer: rule.issuer, holder_bound: false, claims: {}, verified_at: new Date(now * 1000).toISOString(), verification: request.id, expires_at: expires };
      } catch { /* Another explicitly pinned key/rule may match, including rotation. */ }
    }
  } catch { /* Untrusted inputs get one bounded, non-disclosing error. */ }
  return fail("Presentation failed signature, trust, freshness, or binding checks.");
}

/** Live sidecar evidence, intentionally not embedded into a reusable delegation certificate. */
export async function activeCredentialEvidence(store: Store, delegation: string, policy: PolicyClaims, now = Date.now() / 1000): Promise<PresentedEvidence | null> {
  if (!policy.credentials?.trust?.length) return null;
  const requests = await store.listCredentialVerifications(delegation);
  const policyHash = credentialPolicyHash(policy);
  return requests.find(r => r.status === "verified" && r.origin === policy.sub && r.policy_version === policy.version && r.policy_hash === policyHash && r.evidence && r.evidence.expires_at! > now)?.evidence ?? null;
}
