---
name: sim-e2e
description: Run lomo-mobile end to end on the iOS simulator against a throwaway lomod, driving the real UI with axe. This is the release gate — use it before every release (before running build_and_deploy_ios.sh, bumping the version, or uploading to App Store Connect), and whenever asked to "test on the emulator/simulator", "run it end to end", "smoke test the app", "check it actually works on a device", or to verify a change that unit tests can only reach through mocks (backup, sync, AI indexing, login/registration, the remote tree). Reach for it even when Jest and the integration suite are already green, because neither one launches the app.
---

# End-to-end run on the iOS simulator

## Why this exists

`npm test` mocks the network, and the integration suite (`npm run test:integration`)
talks to a real lomod but **stubs `AIService` entirely** and never renders a screen.
So a change can be green on both and still ship an app that crashes on launch, fails
to register, or never starts a backup. This is the only check that runs the shipping
binary against a real server.

Run it before a release. A release uploaded without it is a release nobody has opened.

## Ground rules

**Never point the app at the user's real lomod on `:8000`.** It holds their actual photo
library, and an e2e run registers users, uploads and deletes. Always start a throwaway
lomod on `:8100` with its own scratch directory, and leave `:8000` alone — don't stop it,
don't log in to it, don't `curl` it.

Build for the **Rosetta x86_64 simulator**. ML Kit ships no arm64-simulator slice, so an
arm64 simulator build fails to link with missing-symbol errors from the MLKit frameworks.
The way around it is a simulator created from the *universal* iOS 26.2 runtime, run under
Rosetta, built with `ARCHS=x86_64` — hence "iPhone 17 Pro (26.2 Rosetta)" below.

## 1. Check prerequisites

```bash
xcrun simctl list devices available | grep "26.2 Rosetta"   # need "iPhone 17 Pro (26.2 Rosetta)"
which axe && axe --version                                   # brew install cameroncooke/axe/axe
ls ~/Library/Application\ Support/Lomorage/lomod/lomod       # the throwaway server binary
```

If the Rosetta simulator is missing, create it from the universal iOS 26.2 runtime; if
`axe` is missing, `brew install cameroncooke/axe/axe`. Stop and tell the user if the lomod
binary is absent — don't substitute their real server.

## 2. Start the throwaway lomod

```bash
SCRATCH=<scratchpad>/lomod_e2e && rm -rf "$SCRATCH" && mkdir -p "$SCRATCH/media"
~/Library/Application\ Support/Lomorage/lomod/lomod \
  -b "$SCRATCH" --mount-dir "$SCRATCH/media" \
  -p 8100 --port-webdev 8104 --no-mdns
```

Run it in the background and confirm it is listening on 8100 before launching the app.
`--no-mdns` keeps it from advertising itself next to the real server.

## 3. Build and install

Build in the background — it takes several minutes, longer than a foreground timeout:

```bash
cd ios && xcodebuild -workspace lomomobile.xcworkspace -scheme lomomobile \
  -configuration Release -sdk iphonesimulator -destination id=<SIM_UDID> \
  -derivedDataPath build ARCHS=x86_64 ONLY_ACTIVE_ARCH=YES build
```

Then:

```bash
xcrun simctl boot <SIM_UDID>          # harmless if already booted
xcrun simctl install <SIM_UDID> ios/build/Build/Products/Release-iphonesimulator/Lomorage.app
xcrun simctl launch <SIM_UDID> com.wtao.lomo
```

The first launch sits on the splash screen for a while — the JS bundle loads slowly
under Rosetta. Give it ~30s before concluding anything is wrong, and check the process is
still alive (`xcrun simctl spawn <SIM_UDID> launchctl list | grep lomo`) rather than
screenshotting once and calling it hung.

Seed the camera roll before the backup checks, or there is nothing to upload:

```bash
xcrun simctl addmedia <SIM_UDID> <some .jpg/.heic/.mp4 files>
```

`integration/fixtures/` has usable images and videos.

## 4. Create an account

The app's "Create one" link does **not** create a server account, and passwords are hashed
with argon2, so registering by hand with `curl` is not worth it. Drive the real
`AuthService` instead — `getAvailableDisks(address)` then `register(address, user, pw,
disks[0].name, nick)`, the same path `RegisterScreen` uses.

Run it from a scratch jest config that spreads `integration/jest.config.js` and overrides
`rootDir` (absolute, the repo), `roots`/`testMatch` (your scratch test) and `modulePaths`
(the repo's `node_modules`). Keep the base `globalSetup`, which only checks `LOMOD_BIN`, so
pass `LOMOD_BIN=<lomod path>` when invoking jest. Use the address form `127.0.0.1:8100`,
with no scheme. Then log in through the UI with those credentials.

### Dialogs you will hit on the way in

In order, on a fresh install: the **photo library permission** sheet (tap "Allow Full
Access" — without it the gallery stays empty and the backup has nothing to do), sometimes a
**"Session Expired"** alert (a stale token survives an uninstall, because the keychain does),
and after login the system **"Save Password?"** prompt (tap "Not Now") plus an in-app
"Making your photos searchable" banner ("Got it").

### The login form is prefilled with the user's real server

`Server Address` comes up holding whatever was last used — on this machine that is the
**real lomod**, and `Username` is prefilled too. Clear both before logging in. A field's
cursor lands where you tap, so tap near its right edge and send backspaces
(`axe key-sequence --keycodes 42,42,...`, note the flag name) rather than assuming the
field is empty. Screenshot and confirm the address field reads the throwaway server before
tapping Log In.

## 5. Drive the UI with axe

React Native exposes no accessibility tree to `axe`, so there is nothing to query by
name — **tap by coordinate**. Take a screenshot, find the target in pixels, and divide
by 3 (the simulator's scale factor) to get the tap point:

```bash
xcrun simctl io <SIM_UDID> screenshot <scratch>/shot.png
axe tap -x <px/3> -y <py/3> --udid <SIM_UDID>
```

Two quirks worth knowing before you fight them:

- `axe swipe` flings a list all the way to the end. To scroll a controlled amount use
  `axe drag --duration 1.5` instead.
- Switches often ignore a plain `tap`; use `axe touch --down --up` on them.

Re-screenshot after every interaction. The layout shifts, and coordinates computed from
a stale screenshot tap the wrong thing.

## 6. What to actually verify

Confirm each of these, with a screenshot as evidence:

1. **Launch** — the app opens to the login/onboarding screen without a redbox or crash.
2. **Login** — logging in against `:8100` lands on the home screen.
3. **Backup** — the backup kicks off by itself after login. Open the cloud icon in the
   header for the Backup Status sheet and wait for "Backup complete", then confirm it on the
   server rather than trusting the UI: masters land under
   `$SCRATCH/media/<user>/Photos/master/<yyyy>/<mm>/<dd>/` with generated previews beside
   them in `preview/`. Count them against the camera roll.
4. **Remote tree** — after the backup, the gallery shows the uploaded assets, and a
   relaunch still shows them (this is the `fetchRemoteOverview()` path, including the
   refresh that follows a backup).
5. **AI indexing** — only if the change touches it. Turn **off** AI "Charging Only" in
   Settings first; the simulator never reports charging, so indexing otherwise never
   starts and you will wrongly conclude it is broken.

For a change in a specific area, add a check that would have caught the bug being fixed,
and say in the report which checks were run and which were skipped.

**Not a bug:** the header cloud icon disappears after a relaunch when everything is already
backed up. It renders only when `backupState.totalCount > 0 || backupState.isBackingUp`
(see HomeScreen), which is backup-*session* state, not server connectivity — a fresh launch
with nothing pending has no session, so there is nothing to show. To check the app really is
talking to the server, read the lomod log instead of the header: authenticated
`GET /assets/merkletree` and `GET /preview/...` lines are the proof.

The lomod log is also the best evidence for sync behaviour in general. For example, two
`fetchRemoteOverview()` callers landing a second apart rather than simultaneously is what
serialized overview fetches look like from the server's side.

## 7. Reading logs

Release builds forward only `console.error` to the device log, so most `console.log`
tracing is invisible:

```bash
xcrun simctl spawn <SIM_UDID> log stream --predicate 'process == "Lomorage"' --level debug
```

If you need `console.log` output, build `-configuration Debug` instead.

## 8. Clean up

Stop the throwaway lomod, delete its scratch directory, and uninstall the app
(`xcrun simctl uninstall <SIM_UDID> com.wtao.lomo`) so the next run starts clean. Leave
the simulator booted or shut down as you found it. Never clean anything under the real
server's data directory.

## Where this fits in a release

Run this **before** the version bump and `./build_and_deploy_ios.sh`. If it finds a
problem after an upload has already happened, the build is still only processing at
Apple — say so plainly and don't submit it for review until the issue is understood.
