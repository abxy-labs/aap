# Integrate an operator

This guide is for a company that runs browsers for agents and controls those browsers at the network layer. It covers registering with Foil, issuing certificates for your agents, answering challenges, signing grants, injecting the header, reading the feedback Foil returns, and the optional pieces: the local component for session transfer and the directory. When you finish, sessions from your agents arrive on the agent plane at sites that admit them, and nothing about your sessions changes at sites that do not.

The guide assumes you have read the [Key concepts](../spec.md#key-concepts) and [How it works](../spec.md#how-it-works) sections of the specification. The application that puts your agents in front of consumers has its own guide, [Integrate an agent application](agent-app.md), and this guide points to it where the two meet.

## Before you begin

You need the following in place.

- A control plane that can hold private keys and sign tokens. Keys never need to be in the browser.
- The ability to add a request header at the network layer in your browser, beneath the page, for requests matching a host pattern. In Chromium this is the DevTools Protocol's Fetch domain with a URL pattern, or an equivalent in your own network stack.
- A stable identifier for each of your downstream customers, and a stable pseudonymous identifier for each of their end users.
- Egress network ranges and TLS fingerprints for your browsers, if you want Foil to check that sessions presenting your credentials look like your infrastructure.

## What you read and what you write

| You write | Where | You read | Where |
| --- | --- | --- | --- |
| Agent certificates | Your own store; presented in the chain | Operator certificate | Issued at registration |
| Delegation requests, signed with the agent key | `POST /v1/delegations` | Terms | `GET /v1/terms` |
| Grants, signed with the agent key | `Foil-Agent-Grant` header on telemetry | Challenges | `Foil-Agent-Challenge` header on telemetry responses |
| | | Status and handoff | `Foil-Agent-Status` and `Foil-Agent-Handoff` headers on telemetry responses |
| | | The root public key | `GET /.well-known/foil-root` |
| | | The directory, optionally | `GET /v1/directory` |

## Step 1: Register

Registration is a vetting process rather than an API call. You provide your operator public key, a statement about how you handle sessions that were transferred from a consumer's device, any third-party credentials about you that you want carried, such as a Know-Your-Agent credential from a card network, and optionally your network profile: the autonomous system numbers your browsers egress from and the TLS fingerprints they present. Foil issues an operator certificate that contains your operator id, your public key, your vetting level, the session-handling statement, and the attestations by type, issuer, and reference. It is valid for one year and is renewed through the same process.

If you already sign requests under Web Bot Auth, the Ed25519 key you use for that can be your operator key or an agent key here; the protocol accepts Ed25519 and EC P-256 keys. Sites see your attestations only if they enable operator disclosure, and Foil does not re-verify a network's credential; it records that you presented it and who issued it.

Store the operator private key in your control plane. It signs agent certificates and nothing else.

If you provide a network profile, Foil compares each presenting session with it and returns `operator_mismatch` when a session that carries your credentials does not look like your infrastructure. This protects you as much as the site: a stolen agent key used from somewhere else produces downgraded sessions rather than admitted ones, and the downgrade reason reaches you.

## Step 2: Issue agent certificates

An agent is a named product or agent type, not a session. Issue one certificate per agent, signed with your operator key, without contacting Foil. Foil learns of an agent the first time it appears in a chain.

```json
{
  "iss": "op_7a1d",
  "sub": "ag_9c4e",
  "name": "bill-pay-assistant",
  "key": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "ceiling": {
    "scopes": ["accounts:read", "transactions:read", "payments:initiate"],
    "constraints": { "max_amount": { "value": 500, "currency": "USD" }, "payees": "existing_only" }
  },
  "nbf": 1756900000,
  "exp": 1764676000
}
```

Three decisions matter here.

**One key per agent.** Each agent has its own key pair, and the agent key is what signs grants and delegation requests. Keep the private key in your control plane. A compromised agent key affects one agent, and you retire it by issuing a new certificate with a new key.

**The narrowest ceiling the agent needs.** The ceiling is the most an agent may ever hold. Sites see the agent's name and can deny it, and Foil tracks reputation per agent, so an agent whose ceiling matches its purpose is easier for a site to admit than one that asks for everything. A read-only research agent should have a read-only ceiling.

**Names a site can reason about.** The agent name appears in a site's verification response when the site enables disclosure, and sites can allow or deny agents by name. Name agents by what they do.

Certificates are valid for 90 days by default. Rotate by issuing a new certificate before expiry; a delegation created under the old certificate remains valid because the delegation names the agent, not the certificate.

## Step 3: Obtain a delegation

A delegation is created once for each consumer, agent, and site combination and lasts for its maximum age, which the site sets. The application collects the consumer's acceptance; you sign the request and post it. The application side is described in [Integrate an agent application](agent-app.md). Your side is the following.

1. Fetch the terms for the agent at the origin. The response is cacheable by ETag and changes only when the site's policy changes.
2. Pass the terms to the application, which presents them and returns an acceptance object.
3. Build the delegation request with the agent id, the origin, your subject identifier for the end user, the scopes the task needs, the intent, and the acceptance. If the consumer has a live session at the site on their own device, include its Foil session id as `site_session`; see Step 8.
4. Sign the request with the agent key and post it.
5. Store the delegation certificate keyed by subject, agent, and origin, together with its expiry.

```
POST /v1/delegations
{
  "agent": "ag_9c4e",
  "origin": "bank.example",
  "subject": "usr_41b",
  "scopes": ["accounts:read", "payments:initiate"],
  "intent": "Pay monthly bills",
  "acceptance": { "terms": "t_8f1", "acknowledged": ["esign", "share"], "viewed": ["esign", "privacy"],
                  "channel": "imessage", "accepted_at": "2026-09-01T14:03:40Z", "copies_sent_to": "email" },
  "site_session": "fs_2b81",
  "chain": ["<agent certificate>", "<operator certificate>"],
  "signature": "<request signed with the agent key>"
}
```

The `subject` is your identifier, not the site's. Foil does not learn who the consumer is. It binds the subject to the site's customer through the observed session link when one is present, or through the site's own step-up when it is not. Use the same subject for the same end user across sites and agents, and never use personal data as the subject.

Reuse the delegation for every session until it expires or is revoked. Do not ask the consumer again per session.

## Step 4: Answer the challenge

The Foil SDK on a site's pages sends telemetry to Foil's API hosts. When a page's origin has a policy that admits agents, the telemetry response carries a `Foil-Agent-Challenge` header containing a signed nonce bound to the origin and a short time window. Your browser sees this response at the network layer.

Before answering, verify the challenge.

1. Fetch and cache Foil's root public keys from `/.well-known/foil-root`.
2. Verify the challenge's signature against the root key.
3. Check that the challenge's `origin` matches the origin of the frame that received it, and that it has not expired.

Answer only a challenge that passes all three. An operator never presents credentials unprompted, and never in answer to a challenge it cannot verify. A site that does not run Foil cannot produce a valid challenge, and a site that runs Foil but does not admit agents never receives one to send, so this rule is what keeps your agents invisible everywhere they are not admitted.

## Step 5: Sign the grant

For each browser session at a participating origin, sign a grant with the agent key. The grant references the delegation, names the session, states the agent's intent, carries the challenge nonce, and may narrow the delegation's scopes to what the task needs.

```json
{
  "iss": "ag_9c4e",
  "delegation": "dl_3c9",
  "session_ref": "sess_19c2",
  "intent": "Pay September electric bill",
  "scopes": ["accounts:read", "payments:initiate"],
  "nonce": "<from the challenge>",
  "jti": "g_71c",
  "iat": 1756900000,
  "exp": 1756903600
}
```

A grant is valid for about an hour and is bound to one session the first time Foil sees it. Sign a new grant for each session. A grant presented by two sessions downgrades both.

An agent that needs more scope mid-task, within its delegation, signs a new grant with the wider scope over a fresh challenge. An agent that needs more scope than its delegation allows must obtain a new delegation, which means asking the consumer again through the application.

## Step 6: Inject the header

Add the grant to requests from the browser to Foil's API hosts, and to no other host.

```
Foil-Agent-Grant: <grant>;chain=<delegation>,<agent certificate>,<operator certificate>
```

Inject it at the network layer. Page scripts and service workers must not be able to observe the header, and the page must not be the party that adds it. In Chromium, enable the Fetch domain with a URL pattern for Foil's API hosts, and add the header in the request-paused handler for matching requests. Add nothing to requests to the site.

Send the full chain on the first presentation in a session. Foil caches certificates by key id, so later presentations in the same session can carry the grant alone.

Frames are evaluated separately. A page that embeds a widget from another participating origin, or opens a participating site in a popup, produces a challenge from each of those frames' telemetry. Answer each one on its own telemetry, with the same grant. Do not answer a challenge received in one frame on another frame's requests.

## Step 7: Read the feedback

Foil reports on the telemetry response, which your browser already receives. There is no webhook to operate for normal flow.

```
Foil-Agent-Status: bound
Foil-Agent-Status: downgraded; reason=grant_replayed
Foil-Agent-Handoff: required; scope=payments:initiate
```

| Status | What it means | What to do |
| --- | --- | --- |
| `bound` | The session is on the agent plane with the grant's scopes, as narrowed by the site's current policy | Proceed |
| `downgraded; reason=chain_invalid` | A signature did not verify or a scope was not a subset of the level above | Check the chain you sent and the keys that signed it |
| `downgraded; reason=challenge_invalid` | The grant was not signed over a challenge Foil issued for this origin, or the challenge expired | Answer only verified, current challenges from the same frame |
| `downgraded; reason=delegation_revoked` | The site or the consumer revoked the delegation | Stop the task and ask the consumer for a new delegation if appropriate |
| `downgraded; reason=delegation_expired` | The delegation passed its maximum age | Ask the consumer again |
| `downgraded; reason=policy_denied` | The site's current policy does not admit this operator or agent, or the scopes are above its ceiling | Stop; the site has made a decision |
| `downgraded; reason=grant_replayed` | The grant was presented by another session | Sign one grant per session; investigate if you did |
| `downgraded; reason=operator_mismatch` | The session does not look like your infrastructure | Investigate the session; this may indicate a leaked agent key |
| `downgraded; reason=evidence_insufficient` | The tier in use requires observed evidence and the delegation has only asserted evidence | Create the delegation while the consumer has a live session at the site, or narrow the grant to read |
| `downgraded; reason=scope_violation` | The session exercised a scope outside its grant | Fix the agent; it acted outside what it declared |

`Foil-Agent-Handoff: required` means the agent reached a step the consumer must complete on the site from their own device. Surface it to the application so it can tell the consumer, then wait. When the site reports the step complete, the session continues.

A site or consumer revoking a delegation is reported on the next telemetry response and is also available as an optional webhook.

## Step 8: Support session transfer

Many agents begin with the consumer signing in to a site on their own device, after which the session continues in your cloud browser. To a site this looks like cookie theft. The protocol turns it into evidence when the delegation was created while the consumer's session at the site was live and Foil could observe it.

To provide that link, your local component on the consumer's device reads the Foil session id for the consumer's current session at the site and passes it as `site_session` in the delegation request. The session id is visible in the SDK's telemetry requests from the page, which your local component can observe at the network layer the same way your cloud browser observes challenges. Create the delegation while that session is live; Foil records how old the session was when the delegation was created, and sites use the age in their evidence rules.

A delegation created this way carries observed evidence, which is what sites require for manage and transact tiers. A delegation created without it carries asserted evidence only, which sites accept for read.

## Step 9: Cache the directory

The directory is a hashed list of origins whose policy admits agents. It is optional. With it cached, you can present the grant on the first telemetry request from a participating origin instead of waiting for the challenge on the first response, which saves one telemetry beat at the start of a session. Sync it by ETag and hash origins with SHA-256 of the lowercase origin to check membership.

```
GET /v1/directory
```

The directory also lets you verify the confidentiality guarantee yourself, since an origin absent from it never receives a presentation from you regardless of what it sends.

## Step 10: Handle expiry and revocation

Track each delegation's `expires_at`. Before it passes, ask the consumer again through the application if the relationship is ongoing. A revoked delegation is reported as `delegation_revoked` on the next presentation and through the optional webhook. Remove revoked and expired delegations from your store so that no session attempts to present under them.

## Test it locally

The `aap` command in the reference implementation lets you stand in for Foil and for a site. The following creates a store, registers you, issues an agent, sets a site policy, and takes a delegation and a grant through verification. See the [command reference](../cli.md) for each command.

```
aap init
aap keygen --out operator.key.json
aap keygen --out agent.key.json
aap operator issue --id op_you --key operator.key.json --vetting standard --session-handling "encrypted at rest" --asn AS14618 --out operator.cert
aap agent issue --operator-cert operator.cert --operator-key operator.key.json --id ag_one --name your-agent \
    --key agent.key.json --scopes accounts:read,payments:initiate --max-amount 500 --out agent.cert
aap policy set --origin bank.example --tier transact --evidence read=asserted,transact=observed --handoff payments:initiate
aap terms --agent-cert agent.cert --origin bank.example --scopes accounts:read,payments:initiate
aap site session-record --id fs_live --origin bank.example --human --known-device --age-s 120
aap delegation create --agent-cert agent.cert --operator-cert operator.cert --agent-key agent.key.json \
    --origin bank.example --subject usr_1 --scopes accounts:read,payments:initiate --intent "Pay bills" \
    --acceptance acceptance.json --site-session fs_live --out delegation.cert
aap challenge --origin bank.example --out challenge.jwt
aap challenge verify challenge.jwt
aap grant sign --agent-key agent.key.json --agent-cert agent.cert --delegation delegation.cert \
    --session-ref sess_1 --intent "Pay electric bill" --challenge challenge.jwt --out grant.jwt
aap present --grant grant.jwt --delegation delegation.cert --agent-cert agent.cert --operator-cert operator.cert --out header.txt
aap verify --header-file header.txt --origin bank.example --session fs_agent --asn AS14618
```

Present the same header from a second session id to see `grant_replayed`, pass a different `--asn` to see `operator_mismatch`, and omit `--site-session` to see `evidence_insufficient` at the transact tier.

## Common mistakes

- **Presenting without a challenge, or answering an unverified one.** The rule that keeps your agents invisible at sites that have not admitted them is that you never volunteer. Verify every challenge against the root key before answering.
- **Injecting from the page.** A header added by page script is visible to the site and to any service worker. Inject beneath the page.
- **Answering a challenge on the wrong frame.** A challenge is bound to an origin. Answer it on that frame's telemetry.
- **Reusing a grant across sessions.** Each session gets its own grant. Two sessions with one grant are both downgraded.
- **Wide ceilings.** An agent that asks for the whole vocabulary is harder for a site to admit and easier for a site to deny by name.
- **Asking the consumer per session.** A delegation lasts for its maximum age. Reuse it.
- **Personal data in the subject.** The subject is a pseudonymous identifier. Foil does not need to know who the consumer is.
