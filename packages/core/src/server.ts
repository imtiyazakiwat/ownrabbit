/**
 * Server-only helpers shared by the web app and the worker:
 * Firestore access and the GitHub App client.
 */
import { App as GitHubApp } from "octokit";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import { resolveSettings, type RepoSettings } from "./settings";

export { FieldValue };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** Accepts PEMs pasted with literal "\n" sequences (common in env UIs). */
export function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

// ---------------------------------------------------------------- Firestore

let firestore: Firestore | undefined;

/**
 * On Cloud Run, Application Default Credentials are used. Elsewhere (Vercel),
 * FIREBASE_SERVICE_ACCOUNT holds a base64-encoded service account JSON.
 */
export function db(): Firestore {
  if (firestore) return firestore;
  let app: App;
  if (getApps().length > 0) {
    app = getApps()[0]!;
  } else {
    const encoded = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (encoded) {
      const json = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      app = initializeApp({ credential: cert(json), projectId: json.project_id });
    } else {
      app = initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
    }
  }
  firestore = getFirestore(app);
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}

export const collections = {
  installations: "installations",
  repos: "repos",
  reviews: "reviews",
  prState: "prState",
} as const;

export interface RepoDoc {
  repoId: number;
  installationId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  active: boolean;
  settings?: unknown;
  updatedAt?: unknown;
}

export interface PrStateDoc {
  lastReviewedSha?: string;
  summaryCommentId?: number;
  updatedAt?: unknown;
}

export type ReviewStatus = "queued" | "running" | "completed" | "skipped" | "failed";

export interface ReviewDoc {
  jobId: string;
  repoId: number;
  fullName: string;
  prNumber: number;
  headSha: string;
  mode: string;
  trigger: string;
  status: ReviewStatus;
  reason?: string;
  error?: string;
  filesReviewed?: number;
  commentsPosted?: number;
  findingsRaw?: number;
  durationMs?: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export function prStateId(repoId: number, prNumber: number): string {
  return `${repoId}_${prNumber}`;
}

export async function getRepoSettings(repoId: number): Promise<{
  doc: RepoDoc | undefined;
  settings: RepoSettings;
}> {
  const snap = await db().collection(collections.repos).doc(String(repoId)).get();
  const doc = snap.exists ? (snap.data() as RepoDoc) : undefined;
  return { doc, settings: resolveSettings(doc?.settings) };
}

// ---------------------------------------------------------------- GitHub

let githubApp: GitHubApp | undefined;

export function getGitHubApp(): GitHubApp {
  if (githubApp) return githubApp;
  githubApp = new GitHubApp({
    appId: requireEnv("GITHUB_APP_ID"),
    privateKey: normalizePem(requireEnv("GITHUB_APP_PRIVATE_KEY")),
    oauth: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    },
  });
  return githubApp;
}

export async function installationOctokit(installationId: number) {
  return getGitHubApp().getInstallationOctokit(installationId);
}

/** Login of the app's bot user, e.g. "ownrabbit[bot]". */
export function botLogin(): string {
  return `${requireEnv("GITHUB_APP_SLUG")}[bot]`;
}

export function mentionHandle(): string {
  return `@${requireEnv("GITHUB_APP_SLUG")}`;
}
