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

### Android (any platform)

#### Build and run on a device or emulator:
```bash
npx expo run:android
```

#### Build and install a release APK:
```bash
npx expo run:android --variant release

# Install directly via ADB
adb install -r android/app/build/outputs/apk/release/app-release.apk
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
