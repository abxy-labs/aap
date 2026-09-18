# Integrate a financial institution

## Publish the rules

Map actual business operations to explicit scopes. Set limits, permitted operators/agents, consent documents and acknowledgement text, duration, and any required customer actions. Use `scopes: []` to decline participation; scopes never implicitly include sibling permissions.

```ts
await site.policies.create({
  origin: "bank.example",
  scopes: ["application:write", "identity:verify"],
  max_age_s: 86400,
  disclosures: publishedDisclosures,
  customer_actions: [{
    scope: "identity:verify", mode: "complete",
    url: "https://bank.example/application/verify?action={id}",
    expires_in: 600,
  }],
});
```

Supply your real disclosures. Each document has an ID, title, URL, format, content digest, and link/full presentation requirement. Acknowledgements contain the exact statement the customer must accept.

## Verify an incoming agent request

The browser presents its signed grant on arrival. Your browser-verification integration checks that request and returns its session directly. No listing, polling, or choosing the newest session is required. Policy creation alone does not produce a session.

The following handler illustrates the reference verifier boundary, using the existing internal `verifyPresentation` function. It is not a hosted API endpoint or a method on the public SDK. `store` and `root` are initialized by the reference verification server; `request` is the incoming browser request, and `browserSession` is the current connection context supplied by its transport, never an arbitrary query parameter. Keep the root private key inside the verification service, not in institution application code.

```ts
import { verifyPresentation } from "./src/lib/verify.ts";

async function admitRequest(request: Request, browserSession: { id: string }) {
  const header = request.headers.get("Foil-Agent-Grant");
  if (!header) throw new Error("Missing agent grant");

  const { session } = await verifyPresentation(store, root, {
    header,
    origin: "bank.example", // Configured institution origin, not an untrusted header.
    sessionId: browserSession.id,
  });

  if (session.plane !== "agent" || session.decision.verdict !== "allow") {
    throw new Error("Agent request denied");
  }

  return session;
}
```

In production, the network adapter must bind this context to the actual browser connection and enforce verification on that path. The reference transport is a sandbox, not a deployable production gateway. Your institution application consumes the verified session from that trusted integration and checks status, scopes, constraints, and `agent.authorization.id` before proceeding. If it needs a fresh read later, call `site.sessions.retrieve(session.id)` using this returned ID. `sessions.list` is for inspection and administration, not discovering the request currently being handled.

An allow verdict admits a browser session, not every requested financial operation. Validate the operation and current limits against your own records.

## Complete customer-only steps

Read `session.next_action.customer_action` or consume a `customer_action.created` event. Authenticate the customer on your own site, load the authoritative application/payment, and show its actual details.

After the customer succeeds, call `site.customerActions.complete(action.id, {session: humanSession.id, result})`. The session must be separately verified as human at your origin. The operator cannot complete its own action.

Use `approve` for a precise permission to proceed and `complete` when the human must perform the step. License capture and liveness are human-presence examples; automated background identity checks need not use this flow. Return minimal references/results, not identity documents or biometrics.

Completion restores the existing agent session without expanding its scopes. Check approval context and expiry before executing; AAP does not execute the financial operation or track your transaction ledger.

## Withdraw access and retain evidence

Revoke the authorization by its ID. Recheck permissions on subsequent use; cached allow verdicts are not a replacement for revocation enforcement. Retain the consent revision and your own customer-facing acceptance records.

## Optional evidence

Only when required, configure exact-scope `advanced.evidence` plus explicitly trusted credential issuers/types/claims. See [advanced integration](../advanced.md). Attestations are optional and distinct from consent, authorization and human authentication.

Run `bun run demo` for the reference flow. Test human sessions and completion are fixtures, not a substitute for your authentication or verification systems.
