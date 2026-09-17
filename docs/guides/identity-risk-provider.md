# Issue identity and risk credentials

An **attestation issuer** is a role, not a special class of company. It can be an
identity or risk provider, or an AAP customer such as an agent application, browser
operator, or institution that has checked something about its own user. Here,
"customer" means that business, not the individual being verified.

The proposed credential integration uses **W3C Verifiable Credentials Data Model
2.0**, not a new AAP signed-attestation format. A specialist can issue an identity
verification credential; an application can issue a credential saying it checked
control of an email address or phone number. The receiving institution decides
which issuer it trusts for each claim and action. Email or phone control is not
equivalent to verifying a person's legal identity.

**Implementation status:** this guide describes a proposed integration. Native
VC issuance, presentation, and verification are not implemented by the reference
API. The handoff example below works today but carries only an application-defined
reference to evidence validated outside AAP; that reference is not a VC.

You are not necessarily an embedded provider. Issuing an attestation is a separate
role from hosting an iframe or popup. If you also host the customer's verification
experience, read [Integrate an embedded provider](embedded-provider.md).

## What is supported today

| Path | What AAP carries | Current support |
| --- | --- | --- |
| Operator vetting | Third-party attestation metadata in the operator certificate: type, issuer, reference, and optional credential and timestamps | Supported. Production vetting happens out of band; reference account creation only demonstrates carriage. |
| Customer verification during a handoff | A result recorded by the institution, which can contain a minimal provider attestation reference | Supported as an application-defined handoff result. AAP does not verify the provider's credential or interpret the attestation fields. |
| W3C verifiable credentials | Credentials issued by specialist providers or businesses checking their own users, with binding and provenance verified under the agreed presentation profile | Planned, not implemented. See [verifiable credentials](../spec.md#planned-verifiable-credentials). |

There is no `identity_provider` account type or attestation-issuance API in the
current reference implementation. Providers issue evidence through their own
systems. Do not give a provider your institution's AAP API key: your trusted
backend validates the provider's response and reports the accepted result.

## Proposed: one standard credential model, multiple kinds of issuer

Use [W3C VC Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/) for the
credential and presentation data models. The initial target for securing them is
the JOSE/JWT path in
[Securing Verifiable Credentials using JOSE and COSE](https://www.w3.org/TR/vc-jose-cose/).
Use its standard VC/VP encodings rather than an `aap-attestation` token type or a
custom signature envelope. This does not replace AAP's existing authorization
certificates, grants, or challenges.

The integration profile still has to pin its supported algorithms, trusted key
resolution, claim schemas, status mechanism, and presentation exchange before
implementation. Choosing W3C VCs does not make arbitrary JWTs or every VC proof
suite interoperable. Do not advertise COSE, Data Integrity, selective disclosure,
or wallet compatibility until the corresponding profile is implemented and tested.

Use these roles consistently:

- **Issuer:** the organization standing behind the credential's claims. A browser
  operator can be an issuer for its own checks, but cannot impersonate an outside
  verifier or replace that verifier's signature with its own.
- **Subject:** the person, operator, or agent the claims describe.
- **Holder/presenter:** the party delivering the credential. Relaying it does not
  make that party its issuer, its subject, or proof that the subject consented.
- **Verifier:** Foil acting for the institution in the proposed integration, under
  that institution's acceptance policy. Today the institution validates evidence
  outside the reference API.

### First-party checks and specialist checks

Both paths use the same credential model; they differ in the issuer and the
specific claims, methods, and evidence the institution accepts. For example:

| Proposed institution rule | Acceptable evidence |
| --- | --- |
| Begin an application | A recent email-control credential from an explicitly trusted agent application |
| Use a phone-based contact channel | A recent phone-control credential from an explicitly trusted issuer using an accepted verification method |
| Complete identity verification | An identity credential from one of the institution's approved identity providers, with the required checks |

These are policy examples, not new CLI flags. Do not accept every claim from a
company merely because it is an admitted browser operator, nor treat a provider's
self-declared category as a trust decision. A valid signature authenticates the
issuer; it does not establish the truth or sufficiency of a claim. This is the
issuer/verifier separation in the
[W3C trust model](https://www.w3.org/TR/vc-data-model-2.0/#trust-model).

An illustrative, **unsigned credential body** for an application's own check:

```json
{
  "@context": [
    "https://www.w3.org/ns/credentials/v2",
    {
      "EmailControlCredential": "https://example.org/credentials/EmailControlCredential",
      "email": "https://schema.org/email",
      "emailControl": "https://example.org/credentials/emailControl",
      "method": "https://example.org/credentials/method",
      "checkedAt": "https://example.org/credentials/checkedAt"
    }
  ],
  "type": ["VerifiableCredential", "EmailControlCredential"],
  "issuer": "https://assistant.example",
  "validFrom": "2026-09-17T10:00:00Z",
  "validUntil": "2026-09-18T10:00:00Z",
  "credentialSubject": {
    "id": "urn:uuid:ff3a0a45-3e6c-4c4e-b465-e8b2d306077b",
    "email": "user@example.net",
    "emailControl": true,
    "method": "email_link",
    "checkedAt": "2026-09-17T09:58:00Z"
  }
}
```

The issuer signs this body using the selected W3C securing mechanism. The body
alone is not authenticated. The extra vocabulary above is illustrative, not a
W3C-defined claim set or a published AAP context. Reuse established claim schemas
where suitable; publish and version any necessary domain terms before accepting
them. The dates and one-day validity are examples, not a default assurance policy.

Use a pairwise subject identifier and bind it to the correct customer and
delegation through an authenticated process. The example binds the check to the
specific email address in the credential, not an arbitrary address supplied later.
If a decision depends on a specific address or number,
the issuer-signed evidence must bind that exact value or a securely resolvable
reference to it; a bare boolean is insufficient. Share that value only with the
authorized verifier, not in browser-visible headers or the shared handoff result.

### Two issuance options, with provenance intact

1. **Issuer-managed signing.** The identity provider or customer business issues
   the VC with its own authorized key. Resolve the key through the trusted issuer
   configuration, not an arbitrary URL supplied by the token. Registration or a
   signature alone does not make an issuer trusted for all claims.
2. **Optional Foil-hosted reporting.** A customer submits a check result through
   an authenticated integration. Foil could issue a VC explicitly stating
   "this business reported this check," identifying the reporting business and
   its claim. Foil is the issuer of that receipt, not the independent verifier of
   the underlying check. The receipt needs a distinct, versioned claim schema and
   explicit acceptance rules for both Foil and the reporting business. It must not
   satisfy a rule requiring the original provider's signature. This service is
   proposed only; no hosted-issuance endpoint exists today.

Do not turn an unsigned report into a credential that appears provider-signed.
When relaying a provider-issued VC, preserve its original issuer and proof.

### Presentation and verification requirements

The proposed AAP integration must validate the credential's structure and proof,
issuer/key authorization, permitted claim type and method, validity and check
freshness, and status where required by institution policy. It must also bind the
presentation to the intended verifier, a fresh challenge, and the correct AAP
customer/delegation context, rejecting replay and subject substitution. These
presentation properties are not automatically supplied by a VC signature or its
`credentialSubject.id`.

A customer's wallet can prove possession of a holder key through an appropriate
standard presentation mechanism. A business can also supply evidence from its
backend, but that proves the business submitted it, not that the customer holds
a key. Keep those assurance levels distinct; never mark evidence `holder_bound`
solely because the business signed a credential. Neither a VC nor its holder
proof replaces the customer's authorization to the agent.

Use an established presentation exchange and specify the exact audience,
challenge, subject, and delegation binding before enabling native acceptance.
Missing bindings or unavailable required status checks must fail closed. The
existing `credentials` policy and `presented` record fields are reserved starting
points, not a working verifier or a complete expression of these trust rules.

Minimize disclosed claims, require authenticated access to references, and
encrypt confidential evidence to its intended recipient when transporting it
through intermediaries. A signed VC is not encrypted. A long-lived credential
must not freeze a changing risk decision: use freshness/status rules appropriate
to the claim. Do not assume credential revocation automatically revokes an existing
delegation; define revalidation and the resulting access decision explicitly.

## Current reference flow: agree on evidence and its recipient

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

## Current reference flow: complete a customer verification handoff

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

## Current reference flow: read the result and resume

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

## Current reference flow: attestations about operators

An attestation about an operator belongs on its operator certificate, not in the
customer's identity record. During vetting, supply Foil with the attestation's
type, issuer, reference, and any signed credential or validity metadata agreed
with the verifier. The certificate carries that metadata in `attestations`.

The reference CLI accepts it through `accounts create --attestations @file.json`.
That command stands in for production onboarding; accepting an object there does
not demonstrate independent verification of your issuer's signature or status.
See [Integrate an operator](operator.md) and the [accounts API](../api.md).

These metadata fields are not a second credential standard. A future native
integration should preserve the original W3C credential and validate it under the
agreed profile, rather than treating a copy of its issuer/type/reference as proof.
Until that integration exists, do not set a policy requiring `presented` evidence
and expect a handoff reference or an operator metadata entry to satisfy it.
