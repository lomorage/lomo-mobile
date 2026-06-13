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
        'android:enabled': 'true',
        'android:exported': 'false',
        'android:foregroundServiceType': 'dataSync',
        'tools:node': 'merge',
      },
    };
    services.push(targetService);
  } else {
    targetService.$['android:foregroundServiceType'] = 'dataSync';
    targetService.$['tools:node'] = 'merge';
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
