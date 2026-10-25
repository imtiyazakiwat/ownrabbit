# Self-hosting OwnRabbit

This walks through a full deployment: worker on Cloud Run, web app on Vercel, Firestore for state.
Replace `PROJECT` with your GCP project id. All commands assume `gcloud` is authenticated.

```bash
export PROJECT=your-project REGION=us-central1
gcloud config set project $PROJECT
```

## 1. APIs and database

```bash
gcloud services enable firestore.googleapis.com run.googleapis.com cloudtasks.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
gcloud firestore databases create --location=$REGION --type=firestore-native
gcloud firestore indexes composite create --collection-group=reviews \
  --field-config=field-path=repoId,order=ascending \
  --field-config=field-path=createdAt,order=descending
```

## 2. Queue and service accounts

Three identities keep blast radius small:

| Account | Used by | Permissions |
| --- | --- | --- |
| `ownrabbit-worker` | Cloud Run runtime | Firestore user, read two secrets |
| `ownrabbit-invoker` | Cloud Tasks OIDC token | `run.invoker` on the worker only |
| `ownrabbit-web` | Vercel | Firestore user, enqueue on one queue, act as invoker |

```bash
gcloud tasks queues create ownrabbit-reviews --location=$REGION --max-attempts=3 --min-backoff=30s
for sa in worker invoker web; do gcloud iam service-accounts create ownrabbit-$sa; done
SA() { echo "ownrabbit-$1@$PROJECT.iam.gserviceaccount.com"; }

gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$(SA worker) --role=roles/datastore.user
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$(SA web) --role=roles/datastore.user
gcloud tasks queues add-iam-policy-binding ownrabbit-reviews --location=$REGION \
  --member=serviceAccount:$(SA web) --role=roles/cloudtasks.enqueuer
gcloud iam service-accounts add-iam-policy-binding $(SA invoker) \
  --member=serviceAccount:$(SA web) --role=roles/iam.serviceAccountUser
```

## 3. Register the GitHub App

```bash
node scripts/create-github-app.mjs https://your-app.vercel.app "Your Bot"
```

Click **Create GitHub App** in the page that opens. Credentials are written to `.secrets/github-app.json` (gitignored).

## 4. Secrets

```bash
printf '%s' "$LLM_API_KEY" | gcloud secrets create ownrabbit-llm-api-key --data-file=-
jq -j .pem .secrets/github-app.json | gcloud secrets create ownrabbit-github-app-key --data-file=-
for s in ownrabbit-llm-api-key ownrabbit-github-app-key; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$(SA worker) --role=roles/secretmanager.secretAccessor
done
```

## 5. Deploy the worker

```bash
pnpm --filter @ownrabbit/worker build
gcloud run deploy ownrabbit-worker --source=apps/worker/dist --region=$REGION \
  --service-account=$(SA worker) --no-allow-unauthenticated \
  --timeout=1800 --memory=1Gi --concurrency=4 --max-instances=10 \
  --set-env-vars=NODE_ENV=production,GOOGLE_CLOUD_PROJECT=$PROJECT,LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai,TASKS_INVOKER_EMAIL=$(SA invoker),GITHUB_APP_ID=$(jq -r .id .secrets/github-app.json),GITHUB_APP_SLUG=$(jq -r .slug .secrets/github-app.json) \
  --set-secrets=LLM_API_KEY=ownrabbit-llm-api-key:latest,GITHUB_APP_PRIVATE_KEY=ownrabbit-github-app-key:latest

URL=$(gcloud run services describe ownrabbit-worker --region=$REGION --format='value(status.url)')
gcloud run services update ownrabbit-worker --region=$REGION --update-env-vars=TASKS_AUDIENCE=$URL
gcloud run services add-iam-policy-binding ownrabbit-worker --region=$REGION \
  --member=serviceAccount:$(SA invoker) --role=roles/run.invoker
```

## 6. Deploy the web app

Create a Vercel project with **root directory `apps/web`** and set every variable in [`.env.example`](../.env.example).
`FIREBASE_SERVICE_ACCOUNT` / `GCP_SERVICE_ACCOUNT` are the base64 of a key for `ownrabbit-web`:

```bash
gcloud iam service-accounts keys create /tmp/web.json --iam-account=$(SA web)
base64 < /tmp/web.json | tr -d '\n'   # paste into Vercel, then:
rm /tmp/web.json
```

## 7. Verify

- `https://your-app.vercel.app` loads and **Sign in** redirects to GitHub.
- GitHub App → Advanced → Recent deliveries shows `200` for the ping.
- Open a PR on an installed repo; a summary comment appears within a minute or two.
- Worker logs: `gcloud run services logs read ownrabbit-worker --region=$REGION`.
