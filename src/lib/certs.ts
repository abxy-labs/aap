import type { JWK } from "jose";
import type { AgentClaims, Ceiling, OperatorClaims, OperatorProfile } from "../types.ts";
import { TYP, nowSeconds, sign, verify } from "./jwt.ts";
import type { KeyFile } from "./keys.ts";
import { validate } from "./scopes.ts";

const DAY = 86400;

export async function issueOperator(
  root: KeyFile,
  input: { id: string; key: JWK; vetting: string; sessionHandling: string; profile?: OperatorProfile; days?: number; now?: Date },
): Promise<string> {
  const iat = nowSeconds(input.now);
  const claims: OperatorClaims = {
    iss: "foil",
    sub: input.id,
    key: input.key,
    vetting: input.vetting,
    session_handling: input.sessionHandling,
    ...(input.profile ? { profile: input.profile } : {}),
    iat,
    nbf: iat,
    exp: iat + (input.days ?? 365) * DAY,
  };
  return sign(claims as never, root.private, TYP.operator);
}

export async function issueAgent(
  operatorKey: KeyFile,
  operatorId: string,
  input: { id: string; name: string; key: JWK; ceiling: Ceiling; days?: number; now?: Date },
): Promise<string> {
  const unknown = validate(input.ceiling.scopes);
  if (unknown.length) throw new Error(`unknown scopes in ceiling: ${unknown.join(", ")}`);
  if (input.ceiling.scopes.includes("security:write")) throw new Error("security:write is never grantable and cannot appear in a ceiling");
  const iat = nowSeconds(input.now);
  const claims: AgentClaims = {
    iss: operatorId,
    sub: input.id,
    name: input.name,
    key: input.key,
    ceiling: input.ceiling,
    iat,
    nbf: iat,
    exp: iat + (input.days ?? 90) * DAY,
  };
  return sign(claims as never, operatorKey.private, TYP.agent);
}

export async function verifyOperator(jwt: string, rootPublic: JWK, now?: Date): Promise<OperatorClaims> {
  const { claims } = await verify<OperatorClaims>(jwt, rootPublic, TYP.operator, { now });
  if (claims.iss !== "foil" || !claims.sub || !claims.key) throw new Error("operator certificate is malformed");
  return claims;
}

export async function verifyAgent(jwt: string, operator: OperatorClaims, now?: Date): Promise<AgentClaims> {
  const { claims } = await verify<AgentClaims>(jwt, operator.key as JWK, TYP.agent, { now });
  if (claims.iss !== operator.sub) throw new Error(`agent certificate issuer ${claims.iss} does not match operator ${operator.sub}`);
  if (!claims.sub || !claims.key || !claims.ceiling) throw new Error("agent certificate is malformed");
  return claims;
}
