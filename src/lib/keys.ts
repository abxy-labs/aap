import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

export const ALG = "ES256";

export interface KeyFile {
  kid: string;
  public: JWK;
  private: JWK;
}

export async function generateKeyFile(): Promise<KeyFile> {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const pub = await exportJWK(publicKey);
  const priv = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(pub);
  return { kid, public: { ...pub, kid }, private: { ...priv, kid } };
}

export async function thumbprint(jwk: JWK): Promise<string> {
  const { kid: _kid, ...rest } = jwk;
  return calculateJwkThumbprint(rest);
}

export async function importPrivate(jwk: JWK): Promise<CryptoKey> {
  return (await importJWK(jwk, ALG)) as CryptoKey;
}

export async function importPublic(jwk: JWK): Promise<CryptoKey> {
  const { d: _d, ...pub } = jwk;
  return (await importJWK(pub, ALG)) as CryptoKey;
}

export function publicOnly(jwk: JWK): JWK {
  const { d: _d, ...pub } = jwk;
  return pub;
}

export async function readKeyFile(path: string): Promise<KeyFile> {
  const raw = await Bun.file(path).json();
  if (raw.private && raw.public) return raw as KeyFile;
  if (raw.kty) {
    const kid = raw.kid ?? (await thumbprint(raw));
    return { kid, public: publicOnly(raw), private: raw };
  }
  throw new Error(`${path} is not a key file`);
}

export async function readPublicJwk(path: string): Promise<JWK> {
  const raw = await Bun.file(path).json();
  if (raw.public) return raw.public as JWK;
  if (raw.kty) return publicOnly(raw as JWK);
  throw new Error(`${path} does not contain a public key`);
}
