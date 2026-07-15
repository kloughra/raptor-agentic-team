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

export type FailureClassification =
  | "transient"
  | "deterministic"
  | "user-actionable";

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
 * A user-actionable failure pattern (Sprint 15, user-actionable-failure-class).
 *
 * Unlike TRANSIENT_ERROR_PATTERNS (a bare `RegExp[]`), each user-actionable
 * entry carries the concrete `action` the user must take, so the escalation
 * message and the matched pattern cannot drift (spec AC 7 / architecture
 * §Technology Choices #2).
 */
export interface UserActionablePattern {
  /** Regex tested against the error summary. No /g flag (constraint 13). */
  pattern: RegExp;
  /** Concrete remediation named in the escalation detail (AC 7). */
  action: string;
}

/**
 * User-actionable (blocker-is-outside-the-sprint) error patterns. Code-only
 * registry (spec AC 3 / architecture §Constraints — NOT user-configurable via
 * config.json, mirroring TRANSIENT_ERROR_PATTERNS). Exported so tests can
 * enumerate it. Adding a future signature is a one-line addition with no
 * pipeline change.
 *
 * No /g flags: a stateful lastIndex would make classification non-deterministic
 * (constraint 13). Registry ORDER is significant — `resolveUserAction` returns
 * the FIRST match.
 *
 * Sprint 15 ships EXACTLY ONE seed pattern (billing / spend-limit). An
 * invalid-model seed was cut before merge: the `claude` CLI does NOT fail on an
 * unknown `--model` — it prints an advisory to STDOUT ("There's an issue with
 * the selected model (…). It may not exist or you may not have access to it.")
 * and EXITS 0. `spawnAgent` therefore returns success, the step then fails on
 * MISSING OUTPUTS, and the string `classifyFailure` sees is "Agent completed
 * (exit 0) but did not create required output files" — never the model advisory.
 * No regex in THIS registry can ever fire on that path, and a broad "invalid
 * model" pattern would mis-escalate any deterministic failure whose output
 * merely mentions an unsupported model (e.g. while working on the models feature
 * itself). Detecting invalid-model needs work in the exit-0 / agent-output
 * inspection path (agents.ts / the exit-0 branch of `runAgentStepCycle`), not
 * here — tracked as Inbox item `invalid-model-user-actionable-detection`.
 */
export const USER_ACTIONABLE_ERROR_PATTERNS: UserActionablePattern[] = [
  {
    // billing / spend-limit — specimen "You've hit your monthly spend limit"
    // (commits 908bf63, 9394bdd, f9bc035). Generalized to tolerate phrasing
    // drift ("monthly spend limit" / "usage limit") per the Edge Case, without
    // over-fitting one exact string.
    pattern: /spend limit|(?:monthly|daily)?\s*(?:spend|usage) limit|usage limit reached/i,
    action:
      "Raise your usage limit at https://claude.ai/settings/usage, then resume the sprint.",
  },
  // ---------------------------------------------------------------------------
  // Branch-protection merge-refusal signatures (Sprint 18,
  // branch-protection-merge-lockout, AC 1/2). Order matters —
  // `resolveUserAction` returns the FIRST match; the specific review-required
  // entry precedes the general protection/lock entry (architecture §API
  // Contracts). The regexes bias toward the confirmed `gh pr merge` stderr
  // specimens (Open Question 1) without over-fitting one exact string, and
  // deliberately do NOT match the bare "not mergeable" conflict string (C4 —
  // that ambiguous divergence case is push-before-merge's domain).
  {
    // required approving / code-owner review
    pattern:
      /at least \d+ approving review|approving review is required|review required|changes must be approved|code owner/i,
    action:
      "Approve the PR (an approving or code-owner review is required), then resume the sprint.",
  },
  {
    // protected / locked base branch (lock_branch: true, branch-protection policy)
    pattern:
      /protected branch|branch is protected|branch protection|base branch (?:policy|restrictions)|is not authorized|not allowed to (?:push|merge)|branch .*is locked|lock_branch/i,
    action:
      "Unlock `main` (branch protection / lock_branch is blocking the squash-merge) or merge the PR manually, then resume the sprint.",
  },
];

/**
 * Classify a failure's error summary. Precedence (Open Question 1 ruling —
 * architecture §Constraints): user-actionable → transient → deterministic.
 * User-actionable is checked FIRST so an ambiguous string (e.g. a usage-limit
 * phrasing that also brushes a transient rate-limit pattern) resolves to
 * escalate-now rather than retry-loop — retrying a spend-limit error as if it
 * were a network flake is the exact waste this feature removes.
 *
 * Deterministic remains the default (AC 9 backward compat is handled at read
 * sites via `?? "deterministic"`).
 */
export function classifyFailure(errorSummary: string): FailureClassification {
  for (const { pattern } of USER_ACTIONABLE_ERROR_PATTERNS) {
    if (pattern.test(errorSummary)) return "user-actionable";
  }
  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (pattern.test(errorSummary)) return "transient";
  }
  return "deterministic";
}

/**
 * Resolve the concrete user action for a user-actionable failure (spec AC 7).
 * Returns the `action` of the FIRST matching user-actionable pattern (registry
 * order), or `null` when no user-actionable pattern matches. Used by the
 * escalate pipeline to build the actionable escalation detail. Pure,
 * deterministic, no /g.
 */
export function resolveUserAction(errorSummary: string): string | null {
  for (const { pattern, action } of USER_ACTIONABLE_ERROR_PATTERNS) {
    if (pattern.test(errorSummary)) return action;
  }
  return null;
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
