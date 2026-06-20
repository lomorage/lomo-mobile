const fs = require('fs');
const path = require('path');

try {
  // 1. Read package.json
  const pkgPath = path.join(__dirname, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const currentVersion = pkg.version;

  // 2. Increment patch version
  const parts = currentVersion.split('.');
  if (parts.length !== 3) {
    throw new Error(`Invalid version format in package.json: ${currentVersion}. Expected x.y.z`);
  }
  parts[2] = parseInt(parts[2], 10) + 1;
  const newVersion = parts.join('.');

  console.log(`Bumping version from ${currentVersion} to ${newVersion}...`);

  // 3. Update package.json
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`\u2714 Updated package.json`);

  let newVersionCode = 1;

  // 4. Update app.json
  const appJsonPath = path.join(__dirname, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    if (appJson.expo) {
      if (appJson.expo.version) {
        appJson.expo.version = newVersion;
      }
      
      // Calculate a consistently increasing versionCode based on the version string
      // e.g., 1.0.133 -> 1 * 1000000 + 0 * 10000 + 133 = 1000133
      newVersionCode = parseInt(parts[0], 10) * 1000000 + parseInt(parts[1], 10) * 10000 + parseInt(parts[2], 10);

      // Update android versionCode
      if (!appJson.expo.android) appJson.expo.android = {};
      appJson.expo.android.versionCode = newVersionCode;
      
      // Update ios buildNumber
      if (!appJson.expo.ios) appJson.expo.ios = {};
      appJson.expo.ios.buildNumber = String(parseInt(appJson.expo.ios.buildNumber || '2', 10) + 1);
      
      fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n');
      console.log(`\u2714 Updated app.json (android versionCode: ${newVersionCode}, ios buildNumber: ${appJson.expo.ios.buildNumber})`);
    }
  }

  // 5. Update android/app/build.gradle
  const buildGradlePath = path.join(__dirname, 'android', 'app', 'build.gradle');
  if (fs.existsSync(buildGradlePath)) {
    let buildGradle = fs.readFileSync(buildGradlePath, 'utf8');
    
    // Update versionCode
    buildGradle = buildGradle.replace(/versionCode\s+(\d+)/, `versionCode ${newVersionCode}`);
    
    // Update versionName
    buildGradle = buildGradle.replace(/versionName\s+".*"/, `versionName "${newVersion}"`);
    
    fs.writeFileSync(buildGradlePath, buildGradle);
    console.log(`\u2714 Updated build.gradle (versionCode: ${newVersionCode}, versionName: ${newVersion})`);
  }

  console.log('Version update complete!\n');
} catch (error) {
  console.error('Error updating version:', error.message);
  process.exit(1);
}
