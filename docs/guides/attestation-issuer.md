# Issue attestations

This guide is for anyone who has checked something about a person and wants a site to know it: an identity or risk provider whose business is those checks, or an agent application that verified a consumer's email or phone itself. In both cases you sign a statement as a verifiable credential and it reaches the site attached to the consumer's delegation. When you finish, a site that requires an attestation admits sessions carrying yours.

The guide assumes you have read the [Key concepts](../spec.md#key-concepts) section of the specification. Attestations are optional. A site that does not ask for them is unaffected by anything here.

## Before you begin

You need one of the following, depending on which kind of issuer you are.

- **A provider** needs an issuer account with Foil, an https identifier such as `https://identity.example`, and a signing key whose public half is registered. Sites name your issuer id in their policy.
- **An application** needs nothing new. It signs with the agent key it already has, and a site that admits `operator` in its policy accepts credentials from the delegation's own operator and its agents.

Sites decide what they accept. Being registered does not make a site accept you, and a credential is not a claim that the site should act on it.

## What you read and what you write

| You write | Where | You read | Where |
| --- | --- | --- | --- |
| A signed credential | Locally, with your own key | The attestation that was recorded | The response, or `GET /v1/attestations/:id` |
| A submission against a delegation | `POST /v1/delegations/:id/attestations`, or `attestations` on `POST /v1/delegations` | What a site accepts | From the site, out of band |
| A revocation | `POST /v1/attestations/:id/revoke` | | |

## Step 1: Know the subject

A credential names a subject, and for an attestation the subject is the delegation, expressed as a pseudonymous identifier built from the operator and its own identifier for the end user.

```
urn:aap:subject:op_7a1d:usr_41b
```

You never need the consumer's name, email address, or account number to write this. An operator builds it with `aap.credentials.subject(delegation)`, or from the operator id and subject before the delegation exists. A provider is given it by whoever asked for the check, along with the delegation id, because an issuer account cannot read delegations.

## Step 2: Sign a credential

The format is the W3C Verifiable Credentials data model, serialized as a JWT with the `vc+jwt` media type, signed with ES256 or EdDSA.

```json
{
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  "type": ["VerifiableCredential", "EmailControlCredential"],
  "issuer": "https://identity.example",
  "validFrom": "2026-09-17T18:00:00.000Z",
  "validUntil": "2026-10-17T18:00:00.000Z",
  "credentialSubject": {
    "id": "urn:aap:subject:op_7a1d:usr_41b",
    "email_verified": true,
    "method": "email_link"
  }
}
```

The SDK builds and signs it:

```ts
const credential = await aap.credentials.issue(aap.credentials.body({
  issuer: "https://identity.example",
  type: "EmailControlCredential",
  subject: aap.credentials.subject(delegation),
  claims: { email_verified: true, method: "email_link" },
  validUntil: new Date(Date.now() + 30 * 86_400_000),
}), issuerKey);
```

An application signing its own check names its agent as the issuer and uses its agent key, which `aap.credentials.issueForDelegation(delegation, { issuer: agent.id, … })` does in one call.

Three rules. The `issuer` must be the identifier whose key you are signing with, since a site checks a credential only against keys registered for the issuer it names. Claims must be flat strings, numbers, or booleans. Additional contexts and fields are allowed and ignored, so a credential you already issue for another purpose can be reused if it carries the right subject.

## Step 3: Submit it

Either party can submit, and the site sees the same object.

**A provider posts it.** Whoever commissioned the check gives you the delegation id. Holding that id is what lets you post against it; you cannot read the delegation.

```
POST /v1/delegations/dl_1Qx8k2/attestations
{ "credential": "eyJ…" }
```

**An operator passes one through.** A credential the operator already holds can ride along when the delegation is created, so the site needs no separate exchange.

```ts
await aap.delegations.create({ agent, origin, subject, terms, acceptance, attestations: [credential] });
```

The response is the attestation: the issuer, the type, the claims the site's policy named, when the credential was issued and until when it is valid, and who submitted it. `holder_bound` is always false, because this is a statement by an issuer, not a presentation from the consumer's own wallet.

```json
{
  "id": "att_4Kq2m", "object": "attestation", "status": "active",
  "delegation": "dl_1Qx8k2", "origin": "bank.example",
  "issuer": "https://identity.example", "type": "EmailControlCredential",
  "subject": "urn:aap:subject:op_7a1d:usr_41b",
  "claims": { "email_verified": true },
  "issued_at": 1758000000, "valid_until": 1760592000, "verified_at": 1758000120,
  "submitted_by": "issuer", "holder_bound": false
}
```

Only the claims the site's policy names are kept. Everything else in the credential, including personal data such as the address you checked, is discarded and never stored, returned, or emitted in an event. The credential itself is not retained.

## Step 4: Revoke when the check no longer holds

Either you or the site can revoke. A revoked attestation stops satisfying the site's policy at the next session binding or scope use.

```
POST /v1/attestations/att_4Kq2m/revoke
```

An attestation also stops counting when its `validUntil` passes, or when the site tightens its policy past what the attestation carries. Issue a short validity when the check is time-sensitive rather than relying on revocation.

## Test it locally

```
aap serve                                                              # in another terminal
aap accounts create --type issuer --name "Identity Co" --url https://identity.example --key issuer.key.json
aap credentials issue --issuer https://identity.example --type EmailControlCredential \
    --delegation dl_… --claims email_verified=true,method=email_link --valid-for 30d --key issuer.key.json --out vc.jwt
aap attestations create --delegation dl_… --credential vc.jwt
aap attestations list --delegation dl_…
aap attestations revoke att_…
```

`bun examples/attestations.ts` runs both submission paths end to end against a temporary API, including the refusal before an attestation exists and the downgrade after revocation.

## Common mistakes

- **Naming an issuer you did not sign with.** The site checks your credential only against keys registered for the issuer the credential names.
- **Signing for a subject that is not the delegation's.** The subject is derived from the operator and its own identifier for the end user, not from the consumer's identity.
- **Putting personal data in claims the site did not ask for.** It is discarded, so it only adds risk in transit.
- **Treating registration as acceptance.** A site chooses its issuers, types, and required claims. Ask what it accepts before issuing.
- **Long validity on a time-sensitive check.** A site's `max_age_s` may refuse an old credential even while it is still valid.
