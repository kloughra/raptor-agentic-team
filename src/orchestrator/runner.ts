import * as fs from "fs";
import * as path from "path";
import simpleGit from "simple-git";
import {
  SPRINT_WORKFLOW,
  HANDOFF_MAP,
  WorkflowStep,
} from "./workflow";
import {
  SprintState,
  loadSprintState,
  saveSprintState,
  createInitialState,
} from "./state";
import { renderProgressTable } from "./progress";
import { buildCheckpointPrompt, CheckpointPrompt } from "./checkpoints";
import { buildRolePrompt, buildStepContext } from "./prompts";
import { spawnAgent } from "./agents";

export interface SprintResult {
  status: "checkpoint" | "complete" | "error";
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
  const backlogPath = path.join(projectPath, "docs", "backlog.md");
  if (!fs.existsSync(backlogPath)) return null;

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
 * Build a task description for the subagent based on the step and sprint context.
 */
function buildTaskDescription(
  step: WorkflowStep,
  featureSlug: string,
  sprint: number,
  feedback?: string
): string {
  let task = `Sprint ${sprint}, Step ${step.step}: ${step.description}.\n`;
  task += `Feature slug: ${featureSlug}\n`;

  if (step.expectedOutputs.length > 0) {
    task += `Expected outputs: ${step.expectedOutputs.join(", ")}\n`;
  }

  if (feedback) {
    task += `\nUser feedback from previous review:\n${feedback}\n`;
    task += "Please address this feedback in your output.\n";
  }

  task += `\nCommit your work with the format: [${step.role.toUpperCase()}] {action}: {description}\n`;

  return task;
}

/**
 * Run a sprint from a given step until the next checkpoint or completion.
 */
export async function runSprintFromStep(
  projectPath: string,
  projectSlug: string,
  sprint: number,
  fromStep: number,
  feedback?: string
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
      }))
    );
  }

  const featureSlug = extractFeatureSlug(projectPath);
  if (!featureSlug) {
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

    // Build prompts and context
    const systemPrompt = buildRolePrompt(step.role);
    const context = buildStepContext(step.step, projectPath, featureSlug);
    const taskDesc = buildTaskDescription(
      step,
      featureSlug,
      sprint,
      i === fromStep - 1 ? feedback : undefined
    );

    // Spawn subagent
    const result = await spawnAgent(
      step.role,
      systemPrompt,
      context,
      taskDesc,
      projectPath
    );

    if (result.exitCode !== 0) {
      // Retry once with clarified instructions
      const retryResult = await spawnAgent(
        step.role,
        systemPrompt,
        context +
          "\n\nPREVIOUS ATTEMPT FAILED. Please try again, ensuring you produce the expected outputs.",
        taskDesc,
        projectPath
      );

      if (retryResult.exitCode !== 0) {
        stepState.status = "failed";
        state.status = "failed";
        saveSprintState(projectSlug, sprint, state);
        return {
          status: "error",
          progress: renderProgressTable(state),
          message: `Step ${step.step} (${step.name}) failed after retry.\n\nAgent output:\n${retryResult.output.slice(0, 2000)}`,
          state,
        };
      }
    }

    // Validate outputs if the step has expected outputs
    if (step.expectedOutputs.length > 0) {
      const artifacts = validateStepOutputs(step, projectPath);
      stepState.artifacts = artifacts;
    }

    // Mark step complete
    stepState.status = "complete";
    stepState.completedAt = new Date().toISOString();
    saveSprintState(projectSlug, sprint, state);

    // Create handoff commit if applicable
    const handoff = HANDOFF_MAP[step.step];
    if (handoff && step.step < 9) {
      try {
        await git.commit(
          `[HANDOFF] ${handoff.from.toUpperCase()} -> ${handoff.to.toUpperCase()}: ${handoff.artifact} for ${featureSlug}`,
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

  // All steps complete
  state.status = "complete";
  saveSprintState(projectSlug, sprint, state);

  return {
    status: "complete",
    progress: renderProgressTable(state),
    message: "Sprint complete! All steps finished successfully.",
    state,
  };
}

/**
 * Resume a sprint after a user checkpoint.
 */
export async function resumeSprint(
  projectPath: string,
  projectSlug: string,
  sprint: number,
  action: "approve" | "request-changes",
  feedback?: string
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

  if (state.status !== "paused") {
    return {
      status: "error",
      progress: renderProgressTable(state),
      message: `Sprint is not paused (status: ${state.status}). Cannot resume.`,
      state,
    };
  }

  // Resolve the pending checkpoint
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

  if (action === "approve") {
    pendingCheckpoint.status = "approved";
    pendingCheckpoint.feedback = feedback || null;
    pendingCheckpoint.resolvedAt = new Date().toISOString();
    saveSprintState(projectSlug, sprint, state);

    // Continue from the next step
    return runSprintFromStep(
      projectPath,
      projectSlug,
      sprint,
      state.currentStep + 1
    );
  } else {
    // Request changes — re-run the current step with feedback
    pendingCheckpoint.status = "changes-requested";
    pendingCheckpoint.feedback = feedback || null;
    pendingCheckpoint.resolvedAt = new Date().toISOString();

    // Reset current step to in-progress for re-run
    const currentStepState = state.steps[state.currentStep - 1];
    currentStepState.status = "pending";
    currentStepState.artifacts = [];
    currentStepState.completedAt = null;

    state.status = "in-progress";
    saveSprintState(projectSlug, sprint, state);

    return runSprintFromStep(
      projectPath,
      projectSlug,
      sprint,
      state.currentStep,
      feedback
    );
  }
}
