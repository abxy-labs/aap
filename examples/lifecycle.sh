#!/bin/bash
# Complete isolated SDK lifecycle: consent, browser connect, customer action, revocation.
# The product-page audit separately executes every displayed CLI command.
set -euo pipefail
AAP_EXAMPLE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bun run "$AAP_EXAMPLE_ROOT/src/cli.ts" demo "$@"
