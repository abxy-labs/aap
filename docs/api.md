# API reference

## Public site discovery

A site can serve unauthenticated `GET /.well-known/aap` on its own
origin, pointing to this API. See [Site discovery](discovery.md) for the
versioned document and SDK/CLI integration. The reference server serves it only
when explicitly configured with a profile. It supports HEAD and conditional GET,
five-minute public caching, ETags, and public CORS. Discovery does not expose
policies, require credentials, or replace authorization. The authenticated
`GET /v1/directory` remains an optional hashed participation list, and
`GET /.well-known/foil-root` remains the configured service's key endpoint.

The Agent Admission Protocol API is a resource-oriented HTTP API with JSON request and response bodies. Operators use it to register agents, fetch terms, create delegations, and manage handoffs. Sites use it to configure policies, read sessions, and complete handoffs. Both use it to receive events. Everything that involves a signing key happens on your machine, through the SDK or the command line; the API only ever sees public keys and signed objects.

This document describes the API as served by the reference implementation in this repository. Run it with `aap serve`. The base URL in the examples is `http://127.0.0.1:4010`.

## Conventions

### Authentication

Every request except account creation and the root key carries an API key as a bearer token.

```
Authorization: Bearer sk_test_51Hb2…
```

A key belongs to an account, and an account is either an operator or a site. The account type decides which endpoints the key may call: an operator key can create agents, terms, delegations, and handoffs; a site key can create policies and complete handoffs; both can read what they are party to and manage webhooks. Calling an endpoint for the other type returns a `permission_error`.

### Test and live modes

Each account has a test key, prefixed `sk_test_`, and a live key, prefixed `sk_live_`. Objects created with one are invisible to the other, and every object carries a `livemode` field. Test mode is a complete sandbox with additional endpoints under `/v1/test_helpers/` for the parts of the protocol that a real browser session would otherwise supply: consumer sessions, challenges, presentations, scope use, and handoff completion. Those endpoints refuse a live key.

### Versioning

Requests may name the API version they were written against.

```
AAP-Version: 2026-09-15
```

A request without the header uses the current version. A request naming a version the server does not know returns `invalid_api_version`. Responses echo the version they were served with in the same header.

### Request ids and idempotency

Every response carries a `Request-Id` header, and every error body includes the same id. Quote it when you report a problem.

A `POST` request may carry an `Idempotency-Key` header with any string up to 255 characters. Repeating a request with the same key and the same parameters returns the original response with `Idempotent-Replayed: true`, whether the original succeeded or failed. Repeating a key with different parameters returns an `idempotency_error`. The SDK sets a fresh key on every create automatically and lets you pass your own.

### Objects

Every object has an `id` prefixed by its type, an `object` field naming the type, a `created` Unix timestamp, a `livemode` flag, and a `metadata` map of up to 50 string keys you can use for your own references. Timestamps are Unix seconds. Amounts are integers in the minor unit of their currency, so `20000` with `"currency": "usd"` is two hundred dollars.

| Prefix | Object |
| --- | --- |
| `acct_` | Account |
| `op_` | Operator |
| `ag_` | Agent |
| `pol_` | Policy |
| `trm_` | Terms |
| `dl_` | Delegation |
| `dr_` | Delegation record |
| `sess_` | Session |
| `ho_` | Handoff |
| `evt_` | Event |
| `att_` | Attestation |
| `iss_` | Issuer |
| `we_` | Webhook endpoint |
| `req_` | Request |

### Lists

List endpoints return a list object. Items are ordered newest first. Pass `limit` (1 to 100, default 10) and either `starting_after` or `ending_before` with an object id to page.

```json
{ "object": "list", "url": "/v1/delegations", "has_more": true, "data": [ … ] }
```

### Expanding objects

Fields that hold the id of another object can be expanded into the object itself with `expand[]`, as a query parameter on reads or a body field on writes. Paths may be nested with dots, and `data.` addresses the items of a list.

```
GET /v1/sessions/sess_9d02?expand[]=delegation.record
GET /v1/delegations?expand[]=data.agent
```

### Errors

Errors return an HTTP status in the 4xx or 5xx range and a body with one `error` object.

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "terms_expired",
    "message": "Terms trm_3f2a expired at 1756903600. Create new terms and present them again.",
    "param": "terms",
    "doc_url": "https://docs.usefoil.com/aap/errors#terms_expired",
    "request_id": "req_8Hn3…"
  }
}
```

| Type | Status | Meaning |
| --- | --- | --- |
| `invalid_request_error` | 400, 404, 405 | The request was malformed, named an object that does not exist, or asked for something the protocol does not allow. `code` says which. |
| `authentication_error` | 401 | No key, or a key the server does not recognize. |
| `permission_error` | 403 | The key's account may not do this: wrong account type, an origin it does not own, a live key on a test helper, or a handoff completed from the wrong session. |
| `idempotency_error` | 400 | An idempotency key was reused with different parameters. |
| `api_error` | 500 | Something went wrong on the server. Retry with the same idempotency key. |

## Accounts and operators

An account is who holds the keys. In production, operators are vetted and sites are onboarded out of band, and Foil issues the keys. The reference server offers `POST /v1/accounts` in their place so that one machine can play every part.

```
POST /v1/accounts
```

| Parameter | Type | Description |
| --- | --- | --- |
| `type` | string | `operator` or `site`. Required. |
| `name` | string | Display name. Required. |
| `public_key` | object | The operator's public key as a JWK, EC P-256 or Ed25519. Required for operators. |
| `session_handling` | string | Operators: how transferred sessions are handled. |
| `attestations` | list | Operators: third-party credentials, each with `type`, `issuer`, and optionally `ref`, `credential`, `issued_at`, `expires_at`. |
| `asn`, `ja4` | list | Operators: the network and TLS profile of your browsers. Sessions presenting your credentials from elsewhere are downgraded with `operator_mismatch`. |

The response carries the account, both API keys, and for operators the operator object with its certificate. Keys are shown once.

```json
{
  "account": { "id": "acct_1Kf3…", "object": "account", "type": "operator", "name": "Example Browser Co", "operator": "op_7a1d", "origins": [] },
  "keys": { "test": "sk_test_…", "live": "sk_live_…" },
  "operator": { "id": "op_7a1d", "object": "operator", "name": "Example Browser Co", "vetting": "standard", "attestations": [], "public_key": { … }, "certificate": "eyJ…", "expires_at": 1788436000 }
}
```

`GET /v1/account` returns the account behind the current key, with the operator object inlined for operator accounts.

## Agents

An agent is a named product with its own key pair and a ceiling: the most it may ever be granted. The operator issues the agent's certificate by signing it with the operator key; the API records it and never holds a private key.

```json
{
  "id": "ag_9c4e",
  "object": "agent",
  "created": 1756900000,
  "livemode": false,
  "operator": "op_7a1d",
  "name": "bill-pay-assistant",
  "status": "active",
  "public_key": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "ceiling": {
    "scopes": ["accounts:read", "transactions:read", "payments:initiate"],
    "constraints": { "currency": "usd", "max_amount": 50000, "payees": "existing_only" }
  },
  "certificate": "eyJ…",
  "expires_at": 1764676000,
  "metadata": {}
}
```

### Create an agent

```
POST /v1/agents
```

| Parameter | Type | Description |
| --- | --- | --- |
| `certificate` | string | The agent certificate, signed with your operator key. Its `sub` becomes the agent id, and its `name`, `key`, and `ceiling` become the object's fields. Required. |
| `metadata` | object | Your references. |

The SDK builds the certificate for you: `aap.agents.create({ name, ceiling })` generates a key pair, signs, posts, and keeps the private key in its keyring. From the command line, `aap agents create --name bill-pay-assistant --scopes accounts:read,payments:initiate --max-amount 50000 --currency usd` does the same and stores the key under your profile.

A ceiling may not include `security:write`, and its scopes must be in the [vocabulary](spec.md#scope-vocabulary).

### Retrieve, list, update, deactivate

```
GET  /v1/agents/:id
GET  /v1/agents?status=active
POST /v1/agents/:id            { "metadata": { … } }
POST /v1/agents/:id/deactivate
```

Sites may retrieve and list agents so they can allow or deny them by name. Deactivating an agent moves every later presentation under it to the bot plane with `agent_deactivated`; existing delegations remain but cannot be used.

## Policies

A policy is a site's statement of which agents it admits and what they may do. Each create makes a new immutable version for the origin, and the current version is what verification applies. The first policy for an origin claims that origin for the account.

```json
{
  "id": "pol_2Qm7…",
  "object": "policy",
  "created": 1756900000,
  "livemode": false,
  "origin": "bank.example",
  "version": 14,
  "tier": "transact",
  "allow": { "operators": "any", "agents": "any", "deny_agents": [] },
  "constraints": { "currency": "usd", "max_amount": 20000, "max_count": 5 },
  "disclosures": { "bundle": "linking-v4", "presentation": "app", … },
  "evidence": { "read": "asserted", "transact": "observed" },
  "handoffs": [
    { "scope": "payments:initiate", "mode": "approve", "url": "https://bank.example/agent/confirm?aap_handoff={id}" },
    { "scope": "identity:verify", "url": "https://bank.example/apply/verify?aap_handoff={id}", "expires_in": 86400 }
  ],
  "max_age_s": 2592000,
  "disclose": { "operator": true, "agent": true },
  "credentials": null,
  "statement": "eyJ…",
  "metadata": {}
}
```

### Create a policy

```
POST /v1/policies
```

| Parameter | Type | Description |
| --- | --- | --- |
| `origin` | string | The origin this policy governs. Required. |
| `tier` | string | The highest tier any agent may reach: `observe`, `read`, `manage`, `transact`, or `none` to stop admitting agents. Default `read`. |
| `allow` | object | `operators` and `agents` are `"any"` or lists of ids; `deny_agents` is a list of agent ids refused by name. |
| `constraints` | object | Limits on transact scopes: `currency`, `max_amount`, `max_total`, `max_count`, `payees`. The more restrictive of yours and the agent's applies. |
| `disclosures` | object | A disclosure bundle. See [Disclosures](spec.md#disclosures). |
| `evidence` | object | Per tier, the evidence a delegation must carry: `asserted`, `observed`, `attested`, `presented`, or `site`. |
| `handoffs` | list | Per scope, `mode` (`approve` or `complete`, default `complete`), an https `url` template with `{id}` and optionally `{code}`, and `expires_in` in seconds (default 900; 86400 for `identity:verify`). |
| `max_age_s` | integer | Maximum delegation age in seconds. Default 30 days. |
| `disclose` | list | `operator` and/or `agent`, to show those names in your session responses. |
| `attestations` | object | Which attestations this site accepts: `issuers` (issuer ids, or `"operator"` for the delegation's own operator and its agents), `types`, required `claims`, and optionally `max_age_s`. Configuring it requires nothing until a tier's evidence is `attested`. |
| `credentials` | object | Reserved for consumer-held credentials: accepted `types`, `issuers`, and requestable `claims`. |

`GET /v1/policies/:id` and `GET /v1/policies?origin=` read your own policies. Operators never read policies directly; they read terms, which are the policy already intersected with their agent.

## Terms

Terms are what a consumer must be shown before authorizing an agent at an origin: the scopes that survive the intersection of the request, the agent's ceiling, and the site's policy, each with a plain-language string; the constraints; the site's disclosures; and the evidence rules. Terms are an object with an id and a one-hour expiry, and the consumer's acceptance references the id.

```json
{
  "id": "trm_3f2a…",
  "object": "terms",
  "created": 1756900000,
  "livemode": false,
  "agent": "ag_9c4e",
  "origin": "bank.example",
  "policy_version": 14,
  "scopes": [
    { "id": "accounts:read", "text": "See your accounts and balances" },
    { "id": "payments:initiate", "text": "Make payments up to $200 each to payees you already have" }
  ],
  "constraints": { "currency": "usd", "max_amount": 20000, "max_count": 5, "payees": "existing_only" },
  "max_age_s": 2592000,
  "evidence": { "read": "asserted", "transact": "observed" },
  "disclosures": {
    "bundle": "linking-v4",
    "presentation": "app",
    "documents": [ { "id": "esign", "title": "Consent to electronic records", "url": "https://…", "format": "text/markdown", "sha256": "…", "render": "full" } ],
    "acknowledgements": [ { "id": "esign", "text": "I agree to receive these documents electronically" }, { "id": "share", "text": "I authorize bill-pay-assistant to access my accounts as described for 30 days" } ],
    "retain": "copy_required"
  },
  "expires_at": 1756903600,
  "metadata": {}
}
```

```
POST /v1/terms          { "agent": "ag_9c4e", "origin": "bank.example", "scopes": ["accounts:read", "payments:initiate"] }
GET  /v1/terms/:id
```

`scopes` defaults to the agent's whole ceiling. If the origin does not admit agents the request fails with `origin_not_participating`; if no requested scope survives the intersection it fails with `no_permitted_scopes`.

## Delegations

A delegation is a consumer's authorization of one agent at one origin, valid until it expires or is revoked. It is issued by Foil as a signed certificate after the operator posts the consumer's acceptance. Its scopes are the intersection of the agent's ceiling, the site's policy, and what the consumer accepted, and every grant under it must narrow them.

```json
{
  "id": "dl_1Qx8k2",
  "object": "delegation",
  "created": 1756900000,
  "livemode": false,
  "status": "active",
  "agent": "ag_9c4e",
  "operator": "op_7a1d",
  "origin": "bank.example",
  "subject": "usr_41b",
  "scopes": ["accounts:read", "payments:initiate"],
  "constraints": { "currency": "usd", "max_amount": 20000, "max_count": 5, "payees": "existing_only" },
  "terms": "trm_3f2a",
  "issuer": "foil",
  "intent": "Pay monthly bills",
  "policy_version": 14,
  "expires_at": 1759492000,
  "revoked_at": null,
  "revoked_by": null,
  "record": "dr_5e1",
  "certificate": "eyJ…",
  "metadata": { "task": "monthly-bills" }
}
```

`status` is `active`, `revoked`, or `expired`. `record` is the id of the delegation record, expandable, which holds the asserted evidence from the application, the observed evidence from Foil, and the reserved `presented` block.

### Create a delegation

```
POST /v1/delegations
```

| Parameter | Type | Description |
| --- | --- | --- |
| `agent` | string | Your agent's id. Required. |
| `origin` | string | The origin. Required. |
| `subject` | string | Your stable pseudonymous id for the end user. Never personal data. Required. |
| `terms` | string | The terms the consumer was shown. Required. |
| `acceptance` | object | `terms` (the same id), `acknowledged` and `viewed` lists of ids, `channel`, `accepted_at`, and `copies_sent_to` when the bundle requires a retained copy. Required. |
| `scopes` | list | Scopes to authorize, a subset of the terms' scopes. Defaults to all of them. |
| `intent` | string | Free text describing the purpose. Shown to the site; never verified. |
| `site_session` | string | The consumer's live session at the origin, when there is one, for observed evidence. |
| `signature` | string | The request signed with the agent's key. The SDK adds it. Required. |
| `metadata` | object | Your references. |

The request is refused with a code that names the problem: `terms_expired`, `terms_stale` when the policy changed since the terms were created, `acknowledgements_missing`, `documents_not_viewed`, `copy_required`, `disclosures_site_only`, `scopes_not_in_terms`, `site_session_unknown`, or `invalid_signature`.

### Retrieve, list, revoke

```
GET  /v1/delegations/:id
GET  /v1/delegations?agent=&origin=&subject=&status=
POST /v1/delegations/:id/revoke     { "by": "consumer" }
```

Operators see their own delegations; sites see delegations at origins they own. Either may revoke. Every grant under a revoked delegation is refused at its next verification with `delegation_revoked`.

## Attestations

An attestation is a statement about the consumer, signed by an issuer, recorded against a delegation. The credential is a W3C verifiable credential serialized as a JWT with the `vc+jwt` media type, signed with ES256 or EdDSA, whose subject is the delegation's pseudonymous identifier.

```json
{
  "id": "att_4Kq2m",
  "object": "attestation",
  "created": 1758000120,
  "livemode": false,
  "status": "active",
  "delegation": "dl_1Qx8k2",
  "origin": "bank.example",
  "issuer": "https://identity.example",
  "type": "EmailControlCredential",
  "subject": "urn:aap:subject:op_7a1d:usr_41b",
  "claims": { "email_verified": true },
  "issued_at": 1758000000,
  "valid_until": 1760592000,
  "verified_at": 1758000120,
  "submitted_by": "issuer",
  "holder_bound": false,
  "revoked_at": null,
  "revoked_by": null,
  "metadata": {}
}
```

`status` is `active`, `revoked`, or `expired`. `claims` holds only the claims the site's policy names; everything else in the credential is discarded and the credential itself is not retained. `holder_bound` is always false: this is a statement by an issuer, not a presentation from the consumer's own wallet.

### Submit an attestation

```
POST /v1/delegations/:id/attestations     { "credential": "eyJ…" }
```

An operator may submit against its own delegations. An issuer account may submit against any delegation whose id it has been given, which is what lets a provider deliver its own statement; it cannot read the delegation. A site may submit against delegations at its origins.

An operator can also attach credentials when it creates the delegation, which avoids a second call and any exchange with the site:

```
POST /v1/delegations     { …, "attestations": ["eyJ…"] }
```

The credential is checked against the keys registered for the issuer it names, so a credential signed by one accepted issuer cannot name another. It is then checked against the site's policy. Failures are returned as `credential_invalid`, `issuer_not_accepted`, `attestation_type_not_accepted`, `attestation_subject_mismatch`, `attestation_claims_missing`, `attestation_too_old`, `attestations_not_accepted`, `no_trusted_issuer`, `issuer_mismatch`, or `delegation_inactive`.

### Retrieve, list, revoke

```
GET  /v1/attestations/:id
GET  /v1/attestations?delegation=&origin=&issuer=&status=
POST /v1/attestations/:id/revoke
```

The site and the issuing provider can revoke; the operator cannot. A revoked attestation stops satisfying a policy at the next session binding or scope use.

## Issuers

An issuer is a party whose signed statements a site can accept. Registration is `POST /v1/accounts` with `type: "issuer"`, an https `url` that credentials name as their issuer, and `public_keys`, each a public JWK with a `kid`.

```
GET /v1/issuers/:id
GET /v1/issuers
```

Both are readable by any account, so a site can see the issuers it might accept and an operator can see which issuer a site named. A site names issuers by id in its policy. Naming `"operator"` instead accepts credentials signed by the delegation's own operator or its agents, which is how an application states a check it performed itself.

## Sessions

A session is one browser session at one origin as Foil scored it. Sites read sessions on the verification call they already make. An agent session carries the agent block: what the session may do, what it has done, and the delegation behind it.

```json
{
  "id": "sess_9d02",
  "object": "session",
  "created": 1756901000,
  "livemode": false,
  "origin": "bank.example",
  "plane": "agent",
  "status": "active",
  "decision": { "verdict": "allow", "plane": "agent" },
  "agent": {
    "id": "ag_9c4e",
    "name": "bill-pay-assistant",
    "operator": "op_7a1d",
    "grant": "g_71c",
    "intent": "Pay September electric bill",
    "scopes": ["accounts:read", "payments:initiate"],
    "scopes_used": ["accounts:read"],
    "constraints": { "currency": "usd", "max_amount": 20000, "max_count": 5, "payees": "existing_only" },
    "delegation": {
      "id": "dl_1Qx8k2", "issuer": "foil", "policy_version": 14,
      "created_at": "2026-09-01T14:03:40Z", "expires_at": "2026-10-01T14:03:40Z", "record": "dr_5e1",
      "asserted": { "terms": "trm_3f2a", "acknowledged": ["esign", "share"], "channel": "imessage" },
      "observed": { "site_session": "sess_2b81", "human": true, "known_device": true, "age_s": 240, "handoffs": ["payments:initiate"] },
      "attested": [
        { "attestation": "att_4Kq2m", "issuer": "https://identity.example", "type": "EmailControlCredential",
          "claims": { "email_verified": true }, "holder_bound": false,
          "issued_at": 1758000000, "valid_until": 1760592000, "verified_at": 1758000120 }
      ],
      "presented": null
    },
    "handoff": null,
    "approvals": [
      { "handoff": "ho_4Kq2m", "scope": "payments:initiate", "context": { "amount": 14210, "currency": "usd", "payee": "Pacific Power" }, "approved_at": 1756901420, "expires_at": 1756905020 }
    ]
  },
  "next_action": null,
  "metadata": {}
}
```

`plane` is `human`, `agent`, or `bot`. `status` is `active`, `requires_handoff`, or `downgraded`. When a session requires a handoff, `next_action` names it. A session that presented a grant and failed a check is on the bot plane with a reason:

```json
{ "id": "sess_0000", "object": "session", "plane": "bot", "status": "downgraded",
  "decision": { "verdict": "block", "plane": "bot" },
  "agent": { "grant": "g_71c", "reason": "grant_replayed", "message": "grant g_71c was already presented by session sess_9d02" } }
```

```
GET /v1/sessions/:id
GET /v1/sessions?origin=&status=&plane=
```

A site reads sessions at its origins. An operator reads sessions bound under its own grants. `id`, `name`, and `operator` appear in the agent block only when the site's policy discloses them.

## Handoffs

A handoff is a step the consumer must complete on the site from their own device. It is an object with a lifecycle, and the session tells you when one is needed: the session's `status` becomes `requires_handoff` and `next_action` names the handoff. The agent asks for a handoff before it acts, with the details of what it proposes; or the session reaches a handoff scope and Foil creates one for it.

```json
{
  "id": "ho_4Kq2m",
  "object": "handoff",
  "created": 1756901000,
  "livemode": false,
  "status": "pending",
  "mode": "approve",
  "session": "sess_9d02",
  "delegation": "dl_1Qx8k2",
  "agent": "ag_9c4e",
  "operator": "op_7a1d",
  "origin": "bank.example",
  "scope": "payments:initiate",
  "context": { "amount": 14210, "currency": "usd", "payee": "Pacific Power", "memo": "September electric" },
  "display": {
    "title": "Confirm a payment",
    "message": "bill-pay-assistant wants to pay $142.10 to Pacific Power from your bank.example account. Confirm it on bank.example from your own device."
  },
  "url": "https://bank.example/agent/confirm?aap_handoff=ho_4Kq2m",
  "code": "7KQ-M4X",
  "expires_at": 1756901900,
  "completed_at": null,
  "completed_by": null,
  "result": null,
  "linked_session": null,
  "canceled_by": null,
  "metadata": {}
}
```

| Field | Meaning |
| --- | --- |
| `status` | `pending`, `completed`, `canceled`, or `expired`. |
| `mode` | `approve`: the consumer approves the agent's proposed action and the agent then performs it, receiving an approval on the session. `complete`: the consumer performs the step on the site and the agent resumes afterward. The site's policy chooses per scope; `identity:verify` and site-only disclosures are always `complete`. |
| `context` | What the agent proposes, in the shape the scope defines. `payments:initiate` requires `amount`, `currency`, and `payee`. The site renders its confirmation from this rather than from the page. |
| `display` | Plain language assembled from the scope, the context, the agent's name, and the origin, for the application to show in any channel. |
| `url` | The site's own page for this step, from the template in its policy with the id filled in. Null when the site set none; the consumer is then told to open the site and use the code. |
| `code` | A short code for channels where a link cannot be tapped. |
| `linked_session` | The consumer's session at the site once the SDK, or the site, has attached it. |
| `completed_by` | The consumer session that completed the step, with whether it was scored human and on what kind of device. |
| `result` | Whatever the site reported on completion, such as a verification outcome. |

### Create a handoff

```
POST /v1/handoffs      { "session": "sess_9d02", "scope": "payments:initiate", "context": { "amount": 14210, "currency": "usd", "payee": "Pacific Power" } }
```

Operators create handoffs for their own sessions. The scope must be in the session's grant. One pending handoff exists per session and scope; creating another returns the pending one. In `approve` mode the scope's required context fields must be present, or the request fails with `context_missing`. A session that reaches a handoff scope without asking gets a handoff with no context, and because there is nothing specific to approve, its mode is `complete`.

### Retrieve, list, update

```
GET  /v1/handoffs/:id
GET  /v1/handoffs?session=&origin=&status=
POST /v1/handoffs/:id     { "url": "https://verify.vendor.example/i/abc" }     (site)
POST /v1/handoffs/:id     { "metadata": { … } }                                (either)
```

A site that sets no URL template in its policy can set the URL per handoff, for instance to a vendor's hosted verification link, after receiving `handoff.created`.

### Complete a handoff

```
POST /v1/handoffs/:id/complete     { "session": "sess_c7f1", "result": { "outcome": "passed" } }
```

The site calls this after the consumer completes the step. `session` is the consumer's session at the site; it can be omitted when the page that hosted the step ran the SDK with the handoff id in its URL, since the SDK links that session on its own. Foil checks that the session is at the site's origin, was scored human, and is not the agent's session. A completion from the agent's own session is refused with `handoff_completed_by_agent`, and the agent session is downgraded.

On completion the session returns to `active`, the completed scope is added to the delegation record's observed evidence, and in `approve` mode an approval carrying the context is added to the session's agent block for one hour. The site checks the agent's subsequent submission against that approval the same way it checks amounts against constraints.

### Cancel

```
POST /v1/handoffs/:id/cancel
```

Either party may cancel a pending handoff. The session returns to `active` without the step.

## Events and webhooks

Every change produces an event. Events can be listed, and they are delivered to webhook endpoints you register.

```json
{
  "id": "evt_2Kd9…",
  "object": "event",
  "created": 1756901420,
  "livemode": false,
  "type": "handoff.completed",
  "data": { "object": { "id": "ho_4Kq2m", "object": "handoff", "status": "completed", … } },
  "pending_webhooks": 0,
  "request": { "id": "req_8Hn3…", "idempotency_key": null }
}
```

| Type | When |
| --- | --- |
| `agent.created`, `agent.deactivated` | An operator registered or deactivated an agent. |
| `policy.created` | A site published a policy version. |
| `terms.created` | Terms were created for an agent at an origin. |
| `delegation.created`, `delegation.revoked`, `delegation.expired` | A delegation changed state. Expiry is noticed on the next read of the delegation. |
| `attestation.created`, `attestation.revoked` | An attestation was accepted against a delegation, or stopped counting. Events carry the attestation object, which holds only policy-named claims. |
| `session.bound`, `session.downgraded`, `session.scope_used` | A presentation was verified, a session failed a check, or a bound session exercised a scope. |
| `handoff.created`, `handoff.completed`, `handoff.canceled`, `handoff.expired` | A handoff changed state. |

```
GET  /v1/events/:id
GET  /v1/events?type=handoff.completed
POST /v1/webhook_endpoints      { "url": "https://app.example/aap/webhooks", "enabled_events": ["handoff.completed", "delegation.revoked"] }
GET  /v1/webhook_endpoints/:id
GET  /v1/webhook_endpoints
POST /v1/webhook_endpoints/:id  { "enabled_events": [ … ], "status": "disabled" }
DELETE /v1/webhook_endpoints/:id
```

`enabled_events` accepts `"*"` for every type. The create response includes the endpoint's signing secret, prefixed `whsec_`, once.

### Verifying deliveries

Each delivery is a `POST` with the event as its body and two headers.

```
AAP-Signature: t=1756901421,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
AAP-Event-Id: evt_2Kd9…
```

`v1` is the hex HMAC-SHA256, keyed with the endpoint secret, of the timestamp, a period, and the raw body. Verify it before trusting the body, and reject deliveries whose timestamp is more than five minutes old. The SDK does both:

```ts
const event = aap.webhooks.constructEvent(rawBody, req.headers.get("aap-signature"), process.env.AAP_WEBHOOK_SECRET);
```

Deliveries that fail are not retried by the reference server. Read `pending_webhooks` on the event to see whether any are outstanding.

## Directory

```
GET /v1/directory
```

Operators may read the hashed list of origins whose current policy admits agents, each as the SHA-256 of the lowercase origin. It is an optional participation hint, not endpoint discovery or proof of current authorization. A directory hit does not replace a fresh, origin-bound signed challenge. For site-hosted endpoint and capability discovery, see [Site discovery](discovery.md).

## Root key

```
GET /.well-known/foil-root
```

Returns Foil's root public keys. Use it to verify challenges before answering them and to verify a delegation certificate without contacting the API.

## Test helpers

Test mode stands in for the parts of the protocol that a live browser session would supply. Every endpoint below requires a test key.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/test_helpers/agents` | The fixed-outcome test agents. |
| `POST /v1/test_helpers/sessions` | A consumer session Foil observed at `origin`. `human` (default true), `known_device`, `age` in seconds, `device`. Use its id as `site_session` on a delegation or to complete a handoff. |
| `POST /v1/test_helpers/challenges` | A signed challenge for `origin`, as the SDK's telemetry response would carry. |
| `POST /v1/test_helpers/presentations` | Verify a presentation and bind a session. Pass `header` (the `Foil-Agent-Grant` value) or `agent` (a test agent id), plus `origin`, and optionally `session`, `asn`, `ja4`, `scopes`. Returns the session with `status_header`. |
| `POST /v1/test_helpers/sessions/:id/use` | The session exercised `scope`. Returns the session, and the handoff when the scope required one. |
| `POST /v1/test_helpers/handoffs/:id/link` | Attach a consumer session to a pending handoff, as the SDK does from the page URL. Creates one when `session` is omitted. |
| `POST /v1/test_helpers/handoffs/:id/complete` | The consumer completed the step. Creates and links a consumer session when none is linked; accepts `outcome` or `result`. |
| `POST /v1/test_helpers/events` | Emit an event of `type` with a fixture object, or with `data` you supply. This is what `aap trigger` calls. |

### Test agents

A presentation that names one of these agents produces a fixed outcome without building a chain. They let a site exercise every branch of its integration before any operator has registered.

| Agent | Outcome |
| --- | --- |
| `ag_test_bound` | Binds on the agent plane with the requested scopes. |
| `ag_test_requires_handoff` | Binds, then immediately requires a handoff on `payments:initiate` in approve mode. |
| `ag_test_chain_invalid` | Downgraded, `chain_invalid`. |
| `ag_test_challenge_invalid` | Downgraded, `challenge_invalid`. |
| `ag_test_revoked` | Downgraded, `delegation_revoked`. |
| `ag_test_expired` | Downgraded, `delegation_expired`. |
| `ag_test_policy_denied` | Downgraded, `policy_denied`. |
| `ag_test_replayed` | Downgraded, `grant_replayed`. |
| `ag_test_operator_mismatch` | Downgraded, `operator_mismatch`. |
| `ag_test_evidence_insufficient` | Downgraded, `evidence_insufficient`. |
| `ag_test_scope_violation` | Downgraded, `scope_violation`. |

## Local operations

Three parts of the protocol are not API calls, because they involve a private key or run in the browser. The SDK and the command line provide them.

| Operation | SDK | Command |
| --- | --- | --- |
| Verify a challenge against the root key before answering | `aap.challenges.verify(jwt)` | `aap challenges verify` |
| Sign a per-session grant with the agent key | `aap.grants.sign({ delegation, challenge, sessionRef, intent })` | `aap grants sign` |
| Build the `Foil-Agent-Grant` header with the chain | `aap.presentations.build({ grant, delegation })` | `aap present` |
| Verify a delegation certificate offline | `aap.chain.verify(delegation)` | `aap verify-chain` |
| Verify a webhook delivery | `aap.webhooks.constructEvent(body, header, secret)` | |

The headers exchanged on the SDK's telemetry channel are unchanged from the specification: `Foil-Agent-Challenge` on responses from participating origins, `Foil-Agent-Grant` on the request that answers it, `Foil-Agent-Status` with `bound` or `downgraded; reason=…`, and `Foil-Agent-Handoff` with `required; id=ho_…` or `completed; id=ho_…`.

## Reference server endpoints

Two endpoints exist only in the reference server: `GET /v1/health`, and `GET /v1/dev/logs?after=<seq>` which returns recent requests with their ids, status codes, and durations and is what `aap logs tail` reads.
