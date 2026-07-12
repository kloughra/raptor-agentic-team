/**
 * Integration tests for: reset-sprint-tool
 *
 * Spec:         docs/specs/reset-sprint-tool.md
 * Architecture: docs/architecture/reset-sprint-tool.md
 *
 * TDD note (step 3 of the sprint workflow — tests BEFORE code): `reset_sprint`,
 * its tool function `resetSprintTool` (src/tools.ts), and the new state helper
 * `deleteSprintState` (src/orchestrator/state.ts) DO NOT EXIST YET. These tests
 * pin the post-implementation contract and are EXPECTED TO FAIL against the
 * pre-change code — that is the RED signal required by TEAM.md QA rule 12.
 *
 * ── RED-VERIFICATION (how these tests are proven to FAIL pre-change) ──────────
 *   • `resetSprintTool` is reached via an untyped `require("../../src/tools")`.
 *     Today `toolsApi.resetSprintTool` is `undefined`, so `invokeReset(...)`
 *     throws a TypeError → every constraint scenario goes RED. Once the tool
 *     lands, the same call returns the structured `{ status, ... }` object.
 *   • `deleteSprintState` is reached via an untyped `require("../../src/orchestrator/state")`.
 *     Today it is `undefined`; the "state helper" describe block goes RED until
 *     the helper exists.
 *   • The `in-progress` clean-slate case is the crux: `resume_sprint` REFUSES
 *     `in-progress` at the un-resumable wall (runner.ts:1818), and there is no
 *     built-in path to clear it today. The test asserting the file is gone after
 *     reset cannot pass without the new tool.
 *
 * PRODUCTION SEAM (AC 12): these tests drive the REAL `resetSprintTool` through a
 * REAL `ToolContext` (real `Registry`, real project dir on disk) against a REAL
 * temp `~/.raptor` state file written by the REAL `saveSprintState`. The only
 * redirection is `os.homedir()` (via the jest os-shim) so state lands in a temp
 * dir instead of the real ~/.raptor. The filesystem layer is NOT mocked — that
 * is the whole point (a mock would neuter the regression coverage).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { Registry } from "../../src/registry";
import {
  createInitialState,
  saveSprintState,
  loadSprintState,
  SprintState,
} from "../../src/orchestrator/state";
import { SPRINT_WORKFLOW } from "../../src/orchestrator/workflow";

// Untyped access to the not-yet-implemented tool + state helper so this file
// COMPILES against pre-change code and the assertions go RED (never a compile
// error). Do NOT convert these to typed imports before the code lands.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const toolsApi: any = require("../../src/tools");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stateApi: any = require("../../src/orchestrator/state");

type ToolCtx = {
  projectsBaseDir: string;
  registry: Registry;
  templatePath: string;
};

const SLUG = "reset-proj";
const SPRINT = 16;

let tmpHome: string;
let homedirSpy: jest.SpiedFunction<typeof os.homedir>;
let projectDir: string;
let registry: Registry;
let ctx: ToolCtx;

function workflowSteps() {
  return SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name }));
}

/**
 * Write a REAL sprint state file at ~/.raptor/{slug}/sprint-{N}.json (temp home)
 * via the REAL saveSprintState, with the requested overall status and a couple
 * of non-clean-slate steps so "clean slate" is a meaningful assertion.
 */
function seedState(
  status: SprintState["status"],
  slug: string = SLUG,
  sprint: number = SPRINT
): SprintState {
  const state = createInitialState(slug, sprint, workflowSteps(), `sprint-${sprint}/x`);
  state.status = status;
  // Dirty the slate: attempts, failures, a checkpoint, mixed step statuses.
  state.currentStep = 5;
  state.steps[0].status = "complete";
  state.steps[0].completedAt = "2026-07-12T00:00:00.000Z";
  state.steps[4].status = status === "complete" ? "complete" : "escalated";
  state.steps[4].attempts = 3;
  state.steps[4].failures = [
    {
      attempt: 1,
      errorSummary: "boom",
      timestamp: "2026-07-12T00:00:01.000Z",
      hadPartialArtifacts: false,
    },
  ];
  state.checkpoints = [
    { type: "tech-approval", status: "pending", feedback: null, resolvedAt: null },
  ];
  saveSprintState(slug, sprint, state);
  return state;
}

function stateFilePath(slug: string = SLUG, sprint: number = SPRINT): string {
  return path.join(tmpHome, ".raptor", slug, `sprint-${sprint}.json`);
}

/** Call the real tool; if it doesn't exist yet this throws → RED (by design). */
async function invokeReset(args: {
  name: string;
  sprint: number;
  confirm?: boolean;
}): Promise<Record<string, any>> {
  return toolsApi.resetSprintTool(ctx, args);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "reset-sprint-"));
  homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(tmpHome);

  // Real project directory on disk (so the missing-dir guard passes for the
  // happy paths) and a real Registry backed by a temp projects.json.
  projectDir = path.join(tmpHome, "workspace", SLUG);
  fs.mkdirSync(projectDir, { recursive: true });

  registry = new Registry(path.join(tmpHome, ".raptor", "projects.json"));
  // Seed the registry file directly through the real write path.
  return registry
    .addProject({
      name: SLUG,
      slug: SLUG,
      description: "reset tool fixture",
      path: projectDir,
      createdAt: "2026-07-12T00:00:00.000Z",
    })
    .then(() => {
      ctx = {
        projectsBaseDir: path.join(tmpHome, "workspace"),
        registry,
        templatePath: path.join(tmpHome, "TEAM.md"),
      };
    });
});

afterEach(() => {
  homedirSpy.mockRestore();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ===========================================================================
// AC 1 — reset_sprint exists as a real tool function returning { status, ... }
// ===========================================================================

describe("AC 1: resetSprintTool is a real tool function", () => {
  // RED note: `toolsApi.resetSprintTool` is undefined pre-change → this fails.
  it("is exported from src/tools.ts", () => {
    expect(typeof toolsApi.resetSprintTool).toBe("function");
  });
});

// ===========================================================================
// AC 4, 5 — Clean slate; rescues escalated / failed / in-progress / paused
// ===========================================================================

describe("AC 4 & 5: reset clears every wedged status to a clean slate", () => {
  const wedged: SprintState["status"][] = [
    "escalated",
    "failed",
    "in-progress",
    "paused",
  ];

  for (const status of wedged) {
    // RED note: no reset_sprint today; `in-progress` in particular is the
    // un-resumable limbo (runner.ts:1818) with no built-in clear path.
    it(`clears a '${status}' state so the file is gone and a fresh run starts at step 1`, async () => {
      seedState(status);
      expect(fs.existsSync(stateFilePath())).toBe(true);

      const res = await invokeReset({ name: SLUG, sprint: SPRINT });

      expect(res.status).toBe("success");
      expect(res.priorStatus).toBe(status);
      // Clean slate == pre-first-run condition: no state file, so loadSprintState
      // returns null and run_sprint rebuilds initial state from step 1 (AC 4).
      expect(fs.existsSync(stateFilePath())).toBe(false);
      expect(loadSprintState(SLUG, SPRINT)).toBeNull();
    });
  }

  // RED note: the primary target. resume_sprint refuses in-progress; only reset
  // frees it, so this cannot pass without the new tool.
  it("frees the in-progress limbo that resume_sprint refuses", async () => {
    seedState("in-progress");
    const res = await invokeReset({ name: SLUG, sprint: SPRINT });
    expect(res.status).toBe("success");
    expect(res.priorStatus).toBe("in-progress");
    expect(fs.existsSync(stateFilePath())).toBe(false);
  });
});

// ===========================================================================
// AC 9 — Response names outcome and next action
// ===========================================================================

describe("AC 9: successful response names project, sprint, prior status, next action", () => {
  // RED note: resetSprintTool undefined pre-change → throws.
  it("reports project, sprint, priorStatus, and a run_sprint next action", async () => {
    seedState("escalated");
    const res = await invokeReset({ name: SLUG, sprint: SPRINT });

    expect(res.status).toBe("success");
    expect(res.project).toBe(SLUG);
    expect(res.sprint).toBe(SPRINT);
    expect(res.priorStatus).toBe("escalated");
    expect(typeof res.message).toBe("string");
    expect(String(res.nextAction)).toContain("run_sprint");
    expect(String(res.nextAction)).toContain(SLUG);
    expect(String(res.nextAction)).toContain(String(SPRINT));
  });
});

// ===========================================================================
// AC 6, NFR-2 — No-state informative no-op success; idempotency
// ===========================================================================

describe("AC 6 & NFR-2: no-state is an informative success no-op and idempotent", () => {
  // RED note: pre-change there is no tool to return this shape.
  it("returns success with priorStatus 'none' when no state file exists", async () => {
    expect(fs.existsSync(stateFilePath())).toBe(false);
    const res = await invokeReset({ name: SLUG, sprint: SPRINT });

    expect(res.status).toBe("success");
    expect(res.priorStatus).toBe("none");
    expect(String(res.message).toLowerCase()).toMatch(/nothing to reset|no sprint state/);
  });

  it("is safe to call twice — the second call is a success no-op", async () => {
    seedState("failed");
    const first = await invokeReset({ name: SLUG, sprint: SPRINT });
    expect(first.status).toBe("success");
    expect(first.priorStatus).toBe("failed");

    const second = await invokeReset({ name: SLUG, sprint: SPRINT });
    expect(second.status).toBe("success");
    expect(second.priorStatus).toBe("none");
  });

  it("treats an invalid/never-started sprint number as a no-op success", async () => {
    const res = await invokeReset({ name: SLUG, sprint: 999 });
    expect(res.status).toBe("success");
    expect(res.priorStatus).toBe("none");
  });
});

// ===========================================================================
// AC 7 — Guard against wiping a completed sprint
// ===========================================================================

describe("AC 7: a complete sprint is guarded by the confirm flag", () => {
  // RED note: no guard exists pre-change (no tool at all).
  it("refuses a complete sprint without confirm and leaves the state file intact", async () => {
    seedState("complete");
    const res = await invokeReset({ name: SLUG, sprint: SPRINT });

    expect(res.status).toBe("error");
    expect(res.priorStatus).toBe("complete");
    expect(String(res.message).toLowerCase()).toMatch(/complete/);
    expect(String(res.message).toLowerCase()).toMatch(/confirm/);
    // The shipped record is NOT discarded.
    expect(fs.existsSync(stateFilePath())).toBe(true);
  });

  it("clears a complete sprint when confirm=true", async () => {
    seedState("complete");
    const res = await invokeReset({ name: SLUG, sprint: SPRINT, confirm: true });

    expect(res.status).toBe("success");
    expect(res.priorStatus).toBe("complete");
    expect(fs.existsSync(stateFilePath())).toBe(false);
  });

  it("does NOT require confirm for a wedged (escalated) sprint", async () => {
    seedState("escalated");
    const res = await invokeReset({ name: SLUG, sprint: SPRINT });
    expect(res.status).toBe("success");
    expect(fs.existsSync(stateFilePath())).toBe(false);
  });
});

// ===========================================================================
// AC 3 — Project-resolution parity with run_sprint / resume_sprint
// ===========================================================================

describe("AC 3: project-resolution parity — errors returned, never thrown", () => {
  // RED note: resetSprintTool undefined pre-change → throws instead of returning.
  it("returns an error for an unknown project", async () => {
    const res = await invokeReset({ name: "no-such-project", sprint: SPRINT });
    expect(res.status).toBe("error");
    expect(String(res.message).toLowerCase()).toMatch(/not found|unknown/);
  });

  it("returns an error when the registered project directory is missing on disk", async () => {
    const goneSlug = "gone-proj";
    await registry.addProject({
      name: goneSlug,
      slug: goneSlug,
      description: "missing on disk",
      path: path.join(tmpHome, "workspace", "does-not-exist"),
      createdAt: "2026-07-12T00:00:00.000Z",
    });

    const res = await invokeReset({ name: goneSlug, sprint: SPRINT });
    expect(res.status).toBe("error");
    expect(String(res.message).toLowerCase()).toMatch(/missing|not exist|directory/);
  });

  it("never throws to the transport on a resolution failure", async () => {
    await expect(
      invokeReset({ name: "no-such-project", sprint: SPRINT })
    ).resolves.toBeDefined();
  });
});

// ===========================================================================
// AC 8, NFR-4 — Scope boundary: only the sprint state file is touched
// ===========================================================================

describe("AC 8 & NFR-4: reset touches only ~/.raptor/{slug}/sprint-{N}.json", () => {
  // RED note: no tool exists to assert this containment against pre-change.
  it("removes only the target state file, leaving siblings and the registry intact", async () => {
    seedState("escalated", SLUG, SPRINT);
    // A sibling sprint's state file under the same slug.
    seedState("in-progress", SLUG, SPRINT + 1);

    // Durable, version-controlled work that must survive a reset.
    const backlogPath = path.join(projectDir, "docs", "backlog.md");
    fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
    fs.writeFileSync(backlogPath, "# Backlog\n");
    const summaryPath = path.join(projectDir, "docs", "sprints", "sprint-16-summary.md");
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, "# Sprint 16 Summary\n");

    const registryPath = path.join(tmpHome, ".raptor", "projects.json");
    const registryBefore = fs.readFileSync(registryPath, "utf-8");

    const res = await invokeReset({ name: SLUG, sprint: SPRINT });
    expect(res.status).toBe("success");

    // Target gone; sibling sprint state, backlog, summary, registry all intact.
    expect(fs.existsSync(stateFilePath(SLUG, SPRINT))).toBe(false);
    expect(fs.existsSync(stateFilePath(SLUG, SPRINT + 1))).toBe(true);
    expect(fs.readFileSync(backlogPath, "utf-8")).toBe("# Backlog\n");
    expect(fs.readFileSync(summaryPath, "utf-8")).toBe("# Sprint 16 Summary\n");
    expect(fs.readFileSync(registryPath, "utf-8")).toBe(registryBefore);
  });
});

// ===========================================================================
// AC 10, NFR-3 — Real FS failures surface as errors, not swallowed successes
// ===========================================================================

describe("AC 10 & NFR-3: a genuine FS failure surfaces as an error", () => {
  // RED note: no tool + no deleteSprintState to fail through pre-change.
  it("returns { status: 'error' } (never a false success) when deletion throws", async () => {
    seedState("in-progress");

    // Force the underlying delete to fail with a real FS-style error so the
    // tool's try/catch (AC 10) is exercised — a mock of fs.rmSync is acceptable
    // here because we are provoking the ERROR path, not the happy-path delete
    // (which the other suites drive against the real filesystem).
    const rmSpy = jest
      .spyOn(fs, "rmSync")
      .mockImplementation(() => {
        throw new Error("EACCES: permission denied, unlink");
      });

    try {
      const res = await invokeReset({ name: SLUG, sprint: SPRINT });
      expect(res.status).toBe("error");
      expect(String(res.message)).toMatch(/EACCES|permission denied|Failed to clear/i);
      // Truthfulness: on a failed delete the state file is NOT reported gone.
      expect(fs.existsSync(stateFilePath())).toBe(true);
    } finally {
      rmSpy.mockRestore();
    }
  });
});

// ===========================================================================
// AC 11, NFR-6 — Distinct from resume: no feedback, no re-attempt, no auto-run
// ===========================================================================

describe("AC 11 & NFR-6: reset is isolated from resume — clears and stops", () => {
  // RED note: pre-change there is no tool; post-change this pins that reset
  // does not re-run the sprint (no `progress`/`checkpoint` re-attempt payload).
  it("accepts no feedback argument and returns without re-engaging the sprint", async () => {
    seedState("in-progress");
    const res = await invokeReset({ name: SLUG, sprint: SPRINT });

    expect(res.status).toBe("success");
    // Reset stops after clearing — it does not produce a resume-style re-attempt
    // (no checkpoint payload) and directs the caller to run_sprint next (AC 11).
    expect(res.checkpoint).toBeUndefined();
    expect(String(res.nextAction)).toMatch(/run_sprint/);
    // The state file is gone (cleared), not re-seeded by an implicit run.
    expect(fs.existsSync(stateFilePath())).toBe(false);
  });
});

// ===========================================================================
// State helper — deleteSprintState (src/orchestrator/state.ts)
// ===========================================================================

describe("state helper: deleteSprintState is encapsulated and idempotent", () => {
  // RED note: `stateApi.deleteSprintState` is undefined pre-change.
  it("is exported from state.ts", () => {
    expect(typeof stateApi.deleteSprintState).toBe("function");
  });

  it("returns true and removes an existing file, false when absent (idempotent)", () => {
    seedState("escalated");
    expect(fs.existsSync(stateFilePath())).toBe(true);

    const existed = stateApi.deleteSprintState(SLUG, SPRINT);
    expect(existed).toBe(true);
    expect(fs.existsSync(stateFilePath())).toBe(false);

    // Second call: nothing to remove → false, no throw.
    const again = stateApi.deleteSprintState(SLUG, SPRINT);
    expect(again).toBe(false);
  });
});
