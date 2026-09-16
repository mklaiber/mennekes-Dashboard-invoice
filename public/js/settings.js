/**
 * Frontend der Einstellungsseite.
 *
 * Schreibt über PUT /api/settings; die eigentliche Validierung passiert
 * serverseitig (siehe src/routes/api.js) - hier nur UX.
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
  var mappings = Array.isArray(boot.rfidMappings) ? boot.rfidMappings.slice() : [];

  /* -------------------------------------------------------- RFID-Tabelle */

  function renderMappings() {
    var tbody = $('rfid-rows');
    tbody.innerHTML = '';

    mappings.forEach(function (entry, index) {
      var tr = document.createElement('tr');
      tr.className = 'border-t border-white/5';
      tr.innerHTML =
        '<td class="py-2 pr-2">' + input('rfid', index, entry.rfid, 'z. B. 04A1B2C3', 'font-mono') + '</td>'
        + '<td class="py-2 pr-2">' + input('name', index, entry.name, 'Max Mustermann', '') + '</td>'
        + '<td class="py-2 pr-2">' + input('plate', index, entry.plate, 'M-AB 1234', '') + '</td>'
        + '<td class="py-2 pr-2 text-center">'
        + '<input type="checkbox" data-field="billable" data-index="' + index + '"'
        + (entry.billable !== false ? ' checked' : '')
        + ' class="h-4 w-4 rounded border-white/20 bg-slate-900 text-emerald-500 focus:ring-emerald-500">'
        + '</td>'
        + '<td class="py-2 text-right">'
        + '<button type="button" data-remove="' + index + '"'
        + ' class="rounded-lg px-2 py-1 text-xs text-red-300 hover:bg-red-500/10" aria-label="Zuordnung entfernen">Entfernen</button>'
        + '</td>';
      tbody.appendChild(tr);
    });

    $('rfid-empty').classList.toggle('hidden', mappings.length > 0);
  }

  function escapeAttr(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function input(field, index, value, placeholder, extra) {
    return '<input type="text" data-field="' + field + '" data-index="' + index + '"'
      + ' value="' + escapeAttr(value) + '" placeholder="' + escapeAttr(placeholder) + '"'
      + ' class="w-full rounded-lg border border-white/10 bg-slate-950 px-2.5 py-1.5 text-sm '
      + extra + ' focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500">';
  }

  // Delegierte Listener - die Zeilen werden neu gerendert, direkte Listener wären weg.
  $('rfid-rows').addEventListener('input', function (event) {
    var field = event.target.getAttribute('data-field');
    var index = event.target.getAttribute('data-index');
    if (!field || index === null) return;
    mappings[Number(index)][field] = event.target.value;
  });

  $('rfid-rows').addEventListener('change', function (event) {
    if (event.target.getAttribute('data-field') !== 'billable') return;
    mappings[Number(event.target.getAttribute('data-index'))].billable = event.target.checked;
  });

  $('rfid-rows').addEventListener('click', function (event) {
    var index = event.target.getAttribute('data-remove');
    if (index === null) return;
    mappings.splice(Number(index), 1);
    renderMappings();
  });

  $('add-rfid').addEventListener('click', function () {
    mappings.push({ rfid: '', name: '', plate: '', billable: true });
    renderMappings();
    var inputs = $('rfid-rows').querySelectorAll('input[data-field="rfid"]');
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  });

  /* ------------------------------------------------------------ Speichern */

  function toast(kind, message) {
    var element = $('toast');
    element.className = 'mb-5 rounded-xl border px-4 py-3 text-sm ' + (kind === 'ok'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
      : 'border-red-500/30 bg-red-500/10 text-red-200');
    element.textContent = message;
    element.classList.remove('hidden');
    element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function splitList(value) {
    return String(value || '').split(/[,;\n]/).map(function (entry) { return entry.trim(); })
      .filter(function (entry) { return entry.length > 0; });
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
      },
      mail: {
        from: $('mail-from').value.trim(),
        subjectPrefix: $('mail-subjectPrefix').value.trim(),
        to: splitList($('mail-to').value),
        cc: splitList($('mail-cc').value),
      },
      rfidMappings: mappings.filter(function (entry) { return String(entry.rfid || '').trim() !== ''; }),
      scheduler: {
        enabled: $('scheduler-enabled').checked,
        runPolicy: $('scheduler-runPolicy').value,
      },
    };

    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw new Error(body.message || ('HTTP ' + response.status));
          return body;
        });
      })
      .then(function () {
        toast('ok', 'Einstellungen gespeichert.');
        $('save-hint').textContent = 'Zuletzt gespeichert: ' + new Date().toLocaleTimeString();
      })
      .catch(function (error) {
        toast('error', 'Speichern fehlgeschlagen: ' + error.message);
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

    if (sendMail && !window.confirm('Die Abrechnung wird sofort per E-Mail an die konfigurierten Empfänger versendet. Fortfahren?')) {
      return;
    }

    button.disabled = true;
    button.textContent = 'Erzeuge …';
    result.className = 'mt-4 rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-slate-300';
    result.textContent = 'PDF wird gerendert, das kann einige Sekunden dauern …';
    result.classList.remove('hidden');

    fetch('/api/report/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        year: Number($('run-year').value),
        month: Number($('run-month').value),
        sendMail: sendMail,
      }),
    })
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw new Error(body.message || ('HTTP ' + response.status));
          return body;
        });
      })
      .then(function (body) {
        result.className = 'mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200';
        result.innerHTML = '<p class="font-semibold">' + body.period.label + ' erzeugt.</p>'
          + '<p class="mt-1">' + body.totals.sessionCount + ' Ladevorgänge, '
          + body.totals.energyKwh + ' kWh'
          + (body.mail ? ' – E-Mail versendet an ' + body.mail.to.join(', ') : ' – kein Versand')
          + '.</p>'
          + '<p class="mt-2 text-xs">Dateien: ' + [body.files.pdf, body.files.csvDetail, body.files.csvSummary].join(', ') + '</p>'
          + '<p class="mt-2"><a class="underline" href="/einstellungen">Seite neu laden</a>, um die Dateien in der Liste zu sehen.</p>';
      })
      .catch(function (error) {
        result.className = 'mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200';
        result.textContent = 'Fehlgeschlagen: ' + error.message;
      })
      .finally(function () {
        button.disabled = false;
        button.textContent = 'Jetzt erzeugen';
      });
  });

  renderMappings();
}());
