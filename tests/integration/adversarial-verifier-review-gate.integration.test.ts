/**
 * Integration tests — adversarial-verifier-review-gate (Sprint 14)
 *
 * Spec:         docs/specs/adversarial-verifier-review-gate.md (AC 1–17)
 * Architecture: docs/architecture/adversarial-verifier-review-gate.md
 *
 * PRODUCTION SEAM (TEAM.md QA rule 12 / AC 16): every constraint-guarding test
 * here drives a REAL production seam, never a test-local reimplementation:
 *
 *   - Part 1 gate injection is asserted by driving the REAL `runSprintFromStep`
 *     step loop at step 7 ("Run test suite") and inspecting the actual task
 *     prompt the runner hands to the QA gate agent. The ONLY mock is
 *     `spawnAgent` (sanctioned: so the step does not spawn a real `claude`).
 *   - Config parsing drives the REAL `loadConfig` against a written config file.
 *   - Per-role resolution drives the REAL `resolveRoleModel` export.
 *   - The gate instruction content drives the REAL `buildAdversarialGateSection`
 *     export — the function the architecture centralized precisely so a test can
 *     assert its presence in the step-7 prompt (AC 2).
 *
 * Surface-map (why some Part-2 coverage lives elsewhere, mirroring the
 * progress-aware-circuit-breaker precedent): the `spawnAgent` argv assembly
 * (`--model` insertion, byte-identical no-model argv, load-bearing tail, and
 * idle/ceiling non-regression) needs a fake child process + fake timers, so it
 * is pinned in the colocated unit file
 * `src/orchestrator/adversarial-verifier-review-gate.test.ts`. Together the
 * three real seams — loadConfig (config→parsed), resolveRoleModel (parsed→model),
 * and spawnAgent argv (model→--model) — prove the AC-9 end-to-end chain without
 * a single monolithic call, exactly as the architecture Handoff decomposes it.
 *
 * TDD note: these tests are RED at step 3 — `resolveRoleModel`,
 * `buildAdversarialGateSection`, the `models` config parse, and the runner's
 * step-7 gate injection do not exist yet. That is the required state; the
 * Engineer turns them green in step 5. RED-verification notes are recorded on
 * each constraint-guarding test. Tests tagged [no-regression] are expected to
 * pass both before and after and are not constraint-guarding.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

// Sanctioned mock (Part-1 runner seam): stop step 7/8 from spawning real
// `claude` processes. Do NOT widen this mock — a mock of the runner loop itself
// would silently neuter the gate-injection regression coverage this file exists
// for (the Sprint 10 false-green anti-pattern).
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

import { loadConfig, RaptorConfig } from "../../src/config";
// NEW exports (RED until the Engineer implements Part 1 + Part 2):
import { resolveRoleModel } from "../../src/orchestrator/runner";
import { buildAdversarialGateSection } from "../../src/orchestrator/prompts";

import { runSprintFromStep } from "../../src/orchestrator/runner";
import { SPRINT_WORKFLOW, Role } from "../../src/orchestrator/workflow";
import {
  createInitialState,
  saveSprintState,
  SprintState,
  StepState,
} from "../../src/orchestrator/state";
import { featureBranchName } from "../../src/orchestrator/multi-runner";
import { spawnAgent, AgentResult } from "../../src/orchestrator/agents";
import * as orchestratorIndex from "../../src/orchestrator";

const spawnAgentMock = spawnAgent as jest.MockedFunction<typeof spawnAgent>;

const SPRINT = 1;
const SLUG = "adversarial-verifier-review-gate";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakeHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-adv-gate-"));
  fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  // Sandbox ~/.raptor (state files) — matches the merge-integration harness.
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

function writeConfig(obj: unknown): string {
  const p = path.join(tmpDir, "config.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function workflowSteps() {
  return SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name }));
}

/** Create a real git repo with a Raptor-format single-feature backlog. */
async function initProject(name: string): Promise<string> {
  const projectPath = path.join(tmpDir, name);
  fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, "docs", "backlog.md"),
    `# Backlog\n\n## Sprint ${SPRINT}\n- [ ] ${SLUG}: adversarial verifier review gate\n\n## Ready\n\n## Inbox\n\n## Done\n`
  );
  const git = simpleGit(projectPath);
  await git.init();
  await git.addConfig("user.name", "Vex Velociraptor");
  await git.addConfig("user.email", "vex@raptor.test");
  await git.add(".");
  await git.commit("[PO] add: sprint backlog");
  return projectPath;
}

/** Seed a single-feature sprint parked at `fromStep` (earlier steps complete). */
function seedState(projectSlug: string, fromStep: number): SprintState {
  const state = createInitialState(
    projectSlug,
    SPRINT,
    workflowSteps(),
    featureBranchName(SPRINT, SLUG)
  );
  for (const s of state.steps) {
    if (s.step < fromStep) {
      s.status = "complete";
      s.completedAt = "2026-07-07T00:00:00.000Z";
      s.attempts = 1;
    }
  }
  state.currentStep = fromStep;
  saveSprintState(projectSlug, SPRINT, state);
  return state;
}

/** The task prompt (arg 3) the runner handed to the first QA-role agent spawn. */
function firstQaTaskPrompt(): { context: string; taskDesc: string } {
  const call = spawnAgentMock.mock.calls.find((c) => c[0] === ("qa" as Role));
  if (!call) throw new Error("no QA-role spawnAgent call was made");
  return { context: String(call[2]), taskDesc: String(call[3]) };
}

// ===========================================================================
// Part 1 — Real-seam gate enforcement (AC 1–4, AC 16, AC 17)
// ===========================================================================

describe("Part 1: adversarial gate instruction content (buildAdversarialGateSection)", () => {
  // RED-verification: this whole describe fails to resolve until
  // `buildAdversarialGateSection` is exported from prompts.ts — the export does
  // not exist on pre-change `main`.
  it("acts as an out-of-loop adversarial verifier that hunts reimplementations (AC 1)", () => {
    const section = buildAdversarialGateSection().toLowerCase();
    expect(section).toContain("adversarial");
    expect(section).toContain("verif");
    // (a) hunt for tests that reimplement/stub the system-under-test
    expect(section).toMatch(/reimplement|stub/);
    expect(section).toContain("production seam");
  });

  it("requires a RED-verification note on constraint-guarding tests (AC 1)", () => {
    const section = buildAdversarialGateSection().toLowerCase();
    expect(section).toContain("red");
    expect(section).toMatch(/red[- ]verification|red note|proven to fail|fails? (against|pre-change|before)/);
  });

  it("biases the verifier toward false-negative over false-positive (AC 3)", () => {
    const section = buildAdversarialGateSection().toLowerCase();
    // Reject suspicious-but-plausible rather than accept it.
    expect(section).toMatch(/false[- ]negative|reject|falsely[- ]passing|cannot recover/);
  });

  it("directs the agent to flag/fail and surface the finding — never a silent pass (AC 4, AC 17)", () => {
    const section = buildAdversarialGateSection().toLowerCase();
    expect(section).toMatch(/flag|fail/);
    expect(section).toMatch(/surface|report|do not pass silently|never pass silently/);
  });

  it("scopes the RED-note demand to constraint-guarding tests, not ordinary tests (edge case)", () => {
    const section = buildAdversarialGateSection().toLowerCase();
    expect(section).toContain("constraint-guarding");
  });
});

describe("Part 1: gate instruction is injected at the REAL step-7 QA seam (AC 2, AC 16)", () => {
  it("the runner appends buildAdversarialGateSection to the step-7 QA agent prompt", async () => {
    // RED-verification: fails against the pre-change runner, which never
    // appends the adversarial-gate section to the step-7 task — proven by the
    // fact that `buildAdversarialGateSection` and its injection do not exist on
    // `main`, so `firstQaTaskPrompt()` would carry none of its text.
    const projectSlug = "adv-gate-step7";
    const projectPath = await initProject(projectSlug);
    seedState(projectSlug, 7);

    await runSprintFromStep(projectPath, projectSlug, SPRINT, 7);

    const section = buildAdversarialGateSection();
    const { context, taskDesc } = firstQaTaskPrompt();
    // The section may land in either the task description or the appended
    // context — assert it is present in the actual prompt the agent receives.
    expect(taskDesc + "\n" + context).toContain(section);
  });

  it("[no-regression] the step-7 gate still runs as an agent step and completes", async () => {
    const projectSlug = "adv-gate-step7-runs";
    const projectPath = await initProject(projectSlug);
    seedState(projectSlug, 7);

    await runSprintFromStep(projectPath, projectSlug, SPRINT, 7);

    // The QA gate is an instrumentable agent seam (not a no-op / user gate).
    expect(spawnAgentMock.mock.calls.some((c) => c[0] === ("qa" as Role))).toBe(true);
  });
});

// ===========================================================================
// Part 2 — Config surface parsed (AC 8, AC 9) — REAL loadConfig
// ===========================================================================

describe("Part 2: loadConfig parses the models key (AC 9 — no dead plumbing)", () => {
  // RED-verification: fails on pre-change `main` — `loadConfig` declares no
  // `models` key and never parses it (the config-keys-parsed-vs-declared defect
  // class). `config.models` is `undefined` before the fix.
  it("parses models.default and models.byRole from a config file", () => {
    const cfgPath = writeConfig({
      models: { default: "claude-default-model", byRole: { qa: "claude-verifier-model" } },
    });
    const config = loadConfig(cfgPath);
    expect(config.models).toBeDefined();
    expect(config.models?.default).toBe("claude-default-model");
    expect(config.models?.byRole?.qa).toBe("claude-verifier-model");
  });

  it("drops malformed models field-wise and never throws (AC 15, edge case)", () => {
    // models as an array → ignored entirely; a numeric byRole value and an
    // unknown role key are dropped field-wise (mirrors parseTimeouts).
    const arrayPath = writeConfig({ models: ["not", "an", "object"] });
    expect(() => loadConfig(arrayPath)).not.toThrow();
    expect(loadConfig(arrayPath).models).toBeUndefined();

    const junkPath = writeConfig({
      models: { default: 42, byRole: { qa: 7, notarole: "x", engineer: "claude-eng" } },
    });
    let parsed: RaptorConfig;
    expect(() => (parsed = loadConfig(junkPath))).not.toThrow();
    parsed = loadConfig(junkPath);
    // numeric default dropped
    expect(parsed.models?.default).toBeUndefined();
    // numeric qa dropped, unknown role dropped, valid engineer kept
    expect(parsed.models?.byRole?.qa).toBeUndefined();
    expect((parsed.models?.byRole as Record<string, string> | undefined)?.notarole).toBeUndefined();
    expect(parsed.models?.byRole?.engineer).toBe("claude-eng");
  });

  it("[no-regression] a config with no models key leaves config.models undefined (AC 15)", () => {
    const cfgPath = writeConfig({ projectsBaseDir: "/tmp/x" });
    expect(loadConfig(cfgPath).models).toBeUndefined();
  });
});

// ===========================================================================
// Part 2 — resolveRoleModel (AC 8, AC 10) — REAL resolver export
// ===========================================================================

describe("Part 2: resolveRoleModel (AC 8, AC 10)", () => {
  // RED-verification: `resolveRoleModel` is not exported from runner.ts on
  // `main`; the import fails to resolve pre-change.
  const cfg = (models?: RaptorConfig["models"]): RaptorConfig => ({
    projectsBaseDir: "/tmp/x",
    teamTemplatePath: null,
    models,
  });

  it("returns the per-role override when present (AC 8)", () => {
    const config = cfg({ default: "d", byRole: { qa: "claude-verifier-model" } });
    expect(resolveRoleModel("qa", config)).toBe("claude-verifier-model");
  });

  it("falls back to models.default when no per-role override exists (AC 8)", () => {
    const config = cfg({ default: "claude-default-model" });
    expect(resolveRoleModel("engineer", config)).toBe("claude-default-model");
  });

  it("a per-role override beats the default (AC 8)", () => {
    const config = cfg({ default: "claude-default-model", byRole: { qa: "claude-verifier-model" } });
    expect(resolveRoleModel("qa", config)).toBe("claude-verifier-model");
  });

  it("verifier ≠ generator when both are configured distinctly (AC 10)", () => {
    const config = cfg({ byRole: { qa: "claude-verifier-model", engineer: "claude-engineer-model" } });
    const verifier = resolveRoleModel("qa", config);
    const generator = resolveRoleModel("engineer", config);
    expect(verifier).toBeDefined();
    expect(generator).toBeDefined();
    expect(verifier).not.toBe(generator);
  });

  it("partial config: unconfigured generator falls back, verifier keeps its model (edge case)", () => {
    const config = cfg({ byRole: { qa: "claude-verifier-model" } });
    expect(resolveRoleModel("qa", config)).toBe("claude-verifier-model");
    // engineer unconfigured, no default → undefined (default model); still ≠ verifier.
    expect(resolveRoleModel("engineer", config)).toBeUndefined();
  });

  it("[no-regression] returns undefined for every role when no models config is set (AC 15)", () => {
    const config = cfg(undefined);
    for (const role of ["po", "architect", "qa", "engineer", "team"] as Role[]) {
      expect(resolveRoleModel(role, config)).toBeUndefined();
    }
  });
});

// ===========================================================================
// Part 2 — end-to-end: config file → parsed → resolved (AC 9)
// ===========================================================================

describe("Part 2: config file → loadConfig → resolveRoleModel (AC 9 end-to-end)", () => {
  it("a qa model set in a config file resolves for the qa role and not the engineer role", () => {
    const cfgPath = writeConfig({ models: { byRole: { qa: "claude-verifier-model" } } });
    const config = loadConfig(cfgPath);
    // The parsed key is live plumbing, not dead: it reaches the resolver.
    expect(resolveRoleModel("qa", config)).toBe("claude-verifier-model");
    expect(resolveRoleModel("engineer", config)).toBeUndefined();
  });
});

// ===========================================================================
// Part 3 — vacuous: no LLM-judge scoring gate / no ensemble (AC 11, AC 14)
// ===========================================================================

describe("Part 3: bias controls satisfied vacuously (AC 11, AC 14)", () => {
  it("no judge/ensemble/scoring gate is exported from the orchestrator surface", () => {
    const exportedNames = Object.keys(orchestratorIndex);
    const banned = /judge|ensemble|voting|scoreVerdict|abSwap|orderSwap/i;
    const offenders = exportedNames.filter((n) => banned.test(n));
    expect(offenders).toEqual([]);
  });
});
