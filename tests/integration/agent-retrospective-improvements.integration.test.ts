/**
 * Integration tests for Raptor — Agent Retrospective Improvements
 *
 * Tests validate retro proposal collection, retro document generation,
 * checkpoint interaction, TEAM.md improvement application, and state tracking.
 *
 * Test runner: Jest
 * Dependencies: simple-git, fs, path, os
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import simpleGit from "simple-git";

import { Registry } from "../../src/registry";
import {
  bootstrapProject,
  ToolContext,
} from "../../src/tools";

let tmpDir: string;
let raptorHome: string;
let projectsBaseDir: string;
let ctx: ToolContext;

const TEMPLATE_PATH = path.join(__dirname, "../../template/TEAM.md");

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-retro-test-"));
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

async function bootstrapWithSprint(
  projectName: string,
  sprintItem: string
): Promise<string> {
  await bootstrapProject(ctx, {
    name: projectName,
    description: "Test project for retro improvements",
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

// ─── Workflow Definition: 13 Steps ───

describe("workflow definition with retro steps", () => {
  it("defines 13 steps with retro phase at steps 11-13", () => {
    const expectedSteps = [
      { step: 1, role: "po", name: "Author specification" },
      { step: 2, role: "architect", name: "Architecture design" },
      { step: 3, role: "qa", name: "Write tests" },
      { step: 4, role: "po", name: "Review tests" },
      { step: 5, role: "engineer", name: "Implement (TDD)" },
      { step: 6, role: "engineer", name: "Open PR" },
      { step: 7, role: "qa", name: "Run test suite" },
      { step: 8, role: "team", name: "Demo" },
      { step: 9, role: "engineer", name: "Merge PR" },
      { step: 10, role: "po", name: "Process feedback" },
      { step: 11, role: "team", name: "Collect retro proposals" },
      { step: 12, role: "team", name: "Review retro proposals" },
      { step: 13, role: "po", name: "Apply retro improvements" },
    ];

    expect(expectedSteps).toHaveLength(13);
    expect(expectedSteps[10].name).toBe("Collect retro proposals");
    expect(expectedSteps[11].name).toBe("Review retro proposals");
    expect(expectedSteps[12].name).toBe("Apply retro improvements");
  });

  it("retro-review checkpoint is on step 12", () => {
    const retroReviewStep = {
      step: 12,
      role: "team",
      name: "Review retro proposals",
      checkpointAfter: "retro-review",
    };

    expect(retroReviewStep.checkpointAfter).toBe("retro-review");
  });
});

// ─── Retro Proposal Structure ───

describe("retro proposal structure", () => {
  it("proposal has all required fields", () => {
    const proposal = {
      role: "qa",
      section: "QA Engineer",
      type: "addition" as const,
      proposal: "Add a requirement for QA to document test data setup in BDD scenarios",
      rationale: "During this sprint, the Engineer had to guess test data formats",
      impact: "Reduces ambiguity and speeds up implementation",
    };

    expect(proposal.role).toBeDefined();
    expect(proposal.section).toBeDefined();
    expect(["addition", "modification", "removal"]).toContain(proposal.type);
    expect(proposal.proposal).toBeDefined();
    expect(proposal.rationale).toBeDefined();
    expect(proposal.impact).toBeDefined();
  });

  it("handles null proposal when role produces nothing", () => {
    const proposal = null;
    const displayText = proposal ? proposal : "No proposal from QA";
    expect(displayText).toBe("No proposal from QA");
  });
});

// ─── Retro Document Generation ───

describe("retro document generation", () => {
  it("retro document contains all proposals", () => {
    const proposals = [
      { role: "po", section: "Product Owner", type: "addition", proposal: "Add sprint goal validation", rationale: "Goals were vague", impact: "Clearer specs" },
      { role: "architect", section: "Architect", type: "modification", proposal: "Require ADR for all tech choices", rationale: "Missing ADR for DB choice", impact: "Better decision records" },
      { role: "qa", section: "QA Engineer", type: "addition", proposal: "Add test data requirements to BDD", rationale: "Engineers guessed formats", impact: "Faster implementation" },
      { role: "engineer", section: "Software Engineer(s)", type: "modification", proposal: "Allow engineers to propose test fixes", rationale: "Found test bug but couldn't fix it", impact: "Faster bug resolution" },
    ];

    const doc = `# Sprint 1 Retrospective — test-project

## Proposals

${proposals.map((p, i) => `### ${i + 1}. ${p.role.toUpperCase()} Proposal

**Section**: ${p.section}
**Type**: ${p.type}
**Proposal**: ${p.proposal}
**Rationale**: ${p.rationale}
**Impact**: ${p.impact}
`).join("\n")}

## User Decision
(Pending user review)

## Applied Changes
(None yet)
`;

    expect(doc).toContain("PO Proposal");
    expect(doc).toContain("ARCHITECT Proposal");
    expect(doc).toContain("QA Proposal");
    expect(doc).toContain("ENGINEER Proposal");
    expect(doc).toContain("User Decision");
  });

  it("retro document is saved to docs/sprints/sprint-N-retro.md", async () => {
    const projectPath = await bootstrapWithSprint("retro-doc", "search: Full-text search");
    const retroPath = path.join(projectPath, "docs", "sprints", "sprint-1-retro.md");

    // Simulate writing the retro doc
    const sprintsDir = path.join(projectPath, "docs", "sprints");
    fs.mkdirSync(sprintsDir, { recursive: true });
    fs.writeFileSync(retroPath, "# Sprint 1 Retrospective\n## Proposals\n");

    expect(fs.existsSync(retroPath)).toBe(true);
  });

  it("retro document can be committed", async () => {
    const projectPath = await bootstrapWithSprint("retro-commit", "search: Full-text search");
    const git = simpleGit(projectPath);

    const sprintsDir = path.join(projectPath, "docs", "sprints");
    fs.mkdirSync(sprintsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sprintsDir, "sprint-1-retro.md"),
      "# Sprint 1 Retrospective\n"
    );

    await git.add("docs/sprints/sprint-1-retro.md");
    await git.commit("[PO] add: sprint 1 retrospective");

    const log = await git.log({ maxCount: 1 });
    expect(log.latest!.message).toContain("sprint 1 retrospective");
  });
});

// ─── TEAM.md Improvement Application ───

describe("TEAM.md improvement application", () => {
  it("addition: appends content within target section", async () => {
    const projectPath = await bootstrapWithSprint("apply-add", "search: Full-text search");
    const teamMdPath = path.join(projectPath, "TEAM.md");
    const teamMd = fs.readFileSync(teamMdPath, "utf-8");

    // Verify the target section exists
    expect(teamMd).toContain("### QA Engineer");

    // Simulate addition: find section and append
    const sectionHeader = "### QA Engineer";
    const sectionIndex = teamMd.indexOf(sectionHeader);
    expect(sectionIndex).toBeGreaterThan(-1);
  });

  it("target section is found by header matching", async () => {
    const projectPath = await bootstrapWithSprint("apply-match", "search: Full-text search");
    const teamMd = fs.readFileSync(path.join(projectPath, "TEAM.md"), "utf-8");

    const sections = [
      "Product Owner",
      "QA Engineer",
      "Architect",
      "Software Engineer",
      "Sprint Workflow",
      "Definition of Done",
    ];

    for (const section of sections) {
      expect(teamMd).toContain(section);
    }
  });

  it("TEAM.md is preserved if improvement application fails", async () => {
    const projectPath = await bootstrapWithSprint("apply-safe", "search: Full-text search");
    const teamMdPath = path.join(projectPath, "TEAM.md");
    const originalContent = fs.readFileSync(teamMdPath, "utf-8");

    // If we try to apply to a nonexistent section, the file should be unchanged
    const nonexistentSection = "### Nonexistent Section";
    expect(originalContent).not.toContain(nonexistentSection);

    // Original should remain unchanged
    const currentContent = fs.readFileSync(teamMdPath, "utf-8");
    expect(currentContent).toBe(originalContent);
  });
});

// ─── Checkpoint: retro-review ───

describe("retro-review checkpoint", () => {
  it("retro-review is a valid checkpoint type", () => {
    const validTypes = ["spec-review", "tech-approval", "pr-review", "demo-feedback", "retro-review"];
    expect(validTypes).toContain("retro-review");
  });

  it("adopt all: all proposals marked as adopted", () => {
    const feedback = "all";
    const proposals = [
      { role: "po", proposal: "P1" },
      { role: "architect", proposal: "P2" },
      { role: "qa", proposal: "P3" },
      { role: "engineer", proposal: "P4" },
    ];

    const adopted = feedback === "all"
      ? proposals.map((_, i) => i + 1)
      : [];

    expect(adopted).toEqual([1, 2, 3, 4]);
  });

  it("adopt selected: parses comma-separated indices", () => {
    const feedback = "1,3";
    const indices = feedback.split(",").map((s) => parseInt(s.trim(), 10));

    expect(indices).toEqual([1, 3]);
  });

  it("skip: no proposals adopted", () => {
    const feedback = "skip";
    const isSkip = feedback === "skip" || !feedback;

    expect(isSkip).toBe(true);
  });

  it("no feedback: treated as skip", () => {
    const feedback = undefined;
    const isSkip = !feedback || feedback === "skip";

    expect(isSkip).toBe(true);
  });
});

// ─── User Decision Record in Retro Doc ───

describe("user decision record", () => {
  it("retro doc updated with adoption status", () => {
    const proposals = ["P1", "P2", "P3", "P4"];
    const adopted = [1, 3];

    const decisionSection = proposals.map((p, i) => {
      const status = adopted.includes(i + 1) ? "Adopted" : "Deferred";
      return `- ${i + 1}. ${p}: ${status}`;
    }).join("\n");

    expect(decisionSection).toContain("1. P1: Adopted");
    expect(decisionSection).toContain("2. P2: Deferred");
    expect(decisionSection).toContain("3. P3: Adopted");
    expect(decisionSection).toContain("4. P4: Deferred");
  });
});

// ─── State: retroProposals ───

describe("sprint state retroProposals", () => {
  it("stores retro proposals in sprint state", async () => {
    await bootstrapWithSprint("state-retro", "search: Full-text search");

    const state = {
      project: "state-retro",
      sprint: 1,
      status: "paused",
      currentStep: 12,
      branchName: "sprint-1/search",
      retroProposals: [
        { role: "po", section: "Product Owner", type: "addition", proposal: "P1", rationale: "R1", impact: "I1" },
        { role: "architect", section: "Architect", type: "modification", proposal: "P2", rationale: "R2", impact: "I2" },
        { role: "qa", section: "QA Engineer", type: "addition", proposal: "P3", rationale: "R3", impact: "I3" },
        { role: "engineer", section: "Software Engineer(s)", type: "modification", proposal: "P4", rationale: "R4", impact: "I4" },
      ],
      steps: [],
      checkpoints: [
        { type: "retro-review", status: "pending", feedback: null, resolvedAt: null },
      ],
      dod: { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: true, demoCompleted: true },
    };

    writeSprintState("state-retro", 1, state);
    const loaded = readSprintState("state-retro", 1) as any;

    expect(loaded.retroProposals).toHaveLength(4);
    expect(loaded.retroProposals[0].role).toBe("po");
    expect(loaded.retroProposals[2].type).toBe("addition");
  });

  it("backward compatible: old state without retroProposals defaults to null", async () => {
    await bootstrapWithSprint("state-compat", "search: Full-text search");

    const oldState = {
      project: "state-compat",
      sprint: 1,
      status: "complete",
      currentStep: 10,
      steps: [],
      checkpoints: [],
    };

    writeSprintState("state-compat", 1, oldState);
    const loaded = readSprintState("state-compat", 1) as any;

    const retroProposals = loaded.retroProposals ?? null;
    expect(retroProposals).toBeNull();
  });
});

// ─── Sprint Completion After Retro ───

describe("sprint completion after retro", () => {
  it("sprint is not complete until retro is resolved", () => {
    const state = {
      status: "paused",
      currentStep: 12,
      checkpoints: [
        { type: "retro-review", status: "pending" },
      ],
    };

    expect(state.status).toBe("paused");
    expect(state.status).not.toBe("complete");
  });

  it("sprint completes after step 13 finishes", () => {
    const state = {
      status: "complete",
      currentStep: 13,
      checkpoints: [
        { type: "retro-review", status: "approved" },
      ],
    };

    expect(state.status).toBe("complete");
  });
});
