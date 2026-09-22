/**
 * Frontend der Einstellungsseite.
 *
 * Schreibt über PUT /api/settings; die eigentliche Validierung passiert
 * serverseitig (siehe src/routes/api.js) - hier nur Bedienkomfort.
 * Nutzt die Helfer aus material.js (md.request, md.snackbar, md.confirm).
 */
(function settingsPage() {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = window.md.escapeHtml;
  /* ------------------------------------------------------------ Speichern */

  function splitList(value) {
    return String(value || '').split(/[,;\n]/)
      .map(function (entry) { return entry.trim(); })
      .filter(function (entry) { return entry.length > 0; });
  }

  function intOr(value, fallback) {
    var parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  $('settings-form').addEventListener('submit', function (event) {
    event.preventDefault();
    $('save-button').disabled = true;
    $('save-hint').textContent = 'Speichere …';

    var payload = {
      wallbox: {
        displayName: $('wallbox-displayName').value.trim(),
      },
      billing: {
        pricePerKwh: Number($('billing-pricePerKwh').value),
        currency: $('billing-currency').value.trim().toUpperCase(),
        timezone: $('billing-timezone').value.trim(),
        logoUrl: $('billing-logoUrl').value.trim(),
        margins: {
          top: intOr($('margin-top').value, 20),
          right: intOr($('margin-right').value, 20),
          bottom: intOr($('margin-bottom').value, 20),
          left: intOr($('margin-left').value, 25),
        },
      },
      mail: {
        from: $('mail-from').value.trim(),
        subjectPrefix: $('mail-subjectPrefix').value.trim(),
        to: splitList($('mail-to').value),
        cc: splitList($('mail-cc').value),
      },
      scheduler: {
        enabled: $('scheduler-enabled').checked,
        runPolicy: $('scheduler-runPolicy').value,
      },
    };

    window.md.request('/api/settings', { method: 'PUT', body: payload })
      .then(function () {
        window.md.snackbar('Einstellungen gespeichert.');
        $('save-hint').textContent = 'Zuletzt gespeichert: ' + new Date().toLocaleTimeString();
      })
      .catch(function (error) {
        window.md.snackbar('Speichern fehlgeschlagen: ' + error.message, { error: true });
        $('save-hint').textContent = '';
      })
      .finally(function () {
        $('save-button').disabled = false;
      });
  });

  /* -------------------------------------------------------- Manueller Lauf */

  $('run-button').addEventListener('click', function () {
    var button = $('run-button');
    var result = $('run-result');
    var sendMail = $('run-sendmail').checked;

    var proceed = sendMail
      ? window.md.confirm({
        title: 'Abrechnung versenden?',
        body: 'Die Abrechnung wird sofort per E-Mail an die konfigurierten Empfänger versendet.',
        confirmLabel: 'Versenden',
      })
      : Promise.resolve(true);

    proceed.then(function (confirmed) {
      if (!confirmed) return;

      button.disabled = true;
      button.textContent = 'Erzeuge …';
      result.className = 'md-banner md-banner--info';
      result.style.marginTop = '16px';
      result.innerHTML = '<div style="width:100%">'
        + '<div class="md-progress"><div class="md-progress__bar"></div></div>'
        + '<p class="md-body-s" style="margin:12px 0 0">PDF wird gerendert, das kann einige Sekunden dauern …</p>'
        + '</div>';
      result.classList.remove('hidden');

      window.md.request('/api/report/run', {
        method: 'POST',
        body: {
          year: Number($('run-year').value),
          month: Number($('run-month').value),
          sendMail: sendMail,
        },
      })
        .then(function (body) {
          result.className = 'md-banner md-banner--success';
          result.innerHTML = '<div>'
            + '<p class="md-label-l" style="margin:0">' + esc(body.period.label) + ' erzeugt.</p>'
            + '<p class="md-body-s" style="margin:6px 0 0">'
            + body.totals.sessionCount + ' Ladevorgänge, ' + body.totals.energyKwh + ' kWh'
            + (body.mail ? ' – E-Mail versendet an ' + esc(body.mail.to.join(', ')) : ' – kein Versand')
            + '</p>'
            + '<p class="md-body-s" style="margin:6px 0 0">Dateien: '
            + esc([body.files.pdf, body.files.csvDetail, body.files.csvSummary].join(', ')) + '</p>'
            + '<p class="md-body-s" style="margin:10px 0 0"><a href="/einstellungen">Seite neu laden</a>,'
            + ' um die Dateien in der Liste zu sehen.</p></div>';
          window.md.snackbar('Abrechnung erzeugt.');
        })
        .catch(function (error) {
          result.className = 'md-banner md-banner--error';
          result.textContent = 'Fehlgeschlagen: ' + error.message;
          window.md.snackbar('Erzeugung fehlgeschlagen.', { error: true });
        })
        .finally(function () {
          button.disabled = false;
          button.textContent = 'Jetzt erzeugen';
        });
    });
  });
}());
