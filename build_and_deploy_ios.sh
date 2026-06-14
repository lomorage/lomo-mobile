#!/bin/bash
# Exit immediately if any command fails
set -e

# Load environment variables if they exist in a local .env file
if [ -f .env ]; then
  echo "Loading credentials from .env file..."
  export $(cat .env | grep -v '#' | xargs)
fi

# 1. Check if required environment variables are set
if [ -z "$APPLE_ID" ] || [ -z "$APP_SPECIFIC_PASSWORD" ]; then
  echo "Error: APPLE_ID and APP_SPECIFIC_PASSWORD environment variables are not set."
  echo "Please set them in your terminal session or create a .env file in the project root."
  echo ""
  echo "Example .env file content:"
  echo "  APPLE_ID=\"your-apple-id@email.com\""
  echo "  APP_SPECIFIC_PASSWORD=\"xxxx-xxxx-xxxx-xxxx\""
  exit 1
fi

echo ""
echo "========================================================"
echo "1. Building Production IPA using Fastlane"
echo "========================================================"
echo ""

# Run Fastlane from the ios directory
cd ios
fastlane build_production
cd ..

IPA_PATH="ios/build/lomomobile.ipa"

if [ ! -f "$IPA_PATH" ]; then
  echo "Error: Production IPA was not found at $IPA_PATH"
  exit 1
fi

echo ""
echo "========================================================"
echo "2. Uploading IPA to App Store Connect via xcrun altool"
echo "========================================================"
echo ""

# Upload the built IPA file
xcrun altool --upload-app \
  --type ios \
  --file "$IPA_PATH" \
  --username "$APPLE_ID" \
  --password "$APP_SPECIFIC_PASSWORD"

echo ""
echo "========================================================"
echo "✓ Upload Complete! Apple is processing the build."
echo "========================================================"
echo ""
