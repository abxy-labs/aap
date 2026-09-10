# aap command line reference

`aap` is a reference implementation of the Agent Admission Protocol. It implements every object in the specification, the rules for issuing and verifying them, and the verification response a site reads. It runs against a local store that plays the part of Foil, so one machine can act as Foil, an operator, an agent, and a site in turn. The store is a directory of JSON files, `.aap` in the current directory by default, selected with `--store DIR` or the `AAP_STORE` environment variable.

Every command prints JSON to standard output. Commands that produce a signed object print it inline, or write it to a file when `--out FILE` is given. Errors go to standard error with exit code 1. `aap verify` and `aap session use` exit with code 2 when the session is not on the agent plane, so that scripts can branch on the result.

## Install

```
bun install
bun run src/cli.ts --help
```

To install the command on your path, run `bun link` in the repository, after which `aap` is available directly. The examples below assume that.

## Objects and where they live

| Object | Issued by | Command | Stored |
| --- | --- | --- | --- |
| Root key | `aap init` | `init`, `root` | `root.json` in the store |
| Operator certificate | Foil | `operator issue` | `operators/` |
| Agent certificate | Operator | `agent issue` | In the operator's hands; cached under `agents/` once seen |
| Policy statement | Foil, from site configuration | `policy set` | `policies/` |
| Terms | Computed | `terms` | Not stored; identified by ETag |
| Delegation certificate | Foil | `delegation create` | `delegations/`, with the record under `records/` |
| Challenge | Foil | `challenge` | `challenges/` |
| Grant | Agent | `grant sign` | Bound under `grants/` at verification |
| Session | Foil | `verify` | `sessions/` |

All signed objects are compact JSON Web Signatures using ES256 or EdDSA, with a `typ` header naming the object type, for example `aap-delegation+jwt`. `aap inspect` decodes any of them without verifying.

## Store

### aap init

```
aap init [--store DIR] [--force]
```

Creates the store and generates the root key. The store must not already exist unless `--force` is given, which deletes and recreates it.

### aap root

Prints the root public key in the form of the `/.well-known/foil-root` document. Operators use it to verify challenges; anyone can use it to verify a delegation record offline.

### aap directory

Prints the SHA-256 hash of every origin whose current policy admits agents. This is the optional directory an operator can cache to present on the first telemetry request instead of waiting for a challenge.

## Keys and certificates

### aap keygen

```
aap keygen --out FILE [--alg ES256|EdDSA]
```

Generates a key pair and writes it as a JSON file containing `kid`, `alg`, `public`, and `private`. ES256 keys are EC P-256. EdDSA keys are Ed25519, the key type Web Bot Auth uses, so an operator that already has such a key can use it as an operator or agent key; a bare private JWK file is accepted anywhere a key file is, with the algorithm inferred from the key. The same file serves as either a public key input, from which only the public half is read, or a private key input.

### aap operator issue

```
aap operator issue --id ID --key PUBLIC_KEY_FILE --vetting LEVEL --session-handling TEXT [--attestations FILE] [--asn A,B] [--ja4 X,Y] [--days N] --out FILE
```

Foil's side of vetting. Issues an operator certificate under the root key with the operator's public key, its vetting level, and a statement about how it handles transferred sessions. `--attestations FILE` is a JSON array of third-party credentials about the operator, each with a `type` and an `issuer` and optionally a `ref`, a `credential`, and validity dates; a Know-Your-Agent credential from a card network is the expected use. `--asn` and `--ja4` record the operator's known network and TLS profile; when present, `aap verify` compares them with the presenting session and returns `operator_mismatch` on a difference. The certificate is valid for 365 days by default and is also recorded in the store so that later presentations can omit it.

### aap agent issue

```
aap agent issue --operator-cert FILE --operator-key FILE --id ID --name NAME --key PUBLIC_KEY_FILE --scopes a,b [--max-amount N] [--max-total N] [--currency USD] [--max-count N] [--payees existing_only|any] [--days N] --out FILE
```

The operator's side. Issues an agent certificate signed by the operator key, naming the agent, carrying its public key, and stating its ceiling: the scopes it may ever hold and the tightest constraints it may ever exceed. Foil is not contacted. The command refuses unknown scopes and refuses `security:write`, which is never grantable. The certificate is valid for 90 days by default.

## Site policy

### aap policy set

```
aap policy set --origin O --tier observe|read|manage|transact|none
               [--allow-operators a,b|any] [--allow-agents a,b|any] [--deny-agents a,b]
               [--max-amount N] [--max-total N] [--currency USD] [--max-count N] [--payees existing_only|any]
               [--disclosures FILE] [--evidence read=asserted,transact=observed] [--handoff s1,s2]
               [--max-age-days N] [--disclose operator,agent] [--credentials FILE]
```

Configures the site's policy and signs it as a versioned statement. Each call increments the version. The tier is the highest tier any agent may reach; `none` closes the origin, after which no challenges are issued for it. `--evidence` states, per tier, whether an asserted acceptance is sufficient, whether an observed link to a live session at the site is required, whether a presented credential is required, or whether the step must happen on the site. The `presented` level is reserved: no command can record a presentation yet, so a tier that requires it is refused with `evidence_insufficient` until that exists. `--handoff` names scopes the consumer must complete on the site regardless of tier. `--disclose` controls whether the operator and agent names appear in the site's verification response.

`--disclosures FILE` is a JSON disclosure bundle:

```json
{
  "bundle": "linking-v4",
  "presentation": "app",
  "documents": [
    { "id": "esign", "title": "Consent to electronic records", "url": "https://…", "format": "text/markdown", "sha256": "…", "render": "full" },
    { "id": "privacy", "title": "Privacy notice", "url": "https://…", "format": "application/pdf", "sha256": "…", "render": "link" }
  ],
  "acknowledgements": [
    { "id": "esign", "text": "I agree to receive these documents electronically" },
    { "id": "share", "text": "I authorize {agent} to access my accounts as described for {days} days" }
  ],
  "retain": "copy_required"
}
```

`presentation: site` marks a bundle that cannot be accepted in an application. `render: full` requires the document to have been viewed before acceptance. `retain: copy_required` requires the acceptance to state where a copy was delivered. The placeholders `{agent}` and `{days}` are substituted when terms are computed.

`--credentials FILE` is a JSON object naming the credential types and issuers the site accepts and the claims it may request in a presentation. It is stored on the policy and has no effect on verification in the current version.

```json
{ "types": ["mdl"], "issuers": ["dmv.ca.gov"], "claims": ["age_over_18"] }
```

### aap policy show

```
aap policy show --origin O
```

Prints the current policy statement's claims after verifying its signature.

## Delegation

### aap terms

```
aap terms --agent-cert FILE --origin O --scopes a,b
```

The equivalent of `GET /v1/terms`. Prints what the consumer must be shown for this agent at this origin: the scopes that survive the intersection of the request, the agent's ceiling, and the site's tier, each with a plain-language string; the intersected constraints; the maximum delegation age; the evidence requirements; and the disclosure bundle with placeholders substituted. The response carries an `etag` that the acceptance must reference. If the origin does not admit agents, the response is `{ "participates": false }`.

### aap delegation create

```
aap delegation create --agent-cert FILE --operator-cert FILE --agent-key FILE
                      --origin O --subject S --scopes a,b --intent TEXT
                      --acceptance FILE [--site-session ID] --out FILE
```

The equivalent of `POST /v1/delegations`, with both sides performed locally. The request body is signed with the agent key, the signature is verified against the agent certificate, and the delegation is issued under the root key if every check passes. The acceptance file is what the application collected from the consumer:

```json
{
  "terms": "t_5fbd6a70",
  "acknowledged": ["esign", "share"],
  "viewed": ["esign", "privacy"],
  "channel": "imessage",
  "accepted_at": "2026-09-10T18:00:00Z",
  "copies_sent_to": "email"
}
```

The command refuses an acceptance whose `terms` does not match the current ETag, that is missing an acknowledgement, that has not viewed a document marked for full rendering, that omits `copies_sent_to` when a copy is required, or that references a bundle marked for completion on the site. `--subject` is the operator's own stable identifier for the end user. `--site-session` names a consumer session at the site that Foil has seen; when given, the record carries observed evidence. The output includes the delegation id, the effective scopes and constraints, the record, and the certificate. The certificate carries `issuer: "foil"`, and the record carries a `presented` field that is null; both are reserved for site-issued and consumer-issued delegations and for verifiable credential presentations.

### aap delegation show

```
aap delegation show ID
```

Prints the delegation's status, claims, and certificate. The claims include the full record, which is what a site retains.

### aap delegation revoke

```
aap delegation revoke ID [--by site|consumer|operator]
```

Revokes the delegation. Any grant under it is refused at its next verification with `delegation_revoked`.

## Session

### aap site session-record

```
aap site session-record --id ID --origin O [--human] [--known-device] [--age-s N]
```

Records a consumer session at a site as Foil would have observed it through the SDK. This exists so that the observed side of a delegation record can be exercised locally. `--age-s` backdates the session.

### aap challenge

```
aap challenge --origin O [--out FILE]
aap challenge verify JWT|FILE
```

The first form is Foil's side: it issues a signed challenge for the origin, valid for five minutes, and prints it together with the `Foil-Agent-Challenge` header line. If the origin's policy does not admit agents, no challenge is issued and the output says so. The second form is the operator's side: it verifies a challenge against the root key and prints its claims. An operator's browser answers a challenge only after this check passes.

### aap grant sign

```
aap grant sign --agent-key FILE --agent-cert FILE --delegation FILE --session-ref REF --intent TEXT
               [--scopes a,b] --challenge JWT|FILE [--ttl-s N] --out FILE
```

Signs a per-session grant with the agent key. The grant references the delegation, names the session, states the intent, carries the challenge nonce, and is valid for one hour by default. `--scopes` may narrow the delegation and is refused if it would widen it. The challenge must be for the delegation's origin.

### aap present

```
aap present --grant FILE --delegation FILE --agent-cert FILE --operator-cert FILE [--out FILE]
```

Builds the `Foil-Agent-Grant` header value: the grant followed by the chain. The full chain is needed on the first presentation in a session. Later presentations may carry the grant alone, since Foil caches certificates it has seen.

### aap verify

```
aap verify (--header VALUE | --header-file FILE) --origin O --session ID [--asn A] [--ja4 J]
```

Foil's verification at bind. Resolves the chain, verifies each signature against the key one level up, checks that each level's scopes are a subset of the level above, checks the challenge, checks that the delegation is neither revoked nor expired, applies the origin's current policy, checks the evidence requirement for the highest tier in use, checks that the grant has not been presented by another session, and compares the session's network evidence with the operator profile. On success it binds the grant to the session, prints `Foil-Agent-Status: bound`, and prints the verification response the site will read. On failure it prints `Foil-Agent-Status: downgraded; reason=…`, records the session on the bot plane, and exits with code 2.

The response includes `narrowed` when the site's current policy is tighter than it was when the delegation was created, and `handoff_scopes` for granted scopes that the consumer will have to complete on the site.

Downgrade reasons are `chain_invalid`, `challenge_invalid`, `delegation_revoked`, `delegation_expired`, `policy_denied`, `grant_replayed`, `operator_mismatch`, and `evidence_insufficient`. The last is returned when the tier in use requires observed or presented evidence and the delegation record does not carry it. A replayed grant downgrades both the presenting session and the session that first bound it.

### aap session use

```
aap session use ID --scope S
```

Records that a bound session exercised a scope, as Foil would infer from telemetry. A scope within the grant is added to `scopes_used`. A scope the policy marks for handoff sets the session's `handoff` field and prints `Foil-Agent-Handoff: required; scope=S`. A scope outside the grant downgrades the session with `scope_violation` and exits with code 2.

### aap site session

```
aap site session ID
```

The equivalent of `GET /v1/sessions/{id}`: the decision and the agent block as the site reads them.

### aap site handoff-complete

```
aap site handoff-complete ID --scope S
```

The equivalent of `POST /v1/sessions/{id}/handoff`. The site reports that the consumer completed the step on the site. The session's `handoff` field is cleared and the completed scope is added to the observed evidence in the delegation record.

## Other

### aap inspect

```
aap inspect FILE|JWT
```

Decodes any protocol object and prints its header and claims without verifying the signature.

### aap demo

```
aap demo [--keep] [--store DIR]
```

Runs the whole lifecycle in a temporary store and prints each step: operator and agent issuance, policy, terms, delegation with observed evidence, challenge, grant, verification, the site's view, scope use and handoff, a replayed grant, revocation, and the directory. The store is removed afterwards unless `--keep` or `--store` is given.

## A complete session from the shell

The script in [examples/lifecycle.sh](../examples/lifecycle.sh) runs every command in order against a fresh store. In outline:

```
aap init
aap keygen --out operator.key.json
aap keygen --out agent.key.json
aap operator issue --id op_7a1d --key operator.key.json --vetting standard --session-handling "encrypted at rest" --asn AS14618 --out operator.cert
aap agent issue --operator-cert operator.cert --operator-key operator.key.json --id ag_9c4e --name bill-pay-assistant \
    --key agent.key.json --scopes accounts:read,transactions:read,payments:initiate --max-amount 500 --payees existing_only --out agent.cert
aap policy set --origin bank.example --tier transact --max-amount 200 --disclosures bundle.json \
    --evidence read=asserted,transact=observed --handoff payments:initiate --max-age-days 30 --disclose operator,agent
aap terms --agent-cert agent.cert --origin bank.example --scopes accounts:read,payments:initiate
aap site session-record --id fs_2b81 --origin bank.example --human --known-device --age-s 240
aap delegation create --agent-cert agent.cert --operator-cert operator.cert --agent-key agent.key.json --origin bank.example \
    --subject usr_41b --scopes accounts:read,payments:initiate --intent "Pay monthly bills" --acceptance acceptance.json --site-session fs_2b81 --out delegation.cert
aap challenge --origin bank.example --out challenge.jwt
aap grant sign --agent-key agent.key.json --agent-cert agent.cert --delegation delegation.cert --session-ref sess_19c2 \
    --intent "Pay September electric bill" --challenge challenge.jwt --out grant.jwt
aap present --grant grant.jwt --delegation delegation.cert --agent-cert agent.cert --operator-cert operator.cert --out header.txt
aap verify --header-file header.txt --origin bank.example --session fs_9d02 --asn AS14618
aap session use fs_9d02 --scope accounts:read
aap session use fs_9d02 --scope payments:initiate
aap site handoff-complete fs_9d02 --scope payments:initiate
aap site session fs_9d02
```

## What the implementation does not do

It does not run a network service. Every endpoint in the specification is a command that reads and writes the local store, so the store is the equivalent of Foil's database and the commands are the equivalent of its API and its verification at bind. It does not score sessions. The operator profile check compares network evidence passed on the command line with the operator certificate, which stands in for the fingerprint and behavioral scoring that Foil performs on live traffic. It does not implement the planned edge challenge.
