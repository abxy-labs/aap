# Integrate a browser operator

## Register and authorize

Register under a vetted operator identity. Keep the operator and agent signing keys local. Register an agent with a ceiling of explicit scopes and limits.

Create one authorization for the task. Pass its consent details to the application; submit the customer's actual acceptance against its exact revision using `authorizations.accept`. The SDK signs locally. No separate terms lookup or delegation creation is required.

## Connect once

```ts
const browser = aap.browser({
  challenge: origin => network.receiveChallenge(origin),
  present: ({origin, header, session}) =>
    network.presentProof({origin, header, session}),
});
const session = await browser.connect({authorization: authorization.id});
```

`network` above is your operator's browser-network adapter. It must deliver the signed proof to the verified, intended institution's verification channel and return the actual response. This is not a page-script fetch helper or a universal browser launcher.

The SDK verifies the configured trust root, certificate chain and origin-bound challenge, signs with the agent key, and builds the transport proof. Do not forward credentials to arbitrary origins or automatically trust a service advertised by discovery.

Check the returned session decision. Request customer actions with that session ID and the exact action context. Send the returned URL/display text to the application. Wait for completed; canceled/expired/pending must not authorize work.

Stop scheduling work and issuing connections when authorization is revoked or expires. A retry must not widen scopes or infer new consent.

## Local test

```bash
aap test browser connect --authorization auth_FROM_ACCEPTANCE --asn AS14618
```

The CLI supplies a reference test transport; production uses your real browser adapter. Test mode does not launch a browser or perform banking operations.

See [CLI](../cli.md), [discovery](../discovery.md), and [advanced transport](../advanced.md).
