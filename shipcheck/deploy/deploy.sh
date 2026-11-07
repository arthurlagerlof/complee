#!/usr/bin/env bash
# Deploy ShipCheck to one Linux server (e.g. Vultr) with Docker + Caddy.
# Usage (from anywhere):  bash shipcheck/deploy/deploy.sh
# Needs: deploy/deploy.env (copy deploy.env.example), ssh/scp access, Docker on the server (see README).
# Uploads the COMMITTED app (git archive of shipcheck/, so no local secrets or big files) and the model chunks.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SC="$(cd "$HERE/.." && pwd)"
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
[ -f "$SC/model/manifest.json" ] || { echo "Missing $SC/model/manifest.json (run tools/export first)"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git -C "$SC" archive --format=tar.gz -o "$TMP/app.tgz" HEAD:shipcheck 2>/dev/null || git -C "$SC" archive --format=tar.gz -o "$TMP/app.tgz" HEAD
tar -cf "$TMP/model.tar" -C "$SC" model
printf 'DOMAIN=%s\nALLOWED_ORIGINS=%s\n' "${DOMAIN:-}" "${ALLOWED_ORIGINS:-}" > "$TMP/server.env"
echo "Archive: app $(du -h "$TMP/app.tgz" | cut -f1), model $(du -h "$TMP/model.tar" | cut -f1)"

ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p '$REMOTE_DIR'"
scp "${SSH_OPTS[@]}" "$TMP/app.tgz" "$TMP/model.tar" "$TMP/server.env" "$TARGET:$REMOTE_DIR/"
ssh "${SSH_OPTS[@]}" "$TARGET" "set -e; cd '$REMOTE_DIR' \
  && tar -xzf app.tgz && rm -rf model && tar -xf model.tar && mv server.env deploy/server.env && rm -f app.tgz model.tar \
  && docker compose --env-file deploy/server.env -f deploy/docker-compose.yml up -d --build \
  && sleep 5 && curl -fsS http://127.0.0.1/api/health || curl -fsS -H 'Host: ${DOMAIN:-localhost}' http://127.0.0.1/api/health"
echo
echo "Deployed. Check: curl -s http://${DOMAIN:-$SERVER_HOST}/api/health"
