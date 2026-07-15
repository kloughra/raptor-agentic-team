import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CheckpointType, StepStatus } from "./workflow";

export interface FailureRecord {
  attempt: number;
  errorSummary: string;
  timestamp: string;
  hadPartialArtifacts: boolean;
  /**
   * CB-2 (Sprint 12): recorded at write time. Absent (older sprints) reads
   * as "deterministic" via the `??` convention (AC 9) — no loadSprintState
   * defaulting (architecture constraint 5).
   *
   * Sprint 15 (user-actionable-failure-class): third member added additively.
   * Old records without a classification still read as "deterministic".
   */
  classification?: "transient" | "deterministic" | "user-actionable";
  /**
   * CB-1 (Sprint 12): deterministic signature persisted at record time.
   * An old record without a signature never matches anything (constraint 4).
   */
  signature?: string;
  /** CB-3 (Sprint 12): which kill path produced this failure, if any. */
  killKind?: "idle" | "ceiling" | "buffer-overflow";
  /** True if recorded by a scope-narrowed attempt (CB-1 boundary rule). */
  narrowed?: boolean;
  /** CB-4 (Sprint 12): expectedOutputs patterns already satisfied when recorded. */
  salvagedPatterns?: string[];
}

export interface StepState {
  step: number;
  role: string;
  name: string;
  status: StepStatus;
  artifacts: string[];
  completedAt: string | null;
  /** Deterministic attempts consumed — meaning FROZEN (architecture constraint 3). */
  attempts: number;
  failures: FailureRecord[];
  /** CB-4 (Sprint 12): absent ⇒ "agent" (AC 15). */
  completedVia?: "agent" | "salvage";
  /**
   * CB-1/CB-2 (Sprint 12): why the step escalated (AC 4, AC 7).
   * Sprint 15 (user-actionable-failure-class): "user-actionable" added
   * additively for escalate-now failures whose blocker is outside the sprint.
   */
  escalationReason?:
    | "attempts-exhausted"
    | "no-progress"
    | "transient-cap"
    | "user-actionable";
  /**
   * branch-protection-merge-lockout (Sprint 18): the actionable, PR-naming
   * escalation message persisted at record time so notification-egress — which
   * derives its payload EXCLUSIVELY from persisted state — can surface the
   * concrete human action (AC 5/6). Additive & optional: older sprint-N.json
   * files without it read as `undefined` and render exactly as before.
   */
  escalationDetail?: string;
}

export interface CheckpointState {
  type: CheckpointType;
  status: "pending" | "approved" | "changes-requested";
  feedback: string | null;
  resolvedAt: string | null;
  /**
   * Multi-feature mode only: which feature slug this checkpoint pertains to.
   * Single-feature mode leaves this null/undefined.
   */
  feature?: string | null;
}

export interface DodChecklist {
  codeCommitted: boolean;
  testsPass: boolean;
  prReviewApproved: boolean;
  poAccepted: boolean;
  demoCompleted: boolean;
}

export interface FeatureState {
  slug: string;
  branchName: string | null;
  status: "pending" | "in-progress" | "complete" | "failed" | "escalated";
  currentStep: number;
  steps: StepState[];
  dod: DodChecklist;
}

export interface SprintState {
  project: string;
  sprint: number;
  status: "in-progress" | "paused" | "complete" | "failed" | "escalated";
  currentStep: number;
  branchName: string | null;
  steps: StepState[];
  checkpoints: CheckpointState[];
  dod: DodChecklist;
  retroProposals: unknown[] | null;
  /**
   * Sprint 13 (retro-improvements-not-applied): per-proposal apply report
   * from step 13 — additive and optional (backward-compatible; pre-existing
   * state files load unchanged and absent retroApply renders no
   * qualification line). Stored on SprintState (not StepState) because step
   * 13 runs once per sprint in both dispatch modes and the report feeds the
   * sprint-level result message. Absent when the retro selection was
   * skip/empty/out-of-range (AC 7: skip behavior byte-identical to before).
   */
  retroApply?: {
    applied: number;
    fallback: number;
    alreadyPresent: number;
    unplaced: number;
    outcomes: Array<{
      role: string;
      section: string;
      placement: "applied" | "applied-fallback" | "already-present" | "unplaced";
      placedAt?: string;
      reason?: string;
    }>;
    /** AC 8: a caught apply-commit failure, surfaced instead of swallowed. */
    commitError?: string;
  };
  features?: FeatureState[] | null;
  /**
   * Multi-feature mode only: which feature is currently being dispatched.
   * Drives streaming-checkpoint resume (architecture §6, §8). Single-feature
   * sprints leave this null for the life of the state file.
   */
  currentFeatureSlug?: string | null;
  /**
   * notification-egress (Sprint 16): event keys already notified. Additive &
   * optional — absent in pre-feature state files (loadSprintState defaults to
   * []). Provides at-most-once dedup (AC #11) across runner re-entry. Contains
   * only eventKey strings — never a secret, never agent text. No migration.
   */
  notifiedEvents?: string[];
}

function resolveRaptorHome(): string {
  return path.join(os.homedir(), ".raptor");
}

function sprintStatePath(projectSlug: string, sprint: number): string {
  return path.join(
    resolveRaptorHome(),
    projectSlug,
    `sprint-${sprint}.json`
  );
}

export function loadSprintState(
  projectSlug: string,
  sprint: number
): SprintState | null {
  const filePath = sprintStatePath(projectSlug, sprint);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const state = JSON.parse(content) as SprintState;

    // Backward compatibility: default missing fields
    state.branchName = state.branchName ?? null;
    state.dod = state.dod ?? {
      codeCommitted: false,
      testsPass: false,
      prReviewApproved: false,
      poAccepted: false,
      demoCompleted: false,
    };
    state.retroProposals = state.retroProposals ?? null;
    state.features = state.features ?? null;
    state.currentFeatureSlug = state.currentFeatureSlug ?? null;
    state.notifiedEvents = state.notifiedEvents ?? [];
    for (const step of state.steps) {
      step.attempts = step.attempts ?? 0;
      step.failures = step.failures ?? [];
    }
    for (const cp of state.checkpoints) {
      cp.feature = cp.feature ?? null;
    }

    return state;
  } catch {
    return null;
  }
}

export function saveSprintState(
  projectSlug: string,
  sprint: number,
  state: SprintState
): void {
  const filePath = sprintStatePath(projectSlug, sprint);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

/**
 * Delete the persisted state file for a sprint, returning the sprint to its
 * pre-first-run condition (`reset_sprint`, Sprint 16). Keeps state-file path
 * resolution encapsulated in this module.
 *
 * @returns `true` if a state file existed and was removed, `false` if there was
 *   nothing to remove (idempotent no-op). Throws only on a genuine filesystem
 *   failure (e.g. EACCES/EPERM) — callers convert that into a `{status:"error"}`.
 */
export function deleteSprintState(projectSlug: string, sprint: number): boolean {
  const filePath = sprintStatePath(projectSlug, sprint);
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath);
  return true;
}

export function createInitialState(
  project: string,
  sprint: number,
  steps: { step: number; role: string; name: string }[],
  branchName?: string | null
): SprintState {
  return {
    project,
    sprint,
    status: "in-progress",
    currentStep: 1,
    branchName: branchName ?? null,
    dod: {
      codeCommitted: false,
      testsPass: false,
      prReviewApproved: false,
      poAccepted: false,
      demoCompleted: false,
    },
    retroProposals: null,
    features: null,
    currentFeatureSlug: null,
    steps: steps.map((s) => ({
      step: s.step,
      role: s.role,
      name: s.name,
      status: "pending" as StepStatus,
      artifacts: [],
      completedAt: null,
      attempts: 0,
      failures: [],
    })),
    checkpoints: [],
  };
}
