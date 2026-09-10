import { SignJWT, decodeJwt, decodeProtectedHeader, jwtVerify, type JWK, type JWTPayload } from "jose";
import { ALG, importPrivate, importPublic } from "./keys.ts";

export const TYP = {
  operator: "aap-operator+jwt",
  agent: "aap-agent+jwt",
  policy: "aap-policy+jwt",
  delegation: "aap-delegation+jwt",
  challenge: "aap-challenge+jwt",
  grant: "aap-grant+jwt",
  request: "aap-request+jwt",
} as const;

export type Typ = (typeof TYP)[keyof typeof TYP];

export async function sign(claims: JWTPayload, key: JWK, typ: Typ): Promise<string> {
  const k = await importPrivate(key);
  return new SignJWT(claims).setProtectedHeader({ alg: ALG, typ, kid: key.kid }).sign(k);
}

export interface Verified<T> {
  claims: T;
  header: { alg?: string; typ?: string; kid?: string };
}

export async function verify<T>(jwt: string, key: JWK | CryptoKey, typ: Typ, opts: { now?: Date } = {}): Promise<Verified<T>> {
  const k = "kty" in (key as JWK) ? await importPublic(key as JWK) : (key as CryptoKey);
  const { payload, protectedHeader } = await jwtVerify(jwt, k, {
    algorithms: [ALG],
    typ,
    currentDate: opts.now,
  });
  return { claims: payload as unknown as T, header: protectedHeader };
}

export function decode<T>(jwt: string): { claims: T; header: { alg?: string; typ?: string; kid?: string } } {
  return { claims: decodeJwt(jwt) as unknown as T, header: decodeProtectedHeader(jwt) };
}

export function nowSeconds(now?: Date): number {
  return Math.floor((now ?? new Date()).getTime() / 1000);
}
