# Create Secret Manager entries from backend/.env (local only — never commit .env)
# Run:  cd backend\scripts  &&  create-secrets.cmd

$ErrorActionPreference = "Stop"

$PROJECT_ID = "artful-line-417208"
$EnvFile = Join-Path (Split-Path -Parent $PSScriptRoot) ".env"

if (-not (Test-Path $EnvFile)) {
  Write-Error ".env not found at $EnvFile"
}

function Get-EnvValue($key) {
  $line = Get-Content $EnvFile | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -split "=", 2)[1].Trim()
}

function Ensure-Secret($name, $value) {
  if (-not $value) {
    Write-Warning "Skipping $name — not set in .env"
    return
  }
  gcloud secrets describe $name --project $PROJECT_ID 2>$null
  if ($LASTEXITCODE -ne 0) {
    gcloud secrets create $name --project $PROJECT_ID --replication-policy=automatic
    if ($LASTEXITCODE -ne 0) { throw "Failed to create secret: $name" }
  }
  $tempFile = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($tempFile, $value)
    gcloud secrets versions add $name --project $PROJECT_ID --data-file=$tempFile
    if ($LASTEXITCODE -ne 0) { throw "Failed to upload secret: $name" }
    Write-Host "Updated secret: $name"
  } finally {
    Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
  }
}

gcloud config set project $PROJECT_ID

Ensure-Secret "mailiq-mongodb-uri" (Get-EnvValue "MONGODB_URI")
Ensure-Secret "mailiq-jwt-secret" (Get-EnvValue "JWT_SECRET")
Ensure-Secret "mailiq-gemini-api-key" (Get-EnvValue "GEMINI_API_KEY")
Ensure-Secret "mailiq-smtp-app-password" (Get-EnvValue "PASSWORD_RESET_SMTP_APP_PASSWORD")

$PROJECT_NUMBER = gcloud projects describe $PROJECT_ID --format="value(projectNumber)"
$RUN_SA = "$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
$secrets = @("mailiq-mongodb-uri", "mailiq-jwt-secret", "mailiq-gemini-api-key", "mailiq-smtp-app-password")

Write-Host ""
Write-Host "Granting Cloud Run service account access to secrets ($RUN_SA) ..."
foreach ($secret in $secrets) {
  gcloud secrets add-iam-policy-binding $secret `
    --project $PROJECT_ID `
    --member="serviceAccount:$RUN_SA" `
    --role="roles/secretmanager.secretAccessor" `
    --quiet 2>$null
}

Write-Host "Done. Run deploy-gcp.ps1 to build and deploy."
