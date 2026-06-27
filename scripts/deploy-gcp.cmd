@echo off
REM Build and deploy to Cloud Run (no Docker Desktop needed)
REM Run: cd backend\scripts  then  deploy-gcp.cmd

cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-gcp.ps1"
if errorlevel 1 pause
