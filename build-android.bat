@echo off
echo Starting Android Release Build...

echo Bumping version...
node bump-version.js
if %errorlevel% neq 0 exit /b %errorlevel%

cd android
if %errorlevel% neq 0 exit /b %errorlevel%

echo Building Production APK...
call gradlew.bat assembleRelease
if %errorlevel% neq 0 exit /b %errorlevel%

echo Building Production AAB (Android App Bundle)...
call gradlew.bat bundleRelease
if %errorlevel% neq 0 exit /b %errorlevel%

cd ..

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
