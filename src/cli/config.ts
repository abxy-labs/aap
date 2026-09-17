import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KeyFile } from "../lib/keys.ts";
import type { Keyring } from "../sdk/index.ts";

export interface Profile {
  api_base?: string;
  test_key?: string;
  live_key?: string;
  account?: string;
  account_type?: "operator" | "site";
  keys?: { operator?: string; agents?: Record<string, string> };
}

export interface Config {
  current: string;
  profiles: Record<string, Profile>;
}

export function configDir(): string {
  return process.env.AAP_CONFIG_DIR ?? join(homedir(), ".config", "aap");
}

const EMPTY: Config = { current: "default", profiles: {} };

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const file = await open(path, "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(value, null, 2));
  } finally {
    await file.close();
  }
}

export async function loadConfig(): Promise<Config> {
  const f = Bun.file(join(configDir(), "config.json"));
  if (!(await f.exists())) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...((await f.json()) as Config) };
  } catch {
    return structuredClone(EMPTY);
  }
}

export async function saveConfig(c: Config): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writePrivateJson(join(configDir(), "config.json"), c);
}

export function getProfile(c: Config, name?: string): { name: string; profile: Profile } {
  const n = name ?? c.current ?? "default";
  return { name: n, profile: c.profiles[n] ?? {} };
}

export async function saveKeyFile(profileName: string, kind: "operator" | "agent", id: string, key: KeyFile): Promise<string> {
  const dir = join(configDir(), "keys", profileName);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${kind}.${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  await writePrivateJson(path, key);
  return path;
}

export async function loadKeyring(profile: Profile): Promise<Keyring> {
  const ring: Keyring = { agents: {} };
  if (profile.keys?.operator) {
    const f = Bun.file(profile.keys.operator);
    if (await f.exists()) ring.operator = (await f.json()) as KeyFile;
  }
  for (const [id, path] of Object.entries(profile.keys?.agents ?? {})) {
    const f = Bun.file(path);
    if (await f.exists()) ring.agents[id] = (await f.json()) as KeyFile;
  }
  return ring;
}

export function mask(key?: string): string | undefined {
  if (!key) return undefined;
  return key.slice(0, 12) + "…" + key.slice(-4);
}
