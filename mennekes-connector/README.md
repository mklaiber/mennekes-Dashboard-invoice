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

### 3. Add-on konfigurieren

| Option | Bedeutung |
|---|---|
| `wallbox_url` | Adresse der Wallbox im Heimnetz, z. B. `http://192.168.1.50` |
| `wallbox_auth_mode` | `none`, `basic`, `bearer` oder `apikey` |
| `wallbox_username` / `wallbox_password` | nur bei `basic` |
| `wallbox_token` | nur bei `bearer` oder `apikey` |
| `endpoint_status` | Pfad für den Live-Zustand |
| `endpoint_sessions` | Pfad für die Ladehistorie |
| `endpoint_meter` | optional, falls Zählerwerte separat kommen |
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

### 4. Starten und im Protokoll prüfen

Nach dem Start steht im Add-on-Protokoll:

```
INFO : Connector 1.0.0 gestartet.
INFO : Offene Ladevorgänge in der Warteschlange: 0
INFO : Wallbox erreichbar.
INFO : Online-Tool erreichbar: 0 Vorgänge dort gespeichert.
INFO : 12 neue(r) Ladevorgang/Ladevorgänge aus der Wallbox übernommen.
INFO : 12 Vorgang/Vorgänge übermittelt (12 neu, 0 aktualisiert).
```

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

Warteschlange einsehen (Terminal-Add-on oder SSH):

```bash
cat /addon_configs/*mennekes_connector/pending-sessions.json 2>/dev/null \
  || docker exec addon_local_mennekes_connector cat /data/pending-sessions.json
```

## Was das Add-on NICHT tut

- **Keine Home-Assistant-Entitäten.** Es ist ein reiner Vermittler, wie
  gewünscht. Sensoren für Ladeleistung und Status ließen sich ergänzen, würden
  aber eine zweite Datenhaltung einführen.
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
