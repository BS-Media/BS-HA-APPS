#!/usr/bin/with-contenv bashio
bashio::log.info "Starting RC522 Reader (MQTT publisher)…"
node /app/index.js
