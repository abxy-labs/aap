#!/bin/bash
# Every aap command in order: starts a reference API, onboards an operator and a site,
# and walks a delegation, a session, a handoff, a replay, and a revocation.
# Usage: examples/lifecycle.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/src/cli.ts"
WORK="${TMPDIR:-/tmp}/aap-lifecycle"
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"
export AAP_CONFIG_DIR="$WORK/config"
PORT=$((20000 + RANDOM % 20000))

bun run "$CLI" serve --port "$PORT" --store "$WORK/.aap" >"$WORK/serve.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done

op() { bun run "$CLI" --profile operator "$@"; }
site() { bun run "$CLI" --profile site "$@"; }
field() { PATH_EXPR="$1" python3 -c "import json,sys,os; d=json.load(sys.stdin); v=eval('d'+os.environ['PATH_EXPR']); print(json.dumps(v) if isinstance(v,(dict,list)) else v)"; }

echo "--- onboard"
op accounts create --type operator --name "Example Browser Co" --asn AS14618 --api-base "http://127.0.0.1:$PORT" | field "['operator']['id']"
site accounts create --type site --name "Example Bank" --api-base "http://127.0.0.1:$PORT" | field "['account']['id']"

echo "--- agent"
AGENT=$(op agents create --name bill-pay-assistant --scopes accounts:read,transactions:read,payments:initiate --currency usd --max-amount 50000 --payees existing_only | field "['id']")
echo "$AGENT"

echo "--- policy"
cat > bundle.json <<'JSON'
{ "bundle": "linking-v4", "presentation": "app",
  "documents": [
    { "id": "esign", "title": "Consent to electronic records", "url": "https://cdn.usefoil.com/d/esign.md", "format": "text/markdown", "sha256": "3f2a", "render": "full" },
    { "id": "privacy", "title": "Privacy notice", "url": "https://cdn.usefoil.com/d/privacy.pdf", "format": "application/pdf", "sha256": "9c17", "render": "link" } ],
  "acknowledgements": [
    { "id": "esign", "text": "I agree to receive these documents electronically" },
    { "id": "share", "text": "I authorize {agent} to access my accounts as described for {days} days" } ],
  "retain": "copy_required" }
JSON
site policies create --origin bank.example --tier transact --currency usd --max-amount 20000 --max-count 5 \
  --disclosures @bundle.json --evidence read=asserted,transact=observed \
  --handoff "scope=payments:initiate,mode=approve,url=https://bank.example/agent/confirm?aap_handoff={id}" \
  --max-age-days 30 --disclose operator,agent | field "['version']"

echo "--- terms"
TERMS=$(op terms create --agent "$AGENT" --origin bank.example --scopes accounts:read,payments:initiate | field "['id']")
echo "$TERMS"

echo "--- delegation"
LIVE=$(site test sessions create --origin bank.example --known-device --age 240 | field "['id']")
cat > acceptance.json <<JSON
{ "terms": "$TERMS", "acknowledged": ["esign","share"], "viewed": ["esign","privacy"], "channel": "imessage", "accepted_at": "2026-09-15T18:00:00Z", "copies_sent_to": "email" }
JSON
DL=$(op delegations create --agent "$AGENT" --origin bank.example --subject usr_41b --terms "$TERMS" --intent "Pay monthly bills" --acceptance @acceptance.json --site-session "$LIVE" | field "['id']")
echo "$DL"
op verify-chain --delegation "$DL" | field "['verified']"

echo "--- session"
op test challenges create --origin bank.example --out challenge.jwt >/dev/null
op challenges verify challenge.jwt | field "['origin']"
op grants sign --delegation "$DL" --challenge challenge.jwt --session-ref sess_19c2 --intent "Pay September electric bill" --out grant.jwt >/dev/null
op present --grant grant.jwt --delegation "$DL" --out header.txt >/dev/null
SESSION=$(op test presentations create --origin bank.example --header-file header.txt --asn AS14618 | field "['id']")
site sessions retrieve "$SESSION" | field "['status']"
op test sessions use "$SESSION" --scope accounts:read | field "['agent']['scopes_used']"

echo "--- handoff"
HO=$(op handoffs create --session "$SESSION" --scope payments:initiate --context.amount 14210 --context.currency usd --context.payee "Pacific Power" | field "['id']")
op handoffs retrieve "$HO" | field "['display']['message']"
site sessions retrieve "$SESSION" | field "['next_action']"
op handoffs wait "$HO" --timeout 20s --interval 200ms >"$WORK/wait.json" &
WAITER=$!
sleep 0.5
site test handoffs link "$HO" >/dev/null
site handoffs complete "$HO" --result.confirmed true | field "['status']"
wait $WAITER
field "['status']" <"$WORK/wait.json"
site sessions retrieve "$SESSION" --expand delegation | field "['agent']['approvals'][0]['scope']"

echo "--- replay and revoke"
op test presentations create --origin bank.example --header-file header.txt --asn AS14618 --session sess_replay | field "['status_header']" || true
site delegations revoke "$DL" | field "['status']"
op delegations list --status revoked | field "['data'][0]['id']"

echo "--- events, webhooks, directory"
site events list --limit 3 | field "['data'][0]['type']"
site trigger handoff.completed | field "['type']"
op directory list | field "['data'][0]['hash'][:16]"
site whoami | field "['type']"
echo "ok"
