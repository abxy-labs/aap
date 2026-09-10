import type { ChallengeClaims } from "../types.ts";
import { TYP, nowSeconds, sign, verify } from "./jwt.ts";
import type { KeyFile } from "./keys.ts";
import type { JWK } from "jose";
import { Store } from "./store.ts";
import { admitsAgents, loadPolicy } from "./policy.ts";

export const CHALLENGE_TTL_S = 300;

export async function issueChallenge(store: Store, root: KeyFile, origin: string, now?: Date): Promise<string | null> {
  const policy = await loadPolicy(store, root, origin);
  if (!admitsAgents(policy)) return null;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const iat = nowSeconds(now);
  const claims: ChallengeClaims = { iss: "foil", origin, nonce, iat, exp: iat + CHALLENGE_TTL_S };
  const jwt = await sign(claims as never, root.private, TYP.challenge);
  await store.putChallenge({ nonce, origin, jwt, exp: claims.exp });
  return jwt;
}

/** What an operator's browser does before answering: confirm the challenge is Foil's. */
export async function verifyChallenge(jwt: string, rootPublic: JWK, now?: Date): Promise<ChallengeClaims> {
  const { claims } = await verify<ChallengeClaims>(jwt, rootPublic, TYP.challenge, { now });
  if (claims.iss !== "foil" || !claims.nonce || !claims.origin) throw new Error("challenge is malformed");
  return claims;
}
