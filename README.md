# Agent Admission Protocol

AAP lets an AI agent act at a participating financial institution with explicit customer consent and institution-defined permissions.

This is a draft reference implementation. There is one integration path, not a compatibility layer for earlier drafts:

1. The institution publishes explicit scopes, limits, disclosures, and customer-action requirements.
2. The operator creates an authorization. The application shows its consent details to the customer.
3. The operator records acceptance of that exact consent revision.
4. One browser-connect operation verifies the challenge, signs locally, and presents the authorization.
5. Customer-only steps use customer actions. Either party can withdraw access.

Attestations are optional. Institutions can add signed identity or risk evidence without changing the basic flow.

## Run it

```bash
bun install
bun run demo
bun test
bun run typecheck
```

The demo starts an isolated local API and removes its temporary data afterwards. Consent, human sessions, and financial activity are simulated. It does not open an account or make a payment.

## Integrate

- [Protocol](docs/spec.md)
- [API](docs/api.md) and [CLI](docs/cli.md)
- [Financial institutions](docs/guides/site.md)
- [Agent applications](docs/guides/agent-app.md)
- [Browser operators](docs/guides/operator.md)
- [Identity and risk providers](docs/guides/attestation-issuer.md)
- [Optional evidence and cryptographic transport](docs/advanced.md)
- [Discovery](docs/discovery.md)

## SDK

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

The named integration inputs above are supplied by your application; this is not a standalone script. Run `bun run demo` for a complete runnable example.

Private keys stay local. A browser connection is not a universal browser launcher: the operator implements the network adapter. Discovery never automatically changes the configured API host or trust root.

## Reference implementation boundaries

The JSON-file store, account onboarding, and test transports are for local evaluation. Production deployments need durable transactions, verified onboarding/origin ownership, authenticated customer-session binding, revocation enforcement, and their own financial execution controls. AAP coordinates permission; institutions remain responsible for identity decisions, transaction validation, and execution.
