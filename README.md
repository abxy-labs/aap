# Agent Admission Protocol

<img src="docs/images/aap-logo.svg" alt="Agent Admission Protocol logo" width="305" height="118">

The Agent Admission Protocol (AAP) lets an automated agent identify itself to Foil, lets a site state which agents it admits and what those agents may do, and lets a consumer authorize an agent to act for them at a site. Sites that run Foil block automated traffic by default. The protocol adds a third category between human and bot, the agent plane, so that a site can admit the automation it has chosen to admit without loosening detection for anything else.

Three properties hold throughout. Foil never presents an interface to a consumer. Nothing is added to any request to a site. A site that has not opted in learns nothing.

## Contents

- [docs/spec.md](docs/spec.md): the protocol specification, written for sites, operators, and agent applications. It covers the concepts, the trust chain, the lifecycle, per-role guides, the reference for scopes, headers, and claims, and security considerations.
- [docs/api.md](docs/api.md): the API reference. Objects, endpoints, errors, pagination, events and webhooks, test helpers, and the local signing operations.
- [docs/cli.md](docs/cli.md): the command line reference for `aap`.
- Integration guides, one per party:
  - [Integrate a site](docs/guides/site.md), for an engineer at a site that runs Foil.
  - [Integrate an operator](docs/guides/operator.md), for a company that runs browsers for agents.
  - [Integrate an agent application](docs/guides/agent-app.md), for the product a consumer talks to.
  - [Integrate an embedded provider](docs/guides/embedded-provider.md), for a component that runs inside other companies' flows.
  - [Issue attestations](docs/guides/attestation-issuer.md), for an identity or risk provider, or an application stating a check it performed itself.
- [examples/lifecycle.sh](examples/lifecycle.sh): every command in order against a running reference API.
- [examples/attestations.ts](examples/attestations.ts): both ways a credential reaches a site, end to end.

## Quick start

The reference implementation requires [Bun](https://bun.sh).

```
bun install
bun run src/cli.ts demo
```

The demo runs the whole lifecycle against an in-process API and prints each step. To run it yourself:

```
bun link
aap serve                                                  # terminal 1
aap accounts create --type operator --name "Your Company"  # terminal 2
aap agents create --name my-agent --scopes accounts:read
aap --help
```

## Using the SDK

```ts
import { Aap } from "./src/sdk/index.ts";

const aap = new Aap(process.env.AAP_API_KEY, { keys: { operator: operatorKey } });
const agent = await aap.agents.create({ name: "bill-pay-assistant", ceiling: { scopes: ["accounts:read", "payments:initiate"], constraints: { currency: "usd", max_amount: 50000 } } });
const terms = await aap.terms.create({ agent: agent.id, origin: "bank.example" });
// present terms to the consumer, collect the acceptance
const delegation = await aap.delegations.create({ agent: agent.id, origin: "bank.example", subject: "usr_41b", terms: terms.id, acceptance });
const { grant } = await aap.grants.sign({ delegation, challenge, sessionRef: "sess_19c2", intent: "Pay September electric bill" });
const header = await aap.presentations.build({ grant, delegation });

// when the agent reaches a step the consumer must confirm
const handoff = await aap.handoffs.create({ session, scope: "payments:initiate", context: { amount: 14210, currency: "usd", payee: "Pacific Power" } });
await notifyConsumer(handoff.display.message, handoff.url);
const done = await aap.handoffs.wait(handoff.id, { timeout: 900 });
```

## Site discovery

A site can publish `/.well-known/aap` with their protocol versions, API
service, endpoints, and optional capabilities. Discovery never automatically
sends API credentials, changes a configured service, or trusts an attestation issuer.

```sh
aap discovery create --origin https://bank.example --api-base https://aap.example --out aap.json
aap discovery retrieve https://bank.example
```

Serve the generated file on the site's domain. See
[Site discovery](docs/discovery.md) for the profile, SDK usage,
reference-server hosting, and a local walkthrough. Existing explicit
configuration and challenge-based participation remain supported.

## Repository layout

```
docs/spec.md          the specification
docs/api.md           API reference
docs/cli.md           command reference
docs/guides/          integration guides per party
docs/images/          diagrams and the logo
src/cli.ts            command line entry point
src/cli/              profiles, flag parsing, listen, demo
src/sdk/              the client library
src/server/           the reference API: router, auth, envelope, resources
src/lib/              protocol objects, verification, handoffs, events, the store
src/types.ts          object and claim shapes
test/                 library, downgrade-reason, and API tests
examples/             shell walkthrough and the attestation example
```

## Tests

```
bun test
```

Covers the lifecycle, every downgrade reason, attestations from providers and applications, key interoperability, and the API end to end: conventions, errors, idempotency, pagination, expansion, delegations, sessions, handoffs in both modes, identity verification, test agents, events, and webhook signatures.

## Status

This is a draft. Endpoint names, header names, and claim shapes are subject to change before release. See the last section of [docs/cli.md](docs/cli.md) for what the reference implementation leaves out.
