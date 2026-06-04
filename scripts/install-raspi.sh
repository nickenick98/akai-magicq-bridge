#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-akai}"
SERVICE_NAME="${SERVICE_NAME:-akai-magicq-bridge}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Please run this script as the app user, not as root." >&2
  echo "Example: ./scripts/install-raspi.sh" >&2
  exit 1
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "User does not exist: $APP_USER" >&2
  echo "Create the user in Raspberry Pi Imager or run with APP_USER=<your-user>." >&2
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "App directory not found: $APP_DIR" >&2
  echo "Clone the repo first, then run this script from anywhere." >&2
  exit 1
fi

echo "Installing system packages..."
sudo apt update
sudo apt install -y git curl ca-certificates build-essential python3 make g++ pkg-config libasound2-dev alsa-utils network-manager

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 20 ]]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

echo "Ensuring NetworkManager is enabled..."
sudo systemctl enable --now NetworkManager >/dev/null 2>&1 || true

echo "Preparing ownership and user groups..."
sudo mkdir -p "$(dirname "$APP_DIR")"
sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo usermod -aG audio "$APP_USER"

echo "Installing npm dependencies and building web UI..."
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run build

echo "Installing sudoers entry for network management..."
sudo sed "s/^akai /$APP_USER /" systemd/akai-magicq-bridge-sudoers | sudo tee "/etc/sudoers.d/$SERVICE_NAME" >/dev/null
sudo chmod 440 "/etc/sudoers.d/$SERVICE_NAME"
sudo visudo -cf "/etc/sudoers.d/$SERVICE_NAME"

echo "Installing systemd service..."
tmp_service="$(mktemp)"
sed \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
  -e "s|^User=.*|User=$APP_USER|" \
  systemd/akai-magicq-bridge.service > "$tmp_service"
sudo cp "$tmp_service" "/etc/systemd/system/$SERVICE_NAME.service"
rm -f "$tmp_service"
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
echo "  http://<raspi-ip>/"
echo "  http://192.168.50.10/  # when the backup IP is active"
echo
echo "A reboot is recommended so the audio group membership is active for SSH sessions:"
echo "  sudo reboot"
