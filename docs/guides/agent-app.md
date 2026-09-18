# Integrate an agent application

Your application talks to its browser operator. It does not need a new AAP account type, signing implementation, or separate terms/delegation exchange.

1. Ask your operator to create an authorization with the registered agent, intended institution, pseudonymous customer reference, task intent, and only the required scopes.
2. Display the returned consent details. Show terms/privacy links, render full documents when required, and collect the specific acknowledgement text. Keep the authorization ID and exact consent revision.
3. Send actual acceptance to the operator with that ID/revision. Record document views, acknowledgements, channel, time, and copies delivered when required. A prompt such as “open an account” is not this consent.
4. After the operator connects the browser, show any returned customer action using its URL and display text. License capture and liveness may need the customer; ordinary background identity checks do not inherently need a handoff.
5. Resume only after the institution reports completed. Approval means permission to proceed, not a successful payment or opened account.
6. Show connected authorizations by institution, intent, and scope. Pass a customer disconnect request to the operator, which revokes the exact authorization with `by: "consumer"`.

If the policy changed or consent expired, request fresh authorization and present it again. Do not silently expand scopes or reuse an old acknowledgement for new terms.

The application-to-operator transport is integration-specific. Product-page JSON examples describe that exchange, not invented public endpoints.

An application that actually verified a customer's email/phone can optionally supply a signed credential under an identity the institution explicitly trusts. See [optional attestations](../advanced.md); such evidence does not replace customer consent.
