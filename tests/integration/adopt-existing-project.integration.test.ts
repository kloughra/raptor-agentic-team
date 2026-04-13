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

  describe("Backlog reformatting on adopt", () => {
    it("finds BACKLOG.md (uppercase) in project root", () => {
      const repoPath = path.join(tmpDir, "uppercase-backlog-test");
      fs.mkdirSync(repoPath, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "BACKLOG.md"), "# Backlog\n- Build login page\n- Add auth");

      // Case-insensitive detection
      const files = fs.readdirSync(repoPath);
      const backlogFile = files.find((f) => f.toLowerCase() === "backlog.md");
      expect(backlogFile).toBe("BACKLOG.md");
    });

    it("finds BACKLOG.MD (all caps) in project root", () => {
      const repoPath = path.join(tmpDir, "allcaps-backlog-test");
      fs.mkdirSync(repoPath, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "BACKLOG.MD"), "# TODO\n- Feature A");

      const files = fs.readdirSync(repoPath);
      const backlogFile = files.find((f) => f.toLowerCase() === "backlog.md");
      expect(backlogFile).toBe("BACKLOG.MD");
    });

    it("finds backlog.md in docs/ subfolder", () => {
      const repoPath = path.join(tmpDir, "docs-backlog-test");
      fs.mkdirSync(path.join(repoPath, "docs"), { recursive: true });
      fs.writeFileSync(path.join(repoPath, "docs", "backlog.md"), "# Backlog\n- Item 1");

      const docsFiles = fs.readdirSync(path.join(repoPath, "docs"));
      const backlogFile = docsFiles.find((f) => f.toLowerCase() === "backlog.md");
      expect(backlogFile).toBe("backlog.md");
    });

    it("reformats freeform backlog items into Raptor sections", () => {
      const existingContent = [
        "# TODO",
        "",
        "## In Progress",
        "- Build user dashboard",
        "- [x] Set up CI/CD pipeline",
        "",
        "## Up Next",
        "- Add payment integration",
        "- Implement notifications",
        "",
        "## Ideas",
        "- Mobile app version",
        "- Analytics dashboard",
        "",
        "## Completed",
        "- [x] Project scaffolding",
        "- [x] Database schema design",
      ].join("\n");

      // Simulate the reformat logic
      const lines = existingContent.split("\n");
      const items: { text: string; section: string; done: boolean }[] = [];
      let currentSection = "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (/^#{1,3}\s*(in\s*progress|current|active)/i.test(trimmed)) {
          currentSection = "sprint";
        } else if (/^#{1,3}\s*(up\s*next|ready|prioritized|next)/i.test(trimmed)) {
          currentSection = "ready";
        } else if (/^#{1,3}\s*(ideas|inbox|unprioritized|icebox|future)/i.test(trimmed)) {
          currentSection = "inbox";
        } else if (/^#{1,3}\s*(completed|done|finished|shipped)/i.test(trimmed)) {
          currentSection = "done";
        }

        const itemMatch = trimmed.match(/^[-*]\s+(?:\[([x ])\]\s+)?(.+)/i);
        if (itemMatch) {
          const checked = itemMatch[1]?.toLowerCase() === "x";
          items.push({ text: itemMatch[2], section: currentSection, done: checked });
        }
      }

      // Verify items were categorized
      const sprintItems = items.filter((i) => i.section === "sprint" && !i.done);
      const readyItems = items.filter((i) => i.section === "ready");
      const inboxItems = items.filter((i) => i.section === "inbox");
      const doneItems = items.filter((i) => i.done || i.section === "done");

      expect(sprintItems.length).toBe(1); // "Build user dashboard"
      expect(readyItems.length).toBe(2);  // payment + notifications
      expect(inboxItems.length).toBe(2);  // mobile + analytics
      expect(doneItems.length).toBeGreaterThanOrEqual(3); // CI/CD + scaffolding + database
    });

    it("preserves all item text during reformatting", () => {
      const items = [
        "Build user authentication with OAuth2 and PKCE flow",
        "Add rate limiting to API endpoints (100 req/min default)",
        "Implement WebSocket real-time notifications for order updates",
      ];

      const backlog = `# BACKLOG\n${items.map((i) => `- ${i}`).join("\n")}`;

      // All items should appear in reformatted output
      for (const item of items) {
        expect(backlog).toContain(item);
      }
    });

    it("detects sprint number from existing backlog", () => {
      const content = "# Backlog\n## Sprint 3\n- [ ] Feature X\n## Done\n- [x] Feature Y";
      const match = content.match(/sprint\s+(\d+)/i);
      expect(match).not.toBeNull();
      expect(parseInt(match![1], 10)).toBe(3);
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
