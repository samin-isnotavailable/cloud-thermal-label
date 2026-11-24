@echo off
rem Makes the EZ Label agent start by itself when you sign in to Windows.
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\EZLabelAgent.vbs"
where pythonw >nul 2>nul
if errorlevel 1 (
  echo Could not find pythonw. Make sure Python is installed and added to PATH.
  pause
  exit /b 1
)
if not exist "%~dp0agent_config.json" (
  echo Run this first, in a normal window:  python ezagent.py
  echo Enter the app address and printer key, then run this file again.
  pause
  exit /b 1
)
> "%VBS%" echo Set sh = CreateObject("WScript.Shell")
>> "%VBS%" echo sh.CurrentDirectory = "%~dp0"
>> "%VBS%" echo sh.Run "pythonw ""%~dp0ezagent.py""", 0, False
start "" wscript "%VBS%"
echo Done. The agent is running now and will start every time you sign in to Windows.
echo Its log is in %~dp0agent.log
pause
