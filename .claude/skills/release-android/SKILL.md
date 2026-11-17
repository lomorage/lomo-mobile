---
name: release-android
description: Cut and publish an Android release of lomo-mobile to Google Play with fastlane (version bump PR, build and upload to the internal track, promote to production). Use when the user asks to release, publish, ship, bump the version, or "fastlane发布".
---

# Release lomo-mobile (Android) to Google Play

Shell: PowerShell for fastlane (the signing password lives in a Windows *user* env var). One fastlane command at a time.

## 0. Decide the version and see what Play has

Play is the source of truth, not memory or git:

```powershell
fastlane run google_play_track_version_codes track:production package_name:com.wtao.lomo json_key:fastlane/play-store-credentials.json
fastlane run google_play_track_version_codes track:internal   package_name:com.wtao.lomo json_key:fastlane/play-store-credentials.json
```

Read the `Result: [...]` line. A bump that was merged is not necessarily published (1.0.153 never was). The new `versionCode` must be higher than every number listed.

## 1. Version bump PR

Branch off `master`, change in one commit (mirror an earlier "bump ver to …" commit):
- `app.json`: `expo.version`, `expo.ios.buildNumber` (+1), `expo.android.versionCode` (`1000000 + patch`, e.g. 1.0.154 -> 1000154)
- `package.json`: `version`

Open a PR, and have the user merge it. Do not build before the user says it is merged, unless they ask to build from the branch.

## 2. Sync the generated Android project (the trap)

`android/` is generated and git-ignored. `android/app/build.gradle` keeps the old values after a bump, so the AAB is built with a used version code and Play rejects the upload. Set both lines to match `app.json`:

```
versionCode <android.versionCode>
versionName "<version>"
```

Also check `android/app/src/main/res/values/strings.xml`: `app_name` must equal `expo.name` in `app.json` (it is what Android permission dialogs and the launcher show; it was `lomomobile` until 1.0.155).

(`build-android.sh` does this by running `expo prebuild`; the fastlane lane does not. Do not run `prebuild` just for this.)

## 3. Build and upload to the internal track (draft)

```powershell
Set-Location C:\Users\fuji2\Work\lomo-mobile
$env:LOMO_KEYSTORE_PASSWORD = [Environment]::GetEnvironmentVariable('LOMO_KEYSTORE_PASSWORD','User')
fastlane android deploy 2>&1 | Tee-Object -FilePath "$env:TEMP\fastlane-deploy.log" | Out-Null
```

Run it in the background (a build takes 6-10 minutes) and wait for the completion notice; do not poll. Do not run any other fastlane/Play command meanwhile: each opens its own Play edit and the upload fails with "This edit has expired".

Success is `Successfully finished the upload to Google Play` in the log. Never print the log without redacting passwords.

Failures seen:
- `Version code N has already been used`: step 2 was skipped.
- `This edit has expired`: another Play call ran at the same time; just rerun.

## 4. Promote to production

Production is outward-facing. Only do this when the user asked for it in this conversation ("发布", "rollout 100%"); an earlier release's approval does not carry over. If they only said "release" without a rollout, stop after step 3 and ask.

```powershell
fastlane android promote_to_production version_code:<versionCode>
```

Always pass `version_code` (the lane defaults to app.json's, but being explicit is cheap). Without it Play promotes the internal track's *current* release, which can be an older build and gets refused ("does not allow any existing users to upgrade"). Nothing changes in production when it is refused.

## 5. Verify and clean up

Re-run the production query from step 0: it should list only the new version code. That means Play accepted the release, not that users have it: Google's review follows, and the user checks Play Console or the Play Store listing.

Then `git checkout master; git pull` and delete the bump branch.

## Signing

`LOMO_KEYSTORE_PASSWORD` is set by the user (`setx`, new terminals only; Claude cannot set persistent env vars). Optional: `LOMO_KEY_PASSWORD`, `LOMO_KEY_ALIAS` (default `lomo-mobile-key`), `LOMO_KEYSTORE_PATH` (default `lomo-mobile.jks` in the repo root), or an untracked `key.properties` (see `key.properties.example`). Never write the password into a file, a command line that gets echoed, or a message.

## After the release

The user wants the live build checked with the persona audit (see the usability-test memory). Check for the findings the release was meant to fix, and `adb logcat` for regressions.
