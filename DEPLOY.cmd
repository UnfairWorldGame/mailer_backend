@echo off
setlocal EnableExtensions
title MAILIQ Backend Deploy to Google Cloud Run

set PROJECT_ID=rosy-etching-417006
set REGION=asia-south1
set SERVICE=mailiq-api
set AR_REPO=mailiq

cd /d "%~dp0"
if not exist ".env" (
  echo ERROR: backend\.env not found
  pause
  exit /b 1
)

where gcloud >nul 2>&1
if errorlevel 1 (
  echo ERROR: gcloud CLI not installed. Install from https://cloud.google.com/sdk/docs/install
  pause
  exit /b 1
)

echo.
echo === MAILIQ deploy ===
echo Project: %PROJECT_ID%
echo Region:  %REGION%
echo.

echo [1/6] Login and set project...
gcloud auth login
gcloud config set project %PROJECT_ID%
if errorlevel 1 goto :fail

echo.
echo [2/6] Enable APIs...
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
if errorlevel 1 goto :fail

echo.
echo [3/6] Create Docker registry (ok if already exists)...
gcloud artifacts repositories create %AR_REPO% --repository-format=docker --location=%REGION% --description="MAILIQ API" 2>nul

echo.
echo [4/6] Upload secrets from .env...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$p='%PROJECT_ID%';" ^
  "$f='.env';" ^
  "function gv($k){(Get-Content $f|?{$_ -match ('^\s*'+[regex]::Escape($k)+'\s*=')}|select -First 1)-split '=',2|%%{$_.Trim()}|select -Last 1};" ^
  "function es($n,$v){if(-not $v){Write-Host \"SKIP $n\";return};" ^
  "gcloud secrets describe $n --project $p 2>$null; if($LASTEXITCODE -ne 0){gcloud secrets create $n --project $p --replication-policy=automatic};" ^
  "$t=[IO.Path]::GetTempFileName(); try{[IO.File]::WriteAllText($t,$v); gcloud secrets versions add $n --project $p --data-file=$t; if($LASTEXITCODE -ne 0){throw \"failed $n\"}; Write-Host \"OK $n\"} finally{Remove-Item $t -Force -EA 0}};" ^
  "es 'mailiq-mongodb-uri' (gv 'MONGODB_URI');" ^
  "es 'mailiq-jwt-secret' (gv 'JWT_SECRET');" ^
  "es 'mailiq-gemini-api-key' (gv 'GEMINI_API_KEY');" ^
  "es 'mailiq-smtp-app-password' (gv 'PASSWORD_RESET_SMTP_APP_PASSWORD')"
if errorlevel 1 goto :fail

echo.
echo [5/6] Grant Cloud Run access to secrets...
for /f %%i in ('gcloud projects describe %PROJECT_ID% --format^="value(projectNumber)"') do set PROJECT_NUMBER=%%i
set RUN_SA=%PROJECT_NUMBER%-compute@developer.gserviceaccount.com
for %%s in (mailiq-mongodb-uri mailiq-jwt-secret mailiq-gemini-api-key mailiq-smtp-app-password) do (
  gcloud secrets add-iam-policy-binding %%s --project %PROJECT_ID% --member="serviceAccount:%RUN_SA%" --role="roles/secretmanager.secretAccessor" --quiet >nul 2>&1
)

for /f %%i in ('gcloud projects describe %PROJECT_ID% --format^="value(projectNumber)"') do set PROJECT_NUMBER=%%i
set CB_SA=%PROJECT_NUMBER%@cloudbuild.gserviceaccount.com
gcloud projects add-iam-policy-binding %PROJECT_ID% --member="serviceAccount:%CB_SA%" --role="roles/run.admin" --quiet >nul 2>&1
gcloud projects add-iam-policy-binding %PROJECT_ID% --member="serviceAccount:%CB_SA%" --role="roles/iam.serviceAccountUser" --quiet >nul 2>&1

echo.
echo [6/6] Build image in cloud and deploy to Cloud Run (5-10 min)...
gcloud builds submit --config cloudbuild.yaml .
if errorlevel 1 goto :fail

echo.
echo === DONE ===
for /f "delims=" %%u in ('gcloud run services describe %SERVICE% --region %REGION% --format^="value(status.url)"') do set API_URL=%%u
echo API:    %API_URL%
echo Health: %API_URL%/api/health
echo.
echo Set in Netlify - Site settings - Environment variables:
echo   VITE_API_URL=%API_URL%/api
echo   VITE_SITE_URL=https://mailc.netlify.app
echo.
pause
exit /b 0

:fail
echo.
echo DEPLOY FAILED. Read the error above.
pause
exit /b 1
