# Integrate a site

This guide is for an engineer at a site that runs the Foil SDK on its pages and calls the Foil session verification endpoint from its server. It covers configuring a policy, reading the fields the protocol adds to the verification response, gating routes, handling a handoff, revoking a delegation, and retaining records. When you finish, agents that your policy admits arrive on the agent plane with a scope list, and everything else continues to be treated as it is today.

The guide assumes you have read the [Key concepts](../spec.md#key-concepts) section of the specification.

## Before you begin

You need the following in place.

- The Foil SDK runs on every page an agent will visit, including pages inside authenticated flows.
- Your server calls `GET /v1/sessions/{id}` and acts on `decision.verdict`. The protocol adds fields to this response and does not add a new call.
- An inventory of the routes or actions on your site that an agent could reach, so you can map them to scopes.
- Your disclosure documents, if the flows you are opening require them, and agreement from your compliance team on which acknowledgements the customer must give.

Nothing in this guide requires a new SDK, a new endpoint on your side, or changes to your pages.

## What you read and what you write

| You write | Where | You read | Where |
| --- | --- | --- | --- |
| A policy: tier ceiling, admitted agents, constraints, disclosure bundles, evidence requirements, handoff scopes | Foil dashboard | `decision.plane` and the `agent` block | `GET /v1/sessions/{id}` |
| A handoff completion | `POST /v1/handoffs/{id}/complete` | A handoff the consumer arrived to complete | `GET /v1/handoffs/{id}` |
| A revocation | `POST /v1/delegations/{id}/revoke` | A delegation record for retention | `GET /v1/delegations/{id}?expand[]=record` |

## Step 1: Map your routes to scopes

The protocol expresses permissions as scopes from a fixed vocabulary, listed in the [reference](../spec.md#scope-vocabulary). Your route mapping is internal to your site and never crosses the protocol. Build a table like the following before you configure anything, because the tier ceiling you choose in the next step is a decision about which rows an agent may reach.

| Route or action | Scope | Tier |
| --- | --- | --- |
| `GET /api/accounts` | `accounts:read` | read |
| `GET /api/accounts/{id}/transactions` | `transactions:read` | read |
| `GET /api/documents/statements/*` | `documents:read` | read |
| `POST /api/cards/{id}/lock` | `cards:manage` | manage |
| `POST /api/payments` | `payments:initiate` | transact |
| `POST /api/payees` | `payees:write` | transact |
| `POST /api/settings/password` | `security:write` | control, never grantable |

Every route that changes credentials, multi-factor settings, recovery contacts, or the login email or phone belongs in the control tier. An agent can never hold `security:write`, so your server should refuse those routes for any session on the agent plane without consulting the scope list.

If a route does not fit a scope, choose the closest scope by tier rather than inventing one. Additions to the vocabulary are made to the shared list, not per site.

## Step 2: Choose a tier ceiling

The tier ceiling is the highest tier any agent may reach on your site. Tiers are ordered, so the ceiling is one setting rather than a list of scopes. Most sites begin with read, which admits agents to balances, transactions, documents, and profile information and nothing that writes.

| Ceiling | What an agent can reach | Typical first use |
| --- | --- | --- |
| observe | Pages that require no login | A site that wants to admit agents to public content only |
| read | Authenticated read of the customer's data | Balances, history, statements |
| manage | Non-monetary writes | Card controls, alerts, disputes, support messages |
| transact | Money movement, with constraints | Bill pay, transfers, payees |

Raising the ceiling later does not widen any delegation that already exists, because the consumer accepted the narrower set. Lowering it narrows every existing delegation at its next verification.

## Step 3: Decide which agents are admitted

You can admit every operator Foil has vetted, named operators, or named agents. Most sites admit all vetted operators and use the deny list for exceptions. Denying an agent by name refuses that agent without affecting the other agents of its operator, which is the right tool when one product misbehaves.

Operator and agent names appear in your verification response only if you enable disclosure in Step 7. You can run the agent plane on scopes alone if you prefer not to see who is behind a session.

## Step 4: Set constraints for transact scopes

If your ceiling includes transact, set the constraints that apply to every agent on your site. Foil takes the more restrictive of your value and the agent's ceiling, so your constraints are a maximum, not a default.

| Constraint | Meaning | Who enforces it |
| --- | --- | --- |
| `currency` | The currency of the amounts | |
| `max_amount` | Maximum per transaction, in the minor unit | Your server, by comparing the request amount |
| `max_total` | Maximum total across a delegation, in the minor unit | Your server, by tracking totals per delegation id |
| `max_count` | Maximum number of transactions across a delegation | Your server, by counting per delegation id |
| `payees` | `existing_only` refuses new payees | Your server, at the payee routes |

Foil carries constraints in the delegation and returns them on every verification response. It does not observe amounts, so totals and counts are yours to track, keyed by the delegation id in the response. If you cannot track totals, leave `max_total` and `max_count` unset and rely on `max_amount`.

## Step 5: Attach disclosures

A disclosure bundle names the documents a consumer must see before an agent may act at a given tier, the acknowledgements they must give, how each document must be rendered, and whether a copy must be retained. Upload the documents in the dashboard and write the bundle.

```json
{
  "bundle": "linking-v4",
  "presentation": "app",
  "gates": ["accounts:read", "transactions:read", "payments:initiate"],
  "documents": [
    { "id": "esign", "title": "Consent to electronic records", "format": "text/markdown", "render": "full" },
    { "id": "privacy", "title": "Privacy notice", "format": "application/pdf", "render": "link" }
  ],
  "acknowledgements": [
    { "id": "esign", "text": "I agree to receive these documents electronically" },
    { "id": "share", "text": "I authorize {agent} to access my accounts as described for {days} days" }
  ],
  "retain": "copy_required"
}
```

Two settings decide where acceptance happens. `presentation: app` lets the agent's application present the bundle in whatever channel the consumer is using and collect the acceptance there. `presentation: site` means the bundle cannot be accepted in an application, and the consumer must complete that step on your site, from their own device. Use `site` for anything your compliance team is not willing to have collected through a third party's interface.

`render: full` requires the application to show the whole document before the consumer can accept. `render: link` allows a link. `retain: copy_required` requires the application to deliver a copy and to record where it was sent.

The placeholders `{agent}` and `{days}` are substituted with the agent's name and the delegation's maximum age when the terms are served.

## Step 6: Set evidence requirements and handoff scopes

For each tier, choose what evidence a delegation must carry before a session may use scopes at that tier.

| Requirement | Meaning | When to use it |
| --- | --- | --- |
| `asserted` | The application's signed statement that the consumer accepted is sufficient | Read tier |
| `observed` | Foil must hold an observed link to a live session for the same consumer at your site | Manage and transact |
| `presented` | The delegation must carry a verified credential presentation from the consumer. Reserved; no presentation can be recorded in the current version | Onboarding, once available |
| `site` | The step must be completed on your site by the consumer | Anything you would not delegate to an application |

Handoffs are steps the consumer must complete on your site regardless of tier. Configure one per scope with a mode and the URL of the page on your site that hosts the step.

```json
"handoffs": [
  { "scope": "payments:initiate", "mode": "approve", "url": "https://bank.example/agent/confirm?aap_handoff={id}" },
  { "scope": "identity:verify", "url": "https://bank.example/apply/verify?aap_handoff={id}", "expires_in": 86400 }
]
```

In `approve` mode the agent proposes an action with its details, the consumer approves it on your page, and the agent then performs it; the session carries an approval your server checks the submission against. This is the usual configuration for a first transact deployment: the agent prepares a payment and the consumer confirms it where your step-up controls already are. In `complete` mode the consumer performs the step on your page and the agent resumes afterward. Identity verification is always `complete`. `{id}` in the URL is replaced with the handoff id, so your page can retrieve the handoff and render what the agent proposed. Without a URL, the consumer is told to open your site and use a short code.

## Step 7: Choose what is disclosed to you

Decide whether the operator name and the agent name appear in your verification response. The plane, the scopes, the constraints, and the delegation record appear regardless. Most financial institutions enable both for their fraud team's benefit.

## Step 8: Read the verification response

When a session is on the agent plane, the verification response carries an `agent` block. Every field below is present on every response for an agent session, except the two names, which depend on Step 7.

```json
{
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
    "constraints": { "currency": "usd", "max_amount": 20000, "payees": "existing_only" },
    "delegation": {
      "id": "dl_1Qx8k2",
      "issuer": "foil",
      "policy_version": 14,
      "created_at": "2026-09-01T14:03:40Z",
      "expires_at": "2026-10-01T14:03:40Z",
      "record": "dr_5e1",
      "asserted": { "terms": "trm_3f2a", "acknowledged": ["esign", "share"], "channel": "imessage" },
      "observed": { "site_session": "sess_2b81", "human": true, "known_device": true, "age_s": 240 },
      "presented": null
    },
    "handoff": null,
    "approvals": []
  },
  "next_action": null
}
```

| Field | Use it for |
| --- | --- |
| `decision.plane` | Which plane the session is on. Only `agent` carries a full block. |
| `agent.scopes` | The scopes this session may exercise, after your current policy was applied. |
| `agent.scopes_used` | The scopes Foil has seen the session exercise so far. |
| `agent.constraints` | The limits to compare transaction requests against. |
| `agent.intent` | The agent's stated purpose, for logging and for your fraud team. |
| `agent.delegation.id` | The key for tracking totals and counts, and for revocation. |
| `agent.delegation.observed` | Whether Foil holds a link to a live session for the same consumer, and how old it was. |
| `status` | `active`, `requires_handoff`, or `downgraded`. |
| `next_action` | Set to the pending handoff when the session requires one. |
| `agent.handoff` | The id of the pending handoff, when set. |
| `agent.approvals` | Actions the consumer approved on your site, with the context they approved, for the agent to perform. |

A session that presented a grant and failed a check arrives on the bot plane with a reason.

```json
{
  "decision": { "verdict": "block", "plane": "bot" },
  "agent": { "grant": "g_71c", "reason": "grant_replayed" }
}
```

Treat it as you treat any bot verdict. The reason is for your logs; the operator receives the same reason on its own channel.

## Step 9: Gate routes

On each request from a session on the agent plane, check that the route's scope is in `agent.scopes`, and for transact routes compare the amount and the payee against `agent.constraints`. A session on the human plane is not subject to the scope list. A session on the bot plane is refused as today.

```ts
const session = await foil.sessions.get(sessionId);

if (session.decision.plane === "bot") return deny();
if (session.decision.plane === "human") return allow();

const scope = scopeForRoute(req);            // your table from Step 1
if (!session.agent.scopes.includes(scope)) return deny("outside_scope");

if (scope === "payments:initiate") {
  const c = session.agent.constraints;
  if (c.max_amount !== undefined && req.amount > c.max_amount) return deny("over_limit");
  if (c.payees === "existing_only" && !isExistingPayee(req.payee)) return deny("new_payee");
  if (c.max_total !== undefined && totalFor(session.agent.delegation.id) + req.amount > c.max_total) return deny("over_total");
  // approve mode: the consumer must have approved this exact payment on your site
  const approved = session.agent.approvals.find((a) => a.scope === scope && a.context.amount === req.amount && a.context.payee === req.payee);
  if (!approved) return deny("not_approved");
}
return allow();
```

Refuse control-tier routes for every agent session without consulting the list. The scope will never be present, and the check is cheaper than the lookup.

## Step 10: Handle a handoff

When an agent asks to perform a handoff scope, or reaches one without asking, a handoff is created. The session's status becomes `requires_handoff`, `next_action` names the handoff, and the operator is told. Treat the agent's attempt as incomplete rather than as an error.

The consumer opens the handoff's URL from their own device. It is a page on your site, the one you named in your policy, with the handoff id in the query string. Build that page as follows.

1. Retrieve the handoff. Confirm it is `pending`, at your origin, and for a scope you expect on this page.
2. Render your own confirmation from the handoff's `context`, which is what the agent proposed: for a payment, the amount, currency, and payee. Do not rely on anything the agent typed into your normal forms.
3. Apply your existing step-up controls. This is your page and your customer.
4. When the consumer confirms, complete the handoff. The SDK on your page linked the consumer's session to the handoff when the page loaded, so the call needs only the id and whatever result you want recorded.

```
GET  /v1/handoffs/ho_4Kq2m
POST /v1/handoffs/ho_4Kq2m/complete     { "result": { "confirmed": true } }
```

Foil checks that the completing session is at your origin, was scored human, and is not the agent's session. A completion from the agent's session is refused and the agent session is downgraded. On completion the agent session returns to `active`, the completed scope is added to the delegation record's observed evidence, and in `approve` mode an approval carrying the confirmed context is added to the session for one hour. Your server checks the agent's subsequent submission against it, as in Step 9.

For identity verification the same page launches your vendor's flow after retrieving the handoff, and completes the handoff from your vendor callback with the outcome as the result. Set `expires_in` to a day for that scope, since capture takes longer than a payment confirmation.

Subscribe to `handoff.created` if you want to prepare anything before the consumer arrives, and to `handoff.completed` and `handoff.expired` for your own records.

## Step 11: Revoke a delegation

You can revoke any delegation at your origin. Every grant under it stops being honored at its next telemetry beat, and the operator is notified.

```
POST /v1/delegations/{id}/revoke
```

Revoke when your fraud team sees activity it does not want to continue, when a customer asks you to, or when a customer closes an account. To stop an agent everywhere on your site rather than one delegation, add it to the deny list in your policy. To stop all agents, set the tier ceiling to none.

## Step 12: Retain records

The delegation record is the document your compliance team will want. Fetch it in full and store it in your own system.

```
GET /v1/delegations/{id}?expand[]=record
```

The record contains the terms, the document hashes, the acknowledgements given, the asserted and observed evidence including any handoffs the consumer completed, the policy version the delegation was created under, and the signature chain to Foil's root key. It can be verified without contacting Foil, so a copy in your retention store is sufficient on its own.

## Policy recipes

**Read-only balances and history.** Tier ceiling read. Admit all vetted operators. Evidence for read: asserted. A disclosure bundle with your electronic records consent and privacy notice, presentation app. No constraints, no handoff scopes. This is the configuration to start with.

**Bill pay with limits.** Tier ceiling transact. Constraints: `currency` usd, `max_amount` 20000, `max_count` 5, `payees` existing_only. Evidence for transact: observed. Handoff on `payments:initiate` in `approve` mode with the URL of your confirmation page. The agent can read accounts and prepare a payment, and the consumer confirms each payment on your site.

**Onboarding with identity verification.** Tier ceiling manage, admitting `application:write` and `identity:verify`. A handoff on `identity:verify` with the URL of your verification page and `expires_in` 86400. A disclosure bundle with the account agreement and electronic records consent, presentation site. The agent can fill the application, and the consumer verifies their identity and accepts the account agreement on your site.

## Test it locally

The reference API and the `aap` command let you exercise every branch of your integration before any operator has registered. Start the API, create a site account, set your policy, and use the fixed-outcome test agents. See the [command reference](../cli.md) for each command.

```
aap serve                                                              # in another terminal
aap accounts create --type site --name "Your Site"
aap policies create --origin yoursite.example --tier transact --currency usd --max-amount 20000 \
    --disclosures @bundle.json --evidence read=asserted,transact=observed \
    --handoff "scope=payments:initiate,mode=approve,url=https://yoursite.example/agent/confirm?aap_handoff={id}" \
    --disclose operator,agent
aap test presentations create --origin yoursite.example --agent ag_test_bound --scopes accounts:read
aap test presentations create --origin yoursite.example --agent ag_test_replayed
aap test presentations create --origin yoursite.example --agent ag_test_requires_handoff
```

The last command returns a session in `requires_handoff` with a pending handoff in approve mode. `aap sessions retrieve <id>` prints exactly what your server will read, `aap handoffs retrieve <id>` is what your confirmation page will read, and `aap test handoffs complete <id>` stands in for the consumer confirming on your page. Retrieve the session again to see the approval. `aap listen --forward-to localhost:3000/aap/webhooks` and `aap trigger handoff.completed` exercise your webhook handler.

## Common mistakes

- **Gating on the plane alone.** A session on the agent plane is not a session with every permission. Check the scope on every route.
- **Not tracking totals.** `max_total` and `max_count` are enforced by you. If you set them without tracking per delegation, they do nothing.
- **Reading the agent block on a bot session.** A downgraded session's block contains only the grant id and a reason. Do not look for scopes there.
- **Rendering the confirmation from the page instead of the handoff.** The handoff's context is what the agent declared. Show and check that.
- **Enabling transact with asserted evidence.** An application's assertion is enough for read. Money movement should require an observed link or a handoff.
- **Keeping only Foil's copy of the record.** Fetch and store the delegation record yourself. It verifies offline and outlives your relationship with any vendor.
- **Widening the ceiling and expecting existing delegations to widen.** They do not. The consumer accepted the narrower set, and the agent must obtain a new delegation.
