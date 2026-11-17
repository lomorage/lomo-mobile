---
name: run-persona-audit
description: Run and triage the first-time-user "persona" usability audit of Lomorage (clean session in ~/Work/lomo-usability, test emulator-5560, reset-env.ps1). Use when the user asks to run or rerun the persona audit / usability test, to check a released build, or pastes a persona help request or report.
---

# Persona usability audit (operator side)

The persona is a *separate, fresh* Claude Code session started in `C:\Users\fuji2\Work\lomo-usability`. This session is only the operator: it never plays the persona, never reads the persona's reasoning ahead of time, and does not use this skill from inside that directory (the persona must not see code or memory). Harness files live there: `persona-prompt.md`, `phone.sh` (screenshot/tap only), `operator.sh scan-qr`, `reset-env.ps1`, `seed-media/`, `runs/<stamp>/` archives.

## 0. Decide what is under test
- Say which build: the live Play version (check with the release-android skill's step 0) or a local build. Audit the **live** build when the question is "do we need a new release". Note what changed since the last run (`runs/` and the usability-test memory list past runs and their open findings) so the report can be read against it.
- Rule: every adb call uses `-s <serial>`. Test phone = `emulator-5560` (`Lomo_Test_Phone`). `emulator-5554` is the user's dev emulator and the real Pixel is often plugged in: never touch either. Ask the user to unplug real phones.

## 1. Prepare (operator; the user usually runs these, or approves them)
1. Start the AVD: `"%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe" -avd Lomo_Test_Phone -port 5560` (add `-no-snapshot-load -no-snapshot-save` after a crash; signed in to Google once so Play works). Wait for `adb -s emulator-5560 shell getprop sys.boot_completed` = 1.
2. In `lomo-usability`: `.\reset-env.ps1` (or `-PhoneFull` for a nearly full phone). It archives the last run into `runs/<stamp>/` and **moves** (never deletes) every Lomorage trace on the PC to `%USERPROFILE%\lomorage-test-backups\<stamp>\`, including `Pictures\Lomorage` (missing it once caused a login page instead of first-run setup), uninstalls the app from the phone and restores the seed photos. It only moves files, so it is safe to run; it still changes the PC, so say so before running it for the user.
3. Start the persona: the user opens a fresh session in `C:\Users\fuji2\Work\lomo-usability` and says: `Read persona-prompt.md and run the whole test as that persona. Write the final report to report.md.` A run takes about 20 minutes.

## 2. While the persona runs
- The Windows install is a pasted `irm … install.ps1` with `-ExecutionPolicy Bypass`; the persona session's safety layer needs the **user** to approve it (`.claude/settings.local.json` there allows the exact command). It is a trust event the report should record.
- Never screen-capture the PC (it shows the user's other sessions). `operator.sh scan-qr` first looks at the screen for the QR, then falls back to the image lomod serves at `http://localhost:8000/welcome/qrcode.png`; it targets the app once installed.
- Help requests come back pasted ("I'm stuck at …"). Decide first whether it is a **product problem** (e.g. a real bug: reproduce with `adb -s emulator-5560 logcat`) or an **environment problem** (emulator black screen after ANR, adb offline, wrong server address pre-filled — the login screen pre-fills the user's real NAS 10.0.0.185, change it). Give the persona the minimum a friend would give and record that help was needed. `adb input text` types per character, so it reproduces per-keystroke bugs.
- Do not "help" by fixing code mid-run.

## 3. Read the report (`lomo-usability\report.md`)
- Take the verdict (READY FOR FAMILY USER TEST / NEEDS ONBOARDING FIXES FIRST / CORE FLOW IS BLOCKED), Time to Safe, top drop-offs, trust events and P0/P1 items.
- Compare with the previous run: which earlier findings are now gone (verify, don't assume), which remain, which are new. A finding is only "fixed" if the persona went through that screen on a build that has the fix.
- Separate what can't be judged (emulator, QR simulated, prepared photos, no real LAN discovery) from real findings.
- Classify each finding: app bug (this repo), server (`~/Work/lomod`), website/installer (other repos, e.g. signed Windows installer), or wording.

## 4. After the run
- Offer the fixes grouped by effort; do the ones the user picks as normal PRs (tests first for bugs; real SQLite for data bugs).
- Update the usability-test memory with the run's date, build, verdict and which findings are open/fixed.
- Release a new version only when the user decides (see release-android).
