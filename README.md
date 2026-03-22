# Lomorage Mobile

React Native / Expo client for Lomorage.

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm start
   ```

3. Run on Android / iOS (requires native build):
   ```bash
   npx expo run:android
   # or
   npx expo run:ios
   ```

## Production Build

To test the gallery's real-world behavior and performance (without the overhead of the Metro bundler), you should build a production APK.

### Option 1: Local Build (Requires Android SDK)
1. Ensure the New Architecture is enabled in `android/gradle.properties`: `newArchEnabled=true`.
2. Generate the APK:
   ```bash
   npx expo run:android --variant release
   # Or using gradlew directly
   cd android && ./gradlew assembleRelease
   ```
   The APK will be located at: `android/app/build/outputs/apk/release/app-release.apk`.

### Option 2: EAS Build (Cloud)
1. Install EAS CLI: `npm install -g eas-cli`
2. Configure build: `eas build:configure`
3. Run build: `eas build -p android --profile preview`

## Installation & Testing

1. Uninstall any existing development versions of the app from your device.
2. Transfer and install the `app-release.apk` on your Android device.
3. To test **Offline Resilience**:
   - Open the app and log in.
   - Enter **Airplane Mode**.
   *   The gallery should remain fully functional, and the status bar will transition to **Offline** status instead of crashing.

## Testing

The project uses Jest for unit testing.
```bash
npm test
```
