'use strict';

const { normalizeRfid, rfidVariants, RfidLookup } = require('../src/utils/rfid');
const { resolveRfid } = require('../src/services/billing');

const MAX = { rfid: 'A1B2C3D4', name: 'Max Mustermann' };

describe('normalizeRfid', () => {
  it('entfernt Trennzeichen und vereinheitlicht die Schreibweise', () => {
    expect(normalizeRfid('04:A1-B2 c3')).toBe('04a1b2c3');
  });
});

describe('rfidVariants', () => {
  it('liefert die umgekehrte Byte-Reihenfolge ohne führende Nullen', () => {
    expect(rfidVariants('04A1B2C3')).toEqual(['4a1b2c3', 'c3b2a104']);
  });

  it('rechnet eine aufgedruckte Dezimalzahl in Hex um', () => {
    // 2712847316 = 0xA1B2C3D4
    expect(rfidVariants('2712847316')).toEqual(expect.arrayContaining(['a1b2c3d4', 'd4c3b2a1']));
  });

  it('kennt für eine UID aus lauter Nullen keine Karte', () => {
    expect(rfidVariants('00000000')).toEqual([]);
  });
});

describe('RfidLookup.find', () => {
  const lookup = new RfidLookup([MAX, { rfid: '04E5F6A7B8C9D0', name: 'Erika' }]);

  it.each([
    ['exakt', 'a1b2c3d4'],
    ['mit Trennzeichen', 'A1:B2:C3:D4'],
    ['umgekehrte Byte-Reihenfolge', 'D4C3B2A1'],
    ['mit Nullen aufgefüllt', '00000000A1B2C3D4'],
    ['umgekehrt und aufgefüllt', 'D4C3B2A100000000'],
    ['aufgedruckte Dezimalzahl', '2712847316'],
    ['Dezimalzahl der umgekehrten Reihenfolge', '3569595041'],
  ])('findet die Karte %s', (label, query) => {
    expect(lookup.find(query)).toBe(MAX);
  });

  it('findet eine 7-Byte-UID auch umgekehrt', () => {
    expect(lookup.find('D0C9B8A7F6E504').name).toBe('Erika');
  });

  it('liefert nichts für eine fremde Karte', () => {
    expect(lookup.find('deadbeef')).toBeUndefined();
    expect(lookup.find('')).toBeUndefined();
  });

  it('bevorzugt den exakten Treffer vor einer anderen Schreibweise', () => {
    const exact = { rfid: 'D4C3B2A1', name: 'Andere Karte' };
    const both = new RfidLookup([MAX, exact]);

    expect(both.find('d4c3b2a1')).toBe(exact);
    expect(both.find('a1b2c3d4')).toBe(MAX);
  });

  it('rät nicht, wenn eine Schreibweise auf zwei Karten passt', () => {
    const both = new RfidLookup([MAX, { rfid: 'D4C3B2A1', name: 'Andere Karte' }]);

    // Aufgefüllt passt sowohl zu A1B2C3D4 als auch (umgekehrt) zu D4C3B2A1.
    expect(both.find('00A1B2C3D4')).toBeUndefined();
  });

  it('bleibt eine Map mit den exakten, normalisierten Schlüsseln', () => {
    expect(lookup.get('a1b2c3d4')).toBe(MAX);
    expect(lookup.size).toBe(2);
  });
});

describe('resolveRfid', () => {
  it('ordnet eine Karte in anderer Schreibweise der Person zu', () => {
    const identity = resolveRfid('d4c3b2a1', new RfidLookup([MAX]));

    expect(identity.known).toBe(true);
    expect(identity.name).toBe('Max Mustermann');
  });

  it('nimmt für eine Karte ohne eigenen Namen die aktuelle Fahrzeugzuordnung', () => {
    const fleetCard = { rfid: 'A1B2C3D4', name: '', employeeName: 'Moritz', vehiclePlate: 'TUT-MK-100' };
    const identity = resolveRfid('a1b2c3d4', new RfidLookup([fleetCard]));

    expect(identity).toMatchObject({ name: 'Moritz', plate: 'TUT-MK-100', known: true });
  });

  it('nimmt in der Abrechnung die eingefrorene statt der aktuellen Zuordnung', () => {
    const fleetCard = { rfid: 'A1B2C3D4', name: '', employeeName: 'Neuer Fahrer', vehiclePlate: 'NEU-1' };
    const lookup = new RfidLookup([fleetCard]);

    expect(resolveRfid('a1b2c3d4', lookup, { employeeName: 'Alter Fahrer', vehiclePlate: 'ALT-1' }))
      .toMatchObject({ name: 'Alter Fahrer', plate: 'ALT-1' });
    // Ohne eingefrorene Zuordnung bleibt ein Vorgang vor der Zuordnung unbekannt.
    expect(resolveRfid('a1b2c3d4', lookup, { employeeName: '', vehiclePlate: '' }).name)
      .toBe('Unbekannt (a1b2c3d4)');
  });

  it('arbeitet mit einer schlichten Map weiterhin exakt', () => {
    const lookup = new Map([['a1b2c3d4', MAX]]);

    expect(resolveRfid('A1:B2:C3:D4', lookup).known).toBe(true);
    expect(resolveRfid('d4c3b2a1', lookup).known).toBe(false);
  });
});
