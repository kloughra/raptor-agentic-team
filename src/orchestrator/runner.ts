import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import simpleGit, { SimpleGit } from "simple-git";
import { loadConfig, RaptorConfig } from "../config";
import {
  SPRINT_WORKFLOW,
  HANDOFF_MAP,
  WorkflowStep,
} from "./workflow";
import {
  SprintState,
  StepState,
  FeatureState,
  DodChecklist,
  FailureRecord,
  loadSprintState,
  saveSprintState,
  createInitialState,
} from "./state";
import { resolveBacklogPath } from "../backlog-parser";
import { matchExpectedOutput, describeRequiredOutput } from "./glob-match";
import { renderProgressTable } from "./progress";
import { buildCheckpointPrompt, CheckpointPrompt } from "./checkpoints";
import {
  buildRolePrompt,
  buildStepContext,
  buildTeamMdContext,
  buildStep7GateInstruction,
} from "./prompts";
import { spawnAgent } from "./agents";
import { hasBlockerMarker } from "./blocker-marker";
import { executeMerge, updatePrDodChecklist, MergeResult } from "./merge";
import { generateSprintSummary, loadSprintSummaries } from "./summary";
import {
  buildRetroPrompt,
  parseRetroProposal,
  generateRetroDocument,
  updateRetroDocWithDecisions,
  updateRetroDocWithAppliedChanges,
  applyImprovements,
  buildSprintContextForRetro,
  parseRetroSelection,
  RetroProposal,
  ProposalOutcome,
} from "./retro";
import { Role } from "./workflow";
import { resolveDinoNames, formatHandoffRole, DinoIdentity } from "./dino";
import { resolveStepTimeout, TimeoutConfig } from "./timeouts";
import { detectTestFramework, buildTestScopeSection } from "./test-scope";
import { buildCodebaseSnapshot, formatSnapshotForPrompt } from "./codebase-context";
import { resolveArtifacts, buildRequiredReadingSection } from "./artifact-injection";
import { decomposeTask, executeNarrowedRetry, isNarrowable } from "./scope-narrowing";
import {
  detectSprintFeatures,
  createFeatureStates,
  featureBranchName,
  allFeaturesComplete,
  anyFeaturesEscalated,
  deriveSprintStatus,
  ensureFeatureBranch,
} from "./multi-runner";
import {
  classifyFailure,
  deriveFailureSignature,
  resolveUserAction,
  TRANSIENT_RETRY_CAP,
  TRANSIENT_RETRY_DELAY_MS,
} from "./failure-classification";

export const MAX_RETRY_ATTEMPTS = 3;
export const ERROR_SUMMARY_MAX_LENGTH = 500;
export const RETRY_CONTEXT_MAX_LENGTH = 3000;

/**
 * Resolve the `claude --model` to use for a given role (adversarial-verifier-
 * review-gate, Part 2 — AC 8/9/10). Per-role override wins, then the config
 * default, else `undefined` (⇒ `spawnAgent` runs the default model, argv
 * byte-identical to today). Pure; the resolved value is threaded to every
 * `spawnAgent` call site so the verifying role (QA) can run on a different model
 * than the generating role (Engineer) — the "generator ≠ verifier" separation.
 */
export function resolveRoleModel(role: Role, config: RaptorConfig): string | undefined {
  return config.models?.byRole?.[role] ?? config.models?.default ?? undefined;
}

/**
 * Best-effort load of the user's `~/.raptor/config.json` for model resolution.
 * `loadConfig` returns defaults (no `models`) when the file is absent, so this
 * never throws and yields byte-identical behavior when no models are configured.
 */
function loadRaptorConfig(): RaptorConfig {
  return loadConfig(path.join(os.homedir(), ".raptor", "config.json"));
}

/**
 * Append the full step-7 review-gate instruction — the Sprint-14 adversarial
 * section PLUS the Sprint-17 mutation-check evidence requirement, composed by
 * buildStep7GateInstruction — to the step-7 QA "Run test suite" gate agent's
 * context. Injected in orchestrator code (not TEAM.md), so it takes effect for
 * every sprint. One helper, both dispatch seams — no drift. No-op for all other steps.
 */
function injectStep7Gate(step: WorkflowStep, context: string): string {
  if (step.role === "qa" && step.name === "Run test suite") {
    return `${context}\n\n${buildStep7GateInstruction()}`;
  }
  return context;
}

export interface SprintResult {
  status: "checkpoint" | "complete" | "error" | "escalated";
  progress: string;
  checkpoint?: CheckpointPrompt;
  message?: string;
  state: SprintState;
}

/**
 * Extract the feature slug from the sprint's backlog items.
 * Looks at the first item in the sprint section of backlog.md.
 */
function extractFeatureSlug(projectPath: string): string | null {
  const backlogPath = resolveBacklogPath(projectPath);
  if (!backlogPath) return null;

  const content = fs.readFileSync(backlogPath, "utf-8");
  const sprintMatch = content.match(
    /## Sprint \d+.*\n([\s\S]*?)(?=\n## |\n*$)/
  );
  if (!sprintMatch) return null;

  // Extract slug from first item: "- [ ] slug: description"
  const itemMatch = sprintMatch[1].match(/- \[[ x]\]\s+([a-z][a-z0-9-]*):/);
  return itemMatch ? itemMatch[1] : null;
}

/**
 * Check if expected output artifacts were produced by a step.
 */
function validateStepOutputs(
  step: WorkflowStep,
  projectPath: string
): string[] {
  const found: string[] = [];
  for (const pattern of step.expectedOutputs) {
    const dir = path.join(projectPath, path.dirname(pattern));
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isFile()) {
          found.push(path.relative(projectPath, fullPath));
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }
  return found;
}

/**
 * Validate that required output files exist after an agent completes.
 * Returns list of missing files. Empty list = all outputs present.
 */
export function validateRequiredOutputs(
  step: WorkflowStep,
  featureSlug: string,
  projectPath: string
): string[] {
  if (step.expectedOutputs.length === 0) return [];

  // Each pattern is evaluated independently against the real files on disk;
  // unsatisfied patterns are reported by their ORIGINAL pattern string (never
  // a resolved literal), so messages stay stable and non-misleading (AC #3).
  const missing: string[] = [];
  for (const pattern of step.expectedOutputs) {
    const result = matchExpectedOutput(pattern, projectPath, featureSlug);
    if (!result.satisfied) {
      missing.push(pattern);
    }
  }
  return missing;
}

/**
 * Human-readable required-output descriptions for the task description.
 * e.g. "docs/specs/*.md" → "docs/specs/*.md — at least one real FILE … (e.g. docs/specs/{slug}.md)"
 *
 * Historical note: this used to resolve patterns to literal paths via
 * `pattern.replace("*", featureSlug)`, which produced extensionless literals
 * (e.g. `tests/integration/{slug}`) that agents were told to create and that
 * validation then required verbatim. Descriptions are now generated by the
 * same module that performs validation (glob-match.ts), so the instruction
 * the agent reads and the gate it must pass cannot drift (AC #5).
 */
export function resolveExpectedOutputPaths(
  expectedOutputs: string[],
  featureSlug: string
): string[] {
  return expectedOutputs.map((pattern) =>
    describeRequiredOutput(pattern, featureSlug)
  );
}

/**
 * Build a task description for the subagent based on the step and sprint context.
 */
function buildTaskDescription(
  step: WorkflowStep,
  featureSlug: string,
  sprint: number,
  feedback?: string,
  testScopeSection?: string,
  requiredReadingSection?: string,
  salvageSection?: string
): string {
  let task = `Sprint ${sprint}, Step ${step.step}: ${step.description}.\n`;
  task += `Feature slug: ${featureSlug}\n`;

  if (step.expectedOutputs.length > 0) {
    const requiredOutputs = resolveExpectedOutputPaths(step.expectedOutputs, featureSlug);
    if (requiredOutputs.length > 0) {
      task += `\n**REQUIRED OUTPUT FILES — You MUST create files satisfying these patterns:**\n`;
      for (const description of requiredOutputs) {
        task += `- ${description}\n`;
      }
      task += `\nThis step will FAIL validation if no real file matching each pattern exists on disk after you complete. `;
      task += `Directories do NOT satisfy a pattern — create actual files with conventional names and extensions. `;
      task += `Do NOT skip file creation even if the content seems to already exist elsewhere (e.g. in the backlog). `;
      task += `The file is the deliverable.\n`;
    }
  }

  // CB-4 (AC 14): salvaged-artifact guidance goes in the task description —
  // which expected outputs already exist (do not recreate) vs. still missing.
  if (salvageSection) {
    task += salvageSection;
  }

  if (feedback) {
    task += `\nUser feedback from previous review:\n${feedback}\n`;
    task += "Please address this feedback in your output.\n";
  }

  // Inject required reading artifacts and checklist
  if (requiredReadingSection) {
    task += requiredReadingSection;
  }

  // Append test scope instructions if applicable
  if (testScopeSection) {
    task += testScopeSection;
  }

  task += `\nCommit your work with the format: [${step.role.toUpperCase()}] {action}: {description}\n`;

  return task;
}

/**
 * Build retry context with progressive enrichment.
 */
function buildRetryContext(
  attempt: number,
  maxAttempts: number,
  failures: FailureRecord[],
  partialArtifacts: string[],
  projectPath: string
): string {
  const sections: string[] = [];

  sections.push(`\n--- RETRY CONTEXT (Attempt ${attempt} of ${maxAttempts}) ---`);
  sections.push("Your previous attempt failed. Please try again, ensuring you produce the expected outputs.\n");

  // Include previous error outputs
  for (const failure of failures) {
    sections.push(`Attempt ${failure.attempt} error: ${failure.errorSummary}`);
  }

  // Include partial artifacts if any
  if (partialArtifacts.length > 0) {
    sections.push("\nPartial artifacts from previous attempts (preserved, build on these):");
    for (const artifactPath of partialArtifacts) {
      const fullPath = path.join(projectPath, artifactPath);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const truncated = content.slice(0, RETRY_CONTEXT_MAX_LENGTH);
          sections.push(`--- ${artifactPath} ---\n${truncated}`);
        } catch {
          sections.push(`--- ${artifactPath} (could not read) ---`);
        }
      }
    }
  }

  return sections.join("\n");
}

/**
 * Truncate a string to a max length for error summaries.
 */
function truncateErrorSummary(output: string): string {
  if (!output || output.length === 0) return "agent produced no output";
  return output.slice(0, ERROR_SUMMARY_MAX_LENGTH);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Progress-aware circuit breaker (Sprint 12, CB-1/CB-2/CB-4) ───────────────

/**
 * Result of the salvage check (CB-4): which expectedOutputs patterns are
 * already satisfied by validated files on disk after a failed attempt.
 */
export interface SalvageResult {
  /** Every expectedOutputs pattern satisfied (and the step HAS expected outputs). */
  complete: boolean;
  /** Patterns satisfied, annotated with the matching files: `pattern (file, …)`. */
  satisfied: string[];
  /** Patterns not yet satisfied. */
  missing: string[];
}

/**
 * Check whether a failed attempt left validated expected outputs on disk.
 *
 * A wrapper over the existing glob gate (`matchExpectedOutput`) — salvage
 * never bypasses validation, it IS the validation gate (AC 16). Files named
 * `.gitkeep` never satisfy a pattern for salvage purposes (AC 17) — this
 * wrapper guards independently of the glob gate's own filtering (architecture
 * constraint 6: `validateStepOutputs`/`glob-match.ts` are NOT modified here).
 * Read-only: never mutates the tree.
 */
export function checkSalvage(
  step: WorkflowStep,
  featureSlug: string,
  projectPath: string
): SalvageResult {
  const satisfied: string[] = [];
  const missing: string[] = [];

  // A step with no expected outputs can never salvage-complete.
  if (step.expectedOutputs.length === 0) {
    return { complete: false, satisfied, missing };
  }

  for (const pattern of step.expectedOutputs) {
    const result = matchExpectedOutput(pattern, projectPath, featureSlug);
    const realFiles = result.matchedFiles.filter(
      (f) => path.basename(f) !== ".gitkeep"
    );
    if (result.satisfied && realFiles.length > 0) {
      satisfied.push(`${pattern} (${realFiles.join(", ")})`);
    } else {
      missing.push(pattern);
    }
  }

  return { complete: missing.length === 0, satisfied, missing };
}

/**
 * The retry decision returned after every failed agent attempt (CB-1/2/4).
 * Decision ordering (architecture, Open Question 5 ruling + Sprint 15):
 * salvage-complete > user-actionable (escalate-now) > transient >
 * no-progress short-circuit > slot accounting.
 * (BLOCKER escalation is handled by callers before recording, unchanged.)
 */
export type RetryDecision =
  | { kind: "salvage-complete"; artifacts: string[] }
  | { kind: "retry"; consumesSlot: boolean; delayMs: number }
  | {
      kind: "escalate";
      reason:
        | "no-progress"
        | "transient-cap"
        | "attempts-exhausted"
        | "user-actionable";
      detail: string;
    };

/**
 * Pure retry-decision pipeline — the single mechanism BOTH agent retry loops
 * call, so single- and multi-feature behavior cannot diverge (architecture
 * constraint 1). `newFailure` must already be pushed onto
 * `stepState.failures`, classified and signed.
 */
export function decideAfterFailure(
  stepState: StepState,
  newFailure: FailureRecord,
  salvage: SalvageResult
): RetryDecision {
  // 1. Salvage-complete beats everything (CB-4, AC 15): if the validated
  //    deliverables are on disk, no classification question remains.
  if (salvage.complete) {
    return { kind: "salvage-complete", artifacts: salvage.satisfied };
  }

  const failures = stepState.failures ?? [];
  const classification = newFailure.classification ?? "deterministic";

  // 2. User-actionable (Sprint 15): the blocker is OUTSIDE the sprint — no
  //    amount of retrying can succeed until the user acts (raise a spend
  //    limit, fix a typo'd --model). Escalate-now on the FIRST attempt,
  //    dominating the transient cap, the no-progress short-circuit, and
  //    deterministic slot accounting (spec AC 5). The branch keys off the
  //    CURRENT failure's classification, not the attempt counter, so a
  //    user-actionable failure on attempt 2+ still escalates immediately
  //    (Edge Case). Salvage-complete still wins above (ordering).
  if (classification === "user-actionable") {
    return {
      kind: "escalate",
      reason: "user-actionable",
      detail:
        resolveUserAction(newFailure.errorSummary) ??
        "This failure requires action outside the sprint before it can succeed.",
    };
  }

  // 3. Transient (CB-2, AC 6-7): retry without consuming a deterministic
  //    slot, bounded by the transient cap. Transient failures never
  //    participate in the CB-1 signature comparison.
  if (classification === "transient") {
    const transientCount = failures.filter(
      (f) => (f.classification ?? "deterministic") === "transient"
    ).length;
    if (transientCount >= TRANSIENT_RETRY_CAP) {
      return {
        kind: "escalate",
        reason: "transient-cap",
        detail: `persistent infrastructure failure: ${
          newFailure.signature ?? newFailure.errorSummary
        } × ${TRANSIENT_RETRY_CAP}`,
      };
    }
    return { kind: "retry", consumesSlot: false, delayMs: TRANSIENT_RETRY_DELAY_MS };
  }

  // 4. No-progress short-circuit (CB-1, AC 1-4): compare against the most
  //    recent PRIOR deterministic failure, skipping interleaved transient
  //    records. Signatures are persisted, never re-derived (constraint 4):
  //    an old record without a signature never matches. A match across the
  //    scope-narrowing boundary does not short-circuit (the task changed).
  const newIdx = failures.lastIndexOf(newFailure);
  const searchFrom = (newIdx === -1 ? failures.length : newIdx) - 1;
  for (let j = searchFrom; j >= 0; j--) {
    const prior = failures[j];
    if ((prior.classification ?? "deterministic") !== "deterministic") continue;
    if (
      prior.signature !== undefined &&
      newFailure.signature !== undefined &&
      prior.signature === newFailure.signature &&
      (prior.narrowed ?? false) === (newFailure.narrowed ?? false)
    ) {
      return {
        kind: "escalate",
        reason: "no-progress",
        detail: `retries short-circuited: identical failure signature "${newFailure.signature}" on consecutive attempts`,
      };
    }
    break; // only the MOST RECENT prior deterministic failure participates
  }

  // 5. Deterministic slot accounting — today's exact behavior (AC 8).
  //    `attempts` keeps its frozen meaning: deterministic attempts consumed,
  //    including this failure (constraint 3).
  if ((stepState.attempts ?? 0) >= MAX_RETRY_ATTEMPTS) {
    return {
      kind: "escalate",
      reason: "attempts-exhausted",
      detail: `step failed after ${MAX_RETRY_ATTEMPTS} attempts`,
    };
  }
  return { kind: "retry", consumesSlot: true, delayMs: 0 };
}

/**
 * Render the CB-4 salvage section for the next attempt's TASK DESCRIPTION
 * (AC 14): already-existing validated files (do not recreate) vs. patterns
 * still missing (this attempt's actual job). Empty when nothing was salvaged.
 */
export function buildSalvageSection(salvage: SalvageResult): string {
  if (salvage.satisfied.length === 0) return "";

  const lines: string[] = [];
  lines.push("");
  lines.push("--- SALVAGED WORK FROM PREVIOUS ATTEMPT ---");
  lines.push(
    "The following expected outputs already exist on disk and passed validation. " +
      "Do NOT recreate them from scratch — verify them and build on them:"
  );
  for (const entry of salvage.satisfied) {
    lines.push(`- ${entry}`);
  }
  if (salvage.missing.length > 0) {
    lines.push("");
    lines.push(
      "The following expected-output patterns are still missing — creating them is this attempt's actual job:"
    );
    for (const pattern of salvage.missing) {
      lines.push(`- ${pattern}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Shared per-failure processing for both agent retry loops: record the
 * failure (classified + signed at record time, AC 5 / constraint 4), run the
 * salvage check (CB-4), and return the pure pipeline's decision. Rolls back
 * the provisional attempt increment when the failure is transient (AC 6 —
 * transient failures never consume a deterministic slot) and stamps
 * `escalationReason` on escalation (AC 4/7 — no silent branches).
 */
function processFailureAndDecide(
  step: WorkflowStep,
  stepState: StepState,
  featureSlug: string,
  projectPath: string,
  rawSummary: string,
  attempt: number,
  extras?: { killKind?: "idle" | "ceiling" | "buffer-overflow"; narrowed?: boolean }
): RetryDecision {
  const salvage = checkSalvage(step, featureSlug, projectPath);
  const errorSummary = truncateErrorSummary(rawSummary);

  const record: FailureRecord = {
    attempt,
    errorSummary,
    timestamp: new Date().toISOString(),
    hadPartialArtifacts: validateStepOutputs(step, projectPath).length > 0,
    classification: classifyFailure(errorSummary),
    signature: deriveFailureSignature(errorSummary),
  };
  if (extras?.killKind) record.killKind = extras.killKind;
  if (extras?.narrowed) record.narrowed = true;
  if (salvage.satisfied.length > 0) record.salvagedPatterns = salvage.satisfied;
  stepState.failures.push(record);

  const decision = decideAfterFailure(stepState, record, salvage);

  if (decision.kind === "retry" && !decision.consumesSlot) {
    // Transient: roll back the provisional increment — `attempts` keeps its
    // frozen meaning of deterministic attempts consumed (constraint 3).
    stepState.attempts = Math.max(0, stepState.attempts - 1);
  }
  if (decision.kind === "escalate") {
    stepState.escalationReason = decision.reason;
  }
  return decision;
}

/**
 * Result of resolving which escalated feature a `request-changes` resume should
 * target (multi-feature mode). Pure — performs no state mutation.
 */
export type ResumeTargetResolution =
  | { ok: true; target: string }
  | { ok: false; error: string };

/**
 * Resolve the escalated feature to re-engage for a multi-feature
 * `request-changes` resume (AC #5, #6 + edge cases). Mirrors the architecture's
 * "Resume routing semantics" table:
 *   - exactly one escalated, no `feature` arg → target it implicitly (AC #5)
 *   - >1 escalated, no `feature` arg → error listing all escalated slugs (AC #6)
 *   - explicit `feature` that is escalated → target it
 *   - explicit `feature` that is missing or not escalated → error naming valid slugs
 *
 * No mutation here — the runner mutates only on a successful resolve.
 */
export function resolveEscalatedResumeTarget(
  features: FeatureState[],
  feature: string | undefined
): ResumeTargetResolution {
  const escalated = features.filter((f) => f.status === "escalated");
  const escalatedSlugs = escalated.map((f) => f.slug);

  if (feature !== undefined) {
    const match = features.find((f) => f.slug === feature);
    if (!match || match.status !== "escalated") {
      return {
        ok: false,
        error:
          `Feature '${feature}' is not an escalated feature. ` +
          `Escalated features: [${escalatedSlugs.join(", ")}]. ` +
          `Re-run resume_sprint --action=request-changes --feature=<slug> with one of these.`,
      };
    }
    return { ok: true, target: match.slug };
  }

  if (escalated.length === 1) {
    return { ok: true, target: escalated[0].slug };
  }

  return {
    ok: false,
    error:
      `Multiple features are escalated: [${escalatedSlugs.join(", ")}]. ` +
      `Re-run with --feature=<slug> to choose which feature to re-engage.`,
  };
}

/**
 * Build a clear escalated-state message for a multi-feature sprint (AC #11):
 * names each escalated feature, the step at which it stalled, and the exact
 * resume command (with the `--feature=<slug>` selector required only when more
 * than one feature is escalated).
 */
export function buildMultiFeatureEscalatedMessage(
  state: SprintState,
  sprint: number
): string {
  const escalated = (state.features ?? []).filter((f) => f.status === "escalated");
  if (escalated.length === 0) {
    return (
      `Sprint ${sprint} is escalated — awaiting user intervention. ` +
      `Run resume_sprint --action=request-changes --feedback="…" to re-engage.`
    );
  }

  const lines = escalated.map((f) => {
    const escStep = f.steps.find((s) => s.status === "escalated");
    const stepDesc = escStep ? `step ${escStep.step} (${escStep.name})` : "an earlier step";
    // Sprint 15: for a user-actionable escalation, surface the concrete action
    // so the user can act without guessing (spec AC 7 / AC 8 — same seam parity
    // as the single-feature path). Re-resolve from the last failure's summary;
    // the escalation reason was persisted on the step by the shared pipeline.
    if (escStep && escStep.escalationReason === "user-actionable") {
      const lastError =
        escStep.failures[escStep.failures.length - 1]?.errorSummary ?? "";
      const action =
        resolveUserAction(lastError) ??
        "This failure requires action outside the sprint before it can succeed.";
      return `  • ${f.slug} at ${stepDesc} — action required: ${action}`;
    }
    return `  • ${f.slug} at ${stepDesc}`;
  });

  const slugHint = escalated.length > 1 ? "--feature=<slug>" : "[--feature=<slug>]";
  return (
    `Sprint ${sprint} is escalated. Escalated feature(s):\n${lines.join("\n")}\n` +
    `Run resume_sprint --action=request-changes --feedback="…" ${slugHint} to re-engage. ` +
    `Completed sibling features are preserved.`
  );
}

/**
 * Build the user-facing escalation message for the SINGLE-feature runner seam
 * (Sprint 15, user-actionable-failure-class — AC 7/8). Pure and exported so the
 * production message-rendering seam is testable in isolation (TEAM.md QA rule
 * 12 — parity asserted at the seam, mirroring `buildMultiFeatureEscalatedMessage`).
 *
 * For a `user-actionable` escalation it names the concrete action the user must
 * take (spend limit → claude.ai/settings/usage) instead of the generic
 * "escalated (transient cap)" arm, which previously
 * MISLABELED any non-exhausted reason. `attempts-exhausted` and the
 * no-progress/transient-cap arms are byte-for-byte unchanged (AC 12).
 */
export function buildSingleFeatureEscalationMessage(
  step: WorkflowStep,
  reason: NonNullable<StepState["escalationReason"]>,
  stepState: StepState,
  escalationDetail?: string | null
): string {
  const lastError =
    stepState.failures[stepState.failures.length - 1]?.errorSummary ?? "unknown";

  if (reason === "user-actionable") {
    // Prefer the pipeline detail; fall back to re-resolving from the last
    // failure summary so the action survives a reload where detail was not
    // threaded through.
    const action =
      escalationDetail ??
      resolveUserAction(lastError) ??
      "This failure requires action outside the sprint before it can succeed.";
    return (
      `Step ${step.step} (${step.name}) escalated — action required before this can succeed:\n${action}\n\n` +
      `Last error:\n${lastError}`
    );
  }

  if (reason === "attempts-exhausted") {
    return `Step ${step.step} (${step.name}) failed after ${MAX_RETRY_ATTEMPTS} attempts.\n\nLast error:\n${lastError}`;
  }

  return `Step ${step.step} (${step.name}) escalated (${
    reason === "no-progress" ? "no progress" : "transient cap"
  }): ${escalationDetail ?? lastError}`;
}

/**
 * Find the first duplicate slug in a list, or null if all are unique.
 */
function findDuplicateSlug(slugs: string[]): string | null {
  const seen = new Set<string>();
  for (const slug of slugs) {
    if (seen.has(slug)) return slug;
    seen.add(slug);
  }
  return null;
}

/**
 * Identify which slugs in the sprint section are already checked off as `[x]`.
 * Used by the multi-feature seeder to mark pre-completed features without
 * requiring a helper-signature change to multi-runner exports.
 */
function detectCheckedSlugs(projectPath: string, sprint: number): Set<string> {
  const checked = new Set<string>();
  const backlogPath = resolveBacklogPath(projectPath);
  if (!backlogPath) return checked;

  try {
    const content = fs.readFileSync(backlogPath, "utf-8");
    const sprintMatch = content.match(
      new RegExp(`## Sprint ${sprint}[^]*?(?=\\n## |$)`)
    );
    if (!sprintMatch) return checked;
    const re = /- \[x\]\s+([a-z][a-z0-9-]*):/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sprintMatch[0])) !== null) {
      checked.add(m[1]);
    }
  } catch {
    // Non-critical — return empty set
  }
  return checked;
}

/**
 * Run a sprint from a given step until the next checkpoint or completion.
 */
export async function runSprintFromStep(
  projectPath: string,
  projectSlug: string,
  sprint: number,
  fromStep: number,
  feedback?: string,
  timeoutConfig?: TimeoutConfig
): Promise<SprintResult> {
  // Load or create state
  let state = loadSprintState(projectSlug, sprint);
  if (!state) {
    state = createInitialState(
      projectSlug,
      sprint,
      SPRINT_WORKFLOW.map((s) => ({
        step: s.step,
        role: s.role,
        name: s.name,
      })),
      null
    );
  }

  // --- AC #1 + #11 + Edge: Detection on entry ---
  const detectedFeatures = detectSprintFeatures(projectPath, sprint);

  // AC #11: empty sprint → existing error result, sprint marked failed
  if (detectedFeatures.length === 0) {
    state.status = "failed";
    saveSprintState(projectSlug, sprint, state);
    return {
      status: "error",
      progress: renderProgressTable(state),
      message:
        "Could not extract feature slug from backlog. Ensure the sprint section has items in the format: - [ ] slug: description",
      state,
    };
  }

  // Edge case: duplicate slugs → reject before dispatch (only validate if
  // state.features is not yet populated; once seeded, the set is frozen
  // per AC #12 and the user may freely mutate the backlog without affecting
  // the in-flight sprint).
  if (!state.features || state.features.length === 0) {
    const dup = findDuplicateSlug(detectedFeatures);
    if (dup) {
      state.status = "failed";
      saveSprintState(projectSlug, sprint, state);
      return {
        status: "error",
        progress: renderProgressTable(state),
        message: `Duplicate slug '${dup}' in sprint section of backlog.md`,
        state,
      };
    }
  }

  // --- AC #2: Seed multi-feature state on first run (if 2+ features) ---
  // AC #12: do NOT re-seed once state.features exists. The set is frozen for
  // the life of the state file.
  const isMultiFeature = state.features
    ? state.features.length > 1
    : detectedFeatures.length > 1;

  if (isMultiFeature && (!state.features || state.features.length === 0)) {
    const features = createFeatureStates(detectedFeatures, sprint);
    // Edge: pre-checked items are seeded as complete with all per-feature
    // steps skipped (architecture: post-process inside the dispatcher).
    const checked = detectCheckedSlugs(projectPath, sprint);
    for (const f of features) {
      if (checked.has(f.slug)) {
        f.status = "complete";
        const now = new Date().toISOString();
        for (const s of f.steps) {
          s.status = "complete";
          s.completedAt = now;
        }
      }
    }
    state.features = features;
    saveSprintState(projectSlug, sprint, state);
  }

  // Resolve the feature slug for prompt substitution: in single-feature mode,
  // keep using extractFeatureSlug (preserves existing behavior); in multi mode
  // we will iterate state.features and use each feature's slug.
  const singleFeatureSlug = extractFeatureSlug(projectPath);
  if (!singleFeatureSlug && !isMultiFeature) {
    // Belt-and-suspenders: detectSprintFeatures returned items but
    // extractFeatureSlug (whose regex is slightly different) didn't.
    // Treat as the empty-sprint error.
    state.status = "failed";
    saveSprintState(projectSlug, sprint, state);
    return {
      status: "error",
      progress: renderProgressTable(state),
      message:
        "Could not extract feature slug from backlog. Ensure the sprint section has items in the format: - [ ] slug: description",
      state,
    };
  }

  const git = simpleGit(projectPath);

  // Resolve dino names for this sprint run
  const dinoNames = resolveDinoNames();

  // Detect test framework once for scoped test execution
  const testFramework = detectTestFramework(projectPath);

  // Load cross-sprint context for agent prompts
  const sprintSummaries = loadSprintSummaries(projectPath);

  // Per-role model config (adversarial-verifier-review-gate, Part 2). Absent
  // config ⇒ no models ⇒ every spawn runs the default model (byte-identical).
  const config = loadRaptorConfig();

  // --- Multi-feature dispatch path ---
  if (isMultiFeature) {
    return await runMultiFeatureSprint({
      projectPath,
      projectSlug,
      sprint,
      state,
      fromStep,
      feedback,
      git,
      dinoNames,
      testFramework,
      sprintSummaries,
      timeoutConfig,
      config,
    });
  }

  // --- Single-feature path (existing behavior, untouched below) ---
  // AC #4 (bundled sprint-branch-auto-create): ensure the single feature is on
  // its own sprint-{N}/{slug} branch before any commit-producing step. This
  // replaces the legacy "record whatever HEAD points to" logic.
  const featureSlug = singleFeatureSlug!;
  const sfBranch = await ensureFeatureBranch(projectPath, sprint, featureSlug);
  if (sfBranch.error) {
    state.status = "failed";
    saveSprintState(projectSlug, sprint, state);
    return {
      status: "error",
      progress: renderProgressTable(state),
      message: sfBranch.error,
      state,
    };
  }
  state.branchName = featureBranchName(sprint, featureSlug);
  saveSprintState(projectSlug, sprint, state);

  // Execute steps sequentially from fromStep
  for (let i = fromStep - 1; i < SPRINT_WORKFLOW.length; i++) {
    const step = SPRINT_WORKFLOW[i];
    const stepState = state.steps[i];

    // Skip completed steps
    if (stepState.status === "complete") continue;

    // Mark step in progress
    stepState.status = "in-progress";
    state.currentStep = step.step;
    state.status = "in-progress";
    saveSprintState(projectSlug, sprint, state);

    // --- Handle Collect retro proposals (step 11) ---
    if (step.name === "Collect retro proposals") {
      const teamMdPath = path.join(projectPath, "TEAM.md");
      const teamMd = fs.existsSync(teamMdPath) ? fs.readFileSync(teamMdPath, "utf-8") : "";
      const sprintContext = buildSprintContextForRetro(state);
      const roles: Role[] = ["po", "architect", "qa", "engineer"];
      const proposals: (RetroProposal | null)[] = [];

      for (const role of roles) {
        const retroPrompt = buildRetroPrompt(role, teamMd, sprintContext);
        try {
          const result = await spawnAgent(
            role,
            retroPrompt,
            "",
            "Propose one improvement to TEAM.md based on your sprint experience.",
            projectPath
          );
          const proposal = parseRetroProposal(role, result.output);
          proposals.push(proposal);
        } catch {
          proposals.push(null);
        }
      }

      // Generate and write retro document
      const retroDoc = generateRetroDocument(projectSlug, sprint, proposals, roles);
      const sprintsDir = path.join(projectPath, "docs", "sprints");
      fs.mkdirSync(sprintsDir, { recursive: true });
      const retroPath = path.join(sprintsDir, `sprint-${sprint}-retro.md`);
      fs.writeFileSync(retroPath, retroDoc);

      // Store proposals in state
      state.retroProposals = proposals.filter((p): p is RetroProposal => p !== null);

      try {
        await git.add(retroPath);
        await git.commit(`[PO] add: sprint ${sprint} retrospective proposals`);
      } catch {
        // Non-critical
      }

      stepState.attempts = 1;
      stepState.status = "complete";
      stepState.completedAt = new Date().toISOString();
      saveSprintState(projectSlug, sprint, state);

      // Handoff
      const handoff = HANDOFF_MAP[step.step];
      if (handoff) {
        try {
          await git.commit(
            `[HANDOFF] ${formatHandoffRole(handoff.from, dinoNames)} -> ${formatHandoffRole(handoff.to, dinoNames)}: ${handoff.artifact} for ${featureSlug}`,
            { "--allow-empty": null }
          );
        } catch { /* Non-critical */ }
      }

      // Checkpoint is on step 12, not 11 — continue
      continue;
    }

    // --- Handle Apply retro improvements (step 13) ---
    // Thin wrapper around the shared executor (AC 6: parity with the
    // multi-feature path is structural — one implementation, two seams).
    if (step.name === "Apply retro improvements") {
      const report = await executeRetroApply(projectPath, sprint, state, git);
      persistRetroApplyReport(state, report);

      stepState.attempts = 1;
      stepState.status = "complete";
      stepState.completedAt = new Date().toISOString();
      // Persist-before-yield: report lands in state before the step reads
      // as complete anywhere.
      saveSprintState(projectSlug, sprint, state);

      // Continue — will hit the "All steps complete" block
      continue;
    }

    // --- Handle Merge PR step directly (no subagent) ---
    if (step.name === "Merge PR") {
      // Update PR DoD checklist before merge
      try {
        await updatePrDodChecklist(projectPath, state.dod);
      } catch {
        // Best-effort — don't block merge
      }

      const branchName = state.branchName;
      if (!branchName) {
        stepState.status = "failed";
        state.status = "failed";
        saveSprintState(projectSlug, sprint, state);
        return {
          status: "error",
          progress: renderProgressTable(state),
          message: "Cannot merge: sprint branch name not tracked in state.",
          state,
        };
      }

      // C1 (AC #1, #2, #3): in-place bounded merge retry. The pre-fix code
      // executed `continue` here on a below-cap failure — which ADVANCED the
      // step-loop index and silently SKIPPED the merge (the Sprint 10 /
      // Sprint 12 false-"Sprint complete"). The retry is now a local do/while
      // around the merge attempt — never index games on the step loop
      // (architecture constraint 1). Termination: attempts increments on
      // EVERY failed executeMerge invocation and the escalation branch
      // returns at MAX_RETRY_ATTEMPTS, so the loop runs at most
      // MAX_RETRY_ATTEMPTS iterations (fewer if attempts was already non-zero
      // from a resumed state — resumed attempts still count toward the cap).
      let mergeResult: MergeResult;
      do {
        mergeResult = await executeMerge(
          projectPath,
          featureSlug,
          sprint,
          branchName
        );

        if (!mergeResult.success) {
          // Failure accounting — semantics unchanged (AC #2): attempts count
          // equals executeMerge invocation count; every failure appends one
          // truncated record. C5 (additive): classification + signature
          // persisted for post-mortems — no decideAfterFailure wiring, retry
          // behavior unchanged (architecture constraint 6).
          const errorSummary = truncateErrorSummary(mergeResult.error || "Merge failed");
          stepState.attempts++;
          stepState.failures.push({
            attempt: stepState.attempts,
            errorSummary,
            timestamp: new Date().toISOString(),
            hadPartialArtifacts: false,
            classification: classifyFailure(errorSummary),
            signature: deriveFailureSignature(errorSummary),
          });

          if (stepState.attempts >= MAX_RETRY_ATTEMPTS) {
            // Escalation block preserved verbatim (AC #3, #9): step 9 ->
            // escalated, sprint -> escalated, [ESCALATE] commit, early
            // return — steps 10–13 never run, no [HANDOFF] is created.
            stepState.status = "escalated";
            state.status = "escalated";
            saveSprintState(projectSlug, sprint, state);

            // Create escalation commit
            try {
              const summary = stepState.failures.map(
                (f) => `Attempt ${f.attempt}: ${f.errorSummary}`
              ).join("; ");
              await git.commit(
                `[ESCALATE] ${formatHandoffRole("engineer", dinoNames)}: step ${step.step} (${step.name}) failed ${stepState.attempts} times — requesting user intervention.\nSummary: ${summary}`,
                { "--allow-empty": null }
              );
            } catch {
              // Non-critical
            }

            return {
              status: "escalated",
              progress: renderProgressTable(state),
              message: `Merge failed after ${stepState.attempts} attempts: ${mergeResult.error}`,
              state,
            };
          }

          // Persist before every retry (persist-before-yield pattern, NFR 4)
          // — a crash mid-retry resumes with accurate attempts/failures.
          saveSprintState(projectSlug, sprint, state);
        }
      } while (!mergeResult.success);

      // Merge succeeded
      stepState.attempts++;
      stepState.status = "complete";
      stepState.completedAt = new Date().toISOString();
      saveSprintState(projectSlug, sprint, state);

      // Create handoff commit
      const handoff = HANDOFF_MAP[step.step];
      if (handoff) {
        try {
          await git.commit(
            `[HANDOFF] ${formatHandoffRole(handoff.from, dinoNames)} -> ${formatHandoffRole(handoff.to, dinoNames)}: ${handoff.artifact} for ${featureSlug}`,
            { "--allow-empty": null }
          );
        } catch {
          // Non-critical
        }
      }

      continue;
    }

    // --- Standard agent step with progress-aware circuit breaker (CB-1/2/4) ---
    let succeeded = false;
    let completedViaSalvage = false;
    let escalationDetail: string | null = null;

    while (true) {
      // Safety guard: deterministic slots already exhausted (e.g. re-entered
      // without a reset) — escalate rather than spawning another attempt.
      if (stepState.attempts >= MAX_RETRY_ATTEMPTS) {
        stepState.escalationReason = stepState.escalationReason ?? "attempts-exhausted";
        break;
      }

      // Provisional deterministic attempt number: rolled back by
      // processFailureAndDecide when the failure classifies transient (AC 6).
      const attempt = stepState.attempts + 1;
      stepState.attempts = attempt;
      saveSprintState(projectSlug, sprint, state);

      // Build prompts and context
      const systemPrompt = buildRolePrompt(step.role);
      let context = buildStepContext(step.step, projectPath, featureSlug);

      // Inject the composed step-7 review gate (Sprint-14 adversarial +
      // Sprint-17 mutation-check) into the QA "Run test suite" prompt (no-op for
      // every other step).
      context = injectStep7Gate(step, context);

      // Layer 1: Inject TEAM.md so agents see the canonical process definition
      const teamMdContext = buildTeamMdContext(projectPath);
      if (teamMdContext) {
        context = `${teamMdContext}\n\n${context}`;
      }

      // Inject cross-sprint context if available
      if (sprintSummaries) {
        context = `--- Previous Sprint Context ---\n${sprintSummaries}\n\n--- Current Sprint Artifacts ---\n${context}`;
      }

      // Inject codebase snapshot for Sprint 2+ (regenerated per step)
      if (sprint > 1) {
        const codebaseSnapshot = buildCodebaseSnapshot(projectPath);
        const codebaseSection = formatSnapshotForPrompt(codebaseSnapshot);
        context = `${codebaseSection}\n\n${context}`;
      }

      // Resolve and inject required artifacts (read-before-write enforcement)
      const artifactResult = resolveArtifacts(step.name, featureSlug, projectPath);
      if (artifactResult.missing.length > 0) {
        // Required artifact missing — record failure, run the pipeline
        const decision = processFailureAndDecide(
          step,
          stepState,
          featureSlug,
          projectPath,
          `Missing required artifacts: ${artifactResult.missing.join(", ")}`,
          attempt
        );
        saveSprintState(projectSlug, sprint, state);
        if (decision.kind === "salvage-complete") {
          succeeded = true;
          completedViaSalvage = true;
          break;
        }
        if (decision.kind === "escalate") {
          escalationDetail = decision.detail;
          break;
        }
        if (decision.delayMs > 0) await sleep(decision.delayMs);
        continue;
      }
      const requiredReadingSection = artifactResult.section || undefined;

      // Build test scope section for relevant steps
      const testScopeSection = buildTestScopeSection(
        step.name,
        featureSlug,
        testFramework,
        isMultiFeature
      );

      // CB-4 (AC 14): on retries, tell the agent which expected outputs
      // already exist and passed the gate — do not recreate them.
      const isRetry = (stepState.failures ?? []).length > 0;
      const salvageSection = isRetry
        ? buildSalvageSection(checkSalvage(step, featureSlug, projectPath)) || undefined
        : undefined;

      // Add user feedback on first attempt if provided
      const taskDesc = buildTaskDescription(
        step,
        featureSlug,
        sprint,
        attempt === 1 && i === fromStep - 1 ? feedback : undefined,
        testScopeSection || undefined,
        requiredReadingSection,
        salvageSection
      );

      // Add retry context when previous failures exist
      if (isRetry) {
        const partialArtifacts = validateStepOutputs(step, projectPath);
        context += buildRetryContext(
          attempt,
          MAX_RETRY_ATTEMPTS,
          stepState.failures,
          partialArtifacts,
          projectPath
        );
      }

      // On final deterministic attempt, try scope narrowing before normal retry
      if (attempt === MAX_RETRY_ATTEMPTS && isNarrowable(step.role)) {
        const subTasks = decomposeTask(step.role, step, featureSlug, projectPath, taskDesc);
        if (subTasks.length > 1) {
          const stepTimeout = resolveStepTimeout(step.name, timeoutConfig);
          const narrowResult = await executeNarrowedRetry(
            subTasks, step.role, systemPrompt, context, projectPath, stepTimeout
          );

          if (narrowResult.completedIds.length === narrowResult.subTasks.length) {
            // All sub-tasks succeeded
            succeeded = true;
            break;
          }

          // Partial or full failure — record (flagged narrowed for the CB-1
          // boundary rule) and run the pipeline
          const decision = processFailureAndDecide(
            step,
            stepState,
            featureSlug,
            projectPath,
            `Narrowed retry (${narrowResult.strategy}): ${narrowResult.completedIds.length}/${subTasks.length} sub-tasks completed. Failed: ${narrowResult.failedIds.join(", ")}`,
            attempt,
            { narrowed: true }
          );
          saveSprintState(projectSlug, sprint, state);
          if (decision.kind === "salvage-complete") {
            succeeded = true;
            completedViaSalvage = true;
            break;
          }
          if (decision.kind === "escalate") {
            escalationDetail = decision.detail;
            break;
          }
          if (decision.delayMs > 0) await sleep(decision.delayMs);
          continue;
        }
      }

      // Spawn subagent with step-aware timeout (CB-5: user config now reaches
      // the mechanism; the resolved value is the idle window — CB-3) and the
      // per-role model (Part 2: generator ≠ verifier — AC 9/10). Undefined model
      // ⇒ default `claude`, argv byte-identical to today.
      const stepTimeout = resolveStepTimeout(step.name, timeoutConfig);
      const result = await spawnAgent(
        step.role,
        systemPrompt,
        context,
        taskDesc,
        projectPath,
        stepTimeout,
        resolveRoleModel(step.role, config)
      );

      // Check for [BLOCKER] — immediate escalation (highest priority,
      // ahead of the salvage/transient/short-circuit pipeline)
      if (hasBlockerMarker(result.output)) {
        const blockerSummary = truncateErrorSummary(result.output);
        stepState.failures.push({
          attempt,
          errorSummary: blockerSummary,
          timestamp: new Date().toISOString(),
          hadPartialArtifacts: validateStepOutputs(step, projectPath).length > 0,
          classification: classifyFailure(blockerSummary),
          signature: deriveFailureSignature(blockerSummary),
        });
        stepState.status = "escalated";
        state.status = "escalated";
        saveSprintState(projectSlug, sprint, state);

        // Create escalation commit
        try {
          await git.commit(
            `[ESCALATE] ${formatHandoffRole(step.role, dinoNames)}: step ${step.step} (${step.name}) — agent raised [BLOCKER]: ${truncateErrorSummary(result.output)}`,
            { "--allow-empty": null }
          );
        } catch {
          // Non-critical
        }

        return {
          status: "escalated",
          progress: renderProgressTable(state),
          message: `Agent raised a BLOCKER at step ${step.step} (${step.name}). Escalating to user.\n\nAgent output:\n${result.output.slice(0, 2000)}`,
          state,
        };
      }

      if (result.exitCode === 0) {
        // Layer 3: Validate required outputs actually exist on disk
        const missingOutputs = validateRequiredOutputs(step, featureSlug, projectPath);
        if (missingOutputs.length > 0) {
          // Agent said it's done but didn't create required files — failure
          const decision = processFailureAndDecide(
            step,
            stepState,
            featureSlug,
            projectPath,
            `Agent completed (exit 0) but did not create required output files: ${missingOutputs.join(", ")}. The step is not complete until these files exist on disk.`,
            attempt
          );
          saveSprintState(projectSlug, sprint, state);
          if (decision.kind === "escalate") {
            escalationDetail = decision.detail;
            break;
          }
          if (decision.kind === "retry" && decision.delayMs > 0) {
            await sleep(decision.delayMs);
          }
          continue; // Retry — the agent will see this failure in retry context
        }

        succeeded = true;
        break;
      }

      // Record failure and run the CB-1/2/4 pipeline
      const decision = processFailureAndDecide(
        step,
        stepState,
        featureSlug,
        projectPath,
        result.output,
        attempt,
        { killKind: result.killKind }
      );
      saveSprintState(projectSlug, sprint, state);
      if (decision.kind === "salvage-complete") {
        // Sprint 11 case: agent finished its work, then died. Validated
        // deliverables are on disk — complete WITHOUT another attempt (AC 15).
        succeeded = true;
        completedViaSalvage = true;
        break;
      }
      if (decision.kind === "escalate") {
        escalationDetail = decision.detail;
        break;
      }
      if (decision.delayMs > 0) await sleep(decision.delayMs);
    }

    if (!succeeded) {
      // Escalate — reason recorded by the pipeline (AC 4/7/22)
      const reason = stepState.escalationReason ?? "attempts-exhausted";
      stepState.escalationReason = reason;
      stepState.status = "escalated";
      state.status = "escalated";
      saveSprintState(projectSlug, sprint, state);

      // Create escalation commit
      try {
        const summary = stepState.failures.map(
          (f) => `Attempt ${f.attempt}: ${f.errorSummary}`
        ).join("; ");
        await git.commit(
          `[ESCALATE] ${formatHandoffRole(step.role, dinoNames)}: step ${step.step} (${step.name}) failed ${stepState.failures.length} times — requesting user intervention.\nSummary: ${summary}`,
          { "--allow-empty": null }
        );
      } catch {
        // Non-critical
      }

      const message = buildSingleFeatureEscalationMessage(
        step,
        reason,
        stepState,
        escalationDetail
      );

      return {
        status: "escalated",
        progress: renderProgressTable(state),
        message,
        state,
      };
    }

    // Step succeeded — validate outputs and mark complete
    if (step.expectedOutputs.length > 0) {
      const artifacts = validateStepOutputs(step, projectPath);
      stepState.artifacts = artifacts;
    }

    stepState.status = "complete";
    if (completedViaSalvage) {
      // AC 15/22: auditable marker — the step completed via salvage, not a
      // fresh agent attempt.
      stepState.completedVia = "salvage";
    }
    stepState.completedAt = new Date().toISOString();

    // --- Update DoD fields based on completed step ---
    if (step.name === "Open PR") {
      state.dod.codeCommitted = true;
    } else if (step.name === "Run test suite") {
      state.dod.testsPass = true;
    } else if (step.name === "Demo") {
      state.dod.demoCompleted = true;
    }

    saveSprintState(projectSlug, sprint, state);

    // Create handoff commit if applicable
    const handoff = HANDOFF_MAP[step.step];
    if (handoff && step.step < 10) {
      try {
        await git.commit(
          `[HANDOFF] ${formatHandoffRole(handoff.from, dinoNames)} -> ${formatHandoffRole(handoff.to, dinoNames)}: ${handoff.artifact} for ${featureSlug}`,
          { "--allow-empty": null }
        );
      } catch {
        // Non-critical — handoff commit is informational
      }
    }

    // Check if this step has a checkpoint
    if (step.checkpointAfter) {
      state.status = "paused";
      state.checkpoints.push({
        type: step.checkpointAfter,
        status: "pending",
        feedback: null,
        resolvedAt: null,
      });
      saveSprintState(projectSlug, sprint, state);

      // Build artifact summary for the checkpoint
      const artifactSummary = buildStepContext(
        step.step,
        projectPath,
        featureSlug
      );
      const checkpoint = buildCheckpointPrompt(
        step.checkpointAfter,
        artifactSummary.slice(0, 5000)
      );

      return {
        status: "checkpoint",
        progress: renderProgressTable(state),
        checkpoint,
        state,
      };
    }
  }

  // C3 (AC #4): finalization guard — defense in depth beyond C1. The design
  // invariant: state.status === "complete" implies EVERY step in state.steps
  // is "complete". Pre-fix, this block set "complete" unconditionally — the
  // Sprint 10 / Sprint 12 lie. Guard trips map to "escalated" (Open Question
  // 3 ruling): resumable via the Sprint 10 escalated-resume path, never the
  // Sprint 9 in-progress limbo. No [ESCALATE] commit here — upstream
  // escalation paths already committed when they escalated; the guard's job
  // is truthful status, not duplicate git noise. Guards report, never repair
  // (architecture constraint 4).
  const incompleteSteps = findIncompleteSteps(state.steps);
  if (incompleteSteps.length > 0) {
    state.status = "escalated";
    saveSprintState(projectSlug, sprint, state);
    return {
      status: "escalated",
      progress: renderProgressTable(state),
      message: buildFinalizationGuardMessage(incompleteSteps),
      state,
    };
  }

  // All steps complete — generate sprint summary
  try {
    const summary = generateSprintSummary(projectPath, projectSlug, sprint, state);
    const sprintsDir = path.join(projectPath, "docs", "sprints");
    fs.mkdirSync(sprintsDir, { recursive: true });
    const summaryPath = path.join(sprintsDir, `sprint-${sprint}-summary.md`);
    fs.writeFileSync(summaryPath, summary);

    try {
      await git.add(summaryPath);
      await git.commit(`[PO] add: sprint ${sprint} summary for cross-sprint context`);
    } catch {
      // Non-critical
    }
  } catch {
    // Summary generation is best-effort
  }

  state.status = "complete";
  saveSprintState(projectSlug, sprint, state);

  return {
    status: "complete",
    progress: renderProgressTable(state),
    message: appendRetroApplyQualification(
      "Sprint complete! All steps finished successfully.",
      state
    ),
    state,
  };
}

/**
 * Resume a sprint after a user checkpoint, or from a failed/escalated state.
 */
export async function resumeSprint(
  projectPath: string,
  projectSlug: string,
  sprint: number,
  action: "approve" | "request-changes",
  feedback?: string,
  feature?: string,
  // Default value (not just `?`) so Function.length stays <= 6 — the Sprint 10
  // signature-additivity contract pins arity, and trailing params stay optional.
  timeoutConfig: TimeoutConfig | undefined = undefined
): Promise<SprintResult> {
  const state = loadSprintState(projectSlug, sprint);
  if (!state) {
    return {
      status: "error",
      progress: "",
      message: `No sprint state found for ${projectSlug} sprint ${sprint}. Use run_sprint to start a sprint.`,
      state: createInitialState(projectSlug, sprint, []),
    };
  }

  // --- Resume from paused (checkpoint) ---
  if (state.status === "paused") {
    const pendingCheckpoint = state.checkpoints.find(
      (c) => c.status === "pending"
    );
    if (!pendingCheckpoint) {
      return {
        status: "error",
        progress: renderProgressTable(state),
        message: "No pending checkpoint found.",
        state,
      };
    }

    const isMultiFeatureCheckpoint = !!(
      state.features && state.features.length > 1 && pendingCheckpoint.feature
    );

    if (action === "approve") {
      pendingCheckpoint.status = "approved";
      pendingCheckpoint.feedback = feedback || null;
      pendingCheckpoint.resolvedAt = new Date().toISOString();

      if (isMultiFeatureCheckpoint && state.features) {
        // AC #13 streaming approve: mark only the affected feature's per-step
        // complete + update its DoD; the dispatcher's next loop iteration will
        // skip it and land on the next un-checkpointed feature for this step.
        const feature = state.features.find((f) => f.slug === pendingCheckpoint.feature);
        if (feature) {
          const featureStep = feature.steps.find((s) => s.step === state.currentStep);
          if (featureStep && featureStep.status !== "complete") {
            featureStep.status = "complete";
            featureStep.completedAt = new Date().toISOString();
          }
          if (pendingCheckpoint.type === "pr-review") {
            feature.dod.prReviewApproved = true;
          } else if (pendingCheckpoint.type === "demo-feedback") {
            feature.dod.poAccepted = true;
          }
        }
        saveSprintState(projectSlug, sprint, state);
        // Re-enter from the SAME step so the dispatcher iterates to the next
        // un-checkpointed feature (architecture §3 step 2 checkpoint case).
        return runSprintFromStep(
          projectPath,
          projectSlug,
          sprint,
          state.currentStep,
          undefined,
          timeoutConfig
        );
      }

      // Single-feature path (existing behavior): update top-level DoD and
      // advance to the next workflow step.
      if (pendingCheckpoint.type === "pr-review") {
        state.dod.prReviewApproved = true;
      } else if (pendingCheckpoint.type === "demo-feedback") {
        state.dod.poAccepted = true;
      }
      saveSprintState(projectSlug, sprint, state);
      return runSprintFromStep(
        projectPath,
        projectSlug,
        sprint,
        state.currentStep + 1,
        undefined,
        timeoutConfig
      );
    } else {
      pendingCheckpoint.status = "changes-requested";
      pendingCheckpoint.feedback = feedback || null;
      pendingCheckpoint.resolvedAt = new Date().toISOString();

      if (isMultiFeatureCheckpoint && state.features) {
        // AC #13 + architecture §6: reset ONLY the affected feature's per-step.
        const feature = state.features.find((f) => f.slug === pendingCheckpoint.feature);
        if (feature) {
          const featureStep = feature.steps.find((s) => s.step === state.currentStep);
          if (featureStep) {
            featureStep.status = "pending";
            featureStep.artifacts = [];
            featureStep.completedAt = null;
            featureStep.attempts = 0;
            featureStep.failures = [];
          }
          // Feature is back in progress; do not change other features.
          if (feature.status !== "complete" && feature.status !== "escalated") {
            feature.status = "in-progress";
          }
        }
        state.status = "in-progress";
        saveSprintState(projectSlug, sprint, state);
        return runSprintFromStep(
          projectPath,
          projectSlug,
          sprint,
          state.currentStep,
          feedback,
          timeoutConfig
        );
      }

      // Single-feature path: reset the top-level step. attempts and failures
      // must reset to 0/[] so the retry loop re-enters at attempt 1, where the
      // feedback-injection condition (attempt === 1) actually fires. Without
      // this, the next agent invocation receives a generic prompt and the
      // user's review feedback is silently dropped — closing the
      // request-changes-feedback-injection bug for the single-feature path.
      const currentStepState = state.steps[state.currentStep - 1];
      currentStepState.status = "pending";
      currentStepState.artifacts = [];
      currentStepState.completedAt = null;
      currentStepState.attempts = 0;
      currentStepState.failures = [];

      state.status = "in-progress";
      saveSprintState(projectSlug, sprint, state);

      return runSprintFromStep(
        projectPath,
        projectSlug,
        sprint,
        state.currentStep,
        feedback,
        timeoutConfig
      );
    }
  }

  // --- Resume from escalated ---
  if (state.status === "escalated") {
    // Escalated features (multi-feature mode). Empty when single-feature OR when
    // the escalation happened on a sprint-shared step (10-13), which lives on
    // the top-level state.steps array.
    const escalatedFeatures = (state.features ?? []).filter(
      (f) => f.status === "escalated"
    );

    // Edge case: `approve` cannot finalize a stalled feature. Return a redirect
    // message; do NOT mutate state.
    if (action === "approve") {
      const slugList =
        escalatedFeatures.length > 0
          ? escalatedFeatures.map((f) => f.slug).join(", ")
          : "(see progress)";
      return {
        status: "error",
        progress: renderProgressTable(state),
        message:
          `Sprint ${sprint} is escalated: feature(s) ${slugList} stalled at the circuit breaker. ` +
          `approve cannot finalize a stalled feature. To re-engage, run ` +
          `resume_sprint --action=request-changes --feedback="…" [--feature=<slug>]. ` +
          `To abandon and restart a feature from scratch, use the reset path (reset-sprint-tool, separate).`,
        state,
      };
    }

    if (!feedback) {
      return {
        status: "error",
        progress: renderProgressTable(state),
        message: "Cannot resume an escalated sprint without guidance. Please provide feedback describing how to resolve the issue.",
        state,
      };
    }

    // --- Multi-feature routing (AC #5, #6, #7, #12) ---
    // Only when there is at least one escalated FEATURE. A multi-feature sprint
    // that escalated on a shared step (10-13) has no escalated feature and falls
    // through to the top-level state.steps search below.
    if (state.features && escalatedFeatures.length > 0) {
      const resolution = resolveEscalatedResumeTarget(state.features, feature);
      if (!resolution.ok) {
        // No mutation on a routing error (multi-target without feature, unknown
        // or non-escalated slug).
        return {
          status: "error",
          progress: renderProgressTable(state),
          message: resolution.error,
          state,
        };
      }

      const targetFeature = state.features.find((f) => f.slug === resolution.target)!;
      const targetStep = targetFeature.steps.find((s) => s.status === "escalated");
      if (!targetStep) {
        return {
          status: "error",
          progress: renderProgressTable(state),
          message: `Feature '${targetFeature.slug}' is marked escalated but has no escalated step.`,
          state,
        };
      }

      // AC #7: reset the target feature's escalated step and re-enter. Sibling
      // features are untouched (AC #8) — we only mutate this feature.
      targetStep.attempts = 0;
      targetStep.failures = [];
      targetStep.status = "pending";
      targetStep.artifacts = [];
      targetStep.completedAt = null;
      targetFeature.status = "in-progress";
      targetFeature.currentStep = targetStep.step;
      state.currentFeatureSlug = targetFeature.slug;
      state.status = "in-progress";
      saveSprintState(projectSlug, sprint, state);

      return runSprintFromStep(
        projectPath,
        projectSlug,
        sprint,
        targetStep.step,
        feedback,
        timeoutConfig
      );
    }

    // --- Single-feature (or shared-step) path: search top-level state.steps ---
    const escalatedStep = state.steps.find((s) => s.status === "escalated");
    if (!escalatedStep) {
      return {
        status: "error",
        progress: renderProgressTable(state),
        message: "Sprint is marked as escalated but no escalated step found.",
        state,
      };
    }

    // Reset retry counter and failure history with user guidance
    escalatedStep.attempts = 0;
    escalatedStep.failures = [];
    escalatedStep.status = "pending";
    state.status = "in-progress";
    saveSprintState(projectSlug, sprint, state);

    return runSprintFromStep(
      projectPath,
      projectSlug,
      sprint,
      escalatedStep.step,
      feedback,
      timeoutConfig
    );
  }

  // --- Resume from failed ---
  if (state.status === "failed") {
    const failedStep = state.steps.find((s) => s.status === "failed");
    if (!failedStep) {
      return {
        status: "error",
        progress: renderProgressTable(state),
        message: "Sprint is marked as failed but no failed step found.",
        state,
      };
    }

    if (feedback) {
      // With guidance: reset retry counter
      failedStep.attempts = 0;
      failedStep.failures = [];
    }

    failedStep.status = "pending";
    state.status = "in-progress";
    saveSprintState(projectSlug, sprint, state);

    return runSprintFromStep(
      projectPath,
      projectSlug,
      sprint,
      failedStep.step,
      feedback,
      timeoutConfig
    );
  }

  return {
    status: "error",
    progress: renderProgressTable(state),
    message: `Sprint is in '${state.status}' status and cannot be resumed.`,
    state,
  };
}

// ─── Multi-feature dispatcher (architecture §3) ───────────────────────────────

interface DispatchContext {
  projectPath: string;
  projectSlug: string;
  sprint: number;
  state: SprintState;
  fromStep: number;
  feedback: string | undefined;
  git: SimpleGit;
  dinoNames: Record<Role, DinoIdentity>;
  testFramework: ReturnType<typeof detectTestFramework>;
  sprintSummaries: string | null;
  /** CB-5: user timeout config threaded to every resolveStepTimeout call. */
  timeoutConfig?: TimeoutConfig;
  /** Part 2: RaptorConfig for per-role model resolution (resolveRoleModel). */
  config: RaptorConfig;
}

type AgentStepOutcome =
  | { kind: "complete"; artifacts: string[]; via?: "agent" | "salvage" }
  | { kind: "blocker"; output: string }
  | { kind: "escalated"; lastError: string };

/**
 * Run the standard agent retry loop for a single (step, feature) pair.
 *
 * Encapsulates: prompt building, codebase/cross-sprint context injection,
 * artifact resolution, retry loop with circuit breaker, scope narrowing,
 * BLOCKER detection, output validation. Mutates the supplied stepState
 * (attempts/failures); the caller persists state and decides what to do
 * with the outcome.
 */
export async function runAgentStepCycle(
  step: WorkflowStep,
  stepState: StepState,
  featureSlug: string,
  ctx: DispatchContext,
  isMultiFeature: boolean,
  isFirstStepOfThisInvocation: boolean
): Promise<AgentStepOutcome> {
  const { projectPath, projectSlug, sprint, state, feedback, sprintSummaries, testFramework, timeoutConfig, config } = ctx;

  // Progress-aware circuit breaker (CB-1/2/4): the loop is driven by the
  // RetryDecision pipeline via processFailureAndDecide — the SAME mechanism the
  // single-feature loop uses, so behavior cannot diverge (architecture
  // constraint 1). `stepState.attempts` keeps its frozen meaning: deterministic
  // attempts consumed. Transient failures never consume a slot (AC 6).
  while (true) {
    // Safety guard: deterministic slots already exhausted (e.g. re-entered
    // without a reset) — escalate rather than spawning another attempt.
    if (stepState.attempts >= MAX_RETRY_ATTEMPTS) {
      stepState.escalationReason = stepState.escalationReason ?? "attempts-exhausted";
      break;
    }

    // Provisional deterministic attempt number: rolled back by
    // processFailureAndDecide when the failure classifies transient (AC 6).
    const attempt = stepState.attempts + 1;
    stepState.attempts = attempt;
    saveSprintState(projectSlug, sprint, state);

    // Build prompts and context
    const systemPrompt = buildRolePrompt(step.role);
    let context = buildStepContext(step.step, projectPath, featureSlug);

    // Inject the composed step-7 review gate (Sprint-14 adversarial +
    // Sprint-17 mutation-check) into the QA "Run test suite" prompt (no-op for
    // every other step).
    context = injectStep7Gate(step, context);

    const teamMdContext = buildTeamMdContext(projectPath);
    if (teamMdContext) context = `${teamMdContext}\n\n${context}`;

    if (sprintSummaries) {
      context = `--- Previous Sprint Context ---\n${sprintSummaries}\n\n--- Current Sprint Artifacts ---\n${context}`;
    }

    if (sprint > 1) {
      const codebaseSnapshot = buildCodebaseSnapshot(projectPath);
      const codebaseSection = formatSnapshotForPrompt(codebaseSnapshot);
      context = `${codebaseSection}\n\n${context}`;
    }

    const artifactResult = resolveArtifacts(step.name, featureSlug, projectPath);
    if (artifactResult.missing.length > 0) {
      // Required artifact missing — record failure, run the CB-1/2/4 pipeline
      const decision = processFailureAndDecide(
        step,
        stepState,
        featureSlug,
        projectPath,
        `Missing required artifacts: ${artifactResult.missing.join(", ")}`,
        attempt
      );
      saveSprintState(projectSlug, sprint, state);
      if (decision.kind === "salvage-complete") {
        return {
          kind: "complete",
          artifacts: validateStepOutputs(step, projectPath),
          via: "salvage",
        };
      }
      if (decision.kind === "escalate") break;
      if (decision.delayMs > 0) await sleep(decision.delayMs);
      continue;
    }
    const requiredReadingSection = artifactResult.section || undefined;

    const testScopeSection = buildTestScopeSection(
      step.name,
      featureSlug,
      testFramework,
      isMultiFeature
    );

    // CB-4 (AC 14): on retries, tell the agent which expected outputs already
    // exist and passed the gate — do not recreate them. `failures.length`
    // (not `attempt > 1`) is the retry signal: transient rollbacks can bring
    // `attempt` back to 1 while failure history exists.
    const isRetry = (stepState.failures ?? []).length > 0;
    const salvageSection = isRetry
      ? buildSalvageSection(checkSalvage(step, featureSlug, projectPath)) || undefined
      : undefined;

    const taskDesc = buildTaskDescription(
      step,
      featureSlug,
      sprint,
      attempt === 1 && isFirstStepOfThisInvocation ? feedback : undefined,
      testScopeSection || undefined,
      requiredReadingSection,
      salvageSection
    );

    if (isRetry) {
      const partialArtifacts = validateStepOutputs(step, projectPath);
      context += buildRetryContext(
        attempt,
        MAX_RETRY_ATTEMPTS,
        stepState.failures,
        partialArtifacts,
        projectPath
      );
    }

    // On final deterministic attempt, try scope narrowing before normal retry
    if (attempt === MAX_RETRY_ATTEMPTS && isNarrowable(step.role)) {
      const subTasks = decomposeTask(step.role, step, featureSlug, projectPath, taskDesc);
      if (subTasks.length > 1) {
        const stepTimeout = resolveStepTimeout(step.name, timeoutConfig);
        const narrowResult = await executeNarrowedRetry(
          subTasks, step.role, systemPrompt, context, projectPath, stepTimeout
        );

        if (narrowResult.completedIds.length === narrowResult.subTasks.length) {
          const artifacts =
            step.expectedOutputs.length > 0 ? validateStepOutputs(step, projectPath) : [];
          return { kind: "complete", artifacts };
        }

        // Partial or full failure — record (flagged narrowed for the CB-1
        // boundary rule) and run the pipeline
        const decision = processFailureAndDecide(
          step,
          stepState,
          featureSlug,
          projectPath,
          `Narrowed retry (${narrowResult.strategy}): ${narrowResult.completedIds.length}/${subTasks.length} sub-tasks completed. Failed: ${narrowResult.failedIds.join(", ")}`,
          attempt,
          { narrowed: true }
        );
        saveSprintState(projectSlug, sprint, state);
        if (decision.kind === "salvage-complete") {
          return {
            kind: "complete",
            artifacts: validateStepOutputs(step, projectPath),
            via: "salvage",
          };
        }
        if (decision.kind === "escalate") break;
        if (decision.delayMs > 0) await sleep(decision.delayMs);
        continue;
      }
    }

    // Spawn subagent with step-aware timeout (CB-5: user config now reaches
    // the mechanism; the resolved value is the idle window — CB-3) and the
    // per-role model (Part 2: generator ≠ verifier — AC 9/10). Undefined model
    // ⇒ default `claude`, argv byte-identical to today.
    const stepTimeout = resolveStepTimeout(step.name, timeoutConfig);
    const result = await spawnAgent(
      step.role,
      systemPrompt,
      context,
      taskDesc,
      projectPath,
      stepTimeout,
      resolveRoleModel(step.role, config)
    );

    // [BLOCKER] — immediate escalation, handled ahead of the salvage/transient/
    // short-circuit pipeline (architecture: RetryDecision ordering note).
    // Recorded classified + signed like every other failure, mirroring the
    // single-feature loop.
    if (hasBlockerMarker(result.output)) {
      const blockerSummary = truncateErrorSummary(result.output);
      stepState.failures.push({
        attempt,
        errorSummary: blockerSummary,
        timestamp: new Date().toISOString(),
        hadPartialArtifacts: validateStepOutputs(step, projectPath).length > 0,
        classification: classifyFailure(blockerSummary),
        signature: deriveFailureSignature(blockerSummary),
      });
      return { kind: "blocker", output: result.output };
    }

    if (result.exitCode === 0) {
      const missingOutputs = validateRequiredOutputs(step, featureSlug, projectPath);
      if (missingOutputs.length > 0) {
        // Agent said it's done but didn't create required files — failure
        const decision = processFailureAndDecide(
          step,
          stepState,
          featureSlug,
          projectPath,
          `Agent completed (exit 0) but did not create required output files: ${missingOutputs.join(", ")}. The step is not complete until these files exist on disk.`,
          attempt
        );
        saveSprintState(projectSlug, sprint, state);
        if (decision.kind === "escalate") break;
        if (decision.kind === "retry" && decision.delayMs > 0) {
          await sleep(decision.delayMs);
        }
        continue; // Retry — the agent will see this failure in retry context
      }

      const artifacts =
        step.expectedOutputs.length > 0 ? validateStepOutputs(step, projectPath) : [];
      return { kind: "complete", artifacts };
    }

    // Record failure and run the CB-1/2/4 pipeline
    const decision = processFailureAndDecide(
      step,
      stepState,
      featureSlug,
      projectPath,
      result.output,
      attempt,
      { killKind: result.killKind }
    );
    saveSprintState(projectSlug, sprint, state);
    if (decision.kind === "salvage-complete") {
      // Sprint 11 case: agent finished its work, then died. Validated
      // deliverables are on disk — complete WITHOUT another attempt (AC 15).
      return {
        kind: "complete",
        artifacts: validateStepOutputs(step, projectPath),
        via: "salvage",
      };
    }
    if (decision.kind === "escalate") break;
    if (decision.delayMs > 0) await sleep(decision.delayMs);
  }

  // Escalated — reason recorded on stepState.escalationReason by the pipeline
  // (AC 4/7/22, no silent branches); caller persists status and commits the
  // [ESCALATE] marker.
  stepState.escalationReason = stepState.escalationReason ?? "attempts-exhausted";
  return {
    kind: "escalated",
    lastError: stepState.failures[stepState.failures.length - 1]?.errorSummary || "unknown",
  };
}

/**
 * Update a per-feature DoD checklist when a step completes (architecture §3).
 */
function updateDodForCompletedStep(dod: DodChecklist, stepName: string): void {
  if (stepName === "Open PR") {
    dod.codeCommitted = true;
  } else if (stepName === "Run test suite") {
    dod.testsPass = true;
  } else if (stepName === "Demo") {
    dod.demoCompleted = true;
  }
}

// ---------------------------------------------------------------------------
// Truthfulness guards (sprint-completes-despite-failed-merge, Sprint 13)
// Pure, exported helpers backing the C3 finalization guard (AC #4) and the
// C4 shared-step gate (AC #6). Guards report, never repair (constraint 4).
// ---------------------------------------------------------------------------

/**
 * C3 (AC #4): the finalization-guard predicate. `state.status = "complete"`
 * is reachable only when this returns []. Pure — never mutates.
 */
export function findIncompleteSteps(steps: StepState[]): StepState[] {
  return steps.filter((s) => s.status !== "complete");
}

/**
 * C3 (AC #4, NFR 6): guard-trip message — names every offending step by
 * number, name, and status, and points at the resume path.
 */
export function buildFinalizationGuardMessage(incomplete: StepState[]): string {
  const list = incomplete
    .map((s) => `${s.step} (${s.name}, ${s.status})`)
    .join(", ");
  return `Sprint NOT complete: step(s) ${list} did not finish. Resume with resume_sprint.`;
}

/**
 * C4 (AC #6): the shared-step-gate predicate. Shared steps 10–13 may begin
 * only when this returns [] — every feature terminal ("complete" or
 * "escalated") at its per-feature step 9. Pure — never mutates.
 */
export function findNonTerminalFeatures(features: FeatureState[]): FeatureState[] {
  return features.filter(
    (f) => f.status !== "complete" && f.status !== "escalated"
  );
}

/**
 * C4 (AC #6, NFR 6): gate-trip message — names every non-terminal feature
 * and the step-9 boundary, and points at the resume path.
 */
export function buildSharedStepGateMessage(nonTerminal: FeatureState[]): string {
  const slugs = nonTerminal.map((f) => f.slug).join(", ");
  return `Shared steps blocked: feature(s) ${slugs} not terminal at step 9. Resume with resume_sprint.`;
}

/**
 * Multi-feature dispatcher: iterates state.features for steps 1–9 and runs
 * shared steps 10–13 once on top-level state.steps. Implements AC #3, #5, #6,
 * #7, #8, #9, #12, #13.
 */
async function runMultiFeatureSprint(ctx: DispatchContext): Promise<SprintResult> {
  const { projectPath, projectSlug, sprint, state, fromStep, feedback, git, dinoNames, sprintSummaries } = ctx;

  if (!state.features || state.features.length === 0) {
    // Should never happen — caller is responsible for seeding. Defensive return.
    return {
      status: "error",
      progress: renderProgressTable(state),
      message: "Multi-feature dispatcher invoked without state.features",
      state,
    };
  }

  // AC #7: when resuming with feedback, the affected feature was recorded in
  // state.currentFeatureSlug by resumeSprint (escalated request-changes) or by
  // the streaming-checkpoint resume. Capture it BEFORE the loop overwrites
  // currentFeatureSlug so feedback is injected into the RESUMED feature's first
  // dispatched step — not blindly into feature index 0, which may be a
  // completed sibling that gets skipped.
  const resumedFeatureSlug = feedback ? state.currentFeatureSlug ?? null : null;

  for (let i = fromStep - 1; i < SPRINT_WORKFLOW.length; i++) {
    const step = SPRINT_WORKFLOW[i];
    const isPerFeatureStep = step.step <= 9;

    if (isPerFeatureStep) {
      // Per-feature dispatch (AC #3). Per-feature escalation/failure is recorded
      // directly on feature.status; the loop-exit guard below consults the pure
      // deriveSprintStatus reducer rather than a local flag (AC #2, #10).
      for (let fIdx = 0; fIdx < state.features.length; fIdx++) {
        const feature = state.features[fIdx];

        // Skip features that are entirely complete or whose step is complete
        // (AC #12 resume safety + Edge: already-checked items).
        if (feature.status === "complete" || feature.status === "failed" || feature.status === "escalated") {
          if (feature.status !== "escalated") continue;
          // for escalated features, also skip — they don't continue
          continue;
        }
        const featureStepState = feature.steps.find((s) => s.step === step.step);
        if (!featureStepState) continue; // shouldn't happen
        if (featureStepState.status === "complete") continue;

        // Track which feature is currently being dispatched (drives streaming
        // checkpoint resume — architecture §6, §8).
        state.currentFeatureSlug = feature.slug;
        state.currentStep = step.step;
        state.status = "in-progress";
        feature.status = "in-progress";
        featureStepState.status = "in-progress";
        saveSprintState(projectSlug, sprint, state);

        // AC #4 + bundled sprint-branch-auto-create: ensure the feature's
        // branch is checked out before any commit-producing work.
        const branchResult = await ensureFeatureBranch(projectPath, sprint, feature.slug);
        if (branchResult.error) {
          // Failure isolation (AC #7): mark feature failed, continue with the rest
          featureStepState.status = "failed";
          featureStepState.failures.push({
            attempt: featureStepState.attempts,
            errorSummary: branchResult.error,
            timestamp: new Date().toISOString(),
            hadPartialArtifacts: false,
          });
          feature.status = "failed";
          saveSprintState(projectSlug, sprint, state);
          continue;
        }
        feature.branchName = featureBranchName(sprint, feature.slug);

        // Special handling for the Merge PR step: no agent, runs executeMerge.
        // C2 (AC #5, #8): consume the outcome the pre-fix dispatcher
        // discarded. On "retry", re-execute THIS feature's merge in place
        // instead of advancing with its step 9 left in-progress. Termination
        // inherited from runMergeStepForFeature: it increments attempts on
        // every failure and returns "escalated" at the cap, so "retry" occurs
        // at most MAX_RETRY_ATTEMPTS - 1 times per feature. Sibling isolation
        // (AC #8) is structural: this loop closes over one feature/stepState
        // pair. Do not add outcome variants without updating this loop
        // (architecture API contract).
        if (step.name === "Merge PR") {
          let outcome: "complete" | "escalated" | "retry";
          do {
            outcome = await runMergeStepForFeature(feature, featureStepState, ctx);
          } while (outcome === "retry");
          // "complete" and "escalated" both proceed to the next feature —
          // existing park semantics (deriveSprintStatus below) unchanged.
          continue;
        }

        // AC #7: inject feedback into the resumed feature's first dispatched
        // step. When resuming a specific feature, target it by slug (it may not
        // be index 0); otherwise fall back to the first feature of this step.
        const isFirstStepOfThisInvocation =
          i === fromStep - 1 &&
          (resumedFeatureSlug ? feature.slug === resumedFeatureSlug : fIdx === 0);
        const outcome = await runAgentStepCycle(
          step,
          featureStepState,
          feature.slug,
          ctx,
          true, // isMultiFeature
          isFirstStepOfThisInvocation
        );

        if (outcome.kind === "blocker") {
          featureStepState.status = "escalated";
          feature.status = "escalated";
          saveSprintState(projectSlug, sprint, state);
          try {
            await git.commit(
              `[ESCALATE] ${formatHandoffRole(step.role, dinoNames)}: step ${step.step} (${step.name}) for ${feature.slug} — agent raised [BLOCKER]: ${truncateErrorSummary(outcome.output)}`,
              { "--allow-empty": null }
            );
          } catch { /* non-critical */ }
          continue;
        }

        if (outcome.kind === "escalated") {
          featureStepState.status = "escalated";
          feature.status = "escalated";
          saveSprintState(projectSlug, sprint, state);
          try {
            const summary = featureStepState.failures
              .map((f) => `Attempt ${f.attempt}: ${f.errorSummary}`)
              .join("; ");
            await git.commit(
              `[ESCALATE] ${formatHandoffRole(step.role, dinoNames)}: step ${step.step} (${step.name}) for ${feature.slug} failed ${featureStepState.attempts} times — requesting user intervention.\nSummary: ${summary}`,
              { "--allow-empty": null }
            );
          } catch { /* non-critical */ }
          continue;
        }

        // outcome.kind === "complete"
        featureStepState.artifacts = outcome.artifacts;
        featureStepState.status = "complete";
        featureStepState.completedAt = new Date().toISOString();
        updateDodForCompletedStep(feature.dod, step.name);
        feature.currentStep = step.step + 1;
        saveSprintState(projectSlug, sprint, state);

        // Per-feature handoff commit
        const handoff = HANDOFF_MAP[step.step];
        if (handoff && step.step < 10) {
          try {
            await git.commit(
              `[HANDOFF] ${formatHandoffRole(handoff.from, dinoNames)} -> ${formatHandoffRole(handoff.to, dinoNames)}: ${handoff.artifact} for ${feature.slug}`,
              { "--allow-empty": null }
            );
          } catch { /* non-critical */ }
        }

        // AC #13: Streaming checkpoints. If this step has a checkpointAfter,
        // pause and return a feature-annotated checkpoint. Resume will pick up
        // the next un-completed feature for the same step.
        if (step.checkpointAfter) {
          state.status = "paused";
          state.checkpoints.push({
            type: step.checkpointAfter,
            status: "pending",
            feedback: null,
            resolvedAt: null,
            feature: feature.slug,
          });
          saveSprintState(projectSlug, sprint, state);

          const artifactSummary = buildStepContext(step.step, projectPath, feature.slug);
          const checkpoint = buildCheckpointPrompt(
            step.checkpointAfter,
            artifactSummary.slice(0, 5000),
            dinoNames,
            feature.slug
          );
          return {
            status: "checkpoint",
            progress: renderProgressTable(state),
            checkpoint,
            state,
          };
        }
      }

      // After all features dispatched for this step, consult the pure reducer.
      // AC #2 + #10: with terminal-step completion now marking features
      // "complete" (AC #1), a mixed sprint (>=1 complete, >=1 escalated, none
      // in-progress) reduces to "escalated" and we PARK here — we do NOT
      // silently advance to shared steps 10-13. A "failed" feature parks too
      // (no regression to existing failure-isolation behavior). The sprint
      // stays "in-progress" only while some feature is still non-terminal.
      const sprintStatus = deriveSprintStatus(state.features);
      if (sprintStatus === "escalated" || sprintStatus === "failed") {
        state.status = sprintStatus;
        saveSprintState(projectSlug, sprint, state);
        return {
          status: "escalated",
          progress: renderProgressTable(state),
          message: buildMultiFeatureEscalatedMessage(state, sprint),
          state,
        };
      }
      // Otherwise advance to next step
      continue;
    }

    // --- Sprint-shared step (10–13) — run once on top-level state.steps ---

    // C4 (AC #6): shared-step gate — defense in depth. Shared steps 10–13
    // must not begin while any feature's terminal per-feature step (step 9)
    // is neither "complete" nor "escalated". With C2 in place a feature can
    // only exit the step-9 dispatch terminal; this gate closes the remaining
    // in-progress-at-step-9 hole (deriveSprintStatus returns "in-progress"
    // for that mix and the loop would otherwise continue into shared steps —
    // the Sprint 9 unresumable limbo). Trips map to "escalated" (Open
    // Question 3 ruling — resumable). No [ESCALATE] commit (constraint 4).
    const nonTerminalFeatures = findNonTerminalFeatures(state.features);
    if (nonTerminalFeatures.length > 0) {
      state.status = "escalated";
      saveSprintState(projectSlug, sprint, state);
      return {
        status: "escalated",
        progress: renderProgressTable(state),
        message: buildSharedStepGateMessage(nonTerminalFeatures),
        state,
      };
    }

    const sharedStepState = state.steps[i];
    if (sharedStepState.status === "complete") continue;

    state.currentFeatureSlug = null;
    state.currentStep = step.step;
    state.status = "in-progress";
    sharedStepState.status = "in-progress";
    saveSprintState(projectSlug, sprint, state);

    // Reuse the same retro/feedback machinery as the single-feature path.
    // Pick a representative feature slug for the handoff commit message.
    const representativeSlug = state.features[0]?.slug || "sprint";

    if (step.name === "Collect retro proposals") {
      await runCollectRetroProposalsShared(ctx, sharedStepState, representativeSlug);
      continue;
    }

    if (step.name === "Apply retro improvements") {
      await runApplyRetroImprovementsShared(ctx, sharedStepState);
      continue;
    }

    // Process feedback (step 10) and Review retro proposals (step 12) — run
    // through the standard agent cycle on top-level state. featureSlug is
    // representative (for prompt substitution).
    if (step.name === "Review retro proposals") {
      // Step 12 has a checkpoint but no agent body — pause for user.
      sharedStepState.status = "complete";
      sharedStepState.completedAt = new Date().toISOString();
      sharedStepState.attempts = 1;
      state.status = "paused";
      state.checkpoints.push({
        type: "retro-review",
        status: "pending",
        feedback: null,
        resolvedAt: null,
        feature: null,
      });
      saveSprintState(projectSlug, sprint, state);

      const proposals = (state.retroProposals ?? []) as RetroProposal[];
      const summary = proposals.length > 0
        ? proposals.map((p, idx) => `${idx + 1}. ${p.role.toUpperCase()}: ${p.proposal}`).join("\n")
        : "No retro proposals.";
      const checkpoint = buildCheckpointPrompt("retro-review", summary, dinoNames);
      return {
        status: "checkpoint",
        progress: renderProgressTable(state),
        checkpoint,
        state,
      };
    }

    // Default: run agent on top-level state for this shared step.
    const isFirstStepOfThisInvocation = i === fromStep - 1;
    const outcome = await runAgentStepCycle(
      step,
      sharedStepState,
      representativeSlug,
      ctx,
      true,
      isFirstStepOfThisInvocation
    );

    if (outcome.kind === "blocker" || outcome.kind === "escalated") {
      sharedStepState.status = "escalated";
      state.status = "escalated";
      saveSprintState(projectSlug, sprint, state);
      return {
        status: "escalated",
        progress: renderProgressTable(state),
        message: `Shared step ${step.step} (${step.name}) failed.`,
        state,
      };
    }

    sharedStepState.artifacts = outcome.artifacts;
    sharedStepState.status = "complete";
    sharedStepState.completedAt = new Date().toISOString();
    saveSprintState(projectSlug, sprint, state);
  }

  // --- All steps complete — sprint summary + finalize ---
  try {
    const summary = generateSprintSummary(projectPath, projectSlug, sprint, state);
    const sprintsDir = path.join(projectPath, "docs", "sprints");
    fs.mkdirSync(sprintsDir, { recursive: true });
    const summaryPath = path.join(sprintsDir, `sprint-${sprint}-summary.md`);
    fs.writeFileSync(summaryPath, summary);
    try {
      await git.add(summaryPath);
      await git.commit(`[PO] add: sprint ${sprint} summary for cross-sprint context`);
    } catch { /* non-critical */ }
  } catch { /* best-effort */ }

  state.status = allFeaturesComplete(state.features) ? "complete" : deriveSprintStatus(state.features);
  saveSprintState(projectSlug, sprint, state);

  return {
    status: state.status === "complete" ? "complete" : "escalated",
    progress: renderProgressTable(state),
    message: state.status === "complete"
      ? appendRetroApplyQualification(
          "Sprint complete! All features finished successfully.",
          state
        )
      : `Sprint finished in '${state.status}' status — see per-feature breakdown.`,
    state,
  };
}

/**
 * Run the Merge PR step for a single feature (multi-feature mode).
 */
async function runMergeStepForFeature(
  feature: FeatureState,
  stepState: StepState,
  ctx: DispatchContext
): Promise<"complete" | "escalated" | "retry"> {
  const { projectPath, projectSlug, sprint, state, git, dinoNames } = ctx;

  try {
    await updatePrDodChecklist(projectPath, feature.dod);
  } catch { /* best-effort */ }

  const branchName = feature.branchName;
  if (!branchName) {
    stepState.status = "failed";
    feature.status = "failed";
    saveSprintState(projectSlug, sprint, state);
    return "escalated";
  }

  const mergeResult = await executeMerge(projectPath, feature.slug, sprint, branchName);

  if (!mergeResult.success) {
    // C5 (additive): classification + signature persisted for post-mortems —
    // retry behavior unchanged (architecture constraint 6).
    const errorSummary = truncateErrorSummary(mergeResult.error || "Merge failed");
    stepState.attempts++;
    stepState.failures.push({
      attempt: stepState.attempts,
      errorSummary,
      timestamp: new Date().toISOString(),
      hadPartialArtifacts: false,
      classification: classifyFailure(errorSummary),
      signature: deriveFailureSignature(errorSummary),
    });

    if (stepState.attempts >= MAX_RETRY_ATTEMPTS) {
      stepState.status = "escalated";
      feature.status = "escalated";
      saveSprintState(projectSlug, sprint, state);
      try {
        const summary = stepState.failures.map((f) => `Attempt ${f.attempt}: ${f.errorSummary}`).join("; ");
        await git.commit(
          `[ESCALATE] ${formatHandoffRole("engineer", dinoNames)}: step 9 (Merge PR) for ${feature.slug} failed ${stepState.attempts} times — requesting user intervention.\nSummary: ${summary}`,
          { "--allow-empty": null }
        );
      } catch { /* non-critical */ }
      return "escalated";
    }
    saveSprintState(projectSlug, sprint, state);
    return "retry";
  }

  stepState.attempts++;
  stepState.status = "complete";
  stepState.completedAt = new Date().toISOString();
  // AC #1: the terminal per-feature step (Merge PR, step 9) marks the FEATURE
  // complete and advances currentStep past the terminal step, alongside the
  // existing step transition. This is the single missing transition that
  // previously left mixed sprints reading as "in-progress" (and therefore
  // unrecoverable). Non-terminal steps only bump currentStep; only the merge
  // flips feature.status to "complete".
  feature.status = "complete";
  feature.currentStep = stepState.step + 1;
  saveSprintState(projectSlug, sprint, state);

  const handoff = HANDOFF_MAP[9];
  if (handoff) {
    try {
      await git.commit(
        `[HANDOFF] ${formatHandoffRole(handoff.from, dinoNames)} -> ${formatHandoffRole(handoff.to, dinoNames)}: ${handoff.artifact} for ${feature.slug}`,
        { "--allow-empty": null }
      );
    } catch { /* non-critical */ }
  }
  return "complete";
}

/**
 * Shared "Collect retro proposals" body (step 11 — runs once per sprint).
 */
async function runCollectRetroProposalsShared(
  ctx: DispatchContext,
  stepState: StepState,
  representativeSlug: string
): Promise<void> {
  const { projectPath, projectSlug, sprint, state, git, dinoNames } = ctx;

  const teamMdPath = path.join(projectPath, "TEAM.md");
  const teamMd = fs.existsSync(teamMdPath) ? fs.readFileSync(teamMdPath, "utf-8") : "";
  const sprintContext = buildSprintContextForRetro(state);
  const roles: Role[] = ["po", "architect", "qa", "engineer"];
  const proposals: (RetroProposal | null)[] = [];

  for (const role of roles) {
    const retroPrompt = buildRetroPrompt(role, teamMd, sprintContext);
    try {
      const result = await spawnAgent(
        role,
        retroPrompt,
        "",
        "Propose one improvement to TEAM.md based on your sprint experience.",
        projectPath
      );
      const proposal = parseRetroProposal(role, result.output);
      proposals.push(proposal);
    } catch {
      proposals.push(null);
    }
  }

  const retroDoc = generateRetroDocument(projectSlug, sprint, proposals, roles);
  const sprintsDir = path.join(projectPath, "docs", "sprints");
  fs.mkdirSync(sprintsDir, { recursive: true });
  const retroPath = path.join(sprintsDir, `sprint-${sprint}-retro.md`);
  fs.writeFileSync(retroPath, retroDoc);

  state.retroProposals = proposals.filter((p): p is RetroProposal => p !== null);

  try {
    await git.add(retroPath);
    await git.commit(`[PO] add: sprint ${sprint} retrospective proposals`);
  } catch { /* non-critical */ }

  stepState.attempts = 1;
  stepState.status = "complete";
  stepState.completedAt = new Date().toISOString();
  saveSprintState(projectSlug, sprint, state);

  const handoff = HANDOFF_MAP[11];
  if (handoff) {
    try {
      await git.commit(
        `[HANDOFF] ${formatHandoffRole(handoff.from, dinoNames)} -> ${formatHandoffRole(handoff.to, dinoNames)}: ${handoff.artifact} for ${representativeSlug}`,
        { "--allow-empty": null }
      );
    } catch { /* non-critical */ }
  }
}

/**
 * Shared "Apply retro improvements" body (step 13 — runs once per sprint).
 * Thin wrapper around executeRetroApply — parity with the single-feature
 * path is structural (AC 6: one implementation, two seams).
 */
async function runApplyRetroImprovementsShared(
  ctx: DispatchContext,
  stepState: StepState
): Promise<void> {
  const { projectPath, projectSlug, sprint, state, git } = ctx;

  const report = await executeRetroApply(projectPath, sprint, state, git);
  persistRetroApplyReport(state, report);

  stepState.attempts = 1;
  stepState.status = "complete";
  stepState.completedAt = new Date().toISOString();
  // Persist-before-yield: report lands in state before the step reads as
  // complete anywhere.
  saveSprintState(projectSlug, sprint, state);
}

// ─── Shared step-13 executor (Sprint 13: retro-improvements-not-applied) ───

/**
 * Per-proposal apply report for step 13 (AC 1/AC 4 accounting).
 */
export interface RetroApplyReport {
  applied: number;
  fallback: number;
  alreadyPresent: number;
  unplaced: number;
  outcomes: ProposalOutcome[];
  /** true when selection was skip/empty/no valid indices (AC 7) */
  skipped: boolean;
  /** AC 8: a caught apply-commit failure, surfaced instead of swallowed */
  commitError?: string;
}

/**
 * The single shared step-13 executor. Both runner paths (single-feature
 * inline block and runApplyRetroImprovementsShared) are thin wrappers around
 * this — parity (AC 6) is structural. QA still asserts both production seams
 * independently; a future refactor that forks the paths again must fail
 * those tests.
 *
 * Never throws (errors-returned-not-thrown convention): I/O failures
 * degrade to synthesized "unplaced" outcomes so the outcome-total invariant
 * (outcomes.length === selectedProposals.length) holds on EVERY path (AC 1).
 * Does not persist state — callers own saveSprintState.
 */
export async function executeRetroApply(
  projectPath: string,
  sprint: number,
  state: SprintState,
  git: SimpleGit
): Promise<RetroApplyReport> {
  const retroFeedback = state.checkpoints.find(
    (c) => c.type === "retro-review" && (c.status === "approved" || c.status === "changes-requested")
  );
  const retroProposals = (state.retroProposals ?? []) as RetroProposal[];
  const selectedIndices = parseRetroSelection(
    retroFeedback?.feedback,
    retroProposals.length
  );
  const selectedProposals = selectedIndices
    .map((i) => retroProposals[i - 1])
    .filter((p): p is RetroProposal => p !== undefined);

  const report: RetroApplyReport = {
    applied: 0,
    fallback: 0,
    alreadyPresent: 0,
    unplaced: 0,
    outcomes: [],
    skipped: false,
  };

  // AC 7 (frozen skip path): skip/empty/out-of-range selection → no TEAM.md
  // read, no fallback writes, no new warnings. The retro-doc decisions
  // update still runs (pre-existing behavior, unchanged).
  if (selectedProposals.length === 0) {
    report.skipped = true;
    await updateRetroDocBestEffort(
      projectPath,
      sprint,
      git,
      selectedIndices,
      retroProposals.length,
      null
    );
    return report;
  }

  const teamMdPath = path.join(projectPath, "TEAM.md");
  let outcomes: ProposalOutcome[];

  try {
    const teamMd = fs.readFileSync(teamMdPath, "utf-8");
    const result = applyImprovements(teamMd, selectedProposals, sprint);
    outcomes = result.outcomes;

    if (!result.changed) {
      // AC 5 change verification: byte-identical content while the function
      // CLAIMS placement is the defect signal — downgrade those outcomes to
      // "unplaced" and surface it (never swallow). All-"already-present"
      // with changed === false is the legitimate re-run case, untouched.
      for (const o of outcomes) {
        if (o.placement === "applied" || o.placement === "applied-fallback") {
          o.placement = "unplaced";
          o.placedAt = undefined;
          o.reason = "apply reported success but content unchanged";
        }
      }
    } else {
      fs.writeFileSync(teamMdPath, result.content);
      // AC 8: commit only on change; a caught failure is surfaced in the
      // report (the old `/* non-critical */` silent absorb is gone), but
      // never corrupts step flow.
      try {
        await git.add(teamMdPath);
        await git.commit(
          `[PO] update: apply retrospective improvements from sprint ${sprint}`
        );
      } catch (err) {
        report.commitError = truncateErrorSummary(
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  } catch (err) {
    // TEAM.md read/write failure → synthesize one "unplaced" outcome per
    // selected proposal with the I/O error as reason (AC 1 invariant on the
    // failure path). No throw — step completes qualified; circuit breaker
    // untouched (Out of Scope).
    const reason = truncateErrorSummary(
      err instanceof Error ? err.message : String(err)
    );
    outcomes = selectedProposals.map((p) => ({
      role: p.role,
      section: p.section,
      placement: "unplaced" as const,
      reason,
    }));
  }

  for (const o of outcomes) {
    if (o.placement === "applied") report.applied++;
    else if (o.placement === "applied-fallback") report.fallback++;
    else if (o.placement === "already-present") report.alreadyPresent++;
    else report.unplaced++;
  }
  report.outcomes = outcomes;

  // AC 3: record decisions + per-proposal placement outcomes in the retro
  // doc. Best-effort — a missing doc degrades gracefully and never blocks
  // ACs 1/2/4.
  await updateRetroDocBestEffort(
    projectPath,
    sprint,
    git,
    selectedIndices,
    retroProposals.length,
    outcomes
  );

  return report;
}

/**
 * Update the sprint retro document with user decisions and (when proposals
 * were adopted) per-proposal placement outcomes (AC 3). Best-effort: a
 * missing or unwritable doc is skipped silently (Edge: graceful
 * degradation); the doc commit failure remains non-critical.
 */
async function updateRetroDocBestEffort(
  projectPath: string,
  sprint: number,
  git: SimpleGit,
  selectedIndices: number[],
  totalProposals: number,
  outcomes: ProposalOutcome[] | null
): Promise<void> {
  const retroPath = path.join(projectPath, "docs", "sprints", `sprint-${sprint}-retro.md`);
  try {
    if (!fs.existsSync(retroPath)) return;
    let retroDoc = fs.readFileSync(retroPath, "utf-8");
    retroDoc = updateRetroDocWithDecisions(retroDoc, selectedIndices, totalProposals);
    if (outcomes && outcomes.length > 0) {
      retroDoc = updateRetroDocWithAppliedChanges(retroDoc, outcomes);
    }
    fs.writeFileSync(retroPath, retroDoc);
    try {
      await git.add(retroPath);
      await git.commit(`[PO] update: sprint ${sprint} retro decisions recorded`);
    } catch { /* non-critical — doc reporting is best-effort */ }
  } catch { /* best-effort (AC 3 graceful degradation) */ }
}

/**
 * Persist the step-13 report into sprint state (Data Model: additive
 * optional field). A skipped selection leaves state untouched — absent
 * retroApply renders no qualification line (AC 7).
 */
function persistRetroApplyReport(state: SprintState, report: RetroApplyReport): void {
  if (report.skipped) return;
  state.retroApply = {
    applied: report.applied,
    fallback: report.fallback,
    alreadyPresent: report.alreadyPresent,
    unplaced: report.unplaced,
    outcomes: report.outcomes,
    ...(report.commitError ? { commitError: report.commitError } : {}),
  };
}

/**
 * AC 4 (qualified completion): append the retro-apply accounting to the
 * caller-visible sprint result whenever proposals were adopted. An
 * unqualified message is only possible when retroApply is absent (skip) —
 * and even an all-"applied" run states its counts.
 */
function appendRetroApplyQualification(base: string, state: SprintState): string {
  const r = state.retroApply;
  if (!r) return base;

  let msg =
    `${base} Retro improvements: ${r.applied} applied, ${r.fallback} at fallback, ` +
    `${r.alreadyPresent} already present, ${r.unplaced} NOT applied.`;

  if (r.fallback + r.unplaced > 0) {
    const details = r.outcomes
      .filter((o) => o.placement === "applied-fallback" || o.placement === "unplaced")
      .map((o) =>
        o.placement === "applied-fallback"
          ? `\n- ${o.role.toUpperCase()} proposal → fallback ("Adopted Retro Improvements (Unplaced)"); target "${o.section}" not found`
          : `\n- ${o.role.toUpperCase()} proposal → NOT APPLIED: ${o.reason ?? "unknown reason"}`
      )
      .join("");
    msg += details;
  }

  if (r.commitError) {
    msg += `\nWarning: TEAM.md apply commit failed: ${r.commitError}`;
  }

  return msg;
}
