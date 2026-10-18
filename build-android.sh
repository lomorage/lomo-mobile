#!/bin/bash

echo "Starting Android Release Build..."

# Release signing credentials are never stored in this repository. They come from
# environment variables, or from an untracked key.properties file in the repo root
# (copy key.properties.example). Environment variables take precedence.
#
#   LOMO_KEYSTORE_PASSWORD  (required)  keystore (store) password
#   LOMO_KEY_PASSWORD       (optional)  key password; defaults to LOMO_KEYSTORE_PASSWORD
#   LOMO_KEY_ALIAS          (optional)  key alias; defaults to lomo-mobile-key
#   LOMO_KEYSTORE_PATH      (optional)  keystore file; defaults to lomo-mobile.jks in the repo root
#
# key.properties keys: storePassword, keyPassword, keyAlias, storeFile

cd "$(dirname "$0")" || exit 1
REPO_ROOT="$(pwd)"

# Read one key from key.properties (no sourcing, so values are never executed).
read_prop() {
  [ -f "$REPO_ROOT/key.properties" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$REPO_ROOT/key.properties" | tail -n 1 | tr -d '\r'
}

: "${LOMO_KEYSTORE_PASSWORD:=$(read_prop storePassword)}"
: "${LOMO_KEY_PASSWORD:=$(read_prop keyPassword)}"
: "${LOMO_KEY_ALIAS:=$(read_prop keyAlias)}"
: "${LOMO_KEYSTORE_PATH:=$(read_prop storeFile)}"

if [ -z "$LOMO_KEYSTORE_PASSWORD" ]; then
  cat >&2 <<'MSG'

[ERROR] Release signing password not configured.
  Set the LOMO_KEYSTORE_PASSWORD environment variable (and LOMO_KEY_PASSWORD if the key
  password differs), or copy key.properties.example to key.properties in the repo root
  and fill in storePassword / keyPassword. key.properties is git-ignored; never commit it.
  See README.md, section "Release signing credentials".
MSG
  exit 1
fi
: "${LOMO_KEY_PASSWORD:=$LOMO_KEYSTORE_PASSWORD}"
: "${LOMO_KEY_ALIAS:=lomo-mobile-key}"
: "${LOMO_KEYSTORE_PATH:=lomo-mobile.jks}"
case "$LOMO_KEYSTORE_PATH" in
  /*) ;;
  *) LOMO_KEYSTORE_PATH="$REPO_ROOT/$LOMO_KEYSTORE_PATH" ;;
esac
if [ ! -f "$LOMO_KEYSTORE_PATH" ]; then
  echo "[ERROR] Keystore not found: $LOMO_KEYSTORE_PATH" >&2
  echo "  Set LOMO_KEYSTORE_PATH (or storeFile in key.properties) to your release keystore." >&2
  exit 1
fi
echo "Signing with keystore $LOMO_KEYSTORE_PATH, alias $LOMO_KEY_ALIAS (passwords not shown)"

SIGNING_ARGS=(
  "-Pandroid.injected.signing.store.file=$LOMO_KEYSTORE_PATH"
  "-Pandroid.injected.signing.store.password=$LOMO_KEYSTORE_PASSWORD"
  "-Pandroid.injected.signing.key.alias=$LOMO_KEY_ALIAS"
  "-Pandroid.injected.signing.key.password=$LOMO_KEY_PASSWORD"
)

echo "Syncing native configurations (Prebuild)..."
npx expo prebuild -p android || exit 1

cd android || exit 1

echo "Building Production APK..."
./gradlew assembleRelease "${SIGNING_ARGS[@]}" || exit 1

echo "Building Production AAB (Android App Bundle)..."
./gradlew bundleRelease "${SIGNING_ARGS[@]}" || exit 1

cd ..

echo ""
echo "✅ Build Complete!"
echo "APK Location (for local testing / Private Space):"
echo " -> android/app/build/outputs/apk/release/app-release.apk"
echo ""
echo "AAB Location (for Google Play Console upload):"
echo " -> android/app/build/outputs/bundle/release/app-release.aab"
echo ""
