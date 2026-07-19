@echo off
REM Do NOT double-click .ps1 files — Windows opens them in Notepad.
REM Run this from Command Prompt or PowerShell:  cd backend\scripts  then  setup-gcp.cmd

cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gcp-first-time-setup.ps1"
if errorlevel 1 pause
