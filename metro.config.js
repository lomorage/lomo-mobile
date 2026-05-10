const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Exclude files and directories that Metro watches but never bundles.
// This dramatically speeds up bundling on Windows.
config.resolver.blockList = [
  // Large debug/data files in project root (~10MB total)
  /debug_dump\..*/,
  /remote_tree_clean\.json/,
  /local_cache_clean\.json/,
  /local_cache_latest\.json/,
  /cr_test\.jpg/,
  /debug_dedup\.js/,
  // Native code directories — Metro only needs JS, not .java/.m/.swift files
  // react-native-zeroconf/android alone is 123MB!
  /node_modules\/react-native-zeroconf\/android\/.*/,
  /node_modules\/react-native-zeroconf\/ios\/.*/,
  /node_modules\/react-native-argon2\/android\/.*/,
  /node_modules\/react-native-argon2\/ios\/.*/,
];

// Reduce the number of workers on Windows to avoid file-handle contention
if (process.platform === 'win32') {
  config.maxWorkers = 2;
}

module.exports = config;

