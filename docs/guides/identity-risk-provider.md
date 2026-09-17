# Issue identity and risk credentials

Attestations are **optional**. AAP's authorization and session flows work without
them. An institution can require accepted credential evidence for particular tiers
of actions; that is an institution policy, not a protocol-wide prerequisite.

An **issuer** is a role, not a special category of company. A specialist identity
or risk provider can issue evidence, as can an agent application, browser operator,
or institution that has verified something about its own users. Email or phone
control is not legal-identity verification. The institution decides which issuers,
checks, and methods it accepts for each action. A valid signature identifies the
issuer; it does not prove a claim is true or replace the customer's authorization.

The reference API, SDK, and CLI implement a bounded business-to-institution
profile of [W3C VC Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/), secured
using [W3C VC JOSE](https://www.w3.org/TR/vc-jose-cose/). They do not introduce a
second AAP attestation token format. This profile uses ES256 `vc+jwt` credentials
and issuer-held `vp+jwt` presentations. Both specialist and first-party issuers
use the same flow, with different institution-configured trust rules.

## Try the entire CLI flow

From the repository root, after `bun install`:

```sh
bun examples/credentials.ts
bun examples/credentials.ts --first-party
```

Each walkthrough starts a temporary local reference API and drives the actual CLI:

1. Create an institution, an operator, an agent, and a customer delegation.
2. Configure an institution to trust a specific issuer key and email-control check.
3. Confirm access fails when that institution requires evidence and none exists.
4. Sign a credential and a challenge-bound presentation locally, then verify it.
5. Bind a session and use its scopes with accepted evidence.
6. Revoke the evidence and confirm subsequent protected use is refused.
7. Remove the requirement and confirm ordinary AAP works without attestations.

The script uses fictional check results; it does not send an email, perform KYC,
or prove the example customer exists. It removes its temporary keys, configuration,
and server state on exit. No provider credentials or API keys are printed.

## 1. Configure trust at the institution

The institution owns the policy and pins issuer keys out of band. Do not trust a
key just because an issuer supplied it, or because the issuer is an admitted
browser operator. Never give an issuer your institution's API key.

Generate a separate issuer key locally:

```sh
aap keys generate --alg ES256 --out issuer.json
```

The public part belongs in the institution's `credentials.trust` rule. The private
part stays with the issuer. Key and token files are created owner-only and are not
silently overwritten. Use your normal secret-management system outside a local demo.

An illustrative `trust.json` (replace the **public** JWK placeholder):

```json
{
  "types": ["EmailControlCredential"],
  "issuers": ["https://assistant.example"],
  "claims": ["email", "verified", "method"],
  "trust": [{
    "issuer": "https://assistant.example",
    "type": "EmailControlCredential",
    "key": { "kty": "EC", "crv": "P-256", "x": "PUBLIC_X", "y": "PUBLIC_Y", "kid": "KEY_ID" },
    "context": {
      "EmailControlCredential": "https://example.org/credentials/v1/EmailControlCredential",
      "email": "https://schema.org/email",
      "verified": "https://example.org/credentials/v1/verified",
      "method": "https://example.org/credentials/v1/method",
      "checkedAt": "https://example.org/credentials/v1/checkedAt"
    },
    "claims": { "verified": true, "method": "email_link" },
    "max_age_s": 600
  }]
}
```

The outer `claims` array requires the fields to exist. Each trust rule's `claims`
object requires exact primitive values: `verified: false` or a different method
will not pass. Rules pin the exact vocabulary as well as the issuer and key, so
redefining a JSON-LD term cannot change what the institution is accepting. These
example.org terms are sample vocabulary, not claims defined by W3C. Agree on and
version your actual vocabulary with issuers before deployment.

```sh
aap --profile site policies create --origin bank.example --tier read \
  --credentials @trust.json --evidence read=presented
```

`credentials` alone configures what may be accepted. **Only `evidence` makes it
required for a tier.** Omit both for standard AAP without attestations. Legacy
type/issuer lists without pinned trust rules cannot verify a credential. A policy
update invalidates previous verification results conservatively; repeat verification
under the new policy, including when rotating keys.

## 2. Bind the request to the right customer

After an agent creates the ordinary authorized delegation, the institution creates
a verification request. `$DELEGATION` is that delegation's ID; the credential subject
is the issuer's pairwise customer identifier, not an email address selected by an agent.

```sh
aap --profile site credential-verifications create \
  --delegation "$DELEGATION" \
  --credential-subject urn:uuid:bdc85448-f06d-4522-afeb-d9e411910ea1
```

Save the response securely as `request.json` and deliver it to the issuer over
your authenticated backend integration. It contains a one-use nonce, institution
audience, delegation binding, policy version, and five-minute expiry.

**The institution must establish the subject mapping** from its trusted onboarding
flow. The reference API enforces that only the institution owning the delegation's
origin can create this mapping; it cannot determine that two arbitrary customer
identifiers denote the same person. Do not blindly copy an agent-supplied identifier.

## 3. Issue and present a credential

Create `credential.json` with the VC's `@context` equal to
`["https://www.w3.org/ns/credentials/v2", <the trust rule's context>]`, a URI `id`,
`type: ["VerifiableCredential", "EmailControlCredential"]`, the issuer URI,
`validFrom` and `validUntil` UTC timestamps, and a subject such as:

```json
{
  "id": "urn:uuid:bdc85448-f06d-4522-afeb-d9e411910ea1",
  "email": "user@example.net",
  "verified": true,
  "method": "email_link",
  "checkedAt": "2026-09-17T10:00:00Z"
}
```

Use current timestamps and real check results. Credentials last at most one hour;
the institution can impose a shorter check age (ten minutes above). The walkthrough
generates a complete ready-to-sign body with current timestamps for you.

```sh
aap credentials issue --body @credential.json --key issuer.json --out vc.jwt
aap credentials present --credential vc.jwt --request request.json \
  --key issuer.json --out vp.jwt
```

Both commands run offline without an AAP account. The presentation embeds the
original signed VC as a W3C `EnvelopedVerifiableCredential` data URI and signs the
request's audience and nonce. The initial profile requires the issuer to also be
the organization holding/presenting the credential, using the same pinned key.
It is **not proof of customer wallet-key possession**: `holder_bound` is false.

The CLI does not authenticate a request file received from another party. The issuer
must authenticate the institution and confirm its audience and request context before
presenting personal information. Use direct authenticated TLS backend delivery for
the request and VP. This implementation does not provide an encrypted relay, OID4VP,
or a general wallet exchange.

## 4. Verify and continue

The institution receives `vp.jwt` from its issuer integration and submits it:

```sh
aap --profile site credential-verifications complete "$VERIFICATION" \
  --presentation-file vp.jwt
aap --profile site credential-verifications retrieve "$VERIFICATION"
```

`$VERIFICATION` is the ID from step 2. Verification checks both signatures, pinned
issuer keys and contexts, type, required claim values and method, validity/check
freshness, audience, nonce, subject, current policy, and active delegation. An
invalid presentation does not consume the request. A successful one does; a
presentation for a different request, customer, or institution cannot be reused.
Use the same `--idempotency-key` to retry an uncertain identical completion.

The result is a minimal acceptance summary, not the personal claims or signed
credential. An institution that needs the values should retain the exact submitted
credential privately and use its claims only after verification succeeds. AAP does
not retain raw VC/VPs or copy them into grants, shared handoff results, or events.

Normal grant signing and session binding now work for the required tier. Live
credential evidence is a separate server-side record tied to the delegation; it is
not baked into a reusable delegation certificate. The session's
`agent.delegation.presented` contains the safe summary. The certificate/expanded
delegation record's reserved `presented` field remains null. Binding and subsequent
protected scope use consult live results, including expiry, revocation, and policy
version. Session retrieval itself is a snapshot, not an authorization decision.

```sh
aap --profile site credential-verifications revoke "$VERIFICATION"
```

Revocation stops this verification result from satisfying subsequent protected
operations. It does not revoke the underlying issuer credential globally or undo
actions already performed. New evidence requires a new request. The directory-backed
reference store uses atomic result replacement and a cross-process lock; a crash
may leave a fail-closed lock, in which case create a fresh request. A production
store should implement transactional compare-and-set and appropriate retention.

## Scope and future extensions

Supported now: one short-lived credential per presentation, ES256, explicit key
pinning, flat primitive claims with exact pinned contexts, institution-owned subject
mapping, issuer-held proof, and institution revocation of accepted evidence. Multiple
rules permit different issuers/checks; one matching rule satisfies a requirement.
This is not an all-of credential policy or an automatic trust federation.

The verifier **rejects**, rather than ignores, unsupported `credentialStatus`,
`credentialSchema`, Data Integrity proofs, and other unprofiled credential fields.
It makes no network calls to token-supplied key, context, or status URLs. There is
no issuer-driven global revocation/status-list integration in this profile: if your
action requires it, do not use this short-lived profile as a substitute. COSE,
SD-JWT, selective disclosure, customer wallet presentations, consumer-signed
delegations, and hosted Foil report receipts remain future extensions.

A future Foil-hosted receipt must say that the business reported a check, not that
Foil independently verified it. Preserve original provider signatures; re-signing
or relaying must never upgrade trust. Neither credential evidence nor a receipt
replaces consent, widens scopes, or approves a financial action.

## Existing handoff references and operator metadata

Institution-completed verification handoffs can still carry a minimal opaque
reference to evidence validated outside AAP. That result is not a VC and does not
satisfy `presented` policy requirements. Do not put confidential claims in a shared
handoff result. Do not complete a failed check with `outcome: failed`: completion
resumes the flow regardless of that application-defined field. Cancel or keep the
agent paused and enforce the institution's failed decision.

Likewise, the `attestations` metadata supplied during reference operator onboarding
remains metadata about the operator, not customer credential verification. A
Foil-signed operator certificate does not turn that metadata into a provider-signed
VC. See [operator integration](operator.md). An issuer that also hosts a popup or
iframe can additionally follow [embedded provider integration](embedded-provider.md).
