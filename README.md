# Lomorage Mobile

React Native / Expo client for Lomorage, optimized for massive gallery syncs (18,000+ photos).

## Prerequisites

- **Node.js**: 20.x or later
- **Android SDK**: Required for local builds and ADB debugging.
- **Physical Devices**: Must be on the **same Wi-Fi network** as your development PC.
- **Lomorage Dev Client**: An Expo development client for Lomorage must be installed on your device.

## Installation

1.  Install dependencies (requires legacy-peer-deps for Expo SDK 54 compatibility):
    ```bash
    npm install --legacy-peer-deps
    ```

2.  Generate and install a fresh Development Client (required for first-time setup or native changes):
    ```bash
    # This builds and installs the "Lomorage Debug Engine" on your Android phone.
    # For iOS, use `npx expo run:ios`.
    npx expo run:android
    ```
    *   **Note**: If you already have a dev client installed, you can update it using `adb install -r <path_to_apk>`.

## iOS Development on Windows

Since Lomorage uses a custom native module (`expo-lomo-hasher`), **Expo Go cannot be used**. You must use a Development Client build.

### Option 1: EAS Build (Recommended for Windows)
If you don't have a Mac, you can build the iOS app in the cloud using Expo Application Services (EAS):

1.  **Install EAS CLI**: `npm install -g eas-cli`
2.  **Login**: `eas login`
3.  **Build Development Client**:
    ```bash
    eas build --platform ios --profile development --local=false
    ```
4.  **Install on Device**: Follow the link provided by EAS to install the app on your physical iPhone.
5.  **Start Dev Server**: `npx expo start --dev-client`

### Option 2: Local Build (Requires macOS)
If you have access to a Mac:
1.  **Prebuild**: `npx expo prebuild`
2.  **Run**: `npx expo run:ios` (or open `.xcworkspace` in Xcode).

## Debugging on Real Devices

To debug logic and monitor background syncs across multiple phones:

1.  **Connect ADB**: Connect your phone via USB and ensure it's detected:
    ```bash
    adb devices
    ```
    *   **Prerequisite**: Ensure USB Debugging is enabled on your Android device.

2.  **Start Metro Bundler**:
    ```bash
    npx expo start
    ```
    *   **Note**: Metro typically runs on port `8081`.

3.  **Load the App**:
    *   Open the **Lomorage** app (the custom dev client) installed on your phone.
    *   It should automatically detect the Metro bundler if your phone and PC are on the same Wi-Fi network and subnet.
    *   If not, **shake the phone** to open the **Dev Menu** -> **Settings** -> **Change Bundle Location** and enter your PC's IP address (e.g., `192.168.1.10:8081`).

4.  **Remote Inspection (Chrome DevTools)**:
    *   Open Chrome on your development PC and navigate to `chrome://inspect`.
    *   Under "Remote Target", find your device and click "Inspect" to open the Chrome DevTools. This allows you to view console logs, network requests, and debug the JavaScript context.

5.  **Monitor Background Tasks (ADB Logcat)**:
    Use ADB to watch the background engine work silently. Filter logs for specific components:
    ```bash
    # General FileSystem operations
    adb logcat | grep "FileSystem"

    # Background task execution and scheduling
    adb logcat | grep "BackgroundTask"

    # Lomorage-specific logs (e.g., hashing, sync progress)
    adb logcat | grep "Lomorage"

    # For detailed Merkle Tree sync logs
    adb logcat | grep "MerkleSync"

    # For native radio hardening and network state
    adb logcat | grep "NativeRadio"

    # For WorkManager (Android background task scheduler) logs
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
