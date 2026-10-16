#!/usr/bin/env bash
# Emulator regression helper for on-demand AI models (see docs/regression-ai-models.md).
#
#   ai-models.sh lomod-start    start a throwaway lomod on :8000 (fresh data dir, no mDNS)
#   ai-models.sh lomod-stop     stop whatever listens on :8000
#   ai-models.sh fixtures       download face sample images and push them to the phone
#   ai-models.sh clear-log      clear the phone's logcat (do this right before the step under test)
#   ai-models.sh verify         assert on logcat: embeddings, OCR, face detect/match, no crashes
#
# Env: DEV (default emulator-5560, the Lomo_Test_Phone), LOMOD_BIN, WORK (scratch dir).
set -uo pipefail
export MSYS_NO_PATHCONV=1
DEV="${DEV:-emulator-5560}"
LOMOD_BIN="${LOMOD_BIN:-$LOCALAPPDATA/lomorage-it/lomod/lomod-main.exe}"
WORK="${WORK:-${TMPDIR:-/tmp}/lomo-regression}"
PKG=com.wtao.lomo
mkdir -p "$WORK"

adb_() { adb -s "$DEV" "$@"; }

port_pid() { netstat -ano | grep LISTENING | grep ":8000 " | awk '{print $5}' | head -1; }

case "${1:-}" in
  lomod-start)
    [ -x "$LOMOD_BIN" ] || { echo "LOMOD_BIN not found: $LOMOD_BIN"; exit 2; }
    mkdir -p "$WORK/lomod-base/media"
    (cd "$(dirname "$LOMOD_BIN")" && nohup "$LOMOD_BIN" -b "$WORK/lomod-base" --mount-dir "$WORK/lomod-base/media" \
      -p 8000 --port-https 8443 --port-webdev 8090 --no-mdns > "$WORK/lomod.log" 2>&1 &)
    for _ in $(seq 1 20); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/system)" = 200 ] && break
      sleep 1
    done
    echo "lomod: HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/system)  (data: $WORK/lomod-base)"
    echo "Phone address: $(curl -s http://127.0.0.1:8000/system | grep -o '"ListenIPs":\["[^"]*"' | head -1 | grep -o '[0-9.]*'):8000"
    echo "Setup QR link: $(curl -s http://localhost:8000/welcome/qrcode.png -o "$WORK/qr.png" && python3 -c "
import cv2; print(cv2.QRCodeDetector().detectAndDecode(cv2.imread(r'$WORK/qr.png'))[0])" 2>/dev/null)"
    ;;
  lomod-stop)
    pid=$(port_pid)
    if [ -n "$pid" ]; then taskkill //PID "$pid" //F >/dev/null && echo "stopped lomod (pid $pid)"; else echo "nothing on :8000"; fi
    ;;
  fixtures)
    # Public face-recognition sample images, used only as local test data; never committed.
    cd "$WORK" || exit 1
    base=https://raw.githubusercontent.com
    curl -sfL "$base/ageitgey/face_recognition/master/examples/obama.jpg" -o obama.jpg || { echo "download failed: obama"; exit 2; }
    curl -sfL "$base/ageitgey/face_recognition/master/examples/biden.jpg" -o biden.jpg || { echo "download failed: biden"; exit 2; }
    curl -sfL "$base/opencv/opencv/4.x/samples/data/lena.jpg" -o lena.jpg || { echo "download failed: lena"; exit 2; }
    PYTHONUTF8=1 python3 - <<'PY'
from PIL import Image, ImageOps
for n in ("obama", "biden", "lena"):
    im = Image.open(n + ".jpg").convert("RGB")
    im.save(f"T_{n}_1.jpg", quality=92)
    ImageOps.mirror(im).save(f"T_{n}_2.jpg", quality=92)   # same person, second photo
PY
    for f in T_*.jpg; do
      adb_ push "$f" "/sdcard/DCIM/Camera/$f" >/dev/null
      adb_ shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file:///sdcard/DCIM/Camera/$f" >/dev/null
    done
    echo "pushed: $(adb_ shell 'ls /sdcard/DCIM/Camera' | grep -c '^T_') face images (3 people x 2 photos)"
    ;;
  clear-log)
    adb_ logcat -c && echo "logcat cleared on $DEV"
    ;;
  verify)
    log=$(adb_ logcat -d)
    js=$(printf '%s\n' "$log" | grep ReactNativeJS)
    fail=0
    check() {  # name, count, min
      if [ "$2" -ge "$3" ]; then printf 'PASS  %-46s %s\n' "$1" "$2"; else printf 'FAIL  %-46s %s (need >= %s)\n' "$1" "$2" "$3"; fail=1; fi
    }
    zero() {   # name, count
      if [ "$2" -eq 0 ]; then printf 'PASS  %-46s 0\n' "$1"; else printf 'FAIL  %-46s %s\n' "$1" "$2"; fail=1; fi
    }
    cnt() { printf '%s\n' "$1" | grep -cE "$2"; }
    check "CLIP embeddings saved"                 "$(cnt "$js" 'Saved embedding locally')" 1
    check "perceptual hashes saved"               "$(cnt "$js" 'Saved phash .* locally')" 1
    check "OCR text saved"                        "$(cnt "$js" 'Saved OCR text locally')" 1
    check "faces detected (needs fixtures)"       "$(cnt "$js" 'Detected [1-9][0-9]* faces in')" 1
    check "face album created (new person)"       "$(cnt "$js" 'No match for local face .* creating new Face Album')" 1
    check "face matched to existing album"        "$(cnt "$js" 'Match found for local face')" 1
    zero  "model missing / download failures"     "$(cnt "$js" 'Model not downloaded|Model download failed|Model checksum mismatch|AI models unavailable')"
    zero  "text-embedding failures"               "$(cnt "$js" 'Failed to get text embedding')"
    zero  "face-embedding failures"               "$(cnt "$js" 'Failed to generate embedding for cover')"
    zero  "app crashes / ONNX errors"             "$(printf '%s\n' "$log" | grep -E "FATAL EXCEPTION|OrtException" | grep -cE "$PKG|OrtException")"
    printf '%s\n' "$js" | grep -E 'Match found for local face' | sed 's/.*Match found/  e.g. Match found/' | head -3
    [ "$fail" -eq 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
    exit "$fail"
    ;;
  *)
    sed -n '2,10p' "$0"; exit 1 ;;
esac
