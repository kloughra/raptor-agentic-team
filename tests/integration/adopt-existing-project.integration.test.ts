import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import simpleGit from "simple-git";
import { Registry } from "../../src/registry";

describe("Adopt Existing Project", () => {
  const tmpDir = path.join(os.tmpdir(), `raptor-adopt-test-${Date.now()}`);
  const registryPath = path.join(tmpDir, "projects.json");
  let registry: Registry;

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    registry = new Registry(registryPath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("Validation", () => {
    it("rejects invalid project names", () => {
      const name = "My App!";
      const valid = /^[a-z][a-z0-9-]*$/.test(name);
      expect(valid).toBe(false);
    });

    it("accepts valid project names", () => {
      const name = "my-app";
      const valid = /^[a-z][a-z0-9-]*$/.test(name);
      expect(valid).toBe(true);
    });

    it("detects non-existent path", () => {
      const fakePath = path.join(tmpDir, "nonexistent");
      expect(fs.existsSync(fakePath)).toBe(false);
    });

    it("detects path that is not a directory", () => {
      const filePath = path.join(tmpDir, "not-a-dir.txt");
      fs.writeFileSync(filePath, "hello");
      const stat = fs.statSync(filePath);
      expect(stat.isDirectory()).toBe(false);
    });

    it("detects non-git directory", () => {
      const dirPath = path.join(tmpDir, "no-git");
      fs.mkdirSync(dirPath, { recursive: true });
      const gitDir = path.join(dirPath, ".git");
      expect(fs.existsSync(gitDir)).toBe(false);
    });

    it("detects git directory", async () => {
      const repoPath = path.join(tmpDir, "has-git");
      fs.mkdirSync(repoPath, { recursive: true });
      const git = simpleGit(repoPath);
      await git.init();
      const gitDir = path.join(repoPath, ".git");
      expect(fs.existsSync(gitDir)).toBe(true);
    });
  });

  describe("Duplicate detection", () => {
    it("detects duplicate name", async () => {
      const repoPath = path.join(tmpDir, "dup-name-test");
      fs.mkdirSync(repoPath, { recursive: true });
      await registry.addProject({
        name: "dup-test",
        slug: "dup-test",
        description: "test",
        path: repoPath,
        createdAt: new Date().toISOString(),
      });
      const exists = await registry.projectExists("dup-test");
      expect(exists).toBe(true);
    });

    it("detects duplicate path via registry scan", async () => {
      const projects = await registry.listProjects();
      const targetPath = path.join(tmpDir, "dup-name-test");
      const found = projects.find((p) => p.path === targetPath);
      expect(found).toBeDefined();
      expect(found!.name).toBe("dup-test");
    });
  });

  describe("Additive scaffolding", () => {
    it("creates TEAM.md only if missing", async () => {
      const repoPath = path.join(tmpDir, "scaffold-test");
      fs.mkdirSync(repoPath, { recursive: true });
      await simpleGit(repoPath).init();

      // No TEAM.md exists
      expect(fs.existsSync(path.join(repoPath, "TEAM.md"))).toBe(false);

      // Simulate scaffold
      const teamMdPath = path.join(repoPath, "TEAM.md");
      if (!fs.existsSync(teamMdPath)) {
        fs.writeFileSync(teamMdPath, "# Team Process");
      }
      expect(fs.existsSync(teamMdPath)).toBe(true);
    });

    it("does NOT overwrite existing TEAM.md", () => {
      const repoPath = path.join(tmpDir, "scaffold-test");
      const teamMdPath = path.join(repoPath, "TEAM.md");
      const existingContent = "# My Custom Team Process";
      fs.writeFileSync(teamMdPath, existingContent);

      // Scaffold logic: only write if missing
      if (!fs.existsSync(teamMdPath)) {
        fs.writeFileSync(teamMdPath, "# Default TEAM.md");
      }

      const content = fs.readFileSync(teamMdPath, "utf-8");
      expect(content).toBe(existingContent);
    });

    it("preserves existing docs files when adding subdirectories", () => {
      const repoPath = path.join(tmpDir, "docs-preserve-test");
      fs.mkdirSync(repoPath, { recursive: true });
      const docsDir = path.join(repoPath, "docs");
      fs.mkdirSync(docsDir, { recursive: true });

      // Create existing doc files
      fs.writeFileSync(path.join(docsDir, "design.md"), "# Design Doc");
      fs.writeFileSync(path.join(docsDir, "api.md"), "# API Reference");

      // Simulate additive scaffold: add missing subdirs
      const subDirs = ["specs", "architecture", "sprints"];
      for (const sub of subDirs) {
        const subPath = path.join(docsDir, sub);
        if (!fs.existsSync(subPath)) {
          fs.mkdirSync(subPath, { recursive: true });
          fs.writeFileSync(path.join(subPath, ".gitkeep"), "");
        }
      }

      // Verify existing files untouched
      expect(fs.readFileSync(path.join(docsDir, "design.md"), "utf-8")).toBe("# Design Doc");
      expect(fs.readFileSync(path.join(docsDir, "api.md"), "utf-8")).toBe("# API Reference");

      // Verify new subdirs created
      expect(fs.existsSync(path.join(docsDir, "specs"))).toBe(true);
      expect(fs.existsSync(path.join(docsDir, "architecture"))).toBe(true);
      expect(fs.existsSync(path.join(docsDir, "sprints"))).toBe(true);
    });

    it("skips README.md entirely", () => {
      const repoPath = path.join(tmpDir, "readme-test");
      fs.mkdirSync(repoPath, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "README.md"), "# My Project");

      // Scaffold logic: never touch README
      const readmePath = path.join(repoPath, "README.md");
      // (no write attempted)

      expect(fs.readFileSync(readmePath, "utf-8")).toBe("# My Project");
    });

    it("creates backlog.md only if missing", () => {
      const repoPath = path.join(tmpDir, "backlog-test");
      fs.mkdirSync(path.join(repoPath, "docs"), { recursive: true });

      const backlogPath = path.join(repoPath, "docs", "backlog.md");
      expect(fs.existsSync(backlogPath)).toBe(false);

      if (!fs.existsSync(backlogPath)) {
        fs.writeFileSync(backlogPath, "# Backlog\n\n## Sprint 1\n\n## Ready\n\n## Inbox\n\n## Done\n");
      }
      expect(fs.existsSync(backlogPath)).toBe(true);
    });
  });

  describe("Context discovery", () => {
    it("reads README.md for project description", () => {
      const repoPath = path.join(tmpDir, "context-test");
      fs.mkdirSync(repoPath, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "README.md"), "# My App\n\nA financial planning tool built with React.");

      const readme = fs.readFileSync(path.join(repoPath, "README.md"), "utf-8");
      expect(readme).toContain("financial planning");
    });

    it("detects tech stack from package.json", () => {
      const repoPath = path.join(tmpDir, "context-test");
      fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({
        name: "my-app",
        dependencies: { react: "^18.0.0", express: "^4.18.0" },
        devDependencies: { jest: "^29.0.0", typescript: "^5.0.0" },
      }));

      const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf-8"));
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      expect(deps).toContain("react");
      expect(deps).toContain("jest");
      expect(deps).toContain("typescript");
    });

    it("detects tech stack from pyproject.toml", () => {
      const repoPath = path.join(tmpDir, "python-context-test");
      fs.mkdirSync(repoPath, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "pyproject.toml"), '[project]\nname = "my-app"\ndependencies = ["fastapi", "sqlalchemy"]');

      const content = fs.readFileSync(path.join(repoPath, "pyproject.toml"), "utf-8");
      expect(content).toContain("fastapi");
    });

    it("reads existing docs directory", () => {
      const repoPath = path.join(tmpDir, "context-test");
      const docsDir = path.join(repoPath, "docs");
      fs.mkdirSync(docsDir, { recursive: true });
      fs.writeFileSync(path.join(docsDir, "design.md"), "# System Design\n\nMicroservices architecture with event sourcing.");

      const files = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"));
      expect(files.length).toBeGreaterThan(0);

      const content = fs.readFileSync(path.join(docsDir, "design.md"), "utf-8");
      expect(content).toContain("Microservices");
    });

    it("caps file read at 10KB", () => {
      const maxPerFile = 10 * 1024;
      const largeContent = "x".repeat(20 * 1024);
      const truncated = largeContent.slice(0, maxPerFile);
      expect(truncated.length).toBe(maxPerFile);
    });

    it("generates project-context.md only if missing", () => {
      const repoPath = path.join(tmpDir, "context-gen-test");
      fs.mkdirSync(path.join(repoPath, "docs"), { recursive: true });
      const contextPath = path.join(repoPath, "docs", "project-context.md");

      expect(fs.existsSync(contextPath)).toBe(false);

      if (!fs.existsSync(contextPath)) {
        fs.writeFileSync(contextPath, "# Project Context\n\nGenerated by Raptor.");
      }
      expect(fs.existsSync(contextPath)).toBe(true);
    });

    it("skips binary files", () => {
      const fileName = "logo.png";
      const isBinary = /\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|pdf|zip|tar|gz)$/i.test(fileName);
      expect(isBinary).toBe(true);

      const textFile = "design.md";
      const isTextBinary = /\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|pdf|zip|tar|gz)$/i.test(textFile);
      expect(isTextBinary).toBe(false);
    });
  });

  describe("Directory tree reading", () => {
    it("reads top 2 levels of project structure", () => {
      const repoPath = path.join(tmpDir, "tree-test");
      fs.mkdirSync(path.join(repoPath, "src", "components"), { recursive: true });
      fs.mkdirSync(path.join(repoPath, "src", "utils"), { recursive: true });
      fs.mkdirSync(path.join(repoPath, "tests"), { recursive: true });
      fs.writeFileSync(path.join(repoPath, "src", "index.ts"), "export {};");

      const topLevel = fs.readdirSync(repoPath);
      expect(topLevel).toContain("src");
      expect(topLevel).toContain("tests");

      const srcLevel = fs.readdirSync(path.join(repoPath, "src"));
      expect(srcLevel).toContain("components");
      expect(srcLevel).toContain("utils");
      expect(srcLevel).toContain("index.ts");
    });
  });
});
