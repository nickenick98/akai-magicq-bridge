# Raspberry Pi Fresh Install

Diese Anleitung richtet einen neuen Raspberry Pi fuer die AKAI MagicQ Bridge ein.

## 1. Raspberry Pi OS flashen

Empfohlen:

- Raspberry Pi OS Lite 64-bit
- Hostname z. B. `raspberrypi`
- User: `akai`
- SSH aktivieren
- WLAN optional, Ethernet empfohlen

Nach dem ersten Boot per SSH verbinden:

```bash
ssh akai@<raspi-ip>
```

## 2. Arbeitsordner vorbereiten

```bash
sudo mkdir -p /bridge
sudo chown -R akai:akai /bridge
cd /bridge
```

## 3. Repository klonen

Wenn das Repo public ist:

```bash
git clone https://github.com/nickenick98/akai-magicq-bridge.git
```

Wenn das Repo privat ist, SSH-Key anlegen:

```bash
ssh-keygen -t ed25519 -C "akai-magicq-bridge"
cat ~/.ssh/id_ed25519.pub
```

Diesen Public Key in GitHub als Deploy Key eintragen:

```text
GitHub -> Repo -> Settings -> Deploy keys -> Add deploy key
```

Dann klonen:

```bash
git clone git@github.com:nickenick98/akai-magicq-bridge.git
```

Wichtig: nicht `sudo git clone` verwenden.

## 4. Installer ausfuehren

```bash
cd /bridge/akai-magicq-bridge
chmod +x scripts/install-raspi.sh
./scripts/install-raspi.sh
```

Der Installer erledigt:

- Systempakete installieren
- NetworkManager installieren/aktivieren
- Node.js 20 installieren, falls noetig
- User `akai` zur Gruppe `audio` hinzufuegen
- `npm ci`, wenn `package-lock.json` vorhanden ist, sonst `npm install`
- `npm run build`
- sudoers fuer `ip` und `nmcli`
- systemd-Service passend zu User/Pfad installieren und starten

Der Installer muss als normaler App-User laufen, nicht mit `sudo`. Standard ist `akai`.

Optional mit anderem User/Pfad:

```bash
APP_USER=<dein-user> APP_DIR=/bridge/akai-magicq-bridge ./scripts/install-raspi.sh
```

## 5. Neustart

Nach der Gruppenaenderung fuer MIDI ist ein Neustart sinnvoll:

```bash
sudo reboot
```

Danach:

```bash
systemctl status akai-magicq-bridge
journalctl -u akai-magicq-bridge -f
```

## 6. Weboberflaeche oeffnen

```text
http://<raspi-ip>/
```

Wenn die Backup-IP aktiv ist:

```text
http://192.168.50.10/
```

Die Bridge setzt die Backup-IP beim Start und danach regelmaessig erneut. Die Backup-IP ist immer aktiv und darf nicht leer sein; wenn sie fehlt, wird automatisch `192.168.50.10/24` verwendet. Das Interface wird dafuer auch ohne Link aktiv geschaltet, damit der Pi spaeter direkt am PC ueber diese Adresse erreichbar ist. Beim Anwenden wird die Backup-IP auch dauerhaft als zusaetzliche statische Adresse im NetworkManager-Profil gespeichert. Bei statischer Haupt-IP schaltet die Bridge DHCP ab, entfernt vorhandene globale IPv4-Adressen und setzt danach nur Haupt-IP plus Backup-IP neu. Dabei wird bevorzugt das aktuell aktive NetworkManager-Profil der Schnittstelle auf `manual` gestellt, damit kein altes DHCP-Profil weiter aktiv bleibt. Beim Umschalten zurueck auf DHCP ersetzt die Bridge ungueltige gespeicherte Connection-Namen wie `eth0` automatisch durch das aktive NetworkManager-Profil. Der regelmaessige Refresh entfernt im statischen Modus auch spaeter wieder auftauchende dynamische IPv4-Adressen. Die Haupt-IP wird zusaetzlich sofort per `ip addr replace` und optional das Gateway per `ip route replace` gesetzt. Der Service nutzt dafuer `CAP_NET_ADMIN`, begrenzt die Capabilities aber nicht per `CapabilityBoundingSet`, damit `sudo` fuer `nmcli` weiter zu root wechseln darf. Falls kein passendes Profil existiert, legt die Bridge `akai-bridge-eth0` an.

## 7. MIDI pruefen

APC Mini MK2 anschliessen und pruefen:

```bash
aconnect -l
```

Du solltest etwas sehen wie:

```text
client 20: 'APC mini mk2'
```

Node/easymidi pruefen:

```bash
cd /bridge/akai-magicq-bridge
node -e "const easymidi=require('easymidi'); console.log(easymidi.getInputs()); console.log(easymidi.getOutputs())"
```

## 8. MagicQ einstellen

In der Bridge-GUI:

- MagicQ IP eintragen
- Send Port meist `8000`
- Receive Port meist `9000`
- MIDI Input/Output auf APC oder Auto
- Speichern
- Neu verbinden

In MagicQ:

- OSC Receive aktivieren
- OSC Transmit aktivieren
- Ziel-IP auf Raspberry Pi IP setzen
- Ziel-Port auf Bridge Receive Port setzen, meist `9000`

## 9. Update spaeter

```bash
cd /bridge/akai-magicq-bridge
git pull
npm ci
npm run build
sudo systemctl restart akai-magicq-bridge
```

## 10. Boot optimieren

Nach erfolgreicher Installation kannst du unnoetige Dienste abschalten und den Bridge-Service frueher starten lassen:

```bash
cd /bridge/akai-magicq-bridge
chmod +x scripts/optimize-raspi.sh
./scripts/optimize-raspi.sh
sudo reboot
```

Standardmaessig macht das Skript:

- Bridge-Service wartet nur noch auf `network.target`, nicht auf `network-online.target`
- `NetworkManager-wait-online.service` aus
- Bluetooth aus
- Avahi/mDNS aus
- Triggerhappy aus
- ModemManager aus
- Journald-Groesse begrenzen
- WLAN bleibt unveraendert
- automatische apt-Timer bleiben an

Wenn du Ethernet-only faehrst und WLAN sicher nicht brauchst:

```bash
DISABLE_WIFI=1 ./scripts/optimize-raspi.sh
```

Das schaltet nur den WLAN-Radio ueber NetworkManager aus. Wenn du WLAN wirklich dauerhaft per Boot-Overlay deaktivieren willst, nur bei sicherem Ethernet-Betrieb:

```bash
DISABLE_WIFI=1 PERMANENT_DISABLE_WIFI=1 ./scripts/optimize-raspi.sh
```

Wenn der Pi danach nur noch ueber die Backup-IP erreichbar ist und keine normale Ethernet-IP bekommt:

```bash
./scripts/optimize-raspi.sh --restore-network
sudo reboot
```

Das setzt standardmaessig `eth0` wieder auf DHCP/Autoconnect. WLAN bleibt dabei aus/unveraendert. Falls du eine andere Schnittstelle nutzt:

```bash
ETH_INTERFACE=enp1s0 ./scripts/optimize-raspi.sh --restore-network
```

Nur falls WLAN bewusst wieder aktiviert werden soll:

```bash
RESTORE_WIFI=1 ./scripts/optimize-raspi.sh --restore-network
sudo reboot
```

Wenn alle Optimierungen wieder zurueckgesetzt werden sollen:

```bash
./scripts/optimize-raspi.sh --restore-all
sudo reboot
```

Das entfernt die systemd-Beschleunigung, hebt Journald-Limits auf, entfernt `disable-bt`/`disable-wifi` Boot-Overlays und aktiviert die abgeschalteten Dienste wieder. Wenn WLAN aus bleiben soll:

```bash
KEEP_WIFI_DISABLED=1 ./scripts/optimize-raspi.sh --restore-all
sudo reboot
```

Wenn du maximale Appliance-Startzeit willst und automatische apt-Laeufe nicht brauchst:

```bash
DISABLE_APT_TIMERS=1 ./scripts/optimize-raspi.sh
```

Zum Messen:

```bash
systemd-analyze
systemd-analyze blame
systemd-analyze critical-chain akai-magicq-bridge.service
```

## 11. Fehlerdiagnose

Service:

```bash
systemctl status akai-magicq-bridge
journalctl -u akai-magicq-bridge -n 120 --no-pager
```

MIDI:

```bash
aconnect -l
lsusb
groups akai
```

Netzwerk:

```bash
ip addr show eth0
sudo -n /usr/bin/nmcli general status
sudo -n /usr/sbin/ip addr show
```

Port:

```bash
sudo ss -tulpn | grep ':80'
```
