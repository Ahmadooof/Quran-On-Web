@echo off
:: Auto-detects your current public IP and allows it on the Umami dashboard.
:: Just double-click this file whenever your IP changes.

set SERVER=linuxuser@66.42.80.81
set KEY=%USERPROFILE%\.ssh\id_ed25519

echo Detecting your public IP...
for /f %%i in ('curl -s https://api.ipify.org') do set MYIP=%%i
if "%MYIP%"=="" (
    echo ERROR: Could not detect your IP. Check your internet connection.
    pause
    exit /b 1
)
echo Your IP: %MYIP%

echo Updating Umami allow-list on server...
ssh -i "%KEY%" %SERVER% "printf 'allow %MYIP%;\ndeny  all;\n' | sudo tee /etc/nginx/snippets/umami-allow.conf > /dev/null && sudo nginx -t && sudo systemctl reload nginx && echo Done."
if errorlevel 1 (
    echo ERROR: Could not reach the server.
    pause
    exit /b 1
)

echo.
echo Access granted for %MYIP%. Open https://analytics.readqurantoday.com
pause
