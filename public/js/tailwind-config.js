/* Tailwind Play-CDN Konfiguration.
   Ausgelagert in eine eigene Datei, damit die Content-Security-Policy
   ohne 'unsafe-inline' für Skripte auskommt. */
/* global tailwind */
// Ohne Guard wirft diese Datei einen ReferenceError, wenn das CDN nicht
// erreichbar war - sichtbar in der Browser-Konsole und unnötig beunruhigend.
if (typeof tailwind !== 'undefined') {
  tailwind.config = {
    theme: {
      extend: {
        fontFamily: {
          sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        },
        keyframes: {
          'pulse-ring': {
            '0%':   { transform: 'scale(.8)', opacity: '.7' },
            '80%':  { transform: 'scale(1.6)', opacity: '0' },
            '100%': { transform: 'scale(1.6)', opacity: '0' },
          },
        },
        animation: {
          'pulse-ring': 'pulse-ring 1.8s cubic-bezier(.24,.12,.25,1) infinite',
        },
      },
    },
  };
}
