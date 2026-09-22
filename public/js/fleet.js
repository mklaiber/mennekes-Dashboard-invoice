/* Fuhrpark: Firmen, Mitarbeiter, Fahrzeuge und Kartenzuordnung. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // Die Dialoge stehen als Markup in der Vorlage - dort greifen Stile und
  // Symbole von selbst. Hier stehen nur die Felder, die je Typ zu fuellen
  // und wieder auszulesen sind.
  var TYPES = {
    vehicle: {
      endpoint: 'vehicles',
      titles: ['Fahrzeug anlegen', 'Fahrzeug bearbeiten'],
      fields: ['plate', 'label', 'companyId', 'employeeName', 'notes'],
      switches: ['active'],
    },
    company: {
      endpoint: 'companies',
      titles: ['Firma anlegen', 'Firma bearbeiten'],
      fields: ['name', 'address', 'contactEmail', 'pricePerKwh'],
      switches: ['ownReport', 'active'],
    },
  };

  function openDialog(type, value) {
    var spec = TYPES[type];
    var dialog = $(type + '-dialog');
    var error = $(type + '-dialog-error');
    var isEdit = Boolean(value);

    $(type + '-dialog-title').textContent = spec.titles[isEdit ? 1 : 0];
    error.classList.add('hidden');
    error.textContent = '';

    spec.fields.forEach(function (name) {
      var input = $(type + '-' + name);
      var current = value ? value[name] : undefined;
      input.value = current === null || current === undefined ? '' : String(current);

      // Ein <select> ohne passende Option steht danach auf selectedIndex -1
      // und zeigt ein LEERES Feld - beim Anlegen trifft das jede Auswahl, die
      // keine leere Option hat (etwa "Art"). Abgesendet wuerde dann ein leerer
      // Wert, den der Server still auf seine Vorgabe zieht: das Formular sieht
      // aus, als haette es funktioniert, zeigt aber nie, was gespeichert wird.
      if (input.tagName === 'SELECT' && input.selectedIndex === -1) input.selectedIndex = 0;
    });

    spec.switches.forEach(function (name) {
      var input = $(type + '-' + name);
      // Beim Anlegen ist "aktiv" und "eigener Bericht" die sinnvolle Vorgabe.
      input.checked = value ? Boolean(value[name]) : true;
    });

    // "Aktiv" ergibt beim Anlegen keinen Sinn - es gibt noch nichts
    // stillzulegen.
    var activeRow = $(type + '-active-row');
    if (activeRow) activeRow.classList.toggle('hidden', !isEdit);

    var panel = dialog.querySelector('.md-dialog__panel');
    var submit = panel.querySelector('[data-dialog-submit]');
    submit.disabled = false;

    panel.querySelector('[data-dialog-cancel]').onclick = function () { dialog.close(); };

    submit.onclick = function () {
      var payload = {};
      spec.fields.forEach(function (name) { payload[name] = $(type + '-' + name).value; });
      spec.switches.forEach(function (name) { payload[name] = $(type + '-' + name).checked; });

      submit.disabled = true;
      error.classList.add('hidden');

      var url = '/api/fleet/' + spec.endpoint + (isEdit ? '/' + value.id : '');
      window.md.request(url, { method: isEdit ? 'PUT' : 'POST', body: payload })
        .then(function () {
          dialog.close();
          window.location.reload();
        })
        .catch(function (err) {
          error.textContent = err.message;
          error.classList.remove('hidden');
          submit.disabled = false;
        });
    };

    dialog.showModal();
  }

  document.querySelectorAll('[data-new]').forEach(function (button) {
    button.addEventListener('click', function () {
      openDialog(button.getAttribute('data-new'), null);
    });
  });

  document.querySelectorAll('[data-edit]').forEach(function (button) {
    button.addEventListener('click', function () {
      var type = button.getAttribute('data-edit');
      var row = button.closest('tr');
      openDialog(type, JSON.parse(row.getAttribute('data-' + type)));
    });
  });

  /* -------------------------------------------------------- Ladekarten */

  document.querySelectorAll('[data-assign-submit]').forEach(function (button) {
    button.addEventListener('click', function () {
      var row = button.closest('tr');
      var rfid = row.getAttribute('data-card');
      var auswahl = row.querySelector('[data-assign-vehicle]');
      var vehicleId = auswahl.value ? Number(auswahl.value) : null;
      var rueckwirkend = row.querySelector('[data-assign-backfill]');

      button.disabled = true;
      window.md.request('/api/fleet/cards/' + encodeURIComponent(rfid) + '/assign', {
        method: 'POST',
        body: {
          vehicleId: vehicleId,
          backfill: Boolean(rueckwirkend && rueckwirkend.checked),
        },
      }).then(function (result) {
        window.md.snackbar(
          vehicleId === null
            ? 'Zuordnung gelöst.'
            : (result.backfilled
              ? 'Karte übernommen, ' + result.backfilled + ' Ladevorgang/Ladevorgänge zugeordnet.'
              : 'Karte übernommen.')
        );
        window.location.reload();
      }).catch(function (error) {
        window.md.snackbar(error.message);
        button.disabled = false;
      });
    });
  });

  // Der Schalter wirkt sofort - ein zusaetzliches "Speichern" fuer eine
  // einzelne Ja-Nein-Entscheidung waere nur ein weiterer Klick.
  document.querySelectorAll('[data-billable]').forEach(function (schalter) {
    schalter.addEventListener('change', function () {
      var rfid = schalter.closest('tr').getAttribute('data-card');
      schalter.disabled = true;

      window.md.request('/api/fleet/cards/' + encodeURIComponent(rfid), {
        method: 'PUT',
        body: { billable: schalter.checked },
      }).then(function () {
        window.md.snackbar(schalter.checked ? 'Karte wird abgerechnet.' : 'Karte wird nicht abgerechnet.');
        schalter.disabled = false;
      }).catch(function (error) {
        // Zurueckdrehen, damit der Schalter nicht etwas anderes zeigt als gilt.
        schalter.checked = !schalter.checked;
        schalter.disabled = false;
        window.md.snackbar(error.message);
      });
    });
  });
}());
