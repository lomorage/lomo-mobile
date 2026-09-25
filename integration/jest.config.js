// Integration tests: the real service layer (src/services) talking to a real
// lomod over HTTP, run under plain Node. Native modules are replaced by Node
// implementations in integration/shims. See integration/README.md.
const shim = (name) => `<rootDir>/integration/shims/${name}`;

module.exports = {
  rootDir: '..',
  // Keep the unit tests' root __mocks__ (e.g. the jest.fn() expo-sqlite) out:
  // node_modules mocks there would otherwise apply automatically.
  roots: ['<rootDir>/integration'],
  testMatch: ['<rootDir>/integration/tests/**/*.test.js'],
  testEnvironment: 'node',
  transform: {
    '\\.[jt]sx?$': ['babel-jest', { presets: ['babel-preset-expo'], babelrc: false, configFile: false }],
  },
  moduleNameMapper: {
    '^react-native$': shim('react-native.js'),
    '^expo-file-system/legacy$': shim('expo-file-system-legacy.js'),
    '^expo-file-system$': shim('stubs/expo-file-system.js'),
    '^expo-sqlite$': shim('expo-sqlite.js'),
    '^expo-secure-store$': shim('expo-secure-store.js'),
    '^expo-crypto$': shim('expo-crypto.js'),
    '^expo-media-library$': shim('expo-media-library.js'),
    '^expo-constants$': shim('stubs/expo-constants.js'),
    '^expo-battery$': shim('stubs/expo-battery.js'),
    '^expo-sharing$': shim('stubs/expo-sharing.js'),
    '^react-native-argon2$': shim('react-native-argon2.js'),
    '^react-native-zeroconf$': shim('stubs/react-native-zeroconf.js'),
    '^@react-native-community/netinfo$': shim('stubs/netinfo.js'),
    '/modules/expo-lomo-hasher$': shim('expo-lomo-hasher.js'),
    '^\\./AIService$': shim('stubs/AIService.js'),
  },
  globalSetup: '<rootDir>/integration/setup/globalSetup.js',
  setupFilesAfterEnv: ['<rootDir>/integration/setup/quietConsole.js'],
  testTimeout: 60000,
};
