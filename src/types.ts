export type Tier = "observe" | "read" | "manage" | "transact" | "control";

export interface Money {
  value: number;
  currency: string;
}

export interface Constraints {
  max_amount?: Money;
  max_total?: Money;
  max_count?: number;
  payees?: "existing_only" | "any";
  ttl_s?: number;
}

export interface Ceiling {
  scopes: string[];
  constraints: Constraints;
}

export interface OperatorProfile {
  asn?: string[];
  ja4?: string[];
}

export interface OperatorClaims {
  iss: "foil";
  sub: string;
  key: JsonWebKey;
  vetting: string;
  session_handling: string;
  profile?: OperatorProfile;
  iat: number;
  nbf: number;
  exp: number;
}

export interface AgentClaims {
  iss: string;
  sub: string;
  name: string;
  key: JsonWebKey;
  ceiling: Ceiling;
  iat: number;
  nbf: number;
  exp: number;
}

export interface DisclosureDocument {
  id: string;
  title: string;
  url: string;
  format: string;
  sha256: string;
  render: "full" | "link";
}

export interface DisclosureBundle {
  bundle: string;
  presentation: "app" | "site";
  gates?: string[];
  documents: DisclosureDocument[];
  acknowledgements: { id: string; text: string }[];
  retain: "copy_required" | "none";
}

export type Evidence = "asserted" | "observed" | "site";

export interface PolicyClaims {
  iss: "foil";
  sub: string;
  version: number;
  tier: Tier | "none";
  allow: { operators: string[] | "any"; agents: string[] | "any"; deny_agents: string[] };
  constraints: Constraints;
  disclosures: DisclosureBundle | null;
  evidence: Partial<Record<Tier, Evidence>>;
  handoff: string[];
  max_age_s: number;
  disclose: { operator: boolean; agent: boolean };
  iat: number;
}

export interface Terms {
  policy_version: number;
  scopes: { id: string; text: string }[];
  constraints: Constraints;
  max_age_s: number;
  evidence: Partial<Record<Tier, Evidence>>;
  disclosures: DisclosureBundle | null;
}

export interface Acceptance {
  terms: string;
  acknowledged: string[];
  viewed: string[];
  channel: string;
  accepted_at: string;
  copies_sent_to?: string;
}

export interface ObservedEvidence {
  site_session: string;
  human: boolean;
  known_device: boolean;
  age_s: number;
  handoffs?: string[];
}

export interface DelegationRecord {
  id: string;
  asserted: {
    by: string;
    terms: string;
    acknowledged: string[];
    viewed: string[];
    channel: string;
    accepted_at: string;
    copies_sent_to?: string;
  };
  observed: ObservedEvidence | null;
}

export interface DelegationClaims {
  iss: "foil";
  sub: string;
  agent: string;
  operator: string;
  origin: string;
  subject: string;
  scopes: string[];
  constraints: Constraints;
  policy_version: number;
  terms: string;
  intent: string;
  record: DelegationRecord;
  iat: number;
  exp: number;
  jti: string;
}

export interface ChallengeClaims {
  iss: "foil";
  origin: string;
  nonce: string;
  iat: number;
  exp: number;
}

export interface GrantClaims {
  iss: string;
  delegation: string;
  session_ref: string;
  intent: string;
  scopes: string[];
  nonce: string;
  jti: string;
  iat: number;
  exp: number;
}

export type DowngradeReason =
  | "chain_invalid"
  | "challenge_invalid"
  | "delegation_revoked"
  | "delegation_expired"
  | "policy_denied"
  | "grant_replayed"
  | "operator_mismatch"
  | "scope_violation"
  | "evidence_insufficient";

export interface AgentBlock {
  id?: string;
  name?: string;
  operator?: string;
  grant: string;
  intent: string;
  scopes: string[];
  scopes_used: string[];
  constraints: Constraints;
  delegation: {
    id: string;
    policy_version: number;
    created_at: string;
    expires_at: string;
    record: string;
    asserted: { terms: string; acknowledged: string[]; channel: string };
    observed: ObservedEvidence | null;
  };
  handoff: string | null;
}

export interface SessionRecord {
  id: string;
  origin: string;
  decision: { verdict: "allow" | "block"; plane: "human" | "agent" | "bot" };
  agent: AgentBlock | { grant: string; reason: DowngradeReason } | null;
  grant_jti?: string;
  delegation_id?: string;
  bound_at?: string;
}
