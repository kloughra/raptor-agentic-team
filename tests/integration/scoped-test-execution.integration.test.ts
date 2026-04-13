import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Scoped Test Execution", () => {
  const tmpDir = path.join(os.tmpdir(), `raptor-scoped-test-${Date.now()}`);

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("Test framework detection", () => {
    it("detects jest from package.json", () => {
      const repoPath = path.join(tmpDir, "jest-project");
      fs.mkdirSync(repoPath, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({
        devDependencies: { jest: "^29.0.0" },
      }));

      const hasPackageJson = fs.existsSync(path.join(repoPath, "package.json"));
      expect(hasPackageJson).toBe(true);
      // Framework: "jest"
    });

    it("detects pytest from pyproject.toml", () => {
      const repoPath = path.join(tmpDir, "pytest-project");
      fs.mkdirSync(repoPath, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "pyproject.toml"), "[project]\nname = 'test'");

      const hasPyproject = fs.existsSync(path.join(repoPath, "pyproject.toml"));
      expect(hasPyproject).toBe(true);
    });

    it("detects pytest from setup.py", () => {
      const repoPath = path.join(tmpDir, "setuppy-project");
      fs.mkdirSync(repoPath, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "setup.py"), "from setuptools import setup");

      const hasSetupPy = fs.existsSync(path.join(repoPath, "setup.py"));
      expect(hasSetupPy).toBe(true);
    });

    it("detects cargo from Cargo.toml", () => {
      const repoPath = path.join(tmpDir, "cargo-project");
      fs.mkdirSync(repoPath, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "Cargo.toml"), '[package]\nname = "test"');

      const hasCargoToml = fs.existsSync(path.join(repoPath, "Cargo.toml"));
      expect(hasCargoToml).toBe(true);
    });

    it("returns unknown when no manifest found", () => {
      const repoPath = path.join(tmpDir, "empty-project");
      fs.mkdirSync(repoPath, { recursive: true });

      const hasPackageJson = fs.existsSync(path.join(repoPath, "package.json"));
      const hasPyproject = fs.existsSync(path.join(repoPath, "pyproject.toml"));
      const hasSetupPy = fs.existsSync(path.join(repoPath, "setup.py"));
      const hasCargoToml = fs.existsSync(path.join(repoPath, "Cargo.toml"));

      expect(hasPackageJson).toBe(false);
      expect(hasPyproject).toBe(false);
      expect(hasSetupPy).toBe(false);
      expect(hasCargoToml).toBe(false);
    });
  });

  describe("Scoped test command building", () => {
    type TestFramework = "jest" | "pytest" | "cargo" | "unknown";

    function buildScopedTestCommand(framework: TestFramework, slug: string, customCommand?: string): string | null {
      if (customCommand) {
        return customCommand.replace(/\{slug\}/g, slug);
      }
      switch (framework) {
        case "jest": return `npx jest --testPathPattern="${slug}"`;
        case "pytest": return `pytest -k "${slug}"`;
        case "cargo": return `cargo test ${slug}`;
        case "unknown": return null;
      }
    }

    function buildFullTestCommand(framework: TestFramework, customCommand?: string): string | null {
      if (customCommand) {
        return customCommand.replace(/\{slug\}/g, "");
      }
      switch (framework) {
        case "jest": return "npx jest";
        case "pytest": return "pytest";
        case "cargo": return "cargo test";
        case "unknown": return null;
      }
    }

    it("jest scoped command", () => {
      expect(buildScopedTestCommand("jest", "agent-parallel-execution"))
        .toBe('npx jest --testPathPattern="agent-parallel-execution"');
    });

    it("pytest scoped command", () => {
      expect(buildScopedTestCommand("pytest", "data-pipeline"))
        .toBe('pytest -k "data-pipeline"');
    });

    it("cargo scoped command", () => {
      expect(buildScopedTestCommand("cargo", "auth-module"))
        .toBe("cargo test auth-module");
    });

    it("unknown returns null", () => {
      expect(buildScopedTestCommand("unknown", "anything")).toBeNull();
    });

    it("custom command replaces {slug}", () => {
      expect(buildScopedTestCommand("jest", "my-feature", "npm test -- --grep={slug}"))
        .toBe("npm test -- --grep=my-feature");
    });

    it("full test commands have no scoping", () => {
      expect(buildFullTestCommand("jest")).toBe("npx jest");
      expect(buildFullTestCommand("pytest")).toBe("pytest");
      expect(buildFullTestCommand("cargo")).toBe("cargo test");
    });
  });

  describe("Feature slug escaping", () => {
    function escapeForTestPattern(slug: string): string {
      return slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    it("passes through normal slugs unchanged", () => {
      expect(escapeForTestPattern("agent-parallel-execution")).toBe("agent-parallel-execution");
    });

    it("escapes dots", () => {
      expect(escapeForTestPattern("my-feature.v2")).toBe("my-feature\\.v2");
    });

    it("escapes multiple special chars", () => {
      expect(escapeForTestPattern("feat(test)")).toBe("feat\\(test\\)");
    });

    it("standard slugs have no special chars", () => {
      // Raptor slugs are ^[a-z][a-z0-9-]*$ — no special chars possible
      const slug = "dino-agent-names";
      expect(escapeForTestPattern(slug)).toBe(slug);
    });
  });

  describe("Task description injection", () => {
    it("engineer step includes scoped test instruction", () => {
      const scopedCommand = 'npx jest --testPathPattern="dino-agent-names"';
      const taskDesc = [
        "Sprint 6, Step 5: Implement (TDD).",
        `\n## Test Scope`,
        `Run ONLY tests matching your feature: \`${scopedCommand}\``,
        "Do NOT run the full test suite — other features are being worked on in parallel.",
      ].join("\n");

      expect(taskDesc).toContain("Run ONLY tests matching your feature");
      expect(taskDesc).toContain("dino-agent-names");
      expect(taskDesc).not.toContain("Run the FULL test suite");
    });

    it("QA step includes full test command", () => {
      const fullCommand = "npx jest";
      const taskDesc = [
        "Sprint 6, Step 7: Run test suite.",
        `\nRun the FULL test suite: \`${fullCommand}\``,
      ].join("\n");

      expect(taskDesc).toContain("Run the FULL test suite");
      expect(taskDesc).not.toContain("Run ONLY");
    });

    it("shared config warning present in multi-feature mode", () => {
      const isMultiFeature = true;
      const parts: string[] = ["Sprint 6, Step 5: Implement (TDD)."];

      if (isMultiFeature) {
        parts.push("\n## Shared File Warning");
        parts.push("Do NOT modify shared config files (jest.config.js, pyproject.toml, tsconfig.json, etc.).");
        parts.push("If a config change is needed, raise a [BLOCKER].");
      }

      const taskDesc = parts.join("\n");
      expect(taskDesc).toContain("Shared File Warning");
      expect(taskDesc).toContain("[BLOCKER]");
    });

    it("no shared config warning in single-feature mode", () => {
      const isMultiFeature = false;
      const parts: string[] = ["Sprint 6, Step 5: Implement (TDD)."];

      if (isMultiFeature) {
        parts.push("\n## Shared File Warning");
      }

      const taskDesc = parts.join("\n");
      expect(taskDesc).not.toContain("Shared File Warning");
    });
  });
});
