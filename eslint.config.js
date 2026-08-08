// eslint.config.js
const expoConfig = require('eslint-config-expo/flat');
const { defineConfig } = require('eslint/config');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      'dist/*',
      'android/*',
      'ios/*',
      '.expo/*',
      'modules/**/android/*',
      'modules/**/ios/*',
    ],
  },
  {
    files: ['**/__tests__/**/*.js', '**/*.test.js', '__mocks__/**/*.js'],
    languageOptions: {
      globals: { ...globals.jest, ...globals.node },
    },
  },
  {
    files: [
      '*.config.js',
      'app.config.js',
      'metro.config.js',
      'bump-version.js',
      'scripts/**/*.js',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
]);
