# Integrate an identity and risk provider

This guide is for providers that create attestations about a person, an operator,
or an agent: identity verification, business verification, account ownership, or
risk assessments. Your role is to perform the check and issue evidence about its
result. AAP carries the relevant evidence or its reference through an agent-led
flow. The receiving institution decides which providers and claims it trusts and
what actions it will permit.

You are not necessarily an embedded provider. Issuing an attestation is a separate
role from hosting an iframe or popup. If you also host the customer's verification
experience, read [Integrate an embedded provider](embedded-provider.md).

## What is supported today

| Path | What AAP carries | Current support |
| --- | --- | --- |
| Operator vetting | Third-party attestation metadata in the operator certificate: type, issuer, reference, and optional credential and timestamps | Supported. Production vetting happens out of band; reference account creation only demonstrates carriage. |
| Customer verification during a handoff | A result recorded by the institution, which can contain a minimal provider attestation reference | Supported as an application-defined handoff result. AAP does not verify the provider's credential or interpret the attestation fields. |
| Customer-held verifiable credentials | Issuer-verified, holder-bound presented evidence in the delegation | Planned, not implemented. See [verifiable credentials](../spec.md#planned-verifiable-credentials). |

There is no `identity_provider` account type or attestation-issuance API in the
current reference implementation. Providers issue evidence through their own
systems. Do not give a provider your institution's AAP API key: your trusted
backend validates the provider's response and reports the accepted result.

## 1. Agree on the evidence and its recipient

Agree with the institution on the claim being made, the subject it describes, the
trusted issuer, its validity period, and how to check its authenticity and status.
Examples include an identity check for an account applicant or a business check
for an agent operator. These are different subjects, not interchangeable claims.

Use your existing signed assertion, credential, or authenticated server-to-server
result. Bind it to the right customer and application, restrict its audience where
your format supports that, and provide a way to identify expiry or revocation.
These are provider/institution integration requirements, not automatic checks
performed on an arbitrary AAP handoff result.

An attestation is evidence, not customer consent or permission to act. It does not
replace the delegation, widen an agent's scopes, or approve a loan or payment.

## 2. Complete a customer verification handoff

The institution configures `identity:verify` as a `complete`-mode handoff. Its
agent session already has a customer delegation and the required scope. The agent
requests the handoff and the customer completes the provider's verification flow
from their own device.

```sh
aap --profile operator handoffs create \
  --session ses_demo_application \
  --scope identity:verify \
  --context.application demo_application
```

The institution's backend validates the provider's evidence before completing the
handoff: issuer authenticity, subject/application binding, freshness, status, and
the bank's own acceptance rules. Keep the original evidence in the institution's
or provider's protected records. Pass only a minimal, opaque reference into AAP.

The following is a **local simulation**, using illustrative IDs. The `test`
command associates a simulated human session with the handoff; it is not a
production verification mechanism. Replace the demo IDs with resources from your
local reference API. See the [CLI reference](../cli.md) for profiles and setup.

```sh
aap --profile site test handoffs link hnd_demo_identity \
  --session ses_demo_customer

aap --profile site handoffs complete hnd_demo_identity \
  --data '{
    "result": {
      "outcome": "passed",
      "attestation": {
        "type": "identity_verification",
        "issuer": "https://identity.example",
        "ref": "att_demo_identity"
      }
    }
  }'
```

`result.attestation` here is an application-defined convention, not a standardized
credential object. The reference API stores the result as supplied by the site.
It checks the completing human session, but it does not authenticate the issuer,
verify a signature on this reference, or turn it into `presented` evidence.
It also does not interpret `outcome`: do not complete a failed check with
`"outcome": "failed"`, because completion would still resume the session.
Keep the agent paused or cancel the handoff, and enforce the failed decision in
the institution's application.

## 3. Read the result and resume within existing permissions

```sh
aap --profile operator handoffs retrieve hnd_demo_identity

aap --profile site sessions retrieve ses_demo_application
```

The completed handoff retains the result and its reference. Completion resumes
the agent session without granting new scopes. The institution remains responsible
for deciding whether the application can proceed and for enforcing that decision.

Both the owning institution and the associated operator can retrieve the handoff.
Do not include identity documents, biometrics, dates of birth, raw risk signals,
access tokens, or URLs that confer access to private evidence. A reference should
require separate authorization to resolve. Apply appropriate retention and access
controls to the underlying evidence.

For a risk provider, the same integration pattern can carry a reference to an
assessment relevant to a customer-completed step. It is not a general-purpose
asynchronous risk-feed API: ongoing risk updates, expiry, and revocation still
need explicit handling by the institution outside this result field.

## 4. Provide attestations about operators

An attestation about an operator belongs on its operator certificate, not in the
customer's identity record. During vetting, supply Foil with the attestation's
type, issuer, reference, and any signed credential or validity metadata agreed
with the verifier. The certificate carries that metadata in `attestations`.

The reference CLI accepts it through `accounts create --attestations @file.json`.
That command stands in for production onboarding; accepting an object there does
not demonstrate independent verification of your issuer's signature or status.
See [Integrate an operator](operator.md) and the [accounts API](../api.md).

## Planned: customer-held credentials

The protocol reserves `presented` evidence for a customer-held credential verified
against its issuer and bound to its holder. The intended flow includes a site's
accepted credential types, issuers, and requested claims. Those fields do not yet
provide a working credential-presentation integration. Do not enable a policy
requiring presented evidence expecting this handoff example to satisfy it.

When implementing that extension, providers will need to agree with the verifier
on credential formats, issuer keys, holder binding, audience, selective disclosure,
freshness, and revocation. Until then, use institution-validated handoff results
for customer checks and operator attestations for operator vetting.
