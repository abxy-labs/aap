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

## Verify arriving sessions

Policy creation does not produce a session. Your browser verification integration supplies the arriving session ID. Retrieve it and check plane, status, scopes, constraints and `agent.authorization.id`. A sandbox can list sessions after the operator runs browser connect; do not choose the first list entry in production.

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
