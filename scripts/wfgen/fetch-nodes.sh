#!/bin/bash
# Copies the node type descriptions out of the pinned n8n image, for validate.mjs and inspect.mjs.
set -euo pipefail
cd "$(dirname "$0")"
img=$(awk '/image: n8nio\/n8n:/ {print $2}' ../../docker-compose.yml)
mkdir -p .cache
p=/usr/local/lib/node_modules/n8n/node_modules
docker run --rm --entrypoint cat "$img" $p/n8n-nodes-base/dist/types/nodes.json > .cache/base-nodes.json
docker run --rm --entrypoint cat "$img" $p/@n8n/n8n-nodes-langchain/dist/types/nodes.json > .cache/lc-nodes.json
echo "node types of $img → .cache/"
