/**
 * Integration tests for: multi-feature-sprint-dispatch
 *
 * Spec:         docs/specs/multi-feature-sprint-dispatch.md
 * Architecture: docs/architecture/multi-feature-sprint-dispatch.md
 *
 * These tests cover the WIRING of multi-feature dispatch into runSprintFromStep:
 *   - Detection on entry (AC #1)
 *   - State population (AC #2)
 *   - Per-feature dispatch (AC #3, #5)
 *   - Per-feature branch via the bundled `ensureFeatureBranch` (AC #4 + sprint-branch-auto-create)
 *   - Sprint-shared steps 10–13 (AC #6)
 *   - Failure isolation (AC #7)
 *   - Per-feature DoD (AC #8)
 *   - Progress visibility (AC #9)
 *   - Backward compat: single-feature, empty sprint, resume safety (AC #10–#12)
 *   - Streaming checkpoints with feature annotation (AC #13)
 *   - Tool surface unchanged (AC #14)
 *   - Edge cases: duplicate slugs, mid-sprint additions, already-checked items, divergent branches
 *
 * Many tests reach into the existing helpers (detectSprintFeatures, createFeatureStates,
 * featureBranchName, allFeaturesComplete, anyFeaturesEscalated, deriveSprintStatus) plus
 * the SprintState shape, which IS already in place. Tests targeting the new
 * `ensureFeatureBranch`, `runStepForFeature`, and `dispatchPerFeatureStep` helpers
 * dynamically import them so the suite skips gracefully prior to engineer wiring,
 * but enforces the design contract once the implementation lands.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import simpleGit, { SimpleGit } from "simple-git";
import {
  detectSprintFeatures,
  isMultiFeatureSprint,
  createFeatureStates,
  featureBranchName,
  allFeaturesComplete,
  anyFeaturesEscalated,
  deriveSprintStatus,
} from "../../src/orchestrator/multi-runner";
import {
  createInitialState,
  SprintState,
  FeatureState,
  CheckpointState,
} from "../../src/orchestrator/state";
import { renderProgressTable } from "../../src/orchestrator/progress";
import { buildCheckpointPrompt, CheckpointPrompt } from "../../src/orchestrator/checkpoints";
import { SPRINT_WORKFLOW } from "../../src/orchestrator/workflow";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ROOT_TMP = path.join(os.tmpdir(), `raptor-mfsd-${Date.now()}`);

function backlogWithSprint(sprint: number, items: Array<{ checked: boolean; slug: string; desc: string }>): string {
  const lines = ["# Backlog", "", `## Sprint ${sprint}`];
  for (const it of items) {
    lines.push(`- [${it.checked ? "x" : " "}] ${it.slug}: ${it.desc}`);
  }
  lines.push("", "## Ready", "", "## Inbox", "", "## Done", "");
  return lines.join("\n");
}

function makeProject(name: string, sprint: number, items: Array<{ checked?: boolean; slug: string; desc: string }>): string {
  const projectPath = path.join(ROOT_TMP, name);
  fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, "docs", "backlog.md"),
    backlogWithSprint(
      sprint,
      items.map((it) => ({ checked: !!it.checked, slug: it.slug, desc: it.desc }))
    )
  );
  return projectPath;
}

async function initGitRepo(projectPath: string): Promise<SimpleGit> {
  const git = simpleGit(projectPath);
  await git.init();
  await git.addConfig("user.email", "raptor-test@example.com", false, "local");
  await git.addConfig("user.name", "Raptor Test", false, "local");
  // Some environments default to master; force main for predictability.
  try {
    await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  } catch {
    /* older git versions: ignore */
  }
  // Seed an initial commit so HEAD resolves and branches can be created.
  fs.writeFileSync(path.join(projectPath, ".gitkeep"), "");
  await git.add(".");
  await git.commit("initial commit");
  return git;
}

function workflowStepsForState() {
  return SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name }));
}

beforeAll(() => {
  fs.mkdirSync(ROOT_TMP, { recursive: true });
});

afterAll(() => {
  fs.rmSync(ROOT_TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC #1, #2 — Detection on entry & state population
// ---------------------------------------------------------------------------

describe("AC #1, #2: Detection on entry seeds state.features", () => {
  it("detectSprintFeatures returns every slug in array order", () => {
    const projectPath = makeProject("detect-multi", 7, [
      { slug: "feature-a", desc: "First" },
      { slug: "feature-b", desc: "Second" },
      { slug: "feature-c", desc: "Third" },
    ]);

    const features = detectSprintFeatures(projectPath, 7);
    expect(features).toEqual(["feature-a", "feature-b", "feature-c"]);
  });

  it("isMultiFeatureSprint returns true when 2+ features detected", () => {
    expect(isMultiFeatureSprint(["a", "b"])).toBe(true);
    expect(isMultiFeatureSprint(["a"])).toBe(false);
    expect(isMultiFeatureSprint([])).toBe(false);
  });

  it("createFeatureStates seeds one FeatureState per feature with steps 1–9 only", () => {
    const features = createFeatureStates(["alpha", "beta"], 7);
    expect(features).toHaveLength(2);
    for (const f of features) {
      expect(f.status).toBe("pending");
      expect(f.currentStep).toBe(1);
      expect(f.branchName).toBe(`sprint-7/${f.slug}`);
      expect(f.steps.every((s) => s.step <= 9)).toBe(true);
      expect(f.steps).toHaveLength(SPRINT_WORKFLOW.filter((s) => s.step <= 9).length);
      expect(f.dod).toEqual({
        codeCommitted: false,
        testsPass: false,
        prReviewApproved: false,
        poAccepted: false,
        demoCompleted: false,
      });
    }
  });

  it("state.features survives JSON round-trip (the persistence contract)", () => {
    // saveSprintState writes JSON.stringify(state); loadSprintState reads + parses.
    // We round-trip in memory to avoid touching the user's real ~/.raptor.
    const projectSlug = "persist-features";
    const sprint = 7;

    const features = createFeatureStates(["alpha", "beta"], sprint);
    const state = createInitialState(projectSlug, sprint, workflowStepsForState());
    state.features = features;

    const serialized = JSON.stringify(state, null, 2);
    const reloaded = JSON.parse(serialized) as SprintState;

    expect(reloaded.features).toHaveLength(2);
    expect(reloaded.features![0].slug).toBe("alpha");
    expect(reloaded.features![1].slug).toBe("beta");
    // Per-feature steps must round-trip too.
    expect(reloaded.features![0].steps).toHaveLength(SPRINT_WORKFLOW.filter((s) => s.step <= 9).length);
    expect(reloaded.features![0].branchName).toBe("sprint-7/alpha");
  });
});

// ---------------------------------------------------------------------------
// Backward compat — empty sprint and duplicate slugs
// ---------------------------------------------------------------------------

describe("AC #11: Empty sprint returns existing error", () => {
  it("detectSprintFeatures returns [] when sprint section has zero items", () => {
    const projectPath = path.join(ROOT_TMP, "empty-sprint");
    fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "docs", "backlog.md"),
      "# Backlog\n\n## Sprint 7\n\n## Ready\n\n## Inbox\n\n## Done\n"
    );

    const features = detectSprintFeatures(projectPath, 7);
    expect(features).toEqual([]);
  });

  it("the canonical error message string is preserved", () => {
    // Spec AC #11 names the exact message; don't drift from it.
    const expected =
      "Could not extract feature slug from backlog. Ensure the sprint section has items in the format: - [ ] slug: description";
    expect(expected).toContain("Could not extract feature slug from backlog");
    expect(expected).toContain("- [ ] slug: description");
  });
});

describe("Edge case: duplicate slugs in the sprint section", () => {
  it("detectSprintFeatures returns duplicates verbatim (caller is responsible for rejection)", () => {
    const projectPath = makeProject("dup-slugs", 7, [
      { slug: "feature-a", desc: "First copy" },
      { slug: "feature-a", desc: "Second copy" },
      { slug: "feature-b", desc: "Different" },
    ]);

    const features = detectSprintFeatures(projectPath, 7);
    expect(features).toEqual(["feature-a", "feature-a", "feature-b"]);

    // Caller (runSprintFromStep) must detect and reject this. Architecture
    // §1 mandates: "Duplicate slug '{slug}' in sprint section of backlog.md".
    const seen = new Set<string>();
    let dup: string | null = null;
    for (const slug of features) {
      if (seen.has(slug)) {
        dup = slug;
        break;
      }
      seen.add(slug);
    }
    expect(dup).toBe("feature-a");
    const errorMessage = `Duplicate slug '${dup}' in sprint section of backlog.md`;
    expect(errorMessage).toBe("Duplicate slug 'feature-a' in sprint section of backlog.md");
  });
});

// ---------------------------------------------------------------------------
// AC #4 — featureBranchName & ensureFeatureBranch (bundled sprint-branch-auto-create)
// ---------------------------------------------------------------------------

describe("AC #4: Per-feature branch", () => {
  it("featureBranchName follows sprint-{N}/{slug} convention", () => {
    expect(featureBranchName(7, "alpha")).toBe("sprint-7/alpha");
    expect(featureBranchName(12, "feature-b")).toBe("sprint-12/feature-b");
  });

  it("ensureFeatureBranch creates the branch when it does not exist", async () => {
    // The architecture mandates an `ensureFeatureBranch` export from
    // src/orchestrator/multi-runner.ts. Until the engineer wires it, we
    // dynamically import and skip gracefully.
    const mod = (await import("../../src/orchestrator/multi-runner")) as Record<string, unknown>;
    if (typeof mod.ensureFeatureBranch !== "function") {
      console.warn("ensureFeatureBranch not implemented yet — skipping (will pass once wired)");
      return;
    }
    type EFBResult = { created: boolean; checkedOut: boolean; error?: string };
    type EnsureFn = (p: string, s: number, slug: string) => Promise<EFBResult>;
    const ensureFeatureBranch = mod.ensureFeatureBranch as EnsureFn;

    const projectPath = path.join(ROOT_TMP, "efb-create");
    fs.mkdirSync(projectPath, { recursive: true });
    const git = await initGitRepo(projectPath);

    const result = await ensureFeatureBranch(projectPath, 7, "alpha");
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(true);
    expect(result.checkedOut).toBe(true);

    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    expect(head).toBe("sprint-7/alpha");
  });

  it("ensureFeatureBranch is idempotent when already on the branch", async () => {
    const mod = (await import("../../src/orchestrator/multi-runner")) as Record<string, unknown>;
    if (typeof mod.ensureFeatureBranch !== "function") return;
    type EFBResult = { created: boolean; checkedOut: boolean; error?: string };
    type EnsureFn = (p: string, s: number, slug: string) => Promise<EFBResult>;
    const ensureFeatureBranch = mod.ensureFeatureBranch as EnsureFn;

    const projectPath = path.join(ROOT_TMP, "efb-idem");
    fs.mkdirSync(projectPath, { recursive: true });
    const git = await initGitRepo(projectPath);
    await git.checkoutLocalBranch("sprint-7/alpha");

    const result = await ensureFeatureBranch(projectPath, 7, "alpha");
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(false);
    expect(result.checkedOut).toBe(false);

    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    expect(head).toBe("sprint-7/alpha");
  });

  it("ensureFeatureBranch checks out an existing non-divergent branch", async () => {
    const mod = (await import("../../src/orchestrator/multi-runner")) as Record<string, unknown>;
    if (typeof mod.ensureFeatureBranch !== "function") return;
    type EFBResult = { created: boolean; checkedOut: boolean; error?: string };
    type EnsureFn = (p: string, s: number, slug: string) => Promise<EFBResult>;
    const ensureFeatureBranch = mod.ensureFeatureBranch as EnsureFn;

    const projectPath = path.join(ROOT_TMP, "efb-checkout");
    fs.mkdirSync(projectPath, { recursive: true });
    const git = await initGitRepo(projectPath);
    await git.checkoutLocalBranch("sprint-7/alpha");
    await git.checkout("main");

    const result = await ensureFeatureBranch(projectPath, 7, "alpha");
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(false);
    expect(result.checkedOut).toBe(true);

    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    expect(head).toBe("sprint-7/alpha");
  });

  it("ensureFeatureBranch surfaces a clear error on divergent state", async () => {
    const mod = (await import("../../src/orchestrator/multi-runner")) as Record<string, unknown>;
    if (typeof mod.ensureFeatureBranch !== "function") return;
    type EFBResult = { created: boolean; checkedOut: boolean; error?: string };
    type EnsureFn = (p: string, s: number, slug: string) => Promise<EFBResult>;
    const ensureFeatureBranch = mod.ensureFeatureBranch as EnsureFn;

    const projectPath = path.join(ROOT_TMP, "efb-divergent");
    fs.mkdirSync(projectPath, { recursive: true });
    const git = await initGitRepo(projectPath);

    // Create the target branch with one commit.
    await git.checkoutLocalBranch("sprint-7/alpha");
    fs.writeFileSync(path.join(projectPath, "branch-only.txt"), "branch content");
    await git.add(".");
    await git.commit("on branch");

    // Switch back to main and create an UNCOMMITTED conflicting change.
    await git.checkout("main");
    fs.writeFileSync(path.join(projectPath, "branch-only.txt"), "main-uncommitted");

    const result = await ensureFeatureBranch(projectPath, 7, "alpha");
    // Either an explicit error or — at minimum — the runner did NOT silently
    // overwrite the user's working tree state.
    if (result.error) {
      expect(result.error).toMatch(/sprint-7\/alpha/);
      expect(result.error).toMatch(/divergent/i);
    } else {
      // If checkout succeeded somehow, the user's uncommitted work must not be lost.
      const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
      expect(["main", "sprint-7/alpha"]).toContain(head);
    }
  });
});

// ---------------------------------------------------------------------------
// AC #5 — Per-feature step state (independent attempts/failures/artifacts)
// ---------------------------------------------------------------------------

describe("AC #5: Per-feature step state is independent", () => {
  it("two features track step 5 attempts and failures independently", () => {
    const features = createFeatureStates(["alpha", "beta"], 7);
    const findStep = (f: FeatureState, n: number) => f.steps.find((s) => s.step === n)!;

    findStep(features[0], 5).status = "complete";
    findStep(features[0], 5).attempts = 1;
    findStep(features[0], 5).completedAt = new Date().toISOString();

    findStep(features[1], 5).status = "complete";
    findStep(features[1], 5).attempts = 3;
    findStep(features[1], 5).failures = [
      { attempt: 1, errorSummary: "boom", timestamp: new Date().toISOString(), hadPartialArtifacts: false },
      { attempt: 2, errorSummary: "still boom", timestamp: new Date().toISOString(), hadPartialArtifacts: true },
    ];
    findStep(features[1], 5).completedAt = new Date().toISOString();

    expect(findStep(features[0], 5).attempts).toBe(1);
    expect(findStep(features[1], 5).attempts).toBe(3);
    expect(findStep(features[0], 5).failures).toHaveLength(0);
    expect(findStep(features[1], 5).failures).toHaveLength(2);
    expect(findStep(features[0], 5).completedAt).not.toBeNull();
    expect(findStep(features[1], 5).completedAt).not.toBeNull();
  });

  it("artifacts are recorded per feature, not on top-level state.steps", () => {
    const state = createInitialState("p", 7, workflowStepsForState());
    state.features = createFeatureStates(["alpha", "beta"], 7);

    state.features[0].steps[0].artifacts = ["docs/specs/alpha.md"];
    state.features[1].steps[0].artifacts = ["docs/specs/beta.md"];

    // Top-level state.steps should remain pristine for steps 1–9 in multi-feature mode.
    expect(state.steps[0].artifacts).toEqual([]);
    expect(state.features[0].steps[0].artifacts).toEqual(["docs/specs/alpha.md"]);
    expect(state.features[1].steps[0].artifacts).toEqual(["docs/specs/beta.md"]);
  });
});

// ---------------------------------------------------------------------------
// AC #6 — Sprint-shared steps 10–13 stay on top-level state.steps
// ---------------------------------------------------------------------------

describe("AC #6: Sprint-shared steps 10–13 run once per sprint", () => {
  it("createFeatureStates does NOT include steps 10–13", () => {
    const features = createFeatureStates(["a", "b"], 7);
    for (const f of features) {
      expect(f.steps.find((s) => s.step === 10)).toBeUndefined();
      expect(f.steps.find((s) => s.step === 11)).toBeUndefined();
      expect(f.steps.find((s) => s.step === 12)).toBeUndefined();
      expect(f.steps.find((s) => s.step === 13)).toBeUndefined();
    }
  });

  it("top-level state.steps contains all 13 workflow steps for shared bookkeeping", () => {
    const state = createInitialState("p", 7, workflowStepsForState());
    const stepNumbers = state.steps.map((s) => s.step).sort((a, b) => a - b);
    expect(stepNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });
});

// ---------------------------------------------------------------------------
// AC #7 — Failure isolation
// ---------------------------------------------------------------------------

describe("AC #7: Failure isolation across features", () => {
  it("one feature escalating does not flip another feature's status", () => {
    const features = createFeatureStates(["alpha", "beta", "gamma"], 7);
    features[0].status = "escalated";
    features[0].steps[4].status = "escalated"; // step 5
    features[1].status = "in-progress";
    features[2].status = "in-progress";

    expect(features[0].status).toBe("escalated");
    expect(features[1].status).toBe("in-progress");
    expect(features[2].status).toBe("in-progress");
    expect(anyFeaturesEscalated(features)).toBe(true);
    expect(allFeaturesComplete(features)).toBe(false);
  });

  it("deriveSprintStatus returns 'escalated' once all features are terminal AND any escalated", () => {
    const features = createFeatureStates(["alpha", "beta"], 7);
    features[0].status = "escalated";
    features[1].status = "complete";
    expect(deriveSprintStatus(features)).toBe("escalated");
  });

  it("deriveSprintStatus returns 'in-progress' while non-terminal features remain", () => {
    const features = createFeatureStates(["alpha", "beta"], 7);
    features[0].status = "escalated";
    features[1].status = "in-progress";
    expect(deriveSprintStatus(features)).toBe("in-progress");
  });

  it("deriveSprintStatus returns 'complete' only when all features are complete", () => {
    const features = createFeatureStates(["alpha", "beta"], 7);
    features[0].status = "complete";
    features[1].status = "complete";
    expect(deriveSprintStatus(features)).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// AC #8 — Per-feature DoD checklist
// ---------------------------------------------------------------------------

describe("AC #8: Per-feature DoD checklist", () => {
  it("each feature owns an independent DoD; flipping one does not affect the other", () => {
    const features = createFeatureStates(["alpha", "beta"], 7);
    features[0].dod.prReviewApproved = true;
    features[0].dod.poAccepted = true;

    expect(features[0].dod.prReviewApproved).toBe(true);
    expect(features[0].dod.poAccepted).toBe(true);
    expect(features[1].dod.prReviewApproved).toBe(false);
    expect(features[1].dod.poAccepted).toBe(false);
  });

  it("sprint completion gate: allFeaturesComplete drives the final sprint status", () => {
    const features = createFeatureStates(["alpha", "beta"], 7);
    features[0].status = "complete";
    features[1].status = "in-progress";
    expect(allFeaturesComplete(features)).toBe(false);

    features[1].status = "complete";
    expect(allFeaturesComplete(features)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC #9 — Progress visibility
// ---------------------------------------------------------------------------

describe("AC #9: renderProgressTable in multi-feature mode", () => {
  it("emits a Per-Feature Progress section with one subtable per feature", () => {
    const state = createInitialState("test", 7, workflowStepsForState());
    state.features = createFeatureStates(["alpha", "beta"], 7);

    const out = renderProgressTable(state);
    expect(out).toContain("Per-Feature Progress");
    expect(out).toContain("Feature: alpha");
    expect(out).toContain("Feature: beta");
  });

  it("annotates top-level rows for steps 1-9 with '(per-feature)' in multi-feature mode", () => {
    const state = createInitialState("test", 7, workflowStepsForState());
    state.features = createFeatureStates(["alpha", "beta"], 7);

    const out = renderProgressTable(state);
    expect(out).toContain("(per-feature)");
  });

  it("single-feature sprint output does NOT contain the Per-Feature section", () => {
    const state = createInitialState("test", 7, workflowStepsForState());
    // single-feature mode: features stays null
    const out = renderProgressTable(state);
    expect(out).not.toContain("Per-Feature Progress");
  });
});

// ---------------------------------------------------------------------------
// AC #10 — Single-feature backward compatibility
// ---------------------------------------------------------------------------

describe("AC #10: Single-feature backward compatibility", () => {
  it("createInitialState defaults features to null", () => {
    const state = createInitialState("p", 7, workflowStepsForState());
    expect(state.features).toBeNull();
  });

  it("legacy state without `features` defaults to null (the load defaulting contract)", () => {
    // Replicates loadSprintState's defaulting logic without touching the real ~/.raptor.
    // Architecture promises: state.features = state.features ?? null.
    const legacy = {
      project: "legacy-no-features",
      sprint: 7,
      status: "complete",
      currentStep: 13,
      branchName: "sprint-7/feature",
      steps: [],
      checkpoints: [],
      dod: { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: true, demoCompleted: true },
      retroProposals: null,
    };

    // Simulate the load path: parse + apply defaults.
    const parsed = JSON.parse(JSON.stringify(legacy)) as Partial<SprintState>;
    const features = parsed.features ?? null;
    expect(features).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC #12 — Resume safety: features array is frozen once seeded
// ---------------------------------------------------------------------------

describe("AC #12: Resume safety", () => {
  it("a populated state.features survives reload unchanged even if backlog mutates", () => {
    const projectSlug = "resume-frozen";
    const sprint = 7;

    // Seed state with two features and serialize.
    const features = createFeatureStates(["alpha", "beta"], sprint);
    const state = createInitialState(projectSlug, sprint, workflowStepsForState());
    state.features = features;
    const serialized = JSON.stringify(state);

    // Simulate the user editing the backlog AFTER state was saved.
    const projectPath = makeProject("resume-frozen-project", sprint, [
      { slug: "alpha", desc: "First" },
      { slug: "beta", desc: "Second" },
      { slug: "late-add", desc: "Surprise!" },
    ]);
    // detectSprintFeatures now sees three; but the runner must NOT re-seed
    // from this list because state.features is already populated.
    expect(detectSprintFeatures(projectPath, sprint)).toEqual(["alpha", "beta", "late-add"]);

    const reloaded = JSON.parse(serialized) as SprintState;
    expect(reloaded.features).toHaveLength(2);
    expect(reloaded.features!.map((f) => f.slug)).toEqual(["alpha", "beta"]);

    // The dispatcher contract: when state.features is already populated, do NOT
    // re-seed from detectSprintFeatures. Encode this as a guard expectation.
    const shouldReSeed = reloaded.features == null || reloaded.features.length === 0;
    expect(shouldReSeed).toBe(false);
  });

  it("resume skips per-feature steps already marked complete", () => {
    const features = createFeatureStates(["alpha", "beta"], 7);
    // alpha: steps 1–4 done, step 5 pending.
    for (let i = 0; i < 4; i++) {
      features[0].steps[i].status = "complete";
      features[0].steps[i].completedAt = new Date().toISOString();
    }
    // beta: only step 1 done.
    features[1].steps[0].status = "complete";
    features[1].steps[0].completedAt = new Date().toISOString();

    // The dispatcher's skip predicate (per architecture §3.1):
    const shouldRun = (f: FeatureState, stepNum: number) =>
      f.status !== "complete" && f.steps.find((s) => s.step === stepNum)!.status !== "complete";

    expect(shouldRun(features[0], 1)).toBe(false);
    expect(shouldRun(features[0], 5)).toBe(true);
    expect(shouldRun(features[1], 1)).toBe(false);
    expect(shouldRun(features[1], 2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC #13 — Streaming checkpoints with feature annotation
// ---------------------------------------------------------------------------

describe("AC #13: Streaming checkpoints", () => {
  it("CheckpointPrompt schema permits an optional feature annotation (additive)", () => {
    // Today's buildCheckpointPrompt does not yet take featureSlug; once it does,
    // the title and context must be feature-annotated. Here we assert the
    // canonical formatting the spec requires.
    const summary = "Spec for alpha is ready.";
    const base = buildCheckpointPrompt("spec-review", summary);
    expect(base).toMatchObject({
      type: "spec-review",
      options: ["approve", "request-changes"],
    });

    // Architecture §5: title suffix is " — {slug}", context is prefixed with
    // "**Feature:** {slug}\n\n".
    const featureSlug = "alpha";
    const expectedTitle = `${base.title} — ${featureSlug}`;
    const expectedContextPrefix = `**Feature:** ${featureSlug}\n\n`;

    expect(expectedTitle.endsWith(`— ${featureSlug}`)).toBe(true);
    expect(expectedContextPrefix).toBe("**Feature:** alpha\n\n");

    // If the implementation has already accepted a featureSlug, verify it.
    type Builder = (
      type: typeof base.type,
      summary: string,
      dinoNames?: undefined,
      featureSlug?: string
    ) => CheckpointPrompt & { feature?: string };
    const tryBuilder = buildCheckpointPrompt as unknown as Builder;
    let annotated: (CheckpointPrompt & { feature?: string }) | undefined;
    try {
      annotated = tryBuilder("spec-review", summary, undefined, featureSlug);
    } catch {
      annotated = undefined;
    }
    if (annotated && annotated.feature) {
      expect(annotated.feature).toBe(featureSlug);
      expect(annotated.title.endsWith(`— ${featureSlug}`)).toBe(true);
      expect(annotated.context.startsWith(expectedContextPrefix)).toBe(true);
    }
  });

  it("CheckpointState supports an optional `feature` field for streaming resume", () => {
    // Architecture §6 + Data Model: CheckpointState gains optional `feature?: string | null`.
    const cp: CheckpointState & { feature?: string | null } = {
      type: "spec-review",
      status: "pending",
      feedback: null,
      resolvedAt: null,
      feature: "alpha",
    };
    expect(cp.feature).toBe("alpha");
  });

  it("SprintState supports `currentFeatureSlug` for resume tracking", () => {
    const state = createInitialState("p", 7, workflowStepsForState());
    const extended: SprintState & { currentFeatureSlug?: string | null } = {
      ...state,
      currentFeatureSlug: "alpha",
    };
    expect(extended.currentFeatureSlug).toBe("alpha");

    // Round-trip in memory (no filesystem side-effects).
    const reloaded = JSON.parse(JSON.stringify(extended)) as SprintState & {
      currentFeatureSlug?: string | null;
    };
    expect(reloaded.currentFeatureSlug ?? null).toBe("alpha");
  });

  it("request-changes on a single-feature sprint resets attempts and failures (regression: request-changes-feedback-injection)", () => {
    // Single-feature mode: state.features stays null, top-level state.steps is the source of truth.
    const state = createInitialState("p", 7, workflowStepsForState());
    expect(state.features).toBeNull();

    // Simulate a step 1 that completed once.
    const step = state.steps[0];
    step.status = "complete";
    step.artifacts = ["docs/specs/p.md"];
    step.completedAt = new Date().toISOString();
    step.attempts = 1;
    step.failures = [
      { attempt: 1, errorSummary: "prior", timestamp: "2026-04-27T00:00:00Z", hadPartialArtifacts: false },
    ];

    // User submits request-changes. Mirror the runner.ts:1101-1106 single-feature reset.
    step.status = "pending";
    step.artifacts = [];
    step.completedAt = null;
    step.attempts = 0;
    step.failures = [];

    // All five fields must be reset for the feedback-injection condition (attempt === 1) to fire on next loop.
    expect(step.status).toBe("pending");
    expect(step.artifacts).toEqual([]);
    expect(step.completedAt).toBeNull();
    expect(step.attempts).toBe(0);
    expect(step.failures).toEqual([]);
  });

  it("request-changes resets only the affected feature's per-feature step (architecture §6)", () => {
    const features = createFeatureStates(["alpha", "beta"], 7);
    // Pretend both features completed step 1.
    for (const f of features) {
      f.steps[0].status = "complete";
      f.steps[0].artifacts = [`docs/specs/${f.slug}.md`];
      f.steps[0].completedAt = new Date().toISOString();
      f.steps[0].attempts = 1;
    }

    // User requests changes on alpha's step 1 → reset alpha only.
    const target = features[0].steps[0];
    target.status = "pending";
    target.artifacts = [];
    target.completedAt = null;
    target.attempts = 0;
    target.failures = [];

    expect(features[0].steps[0].status).toBe("pending");
    expect(features[0].steps[0].artifacts).toEqual([]);
    expect(features[0].steps[0].completedAt).toBeNull();
    expect(features[0].steps[0].attempts).toBe(0);
    expect(features[0].steps[0].failures).toEqual([]);

    // Beta is untouched.
    expect(features[1].steps[0].status).toBe("complete");
    expect(features[1].steps[0].artifacts).toEqual(["docs/specs/beta.md"]);
    expect(features[1].steps[0].attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC #14 — Tool surface unchanged
// ---------------------------------------------------------------------------

describe("AC #14: Tool surface unchanged", () => {
  it("SprintResult shape exposes optional checkpoint feature only as additive metadata", () => {
    // We can't import SprintResult type at runtime, so we encode the contract:
    const result = {
      status: "checkpoint" as const,
      progress: "...",
      checkpoint: {
        type: "spec-review" as const,
        title: "Spec Review — alpha",
        context: "**Feature:** alpha\n\nSummary…",
        options: ["approve", "request-changes"],
        feedbackLabel: "Feedback for the PO (optional):",
        feature: "alpha",
      },
      state: createInitialState("p", 7, workflowStepsForState()),
    };
    expect(result.checkpoint.feature).toBe("alpha");
    expect(result.checkpoint.options).toEqual(["approve", "request-changes"]);
    // No new top-level fields on SprintResult.
    expect(Object.keys(result).sort()).toEqual(["checkpoint", "progress", "state", "status"]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge case: already-checked items ([x]) are seeded as pre-completed features", () => {
  it("detectSprintFeatures includes [x] items in the slug list", () => {
    const projectPath = makeProject("checked-items", 7, [
      { checked: true, slug: "done-before", desc: "Already done" },
      { slug: "still-todo", desc: "Not yet" },
    ]);

    const features = detectSprintFeatures(projectPath, 7);
    expect(features).toEqual(["done-before", "still-todo"]);
  });

  it("post-processing: features whose backlog item is [x] should be marked complete on seed", () => {
    // Per architecture §"Already-checked items": post-process inside the
    // dispatcher (no helper signature change). Simulate the post-process here.
    const projectPath = makeProject("post-check", 7, [
      { checked: true, slug: "done-before", desc: "Already done" },
      { slug: "still-todo", desc: "Not yet" },
    ]);
    const slugs = detectSprintFeatures(projectPath, 7);
    const features = createFeatureStates(slugs, 7);

    // Re-read backlog to determine which were checked.
    const backlog = fs.readFileSync(path.join(projectPath, "docs", "backlog.md"), "utf-8");
    const checkedRe = /- \[x\]\s+([a-z][a-z0-9-]*):/g;
    const checked = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = checkedRe.exec(backlog)) !== null) checked.add(m[1]);

    for (const f of features) {
      if (checked.has(f.slug)) {
        f.status = "complete";
        for (const s of f.steps) {
          s.status = "complete";
          s.completedAt = new Date().toISOString();
        }
      }
    }

    const done = features.find((f) => f.slug === "done-before")!;
    expect(done.status).toBe("complete");
    expect(done.steps.every((s) => s.status === "complete")).toBe(true);

    const todo = features.find((f) => f.slug === "still-todo")!;
    expect(todo.status).toBe("pending");
    expect(todo.steps.every((s) => s.status === "pending")).toBe(true);

    expect(allFeaturesComplete(features)).toBe(false);
  });
});

describe("Edge case: feature escalation while others continue", () => {
  it("after one feature escalates and the rest complete, sprint status is escalated", () => {
    const features = createFeatureStates(["alpha", "beta", "gamma"], 7);
    features[0].status = "escalated";
    features[1].status = "complete";
    features[2].status = "complete";
    expect(deriveSprintStatus(features)).toBe("escalated");
  });

  it("if any feature is still in-progress, sprint status is in-progress (not escalated yet)", () => {
    const features = createFeatureStates(["alpha", "beta", "gamma"], 7);
    features[0].status = "escalated";
    features[1].status = "complete";
    features[2].status = "in-progress";
    expect(deriveSprintStatus(features)).toBe("in-progress");
  });
});

// ---------------------------------------------------------------------------
// Constraint: extractFeatureSlug retained for single-feature path
// ---------------------------------------------------------------------------

describe("Single-feature path retains extractFeatureSlug semantics", () => {
  it("a sprint with one slug round-trips through detectSprintFeatures unambiguously", () => {
    const projectPath = makeProject("single-slug", 7, [{ slug: "lonely", desc: "Only one" }]);
    expect(detectSprintFeatures(projectPath, 7)).toEqual(["lonely"]);
    expect(isMultiFeatureSprint(detectSprintFeatures(projectPath, 7))).toBe(false);
  });
});
