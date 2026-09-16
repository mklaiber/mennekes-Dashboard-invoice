/**
 * Material-Verhalten: Ripple, Theme-Umschaltung, Snackbar, Bestätigungsdialog.
 *
 * Bewusst ohne Framework und ohne Web-Components-Bibliothek - das Stylesheet
 * liefert das Aussehen, hier steht nur das Verhalten, das CSS nicht abdeckt.
 * Global als `window.md` verfügbar, damit die Seiten-Skripte es nutzen können.
 */
(function material() {
  'use strict';

  /* ------------------------------------------------------------------ Ripple */

  // Ein Listener am Dokument statt einer pro Knopf: funktioniert auch für
  // Elemente, die erst später ins DOM kommen (Tabellenzeilen, Dialoge).
  document.addEventListener('pointerdown', function (event) {
    var target = event.target.closest('.md-btn, .md-icon-btn');
    if (!target || target.disabled) return;

    var rect = target.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height);

    var ripple = document.createElement('span');
    ripple.className = 'md-ripple';
    ripple.style.width = size + 'px';
    ripple.style.height = size + 'px';
    ripple.style.left = (event.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (event.clientY - rect.top - size / 2) + 'px';

    target.appendChild(ripple);
    ripple.addEventListener('animationend', function () { ripple.remove(); });
  });

  /* ------------------------------------------------------------------- Theme */

  var THEME_KEY = 'wallbox.theme';

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    updateThemeButtons(theme);
  }

  function currentTheme() {
    try {
      return window.localStorage.getItem(THEME_KEY) || 'auto';
    } catch (error) {
      // Privater Modus oder blockierte Site-Daten - dann eben ohne Speicherung.
      return 'auto';
    }
  }

  function updateThemeButtons(theme) {
    var labels = { auto: 'Systemdesign', light: 'Helles Design', dark: 'Dunkles Design' };
    Array.prototype.forEach.call(document.querySelectorAll('[data-theme-toggle]'), function (button) {
      button.setAttribute('aria-label', 'Design wechseln – aktuell: ' + (labels[theme] || labels.auto));
      button.setAttribute('title', labels[theme] || labels.auto);
      Array.prototype.forEach.call(button.querySelectorAll('[data-theme-icon]'), function (icon) {
        icon.classList.toggle('hidden', icon.getAttribute('data-theme-icon') !== theme);
      });
    });
  }

  document.addEventListener('click', function (event) {
    if (!event.target.closest('[data-theme-toggle]')) return;
    // Reihenfolge: auto -> hell -> dunkel -> auto
    var order = ['auto', 'light', 'dark'];
    var next = order[(order.indexOf(currentTheme()) + 1) % order.length];
    try {
      if (next === 'auto') window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, next);
    } catch (error) { /* ohne Speicherung gilt die Wahl nur für diese Seite */ }
    applyTheme(next);
  });

  applyTheme(currentTheme());

  /* ---------------------------------------------------------------- Snackbar */

  var snackbarTimer = null;

  /**
   * Kurze Rückmeldung am unteren Rand.
   * @param {string} message
   * @param {{error?:boolean, duration?:number}} [options]
   */
  function snackbar(message, options) {
    var settings = options || {};
    var element = document.getElementById('md-snackbar');
    if (!element) return;

    element.className = 'md-snackbar' + (settings.error ? ' md-snackbar--error' : '');
    element.querySelector('[data-snackbar-text]').textContent = message;
    // Neustart der Transition erzwingen, falls die Snackbar schon offen ist.
    void element.offsetWidth;
    element.classList.add('is-open');

    window.clearTimeout(snackbarTimer);
    snackbarTimer = window.setTimeout(function () {
      element.classList.remove('is-open');
    }, settings.duration || 5000);
  }

  document.addEventListener('click', function (event) {
    if (event.target.closest('[data-snackbar-close]')) {
      var element = document.getElementById('md-snackbar');
      if (element) element.classList.remove('is-open');
    }
    // Abbrechen im Bestätigungsdialog - als Listener statt Inline-onclick,
    // damit die CSP ohne 'unsafe-inline' für Skripte auskommt.
    if (event.target.closest('[data-confirm-cancel]')) {
      var dialog = event.target.closest('dialog');
      if (dialog) dialog.close();
    }
  });

  /* ----------------------------------------------------------------- Dialog */

  /**
   * Bestätigungsdialog als Promise - ersetzt window.confirm.
   * @param {{title:string, body:string, confirmLabel?:string, danger?:boolean}} options
   * @returns {Promise<boolean>}
   */
  function confirmDialog(options) {
    var dialog = document.getElementById('md-confirm');
    if (!dialog || typeof dialog.showModal !== 'function') {
      // Fallback für Browser ohne <dialog>.
      return Promise.resolve(window.confirm(options.title + '\n\n' + options.body));
    }

    dialog.querySelector('[data-confirm-title]').textContent = options.title;
    dialog.querySelector('[data-confirm-body]').textContent = options.body;

    var confirmButton = dialog.querySelector('[data-confirm-ok]');
    confirmButton.textContent = options.confirmLabel || 'Bestätigen';
    confirmButton.className = 'md-btn ' + (options.danger ? 'md-btn--danger' : 'md-btn--filled');

    return new Promise(function (resolve) {
      function finish(result) {
        dialog.removeEventListener('close', onClose);
        confirmButton.removeEventListener('click', onConfirm);
        resolve(result);
      }
      function onClose() { finish(false); }
      function onConfirm() { dialog.close(); finish(true); }

      dialog.addEventListener('close', onClose);
      confirmButton.addEventListener('click', onConfirm);
      dialog.showModal();
    });
  }

  /* -------------------------------------------------------------- HTTP-Hilfe */

  /** Liest das CSRF-Token aus dem Meta-Tag der Seite. */
  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  /**
   * fetch mit CSRF-Header und einheitlicher Fehlerbehandlung.
   * @param {string} url
   * @param {object} [options] {method, body}
   * @returns {Promise<object>}
   */
  function request(url, options) {
    var settings = options || {};
    var headers = { Accept: 'application/json', 'X-CSRF-Token': csrfToken() };
    if (settings.body !== undefined) headers['Content-Type'] = 'application/json';

    return fetch(url, {
      method: settings.method || 'GET',
      headers: headers,
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
      // Cookie mitsenden, auch wenn der Aufruf von einer anderen Seite stammt.
      credentials: 'same-origin',
    }).then(function (response) {
      // 204 hat keinen Body - JSON.parse würde werfen.
      if (response.status === 204) return {};
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) {
          throw new Error(body.message || ('HTTP ' + response.status));
        }
        return body;
      });
    });
  }

  /** Escaping für Werte, die per innerHTML eingesetzt werden. */
  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.md = {
    snackbar: snackbar,
    confirm: confirmDialog,
    request: request,
    csrfToken: csrfToken,
    escapeHtml: escapeHtml,
  };
}());
