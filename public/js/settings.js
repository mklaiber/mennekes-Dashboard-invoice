/**
 * Frontend der Einstellungsseite.
 *
 * Schreibt über PUT /api/settings; die eigentliche Validierung passiert
 * serverseitig (siehe src/routes/api.js) - hier nur Bedienkomfort.
 * Nutzt die Helfer aus material.js (md.request, md.snackbar, md.confirm).
 */
(function settingsPage() {
  'use strict';

  var boot = {};
  try {
    boot = JSON.parse(document.getElementById('bootstrap-settings').textContent) || {};
  } catch (error) {
    boot = {};
  }

  var $ = function (id) { return document.getElementById(id); };
  var esc = window.md.escapeHtml;
  var mappings = Array.isArray(boot.rfidMappings) ? boot.rfidMappings.slice() : [];

  /* -------------------------------------------------------- RFID-Tabelle */

  function field(name, index, value, placeholder, extraClass) {
    return '<input type="text" data-field="' + name + '" data-index="' + index + '"'
      + ' value="' + esc(value) + '" placeholder="' + esc(placeholder) + '"'
      + ' class="md-field__input ' + (extraClass || '') + '"'
      + ' style="min-height:44px;padding:10px 12px">';
  }

  function renderMappings() {
    var tbody = $('rfid-rows');
    tbody.innerHTML = mappings.map(function (entry, index) {
      return '<tr>'
        + '<td>' + field('rfid', index, entry.rfidRaw || entry.rfid, 'z. B. 04A1B2C3', 'md-mono') + '</td>'
        + '<td>' + field('name', index, entry.name, 'Max Mustermann', '') + '</td>'
        + '<td>' + field('plate', index, entry.plate, 'M-AB 1234', '') + '</td>'
        + '<td style="text-align:center">'
        + '<label class="md-check" style="justify-content:center">'
        + '<input type="checkbox" data-field="billable" data-index="' + index + '"'
        + (entry.billable !== false ? ' checked' : '') + '>'
        + '<span class="sr-only">Abrechenbar</span></label>'
        + '</td>'
        + '<td style="text-align:right">'
        + '<button type="button" class="md-icon-btn" data-remove="' + index + '"'
        + ' aria-label="Zuordnung entfernen" title="Entfernen"'
        + ' style="color:var(--md-error)">'
        + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">'
        + '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'
        + '</button></td>'
        + '</tr>';
    }).join('');

    $('rfid-empty').classList.toggle('hidden', mappings.length > 0);
  }

  // Delegierte Listener - die Zeilen werden neu gerendert, direkte wären weg.
  $('rfid-rows').addEventListener('input', function (event) {
    var name = event.target.getAttribute('data-field');
    var index = event.target.getAttribute('data-index');
    if (!name || index === null || name === 'billable') return;
    mappings[Number(index)][name === 'rfid' ? 'rfidRaw' : name] = event.target.value;
    if (name === 'rfid') mappings[Number(index)].rfid = event.target.value;
  });

  $('rfid-rows').addEventListener('change', function (event) {
    if (event.target.getAttribute('data-field') !== 'billable') return;
    mappings[Number(event.target.getAttribute('data-index'))].billable = event.target.checked;
  });

  $('rfid-rows').addEventListener('click', function (event) {
    var button = event.target.closest('[data-remove]');
    if (!button) return;
    mappings.splice(Number(button.getAttribute('data-remove')), 1);
    renderMappings();
  });

  $('add-rfid').addEventListener('click', function () {
    mappings.push({ rfid: '', rfidRaw: '', name: '', plate: '', billable: true });
    renderMappings();
    var inputs = $('rfid-rows').querySelectorAll('input[data-field="rfid"]');
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  });

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
        baseUrl: $('wallbox-baseUrl').value.trim(),
        displayName: $('wallbox-displayName').value.trim(),
      },
      billing: {
        pricePerKwh: Number($('billing-pricePerKwh').value),
        currency: $('billing-currency').value.trim().toUpperCase(),
        timezone: $('billing-timezone').value.trim(),
        employeeName: $('billing-employeeName').value.trim(),
        companyName: $('billing-companyName').value.trim(),
        vehiclePlate: $('billing-vehiclePlate').value.trim(),
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
      rfidMappings: mappings.filter(function (entry) {
        return String(entry.rfidRaw || entry.rfid || '').trim() !== '';
      }),
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

  renderMappings();
}());
