/**
 * Integration tests — review-gate-mutation-check (Sprint 17)
 *
 * Spec:         docs/specs/review-gate-mutation-check.md (AC 1–10)
 * Architecture: docs/architecture/review-gate-mutation-check.md
 *
 * TDD note (tests BEFORE code): `buildMutationCheckSection` and
 * `buildStep7GateInstruction` (src/orchestrator/prompts.ts) DO NOT EXIST YET, and
 * the runner still injects `buildAdversarialGateSection` directly at both step-7
 * seams. These tests pin the post-implementation contract and are EXPECTED TO FAIL
 * against pre-change code — the RED signal (TEAM.md QA rule 12).
 *
 * ── RED-VERIFICATION ─────────────────────────────────────────────────────────
 *   • [EXPORT-RED] `buildMutationCheckSection` / `buildStep7GateInstruction` are
 *     not exported on `main` → the import + unit assertions go RED.
 *   • [SEAM-RED] the runner injects `buildAdversarialGateSection` (no mutation
 *     directive) at step 7 today → the real-seam prompt assertions (single- AND
 *     multi-feature) find no mutation-check text and go RED.
 *   • [RULE-RED] the pass/fail rule (RED = pass, green-under-mutation = FAIL) and
 *     the structured evidence block do not exist pre-change.
 *
 * PRODUCTION SEAM (AC 9): the real-seam tests drive the REAL `runSprintFromStep`
 * to step 7 and inspect the ACTUAL task prompt the runner hands the QA agent —
 * both the single-feature seam (runner.ts:1125) and the multi-feature seam
 * (runner.ts:1889). Only `spawnAgent` is mocked (to avoid a real `claude`); the
 * gate-injection path is exercised for real.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

// Sanctioned mock: stop step 7 from spawning a real `claude`. Do NOT widen — a
// mock of the runner loop itself would neuter the gate-injection coverage.
jest.mock("../../src/orchestrator/agents", () => {
  const actual = jest.requireActual("../../src/orchestrator/agents") as Record<string, unknown>;
  return { __esModule: true, ...actual, spawnAgent: jest.fn() };
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import simpleGit from "simple-git";

// NEW exports (RED until the Engineer implements them):
import {
  buildAdversarialGateSection,
  buildMutationCheckSection,
  buildStep7GateInstruction,
} from "../../src/orchestrator/prompts";

import { runSprintFromStep } from "../../src/orchestrator/runner";
import { SPRINT_WORKFLOW, Role } from "../../src/orchestrator/workflow";
import {
  createInitialState,
  saveSprintState,
  SprintState,
} from "../../src/orchestrator/state";
import { featureBranchName, createFeatureStates } from "../../src/orchestrator/multi-runner";
import { spawnAgent, AgentResult } from "../../src/orchestrator/agents";

const spawnAgentMock = spawnAgent as jest.MockedFunction<typeof spawnAgent>;

const SPRINT = 1;
const SLUG = "review-gate-mutation-check";

let tmpDir: string;
let fakeHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-mut-gate-"));
  fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  jest.spyOn(os, "homedir").mockReturnValue(fakeHome);
  spawnAgentMock.mockReset();
  spawnAgentMock.mockImplementation(
    async (): Promise<AgentResult> => ({ output: "step done", exitCode: 0 })
  );
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function workflowSteps() {
  return SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name }));
}

async function initProject(name: string): Promise<string> {
  const projectPath = path.join(tmpDir, name);
  fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, "docs", "backlog.md"),
    `# Backlog\n\n## Sprint ${SPRINT}\n- [ ] ${SLUG}: review gate mutation check\n\n## Ready\n\n## Inbox\n\n## Done\n`
  );
  const git = simpleGit(projectPath);
  await git.init();
  await git.addConfig("user.name", "Vex Velociraptor");
  await git.addConfig("user.email", "vex@raptor.test");
  await git.add(".");
  await git.commit("[PO] add: sprint backlog");
  return projectPath;
}

/** Seed a SINGLE-feature sprint parked at step 7 (steps 1-6 complete). */
function seedSingleFeature(projectSlug: string): void {
  const state = createInitialState(
    projectSlug,
    SPRINT,
    workflowSteps(),
    featureBranchName(SPRINT, SLUG)
  );
  for (const s of state.steps) {
    if (s.step < 7) {
      s.status = "complete";
      s.completedAt = "2026-07-15T00:00:00.000Z";
      s.attempts = 1;
    }
  }
  state.currentStep = 7;
  saveSprintState(projectSlug, SPRINT, state);
}

/**
 * Seed a MULTI-feature sprint with the feature under test parked at step 7.
 * TWO features are required so the dispatcher takes the multi-feature path
 * (`runner.ts:801` — `isMultiFeature = state.features.length > 1` → the :1889/:1893
 * seam). The sibling is fully complete so it spawns NOTHING before SLUG's step-7
 * QA gate, keeping SLUG's gate the first QA spawn.
 */
function seedMultiFeature(projectSlug: string): void {
  const state = createInitialState(projectSlug, SPRINT, workflowSteps(), null);
  const features = createFeatureStates([SLUG, `${SLUG}-sibling`], SPRINT);
  for (const f of features) {
    if (f.slug === SLUG) {
      for (const s of f.steps) {
        if (s.step < 7) {
          s.status = "complete";
          s.attempts = 1;
        }
      }
      f.currentStep = 7;
      f.status = "in-progress";
    } else {
      for (const s of f.steps) s.status = "complete";
      f.currentStep = 9;
      f.status = "complete";
    }
  }
  (state as SprintState).features = features;
  state.currentFeatureSlug = SLUG;
  state.currentStep = 7;
  saveSprintState(projectSlug, SPRINT, state);
}

/** The context+task prompt the runner handed the first QA-role agent spawn. */
function firstQaPrompt(): string {
  const call = spawnAgentMock.mock.calls.find((c) => c[0] === ("qa" as Role));
  if (!call) throw new Error("no QA-role spawnAgent call was made");
  return String(call[3]) + "\n" + String(call[2]);
}

// ===========================================================================
// AC 1–5, 8 — buildMutationCheckSection content contract
// ===========================================================================

describe("buildMutationCheckSection: the mutation-evidence directive (AC 1-5, 8)", () => {
  it("[EXPORT-RED] is exported from prompts.ts", () => {
    expect(typeof buildMutationCheckSection).toBe("function");
  });

  it("directs a mutation test on the primary production seam (AC 1)", () => {
    const s = buildMutationCheckSection().toLowerCase();
    expect(s).toContain("mutation");
    expect(s).toContain("seam");
  });

  it("[RULE-RED] states the pass/fail rule: RED = pass, green-under-mutation = FAIL (AC 2)", () => {
    const s = buildMutationCheckSection();
    const lower = s.toLowerCase();
    // green-under-mutation is a false-green and must FAIL the review.
    expect(lower).toContain("false-green");
    expect(lower).toContain("fail");
    // RED (a failing test under the mutation) is the confirmation of coverage.
    expect(lower).toMatch(/\bred\b/);
  });

  it("requires restore-and-verify before completing (AC 4)", () => {
    const lower = buildMutationCheckSection().toLowerCase();
    expect(lower).toMatch(/restore|revert/);
  });

  it("requires a structured evidence block (AC 3)", () => {
    const s = buildMutationCheckSection();
    for (const marker of ["SEAM:", "MUTATION:", "RED EVIDENCE:", "RESTORED:"]) {
      expect(s).toContain(marker);
    }
  });

  it("gives per-independent-seam guidance without a countable rule (AC 5)", () => {
    const lower = buildMutationCheckSection().toLowerCase();
    expect(lower).toContain("independent seam");
  });

  it("states a no-mutable-seam branch for docs/config-only features (AC 8)", () => {
    const lower = buildMutationCheckSection().toLowerCase();
    expect(lower).toContain("no executable production seam");
  });
});

// ===========================================================================
// AC 6 — composition: buildStep7GateInstruction includes BOTH sections
// ===========================================================================

describe("buildStep7GateInstruction: composes adversarial + mutation, never replaces (AC 6)", () => {
  it("[EXPORT-RED] is exported and contains the Sprint-14 adversarial section verbatim", () => {
    expect(typeof buildStep7GateInstruction).toBe("function");
    expect(buildStep7GateInstruction()).toContain(buildAdversarialGateSection());
  });

  it("also contains the mutation-check section verbatim (strictly stronger)", () => {
    expect(buildStep7GateInstruction()).toContain(buildMutationCheckSection());
  });
});

// ===========================================================================
// AC 7, 9 — the mutation directive reaches the REAL step-7 prompt at BOTH seams
// ===========================================================================

describe("real step-7 seam injection at BOTH runner sites (AC 7, AC 9)", () => {
  it("[SEAM-RED] single-feature seam (runner.ts:1125) injects the mutation directive", async () => {
    const slug = "mut-single";
    const projectPath = await initProject(slug);
    seedSingleFeature(slug);

    await runSprintFromStep(projectPath, slug, SPRINT, 7);

    expect(firstQaPrompt()).toContain(buildMutationCheckSection());
  });

  it("[SEAM-RED] multi-feature seam (runner.ts:1889) injects the mutation directive", async () => {
    const slug = "mut-multi";
    const projectPath = await initProject(slug);
    seedMultiFeature(slug);

    await runSprintFromStep(projectPath, slug, SPRINT, 7);

    expect(firstQaPrompt()).toContain(buildMutationCheckSection());
  });
});
