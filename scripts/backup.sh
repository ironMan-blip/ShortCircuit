#!/bin/bash
# Nightly backup (docs/PLAN.md §11): both databases, the workflows and the credentials
# (still encrypted with N8N_ENCRYPTION_KEY) into backups/<date>/; keeps 14 days.
# Restore: scripts/restore.sh backups/<date>
set -euo pipefail
DC=${COMPOSE:-docker compose}  # test hook: another compose project
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
day=$(date +%F); dir=backups/$day; mkdir -p "$dir"; chmod 700 backups
for db in n8n shortcircuit; do $DC exec -T postgres pg_dump -U postgres -Fc "$db" > "$dir/$db.dump"; done
tmp=$($DC exec -T n8n mktemp -d | tr -d '\r')
$DC exec -T n8n sh -c "n8n export:workflow --all --separate --output=$tmp/workflows/ && n8n export:credentials --all --output=$tmp/credentials.json" >/dev/null 2>&1
$DC cp "n8n:$tmp/." "$dir/" >/dev/null
$DC exec -T n8n rm -rf "$tmp"
find backups -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
echo "$(date '+%F %T') backup → $dir ($(du -sh "$dir" | cut -f1))"
