// Flat config. Plain CommonJS on purpose: the VS Code extension host loads `main` with require().
const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'release/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: globals.node },
    rules: {
      camelcase: ['error', { properties: 'never' }], // external JSON keys (session_id, used_percentage) are only ever read as properties
      'new-cap': 'error',
      'no-underscore-dangle': 'error',
      // Names must say what they are: no one- or two-letter identifiers, except loop counters, `id`, and the
      // conventional Node built-in aliases fs, os and vm.
      'id-length': ['error', { min: 3, exceptions: ['id', 'i', 'j', 'fs', 'os', 'vm'], properties: 'never' }],
      'id-denylist': ['error', 'e', 'err', 'cb', 'fn', 'tmp', 'res', 'req', 'val', 'obj', 'arr', 'str', 'num', 'idx', 'ctx', 'cfg', 'msg', 'evt'],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: 'error',
      'no-shadow': 'off', // the base rule misreads TypeScript type names
      '@typescript-eslint/no-shadow': 'warn',
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/no-explicit-any': 'off', // parsed JSON from Claude Code's own files has no fixed shape
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // The webview script runs in a browser, not in Node.
    files: ['src/views/panel.ts'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, acquireVsCodeApi: 'readonly' } },
  },
  {
    // Plain Node scripts that are not part of the TypeScript build.
    files: ['scripts/*.js', 'eslint.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
