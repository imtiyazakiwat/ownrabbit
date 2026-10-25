import "server-only";
import { GoogleAuth } from "google-auth-library";
import type { ReviewJob } from "@ownrabbit/core";
import { env } from "./env";

/**
 * Cloud Tasks via its REST API. The gRPC client (@google-cloud/tasks) loads
 * proto files at runtime that serverless bundlers fail to trace, so REST is
 * used instead.
 */
let auth: GoogleAuth | undefined;

function googleAuth(): GoogleAuth {
  if (auth) return auth;
  const encoded = process.env.GCP_SERVICE_ACCOUNT;
  auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-tasks"],
    ...(encoded ? { credentials: JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) } : {}),
  });
  return auth;
}

/**
 * Enqueue a review. The task name is derived from the GitHub delivery id, so
 * webhook redeliveries are deduplicated by Cloud Tasks (HTTP 409).
 * Cloud Tasks signs the request to the worker with an OIDC token for the
 * invoker account, which the worker verifies.
 */
export async function enqueueReview(job: ReviewJob): Promise<"queued" | "duplicate"> {
  const parent = `projects/${env.gcpProject()}/locations/${env.tasksLocation()}/queues/${env.tasksQueue()}`;
  const client = await googleAuth().getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Could not obtain a Google access token");

  const res = await fetch(`https://cloudtasks.googleapis.com/v2/${parent}/tasks`, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      task: {
        name: `${parent}/tasks/${job.jobId}`,
        dispatchDeadline: "1800s",
        httpRequest: {
          httpMethod: "POST",
          url: `${env.workerUrl()}/review`,
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify(job)).toString("base64"),
          oidcToken: { serviceAccountEmail: env.tasksInvokerEmail(), audience: env.workerUrl() },
        },
      },
    }),
  });

  if (res.ok) return "queued";
  if (res.status === 409) return "duplicate";
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  throw new Error(`Cloud Tasks enqueue failed: HTTP ${res.status} ${detail}`);
}
