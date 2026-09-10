import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

export type Alg = "ES256" | "EdDSA";
export const ALGS: Alg[] = ["ES256", "EdDSA"];

export interface KeyFile {
  kid: string;
  alg: Alg;
  public: JWK;
  private: JWK;
}

/** The algorithm a JWK is used with. EC P-256 keys sign ES256; Ed25519 keys sign EdDSA, the algorithm Web Bot Auth uses. */
export function algOf(jwk: JWK): Alg {
  if (jwk.kty === "EC" && jwk.crv === "P-256") return "ES256";
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") return "EdDSA";
  throw new Error(`unsupported key type ${jwk.kty}/${jwk.crv ?? ""}; use EC P-256 or Ed25519`);
}

export async function generateKeyFile(alg: Alg = "ES256"): Promise<KeyFile> {
  if (!ALGS.includes(alg)) throw new Error(`unsupported algorithm ${alg}; use ES256 or EdDSA`);
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const pub = await exportJWK(publicKey);
  const priv = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(pub);
  return { kid, alg, public: { ...pub, kid }, private: { ...priv, kid } };
}

export async function thumbprint(jwk: JWK): Promise<string> {
  const { kid: _kid, ...rest } = jwk;
  return calculateJwkThumbprint(rest);
}

export async function importPrivate(jwk: JWK): Promise<CryptoKey> {
  return (await importJWK(jwk, algOf(jwk))) as CryptoKey;
}

export async function importPublic(jwk: JWK): Promise<CryptoKey> {
  const { d: _d, ...pub } = jwk;
  return (await importJWK(pub, algOf(pub))) as CryptoKey;
}

export function publicOnly(jwk: JWK): JWK {
  const { d: _d, ...pub } = jwk;
  return pub;
}

export async function readKeyFile(path: string): Promise<KeyFile> {
  const raw = await Bun.file(path).json();
  if (raw.private && raw.public) return { alg: algOf(raw.public), ...raw } as KeyFile;
  if (raw.kty) {
    const kid = raw.kid ?? (await thumbprint(raw));
    return { kid, alg: algOf(raw), public: publicOnly(raw), private: raw };
  }
  throw new Error(`${path} is not a key file`);
}

export async function readPublicJwk(path: string): Promise<JWK> {
  const raw = await Bun.file(path).json();
  if (raw.public) return raw.public as JWK;
  if (raw.kty) return publicOnly(raw as JWK);
  throw new Error(`${path} does not contain a public key`);
}
