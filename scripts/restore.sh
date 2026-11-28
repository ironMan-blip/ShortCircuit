#!/bin/bash
# Restores a backup made by scripts/backup.sh (docs/PLAN.md §11, tested at M10).
# Needs the same N8N_ENCRYPTION_KEY as when the backup was made. Stops n8n while it runs.
# usage: bash scripts/restore.sh backups/<date>
set -euo pipefail
DC=${COMPOSE:-docker compose}  # test hook: another compose project
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
dir=${1:?usage: restore.sh backups/<date>}
[ -f "$dir/n8n.dump" ] && [ -f "$dir/shortcircuit.dump" ] || { echo "no dumps in $dir"; exit 1; }
read -r -p "This replaces the n8n and shortcircuit databases with $dir. Type yes: " ok; [ "$ok" = yes ] || exit 1
$DC stop n8n
for db in n8n shortcircuit; do $DC exec -T postgres pg_restore -U postgres --clean --if-exists -d "$db" < "$dir/$db.dump"; done
$DC up -d n8n
echo "restored $dir; workflows and credentials came back with the n8n database (the JSON copies in $dir are for git or a fresh install)"
