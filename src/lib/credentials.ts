import { SignJWT, decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import type { AttestationPolicy } from "../types.ts";
import { invalid } from "./errors.ts";
import { algOf, importPrivate, type KeyFile } from "./keys.ts";

/** The base context every credential in this profile carries. */
export const VC_CONTEXT = "https://www.w3.org/ns/credentials/v2";
export const VC_TYP = "vc+jwt";
/** Subjects are the delegation's pseudonymous subject, so an issuer never needs the consumer's identity. */
export const SUBJECT_PREFIX = "urn:aap:subject:";
const MAX_TOKEN = 16_384;

export interface CredentialBody {
  "@context": unknown[];
  id?: string;
  type: string[];
  issuer: string;
  validFrom: string;
  validUntil: string;
  credentialSubject: { id: string } & Record<string, unknown>;
}

/** The fields this profile reads. A credential that carries more is accepted; the extra fields are ignored. */
export interface VerifiedCredential {
  issuer: string;
  type: string;
  subject: string;
  claims: Record<string, string | number | boolean>;
  issued_at: number;
  valid_until: number;
}

function fail(message: string): never {
  throw invalid("credential_invalid", message, "credential");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

function seconds(value: unknown, field: string): number {
  if (typeof value !== "string") fail(`${field} must be an XMLSchema date-time string.`);
  const ms = Date.parse(value as string);
  if (!Number.isFinite(ms)) fail(`${field} is not a valid date-time.`);
  return Math.floor(ms / 1000);
}

/** The credential type, which is the one type beyond VerifiableCredential. */
function credentialType(types: unknown): string {
  if (!Array.isArray(types) || types[0] !== "VerifiableCredential") fail("type must begin with VerifiableCredential.");
  const rest = types.slice(1).filter((t) => typeof t === "string");
  if (rest.length !== 1) fail("This profile expects exactly one credential type beyond VerifiableCredential.");
  return rest[0] as string;
}

function readBody(payload: Record<string, unknown>): VerifiedCredential {
  const contexts = payload["@context"];
  if (!Array.isArray(contexts) || contexts[0] !== VC_CONTEXT) fail(`@context must begin with ${VC_CONTEXT}.`);
  if (typeof payload.issuer !== "string" || !payload.issuer) fail("issuer must be a string.");
  const subject = payload.credentialSubject;
  if (!isObject(subject) || typeof subject.id !== "string" || !subject.id) fail("credentialSubject.id is required.");
  const issued = seconds(payload.validFrom, "validFrom");
  const until = seconds(payload.validUntil, "validUntil");
  if (until <= issued) fail("validUntil must be after validFrom.");
  const claims: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(subject)) {
    if (k !== "id" && isPrimitive(v)) claims[k] = v;
  }
  return { issuer: payload.issuer, type: credentialType(payload.type), subject: subject.id, claims, issued_at: issued, valid_until: until };
}

/** Sign a credential with the issuer's own key. Private keys never reach the API. */
export async function issueCredential(body: CredentialBody, key: KeyFile): Promise<string> {
  const parsed = readBody(body as unknown as Record<string, unknown>);
  const token = await new SignJWT(body as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: algOf(key.public), typ: VC_TYP, kid: key.kid })
    .sign(await importPrivate(key.private));
  if (token.length > MAX_TOKEN) fail("Credential is too large.");
  void parsed;
  return token;
}

/** Build a credential body for a subject, with the claims an issuer wants to state. */
export function credentialBody(input: {
  issuer: string;
  type: string;
  subject: string;
  claims: Record<string, string | number | boolean>;
  context?: string[];
  validFrom?: Date;
  validUntil: Date;
}): CredentialBody {
  return {
    "@context": [VC_CONTEXT, ...(input.context ?? [])],
    type: ["VerifiableCredential", input.type],
    issuer: input.issuer,
    validFrom: (input.validFrom ?? new Date()).toISOString(),
    validUntil: input.validUntil.toISOString(),
    credentialSubject: { id: input.subject, ...input.claims },
  };
}

/** A key the site has registered, and the issuer it belongs to. */
export interface IssuerKey {
  issuer: string;
  key: JWK & { kid: string };
}

/**
 * Verify a credential against the keys a site has registered. Keys come from the registry, never
 * from the token, and only keys belonging to the issuer the credential names are tried, so a
 * credential cannot be signed by one registered issuer while naming another.
 */
export async function verifyCredential(token: string, keys: IssuerKey[], now = Math.floor(Date.now() / 1000)): Promise<VerifiedCredential> {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN) fail("Credential is missing or too large.");
  let header: { alg?: string; typ?: string; kid?: string };
  let named: string;
  try {
    header = decodeProtectedHeader(token);
    const claimed = decodeJwt(token).issuer;
    if (typeof claimed !== "string" || !claimed) fail("issuer must be a string.");
    named = claimed;
  } catch (e) {
    if (e instanceof Error && e.message.includes("issuer must be")) throw e;
    return fail("Credential is not a signed JWT.");
  }
  if (header.typ !== VC_TYP && header.typ !== `application/${VC_TYP}`) fail(`Credential must use the ${VC_TYP} media type.`);
  let candidates = keys.filter((k) => k.issuer === named);
  if (!candidates.length) throw invalid("issuer_not_accepted", `This site does not accept attestations from ${named}.`, "credential");
  if (header.kid) candidates = candidates.filter((k) => k.key.kid === header.kid);
  if (!candidates.length) fail("No key registered for this issuer matches the credential's key id.");
  for (const { key } of candidates) {
    try {
      const { payload } = await jwtVerify(token, await importJWK(key, algOf(key)), { currentDate: new Date(now * 1000) });
      const parsed = readBody(payload as Record<string, unknown>);
      if (parsed.issuer !== named) fail("Credential issuer changed between decoding and verification.");
      if (parsed.valid_until <= now) fail("Credential has expired.");
      if (parsed.issued_at > now + 300) fail("Credential is future-dated.");
      return parsed;
    } catch (e) {
      if (e instanceof Error && e.message.includes("credential_invalid")) throw e;
      continue;
    }
  }
  return fail("Credential signature did not verify against a key registered for this issuer.");
}

/** Check a verified credential against a site's attestation policy. */
export function checkAgainstPolicy(vc: VerifiedCredential, policy: AttestationPolicy, expectedSubject: string, now = Math.floor(Date.now() / 1000)): void {
  if (!policy.types.includes(vc.type)) throw invalid("attestation_type_not_accepted", `This site does not accept ${vc.type} attestations.`, "credential");
  if (vc.subject !== expectedSubject) throw invalid("attestation_subject_mismatch", `The credential names subject ${vc.subject}, not this delegation's subject.`, "credential");
  const missing = policy.claims.filter((c) => !(c in vc.claims));
  if (missing.length) throw invalid("attestation_claims_missing", `The credential is missing claims this site requires: ${missing.join(", ")}.`, "credential");
  if (policy.max_age_s !== undefined && now - vc.issued_at > policy.max_age_s) {
    throw invalid("attestation_too_old", `The credential was issued more than ${policy.max_age_s} seconds ago.`, "credential");
  }
}

/** Only the claims the site's policy names are kept; everything else is discarded. */
export function retainedClaims(vc: VerifiedCredential, policy: AttestationPolicy): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const name of policy.claims) {
    if (name in vc.claims) out[name] = vc.claims[name]!;
  }
  return out;
}

export function validateAttestationPolicy(p: AttestationPolicy | null | undefined): void {
  if (p == null) return;
  const bad = (message: string) => invalid("invalid_attestation_policy", message, "attestations");
  if (!isObject(p)) throw bad("attestations must be an object.");
  for (const field of ["issuers", "types", "claims"] as const) {
    const v = p[field];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) throw bad(`attestations.${field} must be a list of strings.`);
  }
  if (!p.issuers.length) throw bad("attestations.issuers must name at least one issuer, or \"operator\".");
  if (!p.types.length) throw bad("attestations.types must name at least one credential type.");
  if (p.max_age_s !== undefined && (!Number.isInteger(p.max_age_s) || p.max_age_s < 1)) throw bad("attestations.max_age_s must be a positive integer.");
}
