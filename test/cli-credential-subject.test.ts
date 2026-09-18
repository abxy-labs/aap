import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegationSubject } from "../src/lib/attestations.ts";

test("credentials subject reports the authorization ID using the public field name", async () => {
  const authorization = { id: "auth_59a0d3c128e64b72", operator: "op_46ab1239", subject: "customer_73e1a920", origin: "bank.example" };
  const directory = await mkdtemp(join(tmpdir(), "aap-cli-subject-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe(`/v1/authorizations/${authorization.id}`);
    expect(request.headers.get("Authorization")).toBe("Bearer sk_test_fixture");
    return Response.json(authorization);
  } });
  try {
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "credentials", "subject", "--authorization", authorization.id,
      "--api-base", server.url.toString(), "--api-key", "sk_test_fixture"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, AAP_CONFIG_DIR: directory }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ object: "credential_subject", subject: delegationSubject(authorization), authorization: authorization.id });
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
