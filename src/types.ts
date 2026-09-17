export type Tier = "observe" | "read" | "manage" | "transact" | "control";

/** Amounts are integers in the minor unit of `currency` (cents for USD). */
export interface Constraints {
  currency?: string;
  max_amount?: number;
  max_total?: number;
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

/** A credential about the operator issued by a third party, such as a card network's Know-Your-Agent credential. */
export interface OperatorAttestation {
  type: string;
  issuer: string;
  ref?: string;
  credential?: string;
  issued_at?: string;
  expires_at?: string;
}

export interface OperatorClaims {
  iss: "foil";
  sub: string;
  key: JsonWebKey;
  vetting: string;
  session_handling: string;
  attestations: OperatorAttestation[];
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

export type Evidence = "asserted" | "observed" | "attested" | "presented" | "site";

export type DelegationIssuer = "foil" | "site" | "consumer";

/** Which attestations a site accepts. `issuers` holds issuer ids, or "operator" for the delegation's own operator. */
export interface AttestationPolicy {
  issuers: string[];
  types: string[];
  claims: string[];
  max_age_s?: number;
}

/** Retained for policies written before attestations. Reserved for holder-bound wallet presentations. */
export interface CredentialPolicy {
  types: string[];
  issuers: string[];
  claims: string[];
}

export interface IssuerObject {
  id: string;
  object: "issuer";
  created: number;
  account: string | null;
  name: string;
  url: string;
  public_keys: (JsonWebKey & { kid: string })[];
  status: "active" | "deactivated";
}

export type AttestationStatus = "active" | "revoked" | "expired";

export interface Attestation extends ObjectBase {
  object: "attestation";
  status: AttestationStatus;
  delegation: string;
  origin: string;
  issuer: string;
  type: string;
  subject: string;
  claims: Record<string, string | number | boolean>;
  issued_at: number;
  valid_until: number;
  verified_at: number;
  submitted_by: "operator" | "issuer" | "site";
  holder_bound: false;
  revoked_at: number | null;
  revoked_by: string | null;
}

/** The summary of an accepted attestation, as it appears in the delegation record and the session. */
export interface AttestedEvidence {
  attestation: string;
  issuer: string;
  type: string;
  claims: Record<string, string | number | boolean>;
  holder_bound: false;
  issued_at: number;
  valid_until: number;
  verified_at: number;
}

/** Reserved for a holder-bound presentation from the consumer's own wallet. */
export interface PresentedEvidence {
  type: string;
  issuer: string;
  holder_bound: boolean;
  claims: Record<string, unknown>;
  verified_at: string;
}

export type HandoffMode = "approve" | "complete";

export interface HandoffConfig {
  scope: string;
  mode?: HandoffMode;
  url?: string | null;
  expires_in?: number;
}

export interface PolicyAllow {
  operators: string[] | "any";
  agents: string[] | "any";
  deny_agents: string[];
}

export interface PolicyClaims {
  iss: "foil";
  sub: string;
  version: number;
  tier: Tier | "none";
  allow: PolicyAllow;
  constraints: Constraints;
  disclosures: DisclosureBundle | null;
  evidence: Partial<Record<Tier, Evidence>>;
  handoffs: HandoffConfig[];
  max_age_s: number;
  disclose: { operator: boolean; agent: boolean };
  attestations: AttestationPolicy | null;
  credentials: CredentialPolicy | null;
  iat: number;
}

export interface ObjectBase {
  id: string;
  object: string;
  created: number;
  livemode: boolean;
  metadata: Record<string, string>;
}

export interface PolicyObject extends ObjectBase {
  object: "policy";
  origin: string;
  version: number;
  tier: Tier | "none";
  allow: PolicyAllow;
  constraints: Constraints;
  disclosures: DisclosureBundle | null;
  evidence: Partial<Record<Tier, Evidence>>;
  handoffs: HandoffConfig[];
  max_age_s: number;
  disclose: { operator: boolean; agent: boolean };
  attestations: AttestationPolicy | null;
  credentials: CredentialPolicy | null;
  statement: string;
}

export interface AgentObject extends ObjectBase {
  object: "agent";
  operator: string;
  name: string;
  status: "active" | "deactivated";
  public_key: JsonWebKey;
  ceiling: Ceiling;
  certificate: string;
  expires_at: number;
}

export interface OperatorObject {
  id: string;
  object: "operator";
  created: number;
  account: string | null;
  name: string;
  vetting: string;
  session_handling: string;
  attestations: OperatorAttestation[];
  profile?: OperatorProfile;
  public_key: JsonWebKey;
  certificate: string;
  expires_at: number;
}

export interface TermsObject extends ObjectBase {
  object: "terms";
  agent: string;
  origin: string;
  policy_version: number;
  scopes: { id: string; text: string }[];
  constraints: Constraints;
  max_age_s: number;
  evidence: Partial<Record<Tier, Evidence>>;
  disclosures: DisclosureBundle | null;
  expires_at: number;
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
  object: "delegation_record";
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
  /** Attestations accepted for this delegation, newest first. */
  attested: AttestedEvidence[];
  /** Reserved for holder-bound wallet presentations. Null until one is recorded. */
  presented: PresentedEvidence | null;
}

export interface DelegationClaims {
  iss: "foil";
  sub: string;
  issuer: DelegationIssuer;
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

export type DelegationStatus = "active" | "revoked" | "expired";

export interface DelegationObject extends ObjectBase {
  object: "delegation";
  status: DelegationStatus;
  agent: string;
  operator: string;
  origin: string;
  subject: string;
  scopes: string[];
  constraints: Constraints;
  terms: string;
  issuer: DelegationIssuer;
  intent: string;
  policy_version: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  record: string;
  certificate: string;
}

export interface StoredDelegation extends DelegationObject {
  claims: DelegationClaims;
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
  | "evidence_insufficient"
  | "agent_deactivated"
  | "handoff_completed_by_agent";

export interface Approval {
  handoff: string;
  scope: string;
  context: Record<string, unknown>;
  approved_at: number;
  expires_at: number;
}

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
    issuer: DelegationIssuer;
    policy_version: number;
    created_at: string;
    expires_at: string;
    record: string;
    asserted: { terms: string; acknowledged: string[]; channel: string };
    observed: ObservedEvidence | null;
    attested: AttestedEvidence[];
    presented: PresentedEvidence | null;
  };
  handoff: string | null;
  approvals: Approval[];
}

export interface DowngradedBlock {
  grant: string;
  reason: DowngradeReason;
  message?: string;
}

export type Plane = "human" | "agent" | "bot";
export type SessionStatus = "active" | "requires_handoff" | "downgraded";

export interface SessionRecord extends ObjectBase {
  object: "session";
  origin: string;
  plane: Plane;
  status: SessionStatus;
  decision: { verdict: "allow" | "block"; plane: Plane };
  agent: AgentBlock | DowngradedBlock | null;
  next_action: { type: "handoff"; handoff: string } | null;
  human?: boolean;
  known_device?: boolean;
  device?: string;
  created_at?: string;
  operator_id?: string;
  grant_jti?: string;
  delegation_id?: string;
  bound_at?: string;
}

export type HandoffStatus = "pending" | "completed" | "canceled" | "expired";

export interface Handoff extends ObjectBase {
  object: "handoff";
  status: HandoffStatus;
  mode: HandoffMode;
  session: string;
  delegation: string;
  agent: string;
  operator: string;
  origin: string;
  scope: string;
  context: Record<string, unknown>;
  display: { title: string; message: string };
  url: string | null;
  code: string;
  expires_at: number;
  completed_at: number | null;
  completed_by: { session: string; human: boolean; known_device: boolean; device: string; cloud_environment: boolean } | null;
  result: Record<string, unknown> | null;
  linked_session: string | null;
  canceled_by: string | null;
}

export interface Account {
  id: string;
  object: "account";
  created: number;
  type: "operator" | "site" | "issuer";
  name: string;
  operator: string | null;
  issuer?: string | null;
  origins: string[];
}

export interface ApiKeyRecord {
  hash: string;
  account: string;
  livemode: boolean;
  prefix: string;
  created: number;
}

export interface EventObject {
  id: string;
  object: "event";
  created: number;
  livemode: boolean;
  type: string;
  data: { object: unknown };
  pending_webhooks: number;
  request: { id: string | null; idempotency_key: string | null };
}

export interface WebhookEndpoint extends ObjectBase {
  object: "webhook_endpoint";
  url: string;
  enabled_events: string[];
  status: "enabled" | "disabled";
  description: string | null;
  secret?: string;
}
