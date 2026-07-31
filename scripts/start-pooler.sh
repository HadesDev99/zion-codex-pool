#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if lsof -nP -iTCP:4000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "already listening on :4000"
  curl -fsS http://127.0.0.1:4000/health
  echo
  exit 0
fi
npm run build >/dev/null
mkdir -p .data
nohup npm run start >> .data/pooler.log 2>&1 &
disown || true
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4000/health >/dev/null 2>&1; then
    curl -fsS http://127.0.0.1:4000/health
    echo
    exit 0
  fi
  sleep 0.25
done
echo "failed to start" >&2
tail -50 .data/pooler.log >&2 || true
exit 1
