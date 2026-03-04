# BS-HA-APPS

Sammlung eigener Home-Assistant Add-ons (Apps) für Raspberry Pi / HAOS.

## Enthaltene Apps
- **RC522 Reader** (`rc522_reader`): Liest RC522/MFRC522 via SPI und published RFID-Events über MQTT.

## Installation (Home Assistant)
1. Home Assistant → **Einstellungen → Apps → App Store → Repositories**
2. Repository hinzufügen: `https://github.com/BS-Media/BS-HA-APPS`
3. **Check for updates**
4. App **RC522 Reader** installieren und starten.

## Updates
- Neue Version wird über `rc522_reader/config.yaml` (`version:`) getriggert.
- Danach in Home Assistant: **Check for updates** → **Update**.