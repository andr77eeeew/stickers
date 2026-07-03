@echo off
title TikTok Sticker Grabber - Chrome Launcher
echo ==============================================================
echo        LAUNCHING GOOGLE CHROME IN ISOLATED DEBUGGING MODE
echo ==============================================================
echo.
echo This script will launch a brand NEW, isolated Chrome instance
echo with the remote debugging port (9222) fully active.
echo.
echo IMPORTANT ADVANTAGES:
echo 1. You DO NOT need to close your currently open Chrome windows!
echo 2. The debugging port is guaranteed to open successfully.
echo.
echo Note: Since this is an isolated profile, you will need to log 
echo in to TikTok again in this new browser window.
echo.
pause
echo Launching Chrome...
start chrome.exe --remote-debugging-port=9222 --user-data-dir="%~dp0.chrome-profile" "https://www.tiktok.com/messages"
echo.
echo Done. Chrome has been launched.
echo Please keep this command prompt open or close it as you wish.
pause
