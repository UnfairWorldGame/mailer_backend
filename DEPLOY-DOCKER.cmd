@echo off
setlocal EnableExtensions
title MAILIQ - Deploy with Docker Desktop

set PROJECT_ID=artful-line-417208
set REGION=asia-south1
set SERVICE=mailiq-api
set AR_REPO=mailiq
set IMAGE=%REGION%-docker.pkg.dev/%PROJECT_ID%/%AR_REPO%/mailer-api:latest

cd /d "%~dp0"

where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker not found. Install Docker Desktop and start it.
  pause
  exit /b 1
)

where gcloud >nul 2>&1
if errorlevel 1 (
  echo ERROR: gcloud CLI not found.
  pause
  exit /b 1
)

echo.
echo === MAILIQ deploy via Docker Desktop ===
echo Image: %IMAGE%
echo.

docker info >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker Desktop is not running. Open Docker Desktop and wait until it says "Running".
  pause
  exit /b 1
)

echo [1/5] Set GCP project...
gcloud config set project %PROJECT_ID%
if errorlevel 1 goto :fail

echo.
echo [2/5] Create registry if needed...
gcloud artifacts repositories create %AR_REPO% --repository-format=docker --location=%REGION% --description="MAILIQ API" 2>nul

echo.
echo [3/5] Login Docker to Google Artifact Registry...
gcloud auth configure-docker %REGION%-docker.pkg.dev --quiet
if errorlevel 1 goto :fail

echo.
echo [4/5] Build image locally (Docker Desktop)...
docker build -t %IMAGE% .
if errorlevel 1 goto :fail

echo.
echo [5/5] Push image and deploy to Cloud Run...
docker push %IMAGE%
if errorlevel 1 goto :fail

gcloud run deploy %SERVICE% ^
  --image %IMAGE% ^
  --region %REGION% ^
  --platform managed ^
  --allow-unauthenticated ^
  --port 8080 ^
  --memory 1Gi ^
  --cpu 1 ^
  --timeout 3600 ^
  --min-instances 1 ^
  --max-instances 10 ^
  --set-env-vars NODE_ENV=production,PORT=8080,HOST=0.0.0.0 ^
  --set-secrets MONGODB_URI=mailiq-mongodb-uri:latest,JWT_SECRET=mailiq-jwt-secret:latest,GEMINI_API_KEY=mailiq-gemini-api-key:latest,PASSWORD_RESET_SMTP_APP_PASSWORD=mailiq-smtp-app-password:latest ^
  --update-env-vars FRONTEND_URL=https://mailc.netlify.app,PASSWORD_RESET_SMTP_EMAIL=mailiq.office@gmail.com,PASSWORD_RESET_FROM_NAME=MAILIQ,CONTACT_INBOX_EMAIL=mailiq.office@gmail.com,ADMIN_EMAILS=m87.krishna@gmail.com
if errorlevel 1 goto :fail

echo.
echo === DONE ===
for /f "delims=" %%u in ('gcloud run services describe %SERVICE% --region %REGION% --format^="value(status.url)"') do set API_URL=%%u
echo API:    %API_URL%
echo Health: %API_URL%/api/health
echo.
echo Netlify env:
echo   VITE_API_URL=%API_URL%/api
echo   VITE_SITE_URL=https://mailc.netlify.app
echo.
pause
exit /b 0

:fail
echo.
echo DEPLOY FAILED. Check errors above.
pause
exit /b 1
