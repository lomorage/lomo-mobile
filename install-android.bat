@echo off
echo Starting Android Release APK Build and Install...

echo Syncing native configurations (Prebuild)...
call npx expo prebuild -p android
if %errorlevel% neq 0 exit /b %errorlevel%

cd android
if %errorlevel% neq 0 exit /b %errorlevel%

echo Building Production APK...
call gradlew.bat assembleRelease
if %errorlevel% neq 0 exit /b %errorlevel%

cd ..

echo Installing APK to connected device...
adb install -r android\app\build\outputs\apk\release\app-release.apk
if %errorlevel% neq 0 exit /b %errorlevel%

echo.
echo ==============================================
echo [SUCCESS] Build and Install Complete!
echo ==============================================
