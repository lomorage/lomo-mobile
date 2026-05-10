#!/bin/bash

echo "Starting Android Release Build..."

# Navigate to android directory
cd android || exit

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
