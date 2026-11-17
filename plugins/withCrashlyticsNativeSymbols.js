const { withAppBuildGradle, withGradleProperties } = require('@expo/config-plugins');

const MARKER = 'nativeSymbolUploadEnabled';

// Face recognition dies in native code (SIGILL inside ONNX). Crashlytics
// records that only as an address unless the release build uploads symbols.
function withCrashlyticsNativeSymbols(config) {
  return withAppBuildGradle(config, (config) => {
    let contents = config.modResults.contents;
    if (contents.includes(MARKER)) {
      return config;
    }

    const needle = 'signingConfig signingConfigs.release';
    if (!contents.includes(needle)) {
      throw new Error('withCrashlyticsNativeSymbols: release signingConfig was not found');
    }

    contents = contents.replace(
      needle,
      [
        'firebaseCrashlytics {',
        '            nativeSymbolUploadEnabled true',
        '        }',
        `        ${needle}`,
      ].join('\n'),
    );
    config.modResults.contents = contents;
    return config;
  });
}

// The Firebase Kotlin compile plus lint needs more metaspace than Expo's 512m default.
function withCrashlyticsGradleMemory(config) {
  return withGradleProperties(config, (config) => {
    const key = 'org.gradle.jvmargs';
    const value = '-Xmx4096m -XX:MaxMetaspaceSize=1024m';
    const existing = config.modResults.find((item) => item.type === 'property' && item.key === key);
    if (existing) {
      existing.value = value;
    } else {
      config.modResults.push({ type: 'property', key, value });
    }
    return config;
  });
}

module.exports = function withCrashlyticsAndroid(config) {
  config = withCrashlyticsNativeSymbols(config);
  config = withCrashlyticsGradleMemory(config);
  return config;
};
