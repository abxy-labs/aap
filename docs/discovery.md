# Site discovery

An site MAY publish `GET https://<site-origin>/.well-known/aap`
to let operators discover its AAP service. This is a draft well-known suffix,
not an assertion of an IANA registration. Discovery is optional: operators
with an explicitly configured service can continue using it, and the existing
directory and signed-challenge flow remain supported.

The site hosts the document on its own HTTPS origin. The advertised
service may be operated by Foil or another implementation of the advertised
API version. Publishing metadata does not enroll an site, create a
policy, grant access, or verify an issuer. The reference server still requires
account onboarding, API credentials, a participating policy, customer consent,
and the normal signed challenge and grant verification.

## Document

```json
{
  "object": "aap_discovery",
  "version": "2026-09-17",
  "origin": "https://bank.example",
  "api_version": "2026-09-15",
  "api_base": "https://aap.example",
  "capabilities": ["delegations", "handoffs"],
  "endpoints": {
    "terms": "https://aap.example/v1/terms",
    "delegations": "https://aap.example/v1/delegations",
    "handoffs": "https://aap.example/v1/handoffs"
  },
  "jwks_uri": "https://aap.example/.well-known/foil-root"
}
```

- `version` versions this discovery format; `api_version` versions the API.
  This implementation accepts exactly the versions above and fails on
  unsupported versions rather than silently downgrading.
- `origin` MUST identify the exact site origin being queried, including
  a non-default port where applicable. It is not a wildcard for subdomains.
- `api_base` identifies the API service origin, without a path, query,
  fragment, or URL credentials. All endpoint URLs MUST match the paths above
  under that service. Alternate paths/transports need a future profile version.
- `capabilities` lists what the service supports. This version defines `delegations` and `handoffs`, and a document must advertise both. Later versions may add capabilities; a client that does not recognize one fails validation rather than guessing.
- `jwks_uri` points to the service's existing `/.well-known/foil-root` public
  key set. Discovery does not fetch it or automatically trust it. It is not a
  list of accepted credential issuers. Those issuers and keys remain explicitly
  configured in site policy.

Responses MUST be JSON (`Content-Type: application/json`) and contain public
metadata only. Do not put private keys, API tokens, customer data, full policies,
issuer allowlists, or customer-specific permissions here. Current terms and
requirements are returned by authenticated `POST /v1/terms` for a known agent
and site. Unknown top-level fields do not confer behavior; the client
returns only supported public fields. Unknown capabilities fail validation.

Serve with `Cache-Control: public, max-age=300` and an ETag; clients may reuse a
profile within its cache lifetime. Revalidate it when stale and invalidate any
previous endpoint/trust approval when the service changes. Stale metadata never
overrides current policy checks. Support CORS (`Access-Control-Allow-Origin: *`)
if browser-based public discovery is wanted; no cookie authentication is used.

## Publish

Generate a document offline, without logging in:

```sh
aap discovery create --origin https://bank.example \
  --api-base https://aap.example --out aap.json
```

Serve `aap.json` at the site's `/.well-known/aap` URL using your existing
web server or CDN. The CLI refuses to overwrite an existing output file. This
is a public file, not a secret. Generation does not provision an API or policy.

For a local reference deployment:

```sh
aap discovery create --origin http://127.0.0.1:4010 \
  --api-base http://127.0.0.1:4010 --allow-local --out local-aap.json
aap serve --port 4010 --discovery local-aap.json --allow-local
# In a second terminal:
aap discovery retrieve http://127.0.0.1:4010 --allow-local
```

`serve --discovery` explicitly mounts one site profile. Without the flag,
the route returns 404; a shared AAP API does not implicitly claim to represent
every site. The request URL origin must match the configured site
origin. When proxying HTTPS, ensure the trusted server integration constructs
that public request URL; the reference server does not trust forwarded headers.
For a separate site domain, serving the static file there is simplest.

The reference route supports GET, HEAD, ETag revalidation (304), and a five-minute
cache lifetime. It never reads test/live policies or private account records.
Configure each published origin intentionally; sandbox discovery should live on
a separate origin rather than exposing test policy through a live site.

## Consume

```sh
aap discovery retrieve https://bank.example
```

```ts
import { discover, Aap } from "aap";

const profile = await discover("https://bank.example");
// Review/allowlist the service first. Use a key issued for that service;
// do not send an existing Foil key to an arbitrary discovered endpoint.
const aap = new Aap(keyForApprovedService, { apiBase: profile.api_base });
const terms = await aap.terms.create({
  agent: agentRegisteredAtThatService,
  origin: profile.origin,
  scopes: ["accounts:read"],
});
// Continue through customer consent, delegation, and signed challenge/grant.
```

`aap.discover(origin)` is also available on an SDK instance. Neither helper
changes that instance's API base, keys, or root-key cache. They never log in,
fetch advertised endpoints/keys, or write CLI configuration. Each call performs
one GET; HTTP caches may honor the response headers, but the SDK adds no
persistent cache. A missing, unavailable, malformed, or incompatible profile
raises an error; it is not permission to act or a reason to fall back to an
untrusted endpoint. Explicit service configuration remains a separate choice.

## Security and privacy

- Discovery requests MUST omit API keys, cookies, grants, and other identity
  headers. HTTPS authenticates the site origin serving the metadata;
  it does not prove customer consent or third-party issuer trust.
- The SDK disables redirects, sets a five-second timeout, limits response bodies
  to 32 KiB, verifies the site binding, and validates service URLs. URLs
  must use HTTPS, without embedded credentials, fragments, or queries. Explicit
  `allowLocal: true` / `--allow-local` permits HTTP only for localhost,
  `127.0.0.1`, and `::1` development origins. Do not enable it for untrusted input.
- Server applications MUST enforce their own trusted-origin/egress policy before
  discovery, including DNS/IP checks and rebinding defenses if accepting user
  input. HTTPS validation is **not an SSRF defense**; this helper is not an
  unrestricted server-side URL crawler. Custom fetch implementations must
  honor the abort signal, redirect prohibition, and credential omission.
- Do not automatically replace a pinned Foil root, authorize an unfamiliar
  service, or trust anything based on metadata alone. A change of
  service requires deliberate onboarding and service-specific credentials.
- The site can observe a request to its well-known URL. Operators that
  must avoid proactively signaling AAP interest can keep using the configured
  service, optional hashed directory, and signed telemetry challenge instead.
  A hash of a known origin is a membership hint, not a privacy guarantee.
- A directory hit never replaces a fresh, origin-bound signed challenge. The
  challenge remains required by the reference grant-signing/verification flow.

Run `bun test test/discovery.test.ts` for public hosting, cache behavior,
SDK/CLI discovery, authenticated terms integration, malformed-response handling,
and non-disclosure/trust-boundary coverage.
