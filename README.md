# AKAI APC Mini MK2 MagicQ Bridge

Plattformuebergreifende Node.js/SvelteKit-Anwendung, die einen AKAI APC Mini MK2 per MIDI liest, OSC-Befehle an ChamSys MagicQ sendet und OSC-Feedback fuer LED-Status zurueck auf den Controller legen kann.

## Funktionen der ersten Version

- MIDI Inputs/Outputs erkennen und speichern
- APC Mini MK2 Events lesen: Pads, Buttons, Shift und Fader
- OSC per UDP an MagicQ senden
- OSC Feedback von MagicQ empfangen und live an die UI weitergeben
- JSON-Konfiguration automatisch anlegen
- Mapping-System fuer Executor Buttons und Fader
- LED-Test und einfache LED-Modi fuer Pads
- SvelteKit-Weboberflaeche mit Verbindung, APC Layout, Mapping Editor und Live Monitor

## Entwicklung

```bash
npm install
npm run dev
```

Die Weboberflaeche laeuft im Entwicklungsmodus standardmaessig auf `http://localhost:5173`.
Der Backend-Server laeuft auf `http://localhost:3001`.

Auf Raspberry Pi OS kann `easymidi` fuer native MIDI-Unterstuetzung zusaetzliche Systempakete wie ALSA-Header benoetigen, zum Beispiel `libasound2-dev`.

## Produktion

```bash
npm install
npm run build
npm start
```

Nach `npm run build` liefert der Node-Server den statischen SvelteKit-Build aus `web/build` aus.

## Windows EXE

Auf Windows kann eine einzelne EXE gebaut werden:

```powershell
npm install
npm run package:win
```

Die Datei liegt danach hier:

```text
dist/akai-magicq-bridge.exe
```

Beim Start der EXE laeuft der Server auf Port `3001`. Die Oberflaeche ist dann erreichbar unter:

```text
http://127.0.0.1:3001
```

Die EXE legt ihre beschreibbaren Daten neben der EXE im Ordner `dist/data` ab. Dort liegen dann `config.json` und `state.json`.

Unter Windows blendet die Oberflaeche die Raspberry-spezifischen Netzwerkfelder aus. Stattdessen werden nur die lokalen Windows-IP-Adressen angezeigt. Sicherung und Wiederherstellung bleiben sichtbar.

## MagicQ

Die Standardkonfiguration nutzt:

- MagicQ Receive Port: `8000`
- MagicQ Transmit Port: `9000`

Die OSC-Ziele sind bewusst einfach gehalten und koennen in `server/osc.js` an das konkret genutzte MagicQ-OSC-Schema angepasst werden:

- Executor Button: `/exec/{page}/{executor}`
- Executor Fader: `/exec/{page}/{executor}/level`

## Raspberry Pi systemd

Eine Beispiel-Service-Datei liegt unter `systemd/akai-magicq-bridge.service`.

### Installation auf dem Raspberry Pi

Eine komplette Schritt-fuer-Schritt-Anleitung fuer einen frischen Raspberry Pi liegt hier:

```text
docs/raspi-fresh-install.md
```

Kurzweg nach dem Klonen nach `/bridge/akai-magicq-bridge`:

```bash
cd /bridge/akai-magicq-bridge
chmod +x scripts/install-raspi.sh
./scripts/install-raspi.sh
sudo reboot
```

Raspberry Pi OS Bookworm nutzt standardmaessig NetworkManager. Die Bridge erwartet Node.js 20 oder neuer.

1. Systempakete installieren:

```bash
sudo apt update
sudo apt install -y git build-essential python3 make g++ libasound2-dev
```

2. Node.js 20 installieren, falls noch nicht vorhanden:

```bash
node -v
```

Wenn die Version kleiner als 20 ist, Node.js 20 ueber NodeSource installieren:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

3. Projekt nach `/home/pi/akai-magicq-bridge` kopieren oder klonen:

```bash
cd /home/pi
git clone <DEIN-REPO-ODER-KOPIE> akai-magicq-bridge
cd /home/pi/akai-magicq-bridge
```

4. Abhaengigkeiten installieren und Weboberflaeche bauen:

```bash
npm install
npm run build
```

5. Optional einmal testen:

```bash
npm start
```

Mit `npm start` laeuft die Oberflaeche weiter auf `http://<raspi-ip>:3001`.

6. Netzwerkrechte fuer Backup-IP und Haupt-IP erlauben:

```bash
sudo cp systemd/akai-magicq-bridge-sudoers /etc/sudoers.d/akai-magicq-bridge
sudo chmod 440 /etc/sudoers.d/akai-magicq-bridge
sudo visudo -cf /etc/sudoers.d/akai-magicq-bridge
```

7. systemd-Service aktivieren:

```bash
sudo cp systemd/akai-magicq-bridge.service /etc/systemd/system/akai-magicq-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable akai-magicq-bridge
sudo systemctl start akai-magicq-bridge
```

Die Oberflaeche ist dann ueber `http://<raspi-ip>/` erreichbar. Der Raspberry-Pi-systemd-Service setzt dafuer `PORT=80` und erlaubt dem Benutzer `akai` das Binden von Port 80 per `CAP_NET_BIND_SERVICE`. Fuer die Backup-IP bekommt der Service zusaetzlich `CAP_NET_ADMIN`, damit `ip addr replace` auch ohne DHCP-Link direkt greifen kann. Die Windows-EXE und die lokale Entwicklung bleiben ohne diese Service-Umgebung bei Port `3001`.

8. Status und Logs ansehen:

```bash
systemctl status akai-magicq-bridge
journalctl -u akai-magicq-bridge -f
```

Nach einem Neustart startet die Bridge automatisch. Wenn `Beim Start setzen` aktiv ist, setzt sie zusaetzlich die Backup-IP auf derselben Schnittstelle.

Der Service beendet beim Stoppen offene Browser-/WebSocket-Verbindungen selbst. Dadurch bleibt `systemctl stop akai-magicq-bridge` nicht an einer noch offenen Weboberflaeche haengen.

## Raspberry Pi Netzwerk

Im Panel `Raspberry Netzwerk` kann eine feste Backup-IP und eine Haupt-IP konfiguriert werden.

- Es gibt genau eine Schnittstelle fuer beide IPs, z. B. `eth0`.
- Backup-IP: bleibt als Rettungsadresse auf dieser Schnittstelle, z. B. `192.168.50.10/24`.
- Haupt-IP: kann per DHCP laufen oder statisch gesetzt werden.
- Unter Windows werden diese Werte nur gespeichert.
- Unter Raspberry Pi OS/Linux wird die Haupt-IP ueber NetworkManager/`nmcli` gesetzt und die Backup-IP als zusaetzliche statische Adresse im NetworkManager-Profil hinterlegt und mit `ip addr replace` ergaenzt.
- Bei statischer Haupt-IP schaltet die Bridge DHCP ab, entfernt vorhandene globale IPv4-Adressen vom Interface und setzt danach nur Haupt-IP plus Backup-IP neu. Die Haupt-IP wird zusaetzlich sofort per `ip addr replace` und optional das Gateway per `ip route replace` gesetzt, damit die Adresse auch dann direkt aktiv wird, wenn NetworkManager den Reconnect nicht sauber schafft.
- Wenn kein passendes NetworkManager-Profil vorhanden ist, legt die Bridge beim Anwenden ein Profil `akai-bridge-<interface>` an, z. B. `akai-bridge-eth0`.
- Wenn `Beim Start setzen` aktiv ist, setzt der Server die Backup-IP beim Start und danach regelmaessig erneut. Dabei wird die Schnittstelle auch ohne Link/Carrier mit `ip link set dev <iface> up` aktiviert, damit ein direkt per Kabel angeschlossener PC die Backup-IP erreichen kann, sobald der Link steht.
- Im statischen Modus prueft der Refresh dabei auch, ob noch fremde/dynamische IPv4-Adressen sichtbar sind, und setzt dann nur Haupt-IP plus Backup-IP erneut.

Raspberry Pi OS Bookworm nutzt standardmaessig NetworkManager. Wenn der systemd-Service als Benutzer `pi` laeuft, braucht die Netzwerk-Anwendung sudo-Rechte ohne Passwort fuer `ip` und `nmcli`, oder der Service muss mit passenden Rechten laufen. Ohne diese Rechte bleibt die Konfiguration gespeichert, kann aber nicht angewendet werden.

Beispiel fuer die feste Backup-IP:

```text
Schnittstelle fuer beide IPs: eth0
Backup IP/CIDR: 192.168.50.10/24
```

Beispiel fuer die Haupt-IP statisch:

```text
Interface: eth0
Modus: Statisch
IP/CIDR: 192.168.178.60/24
Gateway: 192.168.178.1
DNS: 192.168.178.1,1.1.1.1
```

## Sicherung und Wiederherstellung

Im Panel `Raspberry Netzwerk` gibt es:

- `Sicherung exportieren`
- `Sicherung importieren`

Die Sicherung enthaelt Mapping, MIDI-Auswahl, MagicQ-Einstellungen, Haupt-IP-Konfiguration, UI- und APC-Einstellungen sowie den gespeicherten Laufzeit-State. Die Backup-IP wird absichtlich nicht exportiert. Beim Import bleibt die lokale Backup-IP des Raspberry Pi erhalten, damit man sich nicht versehentlich die Rettungsadresse ueberschreibt.
