@echo off
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EZLabelAgent.vbs" 2>nul
echo Removed. The agent will not start with Windows any more.
echo To stop the copy that is running now, restart the PC or end "pythonw.exe" in Task Manager.
pause
