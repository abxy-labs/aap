# Agent Admission Protocol

The Agent Admission Protocol (AAP) lets an automated agent identify itself to Foil, lets a site state which agents it admits and what those agents may do, and lets a consumer authorize an agent to act for them at a site. Sites that run Foil block automated traffic by default. The protocol adds a third category between human and bot, the agent plane, so that a site can admit the automation it has chosen to admit without loosening detection for anything else.

Three properties hold throughout. Foil never presents an interface to a consumer. Nothing is added to any request to a site. A site that has not opted in learns nothing.

## Contents

- [docs/spec.md](docs/spec.md): the protocol specification, written for sites, operators, and agent applications. It covers the concepts, the trust chain, the lifecycle, per-role guides, the reference for scopes, endpoints, headers, and claims, and security considerations.

## Status

This is a draft. Endpoint names, header names, and claim shapes are subject to change before release.
