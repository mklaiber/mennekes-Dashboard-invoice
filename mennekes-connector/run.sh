#!/usr/bin/with-contenv bashio
# =============================================================================
#  Startskript des Add-ons.
#
#  Übersetzt die Home-Assistant-Optionen in Umgebungsvariablen und startet den
#  Connector. bashio::config liest aus /data/options.json.
# =============================================================================
set -e

export WALLBOX_URL="$(bashio::config 'wallbox_url')"
export WALLBOX_AUTH_MODE="$(bashio::config 'wallbox_auth_mode')"
export WALLBOX_USERNAME="$(bashio::config 'wallbox_username')"
export WALLBOX_PASSWORD="$(bashio::config 'wallbox_password')"
export WALLBOX_TOKEN="$(bashio::config 'wallbox_token')"
export WALLBOX_VERIFY_TLS="$(bashio::config 'wallbox_verify_tls')"

export ENDPOINT_STATUS="$(bashio::config 'endpoint_status')"
export ENDPOINT_SESSIONS="$(bashio::config 'endpoint_sessions')"
export ENDPOINT_METER="$(bashio::config 'endpoint_meter')"

export TARGET_URL="$(bashio::config 'target_url')"
export TARGET_TOKEN="$(bashio::config 'target_token')"
export VERIFY_TLS="$(bashio::config 'verify_tls')"

export STATUS_INTERVAL_SECONDS="$(bashio::config 'status_interval_seconds')"
export SESSIONS_INTERVAL_SECONDS="$(bashio::config 'sessions_interval_seconds')"
export HISTORY_DAYS="$(bashio::config 'history_days')"

export LOG_LEVEL="$(bashio::config 'log_level')"

# /data überlebt Neustarts und Add-on-Updates: dort liegt die Warteschlange.
export STATE_DIR="/data"

# Zeitzone von Home Assistant übernehmen, damit Zeitstempel im Log passen.
if bashio::supervisor.ping 2>/dev/null; then
  TZ_VALUE="$(bashio::info.timezone)"
  if [ -n "${TZ_VALUE}" ] && [ "${TZ_VALUE}" != "null" ]; then
    export TZ="${TZ_VALUE}"
  fi
fi

bashio::log.info "Starte Mennekes Wallbox Connector ..."
bashio::log.info "Wallbox:     ${WALLBOX_URL}"
bashio::log.info "Ziel:        ${TARGET_URL}"
bashio::log.info "Takt:        Status alle ${STATUS_INTERVAL_SECONDS}s, Historie alle ${SESSIONS_INTERVAL_SECONDS}s"

exec node /opt/connector/index.js
