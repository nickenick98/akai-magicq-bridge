#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-akai-magicq-bridge}"
FAST_SERVICE="${FAST_SERVICE:-1}"
DISABLE_BLUETOOTH="${DISABLE_BLUETOOTH:-1}"
DISABLE_WIFI="${DISABLE_WIFI:-0}"
PERMANENT_DISABLE_WIFI="${PERMANENT_DISABLE_WIFI:-0}"
DISABLE_AVAHI="${DISABLE_AVAHI:-1}"
DISABLE_TRIGGERHAPPY="${DISABLE_TRIGGERHAPPY:-1}"
DISABLE_MODEM="${DISABLE_MODEM:-1}"
DISABLE_APT_TIMERS="${DISABLE_APT_TIMERS:-0}"
LIMIT_JOURNAL="${LIMIT_JOURNAL:-1}"
RESTORE_NETWORK="${RESTORE_NETWORK:-0}"

if [[ "${1:-}" == "--restore-network" ]]; then
  RESTORE_NETWORK=1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script is intended for Raspberry Pi OS/Linux." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

unit_exists() {
  systemctl list-unit-files "$1" --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$1"
}

disable_unit() {
  local unit="$1"
  if unit_exists "$unit"; then
    echo "Disabling $unit..."
    "${SUDO[@]}" systemctl disable --now "$unit" >/dev/null 2>&1 || true
  fi
}

mask_unit() {
  local unit="$1"
  if unit_exists "$unit"; then
    echo "Masking $unit..."
    "${SUDO[@]}" systemctl mask "$unit" >/dev/null 2>&1 || true
  fi
}

boot_config_path() {
  if [[ -f /boot/firmware/config.txt ]]; then
    echo /boot/firmware/config.txt
  elif [[ -f /boot/config.txt ]]; then
    echo /boot/config.txt
  else
    echo ""
  fi
}

append_boot_overlay() {
  local overlay="$1"
  local config_path
  config_path="$(boot_config_path)"
  if [[ -z "$config_path" ]]; then
    echo "Boot config not found; cannot add $overlay." >&2
    return
  fi

  if ! grep -Eq "^[[:space:]]*${overlay}([[:space:]]|$)" "$config_path"; then
    echo "Adding $overlay to $config_path..."
    printf '\n# AKAI MagicQ Bridge optimization\n%s\n' "$overlay" | "${SUDO[@]}" tee -a "$config_path" >/dev/null
  fi
}

remove_boot_overlay() {
  local overlay="$1"
  local config_path
  config_path="$(boot_config_path)"
  if [[ -z "$config_path" ]]; then
    echo "Boot config not found; cannot remove $overlay." >&2
    return
  fi

  if grep -Eq "^[[:space:]]*${overlay}([[:space:]]|$)" "$config_path"; then
    echo "Removing $overlay from $config_path..."
    "${SUDO[@]}" sed -i.bak "/^[[:space:]]*${overlay//\//\\/}\\([[:space:]]\\|$\\)/d" "$config_path"
  fi
}

restore_network() {
  echo "Restoring network-safe defaults..."
  remove_boot_overlay "dtoverlay=disable-wifi"

  if unit_exists NetworkManager.service; then
    "${SUDO[@]}" systemctl unmask NetworkManager.service >/dev/null 2>&1 || true
    "${SUDO[@]}" systemctl enable --now NetworkManager.service >/dev/null 2>&1 || true
  fi

  if command -v nmcli >/dev/null 2>&1; then
    "${SUDO[@]}" nmcli networking on >/dev/null 2>&1 || true
    "${SUDO[@]}" nmcli radio wifi on >/dev/null 2>&1 || true
  fi

  echo "Network restore done. Reboot is recommended if a boot overlay was removed:"
  echo "  sudo reboot"
}

if [[ "$RESTORE_NETWORK" == "1" ]]; then
  restore_network
  exit 0
fi

echo "Setting default target to multi-user..."
"${SUDO[@]}" systemctl set-default multi-user.target >/dev/null

if [[ "$FAST_SERVICE" == "1" ]]; then
  echo "Optimizing $SERVICE_NAME startup dependencies..."
  service_dir="/etc/systemd/system/${SERVICE_NAME}.service.d"
  "${SUDO[@]}" mkdir -p "$service_dir"
  cat <<EOF | "${SUDO[@]}" tee "$service_dir/10-fast-boot.conf" >/dev/null
[Unit]
Wants=
After=
After=network.target
EOF
  disable_unit NetworkManager-wait-online.service
fi

if [[ "$DISABLE_BLUETOOTH" == "1" ]]; then
  disable_unit bluetooth.service
  disable_unit hciuart.service
  append_boot_overlay "dtoverlay=disable-bt"
fi

if [[ "$DISABLE_WIFI" == "1" ]]; then
  echo "Disabling Wi-Fi radio..."
  if command -v nmcli >/dev/null 2>&1; then
    "${SUDO[@]}" nmcli radio wifi off >/dev/null 2>&1 || true
  fi
  if [[ "$PERMANENT_DISABLE_WIFI" == "1" ]]; then
    echo "Permanently disabling Wi-Fi through boot overlay..."
    append_boot_overlay "dtoverlay=disable-wifi"
  else
    echo "Wi-Fi boot overlay is left untouched. Use PERMANENT_DISABLE_WIFI=1 only for Ethernet-only appliances."
  fi
else
  remove_boot_overlay "dtoverlay=disable-wifi"
  if command -v nmcli >/dev/null 2>&1; then
    "${SUDO[@]}" nmcli networking on >/dev/null 2>&1 || true
    "${SUDO[@]}" nmcli radio wifi on >/dev/null 2>&1 || true
  fi
fi

if [[ "$DISABLE_AVAHI" == "1" ]]; then
  disable_unit avahi-daemon.service
  disable_unit avahi-daemon.socket
fi

if [[ "$DISABLE_TRIGGERHAPPY" == "1" ]]; then
  disable_unit triggerhappy.service
fi

if [[ "$DISABLE_MODEM" == "1" ]]; then
  disable_unit ModemManager.service
fi

if [[ "$DISABLE_APT_TIMERS" == "1" ]]; then
  disable_unit apt-daily.timer
  disable_unit apt-daily-upgrade.timer
  mask_unit apt-daily.service
  mask_unit apt-daily-upgrade.service
fi

if [[ "$LIMIT_JOURNAL" == "1" ]]; then
  echo "Limiting journald disk usage..."
  "${SUDO[@]}" mkdir -p /etc/systemd/journald.conf.d
  cat <<EOF | "${SUDO[@]}" tee /etc/systemd/journald.conf.d/akai-bridge.conf >/dev/null
[Journal]
SystemMaxUse=64M
RuntimeMaxUse=32M
EOF
fi

"${SUDO[@]}" systemctl daemon-reload

if unit_exists "${SERVICE_NAME}.service"; then
  echo "Restarting $SERVICE_NAME..."
  "${SUDO[@]}" systemctl restart "$SERVICE_NAME" || true
fi

echo
echo "Optimization done."
echo "Recommended next checks:"
echo "  systemd-analyze blame"
echo "  systemd-analyze critical-chain ${SERVICE_NAME}.service"
echo "  systemctl status ${SERVICE_NAME}"
echo
echo "Reboot recommended so boot overlays take effect:"
echo "  sudo reboot"
