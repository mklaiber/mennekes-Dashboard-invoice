# K3s-Deployment-Brief: Online-Tool (Server)

Ziel: das Node.js-„Online-Tool" (Dashboard + Abrechnung) in ein bestehendes
k3s-Cluster deployen. **Nicht** Teil davon: der Connector bleibt unverändert
als Home-Assistant-Add-on im Heimnetz, kommuniziert nur per HTTPS mit dieser
k3s-Instanz (`/api/ingest/*`).

Repo: `github.com/mklaiber/mennekes-Dashboard-invoice`, Branch
`claude/mennekes-wallbox-billing-pr4wye`.

## App-Fakten

- Node 22, Express, better-sqlite3 (natives Modul), Puppeteer/Chromium (PDF).
- Port intern `3000`. Basis-Image `node:22-bookworm-slim`, läuft schon als
  `USER node` (nicht root). Start: `node src/server.js`, PID1 = tini
  (normales SIGTERM-Handling, kein Sonderfall für Graceful Shutdown).
- Persistenter Zustand komplett unter **einem** Pfad `/app/data` (SQLite-DB,
  `settings.json`, erzeugte PDF/CSV-Reports) → 1 PVC, ReadWriteOnce genügt.
- SQLite + In-Memory-Sessions → **replicas: 1, keine HPA.**
- Interner node-cron-Scheduler erledigt den Monatsreport selbst - kein
  zusätzlicher k8s CronJob nötig.

## Vorher: Image bauen + pushen

Kein Compose-Build in k3s - Image in eine cluster-erreichbare Registry
bringen (GHCR/Docker Hub/privat):
```
docker build -t <registry>/mennekes-wallbox-billing:<tag> .
docker push <registry>/mennekes-wallbox-billing:<tag>
```

## Pflicht-Env (als Secret)

```
DATA_SOURCE=connector
CONNECTOR_TOKEN=<openssl rand -hex 32>   # muss = target_token im HA-Add-on
AUTH_PASSWORD=<Start-Admin-Passwort>
PRICE_PER_KWH, MAIL_FROM, MAIL_TO, SMTP_HOST/PORT/... (Mailversand)
NODE_ENV=production
```
Vollständige, kommentierte Liste aller Variablen: `.env.example` im Repo.

## Gotchas (nicht in einem generischen Node-Deployment enthalten)

1. **Puppeteer braucht großes `/dev/shm`.** Docker-Compose setzt `shm_size:
   256mb`; k8s-Äquivalent: `emptyDir`-Volume mit `medium: Memory,
   sizeLimit: 256Mi` auf `/dev/shm` mounten. Ohne das crasht die PDF-Erzeugung.
2. **Healthcheck ist authentifiziert.** `Dockerfile` (HEALTHCHECK) und
   `docker-compose.yml` zeigen die exakte Prüfung: Basic Auth
   (AUTH_USER/AUTH_PASSWORD) gegen `GET /api/health`, 200 = ok - 1:1 als k8s
   `exec`-Probe übernehmbar. Einfachere Alternative ohne Secret im Probe:
   `httpGet` auf `/login` (200, unauthentifiziert, weniger aussagekräftig).
3. **`target_url` im Add-on muss `https://` sein** - verweigert sonst den
   Start. Also Ingress mit TLS (z. B. cert-manager), nicht nur HTTP.
4. **securityContext**: zusätzlich zu `USER node` im Image setzt
   Docker-Compose `cap_drop: ALL` + `no-new-privileges` - als
   `securityContext: {runAsNonRoot: true, capabilities: {drop: [ALL]},
   allowPrivilegeEscalation: false}` übernehmen.
5. `CONNECTOR_TOKEN` (Secret hier) muss exakt `target_token` im
   Home-Assistant-Add-on entsprechen - separate Komponente, nicht Teil
   dieses Deployments.

## Aufgabe für die Sitzung

1. Repo/Branch auschecken.
2. Image bauen + pushen.
3. Namespace, Secret (Werte oben), PVC, Deployment, Service, Ingress (TLS)
   anlegen.
4. Ingress-Hostname notieren → das wird der `target_url` im HA-Add-on.
5. Rollout/Logs/Health prüfen, kurzer Test gegen `/login`.
