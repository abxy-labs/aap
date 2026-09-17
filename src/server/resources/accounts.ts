import type { Attestation, OperatorObject } from "../../types.ts";
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
    if (type !== "operator" && type !== "site") throw invalid("parameter_invalid", "type must be operator or site.", "type");
    const name = str(body, "name", true)!;
    let operator: OperatorObject | null = null;
    let operatorId: string | null = null;
    if (type === "operator") {
      const key = obj<JsonWebKey>(body, "public_key", true)!;
      operatorId = id("op");
      const rawAtt = body.attestations;
      if (rawAtt !== undefined && (!Array.isArray(rawAtt) || rawAtt.some((a) => !a || typeof a !== "object" || typeof (a as Attestation).type !== "string" || typeof (a as Attestation).issuer !== "string"))) {
        throw invalid("parameter_invalid", "attestations must be a list of objects with type and issuer.", "attestations");
      }
      const attestations = (rawAtt as Attestation[] | undefined) ?? [];
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
    const { account, keys } = await createAccount(store, { type, name, operator: operatorId });
    if (operator) {
      operator.account = account.id;
      await store.putOperatorObject(operator);
    }
    return { account, keys, ...(operator ? { operator } : {}) };
  }, { auth: "none" });

  r.add("GET", "/v1/account", async ({ store, principal }) => {
    const account = principal!.account;
    const operator = account.operator ? await store.getOperatorObject(account.operator) : null;
    return { ...account, ...(operator ? { operator } : {}) };
  });
}
