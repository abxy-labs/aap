# Optional evidence and transport internals

The core integration needs policies, authorizations, browser connect, and customer actions. The capabilities below are opt-in. A credential is evidence of a claim, never customer permission by itself.

## Exact-scope evidence policy

```json
{
  "origin": "bank.example",
  "scopes": ["accounts:read", "payments:initiate"],
  "advanced": {
    "evidence": {
      "accounts:read": "attested",
      "payments:initiate": "observed"
    },
    "attestations": {
      "issuers": ["iss_RETURNED_BY_REGISTRATION", "operator"],
      "types": ["EmailControlCredential"],
      "claims": ["email_verified"],
      "max_age_s": 86400
    }
  }
}
```

Evidence keys are exact allowed scopes, not tiers. Omitted requirements do not require an attestation. `asserted` records the signed consent assertion; `observed` requires an independently verified customer-session link; `attested` requires a current credential accepted by policy; `site` requires the customer to complete the scope at the institution. `presented` is reserved for holder-bound presentations and fails closed until implemented.

`site_session` on acceptance is the institution's verified human-session ID. It is neither the agent session nor an arbitrary application identifier. The reference test helper simulates this binding; production must authenticate the customer independently.

The `operator` issuer selector accepts the authorization's own operator/agent signing identity. It does not mean “trust any browser company.” A registered identity provider is trusted by its verified issuer record, not merely a claimed URL.

## Credential profile

The implementation accepts signed W3C VC v2-shaped JWT credentials: `typ: vc+jwt`, base context `https://www.w3.org/ns/credentials/v2`, `VerifiableCredential` plus one concrete type, issuer, `validFrom`, `validUntil`, and `credentialSubject.id` with primitive claims. ES256 and EdDSA keys are supported.

This is the reference implementation's constrained VC-JWT profile, not support for every VC proof format, DID method, wallet presentation or status mechanism. Context URLs are identifiers, not instructions to fetch arbitrary remote keys. Only configured issuer keys are trusted.

Derive the subject with `aap.credentials.subject(authorization)`. The namespace binds operator and pseudonymous customer reference. It does not bind the claim to one particular task; the institution chooses whether reuse is appropriate and enforces issuer, type, claims, expiry, revocation and maximum age.

An issuer signs with `aap.credentials.issue(body, key)`. An application can use `aap.credentials.issueForAuthorization(authorization, input)` with its local agent key for checks it actually performed. The operator may pass signed credentials during acceptance using `attestations`, or submit them afterward through `aap.attestations.create(authorization.id, {credential})`.

Inline credentials are verified before issuance. The service stores only selected claims and verification/provenance metadata, not the raw token or unrelated personal fields. Revocation belongs to the actual issuer or institution, not a relay. There is no external status-list fetcher or holder-binding verification in this draft.

## Browser transport

`aap.browser(transport).connect` encapsulates the cryptographic sequence. Implementations still use these internal artifacts:

- Root-signed operator certificate with public key and infrastructure profile.
- Operator-signed agent certificate with public key and scope/constraint ceiling.
- Root-signed internal delegation certificate for the accepted authorization, backed by an immutable consent snapshot.
- Agent-signed short-lived session grant referencing that certificate, origin, challenge nonce, intent, scopes and session reference.

The operator adapter receives the participating site's challenge and delivers the presentation through its browser verification channel. Wire headers remain `Foil-Agent-Challenge`, `Foil-Agent-Grant`, `Foil-Agent-Status`, and `Foil-Agent-CustomerAction`. Browser connect does not put authorization credentials into every ordinary website request.

The SDK verifies the configured root, operator/agent chain, intended origin and challenge before signing. The verifier validates signatures, expiry, admission policy, scope intersection, evidence, operator profile and grant replay. A reused grant on another session downgrades both sessions. Current authorization revocation and policy are checked again on use.

The internal terms/delegation functions are not public REST resources or alternate SDK integration paths. Diagnostics may inspect internal audit records, but application guides use authorization IDs.

## Deployment obligations

The local JSON store and in-process authorization lock do not provide multi-process transactions or crash-atomic multi-file writes. Deployments need durable issuance/revocation transactions, unique authorization-to-certificate mapping, atomic challenge/grant binding, authenticated customer sessions, credential/key lifecycle management and a transactional outbox.

The institution still validates and executes the financial operation, enforces aggregate limits, consumes approval context safely and idempotently, and retains required customer records. The reference examples simulate these boundaries; they do not establish a production-ready financial service.
