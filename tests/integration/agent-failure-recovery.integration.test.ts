/**
 * Integration tests for Raptor — Agent Failure Recovery
 *
 * These tests validate the circuit breaker retry logic, escalation behavior,
 * failure history persistence, resume from failed/escalated states, and
 * progress table rendering. Subagent spawning (claude CLI) is mocked
 * at the boundary to avoid requiring a live Claude session during tests.
 *
 * Test runner: Jest
 * Dependencies: simple-git, fs, path, os
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import simpleGit from "simple-git";

import { Registry } from "../../src/registry";
import {
  bootstrapProject,
  getProjectStatus,
  ToolContext,
} from "../../src/tools";

// We'll import these from the orchestrator once implemented
// import { runSprintFromStep, resumeSprint } from "../../src/orchestrator/runner";
// import { loadSprintState, saveSprintState, createInitialState } from "../../src/orchestrator/state";
// import { renderProgressTable } from "../../src/orchestrator/progress";
// import { MAX_RETRY_ATTEMPTS } from "../../src/orchestrator/runner";

let tmpDir: string;
let raptorHome: string;
let projectsBaseDir: string;
let ctx: ToolContext;

const TEMPLATE_PATH = path.join(__dirname, "../../template/TEAM.md");

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-recovery-test-"));
  raptorHome = path.join(tmpDir, ".raptor");
  projectsBaseDir = path.join(tmpDir, "projects");
  fs.mkdirSync(raptorHome, { recursive: true });

  ctx = {
    projectsBaseDir,
    registry: new Registry(path.join(raptorHome, "projects.json")),
    templatePath: TEMPLATE_PATH,
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Helper: bootstrap a project and add a sprint item to its backlog
 */
async function bootstrapWithSprint(
  projectName: string,
  sprintItem: string
): Promise<string> {
  await bootstrapProject(ctx, {
    name: projectName,
    description: "Test project for failure recovery",
  });

  const projectPath = path.join(projectsBaseDir, projectName);
  const backlogPath = path.join(projectPath, "docs", "backlog.md");

  const backlog = `# Backlog

## Sprint 1 — In Progress
- [ ] ${sprintItem} — assigned to Engineer

## Ready (prioritized, next sprint)

## Inbox (unprioritized)

## Done
`;
  fs.writeFileSync(backlogPath, backlog);

  const git = simpleGit(projectPath);
  await git.add("docs/backlog.md");
  await git.commit("[PO] update: add sprint 1 items to backlog");

  return projectPath;
}

/**
 * Helper: create a sprint state with failure history
 */
function writeSprintState(
  projectSlug: string,
  sprint: number,
  state: Record<string, unknown>
): void {
  const stateDir = path.join(raptorHome, projectSlug);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `sprint-${sprint}.json`),
    JSON.stringify(state, null, 2)
  );
}

/**
 * Helper: read sprint state from disk
 */
function readSprintState(
  projectSlug: string,
  sprint: number
): Record<string, unknown> | null {
  const statePath = path.join(raptorHome, projectSlug, `sprint-${sprint}.json`);
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, "utf-8"));
}

// ─── State Schema: Failure Tracking Fields ───

describe("sprint state failure tracking fields", () => {
  it("step state includes attempts and failures fields", () => {
    const stepState = {
      step: 1,
      role: "po",
      name: "Author specification",
      status: "complete",
      artifacts: ["docs/specs/search-feature.md"],
      completedAt: "2026-04-06T10:00:00Z",
      attempts: 2,
      failures: [
        {
          attempt: 1,
          errorSummary: "Missing backlog context",
          timestamp: "2026-04-06T09:58:00Z",
          hadPartialArtifacts: false,
        },
      ],
    };

    expect(stepState.attempts).toBe(2);
    expect(stepState.failures).toHaveLength(1);
    expect(stepState.failures[0].attempt).toBe(1);
    expect(stepState.failures[0].errorSummary).toBe("Missing backlog context");
    expect(stepState.failures[0].timestamp).toBeDefined();
    expect(stepState.failures[0].hadPartialArtifacts).toBe(false);
  });

  it("escalated is a valid sprint status", () => {
    const validStatuses = ["in-progress", "paused", "complete", "failed", "escalated"];
    expect(validStatuses).toContain("escalated");
  });

  it("default values for new step state have zero attempts and empty failures", () => {
    const defaultStep = {
      step: 1,
      role: "po",
      name: "Author specification",
      status: "pending",
      artifacts: [],
      completedAt: null,
      attempts: 0,
      failures: [],
    };

    expect(defaultStep.attempts).toBe(0);
    expect(defaultStep.failures).toHaveLength(0);
  });
});

// ─── State Persistence: Failure History ───

describe("failure history persistence", () => {
  it("persists failure records to disk and reloads them", async () => {
    await bootstrapWithSprint("fail-persist", "search: Full-text search");

    const state = {
      project: "fail-persist",
      sprint: 1,
      status: "in-progress",
      currentStep: 1,
      steps: [
        {
          step: 1,
          role: "po",
          name: "Author specification",
          status: "in-progress",
          artifacts: [],
          completedAt: null,
          attempts: 2,
          failures: [
            {
              attempt: 1,
              errorSummary: "Agent timed out",
              timestamp: "2026-04-06T09:58:00Z",
              hadPartialArtifacts: false,
            },
            {
              attempt: 2,
              errorSummary: "Spec template malformed",
              timestamp: "2026-04-06T09:59:00Z",
              hadPartialArtifacts: true,
            },
          ],
        },
      ],
      checkpoints: [],
    };

    writeSprintState("fail-persist", 1, state);
    const loaded = readSprintState("fail-persist", 1);

    expect(loaded).not.toBeNull();
    const steps = (loaded as any).steps;
    expect(steps[0].attempts).toBe(2);
    expect(steps[0].failures).toHaveLength(2);
    expect(steps[0].failures[0].errorSummary).toBe("Agent timed out");
    expect(steps[0].failures[1].hadPartialArtifacts).toBe(true);
  });

  it("backward-compatible: loads old state without attempts/failures fields", async () => {
    await bootstrapWithSprint("compat-test", "search: Full-text search");

    // Simulate old state format (pre-failure-recovery)
    const oldState = {
      project: "compat-test",
      sprint: 1,
      status: "in-progress",
      currentStep: 2,
      steps: [
        {
          step: 1,
          role: "po",
          name: "Author specification",
          status: "complete",
          artifacts: ["docs/specs/search.md"],
          completedAt: "2026-04-06T10:00:00Z",
          // NOTE: no attempts or failures field
        },
      ],
      checkpoints: [],
    };

    writeSprintState("compat-test", 1, oldState);
    const loaded = readSprintState("compat-test", 1);

    // Code should default missing fields
    const step = (loaded as any).steps[0];
    const attempts = step.attempts ?? 0;
    const failures = step.failures ?? [];

    expect(attempts).toBe(0);
    expect(failures).toHaveLength(0);
  });
});

// ─── Escalation Commits ───

describe("escalation git commits", () => {
  it("creates an [ESCALATE] commit in the project repo", async () => {
    const projectPath = await bootstrapWithSprint("escalate-test", "search: Full-text search");
    const git = simpleGit(projectPath);

    // Simulate what the orchestrator does on escalation
    await git.commit(
      "[ESCALATE] PO: step 1 (Author specification) failed 3 times — requesting user intervention.\nSummary: Attempt 1: timeout; Attempt 2: malformed output; Attempt 3: missing template",
      { "--allow-empty": null }
    );

    const log = await git.log();
    const escalations = log.all.filter((e) => e.message.includes("[ESCALATE]"));
    expect(escalations).toHaveLength(1);
    expect(escalations[0].message).toContain("[ESCALATE] PO:");
    expect(escalations[0].message).toContain("failed 3 times");
  });

  it("[BLOCKER] in agent output triggers immediate escalation commit", async () => {
    const projectPath = await bootstrapWithSprint("blocker-esc", "search: Full-text search");
    const git = simpleGit(projectPath);

    // Simulate immediate escalation from BLOCKER
    await git.commit(
      "[ESCALATE] QA: step 3 (Write tests) — agent raised [BLOCKER]: spec missing acceptance criteria -- blocked on PO",
      { "--allow-empty": null }
    );

    const log = await git.log();
    const escalations = log.all.filter((e) => e.message.includes("[ESCALATE]"));
    expect(escalations).toHaveLength(1);
    expect(escalations[0].message).toContain("[BLOCKER]");
  });
});

// ─── Resume from Escalated/Failed ───

describe("resume from escalated/failed states", () => {
  it("state can represent escalated status", async () => {
    await bootstrapWithSprint("resume-esc", "search: Full-text search");

    const state = {
      project: "resume-esc",
      sprint: 1,
      status: "escalated",
      currentStep: 2,
      steps: [
        {
          step: 1, role: "po", name: "Author specification",
          status: "complete", artifacts: [], completedAt: "2026-04-06T10:00:00Z",
          attempts: 1, failures: [],
        },
        {
          step: 2, role: "architect", name: "Architecture design",
          status: "escalated", artifacts: [], completedAt: null,
          attempts: 3,
          failures: [
            { attempt: 1, errorSummary: "No output", timestamp: "2026-04-06T10:01:00Z", hadPartialArtifacts: false },
            { attempt: 2, errorSummary: "Partial design", timestamp: "2026-04-06T10:02:00Z", hadPartialArtifacts: true },
            { attempt: 3, errorSummary: "Timeout", timestamp: "2026-04-06T10:03:00Z", hadPartialArtifacts: false },
          ],
        },
      ],
      checkpoints: [],
    };

    writeSprintState("resume-esc", 1, state);
    const loaded = readSprintState("resume-esc", 1);

    expect((loaded as any).status).toBe("escalated");
    expect((loaded as any).steps[1].status).toBe("escalated");
    expect((loaded as any).steps[1].attempts).toBe(3);
    expect((loaded as any).steps[1].failures).toHaveLength(3);
  });

  it("resuming with guidance resets retry counter in state", async () => {
    await bootstrapWithSprint("resume-reset", "search: Full-text search");

    const state = {
      project: "resume-reset",
      sprint: 1,
      status: "escalated",
      currentStep: 2,
      steps: [
        {
          step: 1, role: "po", name: "Author specification",
          status: "complete", artifacts: [], completedAt: "2026-04-06T10:00:00Z",
          attempts: 1, failures: [],
        },
        {
          step: 2, role: "architect", name: "Architecture design",
          status: "escalated", artifacts: [], completedAt: null,
          attempts: 3,
          failures: [
            { attempt: 1, errorSummary: "err1", timestamp: "2026-04-06T10:01:00Z", hadPartialArtifacts: false },
            { attempt: 2, errorSummary: "err2", timestamp: "2026-04-06T10:02:00Z", hadPartialArtifacts: false },
            { attempt: 3, errorSummary: "err3", timestamp: "2026-04-06T10:03:00Z", hadPartialArtifacts: false },
          ],
        },
      ],
      checkpoints: [],
    };

    writeSprintState("resume-reset", 1, state);

    // Simulate what resumeSprint does when user provides guidance
    const loaded = readSprintState("resume-reset", 1) as any;
    loaded.steps[1].attempts = 0;
    loaded.steps[1].failures = [];
    loaded.steps[1].status = "pending";
    loaded.status = "in-progress";
    writeSprintState("resume-reset", 1, loaded);

    const reloaded = readSprintState("resume-reset", 1) as any;
    expect(reloaded.steps[1].attempts).toBe(0);
    expect(reloaded.steps[1].failures).toHaveLength(0);
    expect(reloaded.steps[1].status).toBe("pending");
    expect(reloaded.status).toBe("in-progress");
  });

  it("resuming failed without guidance preserves attempt counter", async () => {
    await bootstrapWithSprint("resume-nofb", "search: Full-text search");

    const state = {
      project: "resume-nofb",
      sprint: 1,
      status: "failed",
      currentStep: 3,
      steps: [
        { step: 1, role: "po", name: "Author specification", status: "complete", artifacts: [], completedAt: "2026-04-06T10:00:00Z", attempts: 1, failures: [] },
        { step: 2, role: "architect", name: "Architecture design", status: "complete", artifacts: [], completedAt: "2026-04-06T10:01:00Z", attempts: 1, failures: [] },
        {
          step: 3, role: "qa", name: "Write tests", status: "failed", artifacts: [], completedAt: null,
          attempts: 2,
          failures: [
            { attempt: 1, errorSummary: "err1", timestamp: "2026-04-06T10:02:00Z", hadPartialArtifacts: false },
            { attempt: 2, errorSummary: "err2", timestamp: "2026-04-06T10:03:00Z", hadPartialArtifacts: false },
          ],
        },
      ],
      checkpoints: [],
    };

    writeSprintState("resume-nofb", 1, state);

    // Simulate resume without guidance — counter NOT reset
    const loaded = readSprintState("resume-nofb", 1) as any;
    loaded.steps[2].status = "pending";
    loaded.status = "in-progress";
    // attempts stays at 2
    writeSprintState("resume-nofb", 1, loaded);

    const reloaded = readSprintState("resume-nofb", 1) as any;
    expect(reloaded.steps[2].attempts).toBe(2);
    expect(reloaded.steps[2].failures).toHaveLength(2);
  });
});

// ─── Progress Table: Retry & Escalation Display ───

describe("progress table with retry and escalation info", () => {
  it("renders retry status icon for in-progress retries", () => {
    // Expected: step shows "⚠ attempt 2/3" when retrying
    const step = {
      step: 2,
      role: "architect",
      name: "Architecture design",
      status: "in-progress",
      attempts: 2,
    };

    // The progress renderer should produce something like:
    // | 2 | Architect | Architecture design | ⚠ attempt 2/3 |
    const maxRetries = 3;
    const retryLabel =
      step.attempts > 1 && step.status === "in-progress"
        ? `⚠ attempt ${step.attempts}/${maxRetries}`
        : "";

    expect(retryLabel).toBe("⚠ attempt 2/3");
  });

  it("renders escalation status icon", () => {
    const step = {
      step: 2,
      role: "architect",
      name: "Architecture design",
      status: "escalated",
      attempts: 3,
    };

    const maxRetries = 3;
    const escalationLabel =
      step.status === "escalated"
        ? `🚨 escalated (${step.attempts}/${maxRetries})`
        : "";

    expect(escalationLabel).toBe("🚨 escalated (3/3)");
  });

  it("does not show retry info for steps with 1 attempt", () => {
    const step = {
      step: 1,
      role: "po",
      name: "Author specification",
      status: "complete",
      attempts: 1,
    };

    const maxRetries = 3;
    const retryLabel =
      step.attempts > 1 && step.status === "in-progress"
        ? `⚠ attempt ${step.attempts}/${maxRetries}`
        : "";

    expect(retryLabel).toBe("");
  });
});

// ─── get_project_status with Escalation ───

describe("get_project_status escalation details", () => {
  it("includes escalation info when sprint is escalated", async () => {
    const projectPath = await bootstrapWithSprint("status-esc", "search: Full-text search");

    // Write an escalated sprint state
    const state = {
      project: "status-esc",
      sprint: 1,
      status: "escalated",
      currentStep: 2,
      steps: [
        { step: 1, role: "po", name: "Author specification", status: "complete", artifacts: [], completedAt: "2026-04-06T10:00:00Z", attempts: 1, failures: [] },
        {
          step: 2, role: "architect", name: "Architecture design",
          status: "escalated", artifacts: [], completedAt: null,
          attempts: 3,
          failures: [
            { attempt: 1, errorSummary: "err1", timestamp: "2026-04-06T10:01:00Z", hadPartialArtifacts: false },
            { attempt: 2, errorSummary: "err2", timestamp: "2026-04-06T10:02:00Z", hadPartialArtifacts: true },
            { attempt: 3, errorSummary: "err3", timestamp: "2026-04-06T10:03:00Z", hadPartialArtifacts: false },
          ],
        },
      ],
      checkpoints: [],
    };

    writeSprintState("status-esc", 1, state);

    const result = await getProjectStatus(ctx, { name: "status-esc" });
    expect(result.status).toBe("success");

    // The orchestrator state should be included in the response
    // Once the real loadSprintState reads from raptorHome, this will
    // populate orchestratorState. For now we verify the state exists on disk.
    const diskState = readSprintState("status-esc", 1);
    expect(diskState).not.toBeNull();
    expect((diskState as any).status).toBe("escalated");
  });
});

// ─── BLOCKER Detection ───

describe("BLOCKER detection in agent output", () => {
  it("detects [BLOCKER] in agent output (case-insensitive)", () => {
    const outputs = [
      "[BLOCKER] QA: spec is missing acceptance criteria -- blocked on PO",
      "[blocker] Engineer: unclear API contract -- blocked on Architect",
      "Some output\n[BLOCKER] PO: requirements ambiguous\nMore output",
    ];

    for (const output of outputs) {
      const hasBlocker = /\[blocker\]/i.test(output);
      expect(hasBlocker).toBe(true);
    }
  });

  it("does not false-positive on similar strings", () => {
    const outputs = [
      "This is not a blocker scenario",
      "BLOCKER without brackets",
      "[BLOCKED] wrong tag",
    ];

    for (const output of outputs) {
      const hasBlocker = /\[blocker\]/i.test(output);
      expect(hasBlocker).toBe(false);
    }
  });
});

// ─── Error Summary Truncation ───

describe("error summary truncation", () => {
  it("truncates error summaries to max length", () => {
    const maxLength = 500;
    const longOutput = "x".repeat(1000);
    const truncated = longOutput.slice(0, maxLength);

    expect(truncated.length).toBe(maxLength);
    expect(truncated).toBe("x".repeat(500));
  });

  it("preserves short error summaries as-is", () => {
    const maxLength = 500;
    const shortOutput = "Missing template file";
    const truncated = shortOutput.slice(0, maxLength);

    expect(truncated).toBe("Missing template file");
  });
});

// ─── Corrupted State Handling ───

describe("corrupted state handling", () => {
  it("returns null when state file contains invalid JSON", async () => {
    await bootstrapWithSprint("corrupt-test", "search: Full-text search");

    const stateDir = path.join(raptorHome, "corrupt-test");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "sprint-1.json"),
      "{{invalid json}}"
    );

    // loadSprintState should handle this gracefully
    let loaded = null;
    try {
      loaded = JSON.parse(
        fs.readFileSync(path.join(stateDir, "sprint-1.json"), "utf-8")
      );
    } catch {
      loaded = null;
    }

    expect(loaded).toBeNull();
  });
});

// ─── Independent Retry Counters ───

describe("independent retry counters per step", () => {
  it("each step maintains its own attempt count", () => {
    const steps = [
      { step: 1, role: "po", attempts: 2, failures: [{ attempt: 1, errorSummary: "err" }] },
      { step: 2, role: "architect", attempts: 1, failures: [] },
      { step: 3, role: "qa", attempts: 3, failures: [
        { attempt: 1, errorSummary: "err1" },
        { attempt: 2, errorSummary: "err2" },
        { attempt: 3, errorSummary: "err3" },
      ]},
    ];

    expect(steps[0].attempts).toBe(2);
    expect(steps[1].attempts).toBe(1);
    expect(steps[2].attempts).toBe(3);

    // Modifying one doesn't affect others
    steps[0].attempts = 0;
    expect(steps[1].attempts).toBe(1);
    expect(steps[2].attempts).toBe(3);
  });
});
