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
  FailureRecord,
  loadSprintState,
  saveSprintState,
  createInitialState,
} from "./state";
import { resolveBacklogPath } from "../backlog-parser";
import { renderProgressTable } from "./progress";
import { buildCheckpointPrompt, CheckpointPrompt } from "./checkpoints";
import { buildRolePrompt, buildStepContext } from "./prompts";
import { spawnAgent } from "./agents";
import { executeMerge, updatePrDodChecklist } from "./merge";
import { generateSprintSummary, loadSprintSummaries } from "./summary";
import {
  buildRetroPrompt,
  parseRetroProposal,
  generateRetroDocument,
  updateRetroDocWithDecisions,
  applyImprovements,
  buildSprintContextForRetro,
  parseRetroSelection,
  RetroProposal,
} from "./retro";
import { Role } from "./workflow";
import { resolveDinoNames, formatHandoffRole, DinoIdentity } from "./dino";
import { resolveStepTimeout, TimeoutConfig } from "./timeouts";
import { detectTestFramework, buildTestScopeSection } from "./test-scope";
import { buildCodebaseSnapshot, formatSnapshotForPrompt } from "./codebase-context";
import { resolveArtifacts, buildRequiredReadingSection } from "./artifact-injection";
import { decomposeTask, executeNarrowedRetry, isNarrowable } from "./scope-narrowing";

export const MAX_RETRY_ATTEMPTS = 3;
export const ERROR_SUMMARY_MAX_LENGTH = 500;
export const RETRY_CONTEXT_MAX_LENGTH = 3000;

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
 * Build a task description for the subagent based on the step and sprint context.
 */
function buildTaskDescription(
  step: WorkflowStep,
  featureSlug: string,
  sprint: number,
  feedback?: string,
  testScopeSection?: string,
  requiredReadingSection?: string
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
 * Detect if agent output contains a [BLOCKER] marker.
 */
function hasBlockerMarker(output: string): boolean {
  return /\[blocker\]/i.test(output);
}

/**
 * Truncate a string to a max length for error summaries.
 */
function truncateErrorSummary(output: string): string {
  if (!output || output.length === 0) return "agent produced no output";
  return output.slice(0, ERROR_SUMMARY_MAX_LENGTH);
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
    // Detect current branch for branchName tracking
    let branchName: string | null = null;
    try {
      const git = simpleGit(projectPath);
      branchName = await git.revparse(["--abbrev-ref", "HEAD"]);
    } catch {
      // Non-critical
    }

    state = createInitialState(
      projectSlug,
      sprint,
      SPRINT_WORKFLOW.map((s) => ({
        step: s.step,
        role: s.role,
        name: s.name,
      })),
      branchName
    );
  }

  // Track branch name if not already set
  if (!state.branchName) {
    try {
      const git = simpleGit(projectPath);
      state.branchName = await git.revparse(["--abbrev-ref", "HEAD"]);
    } catch {
      // Non-critical
    }
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

  // Resolve dino names for this sprint run
  const dinoNames = resolveDinoNames();

  // Detect test framework once for scoped test execution
  const testFramework = detectTestFramework(projectPath);
  const isMultiFeature = !!(state.features && state.features.length > 1);

  // Load cross-sprint context for agent prompts
  const sprintSummaries = loadSprintSummaries(projectPath);

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
    if (step.name === "Apply retro improvements") {
      const retroFeedback = state.checkpoints.find(
        (c) => c.type === "retro-review" && (c.status === "approved" || c.status === "changes-requested")
      );
      const retroProposals = (state.retroProposals ?? []) as RetroProposal[];
      const selectedIndices = parseRetroSelection(
        retroFeedback?.feedback,
        retroProposals.length
      );

      if (selectedIndices.length > 0 && retroProposals.length > 0) {
        const selectedProposals = selectedIndices
          .map((i) => retroProposals[i - 1])
          .filter((p): p is RetroProposal => p !== undefined);

        if (selectedProposals.length > 0) {
          const teamMdPath = path.join(projectPath, "TEAM.md");
          const teamMd = fs.readFileSync(teamMdPath, "utf-8");
          const updatedTeamMd = applyImprovements(teamMd, selectedProposals);
          fs.writeFileSync(teamMdPath, updatedTeamMd);

          try {
            await git.add(teamMdPath);
            await git.commit(`[PO] update: apply retrospective improvements from sprint ${sprint}`);
          } catch { /* Non-critical */ }
        }
      }

      // Update retro doc with decisions
      const retroPath = path.join(projectPath, "docs", "sprints", `sprint-${sprint}-retro.md`);
      if (fs.existsSync(retroPath)) {
        const retroDoc = fs.readFileSync(retroPath, "utf-8");
        const updatedRetroDoc = updateRetroDocWithDecisions(
          retroDoc,
          selectedIndices,
          retroProposals.length
        );
        fs.writeFileSync(retroPath, updatedRetroDoc);
        try {
          await git.add(retroPath);
          await git.commit(`[PO] update: sprint ${sprint} retro decisions recorded`);
        } catch { /* Non-critical */ }
      }

      stepState.attempts = 1;
      stepState.status = "complete";
      stepState.completedAt = new Date().toISOString();
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

      const mergeResult = await executeMerge(
        projectPath,
        featureSlug,
        sprint,
        branchName
      );

      if (!mergeResult.success) {
        // Record failure and use circuit breaker
        stepState.attempts++;
        stepState.failures.push({
          attempt: stepState.attempts,
          errorSummary: truncateErrorSummary(mergeResult.error || "Merge failed"),
          timestamp: new Date().toISOString(),
          hadPartialArtifacts: false,
        });

        if (stepState.attempts >= MAX_RETRY_ATTEMPTS) {
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

        // Retry the merge
        saveSprintState(projectSlug, sprint, state);
        continue;
      }

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

    // --- Standard agent step with circuit breaker retry ---
    let succeeded = false;

    for (let attempt = stepState.attempts + 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      stepState.attempts = attempt;
      saveSprintState(projectSlug, sprint, state);

      // Build prompts and context
      const systemPrompt = buildRolePrompt(step.role);
      let context = buildStepContext(step.step, projectPath, featureSlug);

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
        // Required artifact missing — record failure and retry
        stepState.failures.push({
          attempt,
          errorSummary: `Missing required artifacts: ${artifactResult.missing.join(", ")}`,
          timestamp: new Date().toISOString(),
          hadPartialArtifacts: false,
        });
        saveSprintState(projectSlug, sprint, state);
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

      // Add user feedback on first attempt if provided
      const taskDesc = buildTaskDescription(
        step,
        featureSlug,
        sprint,
        attempt === 1 && i === fromStep - 1 ? feedback : undefined,
        testScopeSection || undefined,
        requiredReadingSection
      );

      // Add retry context for attempts > 1
      if (attempt > 1) {
        const partialArtifacts = validateStepOutputs(step, projectPath);
        context += buildRetryContext(
          attempt,
          MAX_RETRY_ATTEMPTS,
          stepState.failures,
          partialArtifacts,
          projectPath
        );
      }

      // On final attempt, try scope narrowing before normal retry
      if (attempt === MAX_RETRY_ATTEMPTS && isNarrowable(step.role)) {
        const subTasks = decomposeTask(step.role, step, featureSlug, projectPath, taskDesc);
        if (subTasks.length > 1) {
          const stepTimeout = resolveStepTimeout(step.name);
          const narrowResult = await executeNarrowedRetry(
            subTasks, step.role, systemPrompt, context, projectPath, stepTimeout
          );

          if (narrowResult.completedIds.length === narrowResult.subTasks.length) {
            // All sub-tasks succeeded
            succeeded = true;
            break;
          }

          // Partial or full failure — record and fall through to escalation
          stepState.failures.push({
            attempt,
            errorSummary: `Narrowed retry (${narrowResult.strategy}): ${narrowResult.completedIds.length}/${subTasks.length} sub-tasks completed. Failed: ${narrowResult.failedIds.join(", ")}`,
            timestamp: new Date().toISOString(),
            hadPartialArtifacts: narrowResult.completedIds.length > 0,
          });
          saveSprintState(projectSlug, sprint, state);
          continue;
        }
      }

      // Spawn subagent with step-aware timeout
      const stepTimeout = resolveStepTimeout(step.name);
      const result = await spawnAgent(
        step.role,
        systemPrompt,
        context,
        taskDesc,
        projectPath,
        stepTimeout
      );

      // Check for [BLOCKER] — immediate escalation
      if (hasBlockerMarker(result.output)) {
        stepState.failures.push({
          attempt,
          errorSummary: truncateErrorSummary(result.output),
          timestamp: new Date().toISOString(),
          hadPartialArtifacts: validateStepOutputs(step, projectPath).length > 0,
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
        succeeded = true;
        break;
      }

      // Record failure
      stepState.failures.push({
        attempt,
        errorSummary: truncateErrorSummary(result.output),
        timestamp: new Date().toISOString(),
        hadPartialArtifacts: validateStepOutputs(step, projectPath).length > 0,
      });
      saveSprintState(projectSlug, sprint, state);
    }

    if (!succeeded) {
      // All retries exhausted — escalate
      stepState.status = "escalated";
      state.status = "escalated";
      saveSprintState(projectSlug, sprint, state);

      // Create escalation commit
      try {
        const summary = stepState.failures.map(
          (f) => `Attempt ${f.attempt}: ${f.errorSummary}`
        ).join("; ");
        await git.commit(
          `[ESCALATE] ${formatHandoffRole(step.role, dinoNames)}: step ${step.step} (${step.name}) failed ${stepState.attempts} times — requesting user intervention.\nSummary: ${summary}`,
          { "--allow-empty": null }
        );
      } catch {
        // Non-critical
      }

      return {
        status: "escalated",
        progress: renderProgressTable(state),
        message: `Step ${step.step} (${step.name}) failed after ${MAX_RETRY_ATTEMPTS} attempts.\n\nLast error:\n${stepState.failures[stepState.failures.length - 1]?.errorSummary || "unknown"}`,
        state,
      };
    }

    // Step succeeded — validate outputs and mark complete
    if (step.expectedOutputs.length > 0) {
      const artifacts = validateStepOutputs(step, projectPath);
      stepState.artifacts = artifacts;
    }

    stepState.status = "complete";
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
    message: "Sprint complete! All steps finished successfully.",
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

    if (action === "approve") {
      pendingCheckpoint.status = "approved";
      pendingCheckpoint.feedback = feedback || null;
      pendingCheckpoint.resolvedAt = new Date().toISOString();

      // Update DoD fields based on checkpoint type
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
        state.currentStep + 1
      );
    } else {
      pendingCheckpoint.status = "changes-requested";
      pendingCheckpoint.feedback = feedback || null;
      pendingCheckpoint.resolvedAt = new Date().toISOString();

      // Reset current step for re-run
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

  // --- Resume from escalated ---
  if (state.status === "escalated") {
    if (!feedback) {
      return {
        status: "error",
        progress: renderProgressTable(state),
        message: "Cannot resume an escalated sprint without guidance. Please provide feedback describing how to resolve the issue.",
        state,
      };
    }

    // Find the escalated step
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
      feedback
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
      feedback
    );
  }

  return {
    status: "error",
    progress: renderProgressTable(state),
    message: `Sprint is in '${state.status}' status and cannot be resumed.`,
    state,
  };
}
