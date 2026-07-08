/**
 * Integration tests — push-before-merge (Sprint 15)
 *
 * Spec:         docs/specs/push-before-merge.md (AC 1–10)
 * Architecture: docs/architecture/push-before-merge.md (C1–C4)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PRODUCTION SEAM (AC #9 / TEAM.md QA rule 12)
 * ─────────────────────────────────────────────────────────────────────────
 * Every constraint-guarding test in this file drives the REAL `executeMerge`
 * (and, for the retry-accounting test, the REAL `runSprintFromStep` step-9
 * loop). There is NO test-local reimplementation of the push. The push runs
 * against REAL git repositories with REAL bare remotes via simple-git, exactly
 * as the spec/architecture mandate ("stubbing the gh merge execFile and the
 * remote, as integration tests do for git").
 *
 * Mocking is confined to the two boundaries the architecture sanctions:
 *   - `child_process.execFile` — the `gh` CLI calls only (PR detection + the
 *     `gh pr merge` invocation). We do a PARTIAL mock: execFile is replaced,
 *     but `child_process.spawn` is passed through untouched, so simple-git —
 *     which shells git via `spawn`, never `execFile` — performs REAL pushes,
 *     merges, and clones. Do NOT widen this to mock `spawn` or `simple-git`:
 *     that would neuter the entire regression (the real push is the feature).
 *   - `spawnAgent` — only for the runner-seam test, so shared steps 10–13 do
 *     not spawn real `claude` processes. (executeMerge itself is NEVER mocked
 *     here — it is the system under test.)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RED-VERIFICATION NOTES (TEAM.md QA rule 12 — proven to FAIL pre-change)
 * ─────────────────────────────────────────────────────────────────────────
 * The current `executeMerge` (src/orchestrator/merge.ts) does NOT push before
 * `gh pr merge` (verified against `main`, 2026-07-07). Each constraint-guarding
 * test below is RED against that pre-change code because:
 *   [A] "pushes local-only commits": pre-change never pushes → the remote head
 *       stays behind the local head → the remote-contains-local-commit assert
 *       FAILS.
 *   [B] "failing push → no merge": pre-change never pushes and calls the (mock-
 *       succeeding) `gh pr merge` → returns success:true and records a merge
 *       invocation → the success:false / merge-never-invoked asserts FAIL.
 *   [C] "force-push hazard": pre-change never pushes and merges → success:true,
 *       merge invoked → the clean-fail / no-force asserts FAIL.
 *   [S] runner-seam "push failure escalates": pre-change merges successfully on
 *       attempt 1 (no push) → step 9 completes, no escalation, gh pr merge
 *       invoked, shared steps spawn agents → the escalation asserts FAIL.
 * How verified: revert C1 (remove the pre-merge push from `mergeViaGitHub`) and
 * re-run — the four tests above go from GREEN to RED.
 *
 * The AC #4/#6/#7 tests are [no-regression] — they assert the non-open-PR paths
 * NEVER push, and pass both before AND after the change. There is no optional
 * config gating this feature (it is unconditional on the open-PR path), so
 * TEAM.md QA rule 13's default-off parity test does not apply; the closest
 * analog — proving the unchanged paths stay push-free — is those three tests.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

// PARTIAL mock: replace execFile (gh), pass spawn (simple-git) through untouched.
jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process") as Record<string, unknown>;
  return { ...actual, execFile: jest.fn() };
});

// Only for the runner-seam test — keeps shared steps 10–13 from spawning claude.
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
import { runSprintFromStep, MAX_RETRY_ATTEMPTS } from "../../src/orchestrator/runner";
import { SPRINT_WORKFLOW } from "../../src/orchestrator/workflow";
import {
  createInitialState,
  saveSprintState,
  loadSprintState,
  SprintState,
  StepState,
} from "../../src/orchestrator/state";
import { featureBranchName } from "../../src/orchestrator/multi-runner";
import { spawnAgent, AgentResult } from "../../src/orchestrator/agents";

const execFileMock = execFile as unknown as jest.Mock;
const spawnAgentMock = spawnAgent as jest.MockedFunction<typeof spawnAgent>;

const SPRINT = 1;
const SLUG = "widget-export";
const BRANCH = featureBranchName(SPRINT, SLUG); // e.g. "sprint-1/widget-export"

// ---------------------------------------------------------------------------
// gh CLI (execFile) mock — the ONLY thing intercepted; simple-git stays real.
// ---------------------------------------------------------------------------

/** Every `gh pr merge` invocation recorded here (its argv). Length 0 ⇒ never merged. */
let ghMergeInvocations: string[][] = [];

/**
 * Configure the mocked `gh` CLI.
 *  - prView: the stdout `gh pr view` returns ("<num>\n<state>"), or null to make
 *    detection fail (→ executeMerge local fallback).
 *  - mergeError: if set, `gh pr merge` fails with this stderr; else it succeeds.
 */
function configureGh(opts: { prView: string | null; mergeError?: string }): void {
  // Loosely typed to satisfy jest's UnknownFunction mock signature; merge.ts
  // always calls execFile("gh", string[], options, (err, stdout, stderr) => …).
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const file = callArgs[0] as string;
    const args = callArgs[1] as string[];
    const callback = callArgs[3] as (
      err: Error | null,
      stdout: string,
      stderr: string
    ) => void;

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-push-before-merge-"));
  fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  // Sandbox ~/.raptor for the runner-seam test (state files).
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

/** Create a real project git repo with an initial commit on `main`. */
async function makeProject(name: string): Promise<{ projectPath: string; git: SimpleGit }> {
  const projectPath = path.join(tmpDir, name);
  fs.mkdirSync(projectPath, { recursive: true });
  const git = simpleGit(projectPath);
  await git.init();
  await configureUser(git);
  fs.writeFileSync(path.join(projectPath, "README.md"), "# test project\n");
  await git.add(".");
  await git.commit("initial commit");
  await git.raw(["branch", "-M", "main"]); // deterministic default branch
  return { projectPath, git };
}

/** Write a file, stage, commit, and return the new HEAD sha. */
async function commitFile(
  git: SimpleGit,
  projectPath: string,
  file: string,
  content: string,
  message: string
): Promise<string> {
  const full = path.join(projectPath, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  await git.add(file);
  await git.commit(message);
  return (await git.revparse(["HEAD"])).trim();
}

/** rev-parse a ref in any repo (including a bare remote); null if the ref is absent. */
async function refSha(repoPath: string, ref: string): Promise<string | null> {
  try {
    return (await simpleGit(repoPath).revparse([ref])).trim();
  } catch {
    return null;
  }
}

// ===========================================================================
// AC #1 — push precedes the GitHub merge (the Sprint 12 regression)
// ===========================================================================

describe("open-PR path: pre-merge push (AC #1, #10)", () => {
  it("[RED:A] pushes local-only commits to the remote before invoking gh pr merge", async () => {
    const remote = await makeBareRemote("A-remote");
    const { projectPath, git } = await makeProject("A");
    await git.addRemote("origin", remote);
    await git.checkoutLocalBranch(BRANCH);

    // Commit c1 and push it — the remote branch now exists at c1.
    const c1 = await commitFile(git, projectPath, "docs/specs/a.md", "c1\n", "[ENGINEER] add: c1");
    await git.push(["origin", BRANCH]);
    expect(await refSha(remote, BRANCH)).toBe(c1);

    // Commit c2 LOCALLY ONLY — this is the demo/retro commit that Sprint 12 lost.
    const c2 = await commitFile(git, projectPath, "docs/demo.md", "c2\n", "[TEAM] demo notes");
    expect(await refSha(remote, BRANCH)).toBe(c1); // remote still behind — precondition

    configureGh({ prView: "7\nopen" }); // open PR, merge succeeds

    const result = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    expect(result.success).toBe(true);
    expect(result.method).toBe("github");
    // AC #1: the remote branch now contains the previously-unpushed local commit.
    expect(await refSha(remote, BRANCH)).toBe(c2);
    // The merge ran exactly once, AFTER the push (AC #1 ordering; C3).
    expect(ghMergeInvocations).toHaveLength(1);
  });

  it("[no-regression] a branch already in sync pushes as a no-op and merges normally (edge case)", async () => {
    const remote = await makeBareRemote("sync-remote");
    const { projectPath, git } = await makeProject("sync");
    await git.addRemote("origin", remote);
    await git.checkoutLocalBranch(BRANCH);
    const head = await commitFile(git, projectPath, "docs/specs/s.md", "s\n", "[ENGINEER] add: s");
    await git.push(["origin", BRANCH]); // fully in sync
    expect(await refSha(remote, BRANCH)).toBe(head);

    configureGh({ prView: "7\nopen" });

    const result = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    expect(result.success).toBe(true);
    expect(ghMergeInvocations).toHaveLength(1);
    // No-op push leaves the (already-equal) remote unchanged.
    expect(await refSha(remote, BRANCH)).toBe(head);
  });
});

// ===========================================================================
// AC #2, #8, #9 — a failing push fails cleanly and NEVER merges
// ===========================================================================

describe("open-PR path: push failure fails the attempt cleanly (AC #2, #8, #9)", () => {
  it("[RED:B] returns success:false and never invokes gh pr merge when the push fails", async () => {
    const { projectPath, git } = await makeProject("B");
    await git.checkoutLocalBranch(BRANCH);
    await commitFile(git, projectPath, "docs/specs/b.md", "b\n", "[ENGINEER] add: b");
    // Point origin at a path that is not a repository → the push fails.
    await git.addRemote("origin", path.join(tmpDir, "does-not-exist.git"));

    configureGh({ prView: "7\nopen" }); // if the merge were reached it would succeed

    const result = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    // AC #2: clean structured failure — executeMerge must not throw.
    expect(result.success).toBe(false);
    expect(result.method).toBe("github");
    // AC #9: the merge command is NEVER invoked on a push failure.
    expect(ghMergeInvocations).toHaveLength(0);
  });

  it("[RED:B] the push-failure error names the failure as a push failure and names the branch (AC #8)", async () => {
    const { projectPath, git } = await makeProject("B-err");
    await git.checkoutLocalBranch(BRANCH);
    await commitFile(git, projectPath, "docs/specs/b.md", "b\n", "[ENGINEER] add: b");
    await git.addRemote("origin", path.join(tmpDir, "nope.git"));

    configureGh({ prView: "7\nopen" });

    const result = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // Distinguishable from a `gh pr merge` rejection (AC #8).
    expect(result.error!.toLowerCase()).toContain("push");
    expect(result.error).toContain(BRANCH);
  });

  it("does not throw even when the push fails (AC #2 — never-throws contract)", async () => {
    const { projectPath, git } = await makeProject("B-throws");
    await git.checkoutLocalBranch(BRANCH);
    await commitFile(git, projectPath, "docs/specs/b.md", "b\n", "[ENGINEER] add: b");
    await git.addRemote("origin", path.join(tmpDir, "still-nope.git"));

    configureGh({ prView: "7\nopen" });

    await expect(executeMerge(projectPath, SLUG, SPRINT, BRANCH)).resolves.toMatchObject({
      success: false,
      method: "github",
    });
  });
});

// ===========================================================================
// AC #5 — safe push only, no force; genuine divergence fails cleanly
// ===========================================================================

describe("open-PR path: safe push only — never force (AC #5)", () => {
  it("[RED:C] a remote-ahead divergence fails the push without rewriting remote history", async () => {
    const remote = await makeBareRemote("C-remote");
    const { projectPath, git } = await makeProject("C");
    await git.addRemote("origin", remote);
    await git.checkoutLocalBranch(BRANCH);
    const c1 = await commitFile(git, projectPath, "docs/specs/c.md", "c1\n", "[ENGINEER] add: c1");
    await git.push(["origin", BRANCH]);
    expect(await refSha(remote, BRANCH)).toBe(c1);

    // A collaborator advances the REMOTE branch (c1 → c2) so the remote is ahead.
    const collab = path.join(tmpDir, "C-collab");
    await simpleGit().clone(remote, collab);
    const cg = simpleGit(collab);
    await configureUser(cg);
    await cg.checkout(BRANCH);
    const c2 = await commitFile(cg, collab, "docs/collab.md", "c2\n", "[OTHER] add: c2");
    await cg.push(["origin", BRANCH]);
    expect(await refSha(remote, BRANCH)).toBe(c2); // remote is now ahead of local

    // The project makes its OWN divergent commit (c1 → c3). Local ≠ remote,
    // and the push cannot fast-forward → it must be rejected (no force).
    await commitFile(git, projectPath, "docs/specs/c-more.md", "c3\n", "[ENGINEER] add: c3");

    configureGh({ prView: "7\nopen" });

    const result = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    // AC #2 + #5: clean fail, merge never invoked, remote history untouched.
    expect(result.success).toBe(false);
    expect(result.error!.toLowerCase()).toContain("push");
    expect(ghMergeInvocations).toHaveLength(0);
    // The orchestrator never force-updated the remote — still the collaborator's c2.
    expect(await refSha(remote, BRANCH)).toBe(c2);
  });
});

// ===========================================================================
// AC #4, #6, #7 — non-open-PR paths NEVER push  [no-regression]
// ===========================================================================

describe("non-open-PR paths never push (AC #4, #6, #7)", () => {
  it("[no-regression] no-GitHub-PR falls back to local git merge and attempts no push (AC #4)", async () => {
    const remote = await makeBareRemote("D-remote"); // exists, but must NOT be pushed to
    const { projectPath, git } = await makeProject("D");
    await git.addRemote("origin", remote);
    await git.checkoutLocalBranch(BRANCH);
    await commitFile(git, projectPath, "docs/specs/d.md", "d\n", "[ENGINEER] add: d");

    configureGh({ prView: null }); // detectGitHubPR → null → local fallback

    const result = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    expect(result.success).toBe(true);
    expect(result.method).toBe("local");
    expect(ghMergeInvocations).toHaveLength(0);
    // No push happened: the remote never received the feature branch.
    expect(await refSha(remote, BRANCH)).toBeNull();
  });

  it("[no-regression] an already-merged PR short-circuits without pushing (AC #6)", async () => {
    const remote = await makeBareRemote("E-remote");
    const { projectPath, git } = await makeProject("E");
    await git.addRemote("origin", remote);
    await git.checkoutLocalBranch(BRANCH);
    await commitFile(git, projectPath, "docs/specs/e.md", "e\n", "[ENGINEER] add: e");

    configureGh({ prView: "7\nmerged" }); // → detectGitHubPR returns negative

    const result = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    expect(result.success).toBe(true);
    expect(result.alreadyMerged).toBe(true);
    expect(ghMergeInvocations).toHaveLength(0);
    // No push on the already-merged path — remote never received the branch.
    expect(await refSha(remote, BRANCH)).toBeNull();
  });

  it("[no-regression] a PR closed-without-merge returns the existing failure without pushing (AC #7)", async () => {
    const remote = await makeBareRemote("F-remote");
    const { projectPath, git } = await makeProject("F");
    await git.addRemote("origin", remote);
    await git.checkoutLocalBranch(BRANCH);
    await commitFile(git, projectPath, "docs/specs/f.md", "f\n", "[ENGINEER] add: f");

    configureGh({ prView: "7\nclosed" }); // → detectGitHubPR returns 0

    const result = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    expect(result.success).toBe(false);
    expect(result.method).toBe("github");
    expect((result.error ?? "").toLowerCase()).toContain("closed");
    expect(ghMergeInvocations).toHaveLength(0);
    expect(await refSha(remote, BRANCH)).toBeNull();
  });
});

// ===========================================================================
// AC #3 — push failure feeds the EXISTING step-9 retry/escalation loop
//        (drives the REAL runner step-9 seam with the REAL executeMerge)
// ===========================================================================

function workflowSteps() {
  return SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name }));
}

function markComplete(steps: StepState[], through: number): void {
  for (const s of steps) {
    if (s.step <= through) {
      s.status = "complete";
      s.completedAt = "2026-07-07T00:00:00.000Z";
      s.attempts = 1;
    }
  }
}

/**
 * Real single-feature project parked at step 9 (steps 1–8 complete), on a real
 * feature branch, with a bogus `origin` so the pre-merge push fails every time.
 */
async function seedRunnerAtStep9(projectSlug: string): Promise<string> {
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
  // Bogus remote → the real pre-merge push fails deterministically each attempt.
  await git.addRemote("origin", path.join(tmpDir, `${projectSlug}-missing.git`));

  const state = createInitialState(projectSlug, SPRINT, workflowSteps(), BRANCH);
  markComplete(state.steps, 8);
  state.currentStep = 9;
  saveSprintState(projectSlug, SPRINT, state);
  return projectPath;
}

describe("runner seam: push failure is accounted by the existing retry loop (AC #3)", () => {
  it("[RED:S] escalates after MAX_RETRY_ATTEMPTS push failures, never merging and never running shared steps", async () => {
    const projectSlug = "seam-escalate";
    const projectPath = await seedRunnerAtStep9(projectSlug);
    configureGh({ prView: "7\nopen" }); // open PR every attempt; push (real) fails each time

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 9);

    const step9 = result.state.steps.find((s) => s.step === 9)!;
    // AC #3: each push failure incremented attempts + appended one failure record.
    expect(step9.attempts).toBe(MAX_RETRY_ATTEMPTS);
    expect(step9.failures).toHaveLength(MAX_RETRY_ATTEMPTS);
    for (const f of step9.failures) {
      expect(f.errorSummary.toLowerCase()).toContain("push");
    }
    // Escalated cleanly at the cap via the EXISTING loop (no new path).
    expect(step9.status).toBe("escalated");
    expect(result.status).toBe("escalated");
    expect(result.state.status).toBe("escalated");

    // AC #2/#9 at the seam: gh pr merge NEVER ran, shared steps 10–13 never began.
    expect(ghMergeInvocations).toHaveLength(0);
    expect(spawnAgentMock).not.toHaveBeenCalled();
    for (const s of result.state.steps.filter((st) => st.step >= 10)) {
      expect(s.status).toBe("pending");
    }

    // The escalation is durable and an [ESCALATE] commit was created.
    expect(loadSprintState(projectSlug, SPRINT)!.status).toBe("escalated");
    const subjects = (await simpleGit(projectPath).log()).all.map((l) => l.message);
    expect(subjects.some((m) => m.includes("[ESCALATE]") && m.includes("Merge PR"))).toBe(true);
  });
});
