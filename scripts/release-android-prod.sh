#!/usr/bin/env bash
# Build the release AAB and ship it to Google Play production at 100% rollout.
# Usage: scripts/release-android-prod.sh
set -euo pipefail

cd "$(dirname "$0")/.."

AAB="android/app/build/outputs/bundle/release/app-release.aab"
PACKAGE="com.wtao.lomo"
JSON_KEY="fastlane/play-store-credentials.json"

VERSION=$(node -p "require('./app.json').expo.version")
VERSION_CODE=$(node -p "require('./app.json').expo.android.versionCode")
echo "==> Releasing $VERSION ($VERSION_CODE) to production at 100%"

# app.json is the source of truth; android/ is generated, so make sure it agrees before building.
grep -q "versionCode $VERSION_CODE" android/app/build.gradle \
  || { echo "android/app/build.gradle versionCode does not match app.json ($VERSION_CODE)" >&2; exit 1; }
grep -q "versionName \"$VERSION\"" android/app/build.gradle \
  || { echo "android/app/build.gradle versionName does not match app.json ($VERSION)" >&2; exit 1; }

echo "==> Building AAB"
bundle exec fastlane android build_release

# Guard against shipping a stale bundle: the manifest inside the AAB must carry the expected version.
echo "==> Verifying AAB version"
unzip -p "$AAB" base/manifest/AndroidManifest.xml | grep -aqF "$VERSION" \
  || { echo "Built AAB is not version $VERSION; aborting before upload" >&2; exit 1; }

echo "==> Uploading to production (completed = 100% rollout)"
bundle exec fastlane run upload_to_play_store \
  package_name:"$PACKAGE" \
  json_key:"$JSON_KEY" \
  track:production \
  release_status:completed \
  aab:"$AAB" \
  skip_upload_apk:true \
  skip_upload_metadata:true \
  skip_upload_images:true \
  skip_upload_screenshots:true \
  skip_upload_changelogs:true

echo "==> Done: $VERSION ($VERSION_CODE) submitted to production"
