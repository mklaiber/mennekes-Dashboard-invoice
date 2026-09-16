/**
 * Benutzerverwaltung im Browser.
 *
 * Alle Aktionen laufen über /api/users; die Regeln (letzter Administrator,
 * Selbst-Aussperren) prüft der Server - hier geht es nur um die Bedienung.
 */
(function usersPage() {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var dialog = $('user-dialog');
  var passwordDialog = $('password-dialog');

  /** null = anlegen, sonst die ID des bearbeiteten Kontos. */
  var editingId = null;

  function showDialogError(message) {
    var box = $('user-dialog-error');
    box.textContent = message;
    box.classList.toggle('hidden', !message);
  }

  function openDialog(user) {
    editingId = user ? user.id : null;
    showDialogError('');

    $('user-dialog-title').textContent = user ? 'Benutzer bearbeiten' : 'Benutzer anlegen';
    $('user-username').value = user ? user.username : '';
    // Der Benutzername ist der Anmeldeschlüssel - nachträgliches Ändern würde
    // das Protokoll unbrauchbar machen.
    $('user-username').disabled = Boolean(user);
    $('user-displayName').value = user ? (user.displayName || '') : '';
    $('user-email').value = user ? (user.email || '') : '';
    $('user-role').value = user ? user.role : 'viewer';
    $('user-isActive').checked = user ? user.isActive : true;
    $('user-password').value = '';

    // Passwort nur beim Anlegen; Zurücksetzen hat einen eigenen Knopf.
    $('user-password-row').classList.toggle('hidden', Boolean(user));
    $('user-active-row').classList.toggle('hidden', !user);

    dialog.showModal();
  }

  function showGeneratedPassword(password) {
    $('generated-password').textContent = password;
    passwordDialog.showModal();
  }

  /* ------------------------------------------------------------- Speichern */

  $('user-save').addEventListener('click', function () {
    var payload = {
      displayName: $('user-displayName').value.trim(),
      email: $('user-email').value.trim(),
      role: $('user-role').value,
    };

    var promise;
    if (editingId) {
      payload.isActive = $('user-isActive').checked;
      promise = window.md.request('/api/users/' + editingId, { method: 'PUT', body: payload });
    } else {
      payload.username = $('user-username').value.trim();
      var password = $('user-password').value;
      if (password) payload.password = password;
      promise = window.md.request('/api/users', { method: 'POST', body: payload });
    }

    promise
      .then(function (body) {
        dialog.close();
        if (body.generatedPassword) {
          showGeneratedPassword(body.generatedPassword);
          // Erst nach dem Schließen neu laden, sonst ist das Passwort weg,
          // bevor es jemand notieren konnte.
          passwordDialog.addEventListener('close', function () {
            window.location.reload();
          }, { once: true });
          return;
        }
        window.md.snackbar('Benutzer gespeichert.');
        window.setTimeout(function () { window.location.reload(); }, 600);
      })
      .catch(function (error) {
        showDialogError(error.message);
      });
  });

  $('add-user').addEventListener('click', function () { openDialog(null); });

  /* ----------------------------------------------------- Zeilen-Aktionen */

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-action]');
    if (!button) return;

    var action = button.getAttribute('data-action');
    var id = button.getAttribute('data-id');

    if (action === 'edit') {
      window.md.request('/api/users')
        .then(function (body) {
          var user = body.users.filter(function (entry) { return String(entry.id) === String(id); })[0];
          if (user) openDialog(user);
        })
        .catch(function (error) { window.md.snackbar(error.message, { error: true }); });
      return;
    }

    if (action === 'password') {
      window.md.confirm({
        title: 'Passwort zurücksetzen?',
        body: 'Es wird ein neues Passwort erzeugt und einmalig angezeigt. '
          + 'Alle offenen Sitzungen dieses Kontos werden beendet.',
        confirmLabel: 'Zurücksetzen',
      }).then(function (confirmed) {
        if (!confirmed) return;
        window.md.request('/api/users/' + id + '/password', { method: 'POST', body: {} })
          .then(function (body) {
            if (body.generatedPassword) showGeneratedPassword(body.generatedPassword);
            else window.md.snackbar('Passwort zurückgesetzt.');
          })
          .catch(function (error) { window.md.snackbar(error.message, { error: true }); });
      });
      return;
    }

    if (action === 'delete') {
      window.md.confirm({
        title: 'Benutzer löschen?',
        body: 'Das Konto „' + button.getAttribute('data-name') + '“ wird dauerhaft entfernt. '
          + 'Protokolleinträge bleiben erhalten, verlieren aber die Verknüpfung.',
        confirmLabel: 'Löschen',
        danger: true,
      }).then(function (confirmed) {
        if (!confirmed) return;
        window.md.request('/api/users/' + id, { method: 'DELETE' })
          .then(function () {
            window.md.snackbar('Benutzer gelöscht.');
            window.setTimeout(function () { window.location.reload(); }, 600);
          })
          .catch(function (error) { window.md.snackbar(error.message, { error: true }); });
      });
    }
  });
}());
