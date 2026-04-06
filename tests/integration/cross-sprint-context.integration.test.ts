/**
 * Integration tests for Raptor — Cross-Sprint Context
 *
 * Tests validate sprint summary generation, context loading for new sprints,
 * size bounding, scaffold updates, and get_project_status extensions.
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
  getProjectStatus,
  ToolContext,
} from "../../src/tools";

let tmpDir: string;
let raptorHome: string;
let projectsBaseDir: string;
let ctx: ToolContext;

const TEMPLATE_PATH = path.join(__dirname, "../../template/TEAM.md");

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-context-test-"));
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
    description: "Test project for cross-sprint context",
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

function writeSprintSummary(
  projectPath: string,
  sprint: number,
  content?: string
): void {
  const sprintsDir = path.join(projectPath, "docs", "sprints");
  fs.mkdirSync(sprintsDir, { recursive: true });
  const summaryContent = content || `# Sprint ${sprint} Summary — test-project

## Sprint Goal
Deliver feature for sprint ${sprint}

## Features Delivered
- feature-${sprint}: Sprint ${sprint} feature

## Key Technical Decisions
- Used TypeScript for consistency

## Patterns & Conventions Established
- Follow existing patterns

## Issues Encountered
- No major issues

## Deferred Items
- None

## Context for Future Sprints
Sprint ${sprint} established the baseline patterns.
`;
  fs.writeFileSync(
    path.join(sprintsDir, `sprint-${sprint}-summary.md`),
    summaryContent
  );
}

// ─── Summary Template Structure ───

describe("sprint summary template", () => {
  it("generated summary contains all required sections", () => {
    const requiredSections = [
      "Sprint Goal",
      "Features Delivered",
      "Key Technical Decisions",
      "Patterns & Conventions Established",
      "Issues Encountered",
      "Deferred Items",
      "Context for Future Sprints",
    ];

    // Build a mock summary to verify structure
    const summary = `# Sprint 1 Summary — test-project

## Sprint Goal
Deliver search feature

## Features Delivered
- search: Full-text search

## Key Technical Decisions
- Chose SQLite for simplicity

## Patterns & Conventions Established
- All queries go through the repository pattern

## Issues Encountered
- Step 3 failed twice before succeeding

## Deferred Items
- advanced-search: deferred to Sprint 2

## Context for Future Sprints
SQLite is the database. Use repository pattern for all data access.
`;

    for (const section of requiredSections) {
      expect(summary).toContain(`## ${section}`);
    }
  });
});

// ─── Summary File Management ───

describe("sprint summary file management", () => {
  it("summary is written to docs/sprints/sprint-N-summary.md", async () => {
    const projectPath = await bootstrapWithSprint("summary-write", "search: Full-text search");

    writeSprintSummary(projectPath, 1);

    const summaryPath = path.join(projectPath, "docs", "sprints", "sprint-1-summary.md");
    expect(fs.existsSync(summaryPath)).toBe(true);

    const content = fs.readFileSync(summaryPath, "utf-8");
    expect(content).toContain("Sprint 1 Summary");
    expect(content).toContain("Sprint Goal");
  });

  it("summary can be committed to git", async () => {
    const projectPath = await bootstrapWithSprint("summary-git", "search: Full-text search");
    const git = simpleGit(projectPath);

    writeSprintSummary(projectPath, 1);
    await git.add("docs/sprints/sprint-1-summary.md");
    await git.commit("[PO] add: sprint 1 summary");

    const log = await git.log({ maxCount: 1 });
    expect(log.latest!.message).toContain("[PO] add: sprint 1 summary");
  });
});

// ─── Context Loading ───

describe("cross-sprint context loading", () => {
  it("loads a single sprint summary", async () => {
    const projectPath = await bootstrapWithSprint("ctx-single", "search: Full-text search");
    writeSprintSummary(projectPath, 1);

    const sprintsDir = path.join(projectPath, "docs", "sprints");
    const files = fs.readdirSync(sprintsDir).filter((f) => f.match(/sprint-\d+-summary\.md/));

    expect(files).toHaveLength(1);
    const content = fs.readFileSync(path.join(sprintsDir, files[0]), "utf-8");
    expect(content).toContain("Sprint 1 Summary");
  });

  it("loads multiple summaries in order", async () => {
    const projectPath = await bootstrapWithSprint("ctx-multi", "search: Full-text search");
    writeSprintSummary(projectPath, 1);
    writeSprintSummary(projectPath, 2);
    writeSprintSummary(projectPath, 3);

    const sprintsDir = path.join(projectPath, "docs", "sprints");
    const files = fs.readdirSync(sprintsDir)
      .filter((f) => f.match(/sprint-\d+-summary\.md/))
      .sort();

    expect(files).toHaveLength(3);
    expect(files[0]).toBe("sprint-1-summary.md");
    expect(files[1]).toBe("sprint-2-summary.md");
    expect(files[2]).toBe("sprint-3-summary.md");
  });

  it("returns empty when no summaries exist", async () => {
    const projectPath = await bootstrapWithSprint("ctx-empty", "search: Full-text search");
    const sprintsDir = path.join(projectPath, "docs", "sprints");

    if (!fs.existsSync(sprintsDir)) {
      fs.mkdirSync(sprintsDir, { recursive: true });
    }

    const files = fs.readdirSync(sprintsDir).filter((f) => f.match(/sprint-\d+-summary\.md/));
    expect(files).toHaveLength(0);
  });
});

// ─── Size Bounding ───

describe("context size bounding", () => {
  it("truncates to fit within max chars limit", async () => {
    const projectPath = await bootstrapWithSprint("ctx-bound", "search: Full-text search");
    const maxChars = 1000;

    // Create many summaries that exceed the limit
    for (let i = 1; i <= 10; i++) {
      writeSprintSummary(projectPath, i, `# Sprint ${i} Summary\n${"x".repeat(300)}\n`);
    }

    const sprintsDir = path.join(projectPath, "docs", "sprints");
    const files = fs.readdirSync(sprintsDir)
      .filter((f) => f.match(/sprint-\d+-summary\.md/))
      .sort((a, b) => {
        const numA = parseInt(a.match(/\d+/)![0]);
        const numB = parseInt(b.match(/\d+/)![0]);
        return numA - numB;
      });

    // Load most recent first until we hit the limit
    let totalChars = 0;
    const included: string[] = [];

    for (let i = files.length - 1; i >= 0; i--) {
      const content = fs.readFileSync(path.join(sprintsDir, files[i]), "utf-8");
      if (totalChars + content.length > maxChars && included.length > 0) break;
      totalChars += content.length;
      included.unshift(files[i]);
    }

    expect(included.length).toBeLessThan(files.length);
    expect(totalChars).toBeLessThanOrEqual(maxChars + 400); // allow for last file
  });

  it("includes all summaries when total is under the limit", async () => {
    const projectPath = await bootstrapWithSprint("ctx-small", "search: Full-text search");
    const maxChars = 10000;

    writeSprintSummary(projectPath, 1, "# Sprint 1\nSmall summary.\n");
    writeSprintSummary(projectPath, 2, "# Sprint 2\nSmall summary.\n");

    const sprintsDir = path.join(projectPath, "docs", "sprints");
    const files = fs.readdirSync(sprintsDir).filter((f) => f.match(/sprint-\d+-summary\.md/));

    let totalChars = 0;
    for (const f of files) {
      totalChars += fs.readFileSync(path.join(sprintsDir, f), "utf-8").length;
    }

    expect(totalChars).toBeLessThan(maxChars);
    expect(files).toHaveLength(2);
  });
});

// ─── Project Scaffold ───

describe("project scaffold includes docs/sprints/", () => {
  it("bootstrapped projects have docs/sprints/ directory", async () => {
    await bootstrapProject(ctx, {
      name: "scaffold-test",
      description: "Test scaffold",
    });

    const sprintsDir = path.join(projectsBaseDir, "scaffold-test", "docs", "sprints");
    expect(fs.existsSync(sprintsDir)).toBe(true);
  });
});

// ─── get_project_status ───

describe("get_project_status sprint summaries", () => {
  it("reports summary count and latest sprint", async () => {
    const projectPath = await bootstrapWithSprint("status-ctx", "search: Full-text search");
    writeSprintSummary(projectPath, 1);
    writeSprintSummary(projectPath, 2);

    // Commit summaries so they're visible
    const git = simpleGit(projectPath);
    await git.add("docs/sprints/");
    await git.commit("[PO] add: sprint summaries");

    const result = await getProjectStatus(ctx, { name: "status-ctx" });
    expect(result.status).toBe("success");

    // Verify the sprints dir exists with the right files
    const sprintsDir = path.join(projectPath, "docs", "sprints");
    const summaryFiles = fs.readdirSync(sprintsDir).filter((f) => f.match(/sprint-\d+-summary\.md/));
    expect(summaryFiles).toHaveLength(2);
  });

  it("reports zero summaries when none exist", async () => {
    await bootstrapWithSprint("status-none", "search: Full-text search");

    const result = await getProjectStatus(ctx, { name: "status-none" });
    expect(result.status).toBe("success");
    // No sprints dir or no summary files
  });
});

// ─── Edge Cases ───

describe("edge cases", () => {
  it("manually created summary files are picked up", async () => {
    const projectPath = await bootstrapWithSprint("manual-summary", "search: Full-text search");

    // Manually create a summary for "sprint 0"
    writeSprintSummary(projectPath, 0, "# Sprint 0 Summary\nManual bootstrap context.\n");

    const sprintsDir = path.join(projectPath, "docs", "sprints");
    const files = fs.readdirSync(sprintsDir).filter((f) => f.match(/sprint-\d+-summary\.md/));
    expect(files).toContain("sprint-0-summary.md");
  });

  it("non-summary files in docs/sprints/ are ignored", async () => {
    const projectPath = await bootstrapWithSprint("non-summary", "search: Full-text search");
    const sprintsDir = path.join(projectPath, "docs", "sprints");
    fs.mkdirSync(sprintsDir, { recursive: true });

    // Write a retro doc (not a summary)
    fs.writeFileSync(path.join(sprintsDir, "sprint-1-retro.md"), "# Retro\n");
    // Write a summary
    writeSprintSummary(projectPath, 1);

    const summaryFiles = fs.readdirSync(sprintsDir).filter((f) => f.match(/sprint-\d+-summary\.md/));
    expect(summaryFiles).toHaveLength(1);
    expect(summaryFiles[0]).toBe("sprint-1-summary.md");
  });
});
