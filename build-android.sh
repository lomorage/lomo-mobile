#!/bin/bash

echo "Starting Android Release Build..."

echo "Bumping app version..."
node bump-version.js || exit 1

# Navigate to android directory
echo "Syncing native configurations (Prebuild)..."
npx expo prebuild -p android || exit 1

cd android || exit 1

echo "Building Production APK..."
./gradlew assembleRelease

echo "Building Production AAB (Android App Bundle)..."
./gradlew bundleRelease

cd ..

echo ""
echo "✅ Build Complete!"
echo "APK Location (for local testing / Private Space):"
echo " -> android/app/build/outputs/apk/release/app-release.apk"
echo ""
echo "AAB Location (for Google Play Console upload):"
echo " -> android/app/build/outputs/bundle/release/app-release.aab"
echo ""
