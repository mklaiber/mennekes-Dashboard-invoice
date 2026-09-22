#!/usr/bin/with-contenv bashio
# =============================================================================
#  Startskript des Add-ons.
#
#  Übersetzt die Home-Assistant-Optionen in Umgebungsvariablen und startet den
#  Connector. bashio::config liest aus /data/options.json.
# =============================================================================
set -e

export WALLBOX_PROTOCOL="$(bashio::config 'wallbox_protocol')"
export WALLBOX_URL="$(bashio::config 'wallbox_url')"
export WALLBOX_MODBUS_PORT="$(bashio::config 'wallbox_modbus_port')"
export WALLBOX_MODBUS_UNIT_ID="$(bashio::config 'wallbox_modbus_unit_id')"
export WALLBOX_AUTH_MODE="$(bashio::config 'wallbox_auth_mode')"
export WALLBOX_USERNAME="$(bashio::config 'wallbox_username')"
export WALLBOX_PASSWORD="$(bashio::config 'wallbox_password')"
export WALLBOX_TOKEN="$(bashio::config 'wallbox_token')"
export WALLBOX_AUTH_QUERY_PARAM="$(bashio::config 'wallbox_auth_query_param')"
export WALLBOX_VERIFY_TLS="$(bashio::config 'wallbox_verify_tls')"
export WALLBOX_SESSIONS_PROTOCOL="$(bashio::config 'wallbox_sessions_protocol')"

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

export MQTT_HOST="$(bashio::config 'mqtt_host')"
export MQTT_PORT="$(bashio::config 'mqtt_port')"
export MQTT_USERNAME="$(bashio::config 'mqtt_username')"
export MQTT_PASSWORD="$(bashio::config 'mqtt_password')"
export MQTT_SSL="$(bashio::config 'mqtt_ssl')"
export MQTT_DISCOVERY_PREFIX="$(bashio::config 'mqtt_discovery_prefix')"
export MQTT_NODE_ID="$(bashio::config 'mqtt_node_id')"
export MQTT_DEVICE_NAME="$(bashio::config 'mqtt_device_name')"

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
bashio::log.info "Wallbox:     ${WALLBOX_URL} (${WALLBOX_PROTOCOL})"
bashio::log.info "Ziel:        ${TARGET_URL}"
bashio::log.info "Takt:        Status alle ${STATUS_INTERVAL_SECONDS}s, Historie alle ${SESSIONS_INTERVAL_SECONDS}s"
if [ -n "${MQTT_HOST}" ] && [ "${MQTT_HOST}" != "null" ]; then
  bashio::log.info "MQTT:        ${MQTT_HOST}:${MQTT_PORT} (Home-Assistant-Sensoren aktiv)"
else
  bashio::log.info "MQTT:        nicht konfiguriert (keine Home-Assistant-Sensoren)"
fi

exec node /opt/connector/index.js
