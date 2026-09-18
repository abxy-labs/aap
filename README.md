# Agent Admission Protocol

<img src="docs/images/aap-logo.svg" alt="Agent Admission Protocol logo" width="305" height="118">

The Agent Admission Protocol (AAP) lets an automated agent identify itself to a participating site, lets the site state which agents it admits and what those agents may do, and lets a customer authorize an agent to act on their behalf. The protocol adds a third category between human and bot—the agent plane—so a site can admit the automation it has chosen to admit without loosening detection for anything else.

Consent is collected in the customer's application or on the participating site. Authorization is presented through a verified, origin-bound exchange, not broadcast on every ordinary web request. Identity and risk attestations are optional; they provide evidence, not permission.

## Contents

- [Protocol specification](docs/spec.md): the core concepts, roles, authorization lifecycle, consent rules, permissions, and security boundaries.
- [API reference](docs/api.md): objects, endpoints, errors, pagination, events, webhooks, and test helpers.
- [CLI reference](docs/cli.md): the command line reference for `aap`.
- Integration guides, one per party:
  - [Integrate a site](docs/guides/site.md), for a financial institution or other participating site.
  - [Integrate a browser operator](docs/guides/operator.md), for a company that runs browsers for agents.
  - [Integrate an agent application](docs/guides/agent-app.md), for the product a customer talks to.
  - [Integrate an embedded provider](docs/guides/embedded-provider.md), for a component that runs inside other companies' flows.
  - [Issue attestations](docs/guides/attestation-issuer.md), for an identity or risk provider, or an application stating a check it performed itself.
- [Advanced integration](docs/advanced.md): optional evidence and cryptographic transport.
- [examples/lifecycle.sh](examples/lifecycle.sh): a runnable reference lifecycle.
- [examples/attestations.ts](examples/attestations.ts): credentials from identity providers and applications, end to end.

## Quick start

The reference implementation requires [Bun](https://bun.sh).

```bash
bun install
bun run demo
```

The demo runs the lifecycle against an isolated local API and prints each step. Consent, human sessions, and financial activity are simulated; no account is opened or payment made.

To explore the API yourself:

```bash
bun link
aap serve                                                  # terminal 1
aap accounts create --type operator --name "Your Company"  # terminal 2
aap agents create --name my-agent --scopes accounts:read
aap --help
```

## Using the SDK

```ts
import { Aap } from "aap";

const aap = new Aap(process.env.AAP_API_KEY!, { keys: localKeyring });
const authorization = await aap.authorizations.create({
  agent: registeredAgent.id,
  origin: "bank.example",
  subject: customerReference,
  intent: "Open a checking account",
  scopes: ["application:write", "identity:verify"],
});

// Your application displays authorization.consent and collects real consent.
await aap.authorizations.accept(authorization.id, {
  revision: authorization.consent.revision,
  acceptance: customerAcceptance,
});

// Your operator supplies the browser's network adapter.
const session = await aap.browser(transport).connect({
  authorization: authorization.id,
});
```

The example assumes a registered agent, local signing keys, a browser transport, and consent collected by your application. Run `bun run demo` for the complete runnable flow. Private keys stay local; the browser operator supplies the network adapter.

## Site discovery

A site can publish `/.well-known/aap` with its protocol version, API service, endpoints, and capabilities. Discovery locates the service; it does not authorize access or establish trust in an issuer.

```bash
aap discovery create --origin https://bank.example --api-base https://aap.example --out aap.json
aap discovery retrieve https://bank.example
```

Serve the generated file on the site's domain. See [Site discovery](docs/discovery.md) for the profile, SDK usage, and a local walkthrough. Discovery is optional and never automatically sends API credentials or changes the configured service or trust root.

## Repository layout

```text
docs/spec.md          the specification
docs/api.md           API reference
docs/cli.md           command reference
docs/guides/          integration guides per party
docs/images/          diagrams and the logo
src/cli.ts            command line entry point
src/cli/              profiles, flag parsing, listen, demo
src/sdk/              the client library
src/server/           the reference API: router, auth, envelope, resources
src/lib/              authorization, verification, customer actions, events, store
src/types.ts          object and claim shapes
test/                 protocol, SDK, and API tests
examples/             lifecycle walkthrough and attestation examples
```

## Tests

```bash
bun test
bun run typecheck
```

Covers authorization and consent, browser admission, revocation, customer actions, optional attestations, discovery, key interoperability, and API behavior including errors, idempotency, events, and webhook signatures.

## Status

This is a draft. Endpoint names, header names, and claim shapes may change before release.

The file-backed store, account onboarding, and browser transports are for local evaluation. Production integrations need durable state, verified onboarding and origin ownership, trusted customer-session binding, and revocation enforcement. AAP coordinates permission; sites remain responsible for identity decisions and executing the underlying operations. See the [integration boundaries](docs/advanced.md) for more detail.
