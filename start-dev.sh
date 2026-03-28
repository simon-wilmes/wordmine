#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

set -a
source "$root_dir/.env"
set +a
export VITE_GAME_NAME="$GAME_NAME"

cleanup() {
  if [[ -n "${server_pid:-}" ]]; then
    kill "$server_pid" 2>/dev/null || true
  fi
  if [[ -n "${client_pid:-}" ]]; then
    kill "$client_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

( cd "$root_dir/server" && npm run dev ) &
server_pid=$!

( cd "$root_dir/client" && npm run dev ) &
client_pid=$!

wait "$server_pid" "$client_pid"
