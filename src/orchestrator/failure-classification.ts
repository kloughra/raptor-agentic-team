import * as os from "os";

/**
 * Failure classification & signature derivation (Sprint 12,
 * progress-aware-circuit-breaker, CB-1/CB-2).
 *
 * Pure, dependency-free, deterministic string matching — no LLM calls
 * (explicit spec constraint; architecture constraint 12). Classification and
 * signatures are computed at record time and PERSISTED on the FailureRecord
 * (architecture constraint 4), so comparison across a process restart never
 * re-derives with drifted logic against old text.
 */

export type FailureClassification = "transient" | "deterministic";

/** Transient retry cap per step (Architect ruling, spec AC 7). */
export const TRANSIENT_RETRY_CAP = 5;

/** Fixed delay before a transient retry — no exponential backoff (Architect ruling). */
export const TRANSIENT_RETRY_DELAY_MS = 15_000;

/**
 * Transient (infrastructure-level) error patterns. Code-only registry for
 * Sprint 12 (Open Question 2 ruling — architecture constraint 11). Exported
 * so tests can enumerate it. NOT user-configurable.
 *
 * No /g flags: a stateful lastIndex would make classification
 * non-deterministic across successive calls.
 */
export const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /socket connection closed unexpectedly/i, // the Sprint 11 specimen (AC 6 minimum)
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE/,
  /fetch failed/i,
  /overloaded_error|"type"\s*:\s*"overloaded/i,
  /\b(429|529)\b.*(rate|overload)|rate limit/i,
  /50[023]\s+(internal server error|bad gateway|service unavailable)/i,
];

/**
 * Classify a failure's error summary as transient (infra-level, does not
 * consume a circuit-breaker attempt slot) or deterministic (today's slot
 * accounting). Deterministic is the default (AC 9 backward compat is handled
 * at read sites via `?? "deterministic"`).
 */
export function classifyFailure(errorSummary: string): FailureClassification {
  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (pattern.test(errorSummary)) return "transient";
  }
  return "deterministic";
}

// ---------------------------------------------------------------------------
// Signature derivation (Open Question 1 ruling): two tiers.
// Tier 1 — named signature classes, checked in order; the signature is the
// class name, so cosmetic differences (durations, paths) can't defeat a match.
// Tier 2 — generic normalization fallback (readable 200-char prefix).
// ---------------------------------------------------------------------------

const STDIN_WAIT_WARNING =
  "input must be provided either through stdin or as a prompt argument when using --print";

/** Extract, sort and join a comma-separated list for list-carrying classes. */
function sortedList(raw: string): string {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .sort()
    .join(",");
}

/**
 * Derive the deterministic failure signature used by the CB-1 no-progress
 * short-circuit. Same failure text ⇒ same signature, across process restarts.
 */
export function deriveFailureSignature(errorSummary: string): string {
  const text = errorSummary ?? "";

  // --- Tier 1: named signature classes (checked in order) ---

  // stdin-wait warning (absorbs early-exit-on-stdin-warning, AC 2) —
  // case-insensitive substring match.
  if (text.toLowerCase().includes(STDIN_WAIT_WARNING)) {
    return "stdin-wait-warning";
  }

  // Kill messages are appended as a suffix line when buffered output exists,
  // so these classes must match anywhere in the text.
  if (/agent idle-killed after \d+ms with no stdout output/i.test(text)) {
    return "idle-timeout";
  }
  if (/agent killed at hard ceiling \d+ms/i.test(text)) {
    return "hard-ceiling";
  }
  if (/agent timed out after \d+ms/i.test(text)) {
    return "wall-clock-timeout"; // legacy message (old records, mixed-version resumes)
  }
  if (/agent output exceeded 10MB buffer/i.test(text)) {
    return "buffer-overflow";
  }
  if (/agent produced no output/i.test(text)) {
    return "no-output";
  }

  // missing-outputs:<sorted patterns> — "missing A" ≠ "missing B", but
  // "missing A" twice matches regardless of list ordering.
  const missingOutputs = text.match(
    /did not create required output files:\s*([^]*?)(?:\.\s*The step is not complete|$)/i
  );
  if (missingOutputs) {
    return `missing-outputs:${sortedList(missingOutputs[1])}`;
  }

  // missing-artifacts:<sorted list> — same treatment for the pre-spawn failure.
  const missingArtifacts = text.match(/Missing required artifacts:\s*(.+)/i);
  if (missingArtifacts) {
    return `missing-artifacts:${sortedList(missingArtifacts[1])}`;
  }

  // --- Tier 2: generic normalization fallback ---
  // lowercase → strip ISO-8601 timestamps → strip durations → normalize
  // $HOME-anchored absolute paths → collapse whitespace → 200-char prefix.
  // Plain-text prefix, not a hash — post-mortems can read it in state files.
  let normalized = text.toLowerCase();
  normalized = normalized.replace(
    /\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:\d{2})?/g,
    "<timestamp>"
  );
  normalized = normalized.replace(/\b\d+\s*ms\b/g, "<duration>");
  normalized = normalized.replace(/\b\d+ ?(?:min(?:ute)?s?|seconds?|s)\b/g, "<duration>");
  const home = os.homedir().toLowerCase();
  if (home) {
    normalized = normalized.split(home).join("<home>");
  }
  normalized = normalized.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 200);
}
