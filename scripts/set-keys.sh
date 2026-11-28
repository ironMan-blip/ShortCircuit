#!/bin/bash
# Puts the owner's keys into the n8n credentials (and Pexels into renderer.env) from hidden prompts,
# so no secret is typed into a chat, a file or the terminal history. Enter skips a key; fields
# already in n8n are kept (merged, so an OAuth token from Connect survives a re-run).
# Run after the n8n owner account exists and scripts/import-workflows.sh made the credentials.
# usage: bash scripts/set-keys.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DC="docker compose"
tmp=$($DC exec -T n8n mktemp -d | tr -d '\r')
trap '$DC exec -T n8n rm -rf "$tmp" >/dev/null 2>&1 || true' EXIT

ask() { local v; read -rsp "  $1 (Enter skips): " v </dev/tty; echo >&2; printf '%s' "$v"; }
env_value() { awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2) }' "$2"; }

# set_cred ID JSON: merges JSON into the credential's data and imports it back.
set_cred() {
  local id="$1" patch="$2" cur
  cur=$($DC exec -T n8n sh -c "n8n export:credentials --id='$id' --decrypted --output='$tmp/c.json' >/dev/null 2>&1 && cat '$tmp/c.json'") \
    || { echo "  ! credential $id not found: run bash scripts/import-workflows.sh first"; return 1; }
  jq --argjson p "$patch" '(if type == "array" then . else [.] end) | map(.data = ((.data // {}) + $p))' <<<"$cur" \
    | $DC exec -T n8n sh -c "cat > '$tmp/c.json'"
  $DC exec -T n8n n8n import:credentials --input="$tmp/c.json" >/dev/null 2>&1 \
    && echo "  ✓ $(jq -r 'if type == "array" then .[0].name else .name end' <<<"$cur") saved" \
    || { echo "  ! import of $id failed"; return 1; }
}

echo "Google OAuth client (Web application) for Gmail Bot, Drive Bot and YouTube Channel:"
cid=$(ask "Client ID"); csec=$(ask "Client secret")
if [[ -n "$cid" && -n "$csec" ]]; then
  p=$(jq -n --arg i "$cid" --arg s "$csec" '{clientId: $i, clientSecret: $s}')
  for id in scCredGmailBot01 scCredDriveBot01 scCredYouTube001; do set_cred "$id" "$p"; done
fi

k=$(ask "Gemini API key"); [[ -n "$k" ]] && set_cred scCredGemini0001 "$(jq -n --arg k "$k" '{apiKey: $k}')"
k=$(ask "Groq API key");   [[ -n "$k" ]] && set_cred scCredGroq000001 "$(jq -n --arg k "$k" '{apiKey: $k}')"

# Postgres app password comes from .env; nothing to type.
set_cred scCredPostgres01 "$(jq -n --arg p "$(env_value POSTGRES_APP_PASSWORD .env)" '{password: $p}')"

k=$(ask "Pexels API key")
if [[ -n "$k" ]]; then
  [[ "$k" =~ ^[A-Za-z0-9]+$ ]] || { echo "  ! Pexels key not saved: letters and digits only"; exit 1; }
  sed -i '' "s|^PEXELS_API_KEY=.*|PEXELS_API_KEY=$k|" renderer.env
  $DC up -d renderer >/dev/null 2>&1 && echo "  ✓ Pexels key saved, renderer restarted"
fi

echo "Next in n8n → Credentials: open Gmail Bot, Drive Bot (sign in as the bot) and YouTube Channel"
echo "(sign in as the channel owner) and click 'Sign in with Google' / Connect. SC Cancel Form: set by hand."
