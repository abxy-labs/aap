# Command line reference

The CLI is a local SDK client. It stores private signing keys in the chosen profile and signs authorization acceptance locally. Test commands are simulations and reject live keys.

## Start

```bash
bun install
bun run src/cli.ts serve
```

Use `bun run src/cli.ts` in place of `aap`, or link the package's bin locally. In another terminal:

```bash
aap --profile site accounts create --type site --name "Example Bank"
aap --profile operator accounts create --type operator --name "Example Browser Co" --asn AS14618
```

Each profile stores its API base, keys and account. Set `--api-base` explicitly for another service. `aap whoami` inspects the selected account. Never put live keys in documentation or shell history.

## Core commands

```bash
aap --profile site policies create \
  --origin bank.example --scopes accounts:read --max-age-days 1

aap --profile operator agents create \
  --name balance-assistant --scopes accounts:read

aap --profile operator authorizations create \
  --agent ag_FROM_REGISTRATION --origin bank.example \
  --subject customer_8e3a1b7c29f4 --intent "Check my account balance" \
  --scopes accounts:read

aap --profile operator authorizations accept auth_FROM_CREATE \
  --revision REVISION_FROM_CONSENT \
  --data '{"acceptance":{"acknowledged":[],"viewed":[],"channel":"in_app","accepted_at":"2026-09-17T10:00:00Z"}}'

aap --profile operator test browser connect \
  --authorization auth_FROM_ACCEPTANCE --asn AS14618
```

IDs and revision above are placeholders for returned values. The deliberately minimal policy has no disclosures. Real institutions publish the documents and acknowledgement text they require, and applications record real views/acceptance and the actual timestamp. Never auto-consent from a task prompt.

The connect result supplies the session ID. Production operators implement the SDK browser transport rather than running the test command.

## Customer actions and revocation

```bash
aap --profile operator customer-actions create \
  --session sess_FROM_CONNECTION --scope payments:initiate \
  --data '{"context":{"amount":14210,"currency":"usd","payee":"Pacific Power","invoice":"PP-2026-0917"}}'

aap --profile operator customer-actions wait ca_FROM_CREATE --timeout 5m
aap --profile site customer-actions complete ca_FROM_CREATE \
  --session sess_VERIFIED_HUMAN --data '{"result":{"confirmed":true}}'

aap --profile operator authorizations revoke auth_FROM_ACCEPTANCE --by consumer
```

These actions require matching permitted scopes and institution policy; the read-only policy above intentionally cannot make payments. Only the institution may complete an action. It validates authoritative payment/application details and a separate human session first. Waiting returns success only for completed; timeout/cancel/expiry exits 2. Completion never executes the financial operation.

## Resources and flags

Run `aap --help` for all commands. Core resources are agents, policies, authorizations, sessions, customer-actions, events and webhook-endpoints. Discovery is public and unauthenticated.

Use `--data '{...}'` for inline JSON, `--field value`, `--nested.field value`, and `@file.json` for JSON files. List-valued flags such as scopes accept commas. Global options include `--profile`, `--api-base`, `--api-key`, `--live`, `--api-version`, `--idempotency-key`, and `--expand`.

Policy shortcuts include `--max-age-days`, explicit `--scopes`, constraints, and repeatable `--customer-action 'scope=payments:initiate,mode=approve,url=https://bank.example/confirm?action={id}'`. There are no tier, terms, delegation, grant-signing or handoff compatibility commands.

## Optional evidence

Use policy `--data` with `advanced.evidence` keyed by exact scope and `advanced.attestations` for accepted issuers/types/claims. The `--evidence accounts:read=attested` shortcut sets the same advanced map.

`credentials subject --authorization ID` derives a pseudonymous subject. `credentials issue` signs a supported credential locally. `attestations create --authorization ID --credential FILE_OR_JWT` submits it; retrieve/list/revoke and issuer lookup are also supported. An issuer who cannot read the authorization receives the subject from the requester instead. See [advanced integration](advanced.md).

## Run complete examples

```bash
bun run demo
bun examples/attestations.ts
```

The examples create and remove isolated temporary stores. They demonstrate customer authorization and optional evidence without sending email, verifying real people, moving money, or opening accounts.

Test helpers also create human sessions, simulate presentations, link/complete customer actions and trigger webhook events. They are testing tools, not production authentication or browser adapters. Use `listen --forward-to localhost:3000/webhooks` to inspect signed local deliveries.

## Discovery

```bash
aap discovery create --origin https://bank.example --api-base https://aap.example --out aap-discovery.json
aap discovery retrieve https://bank.example
```

Publish the document at the institution's `/.well-known/aap`. Discovery does not forward credentials or reconfigure API trust; see [discovery](discovery.md).
