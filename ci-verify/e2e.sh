#!/bin/bash
# Runs inside reactivecircus/android-emulator-runner once the emulator has booted.
set -x
OUT=${OUT:-$PWD/out}; mkdir -p "$OUT"
adb wait-for-device
adb shell getprop ro.build.version.release > "$OUT/android-version.txt"
# The CI emulator is slow enough that Pixel Launcher ANRs and its dialog covers the app; the app
# is started with monkey/am, so no launcher is needed.
adb shell pm disable-user --user 0 com.google.android.apps.nexuslauncher || true
adb shell settings put secure anr_show_background 0 || true
adb install -r -g "$APK" || exit 1
adb shell pm grant com.wtao.lomo android.permission.POST_NOTIFICATIONS || true
adb shell dumpsys package com.wtao.lomo | grep -E "versionName|versionCode" > "$OUT/installed-version.txt"
if [ "$SCENARIO" = "26" ]; then
  python3 - <<'PY'
import os
src = open('integration/fixtures/photo-2003-11-01.jpg', 'rb').read()
os.makedirs('/tmp/photos', exist_ok=True)
for i in range(int(os.environ.get('N_PHOTOS', '6'))):
    # bytes after the JPEG end marker: still a valid JPEG, but a different file hash
    open(f'/tmp/photos/IMG_2003110{i}_CI.jpg', 'wb').write(src + f'lomo-ci-{i}'.encode())
PY
  adb shell mkdir -p /sdcard/DCIM/Camera
  for f in /tmp/photos/*.jpg; do adb push "$f" /sdcard/DCIM/Camera/; done
  for f in /tmp/photos/*.jpg; do adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file:///sdcard/DCIM/Camera/$(basename $f)" >/dev/null; done
  adb shell content call --uri content://media/ --method scan_volume --arg external_primary || true
  sleep 5
  adb shell content query --uri content://media/external/images/media --projection _display_name > "$OUT/mediastore-before.txt"
fi
python3 ci-verify/drive.py "$SCENARIO" "$OUT"
if [ "$SCENARIO" = "26" ]; then
  adb shell content query --uri content://media/external/images/media --projection _display_name > "$OUT/mediastore-after.txt"
fi
exit 0
