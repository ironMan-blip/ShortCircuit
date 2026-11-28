#!/bin/bash
# Exports every sc.* workflow from the running n8n to workflows/sc.<name>.json, then checks them
# (docs/PLAN.md §10.3). Use it after editing a workflow in the n8n UI, before a commit.
# Note: scripts/wfgen builds the same files from code; after a UI edit, port it to wfgen too,
# or the next `node scripts/wfgen/build.mjs` overwrites it.
set -euo pipefail
DC=${COMPOSE:-docker compose}  # test hook: another compose project
cd "$(dirname "$0")/.."
SVC=${N8N_SERVICE:-n8n}
tmp=$($DC exec -T "$SVC" mktemp -d | tr -d '\r')
$DC exec -T "$SVC" n8n export:workflow --all --separate --pretty --output="$tmp/" >/dev/null 2>&1
out=$(mktemp -d); trap 'rm -rf "$out"; $DC exec -T "$SVC" rm -rf "$tmp" >/dev/null 2>&1 || true' EXIT
$DC cp "$SVC:$tmp/." "$out" >/dev/null
for f in "$out"/*.json; do
  name=$(jq -r .name "$f")
  case "$name" in sc.*) jq 'del(.updatedAt, .createdAt, .versionId, .activeVersionId, .shared, .triggerCount)' "$f" > "workflows/$name.json" ;; esac
done
node scripts/check-workflows.mjs
