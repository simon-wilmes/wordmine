#!/usr/bin/env bash
# Deploy script for codename-competition on Raspberry Pi
# Usage: scp this entire project to the Pi, then run: sudo bash deploy-pi.sh
set -euo pipefail

# --- Configuration ---
APP_NAME="codename-competition"
APP_DIR="/opt/$APP_NAME"
APP_USER="codename"
APP_USER_HOME="/home/$APP_USER"
NODE_VERSION="20"
PORT=3001

# --- Must run as root ---
if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo bash $0"
  exit 1
fi

echo "=== Installing system dependencies ==="
apt-get update
apt-get install -y curl git

# --- Install Node.js via NodeSource if not present or wrong version ---
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_VERSION" ]]; then
  echo "=== Installing Node.js $NODE_VERSION ==="
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y nodejs
else
  echo "=== Node.js $(node -v) already installed ==="
fi

echo "Node: $(node -v)  npm: $(npm -v)"

# --- Install Claude Code CLI if missing ---
if ! command -v claude &>/dev/null; then
  echo "=== Installing Claude Code CLI ==="
  npm install -g @anthropic-ai/claude-code
else
  echo "=== Claude Code CLI already installed ==="
fi

if ! command -v claude &>/dev/null; then
  echo "ERROR: Claude Code CLI installation failed (command 'claude' not found)."
  exit 1
fi

# --- Create app user (with home directory for Claude credentials) ---
if ! id "$APP_USER" &>/dev/null; then
  echo "=== Creating user $APP_USER ==="
  useradd --system --create-home --home-dir "$APP_USER_HOME" --shell /bin/bash "$APP_USER"
fi

if [[ ! -d "$APP_USER_HOME" ]]; then
  mkdir -p "$APP_USER_HOME"
  chown "$APP_USER":"$APP_USER" "$APP_USER_HOME"
fi

# --- Copy project files ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Copying project to $APP_DIR ==="
mkdir -p "$APP_DIR"
rsync -a --exclude='node_modules' --exclude='.git' "$SCRIPT_DIR/" "$APP_DIR/"

# --- Create .env if missing ---
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "GAME_NAME=wordmine" > "$APP_DIR/.env"
fi

# --- Install dependencies & build client ---
echo "=== Installing server dependencies ==="
cd "$APP_DIR/server"
npm ci --omit=dev

echo "=== Installing client dependencies ==="
cd "$APP_DIR/client"
npm ci

echo "=== Building client ==="
export VITE_GAME_NAME="$(grep '^GAME_NAME=' "$APP_DIR/.env" | cut -d= -f2)"
npm run build

# Remove client node_modules after build (not needed at runtime)
rm -rf "$APP_DIR/client/node_modules"

# --- Fix ownership ---
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# --- Verify Claude login for runtime user ---
echo "=== Checking Claude login for user $APP_USER ==="
if ! sudo -u "$APP_USER" -H bash -lc "claude auth status" >/dev/null 2>&1; then
  echo ""
  echo "ERROR: Claude Code is not logged in for user '$APP_USER'."
  echo "Run the following command on the Pi, complete login, then rerun this deploy script:"
  echo "  sudo -u $APP_USER -H claude auth login"
  echo ""
  exit 1
fi

# --- Create systemd service ---
echo "=== Creating systemd service ==="
cat > /etc/systemd/system/${APP_NAME}.service <<EOF
[Unit]
Description=Codename Competition Game Server
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR/server
EnvironmentFile=$APP_DIR/.env
Environment=PORT=$PORT
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5

# Hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# --- Enable and start ---
echo "=== Enabling and starting service ==="
systemctl daemon-reload
systemctl enable "$APP_NAME"
systemctl restart "$APP_NAME"

# --- Verify ---
sleep 2
if systemctl is-active --quiet "$APP_NAME"; then
  echo ""
  echo "=== SUCCESS ==="
  echo "Service is running on port $PORT"
  echo ""
  echo "Useful commands:"
  echo "  systemctl status $APP_NAME    # check status"
  echo "  journalctl -u $APP_NAME -f    # follow logs"
  echo "  systemctl restart $APP_NAME   # restart"
  echo ""
  echo "Point your Cloudflare tunnel to http://localhost:$PORT"
else
  echo ""
  echo "=== FAILED ==="
  echo "Service did not start. Check logs:"
  echo "  journalctl -u $APP_NAME -e"
  exit 1
fi
