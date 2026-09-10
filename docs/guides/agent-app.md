# Integrate an agent application

This guide is for the developer of the product a consumer talks to: a chat assistant, a messaging integration, a command line agent, or a web application that runs its browser sessions on an operator. The application is the only party in the protocol that is in front of the consumer, so it is responsible for showing the consumer what an agent will be allowed to do, collecting their acceptance, and telling them when a step needs them. When you finish, a consumer accepts once for each agent at each site, in the channel they already use, and the resulting delegation carries your agents through every session until it expires.

The guide assumes you have read the [Key concepts](../spec.md#key-concepts) section of the specification. The operator you build on has its own guide, [Integrate an operator](operator.md), which covers the keys, the header, and the requests to Foil. Your operator makes those calls; this guide covers what you supply to them and what you show the consumer.

## Before you begin

You need the following in place.

- An operator relationship, with an agent certificate issued for your product. Your operator holds the agent key and makes the calls to Foil on your behalf.
- A stable pseudonymous identifier for each of your end users, which becomes the delegation's subject.
- A way to present text and documents to the consumer in your channel, and to record what they were shown and what they answered.
- A way to deliver a copy of a document to the consumer, such as email, for sites whose disclosures require a retained copy.

## What you read and what you write

| You write | Where | You read | Where |
| --- | --- | --- | --- |
| An acceptance object | Passed to your operator for the delegation request | Terms | From your operator, from `GET /v1/terms` |
| A subject identifier | Passed to your operator | A handoff notice | From your operator, from the `Foil-Agent-Handoff` header |
| A revocation request | Through your operator | Delegation status and expiry | From your operator |

## Step 1: Ask for what the task needs

Your agent's certificate has a ceiling, the most it may ever hold. A delegation should ask for the scopes a task needs, not the ceiling. A consumer who asked for their balance should be asked to authorize reading accounts, not making payments. Sites see requested scopes in the consumer's acceptance and in every session, and a narrow request is easier to accept and harder to misuse.

If a later task needs more, ask again at that point. A new delegation with wider scope replaces the narrower one.

## Step 2: Fetch the terms before you ask

Before a consumer authorizes an agent at a site, your operator fetches the terms for that agent at that origin. The response is everything the consumer must be shown, already intersected with the agent's ceiling and the site's policy.

```json
{
  "policy_version": 14,
  "scopes": [
    { "id": "accounts:read", "text": "See your accounts and balances" },
    { "id": "payments:initiate", "text": "Make payments up to $200 each to payees you already have" }
  ],
  "constraints": { "max_amount": { "value": 200, "currency": "USD" }, "payees": "existing_only" },
  "max_age_s": 2592000,
  "evidence": { "read": "asserted", "transact": "observed" },
  "disclosures": {
    "bundle": "linking-v4",
    "presentation": "app",
    "documents": [
      { "id": "esign", "title": "Consent to electronic records", "url": "https://cdn.usefoil.com/d/…", "format": "text/markdown", "sha256": "…", "render": "full" },
      { "id": "privacy", "title": "Privacy notice", "url": "https://cdn.usefoil.com/d/…", "format": "application/pdf", "sha256": "…", "render": "link" }
    ],
    "acknowledgements": [
      { "id": "esign", "text": "I agree to receive these documents electronically" },
      { "id": "share", "text": "I authorize bill-pay-assistant to access my accounts as described for 30 days" }
    ],
    "retain": "copy_required"
  }
}
```

The response carries an ETag. Your acceptance must reference it, and Foil refuses an acceptance whose ETag does not match the current terms, so fetch the terms immediately before presenting them rather than from a stale cache. If the origin does not admit agents, the response says so and there is nothing to present.

## Step 3: Present the terms

Show the consumer the scopes, the constraints, the acknowledgements, and the documents, following the rendering requirements in the response. The requirements are set by the site, and a site's compliance team is relying on them being followed.

**Scopes and constraints.** Present the plain-language `text` for each scope. It already includes the constraints where they matter, so "Make payments up to $200 each to payees you already have" is a complete statement. Do not paraphrase.

**Acknowledgements.** Each acknowledgement is a statement the consumer must affirmatively agree to. Present each one and record an explicit yes. Do not pre-select, bundle them into one question, or infer agreement from the consumer continuing.

**Documents marked `render: full`.** Show the whole document in your channel before the consumer can accept. In a chat interface, render the text inline or in a scrollable panel. In a messaging channel with a length limit, send it as consecutive messages or as an attachment the consumer opens. In a terminal, page it. Do not summarize it, and do not replace it with a link.

**Documents marked `render: link`.** A link to the document is sufficient. Show the title and the link.

**`retain: copy_required`.** Deliver a copy of each document to the consumer by a means they can keep, such as email, and record where it was sent. The acceptance includes that record.

**`presentation: site`.** The site requires that this bundle be accepted on the site itself. Do not collect an acceptance for it. Tell the consumer that they will be asked to complete this step on the site, and continue with the rest.

The following is how a chat interface might present the terms above.

```
bill-pay-assistant would like access to your account at bank.example for 30 days.

It will be able to:
  • See your accounts and balances
  • Make payments up to $200 each to payees you already have

Before you decide, please review:
  • Consent to electronic records (shown below)
  • Privacy notice: https://…

[full text of the consent to electronic records]

Do you agree to receive these documents electronically?  [Yes] [No]
Do you authorize bill-pay-assistant to access your accounts as described for 30 days?  [Yes] [No]

A copy of these documents will be sent to you@example.com.
```

## Step 4: Build the acceptance

When the consumer has answered, build the acceptance object and pass it to your operator.

```json
{
  "terms": "t_8f1",
  "acknowledged": ["esign", "share"],
  "viewed": ["esign", "privacy"],
  "channel": "imessage",
  "accepted_at": "2026-09-01T14:03:40Z",
  "copies_sent_to": "email"
}
```

| Field | What to put in it |
| --- | --- |
| `terms` | The ETag of the terms you presented |
| `acknowledged` | The ids of every acknowledgement the consumer agreed to. Foil refuses an acceptance missing any required acknowledgement. |
| `viewed` | The ids of every document the consumer was shown. Every document marked `render: full` must be here. |
| `channel` | Where the consumer accepted, such as `imessage`, `web`, `terminal`, or your product's name |
| `accepted_at` | When they accepted, as an ISO 8601 timestamp |
| `copies_sent_to` | Where copies were delivered, when the bundle requires a retained copy |

The acceptance is signed by your operator with the agent key and becomes the asserted half of the delegation record. A site can see the channel and the acknowledgements, and a false assertion is attributable to the agent and the operator, so record what happened rather than what should have happened.

## Step 5: Provide a subject

The subject is your stable pseudonymous identifier for the end user. Use the same subject for the same person across sites and agents, so that a site can see one consumer's delegations as one consumer's. Never use an email address, a phone number, a name, or any other personal data as the subject. Foil does not need to know who the consumer is, and the protocol binds the subject to the site's customer through evidence that does not involve you.

## Step 6: Create the delegation through your operator

Your operator posts the delegation request and returns the delegation to you. Store its id and its expiry against the subject, the agent, and the site. Reuse it for every session until it expires or is revoked. Do not ask the consumer again per session, per task, or per day.

If the consumer is signed in to the site on their own device at the time, your operator can include that session in the request, and the delegation carries observed evidence. Sites require observed evidence for money movement and account changes, so if your product's flow lets the consumer sign in first, create the delegation while that session is live.

## Step 7: Ask again when you need to

Ask the consumer for a new delegation in four situations.

- The task is at a site where no delegation exists for this consumer and agent.
- The task needs a scope the existing delegation does not include.
- The existing delegation has expired, or is about to.
- The existing delegation was revoked by the site or the consumer.

Each of these is a full presentation of the current terms, since the site's terms may have changed.

## Step 8: Handle a handoff

Some steps must be completed by the consumer on the site, from their own device. The site marks these in its policy, and when your agent reaches one, your operator receives a handoff notice naming the scope. Tell the consumer what the step is and where to complete it, then wait.

```
To finish this payment, bank.example needs you to confirm it yourself.
Open bank.example on your phone and approve the payment to Pacific Power for $142.10.
I'll continue once it's done.
```

When the site reports the step complete, the session continues. Do not attempt to complete the step through the agent, and do not ask the consumer for credentials or codes to do it on their behalf.

## Step 9: Let the consumer see and revoke

Give the consumer a way to see their active delegations, showing the agent, the site, the plain-language scopes, and the expiry, and a way to revoke any of them. Revocation takes effect at the next verification and ends every session under that delegation.

```
Your connected sites
  bank.example — bill-pay-assistant
    See your accounts and balances
    Make payments up to $200 each to payees you already have
    Expires October 1, 2026                          [Disconnect]
```

## Step 10: Respond to downgrades

Your operator receives a reason whenever a session is downgraded. Two of them are about your agent's behavior. `scope_violation` means the agent acted outside the scopes it was granted, which is a defect in the agent, not in the consumer's authorization. `evidence_insufficient` means the task reached a tier the delegation's evidence does not support, and the fix is to create the delegation while the consumer has a live session at the site, or to keep the task at read tier. The rest are described in the operator guide.

## Test it locally

The `aap` command in the reference implementation lets you generate terms and validate an acceptance without an operator. See the [command reference](../cli.md) for the setup commands; the two that concern you are the following.

```
aap terms --agent-cert agent.cert --origin bank.example --scopes accounts:read,payments:initiate
aap delegation create --agent-cert agent.cert --operator-cert operator.cert --agent-key agent.key.json \
    --origin bank.example --subject usr_1 --scopes accounts:read,payments:initiate --intent "Pay bills" \
    --acceptance acceptance.json --out delegation.cert
```

Write the acceptance file from your interface's output. The command refuses an acceptance with a stale ETag, a missing acknowledgement, an unviewed document that required full rendering, or a missing delivery record when a copy is required, with a message naming the problem. Those are the same checks Foil applies.

## Common mistakes

- **Summarizing a document marked for full rendering.** The site required the whole text. Show it.
- **Pre-selected or bundled acknowledgements.** Each one is a separate, explicit yes.
- **Presenting stale terms.** Fetch immediately before presenting. An acceptance with an old ETag is refused.
- **Asking per session.** A delegation lasts for its maximum age. Ask once and reuse it.
- **Personal data in the subject.** The subject is pseudonymous and stable. Nothing else.
- **Asking for the ceiling.** Ask for what the task needs.
- **Completing a handoff for the consumer.** The step exists because the site wants the consumer to do it. Tell them where, and wait.
