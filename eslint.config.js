'use strict';

/**
 * ESLint 9 Flat-Config. Bewusst schlank: die Regeln, die echte Fehler finden,
 * nicht die, die über Formatierung streiten.
 */
module.exports = [
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        // Jest
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        jest: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        global: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^(next|unused)' }],
      'no-undef': 'error',
      'no-console': ['warn', { allow: ['error', 'warn', 'log'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2018,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        EventSource: 'readonly',
        Intl: 'readonly',
        tailwind: 'writable',
      },
    },
    rules: { 'no-undef': 'error' },
  },
];
