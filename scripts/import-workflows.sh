#!/bin/bash
# Imports workflows/ into the running n8n and publishes them (docs/PLAN.md §10.3).
# Credentials that do not exist yet are made from workflows/credentials.stub.json (fixed ids,
# empty secrets), so every node finds its credential; fill each one in the n8n UI once.
# An existing credential is never overwritten.
# usage: bash scripts/import-workflows.sh [--no-publish]
set -euo pipefail
DC=${COMPOSE:-docker compose}  # test hook: another compose project
cd "$(dirname "$0")/.."
SVC=${N8N_SERVICE:-n8n}
n8n() { $DC exec -T "$SVC" n8n "$@" </dev/null 2>&1 | grep -v -E "license SDK|Postgres 16|migration lock|Task Broker" || true; }
node scripts/check-workflows.mjs
tmp=$($DC exec -T "$SVC" mktemp -d | tr -d '\r')
trap '$DC exec -T "$SVC" rm -rf "$tmp" >/dev/null 2>&1 || true' EXIT

# credentials: only the missing ones
missing=$(jq -c '.[]' workflows/credentials.stub.json | while read -r c; do
  id=$(jq -r .id <<<"$c")
  if ! $DC exec -T "$SVC" n8n export:credentials --id="$id" --output=/tmp/sc-cred-probe.json </dev/null >/dev/null 2>&1; then echo "$c"; fi
done | jq -s .)
if [ "$(jq length <<<"$missing")" -gt 0 ]; then
  jq '.' <<<"$missing" | $DC exec -T "$SVC" sh -c "cat > $tmp/creds.json"
  n8n import:credentials --input="$tmp/creds.json"
  echo "new credentials (fill them in the n8n UI): $(jq -r 'map(.name) | join(", ")' <<<"$missing")"
fi
$DC exec -T "$SVC" rm -f /tmp/sc-cred-probe.json

# workflows
for f in workflows/sc.*.json; do $DC cp "$f" "$SVC:$tmp/$(basename "$f")" >/dev/null; done
n8n import:workflow --separate --input="$tmp"
[ "${1:-}" = "--no-publish" ] && exit 0

# publish in dependency order: a workflow that calls an unpublished one is retried next round
todo=$(for f in workflows/sc.*.json; do
  jq -e '[.nodes[].type] | any(test("Trigger$|scheduleTrigger|formTrigger|n8nTrigger") and (test("manualTrigger|evaluationTrigger") | not))' "$f" >/dev/null && jq -r '.id + " " + .name' "$f"
done)
while [ -n "$todo" ]; do
  left=""
  while read -r id name; do
    out=$(n8n publish:workflow --id="$id")
    if grep -q -E "Cannot publish|failed" <<<"$out"; then left+="$id $name"$'\n'; fi
  done <<<"$todo"
  left=$(sed '/^$/d' <<<"$left")
  # a publish reaches the running n8n a moment later: allow a few rounds without progress
  if [ "$left" = "$todo" ]; then stuck=$((${stuck:-0} + 1)); else stuck=0; fi
  if [ "$stuck" -ge 5 ]; then echo "could not publish:"; echo "$left"; exit 1; fi
  todo=$left; [ -n "$todo" ] && sleep 3
done
echo "workflows imported and published"
