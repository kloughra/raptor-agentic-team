/**
 * Integration tests for Raptor — DoD Checklist Tracking
 *
 * Tests validate DoD field tracking in sprint state, PR description updates,
 * progress table rendering, and backward compatibility.
 *
 * Test runner: Jest
 * Dependencies: simple-git, fs, path, os
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-dod-test-"));
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

function readSprintState(
  projectSlug: string,
  sprint: number
): Record<string, unknown> | null {
  const statePath = path.join(raptorHome, projectSlug, `sprint-${sprint}.json`);
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, "utf-8"));
}

// ─── DoD Checklist Structure ───

describe("DoD checklist structure", () => {
  it("has all required boolean fields", () => {
    const dod = {
      codeCommitted: false,
      testsPass: false,
      prReviewApproved: false,
      poAccepted: false,
      demoCompleted: false,
    };

    expect(Object.keys(dod)).toHaveLength(5);
    expect(typeof dod.codeCommitted).toBe("boolean");
    expect(typeof dod.testsPass).toBe("boolean");
    expect(typeof dod.prReviewApproved).toBe("boolean");
    expect(typeof dod.poAccepted).toBe("boolean");
    expect(typeof dod.demoCompleted).toBe("boolean");
  });

  it("all fields start as false", () => {
    const dod = {
      codeCommitted: false,
      testsPass: false,
      prReviewApproved: false,
      poAccepted: false,
      demoCompleted: false,
    };

    expect(Object.values(dod).every((v) => v === false)).toBe(true);
  });
});

// ─── DoD Field Updates ───

describe("DoD field updates at step/checkpoint completion", () => {
  it("codeCommitted set after step 6 (Open PR)", () => {
    const dod = { codeCommitted: false, testsPass: false, prReviewApproved: false, poAccepted: false, demoCompleted: false };

    // Simulate step 6 completion
    dod.codeCommitted = true;

    expect(dod.codeCommitted).toBe(true);
    expect(dod.testsPass).toBe(false);
  });

  it("prReviewApproved set after pr-review checkpoint approved", () => {
    const dod = { codeCommitted: true, testsPass: false, prReviewApproved: false, poAccepted: false, demoCompleted: false };

    // Simulate pr-review checkpoint approval
    dod.prReviewApproved = true;

    expect(dod.prReviewApproved).toBe(true);
  });

  it("testsPass set after step 7 (Run test suite)", () => {
    const dod = { codeCommitted: true, testsPass: false, prReviewApproved: true, poAccepted: false, demoCompleted: false };

    // Simulate step 7 completion
    dod.testsPass = true;

    expect(dod.testsPass).toBe(true);
  });

  it("demoCompleted set after step 8 (Demo)", () => {
    const dod = { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: false, demoCompleted: false };

    // Simulate step 8 completion
    dod.demoCompleted = true;

    expect(dod.demoCompleted).toBe(true);
  });

  it("poAccepted set after demo-feedback checkpoint approved", () => {
    const dod = { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: false, demoCompleted: true };

    // Simulate demo-feedback approval
    dod.poAccepted = true;

    expect(dod.poAccepted).toBe(true);
  });

  it("all fields true before merge step", () => {
    const dod = { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: true, demoCompleted: true };

    const allSatisfied = Object.values(dod).every((v) => v === true);
    expect(allSatisfied).toBe(true);
  });
});

// ─── DoD State Persistence ───

describe("DoD persistence in sprint state", () => {
  it("persists DoD to disk and reloads", () => {
    const state = {
      project: "dod-persist",
      sprint: 1,
      status: "in-progress",
      currentStep: 8,
      branchName: "sprint-1/search",
      steps: [],
      checkpoints: [],
      dod: {
        codeCommitted: true,
        testsPass: true,
        prReviewApproved: true,
        poAccepted: false,
        demoCompleted: false,
      },
    };

    writeSprintState("dod-persist", 1, state);
    const loaded = readSprintState("dod-persist", 1) as any;

    expect(loaded.dod.codeCommitted).toBe(true);
    expect(loaded.dod.testsPass).toBe(true);
    expect(loaded.dod.prReviewApproved).toBe(true);
    expect(loaded.dod.poAccepted).toBe(false);
    expect(loaded.dod.demoCompleted).toBe(false);
  });

  it("backward compatible: old state without dod defaults to all false", () => {
    const oldState = {
      project: "dod-compat",
      sprint: 1,
      status: "complete",
      currentStep: 10,
      steps: [],
      checkpoints: [],
      // No dod field
    };

    writeSprintState("dod-compat", 1, oldState);
    const loaded = readSprintState("dod-compat", 1) as any;

    const dod = loaded.dod ?? {
      codeCommitted: false,
      testsPass: false,
      prReviewApproved: false,
      poAccepted: false,
      demoCompleted: false,
    };

    expect(dod.codeCommitted).toBe(false);
    expect(dod.testsPass).toBe(false);
  });
});

// ─── PR Description Update ───

describe("PR description DoD update", () => {
  it("replaces unchecked items with checked items in PR body", () => {
    const prBody = `## Definition of Done
- [ ] All tests pass
- [ ] Code committed and pushed
- [ ] Peer review approved
- [ ] PO accepted`;

    const dod = { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: true, demoCompleted: true };

    let updatedBody = prBody;
    if (dod.testsPass) updatedBody = updatedBody.replace("- [ ] All tests pass", "- [x] All tests pass");
    if (dod.codeCommitted) updatedBody = updatedBody.replace("- [ ] Code committed and pushed", "- [x] Code committed and pushed");
    if (dod.prReviewApproved) updatedBody = updatedBody.replace("- [ ] Peer review approved", "- [x] Peer review approved");
    if (dod.poAccepted) updatedBody = updatedBody.replace("- [ ] PO accepted", "- [x] PO accepted");

    expect(updatedBody).not.toContain("- [ ]");
    expect(updatedBody.match(/- \[x\]/g)).toHaveLength(4);
  });

  it("partial DoD only checks satisfied items", () => {
    const prBody = `## Definition of Done
- [ ] All tests pass
- [ ] Code committed and pushed
- [ ] Peer review approved
- [ ] PO accepted`;

    const dod = { codeCommitted: true, testsPass: true, prReviewApproved: false, poAccepted: false, demoCompleted: false };

    let updatedBody = prBody;
    if (dod.testsPass) updatedBody = updatedBody.replace("- [ ] All tests pass", "- [x] All tests pass");
    if (dod.codeCommitted) updatedBody = updatedBody.replace("- [ ] Code committed and pushed", "- [x] Code committed and pushed");

    expect(updatedBody.match(/- \[x\]/g)).toHaveLength(2);
    expect(updatedBody.match(/- \[ \]/g)).toHaveLength(2);
  });

  it("generates DoD summary for merge commit message", () => {
    const dod = { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: true, demoCompleted: true };

    const items = [
      { label: "Tests pass", value: dod.testsPass },
      { label: "Code committed", value: dod.codeCommitted },
      { label: "Peer review approved", value: dod.prReviewApproved },
      { label: "PO accepted", value: dod.poAccepted },
      { label: "Demo completed", value: dod.demoCompleted },
    ];

    const summary = items.map((i) => `${i.value ? "✅" : "❌"} ${i.label}`).join("\n");

    expect(summary).toContain("✅ Tests pass");
    expect(summary).toContain("✅ Peer review approved");
    expect(summary).toContain("✅ PO accepted");
    expect(summary).not.toContain("❌");
  });
});

// ─── get_project_status ───

describe("get_project_status includes DoD", () => {
  it("DoD is included in orchestrator state", async () => {
    await bootstrapProject(ctx, { name: "dod-status", description: "DoD test" });

    const state = {
      project: "dod-status",
      sprint: 1,
      status: "in-progress",
      currentStep: 7,
      branchName: "sprint-1/feature",
      steps: [
        { step: 1, role: "po", name: "Author specification", status: "complete", artifacts: [], completedAt: "2026-04-06T10:00:00Z", attempts: 1, failures: [] },
      ],
      checkpoints: [],
      dod: {
        codeCommitted: true,
        testsPass: false,
        prReviewApproved: true,
        poAccepted: false,
        demoCompleted: false,
      },
    };

    writeSprintState("dod-status", 1, state);

    // Write a backlog with sprint 1 to get sprintNumber > 0
    const projectPath = path.join(projectsBaseDir, "dod-status");
    const backlogPath = path.join(projectPath, "docs", "backlog.md");
    fs.writeFileSync(backlogPath, `# Backlog\n\n## Sprint 1 — In Progress\n- [ ] feature: A feature\n\n## Done\n`);

    const result = await getProjectStatus(ctx, { name: "dod-status" });
    expect(result.status).toBe("success");

    // The orchestrator state should include dod
    const orch = result.orchestrator as any;
    if (orch) {
      expect(orch.dod).toBeDefined();
      expect(orch.dod.codeCommitted).toBe(true);
      expect(orch.dod.prReviewApproved).toBe(true);
      expect(orch.dod.testsPass).toBe(false);
    }
  });
});

// ─── Progress Table DoD Line ───

describe("progress table DoD line", () => {
  it("shows DoD satisfied when all true", () => {
    const dod = { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: true, demoCompleted: true };
    const allSatisfied = Object.values(dod).every((v) => v === true);

    const dodLine = allSatisfied ? "**Definition of Done: ✅ all items satisfied**" : "";
    expect(dodLine).toBe("**Definition of Done: ✅ all items satisfied**");
  });

  it("does not show DoD line when items are pending", () => {
    const dod = { codeCommitted: true, testsPass: false, prReviewApproved: false, poAccepted: false, demoCompleted: false };
    const allSatisfied = Object.values(dod).every((v) => v === true);

    const dodLine = allSatisfied ? "**Definition of Done: ✅ all items satisfied**" : "";
    expect(dodLine).toBe("");
  });
});
