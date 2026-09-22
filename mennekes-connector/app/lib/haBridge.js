'use strict';

/**
 * Home-Assistant-Anbindung über MQTT Discovery.
 *
 * Bewusst KEINE eigene Deutung der Wallbox-Rohdaten hier: veröffentlicht wird
 * der Zustand, den das Online-Tool beim Entgegennehmen bereits normalisiert
 * hat (siehe uplink.js). Sonst müsste die Interpretation der Wallbox-Felder -
 * Statuscodes, Watt-vs-kW, RFID-Zuordnung - an zwei Stellen gepflegt werden,
 * und beide liefen über kurz oder lang auseinander.
 *
 * Diese Datei enthält ausschließlich Themen, Payloads und die
 * Discovery-Struktur - keine Netzwerklogik. Der Publisher kommt von außen
 * (siehe lib/mqttClient.js), damit sich die Logik hier ohne echten Broker
 * testen lässt: ein Fake-Publisher genügt.
 */

/**
 * Entity-Definitionen: object_id -> Discovery-Zusatzfelder.
 *
 * Alle Entities teilen sich EIN JSON-Zustandsthema (siehe stateTopic) statt
 * je Entity ein eigenes - das erspart bei jedem Takt sieben zusätzliche
 * MQTT-Veröffentlichungen. `value_template` greift sich das passende Feld
 * heraus.
 *
 * @returns {Array<{objectId:string, component:'sensor'|'binary_sensor', config:object}>}
 */
function entityDefinitions() {
  return [
    {
      objectId: 'power',
      component: 'sensor',
      config: {
        name: 'Ladeleistung',
        device_class: 'power',
        unit_of_measurement: 'kW',
        state_class: 'measurement',
        icon: 'mdi:ev-station',
        value_template: '{{ value_json.powerKw }}',
      },
    },
    {
      objectId: 'status',
      component: 'sensor',
      config: {
        name: 'Status',
        icon: 'mdi:state-machine',
        value_template: '{{ value_json.statusLabel }}',
      },
    },
    {
      objectId: 'charging',
      component: 'binary_sensor',
      config: {
        name: 'Lädt',
        device_class: 'battery_charging',
        payload_on: 'true',
        payload_off: 'false',
        value_template: "{{ 'true' if value_json.status == 'charging' else 'false' }}",
      },
    },
    {
      objectId: 'vehicle_connected',
      component: 'binary_sensor',
      config: {
        name: 'Fahrzeug verbunden',
        device_class: 'plug',
        payload_on: 'true',
        payload_off: 'false',
        value_template: "{{ 'true' if value_json.vehicleConnected else 'false' }}",
      },
    },
    {
      objectId: 'session_energy',
      component: 'sensor',
      config: {
        name: 'Energie (Sitzung)',
        device_class: 'energy',
        unit_of_measurement: 'kWh',
        // 'measurement' statt 'total_increasing': der Wert beginnt mit jeder
        // neuen Ladesitzung wieder bei 0 - kein lebenslanger Zähler.
        state_class: 'measurement',
        value_template: '{{ value_json.energySessionKwh }}',
      },
    },
    {
      objectId: 'meter',
      component: 'sensor',
      config: {
        name: 'Zählerstand',
        device_class: 'energy',
        unit_of_measurement: 'kWh',
        // Lebenslanger, nur wachsender Zähler - kompatibel mit dem
        // Energie-Dashboard von Home Assistant.
        state_class: 'total_increasing',
        value_template: '{{ value_json.meterKwh }}',
      },
    },
    {
      objectId: 'current',
      component: 'sensor',
      config: {
        name: 'Strom',
        device_class: 'current',
        unit_of_measurement: 'A',
        state_class: 'measurement',
        value_template: '{{ value_json.currentA }}',
      },
    },
    {
      objectId: 'voltage',
      component: 'sensor',
      config: {
        name: 'Spannung',
        device_class: 'voltage',
        unit_of_measurement: 'V',
        state_class: 'measurement',
        value_template: '{{ value_json.voltageV }}',
      },
    },
    {
      objectId: 'active_card',
      component: 'sensor',
      config: {
        name: 'Aktive Ladekarte',
        icon: 'mdi:card-account-details',
        // Fällt auf die rohe RFID zurück, wenn keine Zuordnung hinterlegt ist -
        // dieselbe Regel wie im Web-Dashboard ("Unbekannt (…)").
        value_template: "{{ value_json.rfidName or value_json.rfidRaw or 'Keine Karte' }}",
      },
    },
    {
      objectId: 'rfid',
      component: 'sensor',
      config: {
        name: 'RFID',
        icon: 'mdi:tag-outline',
        entity_category: 'diagnostic',
        value_template: "{{ value_json.rfidRaw or 'keine' }}",
      },
    },
    {
      objectId: 'last_update',
      component: 'sensor',
      config: {
        name: 'Letzte Aktualisierung',
        device_class: 'timestamp',
        entity_category: 'diagnostic',
        value_template: '{{ value_json.timestamp }}',
      },
    },
  ];
}

/**
 * Berechnet die MQTT-Themen für einen Knoten, ohne eine Bridge-Instanz zu
 * benötigen. Gebraucht, um das Last-Will-Testament VOR dem Verbindungsaufbau
 * zu kennen (siehe mqttClient.js) - und hier als einzige Stelle, damit beide
 * Seiten nicht auseinanderlaufen können.
 *
 * @param {string} nodeId
 * @returns {{base:string, state:string, availability:string}}
 */
function topicsFor(nodeId) {
  const base = `mennekes_connector/${nodeId}`;
  return { base, state: `${base}/state`, availability: `${base}/availability` };
}

class HomeAssistantBridge {
  /**
   * @param {object} options
   * @param {string} options.nodeId eindeutiger Gerätename in MQTT-Themen (nur a-z0-9_)
   * @param {string} options.discoveryPrefix Standard 'homeassistant'
   * @param {string} options.deviceName Anzeigename des Geräts in Home Assistant
   * @param {string} [options.version] Connector-Version, erscheint als sw_version
   * @param {{publish: (topic:string, payload:string, opts?:object) => Promise<void>}} publisher
   * @param {object} [logger] mit info/warn/error/debug - Standard: console
   */
  constructor(options, publisher, logger) {
    this.nodeId = options.nodeId;
    this.prefix = options.discoveryPrefix;
    this.deviceName = options.deviceName;
    this.version = options.version || '';
    this.publisher = publisher;
    this.logger = logger || console;

    // Eigener Namensraum statt unter dem Discovery-Prefix: nur die
    // /config-Themen müssen dort liegen, damit Home Assistant sie einliest.
    // topicsFor() ist dieselbe Funktion, die mqttClient.js schon VOR dieser
    // Instanz für das Last-Will-Testament braucht - eine Quelle für die
    // Themennamen, damit beide nie auseinanderlaufen.
    const topics = topicsFor(this.nodeId);
    this.baseTopic = topics.base;
    this.stateTopic = topics.state;
    this.availabilityTopic = topics.availability;

    this._discoveryPublished = false;
  }

  /** @returns {object} Geräte-Objekt, das alle Entities zu einem Gerät bündelt */
  get device() {
    return {
      identifiers: [this.nodeId],
      name: this.deviceName,
      manufacturer: 'MENNEKES',
      model: 'Wallbox',
      sw_version: this.version,
    };
  }

  /**
   * @param {string} component 'sensor' | 'binary_sensor'
   * @param {string} objectId
   * @returns {string}
   */
  configTopic(component, objectId) {
    return `${this.prefix}/${component}/${this.nodeId}/${objectId}/config`;
  }

  /**
   * Veröffentlicht alle Discovery-Konfigurationen (retained, damit Home
   * Assistant die Entities auch nach einem eigenen Neustart sofort wieder
   * kennt, ohne dass der Connector erneut senden muss).
   * @returns {Promise<void>}
   */
  async publishDiscovery() {
    const definitions = entityDefinitions();

    for (const entity of definitions) {
      const payload = {
        name: entity.config.name,
        unique_id: `${this.nodeId}_${entity.objectId}`,
        state_topic: this.stateTopic,
        availability_topic: this.availabilityTopic,
        payload_available: 'online',
        payload_not_available: 'offline',
        device: this.device,
        ...entity.config,
      };

      await this.publisher.publish(
        this.configTopic(entity.component, entity.objectId),
        JSON.stringify(payload),
        { retain: true, qos: 1 }
      );
    }

    this._discoveryPublished = true;
    this.logger.info(`${definitions.length} Sensoren bei Home Assistant angemeldet (Gerät "${this.deviceName}").`);
  }

  /**
   * Veröffentlicht einen vom Online-Tool normalisierten Zustand.
   *
   * Meldet die Entities dabei implizit als verfügbar - ein erfolgreich
   * zugestellter Zustand ist der Beweis dafür.
   *
   * @param {object} state Rückgabewert von Uplink#sendStatus().normalized
   * @returns {Promise<void>}
   */
  async publishState(state) {
    if (!this._discoveryPublished) await this.publishDiscovery();

    await this.publisher.publish(this.stateTopic, JSON.stringify(state), { retain: false, qos: 0 });
    await this.setAvailable(true);
  }

  /**
   * Setzt die Verfügbarkeit explizit.
   *
   * Wird bei anhaltenden Fehlern (Wallbox oder Online-Tool nicht erreichbar)
   * auf false gesetzt, damit Home Assistant die letzten Werte als veraltet
   * kennzeichnet, statt sie unkommentiert stehen zu lassen.
   *
   * @param {boolean} online
   * @returns {Promise<void>}
   */
  async setAvailable(online) {
    await this.publisher.publish(this.availabilityTopic, online ? 'online' : 'offline', { retain: true, qos: 1 });
  }

  /**
   * Geordnetes Beenden: meldet "offline". Deckt den regulären Stopp ab: das
   * Last-Will-Testament des MQTT-Clients (siehe mqttClient.js) greift nur bei
   * einem harten Absturz, bei dem keine Nachricht mehr gesendet werden kann.
   * @returns {Promise<void>}
   */
  async close() {
    await this.setAvailable(false).catch((error) => {
      this.logger.warn(`Abmeldung bei Home Assistant fehlgeschlagen: ${error.message}`);
    });
  }
}

module.exports = { HomeAssistantBridge, entityDefinitions, topicsFor };
