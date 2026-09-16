# =============================================================================
#  Mennekes Wallbox Billing
#
#  Zwei Stufen:
#   1. `deps`    - nur Produktivabhängigkeiten installieren (gut cachebar)
#   2. `runtime` - schlankes Laufzeit-Image mit System-Chromium
#
#  Bewusst KEIN Chromium-Download durch Puppeteer: das von Alpine/Debian
#  gepflegte Paket bekommt Sicherheitsupdates über den Paketmanager und
#  spart ~300 MB im Image.
# =============================================================================

FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Puppeteer soll beim Install kein eigenes Chromium herunterladen.
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json* ./
# `npm ci` bei vorhandener Lockfile (reproduzierbar), sonst `npm install`.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi


# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Chromium samt Schriften - ohne Fonts rendert das PDF leere Kästen
# statt Text, und ohne die Emoji-/DejaVu-Fonts fehlen Sonderzeichen.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-dejavu-core \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_NO_SANDBOX=true \
    OUTPUT_DIR=/app/data/reports \
    SETTINGS_FILE=/app/data/settings.json

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts

# Datenverzeichnis anlegen und dem unprivilegierten node-User übergeben.
# Der Container läuft NICHT als root.
RUN mkdir -p /app/data/reports && chown -R node:node /app/data

USER node

EXPOSE 3000

# Healthcheck gegen den authentifizierten Endpunkt. AUTH_USER/AUTH_PASSWORD
# kommen aus der Container-Umgebung.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "const http=require('http');\
const auth=Buffer.from(`${process.env.AUTH_USER||'admin'}:${process.env.AUTH_PASSWORD||''}`).toString('base64');\
http.get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/api/health',headers:{Authorization:'Basic '+auth}},\
r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1));"

# tini als PID 1: reapt Chromium-Zombieprozesse und leitet SIGTERM korrekt weiter.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
