import * as fs from "fs";
import * as path from "path";
import picomatch from "picomatch";

/**
 * Expected-output glob matching (see docs/architecture/expected-outputs-glob-resolution.md).
 *
 * Replaces the old `pattern.replace("*", featureSlug)` literal substitution:
 * instead of predicting a single path, we enumerate the real files an agent
 * wrote under the pattern's base directory and test them against the glob.
 * A pattern is satisfied by at least one real matching file; unsatisfied
 * patterns are reported using their original, human-readable pattern string.
 */

/** Pattern shape drives the matching rule (see architecture matching table). */
export type PatternClass = "exact" | "single-star" | "double-star";

export interface MatchResult {
  /** Original pattern, verbatim — used for missing-output reporting. */
  pattern: string;
  /** Project-relative paths of real files that matched (files only). */
  matchedFiles: string[];
  /** matchedFiles.length > 0 */
  satisfied: boolean;
}

/** Heavy/irrelevant directories pruned from traversal (NFR-2). */
const PRUNE_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

/** Classify a pattern into the matching rule it follows. */
export function classifyPattern(pattern: string): PatternClass {
  if (pattern.includes("**")) return "double-star";
  if (pattern.includes("*")) return "single-star";
  return "exact";
}

/** The literal directory prefix of a pattern, up to its first wildcard. */
function patternBaseDir(pattern: string): string {
  const starIdx = pattern.indexOf("*");
  const prefix = starIdx === -1 ? pattern : pattern.slice(0, starIdx);
  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash === -1 ? "" : prefix.slice(0, lastSlash);
}

/**
 * Recursively enumerate regular files under dirAbs, returning project-relative
 * forward-slash paths. Best-effort: unreadable/missing directories yield no
 * matches (never an exception), symlinks are not followed (NFR-5), `.gitkeep`
 * placeholders never count, and heavy directories are pruned.
 */
function walkFiles(dirAbs: string, projectPath: string): string[] {
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dirAbs, entry.name);
    if (entry.isFile()) {
      if (entry.name === ".gitkeep") continue; // placeholders never satisfy a pattern
      found.push(path.relative(projectPath, full).split(path.sep).join("/"));
    } else if (entry.isDirectory() && !PRUNE_DIRS.has(entry.name)) {
      found.push(...walkFiles(full, projectPath));
    }
    // Symlinks and other entry types are intentionally skipped.
  }
  return found;
}

/**
 * Match one expectedOutputs pattern against the real files on disk.
 *
 * Matching rules (authoritative table in the architecture doc):
 * - exact:       exact path exists AND is a file (a directory never counts).
 * - single-star: at least one real file matches the glob AND has the feature
 *                slug in its filename or a path segment (per-feature isolation).
 * - double-star: at least one real file at any depth matches the glob;
 *                no slug requirement (source files aren't slug-named).
 */
export function matchExpectedOutput(
  pattern: string,
  projectPath: string,
  featureSlug: string
): MatchResult {
  const cls = classifyPattern(pattern);

  if (cls === "exact") {
    const fullPath = path.join(projectPath, pattern);
    let satisfied = false;
    try {
      satisfied = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
    } catch {
      satisfied = false;
    }
    return { pattern, matchedFiles: satisfied ? [pattern] : [], satisfied };
  }

  const baseAbs = path.join(projectPath, patternBaseDir(pattern));
  const candidates = walkFiles(baseAbs, projectPath);
  const isMatch = picomatch(pattern);

  const matchedFiles = candidates.filter((rel) => {
    if (!isMatch(rel)) return false;
    if (cls === "single-star") {
      // Slug association via plain substring — no regex, so hyphens and dots
      // in slugs are inherently literal (Edge Case: hyphenated slug).
      return rel.split("/").some((segment) => segment.includes(featureSlug));
    }
    return true;
  });

  return { pattern, matchedFiles, satisfied: matchedFiles.length > 0 };
}

/**
 * Human-facing "what the agent should create" description for a pattern
 * (AC #5). Generated from the same rules the validator applies, so the
 * instruction an agent reads and the gate it must pass cannot drift.
 * Never emits a bare extensionless literal like `tests/integration/{slug}`.
 */
export function describeRequiredOutput(
  pattern: string,
  featureSlug: string
): string {
  switch (classifyPattern(pattern)) {
    case "exact":
      return pattern;
    case "single-star": {
      const example = pattern.endsWith("*")
        ? `${pattern.slice(0, -1)}${featureSlug}.<ext>`
        : pattern.replace("*", featureSlug);
      return (
        `${pattern} — at least one real FILE (not a directory) matching this pattern ` +
        `whose filename or a path segment contains "${featureSlug}" (e.g. ${example})`
      );
    }
    case "double-star":
      return `${pattern} — at least one real file matching this pattern (any depth)`;
  }
}
