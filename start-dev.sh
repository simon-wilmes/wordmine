#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ensure_npm_deps() {
  local project_dir="$1"
  local label="$2"

  if [[ ! -f "$project_dir/package.json" ]]; then
    echo "[$label] No package.json found, skipping dependency check."
    return
  fi

  if [[ ! -d "$project_dir/node_modules" ]]; then
    echo "[$label] node_modules missing. Running npm install..."
    (cd "$project_dir" && npm install)
    return
  fi

  if ! (cd "$project_dir" && npm ls --depth=0 >/dev/null 2>&1); then
    echo "[$label] Dependency tree is out of sync. Running npm install..."
    (cd "$project_dir" && npm install)
  else
    echo "[$label] Dependencies look good."
  fi
}

set -a
source "$root_dir/.env"
set +a
export VITE_GAME_NAME="$GAME_NAME"

ensure_npm_deps "$root_dir/server" "server"
ensure_npm_deps "$root_dir/client" "client"

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
