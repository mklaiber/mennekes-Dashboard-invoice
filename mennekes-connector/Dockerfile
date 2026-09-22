ARG BUILD_FROM
FROM ${BUILD_FROM}

# Alpine-Basis von Home Assistant: bashio liegt bereits bereit, Node kommt dazu.
# npm wird nur zum Installieren gebraucht und danach wieder entfernt - das spart
# rund 60 MB auf einem Gerät, das oft nur eine SD-Karte hat.
RUN apk add --no-cache nodejs npm tzdata

ENV NODE_ENV=production

# Der HA-Builder reicht BUILD_VERSION (== version: aus config.yaml) automatisch
# durch - damit stimmt die Version in Startprotokoll und den
# Home-Assistant-Sensoren (Gerät "Firmware") auch nach einem Update.
ARG BUILD_VERSION
ENV CONNECTOR_VERSION=${BUILD_VERSION}

WORKDIR /opt/connector

COPY app/package.json app/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && apk del npm \
    && rm -rf /root/.npm /tmp/*

COPY app/ ./

COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
