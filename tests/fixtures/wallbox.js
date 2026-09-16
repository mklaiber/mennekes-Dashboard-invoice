'use strict';

/**
 * Nachgebildete Antworten der Mennekes REST-API.
 *
 * Bewusst in mehreren Ausprägungen: flach, verschachtelt (`data`), mit
 * Wattstunden statt kWh und mit Unix-Timestamps. Der Client muss alle
 * Varianten verarbeiten - genau das prüfen die Tests.
 */

/** Typische Status-Antwort während eines Ladevorgangs. */
const statusCharging = {
  status: 'Charging',
  power: 11.04,
  sessionEnergy: 8.42,
  meterReading: 4211.7,
  current: 16.1,
  voltage: 230,
  rfid: '04:A1:B2:C3',
  sessionStart: '2026-03-05T17:12:00.000Z',
};

/** Status im Leerlauf, verschachtelt unter `data`, Leistung in Watt. */
const statusStandbyNested = {
  data: {
    state: 'A',
    powerUnit: 'W',
    power: 0,
    meterReading: 4203.28,
  },
};

/** Status mit OCPP-Vokabular. */
const statusSuspended = {
  connectorStatus: 'SuspendedEV',
  activePower: 0,
  idTag: 'AABBCCDD',
};

/**
 * Historie mit drei Karten, davon eine unbekannte.
 * Enthält absichtlich einen Datensatz aus dem Vormonat (muss herausgefiltert werden)
 * und einen ohne Energiefeld (muss aus den Zählerständen berechnet werden).
 */
const sessionsMarch2026 = {
  transactions: [
    {
      id: 'tx-1001',
      startTime: '2026-03-02T06:30:00.000Z',
      endTime: '2026-03-02T09:45:00.000Z',
      energy: 24.5,
      idTag: '04:A1:B2:C3',
      meterStart: 4000.0,
      meterStop: 4024.5,
    },
    {
      id: 'tx-1002',
      startTime: '2026-03-11T18:05:00.000Z',
      endTime: '2026-03-11T22:20:00.000Z',
      // Kein Energiefeld -> muss aus meterStart/meterStop berechnet werden.
      idTag: '04A1B2C3',
      meterStart: 4024.5,
      meterStop: 4056.75,
    },
    {
      id: 'tx-1003',
      startTime: '2026-03-18T07:00:00.000Z',
      endTime: '2026-03-18T08:30:00.000Z',
      energyUnit: 'Wh',
      energy: 12250,
      idTag: 'AA-BB-CC-DD',
    },
    {
      id: 'tx-1004',
      // Unix-Timestamp in Sekunden.
      startTime: 1774252800,
      endTime: 1774260000,
      energy: 7.125,
      idTag: 'FFEE0011',
    },
    {
      // Vormonat - darf nicht in der März-Abrechnung landen.
      id: 'tx-0999',
      startTime: '2026-02-25T10:00:00.000Z',
      endTime: '2026-02-25T12:00:00.000Z',
      energy: 18.0,
      idTag: '04:A1:B2:C3',
    },
    {
      // Kaputter Datensatz ohne Start - muss verworfen werden.
      id: 'tx-broken',
      energy: 5,
      idTag: '04A1B2C3',
    },
  ],
};

/** RFID-Zuordnung passend zu den Fixtures. */
const rfidMappings = [
  { rfid: '04A1B2C3', name: 'Max Mustermann', plate: 'M-EV 1234', billable: true },
  { rfid: 'AABBCCDD', name: 'Erika Mustermann', plate: 'M-EV 5678', billable: true },
  // FFEE0011 ist bewusst NICHT gemappt -> "unbekannt" im Report.
];

module.exports = {
  statusCharging,
  statusStandbyNested,
  statusSuspended,
  sessionsMarch2026,
  rfidMappings,
};
