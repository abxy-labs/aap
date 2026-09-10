import type { AgentBlock, AgentClaims, DelegationClaims, DowngradeReason, GrantClaims, OperatorClaims, PolicyClaims, SessionRecord, Tier } from "../types.ts";
import { verifyAgent, verifyOperator } from "./certs.ts";
import { intersectConstraints } from "./constraints.ts";
import { delegationWithinCeiling, verifyDelegation } from "./delegation.ts";
import { parseHeader } from "./grant.ts";
import { TYP, decode, nowSeconds, verify } from "./jwt.ts";
import type { KeyFile } from "./keys.ts";
import { admitsAgents, agentAllowed, loadPolicy, operatorAllowed } from "./policy.ts";
import { isSubset, maxTier, tierIndex, tierOf, withinTier } from "./scopes.ts";
import { Store, iso } from "./store.ts";

export interface VerifyInput {
  header: string;
  origin: string;
  sessionId: string;
  /** Network evidence about the presenting session, compared with the operator profile when present. */
  asn?: string;
  ja4?: string;
  now?: Date;
}

export interface VerifyResult {
  statusHeader: string;
  session: SessionRecord;
  /** Granted scopes dropped because the site's current policy is tighter than when the delegation was created. */
  narrowed?: string[];
  /** Scopes in the grant that the consumer must complete on the site. */
  handoffScopes?: string[];
}

class Downgrade extends Error {
  constructor(public reason: DowngradeReason, message: string) {
    super(message);
  }
}

/** Foil's verification at bind. */
export async function verifyPresentation(store: Store, root: KeyFile, input: VerifyInput): Promise<VerifyResult> {
  const now = input.now ?? new Date();
  let grantJti: string | undefined;
  let delegationId: string | undefined;
  try {
    const p = parseHeader(input.header);

    // Resolve the chain. Certificates seen before may be omitted from later presentations.
    const grantClaims = decode<GrantClaims>(p.grant).claims;
    const agentJwt = p.chain.agent ?? (await store.getAgent(grantClaims.iss ?? ""))?.jwt;
    if (!agentJwt) throw new Downgrade("chain_invalid", "presentation omits the agent certificate and Foil has not seen this agent before");
    const agentIss = decode<AgentClaims>(agentJwt).claims.iss;
    const operatorJwt = p.chain.operator ?? (await store.getOperator(agentIss ?? ""))?.jwt;
    if (!operatorJwt) throw new Downgrade("chain_invalid", "presentation omits the operator certificate and Foil has not seen this operator before");
    const delegationJwt = p.chain.delegation ?? (await store.getDelegation(grantClaims.delegation ?? ""))?.jwt;
    if (!delegationJwt) throw new Downgrade("chain_invalid", "presentation omits the delegation and Foil has no record of it");

    let operator: OperatorClaims;
    let agent: AgentClaims;
    let delegation: DelegationClaims;
    let grant: GrantClaims;
    try {
      operator = await verifyOperator(operatorJwt, root.public, now);
      agent = await verifyAgent(agentJwt, operator, now);
    } catch (e) {
      throw new Downgrade("chain_invalid", errMsg(e));
    }
    try {
      delegation = await verifyDelegation(delegationJwt, root.public, now);
    } catch (e) {
      if (isExpired(e)) throw new Downgrade("delegation_expired", "delegation has passed its maximum age");
      throw new Downgrade("chain_invalid", errMsg(e));
    }
    try {
      grant = (await verify<GrantClaims>(p.grant, agent.key as never, TYP.grant, { now })).claims;
    } catch (e) {
      throw new Downgrade("chain_invalid", `grant: ${errMsg(e)}`);
    }
    grantJti = grant.jti;
    delegationId = delegation.sub;

    if (delegation.agent !== agent.sub || delegation.operator !== operator.sub) throw new Downgrade("chain_invalid", "delegation names a different agent or operator than the chain");
    if (delegation.origin !== input.origin) throw new Downgrade("chain_invalid", `delegation is for ${delegation.origin}, not ${input.origin}`);
    if (grant.iss !== agent.sub || grant.delegation !== delegation.sub) throw new Downgrade("chain_invalid", "grant does not reference this agent and delegation");
    if (!delegationWithinCeiling(delegation, agent)) throw new Downgrade("chain_invalid", "delegation exceeds the agent ceiling");
    if (!isSubset(grant.scopes, delegation.scopes)) throw new Downgrade("chain_invalid", "grant scopes are not a subset of the delegation");

    // Challenge
    const ch = await store.getChallenge(grant.nonce);
    if (!ch || ch.origin !== input.origin) throw new Downgrade("challenge_invalid", "grant was not signed over a challenge Foil issued for this origin");
    if (ch.exp < nowSeconds(now)) throw new Downgrade("challenge_invalid", "challenge has expired");

    // Delegation status
    const stored = await store.getDelegation(delegation.sub);
    if (stored?.status === "revoked") throw new Downgrade("delegation_revoked", `delegation revoked by ${stored.revoked_by} at ${stored.revoked_at}`);
    if (delegation.exp < nowSeconds(now)) throw new Downgrade("delegation_expired", "delegation has passed its maximum age");

    // Current policy
    const policy = await loadPolicy(store, root, input.origin);
    if (!admitsAgents(policy)) throw new Downgrade("policy_denied", `${input.origin} does not admit agents`);
    if (!operatorAllowed(policy, operator.sub)) throw new Downgrade("policy_denied", `operator ${operator.sub} is not admitted`);
    if (!agentAllowed(policy, agent.sub)) throw new Downgrade("policy_denied", `agent ${agent.sub} is not admitted`);
    const effective = withinTier(grant.scopes, policy.tier);
    if (effective.length === 0) throw new Downgrade("policy_denied", `no granted scope is within the site's tier ceiling (${policy.tier})`);
    const narrowed = grant.scopes.filter((s) => !effective.includes(s));
    const constraints = intersectConstraints(delegation.constraints, policy.constraints);

    // Evidence requirement for the highest tier in use
    const top = maxTier(effective);
    const required = top === "none" ? undefined : policy.evidence[top];
    if (required === "observed" && !delegation.record.observed) {
      throw new Downgrade("evidence_insufficient", `${top} tier requires an observed session link and the delegation has only asserted evidence`);
    }
    if (required === "presented" && !delegation.record.presented) {
      throw new Downgrade("evidence_insufficient", `${top} tier requires a presented credential and the delegation has none`);
    }

    // Replay
    const bound = await store.getGrantBinding(grant.jti);
    if (bound && bound.session !== input.sessionId) {
      const other = await store.getSession(bound.session);
      if (other) {
        other.decision = { verdict: "block", plane: "bot" };
        other.agent = { grant: grant.jti, reason: "grant_replayed" };
        await store.putSession(other);
      }
      throw new Downgrade("grant_replayed", `grant ${grant.jti} was already presented by session ${bound.session}`);
    }

    // Operator profile
    if (operator.profile) {
      if (input.asn && operator.profile.asn && !operator.profile.asn.includes(input.asn)) {
        throw new Downgrade("operator_mismatch", `session network ${input.asn} is not in the operator's profile`);
      }
      if (input.ja4 && operator.profile.ja4 && !operator.profile.ja4.includes(input.ja4)) {
        throw new Downgrade("operator_mismatch", `session TLS fingerprint ${input.ja4} is not in the operator's profile`);
      }
    }

    // Bind
    const handoffScopes = handoffFor(policy, effective);
    const block: AgentBlock = {
      ...(policy.disclose.agent ? { id: agent.sub, name: agent.name } : {}),
      ...(policy.disclose.operator ? { operator: operator.sub } : {}),
      grant: grant.jti,
      intent: grant.intent,
      scopes: effective,
      scopes_used: [],
      constraints,
      delegation: {
        id: delegation.sub,
        issuer: delegation.issuer ?? "foil",
        policy_version: delegation.policy_version,
        created_at: iso(delegation.iat),
        expires_at: iso(delegation.exp),
        record: delegation.record.id,
        asserted: {
          terms: delegation.record.asserted.terms,
          acknowledged: delegation.record.asserted.acknowledged,
          channel: delegation.record.asserted.channel,
        },
        observed: delegation.record.observed,
        presented: delegation.record.presented ?? null,
      },
      handoff: null,
    };
    const session: SessionRecord = {
      id: input.sessionId,
      origin: input.origin,
      decision: { verdict: "allow", plane: "agent" },
      agent: block,
      grant_jti: grant.jti,
      delegation_id: delegation.sub,
      bound_at: now.toISOString(),
    };
    await store.putSession(session);
    await store.putGrantBinding({ jti: grant.jti, session: input.sessionId });
    await store.putOperator(operator.sub, operatorJwt);
    await store.putAgent(agent.sub, agentJwt);
    return {
      statusHeader: "Foil-Agent-Status: bound",
      session,
      ...(narrowed.length ? { narrowed } : {}),
      ...(handoffScopes.length ? { handoffScopes } : {}),
    };
  } catch (e) {
    if (!(e instanceof Downgrade)) throw e;
    const session: SessionRecord = {
      id: input.sessionId,
      origin: input.origin,
      decision: { verdict: "block", plane: "bot" },
      agent: { grant: grantJti ?? "unknown", reason: e.reason },
      ...(grantJti ? { grant_jti: grantJti } : {}),
      ...(delegationId ? { delegation_id: delegationId } : {}),
    };
    await store.putSession(session);
    return { statusHeader: `Foil-Agent-Status: downgraded; reason=${e.reason}`, session };
  }
}

export function handoffFor(policy: PolicyClaims, scopes: string[]): string[] {
  return scopes.filter((s) => {
    if (policy.handoff.includes(s)) return true;
    const t = tierOf(s);
    return t !== undefined && policy.evidence[t] === "site";
  });
}

export function requiredEvidenceFor(policy: PolicyClaims, scope: string): string | undefined {
  const t = tierOf(scope);
  return t ? policy.evidence[t] : undefined;
}

export function tierAtLeast(a: Tier | "none", b: Tier | "none"): boolean {
  return tierIndex(a) >= tierIndex(b);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isExpired(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ERR_JWT_EXPIRED";
}
