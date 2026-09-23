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
  /* ----------------------------------------------------------- Kartenart */

  document.querySelectorAll('[data-card-kind]').forEach(function (button) {
    button.addEventListener('click', function () {
      var rfid = button.closest('tr').getAttribute('data-card');
      var kind = button.getAttribute('data-card-kind');
      button.disabled = true;
      window.md.request('/api/fleet/cards/' + encodeURIComponent(rfid) + '/kind', {
        method: 'POST', body: { kind: kind },
      }).then(function () {
        window.location.reload();
      }).catch(function (error) {
        window.md.snackbar(error.message);
        button.disabled = false;
      });
    });
  });

  /* ------------------------------------------------------------ Anlernen */

  var learnDialog = $('learn-dialog');
  if (learnDialog) {
    var knownCards = [];
    try {
      knownCards = JSON.parse(document.getElementById('fleet-cards').textContent) || [];
    } catch (error) {
      knownCards = [];
    }

    // Web NFC gibt es nur in Chromium auf Android. Unter iOS ist NDEFReader in
    // JEDEM Browser undefiniert: alle nutzen WebKit, und WebKit hat es nicht.
    var hasNfc = 'NDEFReader' in window;
    // Android zuerst ausschliessen: iPads geben sich als "MacIntel" mit
    // Touch aus, und genau diese Kombination liefert auch eine Android-
    // Emulation auf einem Mac - dort stand sonst "Auf dem iPhone nicht moeglich".
    var isAndroid = /Android/i.test(navigator.userAgent);
    var isIos = !isAndroid && (/iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

    var learn = { vehicleId: null, plate: '', expiresAt: null, done: false, poll: null, tick: null, nfc: null };

    var normalize = function (id) { return String(id || '').replace(/[\s:_-]/g, '').toLowerCase(); };

    function setState(text, tone) {
      var box = $('learn-state');
      box.className = 'md-banner md-banner--' + (tone || 'info');
      box.textContent = text;
    }

    function setNfcHint(text) { $('learn-nfc-hint').textContent = text; }

    function stopTimers() {
      clearInterval(learn.poll);
      clearInterval(learn.tick);
      learn.poll = null;
      learn.tick = null;
    }

    function stopNfc() {
      if (learn.nfc) {
        learn.nfc.abort();
        learn.nfc = null;
      }
    }

    function remaining() {
      var ms = new Date(learn.expiresAt).getTime() - Date.now();
      if (!(ms > 0)) return null;
      var minutes = Math.floor(ms / 60000);
      var seconds = Math.floor((ms % 60000) / 1000);
      return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
    }

    function finish(text) {
      learn.done = true;
      stopTimers();
      stopNfc();
      // Beide Anleitungen samt ihrem letzten Stand (etwa "Laden ohne Karte
      // erkannt" oder "Karte jetzt an das Handy halten") waeren neben dem
      // Erfolg widerspruechlich - danach steht nur noch das Ergebnis da.
      $('learn-wallbox').classList.add('hidden');
      $('learn-nfc').classList.add('hidden');
      var result = $('learn-result');
      result.textContent = text;
      result.classList.remove('hidden');
      $('learn-cancel').classList.add('hidden');
      $('learn-done').classList.remove('hidden');
    }

    function render(state) {
      if (learn.done) return;
      if (state.capturedRfid) {
        finish('Karte ' + state.capturedRfid + ' angelernt und ' + learn.plate + ' zugeordnet.');
        return;
      }
      if (!state.armed) {
        stopTimers();
        setState('Das Anlernen ist beendet oder abgelaufen. Starte es erneut, um es noch einmal zu versuchen.', 'warning');
        return;
      }
      learn.expiresAt = state.expiresAt;
      var rest = remaining();
      if (state.notice) {
        setState(state.notice + (rest ? ' Noch ' + rest + '.' : ''), 'warning');
      } else {
        setState('Warte auf eine Karte … noch ' + (rest || '0:00'), 'info');
      }
    }

    function setupNfc() {
      var button = $('learn-nfc-start');
      button.disabled = false;
      if (hasNfc) {
        setNfcHint('Nur in Chrome auf Android. Klappt mit den meisten Karten, aber nicht mit jeder – '
          + 'Android gibt manche Chiptypen nicht an Webseiten heraus.');
        button.classList.remove('hidden');
      } else if (isIos) {
        setNfcHint('Auf dem iPhone nicht möglich: Unter iOS kann kein Browser Karten auslesen, '
          + 'Apple gibt NFC nur für eigene Apps frei. Nutze das Anlernen an der Wallbox.');
        button.classList.add('hidden');
      } else if (isAndroid) {
        setNfcHint('In diesem Browser nicht verfügbar – am Handy anlernen geht nur mit Chrome '
          + 'oder Samsung Internet. Oder nutze das Anlernen an der Wallbox.');
        button.classList.add('hidden');
      } else {
        setNfcHint('In diesem Browser nicht verfügbar. Am Handy anlernen geht nur mit Chrome auf Android.');
        button.classList.add('hidden');
      }
    }

    function openLearn(vehicleId, plate, resume) {
      learn.vehicleId = Number(vehicleId);
      learn.plate = plate;
      learn.done = false;
      $('learn-plate').textContent = plate;
      $('learn-wallbox').classList.remove('hidden');
      $('learn-nfc').classList.remove('hidden');
      $('learn-result').classList.add('hidden');
      $('learn-cancel').classList.remove('hidden');
      $('learn-done').classList.add('hidden');
      setState('Starte …', 'info');
      setupNfc();

      var start = resume
        ? window.md.request('/api/fleet/learn')
        : window.md.request('/api/fleet/learn', { method: 'POST', body: { vehicleId: learn.vehicleId } });

      start.then(function (state) {
        render(state);
        if (learn.done || !state.armed) return;
        // Alle 3 Sekunden nachfragen; die Wallbox meldet im 2-Sekunden-Takt.
        learn.poll = setInterval(function () {
          window.md.request('/api/fleet/learn').then(render).catch(function () { /* naechster Versuch */ });
        }, 3000);
        learn.tick = setInterval(function () {
          if (!learn.done && learn.expiresAt && !remaining()) {
            stopTimers();
            setState('Die Zeit ist abgelaufen. Starte das Anlernen erneut.', 'warning');
          }
        }, 1000);
      }).catch(function (error) {
        setState(error.message, 'error');
      });

      learnDialog.showModal();
    }

    function closeLearn() {
      stopTimers();
      stopNfc();
      // Nicht angelernt? Dann auch auf dem Server beenden - sonst bliebe das
      // Anlernen 15 Minuten scharf, und die naechste fremde Karte landete
      // womoeglich bei diesem Fahrzeug.
      if (!learn.done) {
        window.md.request('/api/fleet/learn', { method: 'DELETE' }).catch(function () { /* egal */ });
      }
      if (learnDialog.open) learnDialog.close();
      if (learn.done) window.location.reload();
    }

    function assignFromNfc(id) {
      var known = knownCards.filter(function (c) { return c.rfid === id; })[0];

      var go = function () {
        window.md.request('/api/fleet/cards/' + encodeURIComponent(id) + '/assign', {
          method: 'POST', body: { vehicleId: learn.vehicleId, backfill: true, source: 'nfc' },
        }).then(function () {
          window.md.request('/api/fleet/learn', { method: 'DELETE' }).catch(function () { /* egal */ });
          // Die eigentliche Unsicherheit beim Anlernen am Handy: liest das Handy
          // dieselbe ID wie die Wallbox? Hat die Karte dort schon geladen, ist
          // das bewiesen - sonst sagen wir es ehrlich dazu.
          finish('Karte ' + id + ' am Handy angelernt und ' + learn.plate + ' zugeordnet. '
            + (known && known.seen
              ? 'Sie hat an der Wallbox schon geladen – die IDs stimmen überein.'
              : 'An der Wallbox wurde sie noch nicht gesehen. Die Zuordnung greift beim ersten Laden; '
                + 'taucht die Karte dann trotzdem als „ohne Fahrzeug“ auf, lies sie an der Wallbox an.'));
        }).catch(function (error) {
          setNfcHint(error.message);
        });
      };

      if (known && known.vehicleId && known.vehicleId !== learn.vehicleId) {
        window.md.confirm({
          title: 'Karte umbuchen?',
          body: 'Karte ' + id + ' gehört bereits zu ' + known.vehiclePlate + '. Soll sie ab jetzt '
            + learn.plate + ' zugeordnet werden? Bereits abgerechnete Ladevorgänge bleiben unverändert.',
          confirmLabel: 'Umbuchen',
        }).then(function (ok) { if (ok) go(); });
      } else {
        go();
      }
    }

    $('learn-nfc-start').addEventListener('click', function () {
      var button = this;
      stopNfc();
      button.disabled = true;
      setNfcHint('Karte jetzt flach an die Rückseite des Handys halten …');

      var reader = new window.NDEFReader();
      learn.nfc = new AbortController();

      reader.addEventListener('reading', function (event) {
        var id = normalize(event.serialNumber);
        stopNfc();
        button.disabled = false;
        if (!id) {
          setNfcHint('Die Karte hat keine Seriennummer geliefert. Nutze das Anlernen an der Wallbox.');
          return;
        }
        assignFromNfc(id);
      });

      // Chrome meldet Karten, die Android weder als NDEF noch als NDEF-fähig
      // einstuft, nur als Fehler - OHNE Seriennummer. Einen Umweg gibt es von
      // einer Webseite aus nicht.
      reader.addEventListener('readingerror', function () {
        stopNfc();
        button.disabled = false;
        setNfcHint('Diese Karte kann dein Handy nicht an die Seite weitergeben – Android gibt ihren '
          + 'Chiptyp nicht an Webseiten heraus. Nutze das Anlernen an der Wallbox.');
      });

      reader.scan({ signal: learn.nfc.signal }).catch(function (error) {
        button.disabled = false;
        if (error.name === 'AbortError') return;
        var messages = {
          NotAllowedError: 'NFC wurde nicht erlaubt. Erlaube der Seite in Chrome den Zugriff auf NFC und versuche es erneut.',
          NotReadableError: 'NFC ist ausgeschaltet. Schalte es in den Android-Einstellungen ein und versuche es erneut.',
          NotSupportedError: 'Dieses Handy hat kein NFC. Nutze das Anlernen an der Wallbox.',
        };
        setNfcHint(messages[error.name] || ('NFC ließ sich nicht starten: ' + error.message));
      });
    });

    document.querySelectorAll('[data-learn]').forEach(function (button) {
      button.addEventListener('click', function () {
        openLearn(button.getAttribute('data-learn'), button.getAttribute('data-learn-plate'),
          button.hasAttribute('data-learn-resume'));
      });
    });

    $('learn-cancel').addEventListener('click', closeLearn);
    $('learn-done').addEventListener('click', closeLearn);
    // Escape schliesst den Dialog - dann ebenfalls sauber beenden.
    learnDialog.addEventListener('cancel', function (event) {
      event.preventDefault();
      closeLearn();
    });
  }
}());
