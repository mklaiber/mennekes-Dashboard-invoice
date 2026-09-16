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

  // Farbschema je Wallbox-Zustand, ausgedrückt in Material-Farbrollen.
  var STATUS_STYLES = {
    charging:  { chip: 'md-chip md-chip--primary', color: 'var(--md-primary)',  pulse: true },
    connected: { chip: 'md-chip',                  color: 'var(--md-tertiary)', pulse: false },
    standby:   { chip: 'md-chip',                  color: 'var(--md-outline)',  pulse: false },
    error:     { chip: 'md-chip md-chip--error',   color: 'var(--md-error)',    pulse: true },
    offline:   { chip: 'md-chip',                  color: 'var(--md-outline)',  pulse: false },
    unknown:   { chip: 'md-chip',                  color: 'var(--md-outline)',  pulse: false },
  };

  var powerHistory = [];

  function renderStatus(state) {
    var style = STATUS_STYLES[state.status] || STATUS_STYLES.unknown;

    $('status-pill').className = style.chip;
    var dot = $('status-dot');
    dot.className = 'md-dot' + (style.pulse ? ' md-dot--pulse' : '');
    dot.style.color = style.color;
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
    var colors = {
      live:  'var(--md-primary)',
      retry: 'var(--md-warning)',
      down:  'var(--md-error)',
      idle:  'var(--md-outline)',
    };
    var chip = $('connection');
    chip.className = 'md-chip' + (state === 'live' ? ' md-chip--primary' : (state === 'down' ? ' md-chip--error' : ''));
    var dot = $('connection-dot');
    dot.className = 'md-dot' + (state === 'live' ? ' md-dot--pulse' : '');
    dot.style.color = colors[state] || colors.idle;
    $('connection-text').textContent = text;
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
    $('report-content').classList.add('hidden');

    fetch('/api/report?year=' + parts[0] + '&month=' + parts[1], { headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(renderReport)
      .catch(function (error) {
        $('report-loading').innerHTML = '<div class="md-banner md-banner--error">'
          + 'Abrechnungsdaten konnten nicht geladen werden: ' + escapeHtml(error.message) + '</div>';
      });
  }

  function renderReport(report) {
    $('kpi-energy').textContent = numberFmt(report.totals.energyKwh, 2);
    $('kpi-sessions').textContent = report.totals.sessionCount;
    $('kpi-duration').textContent = report.totals.duration;
    $('kpi-cost').textContent = moneyFmt(report.totals.billableCost);

    $('report-rows').innerHTML = report.groups.length === 0
      ? '<tr><td colspan="6" style="text-align:center;padding:40px 16px" class="md-on-surface-variant">'
        + 'Keine Ladevorgänge in diesem Monat.</td></tr>'
      : report.groups.map(function (group) {
        var badge = group.knownRfid ? ''
          : ' <span class="md-chip md-chip--warning md-chip--small">nicht zugeordnet</span>';
        var plate = group.plate
          ? '<div class="md-body-s md-on-surface-variant">' + escapeHtml(group.plate) + '</div>' : '';
        return '<tr>'
          + '<td><span class="md-label-l">' + escapeHtml(group.name) + '</span>' + badge + plate + '</td>'
          + '<td class="md-mono md-on-surface-variant">' + escapeHtml(group.rfidRaw || group.rfid) + '</td>'
          + '<td class="md-num">' + group.sessionCount + '</td>'
          + '<td class="md-num">' + escapeHtml(group.duration) + '</td>'
          + '<td class="md-num">' + numberFmt(group.energyKwh, 2) + ' kWh</td>'
          + '<td class="md-num"><span class="md-label-l">' + moneyFmt(group.cost) + '</span></td>'
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
