# Mennekes Wallbox Connector

Reiner Datenvermittler zwischen der Wallbox im Heimnetz und der
Online-Abrechnung.

```
   Heimnetz                                    Internet
  ┌──────────────┐        ┌───────────┐       ┌────────────────┐
  │   Wallbox    │◀──────▶│ Connector │──────▶│  Online-Tool   │
  │ 192.168.x.x  │  lesen │  (Add-on) │ senden│  Abrechnung    │
  └──────────────┘        └───────────┘       └────────────────┘
                                ▲
                        Home Assistant
```

**Alle Verbindungen gehen nach außen.** Der Router braucht keine
Portweiterleitung, die Wallbox bleibt aus dem Internet unerreichbar. Das
Add-on öffnet selbst keinen Port und hat keine Bedienoberfläche – es
arbeitet still im Hintergrund.

## Was das Add-on tut

| Takt | Intervall (Vorgabe) | Inhalt |
|---|---|---|
| Live-Zustand | 10 Sekunden | Ladeleistung, Status, aktive Ladekarte, Zählerstand |
| Ladehistorie | 15 Minuten | abgeschlossene Ladevorgänge der letzten 45 Tage |

Optional legt das Add-on dabei auch Home-Assistant-Sensoren an (siehe
[„Home-Assistant-Sensoren (MQTT)“](#home-assistant-sensoren-mqtt) weiter
unten) – das Online-Tool bleibt dabei die alleinige Quelle für die
Abrechnung, die Sensoren zeigen nur denselben Zustand zusätzlich lokal an.

Live-Werte werden bei einem Fehler **nicht** wiederholt – ein zehn Sekunden
alter Messwert nützt niemandem, der nächste steht ohnehin an.

Ladevorgänge dagegen landen in einer **persistenten Warteschlange** unter
`/data`. Fällt das Internet, die Gegenstelle oder der Strom aus, bleiben sie
gespeichert und werden nachgeliefert, sobald die Verbindung wieder steht. Sie
sind die Grundlage der Abrechnung und lassen sich nicht rekonstruieren, wenn
die Wallbox ihre Historie irgendwann überschreibt.

Bereits zugestellte Vorgänge merkt sich das Add-on, damit dieselbe Fahrt nicht
bei jedem Abruf erneut übermittelt wird.

## Einrichtung

### 1. Online-Tool vorbereiten

Dort in der `.env` setzen:

```dotenv
DATA_SOURCE=connector
CONNECTOR_TOKEN=<Ausgabe von: openssl rand -hex 32>
```

Danach neu starten. `MENNEKES_BASE_URL` wird in dieser Betriebsart nicht mehr
gebraucht – das Online-Tool spricht die Wallbox nie an.

### 2. Endpunkte der Wallbox prüfen

Die REST-Pfade unterscheiden sich zwischen den Firmware-Ständen. Einmal im
Heimnetz nachsehen:

```bash
curl -s http://192.168.1.50/api/v1/status | jq
curl -s http://192.168.1.50/api/v1/transactions | jq
```

Die **Feldnamen** innerhalb der Antwort müssen nicht passen – das Online-Tool
erkennt die gängigen Schreibweisen selbst. Nur die **Pfade** müssen stimmen.

**MENNEKES AMTRON (MHCP/1.0):** Die Vorgabe-Konfiguration dieses Add-ons ist
bereits auf dieses Modell eingestellt (`wallbox_auth_mode: query`,
`endpoint_status: /ChargeData`, `endpoint_sessions: /ChargeRecords`,
`wallbox_sessions_protocol: amtron-stateful`) – erkennbar an „System →
REST-Schnittstelle: Aktiviert“ in den Systeminformationen der Wallbox. Nur
noch `wallbox_url` (IP-Adresse) und `wallbox_token` eintragen:

- `wallbox_token` ist der **DevKey** – er steht auf dem Einrichtungsdatenblatt,
  das der Wallbox beilag (dort auch als „APP-Pin“ bzw. „PIN 1“ bezeichnet).
- Die Authentifizierung läuft bei diesem Modell über einen Query-Parameter
  (`?DevKey=...`), nicht über einen Header – deshalb `wallbox_auth_mode: query`
  zusammen mit `wallbox_auth_query_param: DevKey`.
- Die Ladehistorie (`/ChargeRecords`) ist zustandsbehaftet: der Connector
  öffnet eine Sitzung, liest paketweise und schließt wieder
  (`wallbox_sessions_protocol: amtron-stateful`). `simple` (ein einzelner GET)
  liefert bei AMTRON nur eine leere Antwort.
- Zum Prüfen von außerhalb des Connectors: `curl -s
  "http://192.168.1.50:25000/MHCP/1.0/DevInfo?DevKey=<DevKey>"`.

Für andere Firmware-Generationen die Werte unten wie gewohnt anpassen.

### 3. Add-on konfigurieren

| Option | Bedeutung |
|---|---|
| `wallbox_url` | Adresse der Wallbox im Heimnetz, z. B. `http://192.168.1.50` |
| `wallbox_auth_mode` | `none`, `basic`, `bearer`, `apikey` oder `query` (AMTRON: `query`) |
| `wallbox_username` / `wallbox_password` | nur bei `basic` |
| `wallbox_token` | nur bei `bearer`, `apikey` oder `query` (AMTRON: der DevKey) |
| `wallbox_auth_query_param` | nur bei `query` – Name des Query-Parameters (AMTRON: `DevKey`) |
| `endpoint_status` | Pfad für den Live-Zustand |
| `endpoint_sessions` | Pfad für die Ladehistorie |
| `endpoint_meter` | optional, falls Zählerwerte separat kommen |
| `wallbox_sessions_protocol` | `simple` (ein GET) oder `amtron-stateful` (Open/Read/Close, siehe oben) |
| `wallbox_verify_tls` | auf `false`, wenn die Wallbox ein selbstsigniertes Zertifikat nutzt |
| `target_url` | Adresse des Online-Tools, z. B. `https://abrechnung.example.com` |
| `target_token` | dasselbe Geheimnis wie `CONNECTOR_TOKEN` oben |
| `verify_tls` | Zertifikatsprüfung zum Online-Tool – nur in einem Testaufbau abschalten |
| `status_interval_seconds` | Takt der Live-Werte (5–300) |
| `sessions_interval_seconds` | Takt der Historie (60–86400) |
| `history_days` | wie weit zurück die Historie abgefragt wird (1–365) |
| `log_level` | `debug`, `info`, `warn`, `error` |

`target_url` muss `https://` verwenden. Bei `http://` startet das Add-on
nicht – das Token ginge sonst im Klartext durchs Internet. Ausnahme: `localhost`
und `127.0.0.1` für einen Testaufbau auf demselben Rechner.

### 4. Home-Assistant-Sensoren (MQTT) einrichten – optional

Trägt man `mqtt_host` ein, legt das Add-on beim ersten Senden automatisch ein
Gerät „Mennekes Wallbox“ mit mehreren Sensoren in Home Assistant an (MQTT
Discovery – dafür muss die MQTT-Integration von Home Assistant selbst
eingerichtet sein, siehe **Einstellungen → Geräte & Dienste**). Bleibt
`mqtt_host` leer, entfällt dieser Schritt vollständig – der Connector
funktioniert unverändert ohne MQTT.

| Option | Bedeutung |
|---|---|
| `mqtt_host` | Adresse des MQTT-Brokers. Leer = keine Sensoren. Läuft das offizielle „Mosquitto broker“-Add-on, genügt `core-mosquitto`. |
| `mqtt_port` | Port des Brokers (Vorgabe `1883`) |
| `mqtt_username` / `mqtt_password` | nur falls der Broker eine Anmeldung verlangt |
| `mqtt_ssl` | `true`, falls der Broker nur verschlüsselte Verbindungen (`mqtts://`) annimmt |
| `mqtt_discovery_prefix` | Discovery-Präfix von Home Assistant, praktisch immer `homeassistant` |
| `mqtt_node_id` | Eindeutiger Gerätename im MQTT-Thema, z. B. bei mehreren Wallboxen anpassen |
| `mqtt_device_name` | Anzeigename des Geräts in Home Assistant |

Angelegte Entitäten:

| Entität | Typ | Inhalt |
|---|---|---|
| Ladeleistung | Sensor (kW) | aktuelle Ladeleistung |
| Status | Sensor | Klartext-Status (z. B. „Lädt“, „Bereit“) |
| Lädt | Binärsensor | `an`, solange ein Ladevorgang läuft |
| Fahrzeug verbunden | Binärsensor | Stecker eingesteckt ja/nein |
| Energie (Sitzung) | Sensor (kWh) | Energiemenge des laufenden Ladevorgangs |
| Zählerstand | Sensor (kWh) | Gesamtzählerstand, sofern die Wallbox ihn liefert |
| Strom / Spannung | Sensor (A / V) | sofern die Wallbox sie liefert |
| Aktive Ladekarte | Sensor | Name oder RFID der aktuell verwendeten Karte |
| RFID | Sensor (diagnostisch) | rohe RFID-Kennung |
| Letzte Aktualisierung | Sensor (diagnostisch) | Zeitstempel des letzten Live-Werts |

Die Sensoren zeigen genau den Zustand, den auch das Online-Tool erhält – der
Connector wertet die Wallbox-Rohdaten dafür nicht zusätzlich selbst aus.
Bleibt die Wallbox mehrere Fehlversuche in Folge unerreichbar, meldet das
Gerät sich in Home Assistant als „nicht verfügbar“, statt einen veralteten
Wert stehen zu lassen; beim regulären Beenden des Add-ons ebenso.

### 5. Starten und im Protokoll prüfen

Nach dem Start steht im Add-on-Protokoll:

```
INFO : Connector 1.0.0 gestartet.
INFO : Offene Ladevorgänge in der Warteschlange: 0
INFO : Home-Assistant-Sensoren aktiv (Gerät "Mennekes Wallbox").
INFO : Wallbox erreichbar.
INFO : Online-Tool erreichbar: 0 Vorgänge dort gespeichert.
INFO : 12 neue(r) Ladevorgang/Ladevorgänge aus der Wallbox übernommen.
INFO : 12 Vorgang/Vorgänge übermittelt (12 neu, 0 aktualisiert).
```

Die Zeile zu den Home-Assistant-Sensoren erscheint nur, wenn `mqtt_host`
gesetzt ist.

Im Dashboard des Online-Tools erscheint oben ein Hinweis, dass der Connector
verbunden ist, samt Zeitpunkt der letzten Meldung.

## Fehlersuche

| Meldung im Protokoll | Ursache und Abhilfe |
|---|---|
| `Konfiguration unvollständig` | Das Add-on nennt jede fehlende Option einzeln. Konfiguration korrigieren und neu starten. |
| `Wallbox derzeit NICHT erreichbar` | `wallbox_url` prüfen. Steht die Wallbox in einem anderen VLAN, muss Home Assistant sie erreichen können. |
| `Endpunkt nicht gefunden (404)` | Das Online-Tool läuft nicht mit `DATA_SOURCE=connector`. |
| `Abgewiesen (401)` | `target_token` und `CONNECTOR_TOKEN` stimmen nicht überein. |
| `Sendung abgelehnt (400)` | Ein Datensatz war unplausibel. Das Online-Tool nennt die betroffenen IDs; sie werden verworfen, damit sie die Warteschlange nicht blockieren. |
| `Netzwerkfehler` | Vorübergehend – wird automatisch wiederholt, die Vorgänge bleiben gespeichert. |
| `Warteschlange übergelaufen` | Die Gegenstelle war sehr lange nicht erreichbar. Die jüngsten 5000 Vorgänge bleiben erhalten. |
| `Home-Assistant-Anbindung (MQTT) konnte nicht gestartet werden` | `mqtt_host`/`mqtt_port` prüfen. Der Connector läuft trotzdem normal weiter – nur ohne Sensoren. |
| Keine Sensoren in Home Assistant sichtbar | MQTT-Integration in Home Assistant selbst eingerichtet? (**Einstellungen → Geräte & Dienste → MQTT**) `mqtt_discovery_prefix` muss zu deren Einstellung passen (Vorgabe beiderseits `homeassistant`). |

Warteschlange einsehen (Terminal-Add-on oder SSH):

```bash
cat /addon_configs/*mennekes_connector/pending-sessions.json 2>/dev/null \
  || docker exec addon_local_mennekes_connector cat /data/pending-sessions.json
```

## Was das Add-on NICHT tut

- **Keine eigene Abrechnungslogik.** Die Home-Assistant-Sensoren (siehe oben,
  optional über MQTT) zeigen lediglich den vom Online-Tool normalisierten
  Zustand an – die Abrechnung selbst bleibt allein dort. Es entsteht keine
  zweite Datenhaltung.
- **Keine Steuerung der Wallbox.** Es wird ausschließlich gelesen.
- **Keine Bedienoberfläche und kein offener Port.**

## Sicherheit

- Die Verbindung geht ausschließlich vom Heimnetz nach außen.
- Das gemeinsame Geheimnis wandert nur über TLS; ohne `https://` startet das
  Add-on nicht.
- Das Token ist in der Add-on-Konfiguration als `password` hinterlegt und wird
  in der Oberfläche verdeckt dargestellt.
- Der Connector darf beim Online-Tool ausschließlich Daten **liefern** – er
  kann nichts lesen, nichts ändern und hat keine Benutzerrolle.
- Die MQTT-Verbindung (Home-Assistant-Sensoren) bleibt im Heimnetz – Gerät
  und Broker laufen üblicherweise beide unter Home Assistant. `mqtt_password`
  ist ebenfalls als `password` hinterlegt und in der Oberfläche verdeckt.
