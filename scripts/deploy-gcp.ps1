# Build and deploy MAILIQ API to Google Cloud Run
# Prerequisites: gcloud auth login, gcp-first-time-setup.ps1, secrets created

$ErrorActionPreference = "Stop"

$PROJECT_ID = "artful-line-417208"
$REGION = "asia-south1"
$SERVICE = "mailiq-api"

$BackendRoot = Split-Path -Parent $PSScriptRoot
Set-Location $BackendRoot

Write-Host "Project: $PROJECT_ID | Region: $REGION | Service: $SERVICE"
gcloud config set project $PROJECT_ID

Write-Host "Submitting Cloud Build (build + push + deploy) ..."
gcloud builds submit --config cloudbuild.yaml .

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Deployed. Fetching service URL ..."
$url = gcloud run services describe $SERVICE --region $REGION --format="value(status.url)"
Write-Host ""
Write-Host "API URL: $url"
Write-Host "Health:  $url/api/health"
Write-Host ""
Write-Host "Update Netlify (https://mailc.netlify.app) env:"
Write-Host "  VITE_API_URL=$url/api"
Write-Host "  VITE_SITE_URL=https://mailc.netlify.app"
Write-Host ""
