#!/bin/bash

echo "Starting Android Release APK Build and Install..."

echo "Syncing native configurations (Prebuild)..."
npx expo prebuild -p android || exit 1

cd android || exit 1

echo "Building Production APK..."
./gradlew assembleRelease
if [ $? -ne 0 ]; then
  echo "Failed to build APK"
  exit 1
fi

cd ..

echo "Installing APK to connected device..."
adb install -r android/app/build/outputs/apk/release/app-release.apk
if [ $? -ne 0 ]; then
  echo "Failed to install APK"
  exit 1
fi

echo ""
echo "=============================================="
echo "✅ Build and Install Complete!"
echo "=============================================="
