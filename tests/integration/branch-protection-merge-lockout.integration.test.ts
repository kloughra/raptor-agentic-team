/**
 * Integration tests — branch-protection-merge-lockout (Sprint 18)
 *
 * Spec:         docs/specs/branch-protection-merge-lockout.md (AC 1–12)
 * Architecture: docs/architecture/branch-protection-merge-lockout.md (C1–C8)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PRODUCTION SEAM (AC 11 / TEAM.md QA rule 12)
 * ─────────────────────────────────────────────────────────────────────────
 * The escalate-after-one behavior is asserted by driving the REAL step-9 merge
 * seams — the single-feature `runSprintFromStep` do/while loop AND the
 * multi-feature `runMergeStepForFeature` path (reached through the REAL
 * `runSprintFromStep` multi-feature dispatch, exactly as
 * review-gate-mutation-check drives it). There is NO test-local reimplementation
 * of the merge loop; assertions read the REAL attempt counter, the REAL
 * `failures[]` array, the REAL escalation status/reason/detail, and the REAL
 * `gh pr merge` invocation count.
 *
 * Mocking is confined to the two boundaries the architecture sanctions (identical
 * posture to push-before-merge.integration.test.ts):
 *   - `child_process.execFile` — the `gh` CLI only (PR detection + `gh pr merge`).
 *     PARTIAL mock: `child_process.spawn` is passed through untouched so
 *     simple-git performs the REAL pre-merge push against a REAL bare remote.
 *     executeMerge itself is NEVER mocked here — its `gh pr merge` refusal is the
 *     stimulus; the merge SEAM (runner) is the system under test.
 *   - `spawnAgent` — so shared steps never spawn real `claude` processes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RED-VERIFICATION NOTES (TEAM.md QA rule 12 — proven to FAIL pre-change)
 * ─────────────────────────────────────────────────────────────────────────
 * Pre-change (current `main`, 2026-07-15) both merge seams STAMP
 * `classifyFailure(errorSummary)` on the FailureRecord but NEVER consult it — a
 * branch-protection refusal therefore burns the full MAX_RETRY_ATTEMPTS (3):
 *   [SF]  single-feature seam "escalates after exactly one attempt": pre-change
 *         step9.attempts === 3, failures.length === 3, gh pr merge invoked 3×,
 *         escalationReason is undefined, and the message is "Merge failed after 3
 *         attempts: …" (names neither PR nor action) → the attempts===1 /
 *         reason==="user-actionable" / detail-names-PR+action asserts FAIL.
 *   [MF]  multi-feature seam "escalates after exactly one attempt": same, via
 *         runMergeStepForFeature — pre-change 3 attempts, no user-actionable
 *         reason, no escalationDetail → the attempts===1 asserts FAIL.
 *   [MSG] buildMergeLockoutEscalation does not exist pre-change → the import is a
 *         compile-time RED signal; the message-builder tests FAIL.
 *   [PR]  MergeResult.prNumber does not exist pre-change → the field is undefined
 *         → the prNumber-surfacing test FAILS.
 *   [CLS] the branch-protection regexes are not in USER_ACTIONABLE_ERROR_PATTERNS
 *         → classifyFailure returns "deterministic" for every specimen → the
 *         classification/resolveUserAction tests FAIL.
 *   [NOTE] deriveReason does not append escalationDetail pre-change → the
 *         notification-names-action test FAILS.
 * How to re-verify RED: `git stash` the Engineer's change (or revert
 * failure-classification.ts + merge.ts + runner.ts + state.ts + notifications.ts)
 * and re-run — every test tagged [RED:*] flips GREEN→RED.
 *
 * The AC 8 parity test is [no-regression] — it asserts a NON-branch-protection
 * merge failure still retries to MAX_RETRY_ATTEMPTS on the unchanged path (passes
 * both before and after). Its guard-RED is the opposite leak: it would FAIL if the
 * short-circuit were applied to ALL merge failures.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

// PARTIAL mock: replace execFile (gh), pass spawn (simple-git) through untouched.
jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process") as Record<string, unknown>;
  return { ...actual, execFile: jest.fn() };
});

// Keeps shared steps from spawning real claude processes.
jest.mock("../../src/orchestrator/agents", () => {
  const actual = jest.requireActual("../../src/orchestrator/agents") as Record<string, unknown>;
  return { __esModule: true, ...actual, spawnAgent: jest.fn() };
});

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import simpleGit, { SimpleGit } from "simple-git";

import { executeMerge, MergeResult } from "../../src/orchestrator/merge";
import {
  runSprintFromStep,
  MAX_RETRY_ATTEMPTS,
  // New in Sprint 18 (RED until implemented):
  buildMergeLockoutEscalation,
} from "../../src/orchestrator/runner";
import {
  classifyFailure,
  resolveUserAction,
  USER_ACTIONABLE_ERROR_PATTERNS,
  UserActionablePattern,
} from "../../src/orchestrator/failure-classification";
import { SPRINT_WORKFLOW } from "../../src/orchestrator/workflow";
import {
  createInitialState,
  saveSprintState,
  loadSprintState,
  SprintState,
  StepState,
  FeatureState,
} from "../../src/orchestrator/state";
import { featureBranchName, createFeatureStates } from "../../src/orchestrator/multi-runner";
import { deriveNotificationEvent } from "../../src/orchestrator/notifications";
import { spawnAgent, AgentResult } from "../../src/orchestrator/agents";

const execFileMock = execFile as unknown as jest.Mock;
const spawnAgentMock = spawnAgent as jest.MockedFunction<typeof spawnAgent>;

const SPRINT = 18;
const SLUG = "branch-protection-merge-lockout";
const SIBLING = "sibling-feature";
const BRANCH = featureBranchName(SPRINT, SLUG);
const PR_NUMBER = 42;

// ---------------------------------------------------------------------------
// Branch-protection specimens (spec AC 2). These are the seed specimens; the
// exact current-`gh` stderr must be confirmed empirically against a throwaway
// branch (Open Question 1) — the regex biases toward them without over-fitting.
// `actionContains` is the case-insensitive keyword the paired remediation names.
// ---------------------------------------------------------------------------
const BRANCH_PROTECTION_SPECIMENS: Array<{ label: string; stderr: string; actionContains: string }> = [
  {
    label: "base-branch policy",
    stderr: "pull request is not mergeable: the base branch policy prohibits the merge",
    actionContains: "unlock",
  },
  {
    label: "protected branch (update refused)",
    stderr: "protected branch update failed for refs/heads/main",
    actionContains: "unlock",
  },
  {
    label: "branch is protected",
    stderr: "refusing to update the branch: branch is protected",
    actionContains: "unlock",
  },
  {
    label: "locked base branch (lock_branch)",
    stderr: "GraphQL: main is a protected branch and cannot be merged (lock_branch enabled)",
    actionContains: "unlock",
  },
  {
    label: "required approving review",
    stderr: "GraphQL: At least 1 approving review is required by reviewers with write access",
    actionContains: "approve",
  },
  {
    label: "review required (short form)",
    stderr: "pull request is not mergeable: review required",
    actionContains: "approve",
  },
  {
    label: "code-owner review",
    stderr: "GraphQL: Changes must be approved by a code owner",
    actionContains: "approve",
  },
];

// The primary specimen used to drive the merge seams.
const LOCKOUT_STDERR = BRANCH_PROTECTION_SPECIMENS[0].stderr; // base-branch policy → "unlock" action

// A NON-branch-protection deterministic merge error for the parity path (AC 8):
// not billing, not transient (422 is not in the transient registry), not branch
// protection → classifies "deterministic" → the unchanged 3-attempt loop.
const ORDINARY_MERGE_STDERR = "failed to merge pull request: HTTP 422 unexpected server response";

// The bare-conflict string that must NOT be mis-escalated (C4).
const BARE_NOT_MERGEABLE = "Pull request is not mergeable";

// ---------------------------------------------------------------------------
// gh CLI (execFile) mock — the ONLY thing intercepted; simple-git stays real.
// ---------------------------------------------------------------------------

/** Every `gh pr merge` invocation recorded here (its argv). Length ⇒ merge attempts. */
let ghMergeInvocations: string[][] = [];

/**
 * Configure the mocked `gh` CLI.
 *  - prView: stdout `gh pr view` returns ("<num>\n<state>"), or null to make
 *    detection fail (→ executeMerge local fallback — not used here).
 *  - mergeError: if set, `gh pr merge` fails with this stderr; else it succeeds.
 */
function configureGh(opts: { prView: string | null; mergeError?: string }): void {
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const file = callArgs[0] as string;
    const args = callArgs[1] as string[];
    const callback = callArgs[3] as (err: Error | null, stdout: string, stderr: string) => void;

    if (file === "gh" && args[0] === "pr" && args[1] === "view") {
      const jsonIdx = args.indexOf("--json");
      const fields = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
      // updatePrDodChecklist asks for `body`; return empty → it resolves false.
      if (fields.includes("body")) {
        callback(null, "", "");
        return undefined;
      }
      // detectGitHubPR asks for `state,number`.
      if (opts.prView === null) {
        callback(new Error("no pull requests found"), "", "no pull requests found");
        return undefined;
      }
      callback(null, opts.prView, "");
      return undefined;
    }
    if (file === "gh" && args[0] === "pr" && args[1] === "merge") {
      ghMergeInvocations.push(args);
      if (opts.mergeError) {
        callback(new Error("merge failed"), "", opts.mergeError);
      } else {
        callback(null, "Merged", "");
      }
      return undefined;
    }
    callback(new Error(`unexpected execFile call: ${file} ${JSON.stringify(args)}`), "", "");
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakeHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-bpml-"));
  fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  jest.spyOn(os, "homedir").mockReturnValue(fakeHome);

  ghMergeInvocations = [];
  execFileMock.mockReset();
  spawnAgentMock.mockReset();
  spawnAgentMock.mockImplementation(async (role: string): Promise<AgentResult> => {
    return { output: `${role} step done`, exitCode: 0 };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function configureUser(git: SimpleGit): Promise<void> {
  await git.addConfig("user.name", "Vex Velociraptor");
  await git.addConfig("user.email", "vex@raptor.test");
}

/** Create a real, initialized bare remote and return its path. */
async function makeBareRemote(name: string): Promise<string> {
  const bare = path.join(tmpDir, `${name}.git`);
  fs.mkdirSync(bare, { recursive: true });
  await simpleGit(bare).init(["--bare"]);
  return bare;
}

/** Write a file, stage, commit. */
async function commitFile(
  git: SimpleGit,
  projectPath: string,
  file: string,
  content: string,
  message: string
): Promise<void> {
  const full = path.join(projectPath, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  await git.add(file);
  await git.commit(message);
}

function workflowSteps() {
  return SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name }));
}

function markComplete(steps: StepState[], through: number): void {
  for (const s of steps) {
    if (s.step <= through) {
      s.status = "complete";
      s.completedAt = "2026-07-15T00:00:00.000Z";
      s.attempts = 1;
    }
  }
}

/**
 * Real SINGLE-feature project parked at step 9 (steps 1–8 complete), on a real
 * feature branch already pushed to a real bare `origin` so the pre-merge push is
 * a no-op SUCCESS every attempt — the ONLY failure comes from the mocked
 * `gh pr merge`. This isolates the merge-refusal classification, not the push.
 */
async function seedSingleFeatureAtStep9(projectSlug: string): Promise<string> {
  const projectPath = path.join(tmpDir, projectSlug);
  fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, "docs", "backlog.md"),
    `# Backlog\n\n## Sprint ${SPRINT}\n- [ ] ${SLUG}: ${SLUG} feature work\n\n## Ready\n\n## Inbox\n\n## Done\n`
  );
  const git = simpleGit(projectPath);
  await git.init();
  await configureUser(git);
  await git.add(".");
  await git.commit("[PO] add: sprint backlog");
  await git.raw(["branch", "-M", "main"]);
  await git.checkoutLocalBranch(BRANCH);
  await commitFile(git, projectPath, "docs/specs/s.md", "s\n", "[ENGINEER] add: work");

  const remote = await makeBareRemote(`${projectSlug}-remote`);
  await git.addRemote("origin", remote);
  await git.push(["origin", BRANCH]); // branch on remote → pre-merge push is a no-op success

  const state = createInitialState(projectSlug, SPRINT, workflowSteps(), BRANCH);
  markComplete(state.steps, 8);
  state.currentStep = 9;
  saveSprintState(projectSlug, SPRINT, state);
  return projectPath;
}

/**
 * Real MULTI-feature project: the feature-under-test parked at step 9 (steps 1–8
 * complete), the sibling fully complete. TWO features force the multi-feature
 * dispatch path so the REAL `runMergeStepForFeature` seam runs (mirrors
 * review-gate-mutation-check's seedMultiFeature). The under-test feature branch
 * is pushed to a real bare `origin` so its pre-merge push is a no-op success.
 */
async function seedMultiFeatureAtStep9(projectSlug: string): Promise<string> {
  const projectPath = path.join(tmpDir, projectSlug);
  fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, "docs", "backlog.md"),
    `# Backlog\n\n## Sprint ${SPRINT}\n- [ ] ${SLUG}: work\n- [ ] ${SIBLING}: sibling\n\n## Ready\n\n## Inbox\n\n## Done\n`
  );
  const git = simpleGit(projectPath);
  await git.init();
  await configureUser(git);
  await git.add(".");
  await git.commit("[PO] add: sprint backlog");
  await git.raw(["branch", "-M", "main"]);

  const utBranch = featureBranchName(SPRINT, SLUG);
  await git.checkoutLocalBranch(utBranch);
  await commitFile(git, projectPath, "docs/specs/ut.md", "ut\n", "[ENGINEER] add: work");
  const remote = await makeBareRemote(`${projectSlug}-remote`);
  await git.addRemote("origin", remote);
  await git.push(["origin", utBranch]);
  await git.checkout("main"); // leave the repo on main

  const state = createInitialState(projectSlug, SPRINT, workflowSteps(), null);
  const features = createFeatureStates([SLUG, SIBLING], SPRINT);
  for (const f of features) {
    if (f.slug === SLUG) {
      markComplete(f.steps, 8);
      f.currentStep = 9;
      f.status = "in-progress";
    } else {
      for (const s of f.steps) {
        s.status = "complete";
        s.attempts = 1;
      }
      f.currentStep = 10;
      f.status = "complete";
    }
  }
  (state as SprintState).features = features;
  state.currentFeatureSlug = SLUG;
  state.currentStep = 9;
  saveSprintState(projectSlug, SPRINT, state);
  return projectPath;
}

function step9Of(steps: StepState[]): StepState {
  return steps.find((s) => s.step === 9)!;
}

function underTestFeature(state: SprintState): FeatureState {
  return (state.features as FeatureState[]).find((f) => f.slug === SLUG)!;
}

// ===========================================================================
// AC 1, 2, 12 — the branch-protection signatures classify user-actionable
// ===========================================================================

describe("classifyFailure + resolveUserAction — branch-protection specimens (AC 1, 2)", () => {
  it.each(BRANCH_PROTECTION_SPECIMENS)(
    "[RED:CLS] classifies '$label' as user-actionable and names its action",
    ({ stderr, actionContains }) => {
      expect(classifyFailure(stderr)).toBe("user-actionable");
      const action = resolveUserAction(stderr);
      expect(action).not.toBeNull();
      expect(action!.toLowerCase()).toContain(actionContains);
    }
  );

  it("[RED:CLS/C4] does NOT classify the bare 'not mergeable' conflict string as user-actionable", () => {
    // C4: a genuine conflict/divergence (push-before-merge's domain) also emits
    // "not mergeable"; matching it would mis-escalate a resolvable conflict.
    expect(classifyFailure(BARE_NOT_MERGEABLE)).not.toBe("user-actionable");
    expect(resolveUserAction(BARE_NOT_MERGEABLE)).toBeNull();
  });

  it("no-regression: the billing seed still classifies user-actionable (AC 1)", () => {
    expect(classifyFailure("You've hit your monthly spend limit")).toBe("user-actionable");
  });

  it("no-regression: an ordinary deterministic merge error is NOT user-actionable (AC 8 basis)", () => {
    expect(classifyFailure(ORDINARY_MERGE_STDERR)).not.toBe("user-actionable");
    expect(resolveUserAction(ORDINARY_MERGE_STDERR)).toBeNull();
  });
});

// ===========================================================================
// AC 12 — registry stays deterministic & code-only
// ===========================================================================

describe("USER_ACTIONABLE_ERROR_PATTERNS registry contract (AC 12)", () => {
  it("[RED:CLS] contains at least one branch-protection entry beyond the billing seed", () => {
    const bp = USER_ACTIONABLE_ERROR_PATTERNS.filter((e) =>
      BRANCH_PROTECTION_SPECIMENS.some((s) => e.pattern.test(s.stderr))
    );
    expect(bp.length).toBeGreaterThanOrEqual(1);
  });

  it("every entry is a non-/g RegExp paired with a non-empty action (determinism, AC 12)", () => {
    for (const entry of USER_ACTIONABLE_ERROR_PATTERNS as UserActionablePattern[]) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(entry.pattern.flags).not.toContain("g"); // stateful lastIndex → non-deterministic
      expect(typeof entry.action).toBe("string");
      expect(entry.action.trim().length).toBeGreaterThan(0);
    }
  });

  it("classification is repeatable across successive calls (NFR-1 no /g drift)", () => {
    for (const { stderr } of BRANCH_PROTECTION_SPECIMENS) {
      expect(classifyFailure(stderr)).toBe(classifyFailure(stderr));
    }
  });
});

// ===========================================================================
// buildMergeLockoutEscalation — the shared pure message builder (AC 5, C2)
// ===========================================================================

describe("buildMergeLockoutEscalation — actionable message (AC 5, C2)", () => {
  const action = "Unlock `main` (branch protection is blocking the squash-merge) or merge the PR manually.";

  it("[RED:MSG] names the PR number, the action, and the last error", () => {
    const msg = buildMergeLockoutEscalation(PR_NUMBER, action, LOCKOUT_STDERR);
    expect(msg).toContain(String(PR_NUMBER));
    expect(msg).toContain(action);
    expect(msg).toContain(LOCKOUT_STDERR);
  });

  it("[RED:MSG] omits a PR reference gracefully when the PR number is absent (local/no-PR path)", () => {
    const msg = buildMergeLockoutEscalation(null, action, LOCKOUT_STDERR);
    // No stray "PR #null"/"PR #undefined" — still names the action.
    expect(msg).not.toMatch(/#(null|undefined)/);
    expect(msg).toContain(action);
  });

  it("[RED:MSG/C2] is byte-identical for identical inputs (both seams call the SAME builder)", () => {
    const a = buildMergeLockoutEscalation(PR_NUMBER, action, LOCKOUT_STDERR);
    const b = buildMergeLockoutEscalation(PR_NUMBER, action, LOCKOUT_STDERR);
    expect(a).toBe(b);
  });
});

// ===========================================================================
// Open Question 2 — MergeResult carries the PR number on the failure path
// ===========================================================================

describe("MergeResult.prNumber surfacing (OQ2)", () => {
  it("[RED:PR] populates prNumber on the open-PR merge-refusal path", async () => {
    const projectSlug = "pr-surface";
    const projectPath = await seedSingleFeatureAtStep9(projectSlug);
    configureGh({ prView: `${PR_NUMBER}\nopen`, mergeError: LOCKOUT_STDERR });

    const result: MergeResult = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    expect(result.success).toBe(false);
    expect(result.method).toBe("github");
    expect(result.prNumber).toBe(PR_NUMBER);
    expect(result.error).toContain("policy"); // the refusal text is preserved
  });
});

// ===========================================================================
// AC 3, 5, 7, 10 — SINGLE-feature merge seam escalates after EXACTLY ONE attempt
// ===========================================================================

describe("single-feature merge seam: escalate-after-one (AC 3, 5, 7, 10)", () => {
  it("[RED:SF] a branch-protection refusal escalates on the first attempt with an actionable, PR-naming message", async () => {
    const projectSlug = "sf-lockout";
    const projectPath = await seedSingleFeatureAtStep9(projectSlug);
    configureGh({ prView: `${PR_NUMBER}\nopen`, mergeError: LOCKOUT_STDERR });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    const step9 = step9Of(result.state.steps);

    // AC 3: exactly ONE merge attempt, ONE failure record (pre-change: 3 / 3).
    expect(ghMergeInvocations).toHaveLength(1);
    expect(step9.attempts).toBe(1);
    expect(step9.failures).toHaveLength(1);

    // AC 10: the classification (+ signature) is stamped on the record as today.
    expect(step9.failures[0].classification).toBe("user-actionable");
    expect(typeof step9.failures[0].signature).toBe("string");

    // AC 5/7: escalated with the distinct user-actionable reason.
    expect(step9.status).toBe("escalated");
    expect(step9.escalationReason).toBe("user-actionable");
    expect(result.status).toBe("escalated");
    expect(result.state.status).toBe("escalated");

    // AC 5: the surfaced message names the PR and the concrete human action.
    const expectedAction = resolveUserAction(LOCKOUT_STDERR)!;
    expect(result.message).toContain(String(PR_NUMBER));
    expect(result.message.toLowerCase()).toContain("unlock");
    expect(result.message).toContain(expectedAction);

    // Shared steps 10–13 never began; no agent was spawned.
    expect(spawnAgentMock).not.toHaveBeenCalled();
    for (const s of result.state.steps.filter((st) => st.step >= 10)) {
      expect(s.status).toBe("pending");
    }

    // An [ESCALATE] commit was created (durable, best-effort).
    const subjects = (await simpleGit(projectPath).log()).all.map((l) => l.message);
    expect(subjects.some((m) => m.includes("[ESCALATE]"))).toBe(true);
  });
});

// ===========================================================================
// AC 5, 6 — the actionable detail is persisted and rides the notification
// ===========================================================================

describe("persisted actionable detail + notification (AC 5, 6, NFR-4)", () => {
  it("[RED:SF] step 9 escalationDetail is persisted to sprint-N.json naming the PR + action", async () => {
    const projectSlug = "sf-persist";
    const projectPath = await seedSingleFeatureAtStep9(projectSlug);
    configureGh({ prView: `${PR_NUMBER}\nopen`, mergeError: LOCKOUT_STDERR });

    await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    // NFR-4: read it back from disk — persist-before-yield.
    const persisted = loadSprintState(projectSlug, SPRINT)!;
    expect(persisted.status).toBe("escalated");
    const step9 = step9Of(persisted.steps);
    expect(step9.escalationReason).toBe("user-actionable");
    expect(typeof step9.escalationDetail).toBe("string");
    expect(step9.escalationDetail!).toContain(String(PR_NUMBER));
    expect(step9.escalationDetail!).toContain(resolveUserAction(LOCKOUT_STDERR)!);
  });

  it("[RED:NOTE] a notification derived from persisted state names the human action (AC 6)", async () => {
    const projectSlug = "sf-notify";
    const projectPath = await seedSingleFeatureAtStep9(projectSlug);
    configureGh({ prView: `${PR_NUMBER}\nopen`, mergeError: LOCKOUT_STDERR });

    await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    const persisted = loadSprintState(projectSlug, SPRINT)!;
    // notification-egress derives its payload EXCLUSIVELY from persisted state.
    const event = deriveNotificationEvent(persisted, {
      projectSlug,
      occurredAt: "2026-07-15T00:00:00.000Z",
    });
    expect(event).not.toBeNull();
    expect(event!.event).toBe("escalation");
    expect(event!.reason).not.toBeNull();
    // The reason surfaces the concrete action (escalationDetail), not just "step 9".
    expect(event!.reason!.toLowerCase()).toContain("unlock");
  });
});

// ===========================================================================
// AC 4 — MULTI-feature merge seam escalates after EXACTLY ONE attempt
// ===========================================================================

describe("multi-feature merge seam: escalate-after-one at runMergeStepForFeature (AC 4)", () => {
  it("[RED:MF] a branch-protection refusal escalates the feature on the first attempt", async () => {
    const projectSlug = "mf-lockout";
    const projectPath = await seedMultiFeatureAtStep9(projectSlug);
    configureGh({ prView: `${PR_NUMBER}\nopen`, mergeError: LOCKOUT_STDERR });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    const feature = underTestFeature(result.state);
    const step9 = step9Of(feature.steps);

    // AC 4: identical escalate-after-one behavior at the multi-feature seam.
    expect(ghMergeInvocations).toHaveLength(1);
    expect(step9.attempts).toBe(1);
    expect(step9.failures).toHaveLength(1);
    expect(step9.failures[0].classification).toBe("user-actionable");

    expect(step9.status).toBe("escalated");
    expect(step9.escalationReason).toBe("user-actionable");
    expect(feature.status).toBe("escalated");
    expect(result.state.status).toBe("escalated");

    // AC 5/6: the feature's persisted escalationDetail names the PR + action.
    expect(typeof step9.escalationDetail).toBe("string");
    expect(step9.escalationDetail!).toContain(String(PR_NUMBER));
    expect(step9.escalationDetail!).toContain(resolveUserAction(LOCKOUT_STDERR)!);
  });
});

// ===========================================================================
// AC 8 — non-branch-protection merge failures are UNCHANGED (parity)
// ===========================================================================

describe("parity: ordinary merge failures still retry to the cap (AC 8)  [no-regression]", () => {
  it("[GUARD-RED] an ordinary deterministic merge failure retries to MAX_RETRY_ATTEMPTS and never sets a lockout detail", async () => {
    const projectSlug = "parity-ordinary";
    const projectPath = await seedSingleFeatureAtStep9(projectSlug);
    configureGh({ prView: `${PR_NUMBER}\nopen`, mergeError: ORDINARY_MERGE_STDERR });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    const step9 = step9Of(result.state.steps);
    // Unchanged bounded loop: 3 attempts, 3 failures, 3 gh pr merge invocations.
    expect(ghMergeInvocations).toHaveLength(MAX_RETRY_ATTEMPTS);
    expect(step9.attempts).toBe(MAX_RETRY_ATTEMPTS);
    expect(step9.failures).toHaveLength(MAX_RETRY_ATTEMPTS);

    // NOT the user-actionable short-circuit — distinct from the lockout escalation.
    for (const f of step9.failures) {
      expect(f.classification).not.toBe("user-actionable");
    }
    expect(step9.escalationReason).not.toBe("user-actionable");
    expect(step9.escalationDetail).toBeUndefined();
    expect(step9.status).toBe("escalated");
    expect(result.status).toBe("escalated");
    // GUARD-RED: if the short-circuit leaked to ALL merge failures, ghMergeInvocations
    // would be 1 (not MAX_RETRY_ATTEMPTS) and classification would be user-actionable.
  });
});
