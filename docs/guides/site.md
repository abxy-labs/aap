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
| A handoff completion | `POST /v1/sessions/{id}/handoff` | A delegation record for retention | `GET /v1/delegations/{id}` |
| A revocation | `DELETE /v1/delegations/{id}` | | |

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
| `max_amount` | Maximum per transaction | Your server, by comparing the request amount |
| `max_total` | Maximum total across a delegation | Your server, by tracking totals per delegation id |
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
| `site` | The step must be completed on your site by the consumer | Anything you would not delegate to an application |

Handoff scopes are scopes the consumer must complete on your site regardless of tier. Marking `payments:initiate` for handoff means an agent can prepare a payment and the consumer confirms it on your site, where your existing step-up controls apply. This is the usual configuration for a first transact deployment.

## Step 7: Choose what is disclosed to you

Decide whether the operator name and the agent name appear in your verification response. The plane, the scopes, the constraints, and the delegation record appear regardless. Most financial institutions enable both for their fraud team's benefit.

## Step 8: Read the verification response

When a session is on the agent plane, the verification response carries an `agent` block. Every field below is present on every response for an agent session, except the two names, which depend on Step 7.

```json
{
  "decision": { "verdict": "allow", "plane": "agent" },
  "agent": {
    "id": "ag_9c4e",
    "name": "bill-pay-assistant",
    "operator": "op_7a1d",
    "grant": "g_71c",
    "intent": "Pay September electric bill",
    "scopes": ["accounts:read", "payments:initiate"],
    "scopes_used": ["accounts:read"],
    "constraints": { "max_amount": { "value": 200, "currency": "USD" }, "payees": "existing_only" },
    "delegation": {
      "id": "dl_3c9",
      "policy_version": 14,
      "created_at": "2026-09-01T14:03:40Z",
      "expires_at": "2026-10-01T14:03:40Z",
      "record": "dr_5e1",
      "asserted": { "terms": "t_8f1", "acknowledged": ["esign", "share"], "channel": "imessage" },
      "observed": { "site_session": "fs_2b81", "human": true, "known_device": true, "age_s": 240 }
    },
    "handoff": null
  }
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
| `agent.handoff` | The scope the consumer must complete on your site, when set. |

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
  if (c.max_amount && req.amount > c.max_amount.value) return deny("over_limit");
  if (c.payees === "existing_only" && !isExistingPayee(req.payee)) return deny("new_payee");
  if (c.max_total && totalFor(session.agent.delegation.id) + req.amount > c.max_total.value) return deny("over_total");
}
return allow();
```

Refuse control-tier routes for every agent session without consulting the list. The scope will never be present, and the check is cheaper than the lookup.

## Step 10: Handle a handoff

When an agent reaches a scope your policy marks for handoff, the verification response sets `agent.handoff` to that scope and Foil tells the operator that the consumer must complete the step. Your server should treat the agent's attempt as incomplete rather than as an error, and your page should behave as it does for any signed-in customer who arrives at that step.

The consumer completes the step on your site from their own device. Your existing controls apply, and Foil observes a human session doing it. When the step completes, report it so that the delegation record reflects it.

```
POST /v1/sessions/{id}/handoff
{ "scope": "payments:initiate" }
```

The `handoff` field clears, and the completed scope is added to the observed evidence in the delegation record.

## Step 11: Revoke a delegation

You can revoke any delegation at your origin. Every grant under it stops being honored at its next telemetry beat, and the operator is notified.

```
DELETE /v1/delegations/{id}
```

Revoke when your fraud team sees activity it does not want to continue, when a customer asks you to, or when a customer closes an account. To stop an agent everywhere on your site rather than one delegation, add it to the deny list in your policy. To stop all agents, set the tier ceiling to none.

## Step 12: Retain records

The delegation record is the document your compliance team will want. Fetch it in full and store it in your own system.

```
GET /v1/delegations/{id}
```

The record contains the terms version, the document hashes, the acknowledgements given, the asserted and observed evidence, the policy version the delegation was created under, and the signature chain to Foil's root key. It can be verified without contacting Foil, so a copy in your retention store is sufficient on its own.

## Policy recipes

**Read-only balances and history.** Tier ceiling read. Admit all vetted operators. Evidence for read: asserted. A disclosure bundle with your electronic records consent and privacy notice, presentation app. No constraints, no handoff scopes. This is the configuration to start with.

**Bill pay with limits.** Tier ceiling transact. Constraints: `max_amount` 200, `max_count` 5, `payees` existing_only. Evidence for transact: observed. Handoff: `payments:initiate`. The agent can read accounts and prepare a payment, and the consumer confirms each payment on your site.

**Onboarding with site-only disclosures.** Tier ceiling manage, with the application scopes your onboarding flow uses. Two bundles: a privacy notice with presentation app, and the account agreement and electronic records consent with presentation site. The agent can fill the application, and the consumer reads and accepts the account agreement on your site.

## Test it locally

The `aap` command in the reference implementation lets you stand in for an operator against your own policy. The following creates a store, an operator, an agent, and your policy, then walks a delegation and a session through verification. See the [command reference](../cli.md) for each command.

```
aap init
aap keygen --out operator.key.json
aap keygen --out agent.key.json
aap operator issue --id op_test --key operator.key.json --vetting standard --session-handling test --out operator.cert
aap agent issue --operator-cert operator.cert --operator-key operator.key.json --id ag_test --name test-agent \
    --key agent.key.json --scopes accounts:read,payments:initiate --max-amount 500 --payees existing_only --out agent.cert
aap policy set --origin yoursite.example --tier transact --max-amount 200 --disclosures bundle.json \
    --evidence read=asserted,transact=observed --handoff payments:initiate --disclose operator,agent
aap terms --agent-cert agent.cert --origin yoursite.example --scopes accounts:read,payments:initiate
```

Write an acceptance file that references the ETag from the terms output, then create the delegation, sign a grant, and verify it. `aap site session <id>` prints exactly what your server will read, and `aap session use <id> --scope <scope>` lets you see the handoff and scope-violation paths.

## Common mistakes

- **Gating on the plane alone.** A session on the agent plane is not a session with every permission. Check the scope on every route.
- **Not tracking totals.** `max_total` and `max_count` are enforced by you. If you set them without tracking per delegation, they do nothing.
- **Reading the agent block on a bot session.** A downgraded session's block contains only the grant id and a reason. Do not look for scopes there.
- **Enabling transact with asserted evidence.** An application's assertion is enough for read. Money movement should require an observed link or a handoff.
- **Keeping only Foil's copy of the record.** Fetch and store the delegation record yourself. It verifies offline and outlives your relationship with any vendor.
- **Widening the ceiling and expecting existing delegations to widen.** They do not. The consumer accepted the narrower set, and the agent must obtain a new delegation.
