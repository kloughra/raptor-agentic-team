/**
 * Integration tests — sprint-completes-despite-failed-merge (Sprint 13)
 *
 * Spec:         docs/specs/sprint-completes-despite-failed-merge.md (AC 1–10)
 * Architecture: docs/architecture/sprint-completes-despite-failed-merge.md (C1–C5)
 *
 * PRODUCTION SEAM (AC #10 / TEAM.md QA rule 12): every constraint-guarding
 * test in this file drives the REAL `runSprintFromStep` step loop
 * (single-feature) or the real multi-feature dispatcher — never a test-local
 * reimplementation of the control flow. Mocking happens ONLY at the two
 * boundaries the architecture sanctions:
 *
 *   - `executeMerge` / `updatePrDodChecklist` (src/orchestrator/merge) — the
 *     gh/git merge mechanics, explicitly Out of Scope for this feature.
 *   - `spawnAgent` (src/orchestrator/agents) — so shared steps 10–13 don't
 *     spawn real `claude` processes.
 *
 * Do NOT widen these mocks. A future mock of the runner loop, the dispatcher,
 * or `runMergeStepForFeature` silently neuters the regression coverage this
 * file exists for (the Sprint 10 / Sprint 12 false-"Sprint complete").
 *
 * TDD note: the constraint-guarding tests here are RED against the pre-fix
 * control flow (the skip-a-step `continue` at runner.ts:967-969, the ignored
 * "retry" return at runner.ts:2038-2041, the unconditional finalization at
 * runner.ts:1343-1369) — that is the REQUIRED state at step 3 and the proof
 * demanded by AC #10 that these tests actually guard the fix. Tests marked
 * [no-regression] are expected to pass both before and after (AC #7 resume,
 * state-file compatibility) and are not constraint-guarding.
 *
 * Surfaces intentionally NOT covered here:
 *   - The missing-`branchName` hard-fail (spec edge case "unchanged"): after
 *     the Sprint 8 branch-auto-create work, `runSprintFromStep` always sets
 *     `state.branchName` / `feature.branchName` before the merge branch, so
 *     the path cannot be reached through the production seam without mocking
 *     `ensureFeatureBranch` — which this file's mock policy forbids. It is
 *     asserted unchanged by code review (architecture "Unchanged components").
 *   - `executeMerge` internals (gh CLI / local fallback): Out of Scope; the
 *     Sprint 7 suite covers them.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

jest.mock("../../src/orchestrator/merge", () => {
  const actual = jest.requireActual("../../src/orchestrator/merge") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    executeMerge: jest.fn(),
    updatePrDodChecklist: jest.fn(async () => false),
  };
});

jest.mock("../../src/orchestrator/agents", () => {
  const actual = jest.requireActual("../../src/orchestrator/agents") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    spawnAgent: jest.fn(),
  };
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import simpleGit from "simple-git";

import {
  runSprintFromStep,
  MAX_RETRY_ATTEMPTS,
  ERROR_SUMMARY_MAX_LENGTH,
} from "../../src/orchestrator/runner";
import { SPRINT_WORKFLOW } from "../../src/orchestrator/workflow";
import {
  createInitialState,
  saveSprintState,
  loadSprintState,
  SprintState,
  StepState,
} from "../../src/orchestrator/state";
import { createFeatureStates, featureBranchName } from "../../src/orchestrator/multi-runner";
import { executeMerge, MergeResult } from "../../src/orchestrator/merge";
import { spawnAgent, AgentResult } from "../../src/orchestrator/agents";

const executeMergeMock = executeMerge as jest.MockedFunction<typeof executeMerge>;
const spawnAgentMock = spawnAgent as jest.MockedFunction<typeof spawnAgent>;

const SPRINT = 1;
const SLUG = "widget-export";
const SLUG_A = "feat-alpha";
const SLUG_B = "feat-beta";

const MERGE_OK: MergeResult = { success: true, method: "github" };
const mergeFail = (error: string): MergeResult => ({ success: false, method: "github", error });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakeHome: string;
/** Interleaving log: `merge:<slug>` / `agent:<role>` — orders the seam calls. */
let seq: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-merge-retry-"));
  fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  // Sandbox ~/.raptor (state files, config) — enabled by tests/helpers/os-shim.js.
  jest.spyOn(os, "homedir").mockReturnValue(fakeHome);

  seq = [];
  executeMergeMock.mockReset();
  spawnAgentMock.mockReset();
  spawnAgentMock.mockImplementation(async (role: string): Promise<AgentResult> => {
    seq.push(`agent:${role}`);
    return { output: `${role} step done`, exitCode: 0 };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Queue merge outcomes per feature slug. The LAST entry repeats forever
 * (models a permanently-failing merge without an unbounded fixture).
 */
function planMerges(plan: Record<string, MergeResult[]>): void {
  const queues: Record<string, MergeResult[]> = {};
  for (const [slug, results] of Object.entries(plan)) queues[slug] = [...results];
  executeMergeMock.mockImplementation(async (_projectPath, featureSlug) => {
    seq.push(`merge:${featureSlug}`);
    const queue = queues[featureSlug];
    if (!queue || queue.length === 0) {
      throw new Error(`test plan has no merge outcome for '${featureSlug}'`);
    }
    return queue.length > 1 ? queue.shift()! : queue[0];
  });
}

/** Create a real git repo with a Raptor-format backlog for the given slugs. */
async function initProject(name: string, slugs: string[]): Promise<string> {
  const projectPath = path.join(tmpDir, name);
  fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
  const items = slugs.map((s) => `- [ ] ${s}: ${s} feature work`).join("\n");
  fs.writeFileSync(
    path.join(projectPath, "docs", "backlog.md"),
    `# Backlog\n\n## Sprint ${SPRINT}\n${items}\n\n## Ready\n\n## Inbox\n\n## Done\n`
  );
  const git = simpleGit(projectPath);
  await git.init();
  await git.addConfig("user.name", "Vex Velociraptor");
  await git.addConfig("user.email", "vex@raptor.test");
  await git.add(".");
  await git.commit("[PO] add: sprint backlog");
  return projectPath;
}

function workflowSteps() {
  return SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name }));
}

function markComplete(steps: StepState[], through: number): void {
  for (const s of steps) {
    if (s.step <= through) {
      s.status = "complete";
      s.completedAt = "2026-07-06T00:00:00.000Z";
      s.attempts = 1;
    }
  }
}

/** Seed a single-feature sprint state parked at step 9 (steps 1–8 complete). */
function seedSingleFeatureState(projectSlug: string, currentStep = 9): SprintState {
  const state = createInitialState(projectSlug, SPRINT, workflowSteps(), featureBranchName(SPRINT, SLUG));
  markComplete(state.steps, currentStep - 1);
  state.currentStep = currentStep;
  saveSprintState(projectSlug, SPRINT, state);
  return state;
}

/** Seed a multi-feature sprint state with both features parked at step 9. */
function seedMultiFeatureState(projectSlug: string): SprintState {
  const state = createInitialState(projectSlug, SPRINT, workflowSteps(), null);
  state.features = createFeatureStates([SLUG_A, SLUG_B], SPRINT);
  for (const f of state.features) {
    markComplete(f.steps, 8);
    f.status = "in-progress";
    f.currentStep = 9;
  }
  state.currentStep = 9;
  saveSprintState(projectSlug, SPRINT, state);
  return state;
}

const step9 = (state: SprintState): StepState => state.steps.find((s) => s.step === 9)!;

async function gitSubjects(projectPath: string): Promise<string[]> {
  const log = await simpleGit(projectPath).log();
  return log.all.map((l) => l.message);
}

const mergeCalls = (): string[] => seq.filter((e) => e.startsWith("merge:"));
const firstAgentIndex = (): number => seq.findIndex((e) => e.startsWith("agent:"));
const lastMergeIndex = (): number =>
  seq.reduce((last, e, i) => (e.startsWith("merge:") ? i : last), -1);

// ===========================================================================
// Single-feature mode — C1 in-place retry (AC #1, #2, #3, #9)
// ===========================================================================

describe("single-feature: merge retried in place (AC #1, #2)", () => {
  it("re-executes step 9 without advancing the step index when the merge fails once then succeeds", async () => {
    const projectSlug = "sf-retry-once";
    const projectPath = await initProject(projectSlug, [SLUG]);
    seedSingleFeatureState(projectSlug);
    planMerges({ [SLUG]: [mergeFail("gh pr merge: branch diverged"), MERGE_OK] });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    // The heart of AC #1 — RED pre-fix: the `continue` at runner.ts:967-969
    // skips to step 10 after ONE invocation, leaving step 9 in-progress/1.
    expect(executeMergeMock).toHaveBeenCalledTimes(2);
    const s9 = step9(result.state);
    expect(s9.status).toBe("complete");
    expect(s9.attempts).toBe(2);
    expect(s9.failures).toHaveLength(1);
    expect(s9.failures[0].errorSummary).toContain("branch diverged");

    // AC #1: steps 10–13 begin only after step 9 is complete — both merge
    // invocations strictly precede the first shared-step agent spawn.
    expect(mergeCalls()).toEqual([`merge:${SLUG}`, `merge:${SLUG}`]);
    expect(firstAgentIndex()).toBeGreaterThan(lastMergeIndex());

    // Persisted state agrees with the returned state (persist-before-yield).
    const persisted = loadSprintState(projectSlug, SPRINT)!;
    expect(step9(persisted).status).toBe("complete");
    expect(step9(persisted).attempts).toBe(2);

    // Exactly one step-9 [HANDOFF], for the successful merge only (AC #9 edge).
    const handoffs = (await gitSubjects(projectPath)).filter(
      (m) => m.includes("[HANDOFF]") && m.includes("merged PR")
    );
    expect(handoffs).toHaveLength(1);
  });

  it("merge succeeds on the final allowed attempt (fails twice, succeeds on attempt 3)", async () => {
    const projectSlug = "sf-retry-twice";
    const projectPath = await initProject(projectSlug, [SLUG]);
    seedSingleFeatureState(projectSlug);
    planMerges({
      // Neutral DETERMINISTIC failure specimen (retry-to-cap intent). Sprint 18
      // (branch-protection-merge-lockout) reclassifies "protected branch" as
      // user-actionable (escalate-after-one), so this test — which exercises the
      // ordinary bounded retry, not branch protection — uses a non-branch-
      // protection deterministic error instead.
      [SLUG]: [
        mergeFail("HTTP 422 unexpected server response"),
        mergeFail("HTTP 422 unexpected server response"),
        MERGE_OK,
      ],
    });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    expect(executeMergeMock).toHaveBeenCalledTimes(3);
    const s9 = step9(result.state);
    expect(s9.status).toBe("complete");
    expect(s9.attempts).toBe(3); // 2 failures + 1 success increment (AC #2 accounting)
    expect(s9.failures).toHaveLength(2);
    expect(result.state.status).not.toBe("escalated");

    const handoffs = (await gitSubjects(projectPath)).filter(
      (m) => m.includes("[HANDOFF]") && m.includes("merged PR")
    );
    expect(handoffs).toHaveLength(1);
  });

  it("attempts count equals executeMerge invocation count, with truncated error summaries (AC #2)", async () => {
    const projectSlug = "sf-accounting";
    const projectPath = await initProject(projectSlug, [SLUG]);
    seedSingleFeatureState(projectSlug);
    const longError = "x".repeat(ERROR_SUMMARY_MAX_LENGTH * 4);
    planMerges({ [SLUG]: [mergeFail(longError)] }); // repeats forever

    await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    const persisted = loadSprintState(projectSlug, SPRINT)!;
    const s9 = step9(persisted);
    expect(s9.attempts).toBe(executeMergeMock.mock.calls.length);
    expect(s9.failures).toHaveLength(s9.attempts);
    for (const f of s9.failures) {
      expect(f.errorSummary.length).toBeLessThanOrEqual(ERROR_SUMMARY_MAX_LENGTH);
    }
  });

  it("[C5, additive] merge failure records carry classification and signature", async () => {
    const projectSlug = "sf-enrichment";
    const projectPath = await initProject(projectSlug, [SLUG]);
    seedSingleFeatureState(projectSlug);
    // Neutral deterministic failure then success (Sprint 18 makes branch-
    // protection strings user-actionable/escalate-after-one; this test needs the
    // ordinary fail-then-retry-succeeds path).
    planMerges({ [SLUG]: [mergeFail("HTTP 422 unexpected server response"), MERGE_OK] });

    await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    const failure = step9(loadSprintState(projectSlug, SPRINT)!).failures[0];
    expect(failure.classification).toBeDefined();
    expect(failure.signature).toBeDefined();
    expect(failure.signature!.length).toBeGreaterThan(0);
  });
});

describe("single-feature: escalation at cap unchanged (AC #3, #9 + edge cases)", () => {
  it("escalates after exactly MAX_RETRY_ATTEMPTS in-place failures, without executing steps 10–13", async () => {
    const projectSlug = "sf-escalate";
    const projectPath = await initProject(projectSlug, [SLUG]);
    seedSingleFeatureState(projectSlug);
    // Deterministic failure — identical every attempt. NOTE: uses a neutral
    // non-branch-protection specimen; Sprint 18 makes branch-protection strings
    // user-actionable (escalate-after-one), and this test exercises the ordinary
    // retry-to-cap path.
    planMerges({ [SLUG]: [mergeFail("HTTP 422 unexpected server response")] });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    // RED pre-fix: `continue` skips ahead after ONE call — no escalation, and
    // spawnAgent IS called for steps 10+.
    expect(executeMergeMock).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
    expect(result.status).toBe("escalated");
    expect(result.message).toContain(`after ${MAX_RETRY_ATTEMPTS} attempts`);

    const s9 = step9(result.state);
    expect(s9.status).toBe("escalated");
    expect(s9.attempts).toBe(MAX_RETRY_ATTEMPTS);
    expect(s9.failures).toHaveLength(MAX_RETRY_ATTEMPTS);
    expect(result.state.status).toBe("escalated");

    // Steps 10–13 never begin: no subagents, statuses untouched.
    expect(spawnAgentMock).not.toHaveBeenCalled();
    for (const s of result.state.steps.filter((st) => st.step >= 10)) {
      expect(s.status).toBe("pending");
    }

    // [ESCALATE] commit exists; escalated state is persisted.
    const subjects = await gitSubjects(projectPath);
    expect(subjects.some((m) => m.includes("[ESCALATE]") && m.includes("Merge PR"))).toBe(true);
    expect(loadSprintState(projectSlug, SPRINT)!.status).toBe("escalated");
  });

  it("never claims the merge happened after escalation: no step-9 handoff, no 'Sprint complete' (AC #9)", async () => {
    const projectSlug = "sf-truthful";
    const projectPath = await initProject(projectSlug, [SLUG]);
    seedSingleFeatureState(projectSlug);
    planMerges({ [SLUG]: [mergeFail("PR was closed without merging")] });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    expect(step9(result.state).status).not.toBe("complete");
    expect(result.state.status).not.toBe("complete");
    expect(result.status).not.toBe("complete");
    expect(result.message ?? "").not.toContain("Sprint complete");

    const subjects = await gitSubjects(projectPath);
    expect(subjects.some((m) => m.includes("[HANDOFF]") && m.includes("merged PR"))).toBe(false);
  });

  it("the in-place retry terminates on a permanently-failing merge (edge: bounded loop)", async () => {
    const projectSlug = "sf-terminate";
    const projectPath = await initProject(projectSlug, [SLUG]);
    seedSingleFeatureState(projectSlug);
    planMerges({ [SLUG]: [mergeFail("permanent: merge conflict")] });

    // Termination itself is the assertion — an unbounded loop hits the jest
    // timeout. Cap proof: invocations never exceed MAX_RETRY_ATTEMPTS.
    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);
    expect(executeMergeMock.mock.calls.length).toBeLessThanOrEqual(MAX_RETRY_ATTEMPTS);
    expect(result.status).toBe("escalated");
  });

  it("[no-regression, AC #7] a sprint escalated at step 9 re-enters at step 9 and completes once the merge succeeds", async () => {
    const projectSlug = "sf-resume";
    const projectPath = await initProject(projectSlug, [SLUG]);
    seedSingleFeatureState(projectSlug);
    planMerges({ [SLUG]: [mergeFail("branch diverged")] });

    const first = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);
    expect(first.status).toBe("escalated"); // precondition (post-fix)

    // User fixed the underlying problem; re-engage at step 9.
    planMerges({ [SLUG]: [MERGE_OK] });
    const second = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    expect(step9(second.state).status).toBe("complete");
    expect(second.status).not.toBe("escalated");
  });
});

// ===========================================================================
// Single-feature mode — C3 finalization guard (AC #4)
// ===========================================================================

describe("single-feature: finalization guard (AC #4, defense in depth)", () => {
  it("refuses to report 'Sprint complete' when the loop exits with step 9 non-complete (Sprint 10/12 specimen)", async () => {
    const projectSlug = "sf-guard";
    const projectPath = await initProject(projectSlug, [SLUG]);

    // Hand-crafted invariant violation (architecture constraint 4): step 9
    // stuck in-progress with a recorded failure — the exact shape the pre-fix
    // control flow produced in Sprints 10 and 12 — while steps 10–12 are
    // complete. Entering at step 13 drives the loop to the finalization block.
    const state = createInitialState(projectSlug, SPRINT, workflowSteps(), featureBranchName(SPRINT, SLUG));
    markComplete(state.steps, 8);
    const s9 = step9(state);
    s9.status = "in-progress";
    s9.attempts = 1;
    s9.failures = [{
      attempt: 1,
      errorSummary: "gh pr merge: branch diverged",
      timestamp: "2026-07-06T00:00:00.000Z",
      hadPartialArtifacts: false,
    }];
    for (const s of state.steps) {
      if (s.step >= 10 && s.step <= 12) {
        s.status = "complete";
        s.completedAt = "2026-07-06T00:00:00.000Z";
        s.attempts = 1;
      }
    }
    state.currentStep = 13;
    saveSprintState(projectSlug, SPRINT, state);
    planMerges({}); // executeMerge must not be called from step 13

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 13);

    // RED pre-fix: runner.ts:1361 unconditionally sets "complete" and returns
    // "Sprint complete! All steps finished successfully." with step 9 open.
    expect(result.status).not.toBe("complete");
    expect(result.state.status).not.toBe("complete");
    expect(result.message ?? "").not.toContain("Sprint complete!");
    // The returned message names the offending step (architecture C3 / NFR 6).
    expect(result.message ?? "").toMatch(/9/);
    // Open Question 3 ruling: guard trips map to "escalated" (resumable).
    expect(result.status).toBe("escalated");
    expect(loadSprintState(projectSlug, SPRINT)!.status).not.toBe("complete");
    expect(executeMergeMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Multi-feature mode — C2 retry honored + C4 shared-step gate (AC #5, #6, #8)
// ===========================================================================

describe("multi-feature: dispatcher honors the retry outcome (AC #5)", () => {
  it("re-executes a feature's merge in place on 'retry' instead of advancing with step 9 in-progress", async () => {
    const projectSlug = "mf-retry";
    const projectPath = await initProject(projectSlug, [SLUG_A, SLUG_B]);
    seedMultiFeatureState(projectSlug);
    planMerges({
      [SLUG_A]: [mergeFail("branch diverged"), MERGE_OK],
      [SLUG_B]: [MERGE_OK],
    });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    // RED pre-fix: runner.ts:2038-2041 discards the "retry" return — feat-alpha
    // is merged ONCE and left in-progress at step 9.
    const aCalls = mergeCalls().filter((c) => c === `merge:${SLUG_A}`);
    expect(aCalls).toHaveLength(2);

    const featA = result.state.features!.find((f) => f.slug === SLUG_A)!;
    const featB = result.state.features!.find((f) => f.slug === SLUG_B)!;
    const a9 = featA.steps.find((s) => s.step === 9)!;
    expect(a9.status).toBe("complete");
    expect(a9.attempts).toBe(2);
    expect(a9.failures).toHaveLength(1);
    expect(featA.status).toBe("complete");
    expect(featB.status).toBe("complete");

    // Shared steps began only after every feature's merge was resolved.
    expect(firstAgentIndex()).toBeGreaterThan(lastMergeIndex());
  });
});

describe("multi-feature: sibling isolation and mixed-completion park (AC #8 + edge case)", () => {
  it("feature A merges once and is untouched while feature B retries in place then escalates at cap", async () => {
    const projectSlug = "mf-mixed";
    const projectPath = await initProject(projectSlug, [SLUG_A, SLUG_B]);
    seedMultiFeatureState(projectSlug);
    planMerges({
      [SLUG_A]: [MERGE_OK],
      // Neutral deterministic failure (retry-to-cap intent) — Sprint 18 makes
      // branch-protection strings user-actionable, so use a non-BP specimen.
      [SLUG_B]: [mergeFail("HTTP 422 unexpected server response")],
    });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    // RED pre-fix: feat-beta's "retry" is ignored (1 invocation, no
    // escalation) and the dispatcher marches into shared steps —
    // the unresumable in-progress limbo.
    expect(mergeCalls().filter((c) => c === `merge:${SLUG_A}`)).toHaveLength(1);
    expect(mergeCalls().filter((c) => c === `merge:${SLUG_B}`)).toHaveLength(MAX_RETRY_ATTEMPTS);

    const featA = result.state.features!.find((f) => f.slug === SLUG_A)!;
    const featB = result.state.features!.find((f) => f.slug === SLUG_B)!;

    // Sibling isolation (AC #8): A completed exactly once, never re-run or reset.
    expect(featA.status).toBe("complete");
    const a9 = featA.steps.find((s) => s.step === 9)!;
    expect(a9.status).toBe("complete");
    expect(a9.attempts).toBe(1);
    expect(a9.failures).toHaveLength(0);

    // B escalated at the cap with full accounting.
    expect(featB.status).toBe("escalated");
    const b9 = featB.steps.find((s) => s.step === 9)!;
    expect(b9.status).toBe("escalated");
    expect(b9.attempts).toBe(MAX_RETRY_ATTEMPTS);

    // Sprint 10 mixed-completion behavior preserved: sprint parks escalated,
    // shared steps 10–13 never begin.
    expect(result.status).toBe("escalated");
    expect(result.state.status).toBe("escalated");
    expect(spawnAgentMock).not.toHaveBeenCalled();

    const subjects = await gitSubjects(projectPath);
    expect(subjects.some((m) => m.includes("[ESCALATE]") && m.includes(SLUG_B))).toBe(true);
    // A's successful merge got its handoff; B never did (AC #9 in multi mode).
    expect(subjects.some((m) => m.includes("[HANDOFF]") && m.includes(`merged PR for ${SLUG_A}`))).toBe(true);
    expect(subjects.some((m) => m.includes("[HANDOFF]") && m.includes(`merged PR for ${SLUG_B}`))).toBe(false);
  });
});

describe("multi-feature: shared-step gate (AC #6, defense in depth)", () => {
  it("blocks shared steps 10–13 while a feature is non-terminal at step 9", async () => {
    const projectSlug = "mf-gate";
    const projectPath = await initProject(projectSlug, [SLUG_A, SLUG_B]);

    // Hand-crafted invariant violation: feat-alpha terminal-complete,
    // feat-beta stuck mid-retry (in-progress at step 9). Entering at step 10
    // drives the dispatcher straight to the shared-step boundary.
    const state = createInitialState(projectSlug, SPRINT, workflowSteps(), null);
    state.features = createFeatureStates([SLUG_A, SLUG_B], SPRINT);
    const featA = state.features.find((f) => f.slug === SLUG_A)!;
    markComplete(featA.steps, 9);
    featA.status = "complete";
    featA.currentStep = 10;
    const featB = state.features.find((f) => f.slug === SLUG_B)!;
    markComplete(featB.steps, 8);
    featB.status = "in-progress";
    featB.currentStep = 9;
    const b9 = featB.steps.find((s) => s.step === 9)!;
    b9.status = "in-progress";
    b9.attempts = 1;
    b9.failures = [{
      attempt: 1,
      errorSummary: "branch diverged",
      timestamp: "2026-07-06T00:00:00.000Z",
      hadPartialArtifacts: false,
    }];
    state.currentStep = 10;
    saveSprintState(projectSlug, SPRINT, state);
    planMerges({});

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 10);

    // RED pre-fix: runner.ts:2154-2158 continues into shared steps with
    // feat-beta non-terminal — spawnAgent runs step 10 and the sprint drifts on.
    expect(spawnAgentMock).not.toHaveBeenCalled();
    expect(result.status).not.toBe("complete");
    expect(result.state.status).not.toBe("complete");
    // Not the Sprint 9 in-progress limbo either — the gate parks it resumable.
    expect(result.state.status).not.toBe("in-progress");
    // The gate names the non-terminal feature (architecture C4 / NFR 6).
    expect(result.message ?? "").toContain(SLUG_B);
    for (const s of result.state.steps.filter((st) => st.step >= 10)) {
      expect(s.status).not.toBe("complete");
    }
  });
});

// ===========================================================================
// State-file compatibility (edge case, Out of Scope: no migration)
// ===========================================================================

describe("[no-regression] pre-fix state files (Sprint 10/12 specimens)", () => {
  it("loads a falsely-complete state (step 9 in-progress, sprint 'complete') without crashing and without auto-repair", () => {
    const projectSlug = "specimen";
    const stateDir = path.join(fakeHome, ".raptor", projectSlug);
    fs.mkdirSync(stateDir, { recursive: true });

    const specimen = createInitialState(projectSlug, SPRINT, workflowSteps(), featureBranchName(SPRINT, SLUG));
    markComplete(specimen.steps, 8);
    const s9 = step9(specimen);
    s9.status = "in-progress";
    s9.attempts = 1;
    s9.failures = [{
      attempt: 1,
      errorSummary: "gh pr merge: branch diverged",
      timestamp: "2026-07-06T00:00:00.000Z",
      hadPartialArtifacts: false,
    }];
    for (const s of specimen.steps) {
      if (s.step >= 10) {
        s.status = "complete";
        s.completedAt = "2026-07-06T00:00:00.000Z";
      }
    }
    specimen.status = "complete"; // the historical lie
    fs.writeFileSync(
      path.join(stateDir, `sprint-${SPRINT}.json`),
      JSON.stringify(specimen, null, 2)
    );

    const loaded = loadSprintState(projectSlug, SPRINT);
    expect(loaded).not.toBeNull();
    // No migration (spec Out of Scope): the historical record is preserved as-is.
    expect(loaded!.status).toBe("complete");
    expect(step9(loaded!).status).toBe("in-progress");
  });
});
