# Regression: on-demand AI models

The ONNX models (CLIP image/text, face) are not bundled in the app. They are downloaded on
demand by `src/services/ModelAssetService.js`. Run this whenever you touch that service, the
model files/URLs, `AIService` model loading, the Settings "AI Models" row, the native
`ExpoLomoHasher` model loading, or the release build config (ABIs, packaging).

## What is covered where

| Layer | What it proves | How |
|---|---|---|
| Jest (automatic, CI) | Manifest, size/SHA-1 checks, reuse of legacy copies, error paths, state/progress events, `AIService` still works through `ModelAssetService` | `npx jest src/services/__tests__/ModelAssetService.test.js src/services/__tests__/AIService` |
| Hosting | The files really are on the CDN, byte-identical to the manifest | Step 0 below |
| Emulator, end to end | A real release build downloads, verifies and loads the models, and AI works on real photos | Steps 1–6 below, `scripts/regression/ai-models.sh` |
| Real device / iOS | arm64 build, iOS download path | Manual, not yet covered (see "Gaps") |

## Step 0: hosting check (no phone needed)

The manifest in `ModelAssetService.js` (`MODEL_FILES`) pins each file's size and SHA-1. Every
file must download from its URL with exactly that SHA-1:

```bash
for f in visual_quant.onnx textual_quant.onnx vocab.json merges.txt; do
  printf "%s " $f; curl -sL https://lomorage.com/models/v1/$f | sha1sum | cut -c1-40
done
curl -sIL https://github.com/lomorage/homepage/releases/download/models-v1/w600k_r50.onnx | grep -iE "^HTTP|content-length"
```

Pass: hashes equal the manifest, face model answers `200` with the manifest size.
Watch out: `lomorage.com` is GitHub Pages and cannot host files over 100MB (that is why the face
model is a Release asset), and `static/models/**` is `-text` in `.gitattributes`; without that,
git converts line endings and the SHA-1 of `vocab.json`/`merges.txt` no longer matches.
When you ship a new model version, add a new folder (`models/v2`) instead of overwriting `v1`:
installed apps verify against their own manifest.

## Emulator end to end

Use the dedicated test phone `emulator-5560` (`Lomo_Test_Phone`), never the dev emulator on 5554
or a real device. The helper defaults to 5560 (`DEV=...` overrides).

1. **Build.** `cd android && ./gradlew assembleRelease -PreactNativeArchitectures=x86_64`, then
   `adb -s emulator-5560 install -r android/app/build/outputs/apk/release/app-release.apk`.
   Check: APK well under 100MB (it was 440MB with bundled models). Do not run `expo prebuild`.
2. **Server.** `scripts/regression/ai-models.sh lomod-start` (throwaway lomod on `:8000`, needs
   the integration lomod bundle at `%LOCALAPPDATA%\lomorage-it\lomod`). It prints the phone
   address and the setup QR link.
3. **Sign in** (fresh install). Open the QR link on the phone:
   `adb -s emulator-5560 shell am start -a android.intent.action.VIEW -d '<link>' com.wtao.lomo`,
   tap CONTINUE, then register (for example `tester` / `tester-pw1`).
   Gotchas: the login screen pre-fills the real NAS address (`10.0.0.185`), change it to the
   test server before logging in; "Create one" on the login page opens the Play Store instead of a
   form; stopping lomod makes the app log out ("Session Expired"), so keep it running.
4. **Download (UI).** Settings → Local AI Features → **AI Models**.
   - Before: "One-time download of about 313 MB" and a **Download** button.
   - During: "Downloading… N% (X MB of 313 MB)", percentage climbing, no button.
   - After: "Downloaded. Runs on this phone, no internet needed."
   Turning the AI switch on also starts it (on Wi-Fi if "Wi-Fi Only" is set).
5. **AI on real photos.** Make the phone look idle so background indexing runs
   (`adb -s emulator-5560 shell dumpsys battery set ac 1; … set status 2`; undo with
   `dumpsys battery reset`), grant photo access in the app, then
   `scripts/regression/ai-models.sh fixtures` (3 people × 2 photos) and restart the app so it
   rescans. Indexing is slow on an emulator (a few seconds per photo); the 6 fixture photos come
   after the ~100 seeded ones.
6. **Verify.** `scripts/regression/ai-models.sh verify` (use `clear-log` right before step 5 for a
   clean window). It asserts on logcat:
   - CLIP embeddings, perceptual hashes and OCR text were saved;
   - faces were detected, new face albums were created, and the second photo of each person was
     matched to the first one's album (similarity should be roughly 0.85–0.97);
   - no `Model not downloaded` / download / checksum errors, no text- or face-embedding failures,
     no app crash or ONNX exception.

   Reference run (2026-10-16, x86_64 release, 1.0.151): 46 embeddings, 6 faces, 3 albums created,
   3 matches (0.92 / 0.88 / 0.95), no errors.
7. **Clean up.** `ai-models.sh lomod-stop`, `adb … dumpsys battery reset`.

Note: the seeded usability photos (`~/Work/lomo-usability/seed-media`) are synthetic shapes with a
caption, so they exercise CLIP/OCR but contain no faces; the face check depends on `fixtures`.

## Gaps (not covered yet, worth doing next)

- **Failure paths on a real build:** download with no network or interrupted midway (the `.part`
  file must never be used), a corrupted file (SHA-1 mismatch must delete it and show Retry), retry
  after failure.
- **Upgrade path:** an install that already has the models in the documents root (old builds
  copied them there) must reuse them without downloading again.
- **Wi-Fi Only:** turning AI on while on cellular must not auto-download; the manual button must.
- **iOS:** the iOS pod no longer bundles models; the download path is only unit-tested.
- **arm64 / real device,** and a low-storage phone (the reason for this change).
- **Release size:** compare the new AAB with the old 472MB one.
- Automating steps 3–5 (sign-in and the Settings taps use screen coordinates today); the helper
  only covers the server, fixtures and assertions.
