#!/bin/bash
# Applies a saved .env to n8n, safely (docs/PLAN.md §1, §11).
# Run by launchd on every save of .env and every 60 s; an unchanged file exits at once.
# Also run it once by hand at install, before the first `docker compose up -d`:
# it writes state/.env.live, the only env file the containers get.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
STATE=$ROOT/state
LOCK=$STATE/.apply-env.lock
PENDING=$STATE/.env.pending
LIVE=$STATE/.env.live
PREV=$STATE/.env.live.prev
APPLIED=$STATE/.env.applied.sha256
REJECTED=$STATE/.env.rejected.sha256
POLL_S=${APPLY_ENV_POLL_S:-60}      # test hook
WAIT_MIN=${APPLY_ENV_WAIT_MIN:-90}  # test hook

REQUIRED="OWNER_EMAIL CHANNEL_HANDLE BOT_EMAIL TZ PUBLISH_TIME SCHEDULE_CANDIDATES
PUBLISH_MODE BUFFER_TARGET REVIEW_HOURS WEBHOOK_URL GEMINI_MODEL GROQ_MODEL OLLAMA_MODEL
LLM_CHAIN_SCOUT LLM_CHAIN_WRITER LLM_CHAIN_CHECKER LLM_CHAIN_EDITOR LLM_CHAIN_DIRECTOR
LLM_CHAIN_CUTTER LLM_CHAIN_SCHEDULER MASTER_MODEL MASTER_EFFORT
N8N_ENCRYPTION_KEY POSTGRES_PASSWORD POSTGRES_APP_PASSWORD"
REQUIRED=$(echo $REQUIRED)  # one line, single spaces
# A reload cannot apply these: a new key makes every credential unreadable, and
# Postgres keeps the passwords it was created with. Changing them is a manual migration.
FROZEN="N8N_ENCRYPTION_KEY POSTGRES_PASSWORD POSTGRES_APP_PASSWORD"

RE_EMAIL='^[^@,;]+@[^@,;.]+(\.[^@,;.]+)+$'
RE_HANDLE='^@[A-Za-z0-9._-]{3,30}$'
RE_ITEM='(gemini|groq|ollama)(:[A-Za-z0-9._:/-]+)?'
RE_CHAIN="^$RE_ITEM(,$RE_ITEM)*\$"
RE_HHMM='([01][0-9]|2[0-3]):[0-5][0-9]'
RE_TIME="^$RE_HHMM\$"
RE_TIMES="^$RE_HHMM(,$RE_HHMM)*\$"
RE_ZONE='^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$'
RE_URL='^https://[A-Za-z0-9.-]+/$'

log() { echo "$(date '+%F %T') $*"; }
notify() {
  log "$*"
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "ShortCircuit"' \
    -e 'end run' "$*" >/dev/null 2>&1 || true
}

# Value of key $1 in env file $2 (keys are unique once check has passed).
get() { awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$2"; }

# Prints the first problem and fails. Never prints a value: some are secrets.
check() {
  local f=$1 n=0 line key val seen=" " k
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case $line in '' | '#'*) continue ;; esac
    if ! [[ $line =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then echo "line $n is not KEY=value"; return 1; fi
    key=${BASH_REMATCH[1]} val=${BASH_REMATCH[2]}
    case " $REQUIRED " in *" $key "*) ;; *) echo "line $n: unknown key $key"; return 1 ;; esac
    case $seen in *" $key "*) echo "line $n: $key is set twice"; return 1 ;; esac
    seen="$seen$key "
    [ -n "$val" ] || { echo "line $n: $key is empty"; return 1; }
    # Compose would read quotes, $ and \ in an env file differently from this check.
    if [[ $val == *[[:space:]\"\'\$\\\`]* ]]; then
      echo "line $n: $key holds a space, quote, \$, \\ or backtick"; return 1
    fi
    case $key in
      OWNER_EMAIL | BOT_EMAIL) [[ $val =~ $RE_EMAIL ]] || { echo "line $n: $key must be exactly one address"; return 1; } ;;
      CHANNEL_HANDLE) [[ $val =~ $RE_HANDLE ]] || { echo "line $n: CHANNEL_HANDLE must look like @handle (3-30 of A-Z a-z 0-9 . _ -)"; return 1; } ;;
      PUBLISH_MODE) [[ $val == manual || $val == auto ]] || { echo "line $n: PUBLISH_MODE must be manual or auto"; return 1; } ;;
      MASTER_EFFORT) [[ $val == low || $val == medium || $val == high ]] || { echo "line $n: MASTER_EFFORT must be low, medium or high"; return 1; } ;;
      LLM_CHAIN_*)
        [[ $val =~ $RE_CHAIN ]] || { echo "line $n: $key must be a comma list of gemini, groq, ollama (each optionally :model)"; return 1; }
        if [[ $key == LLM_CHAIN_EDITOR || $key == LLM_CHAIN_CUTTER ]] && [[ ,$val =~ ,gemini(,|:|$) ]]; then
          echo "line $n: $key may not name gemini (it carries owner notes)"; return 1
        fi ;;
      TZ) [[ $val =~ $RE_ZONE && -f /usr/share/zoneinfo/$val ]] || { echo "line $n: TZ is not a zoneinfo zone"; return 1; } ;;
      PUBLISH_TIME) [[ $val =~ $RE_TIME ]] || { echo "line $n: PUBLISH_TIME must be HH:MM"; return 1; } ;;
      SCHEDULE_CANDIDATES) [[ $val =~ $RE_TIMES ]] || { echo "line $n: SCHEDULE_CANDIDATES must be a comma list of HH:MM"; return 1; } ;;
      BUFFER_TARGET) [[ $val =~ ^[1-9][0-9]?$ ]] || { echo "line $n: BUFFER_TARGET must be a number 1-99"; return 1; } ;;
      REVIEW_HOURS) [[ $val =~ ^[1-9][0-9]?$ && $val -le 48 ]] || { echo "line $n: REVIEW_HOURS must be a number 1-48"; return 1; } ;;
      WEBHOOK_URL) [[ $val =~ $RE_URL ]] || { echo "line $n: WEBHOOK_URL must be https://host/ with the trailing /"; return 1; } ;;
      N8N_ENCRYPTION_KEY) [ ${#val} -ge 32 ] || { echo "line $n: N8N_ENCRYPTION_KEY must be at least 32 characters"; return 1; } ;;
    esac
  done <"$f"
  for k in $REQUIRED; do
    case $seen in *" $k "*) ;; *) echo "$k is missing"; return 1 ;; esac
  done
  if [ -f "$LIVE" ]; then
    for k in $FROZEN; do
      [ "$(get "$k" "$f")" = "$(get "$k" "$LIVE")" ] || { echo "$k cannot change on a save (manual migration, PLAN §1)"; return 1; }
    done
  fi
}

# Count of jobs a worker holds. No running Postgres = nothing can be locked.
locked_jobs() {
  [ -n "$(docker compose ps -q --status running postgres)" ] || { echo 0; return; }
  docker compose exec -T postgres psql -U postgres -d shortcircuit -tAc \
    "SELECT count(*) FROM jobs WHERE locked_at > now() - interval '90 minutes'"
}

# n8n is healthy and its environment holds every line of $1.
n8n_has() {
  local i id env
  for i in $(seq 36); do
    id=$(docker compose ps -q n8n)
    [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$id")" = healthy ] && break
    [ "$i" = 36 ] && return 1
    sleep 5
  done
  env=$(docker compose exec -T n8n env) || return 1
  grep -E '^[A-Z][A-Z0-9_]*=' "$1" | while IFS= read -r kv; do
    grep -Fxq -- "$kv" <<<"$env" || exit 1
  done
}

mkdir -p "$STATE"
chmod 700 "$STATE"
cd "$ROOT"

if ! mkdir "$LOCK" 2>/dev/null; then
  [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ] || exit 0  # another run is busy
  log "removing a lock older than 2 h (crashed run)"
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || exit 0
fi
trap 'rm -rf "$LOCK" "$PENDING"' EXIT

[ -f .env ] || exit 0
# From here on only the copy is used, so a save made during this run gets its own run.
cp .env "$PENDING"
chmod 600 "$PENDING"
hash=$(shasum -a 256 <"$PENDING" | cut -d' ' -f1)
[ "$hash" = "$(cat "$APPLIED" 2>/dev/null || true)" ] && exit 0
[ "$hash" = "$(cat "$REJECTED" 2>/dev/null || true)" ] && exit 0

if ! err=$(check "$PENDING"); then
  notify ".env not applied, n8n keeps the old values: $err"
  echo "$hash" >"$REJECTED"
  exit 0
fi

# Without Docker nothing can be checked or recreated; save no hash, so the next run retries.
docker info >/dev/null 2>&1 || { log "docker is not running; will retry"; exit 0; }

deadline=$(($(date +%s) + WAIT_MIN * 60))
until n=$(locked_jobs 2>/dev/null) && [ "$n" = 0 ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "jobs still locked after $WAIT_MIN min; the next run starts over"
    exit 0
  fi
  sleep "$POLL_S"
done

# n8n settings that follow from a .env value, so the owner writes each value once.
printf '\n# set by scripts/apply-env.sh\nGENERIC_TIMEZONE=%s\nN8N_EDITOR_BASE_URL=%s\nDB_POSTGRESDB_PASSWORD=%s\n' \
  "$(get TZ "$PENDING")" "$(get WEBHOOK_URL "$PENDING")" "$(get POSTGRES_PASSWORD "$PENDING")" >>"$PENDING"

[ -f "$LIVE" ] && cp -p "$LIVE" "$PREV"
mv "$PENDING" "$LIVE"

if [ -z "$(docker compose ps -a -q n8n)" ]; then
  echo "$hash" >"$APPLIED"
  log "wrote state/.env.live (no n8n container yet)"
  exit 0
fi

if docker compose up -d --no-deps n8n && n8n_has "$LIVE"; then
  echo "$hash" >"$APPLIED"
  log "applied: n8n recreated with the new values"
else
  [ -f "$PREV" ] && mv "$PREV" "$LIVE" && { docker compose up -d --no-deps n8n || true; }
  notify ".env not applied: n8n did not come back with the new values; old values restored"
  echo "$hash" >"$REJECTED"
fi
