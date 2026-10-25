/**
 * Repository review guidelines: rules the maintainers committed for humans or
 * coding agents (OwnRabbit's own file, AGENTS.md, Kiro steering, Cursor rules).
 *
 * Always read from the PR's base commit, never the head, so a pull request
 * cannot rewrite the rules it is reviewed against.
 */

export interface GuidelineSource {
  /** File contents at `ref`, or undefined if absent / not a file. */
  readFile(path: string, ref: string): Promise<string | undefined>;
  /** File names (not paths) directly inside `dir` at `ref`; [] if absent. */
  listDir(dir: string, ref: string): Promise<string[]>;
}

export interface Guidelines {
  text: string;
  files: string[];
}

/** Highest priority first. A dedicated review file outranks generic agent instructions. */
const FILES = [
  ".ownrabbit/review.md",
  "REVIEW.md",
  ".github/review-guidelines.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
];
const DIRS = [".ownrabbit", ".kiro/steering", ".agents/rules", ".cursor/rules"];

const MAX_TOTAL_CHARS = 24_000;
const MAX_FILE_CHARS = 12_000;
const MAX_FILES = 8;

export async function loadGuidelines(source: GuidelineSource, ref: string): Promise<Guidelines | undefined> {
  const dirListings = await Promise.all(
    DIRS.map(async (dir) =>
      (await source.listDir(dir, ref).catch(() => []))
        .filter((name) => /\.mdc?$/i.test(name))
        .sort()
        .map((name) => `${dir}/${name}`),
    ),
  );
  const paths = [...new Set([...FILES, ...dirListings.flat()])];

  const loaded = await Promise.all(
    paths.map(async (path) => ({ path, text: await source.readFile(path, ref).catch(() => undefined) })),
  );

  const files: string[] = [];
  const parts: string[] = [];
  let total = 0;
  for (const { path, text } of loaded) {
    const body = text?.trim();
    if (!body || files.length >= MAX_FILES) continue;
    const room = MAX_TOTAL_CHARS - total;
    if (room < 500) break;
    const clipped = body.length > Math.min(MAX_FILE_CHARS, room) ? `${body.slice(0, Math.min(MAX_FILE_CHARS, room))}\n… [truncated]` : body;
    files.push(path);
    parts.push(`<repo-guidelines file="${path}">\n${clipped}\n</repo-guidelines>`);
    total += clipped.length;
  }
  return files.length > 0 ? { text: parts.join("\n\n"), files } : undefined;
}
