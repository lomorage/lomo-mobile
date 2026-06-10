#!/bin/bash

echo "Starting Android Release Build..."

echo "Bumping version..."
node bump-version.js
if [ $? -ne 0 ]; then
  echo "Failed to bump version"
  exit 1
fi

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
