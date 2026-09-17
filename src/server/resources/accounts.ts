import type { IssuerObject, OperatorAttestation, OperatorObject } from "../../types.ts";
import { issueOperator } from "../../lib/certs.ts";
import { invalid } from "../../lib/errors.ts";
import { decode } from "../../lib/jwt.ts";
import { id, now } from "../../lib/store.ts";
import { createAccount } from "../auth.ts";
import { list, obj, str } from "../params.ts";
import type { Router } from "../router.ts";

export function accountRoutes(r: Router): void {
  // Reference-server stand-in for onboarding. In production, operator vetting and site setup happen out of band.
  r.add("POST", "/v1/accounts", async ({ store, root, body }) => {
    const type = str(body, "type", true)!;
    if (type !== "operator" && type !== "site" && type !== "issuer") throw invalid("parameter_invalid", "type must be operator, site, or issuer.", "type");
    const name = str(body, "name", true)!;
    let operator: OperatorObject | null = null;
    let operatorId: string | null = null;
    if (type === "operator") {
      const key = obj<JsonWebKey>(body, "public_key", true)!;
      operatorId = id("op");
      const rawAtt = body.attestations;
      if (rawAtt !== undefined && (!Array.isArray(rawAtt) || rawAtt.some((a) => !a || typeof a !== "object" || typeof (a as OperatorAttestation).type !== "string" || typeof (a as OperatorAttestation).issuer !== "string"))) {
        throw invalid("parameter_invalid", "attestations must be a list of objects with type and issuer.", "attestations");
      }
      const attestations = (rawAtt as OperatorAttestation[] | undefined) ?? [];
      const asn = list(body, "asn");
      const ja4 = list(body, "ja4");
      const certificate = await issueOperator(root, {
        id: operatorId,
        key,
        vetting: str(body, "vetting") ?? "standard",
        sessionHandling: str(body, "session_handling") ?? "unspecified",
        attestations,
        ...(asn || ja4 ? { profile: { ...(asn ? { asn } : {}), ...(ja4 ? { ja4 } : {}) } } : {}),
      });
      const claims = decode<{ exp: number }>(certificate).claims;
      operator = {
        id: operatorId, object: "operator", created: now(), account: null, name,
        vetting: str(body, "vetting") ?? "standard", session_handling: str(body, "session_handling") ?? "unspecified",
        attestations, ...(asn || ja4 ? { profile: { ...(asn ? { asn } : {}), ...(ja4 ? { ja4 } : {}) } } : {}),
        public_key: key, certificate, expires_at: claims.exp,
      };
    }
    let issuer: IssuerObject | null = null;
    let issuerId: string | null = null;
    if (type === "issuer") {
      const url = str(body, "url", true)!;
      if (!/^https:\/\/[^\s/]+$/.test(url)) throw invalid("parameter_invalid", "url must be an https origin, which is the issuer identifier credentials carry.", "url");
      const keyList = (body.public_keys ?? (body.public_key ? [body.public_key] : [])) as (JsonWebKey & { kid?: string })[];
      if (!Array.isArray(keyList) || !keyList.length || keyList.some((k) => !k || typeof k !== "object" || typeof k.kid !== "string" || !k.kid || "d" in k)) {
        throw invalid("parameter_invalid", "public_keys must be a list of public JWKs, each with a kid.", "public_keys");
      }
      issuerId = id("iss");
      issuer = { id: issuerId, object: "issuer", created: now(), account: null, name, url, public_keys: keyList as (JsonWebKey & { kid: string })[], status: "active" };
    }
    const { account, keys } = await createAccount(store, { type, name, operator: operatorId, issuer: issuerId });
    if (issuer) {
      issuer.account = account.id;
      await store.putIssuer(issuer);
    }
    if (operator) {
      operator.account = account.id;
      await store.putOperatorObject(operator);
    }
    return { account, keys, ...(operator ? { operator } : {}), ...(issuer ? { issuer } : {}) };
  }, { auth: "none" });

  r.add("GET", "/v1/account", async ({ store, principal }) => {
    const account = principal!.account;
    const operator = account.operator ? await store.getOperatorObject(account.operator) : null;
    const issuer = account.issuer ? await store.getIssuer(account.issuer) : null;
    return { ...account, ...(operator ? { operator } : {}), ...(issuer ? { issuer } : {}) };
  });
}
