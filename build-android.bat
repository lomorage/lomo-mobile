@echo off
setlocal EnableExtensions DisableDelayedExpansion
echo Starting Android Release Build...

rem ---------------------------------------------------------------------------
rem Release signing credentials are never stored in this repository.
rem They come from environment variables, or from an untracked key.properties
rem file in the repo root (copy key.properties.example). Environment variables
rem take precedence over key.properties.
rem
rem   LOMO_KEYSTORE_PASSWORD  (required)  keystore (store) password
rem   LOMO_KEY_PASSWORD       (optional)  key password; defaults to LOMO_KEYSTORE_PASSWORD
rem   LOMO_KEY_ALIAS          (optional)  key alias; defaults to lomo-mobile-key
rem   LOMO_KEYSTORE_PATH      (optional)  keystore file; defaults to lomo-mobile.jks in the repo root
rem
rem key.properties keys: storePassword, keyPassword, keyAlias, storeFile
rem ---------------------------------------------------------------------------

pushd "%~dp0"

if exist "key.properties" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("key.properties") do (
    if /i "%%A"=="storePassword" if not defined LOMO_KEYSTORE_PASSWORD set "LOMO_KEYSTORE_PASSWORD=%%B"
    if /i "%%A"=="keyPassword"   if not defined LOMO_KEY_PASSWORD      set "LOMO_KEY_PASSWORD=%%B"
    if /i "%%A"=="keyAlias"      if not defined LOMO_KEY_ALIAS         set "LOMO_KEY_ALIAS=%%B"
    if /i "%%A"=="storeFile"     if not defined LOMO_KEYSTORE_PATH     set "LOMO_KEYSTORE_PATH=%%B"
  )
)

if not defined LOMO_KEYSTORE_PASSWORD (
  echo.
  echo [ERROR] Release signing password not configured.
  echo   Set the LOMO_KEYSTORE_PASSWORD environment variable ^(and LOMO_KEY_PASSWORD if the key
  echo   password differs^), or copy key.properties.example to key.properties in the repo root
  echo   and fill in storePassword / keyPassword. key.properties is git-ignored; never commit it.
  echo   See README.md, section "Release signing credentials".
  popd
  exit /b 1
)
if not defined LOMO_KEY_PASSWORD set "LOMO_KEY_PASSWORD=%LOMO_KEYSTORE_PASSWORD%"
if not defined LOMO_KEY_ALIAS set "LOMO_KEY_ALIAS=lomo-mobile-key"
if not defined LOMO_KEYSTORE_PATH set "LOMO_KEYSTORE_PATH=lomo-mobile.jks"

rem Resolve a relative keystore path against the repo root.
for %%F in ("%LOMO_KEYSTORE_PATH%") do set "LOMO_KEYSTORE_PATH=%%~fF"
if not exist "%LOMO_KEYSTORE_PATH%" (
  echo.
  echo [ERROR] Keystore not found: "%LOMO_KEYSTORE_PATH%"
  echo   Set LOMO_KEYSTORE_PATH ^(or storeFile in key.properties^) to your release keystore.
  popd
  exit /b 1
)

echo Signing with keystore "%LOMO_KEYSTORE_PATH%", alias "%LOMO_KEY_ALIAS%" (passwords not shown)

echo Syncing native configurations (Prebuild)...
call npx expo prebuild -p android
if %errorlevel% neq 0 popd & exit /b %errorlevel%

cd android
if %errorlevel% neq 0 popd & exit /b %errorlevel%

echo Building Production APK...
call gradlew.bat assembleRelease "-Pandroid.injected.signing.store.file=%LOMO_KEYSTORE_PATH%" "-Pandroid.injected.signing.store.password=%LOMO_KEYSTORE_PASSWORD%" "-Pandroid.injected.signing.key.alias=%LOMO_KEY_ALIAS%" "-Pandroid.injected.signing.key.password=%LOMO_KEY_PASSWORD%"
if %errorlevel% neq 0 popd & exit /b %errorlevel%

echo Building Production AAB (Android App Bundle)...
call gradlew.bat bundleRelease "-Pandroid.injected.signing.store.file=%LOMO_KEYSTORE_PATH%" "-Pandroid.injected.signing.store.password=%LOMO_KEYSTORE_PASSWORD%" "-Pandroid.injected.signing.key.alias=%LOMO_KEY_ALIAS%" "-Pandroid.injected.signing.key.password=%LOMO_KEY_PASSWORD%"
if %errorlevel% neq 0 popd & exit /b %errorlevel%

popd

echo.
echo ==============================================
echo [SUCCESS] Build Complete!
echo ==============================================
echo APK Location (for local testing / Private Space):
echo  -^> android\app\build\outputs\apk\release\app-release.apk
echo.
echo AAB Location (for Google Play Console upload):
echo  -^> android\app\build\outputs\bundle\release\app-release.aab
echo.
pause
