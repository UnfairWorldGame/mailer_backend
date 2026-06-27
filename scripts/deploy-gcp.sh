#!/usr/bin/env bash
# Build and deploy MAILIQ API to Google Cloud Run
set -euo pipefail

PROJECT_ID="artful-line-417208"
REGION="asia-south1"
SERVICE="mailiq-api"

cd "$(dirname "$0")/.."

echo "Project: $PROJECT_ID | Region: $REGION | Service: $SERVICE"
gcloud config set project "$PROJECT_ID"
gcloud builds submit --config cloudbuild.yaml .

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo ""
echo "API URL: $URL"
echo "Health:  $URL/api/health"
echo ""
echo "Update frontend env: VITE_API_URL=$URL/api"
