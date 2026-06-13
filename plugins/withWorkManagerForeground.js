const { withAndroidManifest } = require('@expo/config-plugins');

function addPermissions(androidManifest) {
  if (!androidManifest.manifest['uses-permission']) {
    androidManifest.manifest['uses-permission'] = [];
  }
  
  const permissions = androidManifest.manifest['uses-permission'];
  
  const hasForegroundService = permissions.some(
    (p) => p.$['android:name'] === 'android.permission.FOREGROUND_SERVICE'
  );
  if (!hasForegroundService) {
    permissions.push({
      $: { 'android:name': 'android.permission.FOREGROUND_SERVICE' },
    });
  }

  const hasForegroundServiceDataSync = permissions.some(
    (p) => p.$['android:name'] === 'android.permission.FOREGROUND_SERVICE_DATA_SYNC'
  );
  if (!hasForegroundServiceDataSync) {
    permissions.push({
      $: { 'android:name': 'android.permission.FOREGROUND_SERVICE_DATA_SYNC' },
    });
  }

  return androidManifest;
}

function addServiceType(androidManifest) {
  const mainApplication = androidManifest.manifest.application[0];
  
  // Force allow cleartext traffic for HTTP LAN connections on Android 9+ Release builds
  mainApplication.$['android:usesCleartextTraffic'] = 'true';
  
  if (!mainApplication.service) {
    mainApplication.service = [];
  }
  
  const services = mainApplication.service;
  const targetServiceName = 'androidx.work.impl.foreground.SystemForegroundService';
  
  let targetService = services.find((s) => s.$['android:name'] === targetServiceName);
  
  if (!targetService) {
    targetService = {
      $: {
        'android:name': targetServiceName,
        'android:foregroundServiceType': 'dataSync',
        'tools:node': 'merge',
      },
    };
    services.push(targetService);
  } else {
    targetService.$['android:foregroundServiceType'] = 'dataSync';
    targetService.$['tools:node'] = 'merge';
    delete targetService.$['android:enabled'];
    delete targetService.$['android:exported'];
  }
  
  if (!androidManifest.manifest.$['xmlns:tools']) {
    androidManifest.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
  }

  return androidManifest;
}

module.exports = function withWorkManagerForeground(config) {
  return withAndroidManifest(config, (config) => {
    config.modResults = addPermissions(config.modResults);
    config.modResults = addServiceType(config.modResults);
    return config;
  });
};
