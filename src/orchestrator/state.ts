import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CheckpointType, StepStatus } from "./workflow";

export interface FailureRecord {
  attempt: number;
  errorSummary: string;
  timestamp: string;
  hadPartialArtifacts: boolean;
}

export interface StepState {
  step: number;
  role: string;
  name: string;
  status: StepStatus;
  artifacts: string[];
  completedAt: string | null;
  attempts: number;
  failures: FailureRecord[];
}

export interface CheckpointState {
  type: CheckpointType;
  status: "pending" | "approved" | "changes-requested";
  feedback: string | null;
  resolvedAt: string | null;
}

export interface DodChecklist {
  codeCommitted: boolean;
  testsPass: boolean;
  prReviewApproved: boolean;
  poAccepted: boolean;
  demoCompleted: boolean;
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
    for (const step of state.steps) {
      step.attempts = step.attempts ?? 0;
      step.failures = step.failures ?? [];
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
