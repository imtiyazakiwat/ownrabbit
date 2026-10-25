/**
 * Unified-diff helpers. GitHub only accepts inline review comments on lines
 * that appear inside a diff hunk, so we track exactly which new-file lines
 * are commentable and render the patch with explicit line numbers for the
 * model to cite.
 */

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  /** Line number in the new file (undefined for deletions). */
  newLine?: number;
  oldLine?: number;
  text: string;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedPatch {
  hunks: Hunk[];
  /** New-file line -> hunk index, for lines GitHub will accept comments on. */
  commentable: Map<number, number>;
  added: number;
  removed: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parsePatch(patch: string | undefined | null): ParsedPatch {
  const result: ParsedPatch = { hunks: [], commentable: new Map(), added: 0, removed: 0 };
  if (!patch) return result;

  let current: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  const rows = patch.split("\n");
  // A trailing newline yields an empty final element that is not a diff line.
  if (rows.at(-1) === "") rows.pop();

  for (const raw of rows) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      current = { header: raw, lines: [] };
      result.hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"

    const hunkIndex = result.hunks.length - 1;
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "+") {
      current.lines.push({ kind: "add", newLine, text });
      result.commentable.set(newLine, hunkIndex);
      result.added++;
      newLine++;
    } else if (marker === "-") {
      current.lines.push({ kind: "del", oldLine, text });
      result.removed++;
      oldLine++;
    } else {
      // Context line (" "); some tools strip the leading space from blank lines.
      current.lines.push({ kind: "ctx", newLine, oldLine, text });
      result.commentable.set(newLine, hunkIndex);
      oldLine++;
      newLine++;
    }
  }
  return result;
}

/**
 * Render a patch for the model: every non-deleted line is prefixed with its
 * new-file line number so findings can reference real lines.
 */
export function renderNumberedPatch(parsed: ParsedPatch): string {
  const out: string[] = [];
  for (const hunk of parsed.hunks) {
    out.push(hunk.header);
    for (const line of hunk.lines) {
      const num = line.newLine === undefined ? "    " : String(line.newLine).padStart(4);
      const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      out.push(`${num} ${sign}${line.text}`);
    }
  }
  return out.join("\n");
}

/** A comment range is valid only if every endpoint is commentable and in the same hunk. */
export function isValidRange(parsed: ParsedPatch, line: number, startLine?: number): boolean {
  const endHunk = parsed.commentable.get(line);
  if (endHunk === undefined) return false;
  if (startLine === undefined || startLine === line) return true;
  if (startLine > line) return false;
  return parsed.commentable.get(startLine) === endHunk;
}

/** Nearest commentable line within `radius`, preferring added lines. Used to repair off-by-a-few citations. */
export function nearestCommentableLine(
  parsed: ParsedPatch,
  line: number,
  radius = 3,
): number | undefined {
  if (parsed.commentable.has(line)) return line;
  for (let d = 1; d <= radius; d++) {
    if (parsed.commentable.has(line + d)) return line + d;
    if (parsed.commentable.has(line - d)) return line - d;
  }
  return undefined;
}
