import * as fs from "fs";
import * as path from "path";
import simpleGit from "simple-git";
import {
  SprintState,
  FeatureState,
  StepState,
  DodChecklist,
  loadSprintState,
  saveSprintState,
} from "./state";
import { SPRINT_WORKFLOW } from "./workflow";
import { StepStatus } from "./workflow";
import { resolveBacklogPath } from "../backlog-parser";

/**
 * Detect multiple features from the sprint section of backlog.md.
 * Returns an array of feature slugs, or a single-element array for single-feature mode.
 */
export function detectSprintFeatures(projectPath: string, sprint: number): string[] {
  const backlogPath = resolveBacklogPath(projectPath);
  if (!backlogPath) return [];

  const content = fs.readFileSync(backlogPath, "utf-8");
  const sprintMatch = content.match(
    new RegExp(`## Sprint ${sprint}[^]*?(?=\\n## |$)`)
  );
  if (!sprintMatch) return [];

  const features: string[] = [];
  const itemPattern = /- \[[ x]\]\s+([a-z][a-z0-9-]*):/g;
  let match;
  while ((match = itemPattern.exec(sprintMatch[0])) !== null) {
    features.push(match[1]);
  }

  return features;
}

/**
 * Check if a sprint should use multi-feature mode.
 */
export function isMultiFeatureSprint(features: string[]): boolean {
  return features.length > 1;
}

/**
 * Create initial FeatureState entries for a multi-feature sprint.
 */
export function createFeatureStates(
  features: string[],
  sprint: number
): FeatureState[] {
  // Per-feature steps: only steps 1-9 (spec through merge) are per-feature
  // Steps 10-13 (feedback, retro) run once per sprint
  const perFeatureSteps = SPRINT_WORKFLOW.filter((s) => s.step <= 9);

  return features.map((slug) => ({
    slug,
    branchName: `sprint-${sprint}/${slug}`,
    status: "pending" as const,
    currentStep: 1,
    steps: perFeatureSteps.map((s) => ({
      step: s.step,
      role: s.role,
      name: s.name,
      status: "pending" as StepStatus,
      artifacts: [],
      completedAt: null,
      attempts: 0,
      failures: [],
    })),
    dod: {
      codeCommitted: false,
      testsPass: false,
      prReviewApproved: false,
      poAccepted: false,
      demoCompleted: false,
    },
  }));
}

/**
 * Generate a branch name for a feature within a sprint.
 */
export function featureBranchName(sprint: number, featureSlug: string): string {
  return `sprint-${sprint}/${featureSlug}`;
}

/**
 * Check if all features in a multi-feature sprint are complete.
 */
export function allFeaturesComplete(features: FeatureState[]): boolean {
  return features.every((f) => f.status === "complete");
}

/**
 * Check if any features are escalated.
 */
export function anyFeaturesEscalated(features: FeatureState[]): boolean {
  return features.some((f) => f.status === "escalated");
}

/**
 * Determine overall sprint status from feature states.
 */
export function deriveSprintStatus(
  features: FeatureState[]
): "in-progress" | "complete" | "escalated" | "failed" {
  if (allFeaturesComplete(features)) return "complete";
  if (features.some((f) => f.status === "failed")) return "failed";
  if (anyFeaturesEscalated(features) && features.every((f) => f.status === "complete" || f.status === "escalated")) {
    return "escalated";
  }
  return "in-progress";
}

/**
 * Ensure the working tree is on the feature's sprint branch.
 *
 * Behavior (per architecture §4):
 *   1. Compute branchName via featureBranchName(sprint, slug).
 *   2. If we are already on that branch → no-op, return { created: false, checkedOut: false }.
 *   3. Else if the branch exists locally → check it out, return { created: false, checkedOut: true }.
 *      If checkout fails (typically uncommitted changes that would be overwritten by
 *      switching), surface a clear error and do NOT auto-resolve.
 *   4. Else create the branch from current HEAD (effectively `git checkout -b`),
 *      return { created: true, checkedOut: true }.
 *
 * Idempotent: safe to call before every per-feature step. Errors are returned,
 * not thrown — callers convert them into per-feature `failed` outcomes so other
 * features in the sprint continue to dispatch (failure isolation, AC #7).
 *
 * Also bundled-fixes the single-feature `sprint-branch-auto-create` regression:
 * single-feature dispatch calls this once at the top of runSprintFromStep so the
 * runner stops recording whatever branch HEAD happened to point to.
 */
export async function ensureFeatureBranch(
  projectPath: string,
  sprint: number,
  featureSlug: string
): Promise<{ created: boolean; checkedOut: boolean; error?: string }> {
  const branchName = featureBranchName(sprint, featureSlug);
  const git = simpleGit(projectPath);

  let branches;
  try {
    branches = await git.branchLocal();
  } catch (err) {
    return {
      created: false,
      checkedOut: false,
      error: `Failed to inspect local branches in '${projectPath}': ${(err as Error).message}`,
    };
  }

  let currentHead: string | null = null;
  try {
    currentHead = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  } catch {
    // Detached HEAD or empty repo — fall through; create-from-HEAD path handles
    // the branchless case below.
  }

  const exists = branches.all.includes(branchName);

  if (exists) {
    if (currentHead === branchName) {
      return { created: false, checkedOut: false };
    }
    try {
      await git.checkout(branchName);
      return { created: false, checkedOut: true };
    } catch (err) {
      // Most common cause: working tree has uncommitted changes that would be
      // overwritten by checkout. Surface it cleanly so the dispatcher converts
      // the error into a per-feature failed outcome (architecture §4 + AC #4).
      const msg = (err as Error).message || "checkout failed";
      return {
        created: false,
        checkedOut: false,
        error: `Branch '${branchName}' exists with divergent state; resolve manually. (${msg})`,
      };
    }
  }

  // Branch does not exist — create it from current HEAD.
  try {
    await git.checkoutLocalBranch(branchName);
    return { created: true, checkedOut: true };
  } catch (err) {
    const msg = (err as Error).message || "branch creation failed";
    return {
      created: false,
      checkedOut: false,
      error: `Failed to create branch '${branchName}': ${msg}`,
    };
  }
}
