/** Real CLI walkthrough. Run: bun examples/credentials.ts [--first-party] */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server/app.ts";
import { Store } from "../src/lib/store.ts";
import { VC_CONTEXT } from "../src/lib/credentials.ts";

const workspace = await mkdtemp(join(tmpdir(), "aap-credential-demo-"));
const server = await startServer({ store: new Store(join(workspace, "store")), port: 0 });
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const issuer = process.argv.includes("--first-party") ? "https://assistant.example" : "https://identity.example";
const demoEnv: NodeJS.ProcessEnv = { ...process.env, AAP_CONFIG_DIR: join(workspace, "config"), AAP_API_BASE: server.url };
delete demoEnv.AAP_API_KEY;
async function run(profile: string, args: string[], expectedCode = 0): Promise<any> {
  const p = Bun.spawn([process.execPath, cli, "--profile", profile, "--api-base", server.url, ...args], {
    cwd: workspace, env: demoEnv, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== expectedCode) throw new Error(`${args[0]} ${args[1]} failed (${code}): ${stderr}`);
  return JSON.parse(stdout);
}
async function json(name: string, value: unknown) { await writeFile(join(workspace, name), JSON.stringify(value), { mode: 0o600 }); }
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
try {
  await run("operator", ["accounts", "create", "--type", "operator", "--name", "Assistant company"]);
  await run("site", ["accounts", "create", "--type", "site", "--name", "Example bank"]);
  await run("issuer", ["keys", "generate", "--out", "issuer.json"]);
  const key = await Bun.file(join(workspace, "issuer.json")).json();
  const vocabulary = {
    EmailControlCredential: "https://example.org/credentials/v1/EmailControlCredential", email: "https://schema.org/email",
    verified: "https://example.org/credentials/v1/verified", method: "https://example.org/credentials/v1/method", checkedAt: "https://example.org/credentials/v1/checkedAt",
  };
  const credentials = { types: ["EmailControlCredential"], issuers: [issuer], claims: ["email", "verified", "method"], trust: [
    { issuer, type: "EmailControlCredential", key: key.public, context: vocabulary, claims: { verified: true, method: "email_link" }, max_age_s: 600 },
  ] };
  await json("trust.json", credentials);
  await run("site", ["policies", "create", "--origin", "bank.example", "--tier", "read", "--evidence", "read=presented", "--credentials", "@trust.json"]);
  const agent = await run("operator", ["agents", "create", "--name", "Account assistant", "--scopes", "accounts:read"]);
  const terms = await run("operator", ["terms", "create", "--agent", agent.id, "--origin", "bank.example"]);
  await json("acceptance.json", { terms: terms.id, acknowledged: [], viewed: [], channel: "test", accepted_at: new Date().toISOString() });
  const delegation = await run("operator", ["delegations", "create", "--agent", agent.id, "--origin", "bank.example", "--subject", "application_42", "--terms", terms.id, "--acceptance", "@acceptance.json"]);
  const bind = async (suffix: string, expectedCode = 0) => {
    await run("operator", ["test", "challenges", "create", "--origin", "bank.example", "--out", `challenge-${suffix}.jwt`]);
    await run("operator", ["grants", "sign", "--delegation", delegation.id, "--challenge", `challenge-${suffix}.jwt`, "--session-ref", suffix, "--out", `grant-${suffix}.jwt`]);
    await run("operator", ["present", "--grant", `grant-${suffix}.jwt`, "--delegation", delegation.id, "--out", `header-${suffix}.txt`]);
    return run("operator", ["test", "presentations", "create", "--origin", "bank.example", "--header-file", `header-${suffix}.txt`], expectedCode);
  };
  assert((await bind("before", 2)).plane === "bot", "Required evidence should be missing.");
  console.log("PASS: institution-required evidence is missing; no access yet.");
  const subject = `urn:uuid:${crypto.randomUUID()}`;
  // The institution maps this issuer subject to its applicant using its authenticated onboarding flow.
  // This demo supplies a fixture, not a real email verification or identity proofing service.
  const request = await run("site", ["credential-verifications", "create", "--delegation", delegation.id, "--credential-subject", subject]);
  await json("request.json", request);
  const now = Math.floor(Date.now() / 1000);
  await json("credential.json", {
    "@context": [VC_CONTEXT, vocabulary], id: `urn:uuid:${crypto.randomUUID()}`, type: ["VerifiableCredential", "EmailControlCredential"], issuer,
    validFrom: new Date(now * 1000).toISOString(), validUntil: new Date((now + 600) * 1000).toISOString(),
    credentialSubject: { id: subject, email: "user@example.net", verified: true, method: "email_link", checkedAt: new Date(now * 1000).toISOString() },
  });
  await run("issuer", ["credentials", "issue", "--body", "@credential.json", "--key", "issuer.json", "--out", "vc.jwt"]);
  await run("issuer", ["credentials", "present", "--credential", "vc.jwt", "--request", "request.json", "--key", "issuer.json", "--out", "vp.jwt"]);
  const result = await run("site", ["credential-verifications", "complete", request.id, "--presentation-file", "vp.jwt"]);
  assert(result.status === "verified" && result.evidence.holder_bound === false, "Expected organization-held verified evidence.");
  const session = await bind("after");
  assert(session.plane === "agent", "Expected admitted session.");
  assert(!JSON.stringify(session).includes("user@example.net"), "Personal claims leaked.");
  console.log(`PASS: ${issuer} signed VC + VP verified; session admitted without exposing claims.`);
  await run("site", ["credential-verifications", "revoke", request.id]);
  const revoked = await run("site", ["test", "sessions", "use", session.id, "--scope", "accounts:read"]);
  assert(revoked.plane === "bot", "Revoked evidence must block required scope use.");
  console.log("PASS: revoking the evidence blocks subsequent protected use.");
  await run("site", ["policies", "create", "--origin", "bank.example", "--tier", "read"]);
  assert((await bind("optional")).plane === "agent", "Baseline must work without attestations.");
  console.log("PASS: standard AAP flow works without attestations when policy does not require them.");
} finally {
  server.stop();
  await rm(workspace, { recursive: true, force: true });
}
