/**
 * Integration tests for Raptor — MCP Project Bootstrap
 *
 * These tests validate Raptor's tools end-to-end against a real filesystem
 * and real git repos. No mocking — we use temporary directories that are
 * cleaned up after each test.
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
import { loadConfig } from "../../src/config";
import {
  bootstrapProject,
  listProjects,
  getProjectStatus,
  ToolContext,
} from "../../src/tools";
import { getTemplatePath, validateTemplate } from "../../src/template";

let tmpDir: string;
let raptorHome: string;
let projectsBaseDir: string;
let ctx: ToolContext;

// Use the bundled canonical template
const TEMPLATE_PATH = path.join(__dirname, "../../template/TEAM.md");

beforeEach(() => {
  // Create isolated temp directories for each test
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-test-"));
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
  // Clean up temp directories
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Registry Integration ───

describe("Registry", () => {
  it("creates projects.json if it does not exist", async () => {
    const registryPath = path.join(raptorHome, "projects.json");
    expect(fs.existsSync(registryPath)).toBe(false);

    const registry = new Registry(registryPath);
    await registry.addProject({ name: "test", slug: "test", description: "test", path: "/tmp/test", createdAt: new Date().toISOString() });
    expect(fs.existsSync(registryPath)).toBe(true);
  });

  it("persists project entries across reads", async () => {
    const registry = new Registry(path.join(raptorHome, "projects.json"));
    await registry.addProject({ name: "app-one", slug: "app-one", description: "First app", path: "/tmp/app-one", createdAt: new Date().toISOString() });
    await registry.addProject({ name: "app-two", slug: "app-two", description: "Second app", path: "/tmp/app-two", createdAt: new Date().toISOString() });

    const freshRegistry = new Registry(path.join(raptorHome, "projects.json"));
    const projects = await freshRegistry.listProjects();
    expect(projects).toHaveLength(2);
    expect(projects.map(p => p.name)).toContain("app-one");
    expect(projects.map(p => p.name)).toContain("app-two");
  });

  it("detects duplicate project names", async () => {
    const registry = new Registry(path.join(raptorHome, "projects.json"));
    await registry.addProject({ name: "my-app", slug: "my-app", description: "An app", path: "/tmp/my-app", createdAt: new Date().toISOString() });
    await expect(registry.addProject({ name: "my-app", slug: "my-app", description: "Duplicate", path: "/tmp/my-app-2", createdAt: new Date().toISOString() }))
      .rejects.toThrow(/already exists/);
  });
});

// ─── Config Integration ───

describe("Config", () => {
  it("loads config from file", async () => {
    const configPath = path.join(raptorHome, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ projectsBaseDir: "/custom/path" }));

    const config = loadConfig(configPath);
    expect(config.projectsBaseDir).toBe("/custom/path");
  });

  it("uses defaults when config file does not exist", async () => {
    const config = loadConfig(path.join(raptorHome, "config.json"));
    expect(config.projectsBaseDir).toContain("projects");
  });
});

// ─── bootstrap_project Integration ───

describe("bootstrap_project", () => {
  it("creates a valid git repo with full scaffold", async () => {
    const result = await bootstrapProject(ctx, { name: "my-app", description: "Test app" });
    expect(result.status).toBe("success");

    const projectPath = path.join(projectsBaseDir, "my-app");
    const git = simpleGit(projectPath);
    expect(await git.checkIsRepo()).toBe(true);

    // Verify scaffold directories exist
    const expectedDirs = [
      "docs/specs",
      "docs/architecture",
      "docs/adr",
      "docs/demos",
      "tests/bdd",
      "tests/integration",
      "tests/performance",
      "tests/e2e",
      "tests/e2e/screenshots",
      "src",
    ];

    for (const dir of expectedDirs) {
      expect(fs.existsSync(path.join(projectPath, dir))).toBe(true);
      expect(fs.existsSync(path.join(projectPath, dir, ".gitkeep"))).toBe(true);
    }
  });

  it("stamps TEAM.md matching the canonical template", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test app" });
    const stampedTeamMd = fs.readFileSync(path.join(projectsBaseDir, "my-app", "TEAM.md"), "utf-8");
    const canonicalTeamMd = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    expect(stampedTeamMd).toBe(canonicalTeamMd);
  });

  it("creates backlog.md with description and feature ideas", async () => {
    await bootstrapProject(ctx, {
      name: "my-app",
      description: "A recipe app",
      featureIdeas: ["user-login", "recipe-search", "meal-planner"]
    });

    const backlog = fs.readFileSync(path.join(projectsBaseDir, "my-app", "docs", "backlog.md"), "utf-8");
    expect(backlog).toContain("## Inbox (unprioritized)");
    expect(backlog).toContain("user-login");
    expect(backlog).toContain("recipe-search");
    expect(backlog).toContain("meal-planner");
  });

  it("creates exactly one git commit with correct message", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test app" });
    const git = simpleGit(path.join(projectsBaseDir, "my-app"));
    const log = await git.log();
    expect(log.total).toBe(1);
    expect(log.latest?.message).toBe("[BOOTSTRAP] Architect: project scaffold for my-app");
  });

  it("registers the project in the registry", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test app" });
    const registry = JSON.parse(fs.readFileSync(path.join(raptorHome, "projects.json"), "utf-8"));
    expect(registry.projects).toHaveLength(1);
    expect(registry.projects[0].name).toBe("my-app");
    expect(registry.projects[0].path).toBe(path.join(projectsBaseDir, "my-app"));
    expect(registry.projects[0].createdAt).toBeDefined();
  });

  it("creates base directory if it does not exist", async () => {
    const newBaseDir = path.join(tmpDir, "new", "nested", "projects");
    expect(fs.existsSync(newBaseDir)).toBe(false);

    const newCtx: ToolContext = { ...ctx, projectsBaseDir: newBaseDir };
    const result = await bootstrapProject(newCtx, { name: "my-app", description: "Test" });
    expect(result.status).toBe("success");
    expect(fs.existsSync(newBaseDir)).toBe(true);
  });

  it("rejects duplicate project names without modifying existing project", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "First" });
    const firstBacklog = fs.readFileSync(path.join(projectsBaseDir, "my-app", "docs", "backlog.md"), "utf-8");

    const result = await bootstrapProject(ctx, { name: "my-app", description: "Second" });
    expect(result.status).toBe("error");
    expect(result.message).toContain("already exists");

    const unchangedBacklog = fs.readFileSync(path.join(projectsBaseDir, "my-app", "docs", "backlog.md"), "utf-8");
    expect(unchangedBacklog).toBe(firstBacklog);
  });

  it("rejects invalid project names", async () => {
    const invalidNames = ["My App", "my_app!", "123-app", "MY-APP", "-leading-hyphen", ""];
    for (const name of invalidNames) {
      const result = await bootstrapProject(ctx, { name, description: "Test" });
      expect(result.status).toBe("error");
      expect(result.message).toContain("Invalid project name");
    }
  });

  it("filters out empty feature ideas", async () => {
    await bootstrapProject(ctx, {
      name: "my-app",
      description: "Test",
      featureIdeas: ["login", "", "  ", "search"]
    });

    const backlog = fs.readFileSync(path.join(projectsBaseDir, "my-app", "docs", "backlog.md"), "utf-8");
    expect(backlog).toContain("login");
    expect(backlog).toContain("search");
    expect(backlog).not.toMatch(/^\s*-\s*$/m);  // no empty list items
  });
});

// ─── list_projects Integration ───

describe("list_projects", () => {
  it("returns empty array when no projects exist", async () => {
    const result = await listProjects(ctx);
    expect(result.projects).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("returns all bootstrapped projects with full metadata", async () => {
    await bootstrapProject(ctx, { name: "app-one", description: "First" });
    await bootstrapProject(ctx, { name: "app-two", description: "Second" });

    const result = await listProjects(ctx);
    expect(result.count).toBe(2);
    const projects = result.projects as Array<Record<string, unknown>>;
    expect(projects[0]).toHaveProperty("name");
    expect(projects[0]).toHaveProperty("description");
    expect(projects[0]).toHaveProperty("path");
    expect(projects[0]).toHaveProperty("createdAt");
  });
});

// ─── get_project_status Integration ───

describe("get_project_status", () => {
  it("returns correct status for freshly bootstrapped project", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test", featureIdeas: ["feat-a", "feat-b"] });
    const result = await getProjectStatus(ctx, { name: "my-app" });

    expect(result.project).toBe("my-app");
    const backlog = result.backlog as { inbox: { count: number }; ready: { count: number }; sprint: { count: number }; done: { count: number } };
    expect(backlog.inbox.count).toBe(2);
    expect(backlog.ready.count).toBe(0);
    expect(backlog.sprint.count).toBe(0);
    expect(backlog.done.count).toBe(0);
    expect(result.blockers).toEqual([]);
    expect(result.escalations).toEqual([]);
  });

  it("parses blocker commits from git log", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });

    // Simulate a blocker commit in the project repo
    const git = simpleGit(path.join(projectsBaseDir, "my-app"));
    fs.writeFileSync(path.join(projectsBaseDir, "my-app", "tmp.txt"), "test");
    await git.add("tmp.txt");
    await git.commit("[BLOCKER] Engineer: unclear validation rules for email field -- blocked on PO");

    const result = await getProjectStatus(ctx, { name: "my-app" });
    const blockers = result.blockers as Array<{ role: string; description: string; blockedOn: string }>;
    expect(blockers).toHaveLength(1);
    expect(blockers[0].role).toBe("Engineer");
    expect(blockers[0].description).toContain("unclear validation rules");
    expect(blockers[0].blockedOn).toBe("PO");
  });

  it("parses escalation commits from git log", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });

    const git = simpleGit(path.join(projectsBaseDir, "my-app"));
    fs.writeFileSync(path.join(projectsBaseDir, "my-app", "tmp.txt"), "test");
    await git.add("tmp.txt");
    await git.commit("[ESCALATE] QA: test suite fails 3 times — requesting user intervention. Summary: flaky E2E");

    const result = await getProjectStatus(ctx, { name: "my-app" });
    const escalations = result.escalations as Array<unknown>;
    expect(escalations).toHaveLength(1);
  });

  it("parses current sprint number from backlog", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });

    // Update backlog to have a Sprint 2 section
    const backlogPath = path.join(projectsBaseDir, "my-app", "docs", "backlog.md");
    let backlog = fs.readFileSync(backlogPath, "utf-8");
    backlog = backlog.replace("## Sprint {N} — In Progress", "## Sprint 2 — In Progress");
    fs.writeFileSync(backlogPath, backlog);

    const result = await getProjectStatus(ctx, { name: "my-app" });
    const sprint = result.sprint as { current: number };
    expect(sprint.current).toBe(2);
  });

  it("reports sprint 0 for freshly bootstrapped project", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });
    const result = await getProjectStatus(ctx, { name: "my-app" });
    const sprint = result.sprint as { current: number };
    expect(sprint.current).toBe(0);
  });

  it("returns error for untracked project on disk", async () => {
    // Create a repo manually, not through Raptor
    const rogueRepoPath = path.join(projectsBaseDir, "rogue-app");
    fs.mkdirSync(rogueRepoPath, { recursive: true });
    const git = simpleGit(rogueRepoPath);
    await git.init();

    const result = await getProjectStatus(ctx, { name: "rogue-app" });
    expect(result.status).toBe("error");
    expect(result.message).toContain("not tracked by Raptor");
  });

  it("returns error for unknown project", async () => {
    const result = await getProjectStatus(ctx, { name: "ghost" });
    expect(result.status).toBe("error");
    expect(String(result.message)).toContain("not found");
    expect(String(result.message)).toContain("list_projects");
  });

  it("handles project in registry but missing from disk", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });
    fs.rmSync(path.join(projectsBaseDir, "my-app"), { recursive: true });

    const result = await getProjectStatus(ctx, { name: "my-app" });
    expect(result.status).toBe("error");
    expect(String(result.message)).toContain("missing");
  });

  it("handles malformed backlog.md gracefully", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });

    // Overwrite backlog with garbage
    fs.writeFileSync(path.join(projectsBaseDir, "my-app", "docs", "backlog.md"), "# Not a valid backlog\nrandom text here");

    const result = await getProjectStatus(ctx, { name: "my-app" });
    // Should return partial results, not crash
    expect(result.project).toBe("my-app");
    const backlog = result.backlog as { inbox: { count: number } };
    expect(backlog.inbox.count).toBe(0);
  });
});

// ─── Server Startup Integration ───

describe("Server Startup", () => {
  it("starts successfully with valid template", async () => {
    const startTime = Date.now();
    // Validate template loads without error — this is the startup validation
    validateTemplate(TEMPLATE_PATH);
    const config = loadConfig(path.join(raptorHome, "config.json"));
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(2000);
    expect(config).toBeDefined();
  });

  it("starts with defaults when no config file exists", async () => {
    const configPath = path.join(raptorHome, "config.json");
    expect(fs.existsSync(configPath)).toBe(false);
    const config = loadConfig(configPath);
    expect(config.projectsBaseDir).toContain("projects");
  });

  it("fails to start when TEAM.md template is missing", async () => {
    expect(() => validateTemplate("/nonexistent/TEAM.md"))
      .toThrow(/template/i);
  });
});
