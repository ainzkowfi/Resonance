// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  {
    ignores: ['dist/**', '.expo/**'],
  },
  expoConfig,
  {
    rules: {
      // Reanimated worklets mutate shared values off the render path.
      'react-hooks/immutability': 'off',
      'react-hooks/refs': 'off',
    },
  },
]);
