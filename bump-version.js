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

  // 4. Update app.json
  const appJsonPath = path.join(__dirname, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    if (appJson.expo && appJson.expo.version) {
      appJson.expo.version = newVersion;
      fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n');
      console.log(`\u2714 Updated app.json`);
    }
  }

  // 5. Update android/app/build.gradle
  const buildGradlePath = path.join(__dirname, 'android', 'app', 'build.gradle');
  if (fs.existsSync(buildGradlePath)) {
    let buildGradle = fs.readFileSync(buildGradlePath, 'utf8');
    
    let newVersionCode = 1;
    // Update versionCode
    buildGradle = buildGradle.replace(/versionCode\s+(\d+)/, (match, p1) => {
      newVersionCode = parseInt(p1, 10) + 1;
      return `versionCode ${newVersionCode}`;
    });
    
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
