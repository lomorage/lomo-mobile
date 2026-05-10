# Lomorage Mobile

React Native / Expo client for Lomorage, optimized for massive gallery syncs (18,000+ photos).

## Prerequisites

### All Platforms
- **Node.js**: 20.x or later (`node --version` should report `v20.x` or higher)
- **npm**: Bundled with Node.js (used with `--legacy-peer-deps` for Expo SDK 54 compatibility)
- **Expo Account**: Free account at [expo.dev](https://expo.dev) — required for EAS cloud builds and device registration

### macOS (for local iOS builds)
- **Xcode**: 15 or later (install from the Mac App Store)
- **Xcode Command Line Tools**: `xcode-select --install`
- **CocoaPods**: `sudo gem install cocoapods` (or `brew install cocoapods`)
- **iOS Simulator** (optional): Included with Xcode; physical device recommended for full feature testing
- **Apple Developer Account**: Required to sign and deploy to a physical device ([developer.apple.com](https://developer.apple.com))

### Android (any platform)
- **Android SDK**: Required for local builds and ADB debugging
- **Physical Devices**: Must be on the **same Wi-Fi network** as your development machine
- **USB Debugging**: Enable in Developer Options on your Android device

## Installation

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/lomorage/lomo-mobile.git
   cd lomo-mobile
   npm install --legacy-peer-deps
   ```

2. Log in to your Expo account:
   ```bash
   npx expo login
   ```

## Building & Running the iOS App

Lomorage uses a custom native module (`expo-lomo-hasher`), so **Expo Go cannot be used**. A Development Client build is required. Choose the path that matches your development machine.

---

### Option A — macOS: Local Build with Xcode

This is the fastest inner-loop for iOS development. All steps run entirely on your Mac.

#### 1. Install CocoaPods dependencies
```bash
npx expo prebuild --clean   # generates the ios/ Xcode project
cd ios && pod install && cd ..
```
> **Note**: Run `pod install` again any time you add or update a native package.

#### 2. Build and launch on a Simulator
```bash
npx expo run:ios
# Pick a simulator when prompted, or pass it explicitly:
npx expo run:ios --simulator "iPhone 16 Pro"
```

#### 3. Build and launch on a Physical iPhone

1. Connect your iPhone via USB and trust the Mac.
2. Open the generated workspace in Xcode:
   ```bash
   open ios/lomomobile.xcworkspace
   ```
3. In Xcode: select your iPhone as the run destination, then go to  
   **Signing & Capabilities → Team** and select your Apple Developer account.
4. Press **▶ Run** (⌘R) — Xcode will sign, install, and launch the app.
5. Once installed, start the Metro bundler from your terminal:
   ```bash
   npx expo start --dev-client
   ```
   The app will connect to Metro automatically if your Mac and iPhone are on the same Wi-Fi network. If not, shake the device → **Dev Menu → Settings → Change Bundle Location** and enter your Mac's IP (e.g. `192.168.1.10:8081`).

> **Tip**: Use `npx expo run:ios --device` to pick a connected physical device from the CLI without opening Xcode.

---

### Option B — Windows (or any OS): EAS Cloud Build

EAS builds the native iOS binary on Expo's macOS servers, so a Mac is not required.

#### 1. Install EAS CLI
```bash
npm install -g eas-cli
eas login
```

#### 2. Register your iPhone with EAS
```bash
eas device:create
```
Follow the prompts — this registers your device's UDID so EAS can sign the build for it.

#### 3. Build the Development Client in the cloud
```bash
eas build --platform ios --profile development
```
- The build runs on Expo's servers (no Mac needed).
- When complete, EAS provides a QR code / link. Scan it on your iPhone to install the `.ipa`.

#### 4. Start the Metro dev server (runs on Windows/Linux/macOS)
```bash
npx expo start --dev-client
```
Open the installed **Lomorage** app on your iPhone. It will scan for Metro, or tap **Enter URL manually** and type your computer's IP (e.g. `http://192.168.1.10:8081`).

> **Note**: Your iPhone and dev machine must be on the **same Wi-Fi network**. Rebuild with `eas build` only when native code changes; JS changes hot-reload over Metro.

#### 5. Build a Preview / Production IPA
```bash
# Ad-hoc distribution for internal testers
eas build --platform ios --profile preview

# App Store production build
eas build --platform ios --profile production
```

---

## Building & Publishing the Android App

### Option A — EAS Cloud Build (Recommended for Google Play)

EAS builds the native Android App Bundle (`.aab`) on Expo's servers. This is the recommended approach as Expo securely manages your Google Play App Signing Keystore.

```bash
eas build --platform android --profile production
```
Once complete, download the `.aab` from the Expo dashboard to submit to the Google Play Console.

### Option B — Local Windows/Mac Build (Gradle)

If you prefer to build locally on your own hardware without EAS, you can use the Android Gradle wrapper. This requires the Android SDK and Java JDK 17 to be installed.

## Publishing to Google Play Store

### 1. Compile the Production App Bundle (.aab) Locally
Google Play requires an Android App Bundle (`.aab`) rather than an `.apk` for new releases. This project is fully configured to generate a production-signed `.aab` locally using the bundled release keystore.

```bash
# Windows
.\build-android.bat

# Mac/Linux
./build-android.sh
```
The compiled output file will be located at:
`android/app/build/outputs/bundle/release/app-release.aab`

### 2. Gather Store Listing Assets
To publish the app, you will need to upload specific graphical assets to the Google Play Console under **Store presence > Main store listing**:
*   **App Icon**: 512 x 512 px PNG (Generated and stored as `assets/icon.png`)
*   **Feature Graphic**: 1024 x 500 px PNG (Generated as `lomorage_feature_graphic...png` in your local artifacts)
*   **Phone Screenshots**: At least 2-8 screenshots from a phone device. (Use Android Studio AVD to take clean screenshots of the sync gallery).
*   **Tablet Screenshots**: At least 2-8 screenshots for a 7-inch tablet, and another set for a 10-inch tablet.

### 3. Upload to Google Play Console
1. Log in to the [Google Play Console](https://play.google.com/console).
2. Create a new App or select "Lomorage".
3. Navigate to **Testing > Internal Testing** or **Production**.
4. Click **Create new release**.
5. Upload the `app-release.aab` file you generated in Step 1.
6. Fill out your release notes and click **Save**.

### 4. Review Permissions
Since Lomorage requires background sync and local network access, ensure your Privacy Policy explicitly mentions the use of the following Android Permissions:
*   `android.permission.FOREGROUND_SERVICE`
*   `android.permission.FOREGROUND_SERVICE_DATA_SYNC`
*   `android.permission.READ_MEDIA_IMAGES`
*   Local network auto-discovery (mDNS)

### 5. Updating the App Version
Before every new submission to Google Play, you **must** increment your version number. 
**DO NOT run `npx expo prebuild` to do this**, as it will overwrite your custom release signing configuration!

Instead, manually update the following two files:
1. Open `android/app/build.gradle` and locate the `defaultConfig` block (around line 90):
   * Increment `versionCode` by 1 (e.g., `1` -> `2`). **Google Play strictly requires this to be higher than your last upload.**
   * Update `versionName` to your new display version (e.g., `"1.0.0"` -> `"1.0.1"`).
2. Open `package.json` (and optionally `app.json`) and update the `"version"` field to match your new `versionName` so your node environment stays in sync.

#### 2. Build and install a release APK
```bash
# Windows
.\build-android.bat

# Mac/Linux
./build-android.sh
```

Once built, you can install the APK directly to your primary user profile via ADB:
```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

#### Installing to Android 15 Private Space (or Work Profile)
Android 15 Private Space acts as a separate OS User Profile. To install your local APK securely inside it via the terminal:

1. Connect your device and find your Private Space User ID by running:
   ```bash
   adb shell pm list users
   ```
   *(Look for the entry labeled `Private space` or `Work profile` and note the ID number immediately after the `{` e.g., `UserInfo{10:Private space...}` -> ID is `10`)*
2. Install your compiled APK directly into that profile using the `--user` flag:
   ```bash
   adb install --user <USER_ID> android/app/build/outputs/apk/release/app-release.apk
   ```
   *Alternative:* You can also copy the `.apk` file to your phone's internal storage, open the "Files" app located *inside* your Private Space, and tap the file to install it.

#### 3. Build and run in Debug Mode
```bash
npx expo run:android
```

## Debugging on Real Devices

### iOS Debugging

1. **Xcode Console**: With the app running from Xcode, the Debug navigator shows live system and native logs.
2. **Safari Web Inspector** (JS console on a real iPhone):
   - Enable **Settings → Safari → Advanced → Web Inspector** on your iPhone.
   - On your Mac open **Safari → Develop → [your device] → Lomorage**.
3. **Flipper / Expo Dev Tools**: Shake the device to open the Dev Menu, then tap **Open JS Debugger** to attach Chrome DevTools via Metro.
4. **iOS Background Task Logs** (macOS Console app):
   - Open the **Console** app, filter by **Process: lomomobile**.
   - Look for `BGAppRefreshTask` and `BGProcessingTask` entries to verify background sync scheduling.

### Android Debugging

1. **Connect ADB**: Connect your phone via USB and ensure it's detected:
   ```bash
   adb devices
   ```
   > **Prerequisite**: Ensure USB Debugging is enabled on your Android device.

2. **Start Metro Bundler**:
   ```bash
   npx expo start
   ```
   > Metro runs on port `8081` by default.

3. **Load the App**:
   - Open the **Lomorage** dev client installed on your phone.
   - It auto-detects Metro if the phone and PC are on the same Wi-Fi subnet.
   - If not detected, **shake the phone** → **Dev Menu → Settings → Change Bundle Location** and enter your PC's IP (e.g. `192.168.1.10:8081`).

4. **Remote Inspection (Chrome DevTools)**:
   - Navigate to `chrome://inspect` in Chrome.
   - Under **Remote Target**, find your device and click **Inspect**.

5. **Monitor Background Tasks (ADB Logcat)**:
   ```bash
   # General FileSystem operations
   adb logcat | grep "FileSystem"

   # Background task execution and scheduling
   adb logcat | grep "BackgroundTask"

   # Lomorage-specific logs (hashing, sync progress)
   adb logcat | grep "Lomorage"

   # Merkle Tree sync logs
   adb logcat | grep "MerkleSync"

   # Native radio hardening and network state
   adb logcat | grep "NativeRadio"

   # WorkManager (Android background task scheduler)
   adb logcat | grep "WorkManager"
   ```

## Production & Stability Testing (18,000 Photo Sync)

For testing massive gallery syncs (e.g., 18,000 photos), it is highly recommended to use a **Production APK** to avoid the overhead of the Metro bundler and ensure real-world performance.

### Build and Install Release APK:
```bash
# Build the release APK
npx expo run:android --variant release

# The APK will be located at: android/app/build/outputs/apk/release/app-release.apk

# Install the APK on your device (replace with actual path)
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

### Checklist for 18,000 Photo Sync Success:
-   **Server URL & Token**: Ensure the correct Lomorage server URL and user token are configured in the app settings.
-   **Battery Optimization**: Set the app to "Unrestricted" battery usage in Android settings to prevent the OS from killing background tasks.
-   **Always-On Sync (Foreground Service)**: Verify the persistent "Lomorage is syncing" notification is active. This indicates the app is running as a Foreground Service, crucial for maintaining Wi-Fi radio and preventing OS termination.
-   **Progress Tray Monitoring**: Observe the real-time progress updates in the notification tray.
-   **Wi-Fi Only**: Ensure the device is connected to a stable Wi-Fi network.
-   **Native Hasher**: Confirm that the native hashing module is active for performance. A JS fallback is used for specific edge cases (e.g., `atob` fix for certain file types).
-   **Special Character Support**: Test filenames containing `#` (e.g., `photo#1.jpg`) or other URL-unfriendly characters. The app should correctly escape these for hashing and upload.
-   **Duplicate Check**: Verify the app correctly identifies and skips duplicate files (HTTP 200/409 responses).
-   **Resumable Uploads**: Test network interruptions to ensure uploads resume from where they left off (HTTP 206 responses).
-   **Memory Overload**: Monitor device memory usage during large syncs. The app is optimized to process assets in batches (e.g., `MediaService.getAssets(50)`) to prevent memory exhaustion.
-   **Radio Hardening**: The app implements native radio hardening to maintain network connectivity during prolonged background operations.
-   **Background Task Registration**: Verify `expo-background-task` and `expo-task-manager` are correctly registering tasks on app boot (e.g., in `App.js`).
-   **SecureStore Persistence**: Ensure user settings and tokens persist across app restarts.
-   **Android 13+ Permissions**: Confirm `POST_NOTIFICATIONS` permission is granted for Android 13+ devices.

## Deep Clean (For Native Glitches & Build Issues)

If you encounter native crashes, "No matching version" errors, or other build issues after dependency changes, perform a deep clean:

```bash
# 1. Clear npm cache and remove node_modules
npm cache clean --force
rm -rf node_modules
# On Windows PowerShell:
# Remove-Item -Recurse -Force node_modules

# 2. Remove native build artifacts
rm -rf android/app/build
rm -rf ios/build

# 3. Reinstall dependencies
npm install --legacy-peer-deps

# 4. Clean Android project (if applicable)
cd android && ./gradlew clean && cd ..

# 5. Rebuild native modules and install pods (for iOS)
npx expo prebuild --clean
cd ios && pod install && cd .. # For iOS

# 6. Verify Expo SDK and dependencies
npx expo doctor
npx expo install --check
npx expo install --fix
```

## Testing

The project uses Jest for unit testing.
```bash
npm test
```
