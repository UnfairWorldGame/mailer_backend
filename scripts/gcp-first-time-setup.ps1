# One-time Google Cloud setup for MAILIQ backend
# Run:  cd backend\scripts  &&  setup-gcp.cmd
# Or:   powershell -ExecutionPolicy Bypass -File .\scripts\gcp-first-time-setup.ps1

$ErrorActionPreference = "Stop"

$PROJECT_ID = "rosy-etching-417006"
$REGION = "asia-south1"
$AR_REPO = "mailiq"

Write-Host "Setting GCP project to $PROJECT_ID ..."
gcloud config set project $PROJECT_ID

Write-Host "Enabling required APIs ..."
gcloud services enable `
  run.googleapis.com `
  cloudbuild.googleapis.com `
  artifactregistry.googleapis.com `
  secretmanager.googleapis.com

Write-Host "Creating Artifact Registry repo '$AR_REPO' in $REGION (skip if already exists) ..."
gcloud artifacts repositories create $AR_REPO `
  --repository-format=docker `
  --location=$REGION `
  --description="MAILIQ API Docker images" `
  2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Repo may already exist — continuing."
}

Write-Host "Granting Cloud Build permission to deploy Cloud Run ..."
$PROJECT_NUMBER = gcloud projects describe $PROJECT_ID --format="value(projectNumber)"
$CB_SA = "$PROJECT_NUMBER@cloudbuild.gserviceaccount.com"
gcloud projects add-iam-policy-binding $PROJECT_ID `
  --member="serviceAccount:$CB_SA" `
  --role="roles/run.admin" `
  --quiet | Out-Null
gcloud projects add-iam-policy-binding $PROJECT_ID `
  --member="serviceAccount:$CB_SA" `
  --role="roles/iam.serviceAccountUser" `
  --quiet | Out-Null

Write-Host ""
Write-Host "Next: create secrets in Secret Manager (run from backend folder):"
Write-Host ""
Write-Host '  gcloud secrets create mailiq-mongodb-uri --replication-policy=automatic'
Write-Host '  gcloud secrets versions add mailiq-mongodb-uri --data-file=-  # paste MONGODB_URI, Ctrl+Z Enter'
Write-Host ""
Write-Host '  gcloud secrets create mailiq-jwt-secret --replication-policy=automatic'
Write-Host '  gcloud secrets versions add mailiq-jwt-secret --data-file=-'
Write-Host ""
Write-Host '  gcloud secrets create mailiq-gemini-api-key --replication-policy=automatic'
Write-Host '  gcloud secrets versions add mailiq-gemini-api-key --data-file=-'
Write-Host ""
Write-Host '  gcloud secrets create mailiq-smtp-app-password --replication-policy=automatic'
Write-Host '  gcloud secrets versions add mailiq-smtp-app-password --data-file=-'
Write-Host ""
Write-Host "Grant Cloud Run access to secrets:"
Write-Host '  $RUN_SA = gcloud iam service-accounts list --filter="displayName:Compute Engine default" --format="value(email)"'
Write-Host '  foreach ($s in @("mailiq-mongodb-uri","mailiq-jwt-secret","mailiq-gemini-api-key","mailiq-smtp-app-password")) {'
Write-Host '    gcloud secrets add-iam-policy-binding $s --member="serviceAccount:$RUN_SA" --role="roles/secretmanager.secretAccessor"'
Write-Host '  }'
Write-Host ""
Write-Host "Then deploy:"
Write-Host "  cd backend"
Write-Host "  gcloud builds submit --config cloudbuild.yaml ."
Write-Host ""
