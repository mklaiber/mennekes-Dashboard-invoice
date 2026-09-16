# Mennekes Wallbox – Abrechnung & Live-Dashboard

Liest die Ladehistorie einer MENNEKES-Wallbox über deren REST-API aus, erzeugt
monatlich ein Abrechnungs-PDF und eine CSV-Datei je Ladekarte (RFID) und versendet
beides automatisch per E-Mail. Dazu ein passwortgeschütztes Live-Dashboard mit der
aktuellen Ladeleistung, dem Wallbox-Status und der aktiven Ladekarte.

Gedacht für die Abrechnung dienstlicher Ladevorgänge am privaten Hausanschluss
gegenüber dem Arbeitgeber.

Mehrbenutzerfähig mit Anmeldung, Rollen und Protokoll; alle Daten liegen in einer
SQLite-Datei. Die Oberfläche folgt Material Design 3 und kommt ohne CDN aus.

---

## Inhalt

- [Funktionsumfang](#funktionsumfang)
- [Schnellstart](#schnellstart)
- [Anmeldung und Benutzerverwaltung](#anmeldung-und-benutzerverwaltung)
- [Datenbank](#datenbank)
- [Druckbares PDF](#druckbares-pdf)
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
| **Oberfläche** | Material Design 3, selbst gehostet (kein CDN), helles und dunkles Schema mit Umschalter |
| **Benutzer** | Anmeldung mit Sitzungs-Cookie, Rollen (Administrator / Betrachter), Kontosperre, erzwungener Passwortwechsel, Protokoll |
| **Datenhaltung** | SQLite: Konten, Sitzungen, Einstellungen, RFID-Zuordnung, Protokoll, Laufhistorie |
| **Abrechnung** | Gruppierung nach RFID-Tag, Energie- und Kostensummen, konfigurierbarer Arbeitspreis, nicht-abrechenbare Karten |
| **PDF** | Druckfertiger A4-Beleg: konfigurierbare Ränder (DIN-5008-nah, 25 mm Heftrand), wiederholte Tabellenköpfe, saubere Seitenumbrüche, Seitenzahlen |
| **CSV** | Detail-Export (eine Zeile je Ladevorgang) und Summen-Export (eine Zeile je Karte) – Semikolon, deutsches Dezimalkomma, UTF-8-BOM für Excel |
| **E-Mail** | HTML- und Text-Variante mit PDF und beiden CSVs im Anhang |
| **Automatisierung** | `node-cron`, läuft am Monatsletzten und rechnet den ablaufenden Monat ab |
| **Einstellungen** | WebUI für Wallbox-Adresse, Preis, Empfänger, Stammdaten und RFID-Mapping |
| **Sicherheit** | Sitzungs-Auth mit CSRF-Schutz, scrypt-Passwörter, Helmet mit CSP und Nonce, Rate-Limit, Whitelist-Validierung, Path-Traversal-Schutz |
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

WebUI: <http://localhost:3000> – beim ersten Start meldet man sich mit
`AUTH_USER` / `AUTH_PASSWORD` an.

Passwort erzeugen:

```bash
openssl rand -base64 24
```

Ohne `AUTH_PASSWORD` **startet die Anwendung nicht** – das ist Absicht, damit die
WebUI nie ungeschützt im Netz steht.

Läuft die Anwendung ohne TLS im LAN, muss `SESSION_COOKIE_SECURE=false` gesetzt
sein – sonst sendet der Browser das Sitzungs-Cookie nicht und die Anmeldung
scheitert ohne sichtbare Fehlermeldung.

### Mit Docker

```bash
cp .env.example .env
$EDITOR .env
docker compose up -d --build
docker compose logs -f
```

---

## Anmeldung und Benutzerverwaltung

Die Anmeldung läuft über ein Formular und ein serverseitiges Sitzungs-Cookie –
bewusst kein JWT: eine Sitzung muss sich sofort widerrufen lassen (Konto
deaktivieren, Passwort geändert, „überall abmelden“), und dafür bräuchte ein
signiertes Token ohnehin die Tabelle, die man damit einsparen wollte.

### Rollen

| Rolle | Darf |
|---|---|
| **Administrator** | alles: Einstellungen, Benutzerverwaltung, manueller Versand, Protokoll |
| **Betrachter** | Dashboard und Abrechnungsvorschau lesen – keine Einstellungen, kein Versand, keine Empfängeradressen |

### Erster Start

Ist die Benutzertabelle leer, legt die Anwendung aus `AUTH_USER` / `AUTH_PASSWORD`
einen Administrator an. Danach ist die **Datenbank führend**: weitere Änderungen
an diesen Variablen bleiben wirkungslos, und nach dem Löschen des Kontos kommt es
auch nicht durch einen Neustart zurück.

### Konten anlegen

Unter *Benutzer → Benutzer anlegen*. Ohne Passwortangabe erzeugt die Anwendung
ein sicheres Startpasswort und zeigt es **genau einmal** an; beim ersten Anmelden
muss es geändert werden. Bis dahin sind alle anderen Seiten für dieses Konto
gesperrt.

### Schutzmaßnahmen

- **Passwörter** als scrypt-Hash (N=16384, r=8, p=1) mit Zufallssalz – kein natives Modul nötig, da scrypt in Node eingebaut ist.
- **Kontosperre** nach `AUTH_MAX_FAILED_ATTEMPTS` Fehlversuchen für `AUTH_LOCK_MINUTES` Minuten, zusätzlich ein IP-Rate-Limit auf der Login-Route.
- **Gleiche Fehlermeldung** für falsches Passwort und unbekanntes Konto; auch ohne Treffer wird gehasht, damit die Antwortzeit nichts verrät.
- **CSRF-Token** für jede schreibende Anfrage aus dem Browser.
- **Letzter Administrator** lässt sich weder löschen, deaktivieren noch herabstufen – sonst wäre die Anwendung nur noch per Datenbankeingriff erreichbar.
- **Protokoll** über Anmeldungen, Kontoänderungen, Einstellungsänderungen und Abrechnungsläufe (einsehbar unter *Benutzer*).

### Basic-Auth für Maschinen

`/api`-Routen akzeptieren zusätzlich Basic-Auth gegen dieselbe Benutzertabelle –
dafür ist der Docker-Healthcheck gedacht, ebenso Skripte und Monitoring. Da kein
Cookie im Spiel ist, entfällt hier der CSRF-Schutz. Abschaltbar über
`AUTH_ALLOW_BASIC_API=false` (dann schlägt allerdings der Healthcheck fehl).

```bash
curl -u admin:geheim http://localhost:3000/api/health
```

---

## Datenbank

Eine SQLite-Datei unter `DATABASE_FILE` (Standard: `data/wallbox.sqlite`).

| Tabelle | Inhalt |
|---|---|
| `users` | Konten, Rollen, Sperren, letzte Anmeldung |
| `sessions` | offene Sitzungen (gespeichert wird nur der SHA-256 des Cookies) |
| `settings` | Einstellungszweige als JSON, mit Zeitstempel und Urheber |
| `rfid_mappings` | Karten-Zuordnung, eindeutig über die normalisierte ID |
| `audit_log` | sicherheitsrelevante Vorgänge |
| `report_runs` | Historie der Abrechnungsläufe samt Ergebnis und Fehlermeldung |
| `schema_migrations` | angewandte Migrationen |

Warum `better-sqlite3` und nicht das eingebaute `node:sqlite`: letzteres ist in
Node 22 als experimentell markiert („might change at any time“) und auf Node 20
gar nicht vorhanden. `better-sqlite3` bringt fertige Binärpakete mit – ein
Compiler wird im Normalfall nicht gebraucht.

Beim Start laufen ausstehende Migrationen automatisch, in einer Transaktion.
WAL-Modus ist aktiv, damit das Dashboard lesen kann, während ein Report läuft.

### Übernahme aus der Dateiversion

Eine vorhandene `settings.json` wird beim ersten Start einmalig übernommen und
anschließend in `settings.json.migrated` umbenannt. Sie wird nicht gelöscht –
ein Rückbau auf die Dateiversion bliebe sonst unmöglich.

### Sicherung

```bash
# Konsistente Kopie im laufenden Betrieb (WAL-sicher):
docker compose exec wallbox-billing \
  sqlite3 /app/data/wallbox.sqlite ".backup '/app/data/backup.sqlite'"
```

Ohne `sqlite3` im Container genügt es, den Container kurz zu stoppen und die
Datei zu kopieren.

---

## Druckbares PDF

Der Beleg ist für den Ausdruck und das Abheften ausgelegt.

### Seitenränder

Voreinstellung in Millimetern, an DIN 5008 angelehnt:

| Rand | Wert | Grund |
|---|---|---|
| oben | 20 mm | |
| rechts | 20 mm | |
| unten | 20 mm | enthält die Fußzeile mit Seitenzahl |
| **links** | **25 mm** | Heftrand – beim Lochen geht nichts vom Inhalt verloren |

Änderbar unter *Einstellungen → Seitenränder des PDF*. Werte werden auf 5–60 mm
begrenzt, und zwar an zwei Stellen: in der API und noch einmal beim Rendern –
die Datenbank lässt sich auch von Hand bearbeiten.

Unter 10 mm wird abgeraten: handelsübliche Drucker können die äußersten rund
5 mm nicht bedrucken.

### Was sonst noch für den Druck getan wird

- **Tabellenköpfe wiederholen sich** auf jeder Folgeseite (`display: table-header-group`) – sonst stünde auf Seite 2 eine Zahlenkolonne ohne Beschriftung.
- **Zeilen werden nicht zerschnitten**, Überschriften stehen nie allein am Seitenende.
- **Die Fußzeile sitzt im unteren Rand**, aber mit Abstand zur Blattkante. Chromium platziert sie sonst rund 6 mm vom Rand – im nicht bedruckbaren Bereich, sie würde abgeschnitten.
- **Schlussrechnung, Hinweis und Fußtext bleiben zusammen** und wandern notfalls gemeinsam auf die nächste Seite, statt eine Zeile Kleingedrucktes allein auf ein Blatt zu schicken.
- **Keine externen Schriften** im PDF – Puppeteer rendert offline, ein nicht ladbarer Webfont würde das Layout verschieben.

Nachgemessen am erzeugten PDF (150 dpi, drei Seiten): 20,2 mm oben,
25,1 mm links, 20,2 mm rechts, Fußzeile 15,2 mm über der Blattkante.

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
| **Secrets & Infrastruktur** | `.env` / Container-Umgebung | SMTP-Zugang, Wallbox-Token, Ports, Cron-Zeitplan, Sitzungsparameter | Datei bzw. Ansible |
| **Fachliche Einstellungen** | SQLite (`settings`) | Preis, Empfänger, Stammdaten, Seitenränder, RFID-Zuordnung | WebUI |
| **Konten** | SQLite (`users`) | Benutzer, Rollen, Passwörter | WebUI |

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
│   │   └── index.js           ENV laden, typisieren, Pflichtfelder prüfen
│   ├── db/
│   │   ├── index.js           SQLite öffnen, Pragmas, Migrationen ausführen
│   │   └── schema.js          versionierte Migrationen
│   ├── repositories/
│   │   ├── userRepository.js      Konten, Rollen, Sperren, Anmeldung
│   │   ├── sessionRepository.js   Sitzungen (nur Token-Hash gespeichert)
│   │   ├── settingsRepository.js  Einstellungen + RFID, Migration aus JSON
│   │   ├── auditRepository.js     Protokoll
│   │   └── reportRunRepository.js Historie der Abrechnungsläufe
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
│   │   ├── views.js           HTML-Seiten
│   │   ├── auth.js            Anmeldung, Abmeldung, Passwortwechsel
│   │   └── users.js           Benutzerverwaltung (nur Administrator)
│   ├── middleware/
│   │   ├── auth.js            Sitzungen, Rollen, CSRF, Basic-Auth für /api
│   │   └── errorHandler.js    404, zentraler Fehlerhandler, asyncHandler
│   ├── jobs/scheduler.js      node-cron + Monatsletzter-Prüfung
│   └── utils/
│       ├── dates.js           Zeitzonen-korrekte Monatsgrenzen (ohne Fremd-Lib)
│       ├── password.js        scrypt-Hashing, Token, Passwortregeln
│       ├── rfid.js            RFID-Normalisierung (I/O-frei)
│       └── logger.js          Level-Logger ohne Abhängigkeit
├── views/
│   ├── dashboard.ejs          Live-Dashboard
│   ├── settings.ejs           Einstellungen (inkl. Seitenränder)
│   ├── users.ejs              Benutzerverwaltung und Protokoll
│   ├── login.ejs              Anmeldung
│   ├── password.ejs           Passwortwechsel, offene Sitzungen
│   ├── error.ejs
│   ├── partials/              head, nav, foot, icon (Inline-SVG)
│   └── pdf/invoice.hbs        PDF-Template (Druck-CSS, A4)
├── public/
│   ├── css/material.css       Material Design 3, selbst gehostet
│   └── js/                    material.js, dashboard.js, settings.js, users.js
├── tests/                     15 Suites, 370 Tests
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

| Methode | Pfad | Rolle | Zweck |
|---|---|---|---|
| `GET` | `/login` | – | Anmeldeformular |
| `POST` | `/login` | – | Anmelden |
| `POST` | `/logout` | angemeldet | Abmelden |
| `GET`/`POST` | `/passwort` | angemeldet | Eigenes Passwort ändern |
| `GET` | `/` | alle | Live-Dashboard |
| `GET` | `/einstellungen` | Admin | Einstellungsseite |
| `GET` | `/benutzer` | Admin | Benutzerverwaltung |
| `GET`/`POST` | `/api/users` | Admin | Konten lesen / anlegen |
| `PUT`/`DELETE` | `/api/users/:id` | Admin | Konto ändern / löschen |
| `POST` | `/api/users/:id/password` | Admin | Passwort zurücksetzen |
| `GET` | `/api/audit` | Admin | Protokoll |
| `GET` | `/api/live` | alle | **SSE-Stream** – Events `status` und `error` |
| `GET` | `/api/status` | alle | Einmaliger Zustandsabruf (Polling-Fallback) |
| `GET` | `/api/report?year=&month=` | alle | Report als JSON (Default: Vormonat) |
| `POST` | `/api/report/run` | Admin | PDF + CSV erzeugen, optional versenden |
| `GET` | `/api/report/files` | alle | Erzeugte Dateien auflisten |
| `GET` | `/api/report/files/:name` | alle | Datei herunterladen |
| `GET` | `/api/settings` | alle | Einstellungen lesen |
| `PUT` | `/api/settings` | Admin | Einstellungen schreiben (Whitelist) |
| `GET` | `/api/health` | alle | `200` = Wallbox erreichbar, `503` = nicht erreichbar |

Schreibende Anfragen aus dem Browser brauchen den Header `X-CSRF-Token` (das
Token steht im `<meta name="csrf-token">` jeder Seite). Bei Basic-Auth entfällt das.

Beispiel:

```bash
# Über Basic-Auth, ohne CSRF-Token:
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

- **Anmeldung vor allen Inhalten** – ohne Sitzung führt jede HTML-Route zur Anmeldeseite, jede `/api`-Route antwortet mit 401. Frei sind nur die Login-Route und die statischen Dateien, die sie zum Darstellen braucht.
- **Rollen pro Route**, nicht pro Router: der Administrator-Guard hängt an jeder Verwaltungsroute einzeln. Ein `router.use()` hätte – da der Router auf `/` liegt – die ganze Anwendung für Betrachter gesperrt.
- **Passwörter** als scrypt-Hash mit Zufallssalz; Vergleich timing-safe, auch bei unbekanntem Konto wird gehasht.
- **CSRF-Token** für jede zustandsändernde Anfrage aus dem Browser; bei Basic-Auth entfällt der Schutz, weil ohne Cookie kein fremder Ursprung eine authentifizierte Anfrage auslösen kann.
- **Sitzungen serverseitig** – widerrufbar, in der Datenbank liegt nur der SHA-256 des Cookies. Cookie ist `HttpOnly`, `SameSite=Lax` und über `SESSION_COOKIE_SECURE` auf HTTPS beschränkbar.
- **Start ohne Passwort wird verweigert** (`assertProductionSecrets`), ebenso fehlende Wallbox-Credentials im jeweiligen Auth-Modus.
- **CSP mit Nonce** – `script-src` erlaubt nur `'self'` und ein Per-Request-Nonce. Kein Fremd-Host, kein pauschales `'unsafe-inline'` für Skripte.
- **Helmet** für die übrigen Header, HSTS nur unter `NODE_ENV=production`.
- **Rate-Limit** vor der Authentifizierung (600 Anfragen / 15 min).
- **Whitelist-Validierung** in `PUT /api/settings`: Preis-Grenzen, E-Mail-Format, gültige IANA-Zeitzone, `http(s)`-Schema. Unbekannte Felder werden verworfen.
- **Path-Traversal-Schutz** beim Datei-Download: Basename-Vergleich, Endungs-Whitelist und Prüfung des aufgelösten Pfads gegen das Ausgabeverzeichnis.
- **HTML-Escaping** in PDF, E-Mail und Dashboard – RFID-Namen aus den Einstellungen sind Benutzereingaben.
- **Container läuft als `node`**, nicht als root; `cap_drop: ALL`, `no-new-privileges`.
- **Secrets nie in den Einstellungen** und nie in einer API-Antwort – dafür gibt es einen expliziten Test.
- **Passwort-Hashes verlassen die Datenschicht nicht**; die Repository-Funktionen geben ausschließlich eine Whitelist an Spalten heraus.

### Bewusste Kompromisse

- `PUPPETEER_NO_SANDBOX=true` im Container. Chromiums eigene Sandbox braucht Privilegien, die dem Container abgenommen wurden; die Isolation liefert hier der Container. Gerendert wird ausschließlich selbst erzeugtes HTML.
- Das Material-Stylesheet ist selbst gehostet statt per CDN eingebunden. Eine Wallbox-Appliance steht oft in einem Netz ohne Internetzugang; ein CDN-Ausfall würde die Oberfläche sonst unbrauchbar machen. Nebeneffekt: die CSP kommt ohne Fremd-Host im `script-src` aus. Roboto wird von Google Fonts nachgeladen, ist aber reine Verbesserung – ohne Netz greift der System-Zeichensatz.
- Icons sind Inline-SVG statt Icon-Schrift. Fällt eine Icon-Schrift aus, zeigt der Browser den Ligatur-Text („bolt“, „settings“) als sichtbare Wörter an.

---

## Tests

```bash
npm test               # 15 Suites, 370 Tests
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
| `config` | Pflichtfeld-Prüfung, Einstellungen in SQLite, Übernahme aus settings.json |
| `password` | scrypt-Hashing, Salting, kaputte Hashes, Passwortregeln, Token |
| `userRepository` | Anlegen, Rollen, Sperren, letzter Administrator, Bootstrap |
| `sessionRepository` | Token-Hashing, Ablauf, Widerruf, Aufräumen |
| `users.api` | Benutzerverwaltung über HTTP, Selbst-Aussperren, Protokoll |
| `app` | Anmeldung, Rollen, CSRF, erzwungener Passwortwechsel, Security-Header, Path-Traversal, SSE |

Die Wallbox wird durchgehend gemockt; Puppeteer ist in den Unit-Tests ersetzt.
Die Datenbank läuft im Arbeitsspeicher und wird vor jedem Test neu migriert, so
dass kein Test von einem anderen abhängt.

Zusätzlich manuell gegen echte Komponenten geprüft (nicht Teil von `npm test`):
Anmeldung und Rollen gegen einen echten Server, PDF-Erzeugung mit echtem
Chromium und Nachmessen der Seitenränder am gerasterten PDF.

---

## Deployment

### Docker

```bash
docker compose up -d --build
```

Das Image nutzt das **System-Chromium** aus den Debian-Paketquellen statt des
Puppeteer-Downloads: rund 300 MB kleiner und über den Paketmanager aktualisierbar.
`tini` läuft als PID 1 und räumt Chromium-Zombieprozesse ab.

Persistiert wird ausschließlich das Volume `wallbox-data` (`/app/data`) mit der
SQLite-Datenbank und den erzeugten Dateien. **Ohne dieses Volume sind nach einem
Neustart alle Konten und Einstellungen weg.**

Die Build-Werkzeuge für `better-sqlite3` (`python3`, `make`, `g++`) liegen nur in
der `deps`-Stufe und landen nicht im Laufzeit-Image. Im Normalfall werden sie
gar nicht gebraucht, weil ein fertiges Binärpaket existiert.

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
| Anmeldung schlägt ohne Fehlermeldung fehl | `SESSION_COOKIE_SECURE=true` ohne HTTPS – der Browser sendet das Cookie dann nicht. Auf `false` setzen oder TLS davorschalten |
| „Konto vorübergehend gesperrt" | Zu viele Fehlversuche. Warten (`AUTH_LOCK_MINUTES`) oder als anderer Administrator das Passwort zurücksetzen |
| Niemand kann sich mehr anmelden | Datenbankdatei sichern, Container stoppen, `wallbox.sqlite` beiseitelegen und neu starten: der Start-Administrator aus der `.env` wird dann neu angelegt |
| Inhalt am Blattrand abgeschnitten | Seitenränder unter *Einstellungen* erhöhen; unter 10 mm liegt der Rand im nicht bedruckbaren Bereich |
| Schrift wirkt anders als erwartet | Kein Zugriff auf Google Fonts; die Oberfläche nutzt dann den System-Zeichensatz und bleibt voll bedienbar |

Logs:

```bash
docker compose logs -f wallbox-billing
LOG_LEVEL=debug npm start          # ausführlicher lokal
```

---

## Lizenz

MIT
