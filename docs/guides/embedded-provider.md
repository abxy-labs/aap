# Integrate an embedded provider

Treat your origin as its own institution boundary. Publish explicit scopes and disclosures, verify sessions arriving at your origin, and use customer actions for steps that need the human.

A host site's authorization does not automatically authorize your iframe or a third origin. Obtain authorization for the actual participating origin and verify an origin-bound challenge there. Keep each party's disclosures attributable to that party; do not silently combine or skip consent.

Use your own verified customer session for completion and your own records for execution decisions. The reference CLI tests one origin at a time; it is not a complete cross-origin browser/frame integration.

Follow the [institution guide](site.md) and [operator guide](operator.md). Optional credentials are described separately in [advanced integration](../advanced.md).
