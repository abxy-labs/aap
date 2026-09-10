# Agent Admission Protocol

<img src="docs/images/aap-logo.svg" alt="Agent Admission Protocol logo" width="305" height="118">

The Agent Admission Protocol (AAP) lets an automated agent identify itself to Foil, lets a site state which agents it admits and what those agents may do, and lets a consumer authorize an agent to act for them at a site. Sites that run Foil block automated traffic by default. The protocol adds a third category between human and bot, the agent plane, so that a site can admit the automation it has chosen to admit without loosening detection for anything else.

Three properties hold throughout. Foil never presents an interface to a consumer. Nothing is added to any request to a site. A site that has not opted in learns nothing.

## Contents

- [docs/spec.md](docs/spec.md): the protocol specification, written for sites, operators, and agent applications. It covers the concepts, the trust chain, the lifecycle, per-role guides, the reference for scopes, endpoints, headers, and claims, and security considerations.
- [docs/cli.md](docs/cli.md): the command line reference for `aap`, the reference implementation in this repository.
- Integration guides, one per party:
  - [Integrate a site](docs/guides/site.md), for an engineer at a site that runs Foil.
  - [Integrate an operator](docs/guides/operator.md), for a company that runs browsers for agents.
  - [Integrate an agent application](docs/guides/agent-app.md), for the product a consumer talks to.
  - [Integrate an embedded provider](docs/guides/embedded-provider.md), for a component that runs inside other companies' flows.
- [examples/lifecycle.sh](examples/lifecycle.sh): every command in order, from a fresh store to a bound session, a handoff, a replayed grant, and a revocation.

## Reference implementation

`aap` implements every object in the specification and the rules for issuing and verifying them. It runs against a local store that plays the part of Foil, so one machine can act as Foil, an operator, an agent, and a site in turn. It requires [Bun](https://bun.sh).

```
bun install
bun run src/cli.ts demo
```

The demo runs the whole lifecycle in a temporary store and prints each step. To run the commands yourself:

```
bun link
aap init
aap --help
```

Tests cover the lifecycle, every downgrade reason, and the issuance rules:

```
bun test
```

## Repository layout

```
docs/spec.md          the specification
docs/cli.md           command reference
docs/guides/          integration guides per party
docs/images/          diagrams used by the specification
src/cli.ts            command line entry point
src/lib/              protocol objects, verification, and the local store
src/types.ts          claim shapes
test/                 lifecycle and downgrade-reason tests
examples/             shell walkthrough
```

## Status

This is a draft. Endpoint names, header names, and claim shapes are subject to change before release. The reference implementation does not run a network service, does not score sessions, and does not implement the planned edge challenge; see the last section of [docs/cli.md](docs/cli.md).
