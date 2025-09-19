#!/usr/bin/env bash
set -euo pipefail

echo "== Versions =="
node -v || true
npm -v || true
yt-dlp --version || true
ffmpeg -version | head -n1 || true

echo
echo "== Env (selected) =="
echo "APP_MODE=${APP_MODE:-}"
echo "LOG_LEVEL=${LOG_LEVEL:-}"
echo "GEO_BYPASS_COUNTRY=${GEO_BYPASS_COUNTRY:-}"

echo
echo "== Recent logs (container) =="
echo "(Use platform tools to fetch deploy logs)"

