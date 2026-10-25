/**
 * Read-only workspace for the PR head commit plus the tools reviewers can call.
 *
 * The checkout is lazy: quick reviews never clone. Commands run via execFile
 * (no shell) and every path is confined to the checkout root, including
 * symlink targets, because PR authors control the repository contents.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const MAX_FILE_BYTES = 200_000;
const MAX_READ_LINES = 400;
const MAX_SEARCH_RESULTS = 60;
const MAX_TOOL_OUTPUT = 12_000;

export interface Workspace {
  readFile(file: string, startLine?: number, endLine?: number): Promise<string>;
  search(pattern: string, glob?: string): Promise<string>;
  listDir(dir: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface CheckoutOptions {
  owner: string;
  repo: string;
  sha: string;
  getToken: () => Promise<string>;
  timeoutMs?: number;
}

function truncate(text: string, max = MAX_TOOL_OUTPUT): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]` : text;
}

export function createLazyWorkspace(options: CheckoutOptions): Workspace {
  let root: Promise<string> | undefined;
  let dir: string | undefined;

  async function ensure(): Promise<string> {
    root ??= (async () => {
      dir = await mkdtemp(path.join(tmpdir(), "ownrabbit-"));
      await checkout(dir, options);
      return realpath(dir);
    })();
    return root;
  }

  async function resolveInside(relative: string): Promise<string> {
    const base = await ensure();
    const cleaned = relative.replace(/^\/+/, "");
    const target = path.resolve(base, cleaned);
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error("Path escapes repository");
    const real = await realpath(target).catch(() => {
      throw new Error(`Not found: ${relative}`);
    });
    if (real !== base && !real.startsWith(base + path.sep)) throw new Error("Path escapes repository");
    return real;
  }

  return {
    async readFile(file, startLine, endLine) {
      const full = await resolveInside(file);
      const info = await stat(full);
      if (!info.isFile()) return `${file} is not a file`;
      if (info.size > MAX_FILE_BYTES) return `${file} is too large (${info.size} bytes); use search instead`;

      const lines = (await readFile(full, "utf8")).split("\n");
      const from = Math.max(1, Math.floor(startLine ?? 1));
      const to = Math.min(lines.length, Math.floor(endLine ?? from + MAX_READ_LINES - 1), from + MAX_READ_LINES - 1);
      if (from > lines.length) return `${file} has only ${lines.length} lines`;
      const body = lines
        .slice(from - 1, to)
        .map((line, i) => `${String(from + i).padStart(5)}  ${line}`)
        .join("\n");
      return truncate(`${file} (lines ${from}-${to} of ${lines.length})\n${body}`);
    },

    async search(pattern, glob) {
      const base = await ensure();
      if (!pattern.trim()) return "Empty search pattern";
      const args = ["grep", "-n", "-I", "--no-color", "-F", "-e", pattern.slice(0, 200)];
      if (glob) args.push("--", glob.slice(0, 200));
      try {
        const { stdout } = await exec("git", args, { cwd: base, timeout: 20_000, maxBuffer: 4_000_000 });
        const lines = stdout.split("\n").filter(Boolean);
        const shown = lines.slice(0, MAX_SEARCH_RESULTS).map((line) => line.slice(0, 300));
        const more = lines.length > shown.length ? `\n… ${lines.length - shown.length} more matches` : "";
        return truncate(shown.join("\n") + more);
      } catch (err) {
        // git grep exits 1 when there are no matches.
        if ((err as { code?: number }).code === 1) return "No matches";
        throw new Error(`search failed: ${(err as Error).message.slice(0, 200)}`);
      }
    },

    async listDir(relative) {
      const full = await resolveInside(relative || ".");
      const entries = await readdir(full, { withFileTypes: true });
      const names = entries
        .filter((e) => e.name !== ".git")
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .slice(0, 200);
      return names.join("\n") || "(empty)";
    },

    async dispose() {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function checkout(dir: string, { owner, repo, sha, getToken, timeoutMs = 180_000 }: CheckoutOptions) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid commit sha");
  const token = await getToken();
  const remote = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`;
  // Token is passed as a header via env-scoped config so it never appears in
  // argv (visible in process listings) or in the remote URL.
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
  const run = (args: string[]) => exec("git", args, { cwd: dir, env, timeout: timeoutMs, maxBuffer: 10_000_000 });

  await run(["init", "-q"]);
  await run(["remote", "add", "origin", remote]);
  await run(["fetch", "-q", "--depth=1", "--no-tags", "origin", sha]);
  // Never run hooks, filters, or LFS smudge from an untrusted repository.
  await run(["-c", "core.hooksPath=/dev/null", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false", "checkout", "-q", "FETCH_HEAD"]);
}
