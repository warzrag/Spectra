@echo off
echo Testing URL Persistence for AntiDetect Browser
echo ===============================================
echo.

REM Get profile ID from user
set /p PROFILE_ID=Enter Profile ID (or press Enter to skip): 

if "%PROFILE_ID%"=="" (
    echo Please enter a profile ID from your dashboard
    pause
    exit /b 1
)

REM Get URL from user
set /p TARGET_URL=Enter URL to save (e.g., https://twitter.com): 

if "%TARGET_URL%"=="" (
    set TARGET_URL=https://example.com
)

echo.
echo Saving URL "%TARGET_URL%" for profile "%PROFILE_ID%"...
echo.

REM Make sure the app is running
echo Make sure the AntiDetect Browser app is running!
echo.

REM Save the URL using Node.js
node test-save-url.js %PROFILE_ID% "%TARGET_URL%"

echo.
echo ===============================================
echo Now try launching the profile from the app.
echo It should open with the URL: %TARGET_URL%
echo.
echo Check the console for debug logs:
echo - "Profile lastUrl: %TARGET_URL%"
echo - "Chrome launcher - Starting with saved URL: %TARGET_URL%"
echo.
pause