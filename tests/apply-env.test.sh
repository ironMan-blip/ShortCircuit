#!/bin/bash
# Tests scripts/apply-env.sh with stub docker and osascript (no containers touched).
# Run: bash tests/apply-env.test.sh
set -uo pipefail

SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fails=0

# --- stubs. The docker stub plays n8n by echoing state/.env.live as its environment.
mkdir -p "$T/bin"
cat >"$T/bin/osascript" <<'EOF'
#!/bin/bash
echo "${@: -1}" >>"$STUB_DIR/notify.log"
EOF
cat >"$T/bin/docker" <<'EOF'
#!/bin/bash
echo "$*" >>"$STUB_DIR/docker.log"
[ -f "$STUB_DIR/docker_down" ] && exit 1
case "$*" in
  info) ;;
  "compose ps -q --status running postgres") echo pg1 ;;
  "compose ps -a -q n8n" | "compose ps -q n8n") [ -f "$STUB_DIR/n8n_exists" ] && echo n8n1 ;;
  "inspect -f {{.State.Health.Status}} n8n1") echo healthy ;;
  "compose up -d --no-deps n8n") ;;
  "compose exec -T n8n env")
    if [ -f "$STUB_DIR/n8n_stale_env" ]; then echo "OWNER_EMAIL=old@example.com"; else cat "$ROOT/state/.env.live"; fi ;;
  "compose exec -T postgres psql"*)
    busy=$(cat "$STUB_DIR/busy_polls" 2>/dev/null || echo 0)
    if [ "$busy" -gt 0 ]; then
      echo $((busy - 1)) >"$STUB_DIR/busy_polls"
      # A save made while the run waits.
      [ -f "$STUB_DIR/save_during_wait" ] && { sed -i '' 's/^OWNER_EMAIL=.*/OWNER_EMAIL=during@example.com/' "$ROOT/.env"; rm "$STUB_DIR/save_during_wait"; }
      echo 1
    else
      echo 0
    fi ;;
  *) echo "stub docker: unexpected: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$T/bin/"*

setup() {  # fresh project dir with a valid .env
  R=$T/proj
  rm -rf "$R"
  mkdir -p "$R/scripts" "$R/stub"
  cp "$SRC/scripts/apply-env.sh" "$R/scripts/"
  sed -e 's/^N8N_ENCRYPTION_KEY=$/N8N_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef/' \
    -e 's/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=pgpass1/' \
    -e 's/^POSTGRES_APP_PASSWORD=$/POSTGRES_APP_PASSWORD=apppass1/' "$SRC/.env.example" >"$R/.env"
}
run() { PATH="$T/bin:$PATH" STUB_DIR="$R/stub" ROOT="$R" APPLY_ENV_POLL_S=0 "$@" bash "$R/scripts/apply-env.sh"; }
run_wait0() { PATH="$T/bin:$PATH" STUB_DIR="$R/stub" ROOT="$R" APPLY_ENV_POLL_S=0 APPLY_ENV_WAIT_MIN=0 bash "$R/scripts/apply-env.sh"; }
set_env() { sed -i '' "s|^$1=.*|$1=$2|" "$R/.env"; }
ok() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
notes() { cat "$R/stub/notify.log" 2>/dev/null | wc -l | tr -d ' '; }
live_has() { grep -Fxq "$1" "$R/state/.env.live"; }
applied() { [ "$(cat "$R/state/.env.applied.sha256" 2>/dev/null)" = "$(shasum -a 256 <"$R/.env" | cut -d' ' -f1)" ]; }

reject_case() {  # name, key, bad value
  setup; run; cp "$R/state/.env.live" "$R/live.before"; set_env "$2" "$3"; run
  ok "$1: one notification, n8n untouched" '[ "$(notes)" = 1 ] && cmp -s "$R/live.before" "$R/state/.env.live"'
  run
  ok "$1: no repeat notification" '[ "$(notes)" = 1 ] && ! grep -q "up -d" "$R/stub/docker.log" 2>/dev/null'
}

# 1. first install: live written with derived keys, no n8n container to recreate
setup; run
ok "install writes .env.live" 'live_has "OWNER_EMAIL=you@example.com" && live_has "GENERIC_TIMEZONE=Asia/Dhaka" && live_has "DB_POSTGRESDB_PASSWORD=pgpass1" && live_has "N8N_EDITOR_BASE_URL=https://your-mac.your-tailnet.ts.net/"'
ok "install saves applied hash" applied
ok "state/ is mode 700" '[ "$(stat -f %Lp "$R/state")" = 700 ]'
ok "no pending copy or lock left" '[ ! -e "$R/state/.env.pending" ] && [ ! -e "$R/state/.apply-env.lock" ]'

# 2. unchanged file: exits before touching docker
rm -f "$R/stub/docker.log"; run
ok "unchanged .env does nothing" '[ ! -f "$R/stub/docker.log" ]'

# 3. bad values: one notification each, live unchanged
reject_case "two owner addresses" OWNER_EMAIL "a@x.com,b@y.com"
reject_case "PUBLISH_MODE=Auto" PUBLISH_MODE Auto
reject_case "unknown provider in chain" LLM_CHAIN_WRITER "gemini,openai"
reject_case "gemini in editor chain" LLM_CHAIN_EDITOR "groq,gemini"
reject_case "gemini:model in cutter chain" LLM_CHAIN_CUTTER "gemini:gemini-2.5-flash"
reject_case "bad handle (no @)" CHANNEL_HANDLE "shortcircuittech"
reject_case "bad zone" TZ "../../etc/passwd"
reject_case "bad time" PUBLISH_TIME "25:00"
reject_case "quote in value" BOT_EMAIL '"bot@example.com"'
reject_case "changed encryption key" N8N_ENCRYPTION_KEY "ffffffffffffffffffffffffffffffffff"
reject_case "changed postgres password" POSTGRES_PASSWORD "other"

setup; run; echo "NODE_OPTIONS=--require=/data/x.js" >>"$R/.env"; run
ok "unknown key refused" '[ "$(notes)" = 1 ] && ! live_has "NODE_OPTIONS=--require=/data/x.js"'
setup; run; echo "GENERIC_TIMEZONE=UTC" >>"$R/.env"; run
ok "derived key in .env refused" '[ "$(notes)" = 1 ]'
setup; sed -i '' '/^BOT_EMAIL=/d' "$R/.env"; run
ok "missing key refused" '[ "$(notes)" = 1 ] && grep -q "BOT_EMAIL is missing" "$R/stub/notify.log"'
setup; run; sed -i '' 's/^OWNER_EMAIL=.*/OWNER_EMAIL=me@example.com\r/' "$R/.env"; run
ok "CRLF line refused" '[ "$(notes)" = 1 ]'
setup; run; set_env POSTGRES_APP_PASSWORD "s3cr3tvalue"; run
ok "notification never shows a value" '! grep -q s3cr3tvalue "$R/stub/notify.log"'

# 4. good change with n8n running: recreated, checked, applied
setup; run; touch "$R/stub/n8n_exists"; set_env OWNER_EMAIL new@example.com; run
ok "good change recreates n8n" 'grep -q "compose up -d --no-deps n8n" "$R/stub/docker.log" && live_has "OWNER_EMAIL=new@example.com" && applied'
# a save by rename (mv over the file) is just a new hash
cp "$R/.env" "$R/env.tmp"; sed -i '' 's/^OWNER_EMAIL=.*/OWNER_EMAIL=mv@example.com/' "$R/env.tmp"; mv "$R/env.tmp" "$R/.env"; run
ok "save by mv applied" 'live_has "OWNER_EMAIL=mv@example.com" && applied'

# 5. n8n comes back with the old values: roll back, one notification, rejected
setup; run; touch "$R/stub/n8n_exists" "$R/stub/n8n_stale_env"; set_env OWNER_EMAIL new@example.com; run
ok "failed reload rolls back" 'live_has "OWNER_EMAIL=you@example.com" && [ "$(grep -c "up -d --no-deps n8n" "$R/stub/docker.log")" = 2 ] && [ "$(notes)" = 1 ]'
run
ok "failed reload not retried every minute" '[ "$(notes)" = 1 ] && [ "$(grep -c "up -d --no-deps n8n" "$R/stub/docker.log")" = 2 ]'

# 6. waits for locked jobs; a save made during the wait is left for the next run
setup; run; touch "$R/stub/n8n_exists"; set_env OWNER_EMAIL first@example.com
echo 2 >"$R/stub/busy_polls"; touch "$R/stub/save_during_wait"; run
ok "waits, then applies the copy it checked" 'live_has "OWNER_EMAIL=first@example.com" && ! applied'
run
ok "next run applies the save made during the wait" 'live_has "OWNER_EMAIL=during@example.com" && applied'

# 7. still busy at the deadline: no hash saved, nothing changed
setup; run; touch "$R/stub/n8n_exists"; set_env OWNER_EMAIL late@example.com; echo 5 >"$R/stub/busy_polls"; run_wait0
ok "busy past the wait: nothing applied, no hash" '! live_has "OWNER_EMAIL=late@example.com" && ! applied && [ "$(notes)" = 0 ]'

# 8. docker down: no hash saved, retried later
setup; run; set_env OWNER_EMAIL d@example.com; touch "$R/stub/docker_down"; run
ok "docker down: nothing applied" '! live_has "OWNER_EMAIL=d@example.com" && ! applied'
rm "$R/stub/docker_down"; run
ok "docker back: applied" 'live_has "OWNER_EMAIL=d@example.com" && applied'

# 9. lock: a fresh one stops the run, one older than 2 h is removed
setup; run; set_env OWNER_EMAIL l@example.com; mkdir "$R/state/.apply-env.lock"; run
ok "fresh lock: run skipped" '! live_has "OWNER_EMAIL=l@example.com" && [ -d "$R/state/.apply-env.lock" ]'
touch -t 202001010000 "$R/state/.apply-env.lock"; run
ok "stale lock removed and run done" 'live_has "OWNER_EMAIL=l@example.com" && [ ! -e "$R/state/.apply-env.lock" ]'

echo
[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
