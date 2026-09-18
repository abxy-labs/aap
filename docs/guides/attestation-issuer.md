# Integrate an identity or risk provider

Attestations are optional evidence, not admission or customer consent. The institution explicitly decides which issuer identities, credential types and claims it accepts.

A registered provider signs its own credential with its locally held issuer key. An agent application can instead sign claims about checks it performed itself, using its operator/agent identity when the institution trusts that source. Passing a third-party credential through does not change who signed it.

1. Register the issuer's public keys and identifier with the reference service. Production registration requires verified ownership and trust onboarding.
2. Obtain the pseudonymous credential subject and authorization ID from the requesting application/institution. The subject is derived from operator + customer reference; a provider does not need permission to read the whole authorization.
3. Perform the real check, then issue the supported W3C VC v2 JWT profile. State only what you verified, with issue/expiry times.
4. Submit with `aap.attestations.create(authorization.id, {credential})`, or return the credential for the operator to pass through.
5. Revoke it when your claim no longer holds. The institution may also revoke; an operator merely relaying it cannot withdraw your statement.

Only policy-selected claims are retained. Raw credentials and unneeded personal fields are not stored. Do not include documents or biometrics.

Run `bun examples/attestations.ts` for both provider-signed and application-signed reference flows. These are simulated checks. See [credential format and limitations](../advanced.md).
