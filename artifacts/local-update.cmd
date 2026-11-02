@echo off
rem Run by the Windows task scheduler, not by the app: it has to outlive Prophey quitting.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\projects\js\pi-mcps\scripts\install-local-update.ps1" -Setup "D:\projects\js\pi-mcps\release\Prophey-0.6.33-Setup.exe"
