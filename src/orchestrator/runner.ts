import * as fs from "fs";
import * as path from "path";
import simpleGit, { SimpleGit } from "simple-git";
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
import { renderProgressTable } from "./progress";
import { buildCheckpointPrompt, CheckpointPrompt } from "./checkpoints";
import { buildRolePrompt, buildStepContext, buildTeamMdContext } from "./prompts";
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
import {
  detectSprintFeatures,
  createFeatureStates,
  featureBranchName,
  allFeaturesComplete,
  anyFeaturesEscalated,
  deriveSprintStatus,
  ensureFeatureBranch,
} from "./multi-runner";

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
 * Validate that required output files exist after an agent completes.
 * Returns list of missing files. Empty list = all outputs present.
 */
export function validateRequiredOutputs(
  step: WorkflowStep,
  featureSlug: string,
  projectPath: string
): string[] {
  if (step.expectedOutputs.length === 0) return [];

  const missing: string[] = [];
  const resolvedPaths = resolveExpectedOutputPaths(step.expectedOutputs, featureSlug);

  for (const relPath of resolvedPaths) {
    const fullPath = path.join(projectPath, relPath);
    if (!fs.existsSync(fullPath)) {
      missing.push(relPath);
    }
  }

  // For patterns with double-star globs (e.g. src/**/*.ts) that can't resolve
  // to a single file, fall back to directory-level check: at least one file must exist
  for (const pattern of step.expectedOutputs) {
    if (!pattern.includes("**")) continue; // Already handled by exact path check above

    // Check that the base directory has at least one file
    // For "src/**/*.ts", check "src/" has files (recursively would be ideal, but
    // a flat check on the base directory is sufficient for validation)
    const baseDir = pattern.split("**")[0]; // "src/" from "src/**/*.ts"
    const dir = path.join(projectPath, baseDir);
    if (!fs.existsSync(dir)) {
      missing.push(pattern);
      continue;
    }
    try {
      const files = fs.readdirSync(dir).filter((f) => {
        try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
      });
      if (files.length === 0) {
        missing.push(pattern);
      }
    } catch {
      missing.push(pattern);
    }
  }

  return missing;
}

/**
 * Resolve expectedOutputs glob patterns to concrete file paths using the feature slug.
 * e.g. "docs/specs/*.md" → "docs/specs/{slug}.md"
 *
 * Patterns with double-star globs (e.g. src/**\/*.ts) are not resolvable to a
 * single file path — they're filtered out and handled by directory-level checks
 * in validateRequiredOutputs instead.
 */
export function resolveExpectedOutputPaths(
  expectedOutputs: string[],
  featureSlug: string
): string[] {
  return expectedOutputs
    .filter((p) => !p.includes("**")) // Drop double-star globs — not resolvable
    .map((pattern) => pattern.replace("*", featureSlug))
    .filter((p) => !p.includes("*")); // Drop any remaining unresolvable patterns
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
    const resolvedPaths = resolveExpectedOutputPaths(step.expectedOutputs, featureSlug);
    if (resolvedPaths.length > 0) {
      task += `\n**REQUIRED OUTPUT FILES — You MUST create these files:**\n`;
      for (const filePath of resolvedPaths) {
        task += `- ${filePath}\n`;
      }
      task += `\nThis step will FAIL validation if these files do not exist on disk after you complete. `;
      task += `Do NOT skip file creation even if the content seems to already exist elsewhere (e.g. in the backlog). `;
      task += `The file is the deliverable.\n`;
    }
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
        // Layer 3: Validate required outputs actually exist on disk
        const missingOutputs = validateRequiredOutputs(step, featureSlug, projectPath);
        if (missingOutputs.length > 0) {
          // Agent said it's done but didn't create required files — treat as failure
          stepState.failures.push({
            attempt,
            errorSummary: `Agent completed (exit 0) but did not create required output files: ${missingOutputs.join(", ")}. The step is not complete until these files exist on disk.`,
            timestamp: new Date().toISOString(),
            hadPartialArtifacts: validateStepOutputs(step, projectPath).length > 0,
          });
          saveSprintState(projectSlug, sprint, state);
          continue; // Retry — the agent will see this failure in retry context
        }

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
          state.currentStep
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
        state.currentStep + 1
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
          feedback
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
}

type AgentStepOutcome =
  | { kind: "complete"; artifacts: string[] }
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
async function runAgentStepCycle(
  step: WorkflowStep,
  stepState: StepState,
  featureSlug: string,
  ctx: DispatchContext,
  isMultiFeature: boolean,
  isFirstStepOfThisInvocation: boolean
): Promise<AgentStepOutcome> {
  const { projectPath, projectSlug, sprint, state, feedback, sprintSummaries, testFramework } = ctx;

  for (let attempt = stepState.attempts + 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    stepState.attempts = attempt;
    saveSprintState(projectSlug, sprint, state);

    // Build prompts and context
    const systemPrompt = buildRolePrompt(step.role);
    let context = buildStepContext(step.step, projectPath, featureSlug);

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

    const testScopeSection = buildTestScopeSection(
      step.name,
      featureSlug,
      testFramework,
      isMultiFeature
    );

    const taskDesc = buildTaskDescription(
      step,
      featureSlug,
      sprint,
      attempt === 1 && isFirstStepOfThisInvocation ? feedback : undefined,
      testScopeSection || undefined,
      requiredReadingSection
    );

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

    if (attempt === MAX_RETRY_ATTEMPTS && isNarrowable(step.role)) {
      const subTasks = decomposeTask(step.role, step, featureSlug, projectPath, taskDesc);
      if (subTasks.length > 1) {
        const stepTimeout = resolveStepTimeout(step.name);
        const narrowResult = await executeNarrowedRetry(
          subTasks, step.role, systemPrompt, context, projectPath, stepTimeout
        );

        if (narrowResult.completedIds.length === narrowResult.subTasks.length) {
          const artifacts =
            step.expectedOutputs.length > 0 ? validateStepOutputs(step, projectPath) : [];
          return { kind: "complete", artifacts };
        }

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

    const stepTimeout = resolveStepTimeout(step.name);
    const result = await spawnAgent(
      step.role,
      systemPrompt,
      context,
      taskDesc,
      projectPath,
      stepTimeout
    );

    if (hasBlockerMarker(result.output)) {
      stepState.failures.push({
        attempt,
        errorSummary: truncateErrorSummary(result.output),
        timestamp: new Date().toISOString(),
        hadPartialArtifacts: validateStepOutputs(step, projectPath).length > 0,
      });
      return { kind: "blocker", output: result.output };
    }

    if (result.exitCode === 0) {
      const missingOutputs = validateRequiredOutputs(step, featureSlug, projectPath);
      if (missingOutputs.length > 0) {
        stepState.failures.push({
          attempt,
          errorSummary: `Agent completed (exit 0) but did not create required output files: ${missingOutputs.join(", ")}. The step is not complete until these files exist on disk.`,
          timestamp: new Date().toISOString(),
          hadPartialArtifacts: validateStepOutputs(step, projectPath).length > 0,
        });
        saveSprintState(projectSlug, sprint, state);
        continue;
      }

      const artifacts =
        step.expectedOutputs.length > 0 ? validateStepOutputs(step, projectPath) : [];
      return { kind: "complete", artifacts };
    }

    stepState.failures.push({
      attempt,
      errorSummary: truncateErrorSummary(result.output),
      timestamp: new Date().toISOString(),
      hadPartialArtifacts: validateStepOutputs(step, projectPath).length > 0,
    });
    saveSprintState(projectSlug, sprint, state);
  }

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

  for (let i = fromStep - 1; i < SPRINT_WORKFLOW.length; i++) {
    const step = SPRINT_WORKFLOW[i];
    const isPerFeatureStep = step.step <= 9;

    if (isPerFeatureStep) {
      // Per-feature dispatch (AC #3)
      let anyEscalated = false;

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
          anyEscalated = true;
          continue;
        }
        feature.branchName = featureBranchName(sprint, feature.slug);

        // Special handling for the Merge PR step: no agent, runs executeMerge.
        if (step.name === "Merge PR") {
          const mergeOutcome = await runMergeStepForFeature(feature, featureStepState, ctx);
          if (mergeOutcome === "escalated") {
            anyEscalated = true;
          }
          continue;
        }

        const isFirstStepOfThisInvocation = i === fromStep - 1 && fIdx === 0;
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
          anyEscalated = true;
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
          anyEscalated = true;
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

      // After all features dispatched for this step
      const sprintStatus = deriveSprintStatus(state.features);
      if (sprintStatus === "escalated" || (anyEscalated && sprintStatus !== "in-progress")) {
        state.status = "escalated";
        saveSprintState(projectSlug, sprint, state);
        return {
          status: "escalated",
          progress: renderProgressTable(state),
          message: `Step ${step.step} (${step.name}): one or more features escalated. Sprint status: ${sprintStatus}.`,
          state,
        };
      }
      // Otherwise advance to next step
      continue;
    }

    // --- Sprint-shared step (10–13) — run once on top-level state.steps ---
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
      ? "Sprint complete! All features finished successfully."
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
    stepState.attempts++;
    stepState.failures.push({
      attempt: stepState.attempts,
      errorSummary: truncateErrorSummary(mergeResult.error || "Merge failed"),
      timestamp: new Date().toISOString(),
      hadPartialArtifacts: false,
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
 */
async function runApplyRetroImprovementsShared(
  ctx: DispatchContext,
  stepState: StepState
): Promise<void> {
  const { projectPath, projectSlug, sprint, state, git } = ctx;

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
      } catch { /* non-critical */ }
    }
  }

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
    } catch { /* non-critical */ }
  }

  stepState.attempts = 1;
  stepState.status = "complete";
  stepState.completedAt = new Date().toISOString();
  saveSprintState(projectSlug, sprint, state);
}
