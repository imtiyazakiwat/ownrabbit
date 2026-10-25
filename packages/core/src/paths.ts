import picomatch from "picomatch";
import type { RepoSettings } from "./settings";

/**
 * Returns a predicate deciding whether a changed file should be reviewed.
 * Excludes win over includes. Empty include list means "everything".
 */
export function createPathFilter(
  settings: Pick<RepoSettings, "includePaths" | "excludePaths">,
): (path: string) => boolean {
  const options = { dot: true };
  const isIncluded =
    settings.includePaths.length > 0 ? picomatch(settings.includePaths, options) : () => true;
  const isExcluded =
    settings.excludePaths.length > 0 ? picomatch(settings.excludePaths, options) : () => false;
  return (path) => isIncluded(path) && !isExcluded(path);
}
