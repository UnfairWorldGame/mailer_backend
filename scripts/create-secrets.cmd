@echo off
REM Upload secrets from backend\.env to Google Secret Manager
REM Run: cd backend\scripts  then  create-secrets.cmd

cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-gcp-secrets.ps1"
if errorlevel 1 pause
