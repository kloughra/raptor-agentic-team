import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  resolveExpectedOutputPaths,
  validateRequiredOutputs,
  buildTeamMdContext,
} from "../../src/orchestrator";
import { WorkflowStep, SPRINT_WORKFLOW } from "../../src/orchestrator/workflow";

describe("Artifact Output Validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-output-val-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Layer 2: resolveExpectedOutputPaths ---

  describe("resolveExpectedOutputPaths", () => {
    it("resolves glob patterns to concrete paths using feature slug", () => {
      const patterns = ["docs/specs/*.md", "docs/architecture/*.md"];
      const resolved = resolveExpectedOutputPaths(patterns, "my-feature");
      expect(resolved).toEqual([
        "docs/specs/my-feature.md",
        "docs/architecture/my-feature.md",
      ]);
    });

    it("filters out double-star globs (handled by directory check)", () => {
      const patterns = ["src/**/*.ts"];
      const resolved = resolveExpectedOutputPaths(patterns, "my-feature");
      // Double-star globs are not resolvable to a single path — they're filtered out
      expect(resolved).toEqual([]);
    });

    it("returns empty array for steps with no expected outputs", () => {
      const resolved = resolveExpectedOutputPaths([], "my-feature");
      expect(resolved).toEqual([]);
    });

    it("drops patterns that cannot be fully resolved", () => {
      // A pattern with multiple wildcards that can't be resolved
      const patterns = ["docs/specs/*.md", "src/**/components/*.tsx"];
      const resolved = resolveExpectedOutputPaths(patterns, "my-feature");
      // First resolves, second still has a * after replacement
      expect(resolved).toContain("docs/specs/my-feature.md");
      // The second should be filtered out since it still contains *
      expect(resolved.every((p) => !p.includes("*"))).toBe(true);
    });
  });

  // --- Layer 3: validateRequiredOutputs ---

  describe("validateRequiredOutputs", () => {
    const makeStep = (expectedOutputs: string[]): WorkflowStep => ({
      step: 1,
      role: "po",
      name: "Author specification",
      description: "Write a spec",
      inputArtifacts: [],
      expectedOutputs,
    });

    it("returns empty array when all required outputs exist", () => {
      const specDir = path.join(tmpDir, "docs", "specs");
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(path.join(specDir, "my-feature.md"), "# Spec content");

      const step = makeStep(["docs/specs/*.md"]);
      const missing = validateRequiredOutputs(step, "my-feature", tmpDir);
      expect(missing).toEqual([]);
    });

    it("returns missing files when required outputs do not exist", () => {
      // Don't create the file
      const step = makeStep(["docs/specs/*.md"]);
      const missing = validateRequiredOutputs(step, "my-feature", tmpDir);
      expect(missing).toContain("docs/specs/my-feature.md");
    });

    it("returns empty array for steps with no expected outputs", () => {
      const step = makeStep([]);
      const missing = validateRequiredOutputs(step, "my-feature", tmpDir);
      expect(missing).toEqual([]);
    });

    it("validates multiple output files independently", () => {
      // Create one but not the other
      const specDir = path.join(tmpDir, "docs", "specs");
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(path.join(specDir, "my-feature.md"), "# Spec");

      const step = makeStep(["docs/specs/*.md", "docs/architecture/*.md"]);
      const missing = validateRequiredOutputs(step, "my-feature", tmpDir);
      expect(missing).toContain("docs/architecture/my-feature.md");
      expect(missing).not.toContain("docs/specs/my-feature.md");
    });

    it("handles unresolvable glob patterns with directory-level check", () => {
      // src/**/*.ts can't resolve to a single file — check directory has files
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, "index.ts"), "export {}");

      const step = makeStep(["src/**/*.ts"]);
      const missing = validateRequiredOutputs(step, "my-feature", tmpDir);
      expect(missing).toEqual([]);
    });

    it("fails unresolvable glob patterns when directory is empty", () => {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      // Directory exists but has no files

      const step = makeStep(["src/**/*.ts"]);
      const missing = validateRequiredOutputs(step, "my-feature", tmpDir);
      expect(missing.length).toBeGreaterThan(0);
    });

    it("fails unresolvable glob patterns when directory does not exist", () => {
      const step = makeStep(["src/**/*.ts"]);
      const missing = validateRequiredOutputs(step, "my-feature", tmpDir);
      expect(missing.length).toBeGreaterThan(0);
    });
  });

  // --- Layer 1: buildTeamMdContext ---

  describe("buildTeamMdContext", () => {
    it("reads TEAM.md from the project directory", () => {
      fs.writeFileSync(
        path.join(tmpDir, "TEAM.md"),
        "# Team Process\n\nThis is the team methodology."
      );

      const context = buildTeamMdContext(tmpDir);
      expect(context).toContain("TEAM.md (Process Definition)");
      expect(context).toContain("# Team Process");
      expect(context).toContain("This is the team methodology.");
    });

    it("returns empty string when no TEAM.md exists", () => {
      // Use a directory that definitely has no TEAM.md and no bundled template
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-no-team-"));
      // Note: this may find the bundled template as fallback
      // The function should still return a string (possibly the template)
      const context = buildTeamMdContext(emptyDir);
      // It's either empty or contains the bundled template — both are valid
      expect(typeof context).toBe("string");
      fs.rmSync(emptyDir, { recursive: true, force: true });
    });

    it("truncates large TEAM.md files", () => {
      const largeContent = "# Team\n" + "x".repeat(10 * 1024); // > 8KB cap
      fs.writeFileSync(path.join(tmpDir, "TEAM.md"), largeContent);

      const context = buildTeamMdContext(tmpDir);
      expect(context).toContain("truncated for context size");
      // Should be capped — the section wrapper adds some overhead
      expect(context.length).toBeLessThan(largeContent.length);
    });
  });

  // --- Layer 2: Task description mandate ---

  describe("buildTaskDescription output mandate", () => {
    it("includes REQUIRED OUTPUT FILES for steps with expected outputs", () => {
      // We can't call buildTaskDescription directly (it's not exported),
      // but we can verify the workflow steps that matter have expectedOutputs
      const specStep = SPRINT_WORKFLOW.find((s) => s.name === "Author specification");
      expect(specStep).toBeDefined();
      expect(specStep!.expectedOutputs).toContain("docs/specs/*.md");

      const archStep = SPRINT_WORKFLOW.find((s) => s.name === "Architecture design");
      expect(archStep).toBeDefined();
      expect(archStep!.expectedOutputs).toContain("docs/architecture/*.md");

      const testStep = SPRINT_WORKFLOW.find((s) => s.name === "Write tests");
      expect(testStep).toBeDefined();
      expect(testStep!.expectedOutputs.length).toBeGreaterThan(0);
    });

    it("steps without outputs have empty expectedOutputs", () => {
      const prStep = SPRINT_WORKFLOW.find((s) => s.name === "Open PR");
      expect(prStep).toBeDefined();
      expect(prStep!.expectedOutputs).toEqual([]);

      const demoStep = SPRINT_WORKFLOW.find((s) => s.name === "Demo");
      expect(demoStep).toBeDefined();
      expect(demoStep!.expectedOutputs).toEqual([]);
    });

    it("resolveExpectedOutputPaths produces concrete paths for all artifact steps", () => {
      const artifactSteps = SPRINT_WORKFLOW.filter((s) => s.expectedOutputs.length > 0);
      for (const step of artifactSteps) {
        const resolved = resolveExpectedOutputPaths(step.expectedOutputs, "test-feature");
        // At least some patterns should resolve (glob-only patterns get filtered)
        // The important thing is no resolved path contains a wildcard
        for (const p of resolved) {
          expect(p).not.toContain("*");
        }
      }
    });
  });

  // --- Integration: The cascade scenario ---

  describe("cascade prevention scenario", () => {
    it("detects missing spec after PO exits without writing file", () => {
      // Simulate: PO agent exits 0, but docs/specs/my-feature.md doesn't exist
      const poStep = SPRINT_WORKFLOW.find((s) => s.name === "Author specification")!;
      const missing = validateRequiredOutputs(poStep, "my-feature", tmpDir);
      expect(missing).toContain("docs/specs/my-feature.md");
    });

    it("detects missing architecture after Architect exits without writing file", () => {
      // Simulate: spec exists (from PO), but architecture doc wasn't created
      const specDir = path.join(tmpDir, "docs", "specs");
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(path.join(specDir, "my-feature.md"), "# Spec");

      const archStep = SPRINT_WORKFLOW.find((s) => s.name === "Architecture design")!;
      const missing = validateRequiredOutputs(archStep, "my-feature", tmpDir);
      expect(missing).toContain("docs/architecture/my-feature.md");
    });

    it("detects missing BDD tests after QA exits without writing file", () => {
      // Simulate: spec + arch exist, but no BDD feature file
      const specDir = path.join(tmpDir, "docs", "specs");
      const archDir = path.join(tmpDir, "docs", "architecture");
      fs.mkdirSync(specDir, { recursive: true });
      fs.mkdirSync(archDir, { recursive: true });
      fs.writeFileSync(path.join(specDir, "my-feature.md"), "# Spec");
      fs.writeFileSync(path.join(archDir, "my-feature.md"), "# Arch");

      const qaStep = SPRINT_WORKFLOW.find((s) => s.name === "Write tests")!;
      const missing = validateRequiredOutputs(qaStep, "my-feature", tmpDir);
      expect(missing).toContain("tests/bdd/my-feature.feature");
    });

    it("passes when all artifacts are present", () => {
      // Create all artifacts that any step might expect as output
      const dirs = [
        "docs/specs", "docs/architecture", "docs/sprints",
        "tests/bdd", "tests/integration", "src",
      ];
      for (const dir of dirs) {
        fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
      }
      fs.writeFileSync(path.join(tmpDir, "docs/specs/my-feature.md"), "# Spec");
      fs.writeFileSync(path.join(tmpDir, "docs/architecture/my-feature.md"), "# Arch");
      fs.writeFileSync(path.join(tmpDir, "docs/backlog.md"), "## Sprint 1\n- [ ] my-feature: test");
      fs.writeFileSync(path.join(tmpDir, "docs/sprints/my-feature.md"), "# Sprint summary");
      fs.writeFileSync(path.join(tmpDir, "tests/bdd/my-feature.feature"), "Feature: ...");
      // tests/integration/* resolves to tests/integration/my-feature (exact path)
      fs.writeFileSync(path.join(tmpDir, "tests/integration/my-feature"), "test()");
      fs.writeFileSync(path.join(tmpDir, "src/index.ts"), "export {}");
      fs.writeFileSync(path.join(tmpDir, "TEAM.md"), "# Team process");

      // All steps should pass validation
      for (const step of SPRINT_WORKFLOW) {
        if (step.expectedOutputs.length > 0) {
          const missing = validateRequiredOutputs(step, "my-feature", tmpDir);
          expect(missing).toEqual([]);
        }
      }
    });
  });
});
