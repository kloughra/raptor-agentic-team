import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import simpleGit from "simple-git";
import { Registry } from "./registry";
import { bootstrapProject, listProjects, getProjectStatus, ToolContext } from "./tools";

let tmpDir: string;
let raptorHome: string;
let projectsBaseDir: string;
let ctx: ToolContext;

// Create a simple TEAM.md template for tests
const TEAM_MD_CONTENT = "# Agentic Dev Team\n\nThis is the canonical template.\n";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-tools-test-"));
  raptorHome = path.join(tmpDir, ".raptor");
  projectsBaseDir = path.join(tmpDir, "projects");
  fs.mkdirSync(raptorHome, { recursive: true });

  // Write a test template
  const templatePath = path.join(tmpDir, "TEAM.md");
  fs.writeFileSync(templatePath, TEAM_MD_CONTENT);

  ctx = {
    projectsBaseDir,
    registry: new Registry(path.join(raptorHome, "projects.json")),
    templatePath,
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("bootstrapProject", () => {
  it("creates a valid git repo with full scaffold", async () => {
    const result = await bootstrapProject(ctx, {
      name: "my-app",
      description: "Test app",
    });
    expect(result.status).toBe("success");

    const projectPath = path.join(projectsBaseDir, "my-app");
    const git = simpleGit(projectPath);
    expect(await git.checkIsRepo()).toBe(true);

    // Verify TEAM.md
    const teamMd = fs.readFileSync(path.join(projectPath, "TEAM.md"), "utf-8");
    expect(teamMd).toBe(TEAM_MD_CONTENT);

    // Verify scaffold directories
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

  it("creates exactly one commit with correct message", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });
    const git = simpleGit(path.join(projectsBaseDir, "my-app"));
    const log = await git.log();
    expect(log.total).toBe(1);
    expect(log.latest?.message).toBe(
      "[BOOTSTRAP] Architect: project scaffold for my-app"
    );
  });

  it("registers the project", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });
    const projects = await ctx.registry.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("my-app");
  });

  it("creates backlog with feature ideas", async () => {
    await bootstrapProject(ctx, {
      name: "my-app",
      description: "A recipe app",
      featureIdeas: ["user-login", "recipe-search", "meal-planner"],
    });
    const backlog = fs.readFileSync(
      path.join(projectsBaseDir, "my-app", "docs", "backlog.md"),
      "utf-8"
    );
    expect(backlog).toContain("## Inbox (unprioritized)");
    expect(backlog).toContain("user-login");
    expect(backlog).toContain("recipe-search");
    expect(backlog).toContain("meal-planner");
  });

  it("filters empty feature ideas", async () => {
    await bootstrapProject(ctx, {
      name: "my-app",
      description: "Test",
      featureIdeas: ["login", "", "  ", "search"],
    });
    const backlog = fs.readFileSync(
      path.join(projectsBaseDir, "my-app", "docs", "backlog.md"),
      "utf-8"
    );
    expect(backlog).toContain("login");
    expect(backlog).toContain("search");
    expect(backlog).not.toMatch(/^\s*-\s*:\s/m);
  });

  it("rejects duplicate project names", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "First" });
    const result = await bootstrapProject(ctx, {
      name: "my-app",
      description: "Second",
    });
    expect(result.status).toBe("error");
    expect(result.message).toContain("already exists");
  });

  it("rejects invalid project names", async () => {
    const invalidNames = ["My App", "my_app!", "123-app", "MY-APP", "-leading", ""];
    for (const name of invalidNames) {
      const result = await bootstrapProject(ctx, {
        name,
        description: "Test",
      });
      expect(result.status).toBe("error");
      expect(String(result.message)).toContain("Invalid project name");
    }
  });

  it("creates base directory if it does not exist", async () => {
    const newBaseDir = path.join(tmpDir, "new", "nested", "projects");
    const newCtx = { ...ctx, projectsBaseDir: newBaseDir };
    expect(fs.existsSync(newBaseDir)).toBe(false);

    const result = await bootstrapProject(newCtx, {
      name: "my-app",
      description: "Test",
    });
    expect(result.status).toBe("success");
    expect(fs.existsSync(newBaseDir)).toBe(true);
  });

  it("response includes path and next steps", async () => {
    const result = await bootstrapProject(ctx, {
      name: "my-app",
      description: "An app",
    });
    expect(String(result.message)).toContain(
      path.join(projectsBaseDir, "my-app")
    );
    expect(String(result.message)).toContain("Next step");
  });
});

describe("listProjects", () => {
  it("returns empty array when no projects exist", async () => {
    const result = await listProjects(ctx);
    expect(result.projects).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("returns all bootstrapped projects", async () => {
    await bootstrapProject(ctx, { name: "app-one", description: "First" });
    await bootstrapProject(ctx, { name: "app-two", description: "Second" });
    const result = await listProjects(ctx);
    expect(result.count).toBe(2);
    const projects = result.projects as Array<{ name: string }>;
    expect(projects.map((p) => p.name)).toContain("app-one");
    expect(projects.map((p) => p.name)).toContain("app-two");
  });
});

describe("getProjectStatus", () => {
  it("returns correct status for freshly bootstrapped project", async () => {
    await bootstrapProject(ctx, {
      name: "my-app",
      description: "Test",
      featureIdeas: ["feat-a", "feat-b"],
    });
    const result = await getProjectStatus(ctx, { name: "my-app" });
    expect(result.project).toBe("my-app");
    const backlog = result.backlog as { inbox: { count: number } };
    expect(backlog.inbox.count).toBe(2);
    expect(result.blockers).toEqual([]);
    expect(result.escalations).toEqual([]);
  });

  it("reports sprint 0 for freshly bootstrapped project", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });
    const result = await getProjectStatus(ctx, { name: "my-app" });
    const sprint = result.sprint as { current: number };
    expect(sprint.current).toBe(0);
  });

  it("parses blocker commits from git log", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });
    const projectPath = path.join(projectsBaseDir, "my-app");
    const git = simpleGit(projectPath);
    fs.writeFileSync(path.join(projectPath, "tmp.txt"), "test");
    await git.add("tmp.txt");
    await git.commit(
      "[BLOCKER] Engineer: unclear validation rules for email field -- blocked on PO"
    );

    const result = await getProjectStatus(ctx, { name: "my-app" });
    const blockers = result.blockers as Array<{
      role: string;
      description: string;
      blockedOn: string;
    }>;
    expect(blockers).toHaveLength(1);
    expect(blockers[0].role).toBe("Engineer");
    expect(blockers[0].description).toContain("unclear validation rules");
    expect(blockers[0].blockedOn).toBe("PO");
  });

  it("parses escalation commits from git log", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });
    const projectPath = path.join(projectsBaseDir, "my-app");
    const git = simpleGit(projectPath);
    fs.writeFileSync(path.join(projectPath, "tmp.txt"), "test");
    await git.add("tmp.txt");
    await git.commit(
      "[ESCALATE] QA: test suite fails 3 times — requesting user intervention. Summary: flaky E2E"
    );

    const result = await getProjectStatus(ctx, { name: "my-app" });
    const escalations = result.escalations as Array<unknown>;
    expect(escalations).toHaveLength(1);
  });

  it("parses sprint number from updated backlog", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });
    const backlogPath = path.join(
      projectsBaseDir,
      "my-app",
      "docs",
      "backlog.md"
    );
    let backlog = fs.readFileSync(backlogPath, "utf-8");
    backlog = "## Sprint 2 — In Progress\n\n" + backlog;
    fs.writeFileSync(backlogPath, backlog);

    const result = await getProjectStatus(ctx, { name: "my-app" });
    const sprint = result.sprint as { current: number };
    expect(sprint.current).toBe(2);
  });

  it("returns error for unknown project", async () => {
    const result = await getProjectStatus(ctx, { name: "ghost" });
    expect(result.status).toBe("error");
    expect(String(result.message)).toContain("not found");
    expect(String(result.message)).toContain("list_projects");
  });

  it("returns error for untracked project on disk", async () => {
    // Create a repo manually, not through Raptor
    const rogueRepoPath = path.join(projectsBaseDir, "rogue-app");
    fs.mkdirSync(rogueRepoPath, { recursive: true });
    const git = simpleGit(rogueRepoPath);
    await git.init();

    const result = await getProjectStatus(ctx, { name: "rogue-app" });
    expect(result.status).toBe("error");
    expect(String(result.message)).toContain("not tracked by Raptor");
  });

  it("returns error when project is in registry but missing from disk", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });
    fs.rmSync(path.join(projectsBaseDir, "my-app"), { recursive: true });

    const result = await getProjectStatus(ctx, { name: "my-app" });
    expect(result.status).toBe("error");
    expect(String(result.message)).toContain("missing");
  });

  it("handles malformed backlog gracefully", async () => {
    await bootstrapProject(ctx, { name: "my-app", description: "Test" });
    fs.writeFileSync(
      path.join(projectsBaseDir, "my-app", "docs", "backlog.md"),
      "# Not a valid backlog\nrandom text here"
    );

    const result = await getProjectStatus(ctx, { name: "my-app" });
    expect(result.project).toBe("my-app");
    const backlog = result.backlog as { inbox: { count: number } };
    expect(backlog.inbox.count).toBe(0);
  });
});
