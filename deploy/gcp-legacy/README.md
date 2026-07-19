# Google Cloud Run tooling — NOT the live deployment

**The MAILIQ API runs on Render.** Its deployment is defined by
[`backend/render.yaml`](../../render.yaml). That is the file to edit.

Everything in this folder targets Google Cloud Run (project `rosy-etching-417006`,
service `mailiq-api`, region `asia-south1`). It is kept for reference only.
Running any of it deploys a **second, unused** backend that serves no traffic.

## Why this is quarantined

`cloudbuild.yaml` was, until recently, the only file in the repository that
recorded production environment variables — `FRONTEND_URL`, `ADMIN_EMAILS`,
`CONTACT_INBOX_EMAIL`, `PASSWORD_RESET_SMTP_EMAIL`, `PASSWORD_RESET_FROM_NAME`.
It is consumed exclusively by `gcloud builds submit`, which is not part of the
Render pipeline. So changing a value there, committing it, and watching it merge
looked exactly like a config change and had no effect whatsoever on production.

That failure mode is silent and expensive: an operator believes the running
service has a setting it does not have. `render.yaml` now holds the real
configuration, and the boot sequence fails fast on the two variables whose
absence is otherwise invisible (`JWT_SECRET`, `FRONTEND_URL`).

## If you ever migrate back to Cloud Run

1. Move these files back to `backend/`.
2. Reconcile the env vars against `render.yaml` — this folder's copies are a
   snapshot from before the Render migration and may be stale.
3. Note that Cloud Run needs `min-instances >= 1`: the send engine is an
   in-process background loop, and scaling to zero kills campaigns mid-send.
4. Update `docs/11-deployment.md`, which describes Render.
