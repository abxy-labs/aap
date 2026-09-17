import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, saveKeyFile } from "../src/cli/config.ts";
import type { KeyFile } from "../src/lib/keys.ts";

describe("CLI credential storage", () => {
  let dir = "";
  const previous = process.env.AAP_CONFIG_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aap-config-"));
    process.env.AAP_CONFIG_DIR = dir;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.AAP_CONFIG_DIR;
    else process.env.AAP_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  test("creates credential files as owner-only and corrects existing permissions", async () => {
    const config = { current: "default", profiles: { default: { test_key: "sk_test_secret" } } };
    await saveConfig(config);
    const configPath = join(dir, "config.json");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    await chmod(configPath, 0o644);
    await saveConfig(config);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);

    const key = { kid: "test", alg: "ES256", public: { kty: "EC" }, private: { kty: "EC", d: "secret" } } as KeyFile;
    const keyPath = await saveKeyFile("default", "operator", "op_test", key);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    await chmod(keyPath, 0o644);
    await saveKeyFile("default", "operator", "op_test", key);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
  });
});
