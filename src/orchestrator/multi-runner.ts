import * as fs from "fs";
import * as path from "path";
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

/**
 * Detect multiple features from the sprint section of backlog.md.
 * Returns an array of feature slugs, or a single-element array for single-feature mode.
 */
export function detectSprintFeatures(projectPath: string, sprint: number): string[] {
  const backlogPath = path.join(projectPath, "docs", "backlog.md");
  if (!fs.existsSync(backlogPath)) return [];

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
