/**
 * Dashboard-Frontend.
 *
 * Bezieht Live-Daten über Server-Sent Events (/api/live) und die
 * Monatsvorschau über /api/report. Bewusst ohne Framework - der
 * Funktionsumfang rechtfertigt kein Build-Setup.
 */
(function dashboard() {
  'use strict';

  var boot = {};
  try {
    boot = JSON.parse(document.getElementById('bootstrap-data').textContent) || {};
  } catch (error) {
    boot = {};
  }

  var LOCALE = boot.locale || 'de-DE';
  var CURRENCY = boot.currency || 'EUR';
  var SPARK_POINTS = 60; // ~5 Minuten bei 5s-Intervall

  var $ = function (id) { return document.getElementById(id); };

  var numberFmt = function (value, digits) {
    return new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(Number.isFinite(value) ? value : 0);
  };

  var moneyFmt = function (value) {
    return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY })
      .format(Number.isFinite(value) ? value : 0);
  };

  /* ------------------------------------------------------------------ Status */

  // Farbschema je Wallbox-Zustand: Klassen für Pille, Punkt und Puls-Ring.
  var STATUS_STYLES = {
    charging:  { pill: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300', dot: 'bg-emerald-400', ping: 'bg-emerald-400 animate-pulse-ring opacity-75' },
    connected: { pill: 'border-sky-500/40 bg-sky-500/10 text-sky-300',             dot: 'bg-sky-400',     ping: 'opacity-0' },
    standby:   { pill: 'border-slate-500/40 bg-slate-500/10 text-slate-300',       dot: 'bg-slate-400',   ping: 'opacity-0' },
    error:     { pill: 'border-red-500/40 bg-red-500/10 text-red-300',             dot: 'bg-red-400',     ping: 'bg-red-400 animate-pulse-ring opacity-75' },
    offline:   { pill: 'border-slate-700 bg-slate-800/50 text-slate-400',          dot: 'bg-slate-600',   ping: 'opacity-0' },
    unknown:   { pill: 'border-slate-700 bg-slate-800/50 text-slate-400',          dot: 'bg-slate-600',   ping: 'opacity-0' },
  };

  var powerHistory = [];

  function renderStatus(state) {
    var style = STATUS_STYLES[state.status] || STATUS_STYLES.unknown;

    $('status-pill').className = 'relative inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold ' + style.pill;
    $('status-dot').className = 'relative inline-flex h-2.5 w-2.5 rounded-full ' + style.dot;
    $('status-ping').className = 'absolute inline-flex h-full w-full rounded-full ' + style.ping;
    $('status-label').textContent = state.statusLabel || 'Unbekannt';

    $('status-updated').textContent = 'Stand: ' + new Date(state.timestamp).toLocaleTimeString(LOCALE, {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    $('power-value').textContent = numberFmt(state.powerKw, state.powerKw >= 10 ? 1 : 2);

    $('power-detail').textContent = state.status === 'charging'
      ? 'Fahrzeug lädt.'
      : (state.vehicleConnected ? 'Fahrzeug verbunden, kein Ladevorgang aktiv.' : 'Kein Fahrzeug verbunden.');

    $('rfid-name').textContent = state.rfidName || (state.rfidRaw ? 'Unbekannte Karte' : '–');
    $('rfid-id').textContent = state.rfidRaw || 'keine Karte erkannt';

    $('session-energy').textContent = state.energySessionKwh === null || state.energySessionKwh === undefined
      ? '–' : numberFmt(state.energySessionKwh, 2) + ' kWh';
    $('session-duration').textContent = state.sessionStart ? elapsed(state.sessionStart) : '–';
    $('current').textContent = state.currentA === null || state.currentA === undefined ? '–' : numberFmt(state.currentA, 1) + ' A';
    $('voltage').textContent = state.voltageV === null || state.voltageV === undefined ? '–' : numberFmt(state.voltageV, 0) + ' V';
    $('meter').textContent = state.meterKwh === null || state.meterKwh === undefined ? '–' : numberFmt(state.meterKwh, 1) + ' kWh';

    pushPower(state.powerKw);
    hideError();
  }

  /** Vergangene Zeit seit Sitzungsbeginn als "1:23 h". */
  function elapsed(startIso) {
    var seconds = Math.max(0, (Date.now() - new Date(startIso).getTime()) / 1000);
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    return hours + ':' + String(minutes).padStart(2, '0') + ' h';
  }

  /* --------------------------------------------------------------- Sparkline */

  function pushPower(value) {
    powerHistory.push(Number.isFinite(value) ? value : 0);
    if (powerHistory.length > SPARK_POINTS) powerHistory.shift();
    drawSparkline();
  }

  function drawSparkline() {
    var width = 600;
    var height = 100;
    var line = $('spark-line');
    var area = $('spark-area');
    var hint = $('spark-hint');
    if (!line) return;

    // Unter zwei Messwerten gibt es keinen Verlauf zu zeichnen - statt einer
    // leeren Flaeche bleibt der Hinweis stehen.
    if (powerHistory.length < 2) {
      if (hint) hint.classList.remove('hidden');
      return;
    }
    if (hint) hint.classList.add('hidden');

    // Skala mit Mindesthöhe, damit eine Null-Linie nicht am oberen Rand klebt.
    var max = Math.max.apply(null, powerHistory);
    var scaleMax = Math.max(max, 1);
    var step = width / (powerHistory.length - 1);

    var points = powerHistory.map(function (value, index) {
      var x = index * step;
      var y = height - (value / scaleMax) * (height - 6) - 3;
      return x.toFixed(1) + ',' + y.toFixed(1);
    });

    line.setAttribute('d', 'M' + points.join(' L'));
    area.setAttribute('d', 'M0,' + height + ' L' + points.join(' L') + ' L' + width + ',' + height + ' Z');

    $('spark-window').textContent = String(powerHistory.length);
    $('spark-max').textContent = numberFmt(max, 1);
  }

  /* ------------------------------------------------------------------ Fehler */

  function showError(message) {
    $('error-message').textContent = message;
    $('error-banner').classList.remove('hidden');
  }

  function hideError() {
    $('error-banner').classList.add('hidden');
  }

  function setConnection(state, text) {
    var colors = { live: 'bg-emerald-400', retry: 'bg-amber-400', down: 'bg-red-400', idle: 'bg-slate-500' };
    $('connection-dot').className = 'h-2 w-2 rounded-full ' + (colors[state] || colors.idle);
    $('connection-text').textContent = text;
    $('connection-text').className = state === 'live' ? 'text-emerald-300' : 'text-slate-400';
  }

  /* --------------------------------------------------------------------- SSE */

  function connect() {
    // EventSource reconnectet selbständig - wir spiegeln den Zustand nur in der UI.
    var source = new EventSource('/api/live');

    source.addEventListener('open', function () {
      setConnection('live', 'Live verbunden');
    });

    source.addEventListener('status', function (event) {
      try {
        renderStatus(JSON.parse(event.data));
        setConnection('live', 'Live verbunden');
      } catch (error) {
        /* Defektes Frame ignorieren - das nächste kommt in Sekunden. */
      }
    });

    source.addEventListener('error', function (event) {
      // Zwei Fälle: Nutzlast-Fehler (Wallbox nicht erreichbar) oder Transportfehler.
      if (event && typeof event.data === 'string') {
        try {
          showError(JSON.parse(event.data).message || 'unbekannter Fehler');
        } catch (parseError) {
          showError('unbekannter Fehler');
        }
        setConnection('retry', 'Wallbox antwortet nicht');
        return;
      }
      setConnection(source.readyState === EventSource.CLOSED ? 'down' : 'retry',
        source.readyState === EventSource.CLOSED ? 'Verbindung getrennt' : 'Verbinde neu …');
    });
  }

  /* ---------------------------------------------------------- Monatsvorschau */

  function fillPeriodSelect() {
    var select = $('period');
    var now = new Date();
    var options = [];

    // Letzte 12 Monate, beginnend mit dem laufenden.
    for (var offset = 0; offset < 12; offset += 1) {
      var date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      options.push({
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        label: date.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' }),
      });
    }

    select.innerHTML = options.map(function (option) {
      return '<option value="' + option.year + '-' + option.month + '">' + option.label + '</option>';
    }).join('');

    // Vormonat vorauswählen - das ist der typische Abrechnungsfall.
    select.selectedIndex = Math.min(1, options.length - 1);
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function loadReport() {
    var parts = $('period').value.split('-');
    $('report-loading').classList.remove('hidden');
    $('report-loading').textContent = 'Lade Abrechnungsdaten …';
    $('report-content').classList.add('hidden');

    fetch('/api/report?year=' + parts[0] + '&month=' + parts[1], { headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(renderReport)
      .catch(function (error) {
        $('report-loading').textContent = 'Abrechnungsdaten konnten nicht geladen werden (' + error.message + ').';
      });
  }

  function renderReport(report) {
    $('kpi-energy').textContent = numberFmt(report.totals.energyKwh, 2);
    $('kpi-sessions').textContent = report.totals.sessionCount;
    $('kpi-duration').textContent = report.totals.duration;
    $('kpi-cost').textContent = moneyFmt(report.totals.billableCost);

    $('report-rows').innerHTML = report.groups.length === 0
      ? '<tr><td colspan="6" class="px-4 py-8 text-center text-slate-500">Keine Ladevorgänge in diesem Monat.</td></tr>'
      : report.groups.map(function (group) {
        var badge = group.knownRfid ? ''
          : ' <span class="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">nicht zugeordnet</span>';
        var plate = group.plate ? '<div class="text-xs text-slate-500">' + escapeHtml(group.plate) + '</div>' : '';
        return '<tr class="hover:bg-white/[.03]">'
          + '<td class="px-4 py-2.5"><span class="font-medium">' + escapeHtml(group.name) + '</span>' + badge + plate + '</td>'
          + '<td class="px-4 py-2.5 font-mono text-xs text-slate-400">' + escapeHtml(group.rfidRaw || group.rfid) + '</td>'
          + '<td class="px-4 py-2.5 text-right tabular-nums">' + group.sessionCount + '</td>'
          + '<td class="px-4 py-2.5 text-right tabular-nums">' + escapeHtml(group.duration) + '</td>'
          + '<td class="px-4 py-2.5 text-right tabular-nums">' + numberFmt(group.energyKwh, 2) + ' kWh</td>'
          + '<td class="px-4 py-2.5 text-right font-semibold tabular-nums">' + moneyFmt(group.cost) + '</td>'
          + '</tr>';
      }).join('');

    $('report-loading').classList.add('hidden');
    $('report-content').classList.remove('hidden');
  }

  /* -------------------------------------------------------------------- Init */

  if (boot.initialState) renderStatus(boot.initialState);
  setConnection('idle', 'Verbinde …');
  connect();

  fillPeriodSelect();
  loadReport();
  $('period').addEventListener('change', loadReport);
  $('reload-report').addEventListener('click', loadReport);
}());
