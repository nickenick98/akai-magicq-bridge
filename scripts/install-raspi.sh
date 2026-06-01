#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-akai}"
APP_DIR="${APP_DIR:-/bridge/akai-magicq-bridge}"
SERVICE_NAME="${SERVICE_NAME:-akai-magicq-bridge}"

if [[ ! -d "$APP_DIR" ]]; then
  echo "App directory not found: $APP_DIR" >&2
  echo "Clone the repo first, then run this script from anywhere." >&2
  exit 1
fi

echo "Installing system packages..."
sudo apt update
sudo apt install -y git curl ca-certificates build-essential python3 make g++ libasound2-dev alsa-utils

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 20 ]]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

echo "Preparing ownership and user groups..."
sudo mkdir -p "$(dirname "$APP_DIR")"
sudo chown -R "$APP_USER:$APP_USER" "$(dirname "$APP_DIR")"
sudo usermod -aG audio "$APP_USER"

echo "Installing npm dependencies and building web UI..."
cd "$APP_DIR"
npm install
npm run build

echo "Installing sudoers entry for network management..."
sudo cp systemd/akai-magicq-bridge-sudoers "/etc/sudoers.d/$SERVICE_NAME"
sudo chmod 440 "/etc/sudoers.d/$SERVICE_NAME"
sudo visudo -cf "/etc/sudoers.d/$SERVICE_NAME"

echo "Installing systemd service..."
sudo cp systemd/akai-magicq-bridge.service "/etc/systemd/system/$SERVICE_NAME.service"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo
echo "Done."
echo "Check status with:"
echo "  systemctl status $SERVICE_NAME"
echo "  journalctl -u $SERVICE_NAME -f"
echo
echo "Open the UI at:"
echo "  http://<raspi-ip>:3001"
