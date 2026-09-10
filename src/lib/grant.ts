import type { AgentClaims, DelegationClaims, GrantClaims } from "../types.ts";
import { TYP, decode, nowSeconds, sign } from "./jwt.ts";
import type { KeyFile } from "./keys.ts";
import { id } from "./store.ts";
import { isSubset, validate } from "./scopes.ts";

export const GRANT_TTL_S = 3600;

export async function signGrant(
  agentKey: KeyFile,
  agent: AgentClaims,
  delegation: DelegationClaims,
  input: { sessionRef: string; intent: string; scopes?: string[]; nonce: string; ttlS?: number; now?: Date },
): Promise<string> {
  const scopes = input.scopes ?? delegation.scopes;
  const unknown = validate(scopes);
  if (unknown.length) throw new Error(`unknown scopes: ${unknown.join(", ")}`);
  if (!isSubset(scopes, delegation.scopes)) {
    throw new Error(`grant scopes must narrow the delegation; not in delegation: ${scopes.filter((s) => !delegation.scopes.includes(s)).join(", ")}`);
  }
  const iat = nowSeconds(input.now);
  const claims: GrantClaims = {
    iss: agent.sub,
    delegation: delegation.sub,
    session_ref: input.sessionRef,
    intent: input.intent,
    scopes,
    nonce: input.nonce,
    jti: id("g"),
    iat,
    exp: iat + (input.ttlS ?? GRANT_TTL_S),
  };
  return sign(claims as never, agentKey.private, TYP.grant);
}

export interface Presentation {
  grant: string;
  chain: { delegation?: string; agent?: string; operator?: string };
}

/** Build the Foil-Agent-Grant header value. */
export function buildHeader(p: Presentation): string {
  const parts = [p.chain.delegation, p.chain.agent, p.chain.operator].filter(Boolean);
  return parts.length ? `${p.grant};chain=${parts.join(",")}` : p.grant;
}

export function parseHeader(value: string): Presentation {
  const [grant, ...rest] = value.split(";");
  if (!grant) throw new Error("empty header");
  const chain: Presentation["chain"] = {};
  for (const part of rest) {
    const [k, v] = part.split("=", 2);
    if (k?.trim() === "chain" && v) {
      for (const jwt of v.split(",")) {
        const typ = decode(jwt).header.typ;
        if (typ === TYP.delegation) chain.delegation = jwt;
        else if (typ === TYP.agent) chain.agent = jwt;
        else if (typ === TYP.operator) chain.operator = jwt;
      }
    }
  }
  return { grant: grant.trim(), chain };
}
