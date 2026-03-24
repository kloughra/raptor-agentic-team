import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CheckpointType, StepStatus } from "./workflow";

export interface StepState {
  step: number;
  role: string;
  name: string;
  status: StepStatus;
  artifacts: string[];
  completedAt: string | null;
}

export interface CheckpointState {
  type: CheckpointType;
  status: "pending" | "approved" | "changes-requested";
  feedback: string | null;
  resolvedAt: string | null;
}

export interface SprintState {
  project: string;
  sprint: number;
  status: "in-progress" | "paused" | "complete" | "failed";
  currentStep: number;
  steps: StepState[];
  checkpoints: CheckpointState[];
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
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as SprintState;
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
  steps: { step: number; role: string; name: string }[]
): SprintState {
  return {
    project,
    sprint,
    status: "in-progress",
    currentStep: 1,
    steps: steps.map((s) => ({
      step: s.step,
      role: s.role,
      name: s.name,
      status: "pending" as StepStatus,
      artifacts: [],
      completedAt: null,
    })),
    checkpoints: [],
  };
}
