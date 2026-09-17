# Command line reference

`aap` is the command line for the Agent Admission Protocol. It is a thin client over the API: each resource is a command, each verb is a subcommand, and flags map to request fields. It also runs the reference API locally, signs the objects that never leave your machine, forwards webhooks to a development server, and tails request logs.

## Install

The reference implementation requires [Bun](https://bun.sh).

```
bun install
bun link          # makes `aap` available on your path
aap --help
```

Without `bun link`, replace `aap` with `bun run src/cli.ts` in every example.

## Run the reference API

```
aap serve [--port 4010] [--store DIR]
```

Starts the API on `127.0.0.1:4010` over a store directory, `.aap` in the current directory by default. The store plays the part of Foil's database. It is created, with a root key, on first run. Keep this running in one terminal while you use the commands below in another.

```
aap demo [--keep]
```

Runs the whole lifecycle against an in-process API and prints each step: onboarding, an agent, a policy, terms, a delegation with observed evidence, a challenge, a grant, verification, the site's view of the session, a handoff in approve mode completed by the consumer, a replayed grant, a revocation, and the events that were recorded. Nothing outside a temporary directory is touched.

## Accounts and profiles

The command line keeps profiles in `~/.config/aap/config.json`, or under `AAP_CONFIG_DIR`. A profile holds the API base URL, a test key, a live key, and the paths of the signing keys it has generated. Commands use the current profile; `--profile NAME` selects another, and one machine typically has an `operator` profile and a `site` profile.

```
aap accounts create --type operator --name "Example Browser Co" [--asn AS14618,AS16509] [--attestations @kya.json] [--key operator.key.json]
aap accounts create --type site --name "Example Bank"
```

Onboarding against the reference server. Creating an operator account generates an operator signing key when `--key` is not given, uploads the public half, receives the operator certificate and both API keys, stores everything in the profile, and logs you in. In production these steps happen out of band and you receive keys from Foil.

```
aap login --api-key sk_test_… [--live-key sk_live_…] [--api-base URL] [--profile NAME]
aap logout
aap config
aap whoami
```

`login` stores keys you were given. `config` prints the current profile with keys masked. `whoami` retrieves the account behind the current key.

## Global flags

| Flag | Meaning |
| --- | --- |
| `--api-key KEY` | Use this key instead of the profile's. `AAP_API_KEY` does the same. |
| `--api-base URL` | Use this API instead of the profile's. `AAP_API_BASE` does the same. |
| `--profile NAME` | Use another profile. |
| `--live` | Use the profile's live key. |
| `--expand a,b.c` | Expand referenced objects in the response. |
| `--idempotency-key KEY` | Set the idempotency key on a create. One is generated when absent. |
| `--api-version DATE` | Pin the API version. |
| `-d '{"json": true}'` | Merge a JSON object into the request body. |

Output is always JSON, pretty-printed. Commands exit 0 on success, 1 on an error, and 2 when a verification or wait ended in a state other than the one asked for.

## Flag syntax

Flags map to request fields. `--a.b VALUE` sets a nested field. `--items.0.k VALUE` builds a list of objects. `@file.json` reads a JSON value from a file. For fields that hold lists of strings, `a,b,c` is a list. `true`, `false`, and integers are converted; fields that hold ids or names are kept as strings.

```
aap handoffs create --session sess_9d02 --scope payments:initiate --context.amount 14210 --context.currency usd --context.payee "Pacific Power"
aap policies create --origin bank.example --tier read --disclosures @bundle.json --handoffs.0.scope payments:initiate --handoffs.0.mode approve
```

## Resources

For specialist providers or businesses attesting to checks on their own users,
see [Issue identity and risk credentials](guides/identity-risk-provider.md).
It describes the proposed W3C VC integration and shows how an institution can
record an externally validated evidence reference using existing handoff commands.
The CLI does not yet issue, present, or verify W3C credentials.

Every resource supports `create`, `retrieve ID`, and `list`, plus the verbs shown. Arguments after the verb are the id; everything else is a flag.

### agents

```
aap agents create --name NAME --scopes a,b [--currency usd] [--max-amount N] [--max-total N] [--max-count N] [--payees existing_only|any] [--key FILE] [--alg ES256|EdDSA] [--days N]
aap agents retrieve ID
aap agents list [--status active]
aap agents update ID --metadata.team payments
aap agents deactivate ID
```

`create` generates an agent key pair, signs the certificate with the profile's operator key, registers it, and stores the agent key under the profile. Later commands that sign for this agent find the key by the agent's id. Pass `--key` to use a key you already have.

### policies

```
aap policies create --origin O --tier observe|read|manage|transact|none
    [--allow-operators any|a,b] [--allow-agents any|a,b] [--deny-agents a,b]
    [--currency usd] [--max-amount N] [--max-total N] [--max-count N] [--payees existing_only]
    [--disclosures @bundle.json] [--evidence read=asserted,transact=observed]
    [--handoff "scope=payments:initiate,mode=approve,url=https://bank.example/agent/confirm?aap_handoff={id}"]
    [--max-age-days 30] [--disclose operator,agent] [--credentials @credentials.json]
aap policies retrieve ID
aap policies list [--origin O]
```

`--handoff` may be repeated, one per scope. `mode` is `approve` or `complete`, `url` is an https template with `{id}` and optionally `{code}`, and `expires_in` is in seconds.

### terms

```
aap terms create --agent ID --origin O [--scopes a,b]
aap terms retrieve ID
```

### delegations

```
aap delegations create --agent ID --origin O --subject S --terms ID --acceptance @acceptance.json [--scopes a,b] [--intent TEXT] [--site-session ID]
aap delegations retrieve ID [--expand record,agent]
aap delegations list [--agent ID] [--origin O] [--subject S] [--status active|revoked|expired]
aap delegations revoke ID [--by consumer]
```

The acceptance file is what the application collected from the consumer:

```json
{ "terms": "trm_3f2a", "acknowledged": ["esign", "share"], "viewed": ["esign", "privacy"], "channel": "imessage", "accepted_at": "2026-09-01T14:03:40Z", "copies_sent_to": "email" }
```

The request is signed with the agent's key from the profile before it is sent.

### sessions

```
aap sessions retrieve ID [--expand delegation.record]
aap sessions list [--origin O] [--status active|requires_handoff|downgraded] [--plane human|agent|bot]
```

### handoffs

```
aap handoffs create --session ID --scope S [--context.amount N --context.currency usd --context.payee NAME] [--context.application REF]
aap handoffs retrieve ID
aap handoffs list [--session ID] [--origin O] [--status pending]
aap handoffs update ID --url https://verify.vendor.example/i/abc        (site)
aap handoffs complete ID [--session ID] [--result.outcome passed]        (site)
aap handoffs cancel ID
aap handoffs wait ID [--timeout 15m] [--interval 1s]
```

`wait` polls until the handoff is completed, canceled, or expired, prints it, and exits 0 only when it completed. Durations accept `s`, `m`, and `h`.

### events and webhook endpoints

```
aap events retrieve ID
aap events list [--type handoff.completed] [--limit 20]
aap webhook-endpoints create --url URL [--enabled-events a,b] [--description TEXT]
aap webhook-endpoints retrieve ID | list | update ID --status disabled | delete ID
aap directory list
```

## Local signing

These commands use keys from the profile and read from the API only to fetch objects by id. Nothing they produce is sent unless you send it.

```
aap keys generate --out FILE [--alg ES256|EdDSA]
aap keys list
aap challenges verify JWT|FILE
aap grants sign --delegation ID --challenge JWT|FILE --session-ref REF [--intent TEXT] [--scopes a,b] [--ttl-s N] [--out FILE]
aap present --grant FILE|JWT --delegation ID [--out FILE]
aap verify-chain --delegation ID|FILE
aap inspect FILE|JWT
```

`grants sign` verifies the challenge against the root key first and refuses a challenge for a different origin than the delegation's. `present` writes the `Foil-Agent-Grant` header value with the full chain. `verify-chain` verifies a delegation certificate against the root key and, given an id, the agent and operator certificates above it. `inspect` decodes any signed object without verifying it.

## Test mode

```
aap test agents list
aap test sessions create --origin O [--human false] [--known-device] [--age 240] [--device mobile]
aap test sessions use ID --scope S
aap test challenges create --origin O [--out FILE]
aap test presentations create --origin O (--header-file FILE | --agent ag_test_bound) [--session ID] [--asn A] [--ja4 J] [--scopes a,b]
aap test handoffs link ID [--session ID]
aap test handoffs complete ID [--outcome passed] [--result.reference chk_1]
aap trigger EVENT_TYPE [--origin O]
```

These call the test helpers described in the [API reference](api.md#test-helpers) and require a test key. `test presentations create --agent` takes one of the fixed-outcome test agents, so a site can see every downgrade reason and the handoff flow without an operator.

## Webhooks and logs

```
aap listen --forward-to localhost:3000/aap/webhooks [--events handoff.completed,delegation.revoked]
```

Registers a temporary webhook endpoint pointing at a local listener, prints its signing secret, and forwards every delivery to your application with the original `AAP-Signature` header so your verification code runs unchanged. The endpoint is removed when you quit.

```
aap trigger handoff.completed
aap logs tail
```

`trigger` emits an event with a realistic fixture object, which is the quickest way to exercise a webhook handler. `logs tail` streams the reference server's request log: status, method, path, duration, account, mode, and request id.

## A complete session from the shell

[examples/lifecycle.sh](../examples/lifecycle.sh) starts a reference API, onboards an operator and a site as two profiles, and runs every command in order: an agent, a policy with a disclosure bundle and an approve-mode handoff, terms, a consumer session, a delegation, a challenge, a grant, a presentation, scope use, a handoff created by the agent and completed by the consumer while the operator waits on it, a replayed grant, a revocation, an event, a triggered webhook, and the directory. Run it with `bash examples/lifecycle.sh`.

## What the reference implementation does not do

It does not score sessions. The operator profile check compares network evidence passed on the command line with the operator certificate, standing in for the fingerprint and behavioral scoring Foil performs on live traffic. It does not retry failed webhook deliveries. It does not implement the planned edge challenge. Its account creation endpoint stands in for onboarding that happens out of band in production.
