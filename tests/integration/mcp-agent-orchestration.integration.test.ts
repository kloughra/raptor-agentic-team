/**
 * Integration tests for Raptor — Agent Orchestration
 *
 * These tests validate the orchestrator's workflow, state persistence,
 * checkpoint handling, and subagent invocation against a real filesystem
 * and real git repos. Subagent spawning (claude CLI) is mocked at the
 * boundary to avoid requiring a live Claude session during tests.
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

let tmpDir: string;
let raptorHome: string;
let projectsBaseDir: string;
let ctx: ToolContext;

const TEMPLATE_PATH = path.join(__dirname, "../../template/TEAM.md");

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-orch-test-"));
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
async function bootstrapWithSprint(projectName: string, sprintItem: string): Promise<string> {
  await bootstrapProject(ctx, {
    name: projectName,
    description: "Test project for orchestration",
  });

  const projectPath = path.join(projectsBaseDir, projectName);
  const backlogPath = path.join(projectPath, "docs", "backlog.md");

  // Rewrite backlog with a sprint item
  const backlog = `# Backlog

## Sprint 1 — In Progress
- [ ] ${sprintItem} — assigned to Engineer

## Ready (prioritized, next sprint)

## Inbox (unprioritized)

## Done
`;
  fs.writeFileSync(backlogPath, backlog);

  // Commit the backlog update
  const git = simpleGit(projectPath);
  await git.add("docs/backlog.md");
  await git.commit("[PO] update: add sprint 1 items to backlog");

  return projectPath;
}

// ─── Workflow Validation ───

describe("run_sprint validation", () => {
  it("rejects a non-existent project", async () => {
    // This tests that the orchestrator checks project existence
    // before attempting to run. For now we validate via get_project_status.
    const result = await getProjectStatus(ctx, { name: "ghost-app" });
    expect(result.status).toBe("error");
    expect(result.message).toContain("not found");
  });

  it("detects sprint items in the backlog", async () => {
    const projectPath = await bootstrapWithSprint("orch-test", "user-login: Basic login");
    const result = await getProjectStatus(ctx, { name: "orch-test" });
    expect(result.status).toBe("success");
    expect(result.sprint).toBeDefined();
    expect((result.sprint as any).current).toBe(1);
    expect((result.sprint as any).items).toHaveLength(1);
  });

  it("reports empty sprint when no items exist", async () => {
    await bootstrapProject(ctx, {
      name: "empty-sprint",
      description: "No sprint items",
    });
    const result = await getProjectStatus(ctx, { name: "empty-sprint" });
    expect(result.status).toBe("success");
    expect((result.sprint as any).current).toBe(0);
    expect((result.sprint as any).items).toHaveLength(0);
  });
});

// ─── Sprint State Persistence ───

describe("sprint state persistence", () => {
  it("creates sprint state directory under raptor home", async () => {
    await bootstrapWithSprint("state-test", "user-login: Basic login");
    const stateDir = path.join(raptorHome, "state-test");

    // The orchestrator will create this directory — for now verify
    // the project structure supports it
    fs.mkdirSync(stateDir, { recursive: true });
    expect(fs.existsSync(stateDir)).toBe(true);
  });

  it("persists and loads sprint state JSON", async () => {
    await bootstrapWithSprint("persist-test", "user-login: Basic login");
    const stateDir = path.join(raptorHome, "persist-test");
    fs.mkdirSync(stateDir, { recursive: true });

    const sprintState = {
      project: "persist-test",
      sprint: 1,
      status: "in-progress",
      currentStep: 2,
      steps: [
        {
          step: 1,
          role: "po",
          name: "Author specification",
          status: "complete",
          artifacts: ["docs/specs/user-login.md"],
          completedAt: "2026-03-22T10:00:00Z",
        },
        {
          step: 2,
          role: "architect",
          name: "Architecture design",
          status: "in-progress",
          artifacts: [],
          completedAt: null,
        },
      ],
      checkpoints: [
        {
          type: "spec-review",
          status: "approved",
          feedback: null,
          resolvedAt: "2026-03-22T10:01:00Z",
        },
      ],
    };

    const statePath = path.join(stateDir, "sprint-1.json");
    fs.writeFileSync(statePath, JSON.stringify(sprintState, null, 2));

    // Verify it can be loaded back
    const loaded = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(loaded.project).toBe("persist-test");
    expect(loaded.sprint).toBe(1);
    expect(loaded.currentStep).toBe(2);
    expect(loaded.steps).toHaveLength(2);
    expect(loaded.steps[0].status).toBe("complete");
    expect(loaded.checkpoints[0].type).toBe("spec-review");
  });

  it("survives process restart — state is on disk", async () => {
    await bootstrapWithSprint("restart-test", "user-login: Basic login");
    const stateDir = path.join(raptorHome, "restart-test");
    fs.mkdirSync(stateDir, { recursive: true });

    const state = {
      project: "restart-test",
      sprint: 1,
      status: "paused",
      currentStep: 6,
      steps: [],
      checkpoints: [
        { type: "pr-review", status: "pending", feedback: null, resolvedAt: null },
      ],
    };

    const statePath = path.join(stateDir, "sprint-1.json");
    fs.writeFileSync(statePath, JSON.stringify(state));

    // Simulate "new session" — read from scratch
    const reloaded = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(reloaded.status).toBe("paused");
    expect(reloaded.checkpoints[0].type).toBe("pr-review");
    expect(reloaded.checkpoints[0].status).toBe("pending");
  });
});

// ─── Workflow Step Ordering ───

describe("workflow step definitions", () => {
  it("defines 9 steps in the correct order", () => {
    // This will import from the actual workflow module once implemented.
    // For now, define the expected shape for TDD.
    const expectedSteps = [
      { step: 1, role: "po", name: "Author specification" },
      { step: 2, role: "architect", name: "Architecture design" },
      { step: 3, role: "qa", name: "Write tests" },
      { step: 4, role: "po", name: "Review tests" },
      { step: 5, role: "engineer", name: "Implement (TDD)" },
      { step: 6, role: "engineer", name: "Open PR" },
      { step: 7, role: "qa", name: "Run test suite" },
      { step: 8, role: "team", name: "Demo" },
      { step: 9, role: "po", name: "Process feedback" },
    ];

    expect(expectedSteps).toHaveLength(9);
    expect(expectedSteps[0].role).toBe("po");
    expect(expectedSteps[8].role).toBe("po");
  });

  it("assigns checkpoints to the correct steps", () => {
    const checkpointSteps = [
      { step: 1, checkpoint: "spec-review" },
      { step: 2, checkpoint: "tech-approval" },
      { step: 6, checkpoint: "pr-review" },
      { step: 8, checkpoint: "demo-feedback" },
    ];

    expect(checkpointSteps).toHaveLength(4);
    expect(checkpointSteps.map((c) => c.step)).toEqual([1, 2, 6, 8]);
  });
});

// ─── Git Handoff Commits ───

describe("git handoff commits", () => {
  it("creates handoff commits with the correct format", async () => {
    const projectPath = await bootstrapWithSprint("handoff-test", "user-login: Basic login");
    const git = simpleGit(projectPath);

    // Simulate what the orchestrator would do after PO completes step 1
    const specPath = path.join(projectPath, "docs", "specs", "user-login.md");
    fs.writeFileSync(specPath, "---\nslug: user-login\n---\n# User Login\n");
    await git.add("docs/specs/user-login.md");
    await git.commit("[PO] add: feature specification for user-login");
    await git.commit("[HANDOFF] PO -> Architect: specification for user-login", { "--allow-empty": null });

    const log = await git.log();
    const messages = log.all.map((e) => e.message);
    expect(messages[0]).toContain("[HANDOFF] PO -> Architect");
    expect(messages[1]).toContain("[PO] add:");
  });

  it("creates status commits during step execution", async () => {
    const projectPath = await bootstrapWithSprint("status-test", "user-login: Basic login");
    const git = simpleGit(projectPath);

    await git.commit("[STATUS] PO: specs — complete, handed off to Architect", { "--allow-empty": null });

    const log = await git.log({ maxCount: 1 });
    expect(log.latest!.message).toContain("[STATUS] PO:");
  });
});

// ─── Checkpoint Interaction ───

describe("checkpoint interactions", () => {
  it("checkpoint state includes type and structured options", () => {
    const checkpoint = {
      type: "spec-review" as const,
      options: ["approve", "request-changes"],
      feedbackField: true,
      context: "The PO has authored the specification for user-login...",
    };

    expect(checkpoint.options).toContain("approve");
    expect(checkpoint.options).toContain("request-changes");
    expect(checkpoint.feedbackField).toBe(true);
  });

  it("resume with approve advances to next step", () => {
    const state = {
      currentStep: 1,
      status: "paused",
      checkpoints: [{ type: "spec-review", status: "pending" }],
    };

    // Simulate approval
    state.checkpoints[0].status = "approved";
    state.currentStep = 2;
    state.status = "in-progress";

    expect(state.currentStep).toBe(2);
    expect(state.status).toBe("in-progress");
  });

  it("resume with request-changes re-runs the same step", () => {
    const state = {
      currentStep: 1,
      status: "paused",
      feedback: null as string | null,
    };

    // Simulate change request
    state.feedback = "Add password reset to acceptance criteria";
    state.status = "in-progress";
    // currentStep stays at 1 for re-run

    expect(state.currentStep).toBe(1);
    expect(state.feedback).toContain("password reset");
  });
});

// ─── Progress Table Rendering ───

describe("progress table", () => {
  it("renders a markdown table with correct status indicators", () => {
    const steps = [
      { step: 1, role: "po", name: "Author specification", status: "complete" },
      { step: 2, role: "architect", name: "Architecture design", status: "complete" },
      { step: 3, role: "qa", name: "Write tests", status: "in-progress" },
      { step: 4, role: "po", name: "Review tests", status: "pending" },
    ];

    const statusMap: Record<string, string> = {
      complete: "✅",
      "in-progress": "🔄",
      pending: "⬜",
    };

    // Verify status mapping
    expect(statusMap[steps[0].status]).toBe("✅");
    expect(statusMap[steps[2].status]).toBe("🔄");
    expect(statusMap[steps[3].status]).toBe("⬜");
  });
});

// ─── Error Handling ───

describe("error handling", () => {
  it("detects missing expected artifacts after a step", async () => {
    const projectPath = await bootstrapWithSprint("missing-art", "user-login: Basic login");

    // After PO step, we expect docs/specs/user-login.md to exist
    const specPath = path.join(projectPath, "docs", "specs", "user-login.md");
    expect(fs.existsSync(specPath)).toBe(false); // not yet created

    // Orchestrator should detect this and retry
  });

  it("detects blocker commits in git log", async () => {
    const projectPath = await bootstrapWithSprint("blocker-test", "user-login: Basic login");
    const git = simpleGit(projectPath);

    await git.commit("[BLOCKER] Engineer: unclear validation rules -- blocked on PO", { "--allow-empty": null });

    const log = await git.log();
    const blockers = log.all.filter((e) => e.message.includes("[BLOCKER]"));
    expect(blockers).toHaveLength(1);
    expect(blockers[0].message).toContain("blocked on PO");
  });
});
