import "server-only";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const env = {
  appUrl: () => required("APP_URL").replace(/\/+$/, ""),
  appSlug: () => required("GITHUB_APP_SLUG"),
  webhookSecret: () => required("GITHUB_WEBHOOK_SECRET"),
  clientId: () => required("GITHUB_CLIENT_ID"),
  clientSecret: () => required("GITHUB_CLIENT_SECRET"),
  sessionSecret: () => required("SESSION_SECRET"),
  gcpProject: () => required("GCP_PROJECT"),
  tasksLocation: () => required("TASKS_LOCATION"),
  tasksQueue: () => required("TASKS_QUEUE"),
  workerUrl: () => required("WORKER_URL").replace(/\/+$/, ""),
  tasksInvokerEmail: () => required("TASKS_INVOKER_EMAIL"),
};
