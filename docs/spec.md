# Agent Admission Protocol

Draft. Endpoint names and wire formats may change without compatibility guarantees.

## The core model

**Agent:** a registered actor with a locally held signing key and an operator-signed ceiling of scopes and constraints.

**Policy:** the institution's explicit allowed scopes, narrower limits, disclosures, accepted operators/agents, and customer-action rules. There is no tier ceiling. An empty scope list declines agent admission.

**Authorization:** one resource binding the agent, operator, institution origin, pseudonymous customer reference, task intent, permitted scopes, and exact consent revision. Its lifecycle is `pending_consent → active → revoked / expired`. A pending request can also expire or be revoked. Changes to scope or intent require a fresh authorization and consent.

**Session:** the verified browser session. Authorization alone does not create one. The institution receives it through its browser verification integration and checks its scopes and constraints before allowing an operation.

**Customer action:** an institution-controlled step requiring the customer. In `approve` mode the customer approves a specific action and the agent may continue. In `complete` mode the human completes the step themselves. Pending, canceled, or expired is never approval.

## Roles

- The financial institution publishes policy, verifies sessions, completes customer actions, and decides whether to execute the business operation.
- The agent application presents disclosures and permissions, captures actual consent, and directs the customer to required steps.
- The browser operator registers agents, submits authorization requests and consent, and connects browser sessions.
- An optional identity or risk issuer signs evidence of checks it actually performed. An application can also provide its own signed claims. Neither role grants permission by itself.

## Lifecycle

1. Use an explicitly configured service, or discover the participating origin using `GET /.well-known/aap`. Discovery is optional public metadata, not trust or consent.
2. Create `POST /v1/authorizations` with agent, origin, subject, intent, and scopes.
3. Display the returned consent: scopes, limits, duration, linked documents, full-render documents where required, and acknowledgement text.
4. Submit `POST /v1/authorizations/:id/accept` with the displayed revision and explicit acceptance. The SDK signs the immutable authorization reference, revision, acceptance, and optional evidence bindings.
5. Call `aap.browser(transport).connect({ authorization })`. The SDK obtains and verifies an origin-bound challenge, signs a short-lived proof locally, and presents it using the operator's adapter.
6. The verifier applies the current policy, chain validity, scope intersection, expiry, revocation, replay protection, and configured evidence requirements. Only a successful verification binds an agent session.
7. When necessary, create a customer action using that session and the specific action context. The institution completes it from a separately verified human session at the same origin.
8. Revoke the authorization to stop further access. A stored previous allow verdict is not a fresh authorization decision.

## Scope and action enforcement

Requested scopes are intersected with the agent ceiling and explicit policy scopes. Limits only narrow. The institution must enforce current limits, payee restrictions, approval context and expiry, aggregate amounts, and execution idempotency against its own records. Permission to submit a loan application is not a credit decision; payment approval does not move money.

The shared vocabulary includes account and transaction reads, application preparation/submission, payments and transfers, and human-presence verification. `identity:verify` denotes customer-present steps such as license capture or liveness—not all background identity checks. `security:write` is never grantable.

## Consent invariants

Acceptance binds to one authorization and its exact consent revision. Missing acknowledgements, required unread documents, missing required copies, stale policy, expired consent, or an invalid signature prevent issuance. Repeating identical acceptance does not create another signed authorization. Accepted requests are immutable. The reference server serializes acceptance/revocation per authorization within one process.

The signature proves what the agent/operator asserted. It does not prove the customer understood or freely agreed. Applications must not infer consent from a task prompt.

## Optional evidence

No attestation is required by the core protocol. A policy can opt into exact-scope evidence requirements using `advanced.evidence` and explicitly accepted credential issuers/types/claims using `advanced.attestations`. See [advanced integration](advanced.md).

## Security and boundaries

- Signing keys stay with the operator. API credentials never belong in page JavaScript.
- Credentials are presented only after a verified challenge for the intended origin. Discovery cannot silently replace the API or trust root.
- A proof is short-lived and bound to its first presenting session. Reuse in another session downgrades both sessions.
- A valid certificate is not proof of benign behavior. The deployed verifier must assess the browser/session independently.
- Customer actions require a separate human session at the institution's origin. Agent-provided payment or application context is not authoritative; the institution verifies it before approval.
- Expiry and revocation must be checked when access is used, not just when consent was collected.
- Persist only needed evidence; never put licenses, biometrics, raw identity documents, or secrets in result metadata.

The reference server is a single-process, file-backed sandbox, not a production authorization service. Durable atomic issuance, unique bindings, multi-process coordination, verified origin ownership, customer authentication and business execution are deployment responsibilities. Test helpers simulate them and reject live keys.

## Transport internals

The implementation retains signed operator and agent certificates, an internal immutable consent snapshot and signed delegation certificate, and a short-lived session grant. These are cryptographic artifacts, not separate public integration flows. There are no public terms/delegation endpoints or old CLI aliases. See [transport and evidence](advanced.md), [API](api.md), and [role guides](guides/site.md).
