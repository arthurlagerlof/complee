#!/usr/bin/env bash
# Deploy ShipCheck to one Linux server (e.g. Vultr) with Docker + Caddy.
# Usage (from anywhere):  bash shipcheck/deploy/deploy.sh
# Needs: deploy/deploy.env (copy deploy.env.example), ssh/scp access, Docker on the server (see README).
# Uploads the COMMITTED app (git archive of shipcheck/, so no local secrets or big files) and the model chunks.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SC="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(git -C "$SC" rev-parse --show-toplevel)"
ENV_FILE="$HERE/deploy.env"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (copy deploy.env.example and fill it in)"; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${SERVER_HOST:?SERVER_HOST is empty in deploy.env}"
: "${SERVER_USER:?SERVER_USER is empty in deploy.env}"
REMOTE_DIR="${REMOTE_DIR:-/opt/shipcheck}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[ -n "${SSH_KEY:-}" ] && SSH_OPTS+=(-i "$SSH_KEY")
TARGET="$SERVER_USER@$SERVER_HOST"

if [ -n "$(git -C "$SC" status --porcelain -- . | grep -v '^??' || true)" ]; then
  echo "Note: uncommitted changes in shipcheck/ are NOT deployed (the archive uses the last commit)."
fi
if [ "${MODEL_SOURCE:-}" = "vultr" ]; then
  for v in VULTR_S3_ENDPOINT VULTR_S3_BUCKET VULTR_S3_ACCESS_KEY VULTR_S3_SECRET_KEY; do
    [ -n "${!v:-}" ] || { echo "MODEL_SOURCE=vultr needs $v in deploy.env"; exit 1; }
  done
else
  [ -f "$SC/model/manifest.json" ] || { echo "Missing $SC/model/manifest.json (run tools/export first)"; exit 1; }
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git -C "$REPO_ROOT" archive --format=tar.gz -o "$TMP/app.tgz" HEAD:shipcheck
tar -tzf "$TMP/app.tgz" > "$TMP/app-files.txt"
grep -qx 'server.mjs' "$TMP/app-files.txt" && grep -qx 'deploy/docker-compose.yml' "$TMP/app-files.txt" || { echo "The ShipCheck archive is incomplete; refusing to deploy."; exit 1; }
if grep -Eq '(^|/)(\.env(\..*)?|deploy\.env)$' "$TMP/app-files.txt"; then echo "The app archive contains a forbidden environment file; refusing to deploy."; exit 1; fi
# diagnostic audit reports (hundreds of MB) are not served: left out of the upload
if [ "${MODEL_SOURCE:-}" = "vultr" ]; then
  # model tiles are streamed from the bucket: upload an empty model/ folder
  mkdir -p "$TMP/empty/model" && tar -cf "$TMP/model.tar" -C "$TMP/empty" model
else
  tar -cf "$TMP/model.tar" --exclude=model/source-coverage.json --exclude=model/tile-integrity.json -C "$SC" model
fi
printf 'DOMAIN=%s\nALLOWED_ORIGINS=%s\nCADDY_BIND_ADDRESS=%s\nTRUST_CLOUDFLARE_TUNNEL=%s\nSHIPCHECK_DATA_API_URL=%s\nREGULATION_API_URL=%s\nMODEL_SOURCE=%s\nVULTR_S3_ENDPOINT=%s\nVULTR_S3_BUCKET=%s\nVULTR_S3_ACCESS_KEY=%s\nVULTR_S3_SECRET_KEY=%s\nVULTR_S3_REGION=%s\n' \
  "${DOMAIN:-}" "${ALLOWED_ORIGINS:-}" "${CADDY_BIND_ADDRESS:-}" "${TRUST_CLOUDFLARE_TUNNEL:-false}" "${SHIPCHECK_DATA_API_URL:-}" "${REGULATION_API_URL:-}" "${MODEL_SOURCE:-local}" "${VULTR_S3_ENDPOINT:-}" "${VULTR_S3_BUCKET:-}" \
  "${VULTR_S3_ACCESS_KEY:-}" "${VULTR_S3_SECRET_KEY:-}" "${VULTR_S3_REGION:-}" > "$TMP/server.env"
# model/ = the 6 main chunks, the rest sub-chunks (rest-NN.glb, Full model), manifest.json and props/ (rest part data)
[ "${MODEL_SOURCE:-}" = "vultr" ] && echo "Model: streamed from bucket ${VULTR_S3_BUCKET} (not uploaded)" || echo "Model: $(ls "$SC"/model/*.glb | wc -l | tr -d ' ') chunk files ($(ls "$SC"/model/rest-*.glb 2>/dev/null | wc -l | tr -d ' ') rest sub-chunks), $(ls "$SC"/model/props 2>/dev/null | wc -l | tr -d ' ') property files"
echo "Archive: app $(du -h "$TMP/app.tgz" | cut -f1), model $(du -h "$TMP/model.tar" | cut -f1)"
echo "Total upload: $(( ( $(wc -c < "$TMP/app.tgz") + $(wc -c < "$TMP/model.tar") ) / 1000000 )) MB"

ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p '$REMOTE_DIR'"
scp "${SSH_OPTS[@]}" "$TMP/app.tgz" "$TMP/model.tar" "$TMP/server.env" "$TARGET:$REMOTE_DIR/"
MODEL_PREP='rm -rf model'
[ "${MODEL_SOURCE:-}" = "vultr" ] && MODEL_PREP=true
ssh "${SSH_OPTS[@]}" "$TARGET" "set -e; cd '$REMOTE_DIR' \
  && chmod 600 server.env && tar -xzf app.tgz && $MODEL_PREP && tar -xf model.tar && mv server.env deploy/server.env && rm -f app.tgz model.tar \
  && docker compose --env-file deploy/server.env -f deploy/docker-compose.yml up -d --build \
  && sleep 5 && curl -fsS http://127.0.0.1/api/health || curl -fsS -H 'Host: ${DOMAIN:-localhost}' http://127.0.0.1/api/health"
echo
CHECK_SCHEME=https
[ -n "${DOMAIN:-}" ] || CHECK_SCHEME=http
echo "Deployed. Check: curl -s ${CHECK_SCHEME}://${DOMAIN:-$SERVER_HOST}/api/health"
