/* Fuhrpark: Firmen, Mitarbeiter, Fahrzeuge und Kartenzuordnung. */
(function () {
  'use strict';

  var data = JSON.parse(document.getElementById('fleet-data').textContent || '{}');
  var companies = data.companies || [];
  var employees = data.employees || [];

  /* ------------------------------------------------------------- Dialog */

  // Ein generischer Formulardialog statt drei fast gleicher <dialog>-Bloecke
  // im Markup: die drei Stammdatentypen unterscheiden sich nur in ihren
  // Feldern, nicht im Verhalten.
  function openForm(options) {
    var dialog = document.createElement('dialog');
    dialog.className = 'md-dialog';

    var form = document.createElement('form');
    form.method = 'dialog';

    var heading = document.createElement('h2');
    heading.className = 'md-title-m';
    heading.textContent = options.title;
    form.appendChild(heading);

    var error = document.createElement('div');
    error.className = 'md-banner md-banner--error';
    error.hidden = true;
    error.style.margin = '12px 0';
    form.appendChild(error);

    var inputs = {};
    options.fields.forEach(function (field) {
      var wrap = document.createElement('label');
      wrap.className = 'md-field';
      wrap.style.display = 'block';
      wrap.style.marginTop = '12px';

      var caption = document.createElement('span');
      caption.className = 'md-body-s';
      caption.textContent = field.label;
      wrap.appendChild(caption);

      var input;
      if (field.type === 'select') {
        input = document.createElement('select');
        input.className = 'md-select';
        field.options.forEach(function (option) {
          var element = document.createElement('option');
          element.value = option.value;
          element.textContent = option.label;
          input.appendChild(element);
        });
      } else if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.className = 'md-input';
        input.rows = 3;
      } else if (field.type === 'checkbox') {
        input = document.createElement('input');
        input.type = 'checkbox';
      } else {
        input = document.createElement('input');
        input.className = 'md-input';
        input.type = field.type || 'text';
      }

      input.style.width = field.type === 'checkbox' ? '' : '100%';
      if (field.placeholder) input.placeholder = field.placeholder;

      var current = options.value ? options.value[field.name] : undefined;
      if (field.type === 'checkbox') input.checked = current === undefined ? field.def !== false : !!current;
      else input.value = current === null || current === undefined ? '' : String(current);

      wrap.appendChild(input);
      if (field.hint) {
        var hint = document.createElement('span');
        hint.className = 'md-body-s md-on-surface-variant';
        hint.textContent = field.hint;
        wrap.appendChild(hint);
      }
      form.appendChild(wrap);
      inputs[field.name] = input;
    });

    var actions = document.createElement('div');
    actions.className = 'md-dialog__actions';

    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'md-btn md-btn--text';
    cancel.textContent = 'Abbrechen';
    cancel.addEventListener('click', function () { dialog.close(); });

    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'md-btn md-btn--filled';
    submit.textContent = options.submitLabel || 'Speichern';

    submit.addEventListener('click', function () {
      var payload = {};
      options.fields.forEach(function (field) {
        var input = inputs[field.name];
        payload[field.name] = field.type === 'checkbox' ? input.checked : input.value;
      });

      submit.disabled = true;
      error.hidden = true;

      options.onSubmit(payload)
        .then(function () {
          dialog.close();
          window.location.reload();
        })
        .catch(function (err) {
          error.textContent = err.message;
          error.hidden = false;
          submit.disabled = false;
        });
    });

    actions.appendChild(cancel);
    actions.appendChild(submit);
    form.appendChild(actions);
    dialog.appendChild(form);
    document.body.appendChild(dialog);

    dialog.addEventListener('close', function () { dialog.remove(); });
    dialog.showModal();
  }

  function companyOptions(withPrivateHint) {
    var list = [{ value: '', label: withPrivateHint ? '– keine (privat) –' : '– keine –' }];
    companies.forEach(function (company) {
      if (company.active) list.push({ value: String(company.id), label: company.name });
    });
    return list;
  }

  function employeeOptions() {
    var list = [{ value: '', label: '– keiner –' }];
    employees.forEach(function (employee) {
      if (employee.active) list.push({ value: String(employee.id), label: employee.name });
    });
    return list;
  }

  /* ------------------------------------------------------- Felddefinition */

  var FIELDS = {
    vehicle: function (isEdit) {
      var fields = [
        { name: 'plate', label: 'Kennzeichen', placeholder: 'TUT-MK-100' },
        { name: 'label', label: 'Bezeichnung (optional)', placeholder: 'Kombi' },
        { name: 'companyId', label: 'Firma', type: 'select', options: companyOptions(true) },
        { name: 'employeeId', label: 'Mitarbeiter', type: 'select', options: employeeOptions() },
        { name: 'notes', label: 'Notiz (optional)', type: 'textarea' },
      ];
      if (isEdit) fields.push({ name: 'active', label: 'Aktiv', type: 'checkbox' });
      return fields;
    },
    company: function (isEdit) {
      var fields = [
        { name: 'name', label: 'Name' },
        {
          name: 'kind', label: 'Art', type: 'select',
          options: [{ value: 'company', label: 'Firma' }, { value: 'private', label: 'Privat' }],
        },
        { name: 'address', label: 'Rechnungsanschrift', type: 'textarea' },
        { name: 'contactEmail', label: 'Kontaktadresse für Rechnungen', type: 'email' },
        {
          name: 'pricePerKwh', label: 'Eigener Arbeitspreis (€/kWh)',
          hint: 'Leer lassen für den Preis aus den Einstellungen.',
        },
        {
          name: 'ownReport', label: 'Eigener Monatsbericht per Mail', type: 'checkbox',
          hint: 'Ohne Haken erscheint die Firma nur in der Gesamtübersicht.',
        },
      ];
      if (isEdit) fields.push({ name: 'active', label: 'Aktiv', type: 'checkbox' });
      return fields;
    },
    employee: function (isEdit) {
      var fields = [
        { name: 'name', label: 'Name' },
        { name: 'companyId', label: 'Firma', type: 'select', options: companyOptions(false) },
        { name: 'personnelNo', label: 'Personalnummer (optional)' },
      ];
      if (isEdit) fields.push({ name: 'active', label: 'Aktiv', type: 'checkbox' });
      return fields;
    },
  };

  var TITLES = {
    vehicle: ['Fahrzeug anlegen', 'Fahrzeug bearbeiten'],
    company: ['Firma anlegen', 'Firma bearbeiten'],
    employee: ['Mitarbeiter anlegen', 'Mitarbeiter bearbeiten'],
  };

  var ENDPOINTS = { vehicle: 'vehicles', company: 'companies', employee: 'employees' };

  /* ------------------------------------------------------------- Aktionen */

  document.querySelectorAll('[data-new]').forEach(function (button) {
    button.addEventListener('click', function () {
      var kind = button.getAttribute('data-new');
      openForm({
        title: TITLES[kind][0],
        fields: FIELDS[kind](false),
        onSubmit: function (payload) {
          return window.md.request('/api/fleet/' + ENDPOINTS[kind], { method: 'POST', body: payload });
        },
      });
    });
  });

  document.querySelectorAll('[data-edit]').forEach(function (button) {
    button.addEventListener('click', function () {
      var kind = button.getAttribute('data-edit');
      var row = button.closest('tr');
      var value = JSON.parse(row.getAttribute('data-' + kind));
      openForm({
        title: TITLES[kind][1],
        fields: FIELDS[kind](true),
        value: value,
        onSubmit: function (payload) {
          return window.md.request('/api/fleet/' + ENDPOINTS[kind] + '/' + value.id, {
            method: 'PUT', body: payload,
          });
        },
      });
    });
  });

  document.querySelectorAll('[data-assign-submit]').forEach(function (button) {
    button.addEventListener('click', function () {
      var row = button.closest('tr');
      var rfid = row.getAttribute('data-card');
      var vehicleId = row.querySelector('[data-assign-vehicle]').value;
      var backfill = row.querySelector('[data-assign-backfill]').checked;

      if (!vehicleId) {
        window.md.snackbar('Bitte zuerst ein Fahrzeug wählen.');
        return;
      }

      button.disabled = true;
      window.md.request('/api/fleet/cards/' + encodeURIComponent(rfid) + '/assign', {
        method: 'POST',
        body: { vehicleId: Number(vehicleId), backfill: backfill },
      }).then(function (result) {
        window.md.snackbar(
          result.backfilled
            ? 'Karte zugeordnet, ' + result.backfilled + ' Ladevorgang/Ladevorgänge übernommen.'
            : 'Karte zugeordnet.'
        );
        window.location.reload();
      }).catch(function (error) {
        window.md.snackbar(error.message);
        button.disabled = false;
      });
    });
  });
}());
