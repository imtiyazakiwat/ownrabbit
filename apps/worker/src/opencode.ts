/**
 * Headless opencode runtime.
 *
 * Each model attempt gets its own `opencode serve` process, XDG state, and MCP
 * publisher, so a failed or rate-limited model cannot leak state into the next
 * attempt. The checkout is the server's cwd; the SDK `directory` option is not
 * enough to set the project root.
 */
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freeModelCandidates, type FreeModelId, type RepoSettings, type ReviewJob } from "@ownrabbit/core";
import { POST_FOLLOW_UP, REVIEW_AGENT_PROMPT } from "./opencode-prompt";
import { OpenCodeResultSchema, OPENCODE_RESULT_FILE, type OpenCodeJob, type OpenCodeResult } from "./review-job";

const MODEL_TIMEOUT_MS = 8 * 60_000;
const SERVER_START_TIMEOUT_MS = 45_000;
const MAX_LOG_BYTES = 12_000;

const REVIEW_PERMISSIONS = {
  "*": "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  "ownrabbit_*": "allow",
  external_directory: "deny",
  doom_loop: "allow",
} as const;

/** Remove files opencode would auto-load as agent instructions. */
export async function sanitizeCheckout(root: string): Promise<void> {
  const targets = [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    "opencode.json",
    "opencode.jsonc",
    ".opencode",
    ".claude",
    ".cursor",
    ".github/copilot-instructions.md",
  ];
  await Promise.all(targets.map((target) => rm(path.join(root, target), { recursive: true, force: true }).catch(() => undefined)));
}

export interface OpenCodeInput {
  job: ReviewJob;
  settings: RepoSettings;
  headSha: string;
  baseSha: string;
  mode: "full" | "incremental";
  platformDefault: string;
  checkout: string;
  githubToken: string;
  apiKey: string;
  files: string[];
  filesSkipped: number;
  scopeTruncated: boolean;
  mention: string;
  botLogin: string;
  summaryCommentId?: number;
  guidelineFiles: string[];
  prompt: string;
  budgetMs?: number;
  signal?: AbortSignal;
  log: (message: string, extra?: Record<string, unknown>) => void;
}

export interface OpenCodeOutput {
  model: FreeModelId;
  result: OpenCodeResult;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  durationMs: number;
}

class ModelAttemptError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncated(value: string): string {
  return value.length > MAX_LOG_BYTES ? `…${value.slice(-MAX_LOG_BYTES)}` : value;
}

function killTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // already gone
    }
  }
}

async function stopServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  killTree(proc, "SIGTERM");
  await Promise.race([new Promise((resolve) => proc.once("exit", resolve)), sleep(4_000)]);
  if (proc.exitCode === null) killTree(proc, "SIGKILL");
}

async function waitForHealth(
  baseUrl: string,
  proc: ChildProcess,
  logs: () => string,
  spawnError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const failed = spawnError();
    if (failed) throw new Error(`could not start opencode: ${failed.message}`);
    if (proc.exitCode !== null) throw new Error(`opencode server exited with code ${proc.exitCode}: ${truncated(logs())}`);
    try {
      const response = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      // server not listening yet
    }
    await sleep(400);
  }
  throw new Error(`opencode server did not become healthy in ${SERVER_START_TIMEOUT_MS / 1000}s: ${truncated(logs())}`);
}

function sdkError(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error("review aborted");
}

async function readResult(file: string): Promise<OpenCodeResult | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const result = OpenCodeResultSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

async function runOneModel(input: OpenCodeInput, model: FreeModelId, deadline: number): Promise<OpenCodeOutput> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(30_000, Math.min(MODEL_TIMEOUT_MS, deadline - Date.now()));
  const base = await mkdtemp(path.join(tmpdir(), "ownrabbit-opencode-"));
  const configHome = path.join(base, "config");
  const dataHome = path.join(base, "data");
  const stateHome = path.join(base, "state");
  const cacheHome = path.join(base, "cache");
  const home = path.join(base, "home");
  const temp = path.join(base, "tmp");
  const tokenFile = path.join(base, "github-token");
  const resultFile = path.join(base, OPENCODE_RESULT_FILE);
  await Promise.all(
    [configHome, dataHome, stateHome, cacheHome, home, temp].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
  );
  await writeFile(tokenFile, input.githubToken, { mode: 0o600 });

  const port = 20_000 + (randomBytes(2).readUInt16BE(0) % 40_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mcpScript = process.env.OWNRABBIT_MCP_SCRIPT ?? path.join(here, "mcp-review.js");

  const mcpJob: OpenCodeJob = {
    owner: input.job.owner,
    repo: input.job.repo,
    prNumber: input.job.prNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    mode: input.mode,
    files: input.files,
    filesSkipped: input.filesSkipped,
    scopeTruncated: input.scopeTruncated,
    settings: input.settings,
    mention: input.mention,
    botLogin: input.botLogin,
    ...(input.summaryCommentId ? { summaryCommentId: input.summaryCommentId } : {}),
    guidelineFiles: input.guidelineFiles,
  };

  const config = {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    permission: REVIEW_PERMISSIONS,
    agent: {
      review: {
        description: "OwnRabbit read-only PR reviewer",
        mode: "primary",
        prompt: REVIEW_AGENT_PROMPT,
        permission: REVIEW_PERMISSIONS,
        tools: { write: false, edit: false, bash: false, task: false, webfetch: false, question: false },
      },
    },
    mcp: {
      ownrabbit: {
        type: "local",
        command: [process.execPath, mcpScript],
        enabled: true,
        environment: {
          OWNRABBIT_JOB: JSON.stringify(mcpJob),
          OWNRABBIT_RESULT: resultFile,
          OWNRABBIT_TOKEN_FILE: tokenFile,
          ...(process.env.GITHUB_API_URL ? { GITHUB_API_URL: process.env.GITHUB_API_URL } : {}),
        },
      },
    },
  };

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: temp,
    LANG: process.env.LANG ?? "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    XDG_CACHE_HOME: cacheHome,
    OPENCODE_API_KEY: input.apiKey,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };

  let logs = "";
  const append = (chunk: Buffer) => {
    logs = truncated(logs + chunk.toString());
  };

  const bin = process.env.OPENCODE_BIN ?? "opencode";
  const proc = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: input.checkout,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let spawnFailure: Error | undefined;
  proc.once("error", (err) => {
    spawnFailure = err;
  });
  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);

  try {
    await waitForHealth(baseUrl, proc, () => logs, () => spawnFailure);
    const client = createOpencodeClient({ baseUrl });
    const session = await client.session.create({ title: `OwnRabbit review ${input.job.owner}/${input.job.repo}#${input.job.prNumber}` }, { throwOnError: false });
    if (session.error) throw new ModelAttemptError(`could not create session: ${sdkError(session.error)}`);
    const sessionID = session.data?.id;
    if (!sessionID) throw new ModelAttemptError("opencode returned no session id");

    let tokens: OpenCodeOutput["tokens"] = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;

    const promptOnce = async (text: string) => {
      input.log("opencode prompt", { model, chars: text.length });
      const prompt = client.session.prompt(
        {
          sessionID,
          model: { providerID: "opencode", modelID: model },
          agent: "review",
          parts: [{ type: "text", text }],
        },
        { throwOnError: false },
      );

      let timer: NodeJS.Timeout | undefined;
      let removeAbort = () => undefined as void;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          client.session.abort({ sessionID }).catch(() => undefined);
          reject(new ModelAttemptError(`model ${model} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      });
      const aborted = new Promise<never>((_, reject) => {
        if (!input.signal) return;
        const onAbort = () => reject(abortError(input.signal!));
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => input.signal?.removeEventListener("abort", onAbort);
      });

      try {
        const outcome = await Promise.race([prompt, timedOut, aborted]);
        if (input.signal?.aborted) throw abortError(input.signal);
        if (outcome.error) throw new ModelAttemptError(`model ${model} failed: ${sdkError(outcome.error)}`);
        const info = outcome.data?.info;
        if (!info) throw new ModelAttemptError(`model ${model} returned no message`);
        if (info.error) throw new ModelAttemptError(`model ${model} failed: ${sdkError(info.error)}`);
        tokens = {
          input: tokens.input + (info.tokens?.input ?? 0),
          output: tokens.output + (info.tokens?.output ?? 0),
          reasoning: tokens.reasoning + (info.tokens?.reasoning ?? 0),
          cacheRead: tokens.cacheRead + (info.tokens?.cache?.read ?? 0),
          cacheWrite: tokens.cacheWrite + (info.tokens?.cache?.write ?? 0),
        };
        cost += info.cost ?? 0;
      } finally {
        if (timer) clearTimeout(timer);
        removeAbort();
        prompt.catch(() => undefined);
      }
    };

    await promptOnce(input.prompt);
    let result = await readResult(resultFile);
    if (!result) {
      await promptOnce(POST_FOLLOW_UP);
      result = await readResult(resultFile);
    }
    if (!result) throw new ModelAttemptError(`model ${model} did not call ownrabbit_post_review`);
    if (result.status === "invalid" && result.attempts < 3) {
      await promptOnce(POST_FOLLOW_UP);
      result = (await readResult(resultFile)) ?? result;
    }
    if (result.status !== "posted" && result.status !== "already-posted") {
      throw new ModelAttemptError(`model ${model} could not publish: ${result.error ?? result.status}`);
    }

    return { model, result, cost, tokens, durationMs: Date.now() - startedAt };
  } finally {
    await stopServer(proc);
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Try the repository's free-model override, then the platform default, then
 * the known fallbacks. Each attempt is isolated; only a posted review wins.
 */
export async function runOpenCodeReview(input: OpenCodeInput): Promise<OpenCodeOutput> {
  if (!input.apiKey) throw new Error("OPENCODE_API_KEY is not configured");
  const deadline = Date.now() + (input.budgetMs ?? MODEL_TIMEOUT_MS * 3);
  const candidates = freeModelCandidates(input.settings.reviewModel, input.platformDefault);
  const errors: string[] = [];

  for (const model of candidates) {
    if (input.signal?.aborted) throw abortError(input.signal);
    if (Date.now() >= deadline) break;
    input.log("trying review model", { model });
    try {
      const success = await runOneModel(input, model, deadline);
      input.log("review model succeeded", { model, tokens: success.tokens, cost: success.cost, ms: success.durationMs });
      return success;
    } catch (err) {
      if (input.signal?.aborted) throw abortError(input.signal);
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${model}: ${message}`);
      input.log("review model failed, trying fallback", { model, error: message.slice(0, 400) });
    }
  }

  throw new Error(`all free review models failed: ${errors.join(" | ").slice(0, 1_200)}`);
}
