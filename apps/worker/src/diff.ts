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

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/** Text of new-file lines in [start, end], or undefined if any line is not in the diff. */
export function textOfRange(parsed: ParsedPatch, start: number, end: number): string | undefined {
  const byLine = new Map<number, string>();
  for (const hunk of parsed.hunks) for (const l of hunk.lines) if (l.newLine !== undefined) byLine.set(l.newLine, l.text);
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const text = byLine.get(n);
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out.join("\n");
}

/**
 * Find where a quoted snippet actually lives in the diff (whitespace-insensitive,
 * within one hunk, non-deleted lines). Models cite line numbers loosely but quote
 * code accurately, so the quote is the better anchor.
 */
export function locateSnippet(parsed: ParsedPatch, snippet: string): { startLine: number; line: number } | undefined {
  const wanted = snippet.split("\n").map(normalize).filter(Boolean);
  if (wanted.length === 0) return undefined;
  for (const hunk of parsed.hunks) {
    const lines = hunk.lines.filter((l) => l.newLine !== undefined);
    for (let i = 0; i + wanted.length <= lines.length; i++) {
      let j = 0;
      let k = i;
      // Skip blank lines inside the hunk so a quote without them still matches.
      while (j < wanted.length && k < lines.length) {
        const text = normalize(lines[k]!.text);
        if (!text && k > i) {
          k++;
          continue;
        }
        if (text !== wanted[j]) break;
        j++;
        k++;
      }
      if (j === wanted.length) return { startLine: lines[i]!.newLine!, line: lines[k - 1]!.newLine! };
    }
  }
  return undefined;
}

/** True when `snippet` matches the cited lines, ignoring whitespace differences. */
export function snippetMatches(parsed: ParsedPatch, snippet: string, start: number, end: number): boolean {
  const actual = textOfRange(parsed, start, end);
  if (actual === undefined) return false;
  const a = actual.split("\n").map(normalize).filter(Boolean).join("\n");
  const w = snippet.split("\n").map(normalize).filter(Boolean).join("\n");
  return w.length > 0 && (a === w || a.includes(w));
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
