const fs = require('fs');
const path = require('path');

try {
  // Get version from argument or auto-increment from package.json
  let newVersion = process.argv[2];
  const pkgPath = path.join(__dirname, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const currentVersion = pkg.version;

  if (!newVersion) {
    const parts = currentVersion.split('.');
    if (parts.length !== 3) {
      throw new Error(`Invalid version format in package.json: ${currentVersion}. Expected x.y.z`);
    }
    parts[2] = parseInt(parts[2], 10) + 1;
    newVersion = parts.join('.');
  }

  console.log(`Bumping version to ${newVersion} (current package.json version: ${currentVersion})...`);

  // 1. Update package.json
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`✔ Updated package.json`);

  let newVersionCode = 1;
  let newBuildNumber = 1;

  // 2. Update app.json & increment buildNumber
  const appJsonPath = path.join(__dirname, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    if (appJson.expo) {
      appJson.expo.version = newVersion;
      
      // Calculate a consistently increasing versionCode based on the version string
      // e.g., 1.0.133 -> 1 * 1000000 + 0 * 10000 + 133 = 1000133
      const newParts = newVersion.split('.');
      newVersionCode = parseInt(newParts[0], 10) * 1000000 + parseInt(newParts[1], 10) * 10000 + parseInt(newParts[2], 10);

      // Update android versionCode
      if (!appJson.expo.android) appJson.expo.android = {};
      appJson.expo.android.versionCode = newVersionCode;
      
      // Get and increment iOS buildNumber
      if (!appJson.expo.ios) appJson.expo.ios = {};
      const currentBuildNumber = parseInt(appJson.expo.ios.buildNumber || '1', 10);
      newBuildNumber = currentBuildNumber + 1;
      appJson.expo.ios.buildNumber = String(newBuildNumber);
      
      fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n');
      console.log(`✔ Updated app.json (version: ${newVersion}, android versionCode: ${newVersionCode}, ios buildNumber: ${newBuildNumber})`);
    }
  }

  // 3. Update android/app/build.gradle
  const buildGradlePath = path.join(__dirname, 'android', 'app', 'build.gradle');
  if (fs.existsSync(buildGradlePath)) {
    let buildGradle = fs.readFileSync(buildGradlePath, 'utf8');
    // Update versionCode
    buildGradle = buildGradle.replace(/versionCode\s+(\d+)/, `versionCode ${newVersionCode}`);
    
    // Update versionName
    buildGradle = buildGradle.replace(/versionName\s+".*"/, `versionName "${newVersion}"`);
    
    fs.writeFileSync(buildGradlePath, buildGradle);
    console.log(`✔ Updated android/app/build.gradle (versionCode: ${newVersionCode}, versionName: ${newVersion})`);
  }

  // 4. Update ios/lomomobile/Info.plist
  const infoPlistPath = path.join(__dirname, 'ios', 'lomomobile', 'Info.plist');
  if (fs.existsSync(infoPlistPath)) {
    let infoPlist = fs.readFileSync(infoPlistPath, 'utf8');
    
    // Replace CFBundleShortVersionString value
    infoPlist = infoPlist.replace(
      /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${newVersion}$2`
    );
    
    // Replace CFBundleVersion value
    infoPlist = infoPlist.replace(
      /(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${newBuildNumber}$2`
    );
    
    fs.writeFileSync(infoPlistPath, infoPlist);
    console.log(`✔ Updated ios/lomomobile/Info.plist (CFBundleShortVersionString: ${newVersion}, CFBundleVersion: ${newBuildNumber})`);
  }

  // 5. Update ios/lomomobile.xcodeproj/project.pbxproj
  const pbxprojPath = path.join(__dirname, 'ios', 'lomomobile.xcodeproj', 'project.pbxproj');
  if (fs.existsSync(pbxprojPath)) {
    let pbxproj = fs.readFileSync(pbxprojPath, 'utf8');
    
    // Replace all occurrences of MARKETING_VERSION
    pbxproj = pbxproj.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${newVersion};`);
    
    // Replace all occurrences of CURRENT_PROJECT_VERSION
    pbxproj = pbxproj.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${newBuildNumber};`);
    
    fs.writeFileSync(pbxprojPath, pbxproj);
    console.log(`✔ Updated ios/lomomobile.xcodeproj/project.pbxproj (MARKETING_VERSION: ${newVersion}, CURRENT_PROJECT_VERSION: ${newBuildNumber})`);
  }

  console.log('Version and build number update complete across Android and iOS!\n');
} catch (error) {
  console.error('Error updating version:', error.message);
  process.exit(1);
}
