# Mennekes Wallbox – Abrechnung & Live-Dashboard

Liest die Ladehistorie einer MENNEKES-Wallbox über deren REST-API aus, erzeugt
monatlich ein Abrechnungs-PDF und eine CSV-Datei je Ladekarte (RFID) und versendet
beides automatisch per E-Mail. Dazu ein passwortgeschütztes Live-Dashboard mit der
aktuellen Ladeleistung, dem Wallbox-Status und der aktiven Ladekarte.

Gedacht für die Abrechnung dienstlicher Ladevorgänge am privaten Hausanschluss
gegenüber dem Arbeitgeber.

---

## Inhalt

- [Funktionsumfang](#funktionsumfang)
- [Schnellstart](#schnellstart)
- [Wichtig: Endpunkte der Wallbox prüfen](#wichtig-endpunkte-der-wallbox-prüfen)
- [Konfiguration](#konfiguration)
- [Projektstruktur](#projektstruktur)
- [REST-API](#rest-api)
- [Automatisierung](#automatisierung)
- [Sicherheit](#sicherheit)
- [Tests](#tests)
- [Deployment](#deployment)
- [Betrieb & Fehlersuche](#betrieb--fehlersuche)

---

## Funktionsumfang

| Bereich | Umsetzung |
|---|---|
| **Live-Dashboard** | Ladeleistung (kW), Status, aktive RFID-Karte, Strom, Spannung, Zählerstand, Leistungsverlauf – per Server-Sent Events in Echtzeit |
| **Abrechnung** | Gruppierung nach RFID-Tag, Energie- und Kostensummen, konfigurierbarer Arbeitspreis, nicht-abrechenbare Karten |
| **PDF** | A4-Beleg via Handlebars + Puppeteer: Logo, Stammdaten, Kennzahlen, Zusammenfassung je Karte, Einzelnachweis, Schlussrechnung, Seitenzahlen |
| **CSV** | Detail-Export (eine Zeile je Ladevorgang) und Summen-Export (eine Zeile je Karte) – Semikolon, deutsches Dezimalkomma, UTF-8-BOM für Excel |
| **E-Mail** | HTML- und Text-Variante mit PDF und beiden CSVs im Anhang |
| **Automatisierung** | `node-cron`, läuft am Monatsletzten und rechnet den ablaufenden Monat ab |
| **Einstellungen** | WebUI für Wallbox-Adresse, Preis, Empfänger, Stammdaten und RFID-Mapping |
| **Sicherheit** | Basic-Auth über alle Routen, Helmet mit CSP und Nonce, Rate-Limit, Whitelist-Validierung, Path-Traversal-Schutz |
| **Deployment** | Dockerfile (System-Chromium, non-root), `docker-compose.yml`, Ansible-Playbook |

---

## Schnellstart

Voraussetzung: Node.js ≥ 20.

```bash
git clone <repo-url> mennekes-billing
cd mennekes-billing
npm install

cp .env.example .env
$EDITOR .env          # mindestens AUTH_PASSWORD und MENNEKES_BASE_URL setzen

npm start
```

WebUI: <http://localhost:3000> – Anmeldung mit `AUTH_USER` / `AUTH_PASSWORD`.

Passwort erzeugen:

```bash
openssl rand -base64 24
```

Ohne `AUTH_PASSWORD` **startet die Anwendung nicht** – das ist Absicht, damit die
WebUI nie ungeschützt im Netz steht.

### Mit Docker

```bash
cp .env.example .env
$EDITOR .env
docker compose up -d --build
docker compose logs -f
```

---

## Wichtig: Endpunkte der Wallbox prüfen

Die REST-Pfade unterscheiden sich zwischen den MENNEKES-Firmware-Generationen
(AMTRON Professional, Professional+, ChargeControl …). Dieses Projekt trifft
deshalb **keine feste Annahme**: die Pfade sind über die `.env` konfigurierbar,
und das Parsing der Antworten ist bewusst tolerant gegenüber unterschiedlichen
Feldbenennungen.

Vor dem ersten Produktivlauf einmal gegen die eigene Wallbox prüfen:

```bash
curl -s http://<WALLBOX-IP>/api/v1/status | jq
curl -s http://<WALLBOX-IP>/api/v1/transactions | jq
```

Passen die Pfade nicht, in der `.env` anpassen:

```dotenv
MENNEKES_ENDPOINT_STATUS=/api/v1/status
MENNEKES_ENDPOINT_SESSIONS=/api/v1/transactions
MENNEKES_ENDPOINT_METER=            # optional, falls Zählerwerte separat kommen
```

**Die Feldnamen innerhalb der Antwort müssen nicht angepasst werden.** Der Client
erkennt jeweils mehrere gängige Schreibweisen:

| Wert | Akzeptierte Felder (Auswahl) |
|---|---|
| Status | `status`, `state`, `chargePointState`, `connectorStatus`, `connectors[0].status` |
| Leistung | `power`, `powerKw`, `activePower`, `chargingPower`, `meter.power` |
| Energie | `energy`, `energyKwh`, `chargedEnergy`, `consumption`, `kwh` |
| RFID | `rfid`, `rfidTag`, `idTag`, `tokenId`, `authorizationId`, `cardId` |
| Start/Ende | `start`/`startTime`/`startedAt`, `end`/`endTime`/`stoppedAt` |

Zusätzlich werden erkannt und umgerechnet:

- **IEC-61851-Statusbuchstaben** (`A` → Standby, `B` → Verbunden, `C`/`D` → Lädt) und **OCPP-Status** (`SuspendedEV`, `Preparing`, `Faulted` …)
- **Wattstunden statt kWh** – über `energyUnit: "Wh"` oder heuristisch bei unplausibel großen Werten
- **Unix-Timestamps** in Sekunden und Millisekunden neben ISO-8601
- **Fehlendes Energiefeld** – wird aus `meterStart`/`meterStop` berechnet

Ein Datensatz ohne Startzeitpunkt oder ohne ermittelbare Energie wird verworfen,
statt die Abrechnung zu verfälschen.

---

## Konfiguration

Die Konfiguration ist bewusst zweigeteilt:

| Ebene | Ort | Inhalt | Änderbar über |
|---|---|---|---|
| **Secrets & Infrastruktur** | `.env` / Container-Umgebung | Passwörter, API-Token, SMTP-Zugang, Ports, Cron-Zeitplan | Datei bzw. Ansible |
| **Fachliche Einstellungen** | `data/settings.json` | Preis, Empfänger, Stammdaten, RFID-Mapping | WebUI |

Die WebUI kann **keine** Secrets lesen oder schreiben. `PUT /api/settings` arbeitet
mit einer Whitelist – unbekannte Felder aus dem Request werden verworfen.

Vollständige Variablenliste: siehe [`.env.example`](.env.example).

### RFID-Mapping

Karten-IDs werden vor dem Vergleich normalisiert (Kleinschreibung, Entfernen von
`:`, `-`, `_` und Leerzeichen). `04:A1:B2:C3`, `04-a1-b2-c3` und `04A1B2C3` sind
damit dieselbe Karte.

Nicht zugeordnete Karten erscheinen in PDF und Dashboard als „Unbekannt (…)" mit
Hinweis – sie werden trotzdem abgerechnet, damit keine kWh verlorengehen.

Über `billable: false` lässt sich eine Karte (z. B. privates Zweitfahrzeug) aus
dem Erstattungsbetrag herausnehmen; im Einzelnachweis bleibt sie sichtbar.

---

## Projektstruktur

```
.
├── src/
│   ├── server.js              Prozess-Einstieg: Start, Cronjob, Signal-Handling
│   ├── app.js                 Express-App-Factory (für Tests injizierbar)
│   ├── config/
│   │   ├── index.js           ENV laden, typisieren, Pflichtfelder prüfen
│   │   └── settings.js        settings.json: laden, atomar speichern, RFID-Lookup
│   ├── services/
│   │   ├── mennekesClient.js  REST-Client inkl. Normalisierung und Retry
│   │   ├── billing.js         Gruppierung, Kostenberechnung (I/O-frei)
│   │   ├── pdfService.js      Handlebars → HTML → Puppeteer → PDF
│   │   ├── csvService.js      Detail- und Summen-CSV
│   │   ├── mailer.js          nodemailer, HTML- und Text-Body
│   │   ├── reportService.js   Orchestrierung: Abruf → Dateien → Versand
│   │   └── liveFeed.js        SSE-Broadcast mit einem Poll-Timer für alle Clients
│   ├── routes/
│   │   ├── api.js             REST + SSE
│   │   └── views.js           HTML-Seiten
│   ├── middleware/
│   │   ├── auth.js            Basic-Auth (timing-safe)
│   │   └── errorHandler.js    404, zentraler Fehlerhandler, asyncHandler
│   ├── jobs/scheduler.js      node-cron + Monatsletzter-Prüfung
│   └── utils/
│       ├── dates.js           Zeitzonen-korrekte Monatsgrenzen (ohne Fremd-Lib)
│       └── logger.js          Level-Logger ohne Abhängigkeit
├── views/
│   ├── dashboard.ejs          Ansicht 1: Live-Dashboard
│   ├── settings.ejs           Ansicht 2: Einstellungen
│   ├── error.ejs
│   ├── partials/              head, nav, foot
│   └── pdf/invoice.hbs        PDF-Template (Druck-CSS, A4)
├── public/
│   ├── js/                    dashboard.js, settings.js, tailwind-config.js
│   └── css/fallback.css       Notfall-Styles, falls das Tailwind-CDN fehlt
├── tests/                     11 Suites, 243 Tests
│   ├── fixtures/wallbox.js    nachgebildete API-Antworten
│   └── setup.js               ENV für den Testlauf
├── scripts/run-report.js      CLI für manuelle Läufe und Nachläufe
├── ansible/                   Playbook, env.j2, Inventar-Vorlagen
├── Dockerfile
└── docker-compose.yml
```

---

## REST-API

Alle Endpunkte erfordern Basic-Auth.

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/` | Live-Dashboard |
| `GET` | `/einstellungen` | Einstellungsseite |
| `GET` | `/api/live` | **SSE-Stream** – Events `status` und `error` |
| `GET` | `/api/status` | Einmaliger Zustandsabruf (Polling-Fallback) |
| `GET` | `/api/report?year=&month=` | Report als JSON (Default: Vormonat) |
| `POST` | `/api/report/run` | PDF + CSV erzeugen, optional versenden |
| `GET` | `/api/report/files` | Erzeugte Dateien auflisten |
| `GET` | `/api/report/files/:name` | Datei herunterladen |
| `GET` | `/api/settings` | Einstellungen lesen |
| `PUT` | `/api/settings` | Einstellungen schreiben (Whitelist) |
| `GET` | `/api/health` | `200` = Wallbox erreichbar, `503` = nicht erreichbar |

Beispiel:

```bash
curl -u admin:geheim \
     -H 'Content-Type: application/json' \
     -d '{"year":2026,"month":3,"sendMail":false}' \
     http://localhost:3000/api/report/run
```

---

## Automatisierung

`node-cron` kennt kein `L` für den letzten Tag des Monats, und der Monatsletzte
wechselt zwischen dem 28. und 31. Deshalb läuft der Job **täglich** zur
konfigurierten Uhrzeit und prüft selbst, ob heute der Monatsletzte ist:

```dotenv
CRON_EXPRESSION=30 23 * * *        # täglich 23:30
CRON_RUN_POLICY=last-day-of-month  # oder "always" zum Testen
```

Läuft der Job am 31.03. um 23:30, wird der **ablaufende** Monat (März) abgerechnet
– nicht der Vormonat. Der manuelle Lauf ohne Monatsangabe rechnet dagegen den
Vormonat ab, weil er typischerweise als Nachlauf gestartet wird.

Ein fehlgeschlagener Lauf beendet den Prozess nicht; der Fehler landet im Log und
im nächsten Monat läuft der Job normal weiter.

Manueller Nachlauf:

```bash
node scripts/run-report.js --month 3 --year 2026          # mit Versand
node scripts/run-report.js --no-mail                      # nur Dateien
node scripts/run-report.js --to test@firma.de             # Testversand
```

---

## Sicherheit

- **Basic-Auth vor allem** – die Middleware ist vor Routen *und* vor dem Static-Handler registriert. Der Passwortvergleich läuft timing-safe.
- **Start ohne Passwort wird verweigert** (`assertProductionSecrets`), ebenso fehlende Wallbox-Credentials im jeweiligen Auth-Modus.
- **CSP mit Nonce** – `script-src` erlaubt nur `'self'`, das Tailwind-CDN und ein Per-Request-Nonce. Kein pauschales `'unsafe-inline'` für Skripte.
- **Helmet** für die übrigen Header, HSTS nur unter `NODE_ENV=production`.
- **Rate-Limit** vor der Authentifizierung (600 Anfragen / 15 min).
- **Whitelist-Validierung** in `PUT /api/settings`: Preis-Grenzen, E-Mail-Format, gültige IANA-Zeitzone, `http(s)`-Schema. Unbekannte Felder werden verworfen.
- **Path-Traversal-Schutz** beim Datei-Download: Basename-Vergleich, Endungs-Whitelist und Prüfung des aufgelösten Pfads gegen das Ausgabeverzeichnis.
- **HTML-Escaping** in PDF, E-Mail und Dashboard – RFID-Namen aus den Einstellungen sind Benutzereingaben.
- **Container läuft als `node`**, nicht als root; `cap_drop: ALL`, `no-new-privileges`.
- **Secrets nie in `settings.json`** und nie in einer API-Antwort – dafür gibt es einen expliziten Test.

### Bewusste Kompromisse

- `PUPPETEER_NO_SANDBOX=true` im Container. Chromiums eigene Sandbox braucht Privilegien, die dem Container abgenommen wurden; die Isolation liefert hier der Container. Gerendert wird ausschließlich selbst erzeugtes HTML.
- Tailwind kommt per CDN (so angefordert). Damit ein Ausfall des CDN die Oberfläche nicht unbrauchbar macht, liefert `public/css/fallback.css` die Klassen mit *funktionaler* Bedeutung (`hidden`, `sr-only`) und ein lesbares Grundlayout.

---

## Tests

```bash
npm test               # 11 Suites, 243 Tests
npm run test:coverage
npm run lint
```

| Suite | Prüft |
|---|---|
| `dates` | Monatsgrenzen über Sommer-/Winterzeit, Schaltjahre, Jahreswechsel |
| `mennekesClient` | Normalisierung aller Antwortvarianten, Retry-Verhalten, Zeitraumfilter |
| `billing` | Gruppierung, Rundung auf Cent, abrechenbar/nicht abrechenbar, Leermonat |
| `csvService` | Trennzeichen, Dezimalkomma, BOM, Maskierung, Summenzeile |
| `pdfService` | HTML-Rendering, Logo-Fallback, XSS-Escaping, PDF-Optionen (Puppeteer gemockt) |
| `mailer` | Empfänger, Betreff, beide Body-Varianten, Anhänge, Fehlerdurchreichung |
| `reportService` | Orchestrierung vom Abruf bis zum Versand |
| `scheduler` | Monatsletzter-Erkennung, Zeitraumwahl, Fehlertoleranz, keine Parallelläufe |
| `liveFeed` | Fan-out an mehrere Clients, Timer-Lebenszyklus, Abbruchbehandlung |
| `config` | Pflichtfeld-Prüfung, atomares Speichern, defekte settings.json |
| `app` | Auth auf allen Routen, Security-Header, Validierung, Path-Traversal, SSE-Stream |

Die Wallbox wird durchgehend gemockt; Puppeteer ist in den Unit-Tests ersetzt,
damit die Suite ohne Chromium in unter drei Sekunden durchläuft.

---

## Deployment

### Docker

```bash
docker compose up -d --build
```

Das Image nutzt das **System-Chromium** aus den Debian-Paketquellen statt des
Puppeteer-Downloads: rund 300 MB kleiner und über den Paketmanager aktualisierbar.
`tini` läuft als PID 1 und räumt Chromium-Zombieprozesse ab.

Persistiert wird ausschließlich das Volume `wallbox-data` (`/app/data`) mit
`settings.json` und den erzeugten Dateien.

### Ansible

```bash
cd ansible
ansible-galaxy collection install -r requirements.yml
cp inventory.ini.example inventory.ini
cp group_vars/all.yml.example group_vars/all.yml
ansible-playbook deploy.yml --ask-vault-pass
```

Das Playbook installiert Docker, legt einen Systemnutzer an, überträgt das Projekt
nach `/opt/mennekes-billing`, erzeugt die `.env` aus Ansible-Variablen
(`no_log: true`, Rechte `0640`), baut das Image und wartet auf den Health-Check.

Details, Tags und Vault-Nutzung: [`ansible/README.md`](ansible/README.md).

---

## Betrieb & Fehlersuche

| Symptom | Ursache / Abhilfe |
|---|---|
| Start bricht mit „Fehlende Pflicht-Umgebungsvariablen" ab | `AUTH_PASSWORD` bzw. Wallbox-Credentials in der `.env` setzen |
| `/api/health` liefert `503` | Die App läuft, die Wallbox antwortet nicht: `MENNEKES_BASE_URL`, Netzwerk und Auth-Modus prüfen |
| Dashboard zeigt „Wallbox antwortet nicht" | Gleiche Ursache; die Fehlermeldung aus dem SSE-`error`-Event steht im Banner |
| Report ist leer | Endpunkt-Pfad der Historie prüfen (`curl … | jq`) und mit `MENNEKES_ENDPOINT_SESSIONS` korrigieren |
| Karten erscheinen als „Unbekannt" | RFID unter *Einstellungen → RFID-Zuordnung* eintragen – Schreibweise egal |
| PDF-Erzeugung schlägt im Container fehl | `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` und `PUPPETEER_NO_SANDBOX=true` prüfen; bei `/dev/shm`-Fehlern `shm_size` erhöhen |
| Keine E-Mail | `docker compose logs` zeigt die SMTP-Antwort; Testversand: `node scripts/run-report.js --to <adresse>` |
| Oberfläche unformatiert | Kein Zugriff auf `cdn.tailwindcss.com`; die Seite bleibt über `fallback.css` bedienbar |

Logs:

```bash
docker compose logs -f wallbox-billing
LOG_LEVEL=debug npm start          # ausführlicher lokal
```

---

## Lizenz

MIT
