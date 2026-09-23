'use strict';

/**
 * Karten an der Wallbox anlernen.
 *
 * Die Wallbox hat bereits einen Kartenleser - genau den, dessen ID spaeter
 * abgerechnet wird. Anlernen hier heisst deshalb: "die naechste noch
 * unbekannte Karte, die an der Wallbox auftaucht, gehoert zu Fahrzeug X".
 * Damit gibt es kein Formatproblem zwischen zwei verschiedenen Lesern, und es
 * funktioniert mit jedem Handy, auch ohne NFC.
 *
 * Die Wallbox gibt die ID allerdings nur WAEHREND eines Ladevorgangs heraus
 * (Bender-Register 720-729: "When a charging session is not in progress ...
 * these registers contain all ASCII-whitespaces"). Der Ablauf ist also:
 * Anlernen starten, Karte vorhalten, Auto anstecken.
 */

const { db, now } = require('../db');
const fleet = require('./fleetRepository');
const { normalizeRfid } = require('../utils/rfid');
const logger = require('../utils/logger');

/** Lange genug, um zum Auto zu gehen und anzustecken; kurz genug, um nicht zu vergessen. */
const LEARN_MINUTES = 15;

function row() {
  return db().prepare(`
    SELECT l.vehicle_id AS vehicleId, l.armed_by AS armedBy, l.armed_at AS armedAt,
           l.expires_at AS expiresAt, l.captured_rfid AS capturedRfid,
           l.captured_at AS capturedAt, l.notice, v.plate AS vehiclePlate
      FROM card_learning l
      LEFT JOIN vehicles v ON v.id = l.vehicle_id
     WHERE l.id = 1
  `).get();
}

/**
 * Aktueller Zustand, so wie ihn die Oberflaeche braucht.
 * @returns {{armed:boolean, vehicleId:number|null, vehiclePlate:string, expiresAt:string|null,
 *            capturedRfid:string|null, capturedAt:string|null, notice:string, armedBy:string}}
 */
function status() {
  const r = row();
  const armed = Boolean(
    r.expiresAt && !r.capturedRfid && r.vehicleId && new Date(r.expiresAt) > new Date()
  );
  return {
    armed,
    vehicleId: r.vehicleId ?? null,
    vehiclePlate: r.vehiclePlate || '',
    expiresAt: r.expiresAt,
    capturedRfid: r.capturedRfid,
    capturedAt: r.capturedAt,
    notice: r.notice,
    armedBy: r.armedBy,
  };
}

/**
 * Startet das Anlernen fuer ein Fahrzeug. Ein laufender Anlernvorgang fuer
 * ein anderes Fahrzeug wird dabei ersetzt - es gibt nur eine Wallbox.
 *
 * @param {number} vehicleId
 * @param {string} username
 * @returns {object} neuer Zustand
 */
function arm(vehicleId, username) {
  const ts = new Date();
  db().prepare(`
    UPDATE card_learning
       SET vehicle_id = @vehicleId, armed_by = @username, armed_at = @armedAt,
           expires_at = @expiresAt, captured_rfid = NULL, captured_at = NULL, notice = ''
     WHERE id = 1
  `).run({
    vehicleId,
    username: String(username || '').slice(0, 64),
    armedAt: ts.toISOString(),
    expiresAt: new Date(ts.getTime() + LEARN_MINUTES * 60_000).toISOString(),
  });
  return status();
}

/** Beendet das Anlernen ohne Ergebnis. */
function cancel() {
  db().prepare(`
    UPDATE card_learning SET expires_at = NULL, notice = '' WHERE id = 1
  `).run();
  return status();
}

function note(text) {
  db().prepare('UPDATE card_learning SET notice = ? WHERE id = 1').run(String(text).slice(0, 300));
}

/**
 * Prueft eine an der Wallbox gesehene Karten-ID gegen den Anlernmodus.
 *
 * Wird aus dem Status-Takt UND vor dem Speichern eingehender Ladevorgaenge
 * aufgerufen - in dieser Reihenfolge, damit schon der erste Ladevorgang mit
 * der neuen Zuordnung eingefroren wird.
 *
 * @param {string|null} rawRfid
 * @returns {{captured:boolean}}
 */
function tryCapture(rawRfid) {
  const rfid = normalizeRfid(rawRfid);
  if (!rfid || rfid === 'unbekannt' || rfid === 'anon') return { captured: false };

  const current = status();
  if (!current.armed) return { captured: false };

  // Freies Laden ohne Karte: die Wallbox meldet einen festen Wert. Den einem
  // Dienstwagen zuzuschlagen, hiesse jede kartenlose Ladung dieser Firma zu
  // berechnen - das waere genau der Fehler, den der Anlernmodus nicht machen
  // darf. Anlernen bleibt deshalb aktiv.
  if (fleet.isFreeCharging(rfid, fleet.cardKind(rfid))) {
    note('Laden ohne Karte erkannt - wird nicht angelernt. Bitte mit der Karte laden.');
    return { captured: false };
  }

  // Eine Karte, die schon einem Fahrzeug gehoert, wird NICHT stillschweigend
  // umgebucht. Sonst genuegte es, dass waehrend des Anlernens zufaellig
  // jemand anderes mit seiner Karte laedt.
  const owner = fleet.resolveAttribution(rfid);
  if (owner.vehicleId) {
    if (owner.vehicleId === current.vehicleId) {
      note(`Karte ${rfid} ist diesem Fahrzeug bereits zugeordnet.`);
    } else {
      note(`Karte ${rfid} gehört bereits zu ${owner.vehiclePlate} und wurde nicht umgebucht.`);
    }
    return { captured: false };
  }

  // Rueckwirkend: fruehere Ladevorgaenge derselben Karte ohne Zuordnung
  // werden mit uebernommen - wer die Karte anlernt, sagt damit, wem sie gehoert.
  const result = fleet.assignCardToVehicle(rfid, current.vehicleId, { backfill: true });
  if (!result.assigned) return { captured: false };

  const ts = now();
  db().prepare(`
    UPDATE card_learning SET captured_rfid = ?, captured_at = ?, notice = '' WHERE id = 1
  `).run(rfid, ts);

  logger.info(`Anlernmodus: Karte ${rfid} dem Fahrzeug ${current.vehiclePlate} zugeordnet.`);
  return { captured: true, rfid, backfilled: result.backfilled };
}

module.exports = { status, arm, cancel, tryCapture, LEARN_MINUTES };
