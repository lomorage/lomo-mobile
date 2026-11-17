---
name: run-e2e-regression
description: Build the current lomo-mobile code, install it on the test emulator against an isolated lomod and walk every user flow (sign-up, backup, timeline, big-photo view for every photo shape, zoom, video, search, albums, favorites, delete, share, Free Up Space, settings), fixing what is broken. Use for end-to-end/regression testing, "test it on the emulator", checking a UI bug (e.g. big-photo position/size), or before a release.
---

# End-to-end regression on the emulator

You (this session) drive the phone as a user would: look at screenshots, tap, judge the experience, then fix the code and re-verify on a rebuilt app. Unlike `run-persona-audit` (a separate fresh session judging first-time onboarding of the **live** build), this tests the **current working tree** and you may change code. Build and install yourself when the user asks for e2e/regression; do not ask them to build.

## 0. Rules
- Phone = `emulator-5560` (`Lomo_Test_Phone`, dedicated AVD). Never touch `emulator-5554` (user's dev emulator) or a real phone; every adb call uses `-s emulator-5560`.
- Never point the app at the user's real lomod (`localhost:8000`, `10.0.0.185`): the seed photos would land in their real library. Always start an isolated one (step 2).
- Harness: `C:\Users\fuji2\Work\lomo-usability\phone.sh` (`shot [label]`, `screen`, `tap X Y`, `swipe X1 Y1 X2 Y2 [ms]`, `type`, `key back|enter`). Coordinates are in **screenshot pixels** (540 wide = half of 1080). Always `Read` the screenshot, do not trust `screen` text alone. Git Bash needs `export MSYS_NO_PATHCONV=1` for `/sdcard` paths.

## 1. Start the phone
`"%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe" -avd Lomo_Test_Phone -port 5560 -no-snapshot-save` in the background; wait for `getprop sys.boot_completed` = 1. Seed photos live in `lomo-usability\seed-media\` (100 landscape photos 2000x1500 + 3 videos: H.264 12 s, H.264 1080p 45 s, HEVC 8 s). The AVD may still hold **older** versions of the videos (7 KB single-frame clip, MPEG-4 Part 2): compare sizes with `adb shell ls -la /sdcard/DCIM/Camera` and re-push from seed-media (then `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/DCIM/Camera/<f>`), otherwise "video does not play" is a test artifact, not a bug.

## 2. Isolated lomod (fresh, empty, first user may register)
```
B=/c/Users/fuji2/AppData/Local/Lomorage/lomod; D=$(cygpath -w ~/lomod-e2e); mkdir -p ~/lomod-e2e/media
cd $B && (nohup ./lomod.exe -b "$D" --mount-dir "$D\\media" -p 8765 --port-https 8766 --port-webdev 8767 --no-mdns > ~/lomod-e2e/lomod.log 2>&1 &)
curl -s http://127.0.0.1:8765/system     # SystemStatus 0 = first run, registration allowed
```
Phone reaches it at `10.0.2.2:8765`. To start over: kill that lomod, `rm -rf ~/lomod-e2e`, restart. Stored files appear in `~/lomod-e2e/media/alice/Photos/master/<yyyy>/<mm>/<dd>/<date>_<id>.jpg` (lomod does not keep original filenames, so remote items show `103.jpg`-style names: not an app bug). Server log: `~/lomod-e2e/lomod.log` (requests show up as `"POST /album HTTP/1.1"`).

## 3. Build and install the current tree (about 1 min incremental)
Release signing secrets are never used; sign with the debug keystore, x86_64 only:
```
cd ~/Work/lomo-mobile/android && ./gradlew assembleRelease -PreactNativeArchitectures=x86_64 \
  -Pandroid.injected.signing.store.file="$(cygpath -w $PWD/app/debug.keystore)" -Pandroid.injected.signing.store.password=android \
  -Pandroid.injected.signing.key.alias=androiddebugkey -Pandroid.injected.signing.key.password=android > ~/gradle.log 2>&1
adb -s emulator-5560 install -r "$(cygpath -w $PWD/app/build/outputs/apk/release/app-release.apk)"   # Windows path! a /c/... path fails
adb -s emulator-5560 shell am force-stop com.wtao.lomo; adb -s emulator-5560 shell am start -n com.wtao.lomo/.MainActivity
```
First install over an app signed with another key: `adb uninstall com.wtao.lomo` first. Check the installed `versionName` with `aapt dump badging` so you know the APK matches the tree (an old `app-release.apk` lying around is a trap: 1.0.151 was once installed by mistake). Skip `expo prebuild`.

## 4. Test media for every shape
`python gen_shapes.py <dir>` (this folder; needs Pillow) writes portrait, square, panorama, 1:4 tall and EXIF-rotated (90/180 degree) photos with a blue marker in the top-left corner. Push to `/sdcard/Pictures/`, run the MEDIA_SCANNER broadcast, then **force-stop and restart the app** (it does not notice new media while running). The seed set alone is all-landscape and would not catch shape bugs.

## 5. Flows to walk (screenshot each; compare local vs remote-only)
1. **Sign-up**: Set up Lomorage, Create Account, server `10.0.2.2:8765` (the disk loads **once**, no per-keystroke lookups; check the log), username/password/confirm (scroll to the button), "Signed in" alert, Continue, Allow all, notifications.
2. **Backup**: header cloud icon turns into a green check; `Free Up Space` banner appears. Server log shows uploads.
3. **Timeline**: groups by month, 3 columns, EXIF-rotated thumbnails right way up (blue marker top-right for rot90, bottom-right for rot180). Many photos are ~1/month so one tile per row is **expected** with the seed set.
4. **Big photo, local**: open each shape; it fits inside the white photo area, centered, marker correct. Swipe left/right through all. Open a tile deep in the list and a right-column tile, and screenshot immediately after the tap (transition).
5. **Zoom**: double-tap near an edge/corner: the picture must fill the photo area with no white gap and never overflow onto the header/footer; double-tap again resets; double-tap at the opposite corner zooms there. (Bug found 2026-11: used screen size instead of view size.)
6. **Free Up Space**: Photos, Select All, Delete, system confirm, "Space freed". Then repeat 4/5 on **remote-only** items (server preview, 640 px, will look soft: by design).
7. **Video**: tap a video tile, it autoplays with a moving timer; controls appear on tap; the date line must not read 12/31/1969.
8. **Search**: "2024" (date) and a word; result tiles open the right photo; **no "99% Match" badge on date-only results**. Back returns to the search screen; Cancel leaves it.
9. **Albums**: Duplicates Cleanup (empty = "Your library is clean!" with the seed set), Favorites (heart on a photo makes it appear), `+` New Album, add via the chips under a photo, open the album and a photo from it (filename and date must be filled, not blank).
10. **Delete** a photo (confirm, next photo shows), **Share** (system chooser opens), **Map** (empty state; asks for location when opened), **Settings** and **Backup Status** (counts after freeing: it counts only what is still on the phone, so "3 videos" after freeing 106 photos is by design but reads oddly).

## 6. Harness gotchas
- `key back` closes dialogs/modals (it killed "New Album") and, pressed once too often, leaves the app. Press Save/Cancel with a tap.
- `adb input text` can double the text in a dialog (`TripTrip`): not an app bug; check the field before tapping Save. `uiautomator dump` (`phone.sh screen`) can return nothing while Gboard's floating toolbar is up: use a screenshot.
- Swiping from the top region grabs the swipe-to-dismiss banner, not the list: start list swipes at y >= 500. Fast flings coast past targets: use 600-700 ms drags when hunting for a month header.
- A tap right after a screen change can land on the old screen: wait 3-4 s, re-screenshot.
- After a crash/ANR the app can render black while the hierarchy is fine: restart the emulator with `-no-snapshot-load -no-snapshot-save`.
- Times in screenshots and logcat are the emulator clock.
- Every Bash call is a fresh shell: put `export MSYS_NO_PATHCONV=1` in each one that uses `/sdcard` paths or `com.wtao.lomo/.MainActivity` (otherwise "Activity class does not exist" or `C:/Program Files/Git/...` paths).
- Back from a photo opened in an album returns to that album, not the timeline: tap the in-app Back, then the Photos tab, before replaying a script.
- Whole screen black (no status bar) after relaunching the app = emulator display problem, not the app (check `logcat` for FATAL/ANR first): `adb -s emulator-5560 emu kill`, restart with `-no-snapshot-load -no-snapshot-save`; app, data and photos survive.
- lomod answers `GET /asset/metadata/<hash>` with the Go struct `types.Asset`: capitalised keys (`Name`, `Date`, `Hash`, ...), no `type` field. A video is recognised by its extension. (The detail screen read lowercase keys for a long time, so the on-demand fill never worked.)
- Photos and videos without a taken date have `creationTime` 0 and lomod files them under the upload day; test files pushed with adb have no EXIF date, so "1969"/blank date bugs show up here more than with real photos.

## 7. Fix, then verify
For every defect: reproduce, find the cause in code (do not guess: `adb -s emulator-5560 logcat -d -s ReactNativeJS:*`), fix, add a Jest test (pure logic goes in `src/utils` or a `*Helpers.js` so it can be tested), run `npx jest` and `npx eslint <files>`, rebuild (step 3) and **repeat the exact steps that failed** on the phone. Then run the `code-review` skill (`high`) on the diff, triage each finding (verify against the code, reject the ones that are wrong or belong to someone else's uncommitted work, say why), fix, and repeat until a round finds nothing real in your own changes (this took four rounds once: each fix can introduce a new gesture/race problem). Finish with the full `npx jest`, a rebuild, and one more pass over steps 4-5 and every flow you touched.

## 8. Report
List: what was walked, defects fixed (cause and how verified), defects found but not fixed (and why: design question, server behaviour, test-data artifact), and what could not be tested (real GPS, Live Photos, AI features that need the ~350 MB on-demand models, duplicates with real near-copies, real LAN discovery, iOS).
