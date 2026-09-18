import type { Acceptance, TermsObject, ObjectBase } from "../types.ts";
export type AuthorizationAcceptance = Omit<Acceptance, "terms">;
export interface Authorization extends ObjectBase {
  object: "authorization";
  status: "pending_consent" | "active" | "revoked" | "expired";
  agent: string;
  operator: string;
  origin: string;
  subject: string;
  intent: string;
  consent: {
    revision: string;
    scopes: TermsObject["scopes"];
    constraints: TermsObject["constraints"];
    disclosures: TermsObject["disclosures"];
    max_age_s: number;
  };
  expires_at: number;
  revoked_by?: string | null;
  revoked_at?: number | null;
}
export interface AuthorizationAcceptParams {
  revision: string;
  acceptance: AuthorizationAcceptance;
  site_session?: string | null;
  attestations?: string[];
}
export interface StoredAuthorization extends Authorization {
  terms: string;
  delegation: string | null;
  acceptance_hash?: string;
}
export function authorizationSigningPayload(
  id: string,
  p: AuthorizationAcceptParams,
): string {
  const a = p.acceptance;
  const acceptance = {
    acknowledged: a.acknowledged,
    viewed: a.viewed,
    channel: a.channel,
    accepted_at: a.accepted_at,
    ...(a.copies_sent_to ? { copies_sent_to: a.copies_sent_to } : {}),
  };
  return JSON.stringify({
    authorization: id,
    revision: p.revision,
    acceptance,
    site_session: p.site_session ?? null,
    attestations: p.attestations ?? null,
  });
}
