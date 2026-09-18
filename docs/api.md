# API reference

Draft canonical API. Earlier terms/delegation/handoff routes are not supported.

## Conventions

Use a configured service with `Authorization: Bearer sk_test_…` or `sk_live_…`, JSON request bodies, and `AAP-Version: 2026-09-15`. Keys are account- and mode-scoped. Test helpers reject live keys.

Objects have `id`, `object`, `created`, `livemode`, and `metadata`. Lists use `data`, `has_more`, `limit`, `starting_after`, and `ending_before`. Errors contain `type`, `code`, `message`, optional `param`, and a request ID. Mutating requests accept an `Idempotency-Key`; a reused key with different parameters fails. Use a fresh key after correcting a failed request. File-backed idempotency is not a substitute for production transactional storage.

## Policies — institution

`POST /v1/policies` publishes a new version. Required: `origin`, `scopes`. Optional: `allow`, `constraints`, `disclosures`, `customer_actions`, `max_age_s`, `disclose`, `metadata`, `advanced`.

```json
{
  "origin": "bank.example",
  "scopes": ["accounts:read", "payments:initiate"],
  "constraints": {"currency":"usd","max_amount":20000,"payees":"existing_only"},
  "max_age_s": 86400,
  "customer_actions": [{
    "scope":"payments:initiate",
    "mode":"approve",
    "url":"https://bank.example/agent/confirm?action={id}",
    "expires_in":600
  }]
}
```

Amounts are integer minor units. Publish actual disclosures alongside this policy before collecting consent. `scopes: []` declines participation. Unknown scopes and `security:write` are rejected. There is no `tier` parameter.

Retrieve `GET /v1/policies/:id`; list `GET /v1/policies?origin=…`. Only the owning institution can manage its policy. Optional evidence lives in [advanced settings](advanced.md).

## Authorizations — operator and institution

- `POST /v1/authorizations` — operator creates a pending request. Required: `agent`, `origin`, `subject`, `intent`, `scopes`.
- `GET /v1/authorizations/:id` — owning operator or institution reads it.
- `GET /v1/authorizations` — filter by agent, origin, subject, status.
- `POST /v1/authorizations/:id/accept` — owning operator submits revision, acceptance, and signature. Use the SDK/CLI to sign locally.
- `POST /v1/authorizations/:id/revoke` — owning operator or institution withdraws access. Operator `by: "consumer"` records a customer request.

A request returns `status: "pending_consent"`, `consent.revision`, plain-language scopes, constraints, max duration, disclosures and expiry. Show the complete consent details before accepting.

```json
{
  "revision": "<consent.revision from the authorization>",
  "acceptance": {
    "acknowledged": ["authorize"],
    "viewed": ["terms", "privacy"],
    "channel": "in_app",
    "accepted_at": "2026-09-17T10:00:00Z"
  }
}
```

Acknowledgement/document IDs must match that consent; record actual interactions and actual timestamps. Include `copies_sent_to` when required. Optional `site_session` references the institution's verified human session, not the agent session. Optional `attestations` contains signed credentials.

Acceptance activates the same authorization ID. The SDK signs the canonical request including evidence bindings. Identical repeated acceptance is idempotent; different acceptance after activation is refused. Consent expires after one hour unless accepted; active expiry follows the permitted duration. Policy changes require new consent.

`GET /v1/authorizations/:id/connection` is operator-only signed material used internally by browser connect. It is not a second permission API.

## Browser connection — SDK

```ts
const session = await aap.browser(transport).connect({ authorization: authorization.id });
```

The operator implements `transport.challenge(origin)` and `transport.present({origin, header, session})` in its browser network integration. The SDK verifies the chain/challenge, signs locally, and builds the proof. The adapter returns the actual verification response. Check `plane`, `status` and the decision before proceeding.

The reference equivalent is `aap.test.browser.connect({authorization, asn})`. It simulates a browser connection, not real browser traffic.

## Sessions — participating operator or institution

`GET /v1/sessions/:id` and `GET /v1/sessions` (origin, plane, status filters) return verified session state. An agent block includes `intent`, `scopes`, `constraints`, `authorization.id`, `approvals` and any pending customer action. An authorization ID comes from authorization creation; a session ID comes from browser verification. They are not interchangeable.

Admission is request-driven: the browser-verification integration returns the current request's session directly. The institution does not poll the collection or select its first/newest entry to associate a request. Listing is an administrative inspection tool; subsequent reads use the returned session ID. See the [incoming-request example](guides/site.md#verify-an-incoming-agent-request) for the reference verifier boundary and production integration requirements.

An institution must gate each business operation against current permissions and approval context, rather than treating a prior allow response as blanket permission.

## Customer actions

- Operator: `POST /v1/customer_actions` with `session`, `scope`, and `context`.
- Parties: retrieve/list at `/v1/customer_actions`, filter by session/origin/status; cancel via `/:id/cancel`.
- Institution: set its URL via `POST /:id`; complete via `POST /:id/complete` with a verified human `session` and minimal `result`.

The response contains `id`, `status`, `mode`, scope/context, `url`, display title/message, and expiry. Send the returned URL to the customer. Never complete it from the agent session. The institution checks the amount/payee/application against its own records before completing. The SDK offers `customerActions.wait(id)`; continue only on `completed`.

Approval records retain exact context and expiry. Completion does not itself execute a transaction, grant a loan, or open an account.

## Optional attestations

`POST /v1/authorizations/:id/attestations` accepts a signed credential, submitted by the operator, owning institution, or registered issuer. Retrieve/list/revoke at `/v1/attestations`; list by `authorization`, origin, issuer, status. Only the institution or the credential's actual issuer may revoke it. See [advanced integration](advanced.md).

## Other resources

- Accounts: `POST /v1/accounts` for reference onboarding; `GET /v1/account`.
- Agents: `POST /v1/agents`, retrieve/list/update, `/:id/deactivate`. SDK creates and locally signs agent certificates.
- Issuers: retrieve/list `/v1/issuers`.
- Events: retrieve/list `/v1/events`; signed webhooks configured at `/v1/webhook_endpoints`.
- Events include authorization.created/accepted/revoked, customer_action.created/completed/canceled/expired, session.bound/downgraded/scope_used, agent.created/deactivated, policy.created, attestation.created/revoked.
- Directory: `GET /v1/directory` returns hashed participating origins.
- Root verification key: `GET /.well-known/foil-root`.
- Public site discovery: `GET /.well-known/aap`. See [discovery](discovery.md).

## Test-only transport

Under `/v1/test_helpers`: create sessions/challenges/presentations, exercise `sessions/:id/use`, link/complete `customer_actions/:id`, trigger events, and list fixed-outcome agents. These fixtures never prove real identity, customer consent, or a completed financial operation.
