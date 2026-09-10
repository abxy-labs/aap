#!/bin/bash
set -euo pipefail
# Runs every aap command in order against a fresh store.
# Usage: examples/lifecycle.sh [path/to/src/cli.ts]
CLI="$(cd "$(dirname "${1:-$(dirname "$0")/../src/cli.ts}")" && pwd)/$(basename "${1:-src/cli.ts}")"
WORK="${TMPDIR:-/tmp}/aap-lifecycle"
STORE="$WORK/.aap"
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"
A() { bun run "$CLI" --store "$STORE" "$@"; }
A init >/dev/null
A keygen --out operator.key.json >/dev/null; A keygen --out agent.key.json >/dev/null
A operator issue --id op_7a1d --key operator.key.json --vetting standard --session-handling "encrypted at rest" --asn AS14618 --out operator.cert >/dev/null
A agent issue --operator-cert operator.cert --operator-key operator.key.json --id ag_9c4e --name bill-pay-assistant --key agent.key.json --scopes accounts:read,transactions:read,payments:initiate --max-amount 500 --payees existing_only --out agent.cert >/dev/null
cat > bundle.json <<'EOF'
{ "bundle": "linking-v4", "presentation": "app",
  "documents": [
    { "id": "esign", "title": "Consent to electronic records", "url": "https://cdn.usefoil.com/d/esign.md", "format": "text/markdown", "sha256": "3f2a", "render": "full" },
    { "id": "privacy", "title": "Privacy notice", "url": "https://cdn.usefoil.com/d/privacy.pdf", "format": "application/pdf", "sha256": "9c17", "render": "link" } ],
  "acknowledgements": [
    { "id": "esign", "text": "I agree to receive these documents electronically" },
    { "id": "share", "text": "I authorize {agent} to access my accounts as described for {days} days" } ],
  "retain": "copy_required" }
EOF
A policy set --origin bank.example --tier transact --max-amount 200 --max-count 5 --disclosures bundle.json --evidence read=asserted,transact=observed --handoff payments:initiate --max-age-days 30 --disclose operator,agent | head -4
ETAG=$(A terms --agent-cert agent.cert --origin bank.example --scopes accounts:read,payments:initiate | python3 -c 'import json,sys; print(json.load(sys.stdin)["etag"])')
echo "etag=$ETAG"
cat > acceptance.json <<EOF
{ "terms": "$ETAG", "acknowledged": ["esign","share"], "viewed": ["esign","privacy"], "channel": "imessage", "accepted_at": "2026-09-10T18:00:00Z", "copies_sent_to": "email" }
EOF
A site session-record --id fs_2b81 --origin bank.example --human --known-device --age-s 240 >/dev/null
A delegation create --agent-cert agent.cert --operator-cert operator.cert --agent-key agent.key.json --origin bank.example --subject usr_41b --scopes accounts:read,payments:initiate --intent "Pay monthly bills" --acceptance acceptance.json --site-session fs_2b81 --out delegation.cert | python3 -c 'import json,sys; d=json.load(sys.stdin); print("delegation", d["delegation"], d["scopes"])'
A challenge --origin bank.example --out challenge.jwt >/dev/null
A challenge verify challenge.jwt | python3 -c 'import json,sys; print("challenge origin", json.load(sys.stdin)["origin"])'
A grant sign --agent-key agent.key.json --agent-cert agent.cert --delegation delegation.cert --session-ref sess_19c2 --intent "Pay September electric bill" --challenge challenge.jwt --out grant.jwt >/dev/null
A present --grant grant.jwt --delegation delegation.cert --agent-cert agent.cert --operator-cert operator.cert --out header.txt >/dev/null
echo "--- verify"; A verify --header-file header.txt --origin bank.example --session fs_9d02 --asn AS14618 | head -12
echo "--- use read scope"; A session use fs_9d02 --scope accounts:read | head -1
echo "--- use handoff scope"; A session use fs_9d02 --scope payments:initiate | head -1
echo "--- site completes handoff"; A site handoff-complete fs_9d02 --scope payments:initiate | python3 -c 'import json,sys; print("handoff now", json.load(sys.stdin)["agent"]["handoff"])'
echo "--- site reads session"; A site session fs_9d02 | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["decision"], d["agent"]["scopes_used"])'
echo "--- replay from another session"; A verify --header-file header.txt --origin bank.example --session fs_0000 --asn AS14618 | head -1 || true
DL=$(python3 -c "import json; print(json.load(open('$STORE/sessions/fs_9d02.json'))['delegation_id'])")
echo "--- revoke"; A delegation revoke "$DL" --by site | head -3
echo "--- directory"; A directory
echo "--- inspect"; A inspect grant.jwt | head -6
echo "--- help"; A grant sign --help
echo "--- unknown scope error"; A agent issue --operator-cert operator.cert --operator-key operator.key.json --id ag_x --key agent.key.json --scopes nope:read --out /dev/null || echo "exit $?"
