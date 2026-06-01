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
- Node.js 20 installieren, falls noetig
- User `akai` zur Gruppe `audio` hinzufuegen
- `npm install`
- `npm run build`
- sudoers fuer `ip` und `nmcli`
- systemd-Service installieren und starten

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

Die Bridge setzt die Backup-IP beim Start und danach regelmaessig erneut. Das Interface wird dafuer auch ohne Link aktiv geschaltet, damit der Pi spaeter direkt am PC ueber diese Adresse erreichbar ist. Im systemd-Service ist dafuer `CAP_NET_ADMIN` gesetzt; die Haupt-IP-Konfiguration ueber NetworkManager braucht weiterhin die sudoers-Regel fuer `nmcli`.

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
npm install
npm run build
sudo systemctl restart akai-magicq-bridge
```

## 10. Fehlerdiagnose

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
