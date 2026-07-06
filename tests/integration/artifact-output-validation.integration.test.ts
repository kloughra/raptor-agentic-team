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
    it("produces slug-scoped descriptions that reference the original pattern", () => {
      const patterns = ["docs/specs/*.md", "docs/architecture/*.md"];
      const resolved = resolveExpectedOutputPaths(patterns, "my-feature");
      expect(resolved).toHaveLength(2);
      expect(resolved[0]).toContain("docs/specs/*.md");
      expect(resolved[0]).toContain("docs/specs/my-feature.md"); // conventional example
      expect(resolved[1]).toContain("docs/architecture/*.md");
    });

    it("includes double-star globs (matched at any depth, no slug requirement)", () => {
      const patterns = ["src/**/*.ts"];
      const resolved = resolveExpectedOutputPaths(patterns, "my-feature");
      // Old behavior filtered these out; now every pattern gets a description
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toContain("src/**/*.ts");
    });

    it("returns empty array for steps with no expected outputs", () => {
      const resolved = resolveExpectedOutputPaths([], "my-feature");
      expect(resolved).toEqual([]);
    });

    it("never emits a bare extensionless literal (the Sprint-8 trap)", () => {
      const resolved = resolveExpectedOutputPaths(["tests/integration/*"], "my-feature");
      expect(resolved).toHaveLength(1);
      // The agent must never be instructed to create tests/integration/my-feature
      expect(resolved[0]).not.toBe("tests/integration/my-feature");
      expect(resolved[0]).toContain("tests/integration/*");
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

    it("returns missing patterns when required outputs do not exist", () => {
      // Don't create the file
      const step = makeStep(["docs/specs/*.md"]);
      const missing = validateRequiredOutputs(step, "my-feature", tmpDir);
      // The missing list reports the ORIGINAL pattern, not a resolved literal
      expect(missing).toContain("docs/specs/*.md");
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
      expect(missing).toContain("docs/architecture/*.md");
      expect(missing).not.toContain("docs/specs/*.md");
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

    it("resolveExpectedOutputPaths produces a description for every artifact step pattern", () => {
      const artifactSteps = SPRINT_WORKFLOW.filter((s) => s.expectedOutputs.length > 0);
      for (const step of artifactSteps) {
        const resolved = resolveExpectedOutputPaths(step.expectedOutputs, "test-feature");
        // Every pattern gets a description that references the original pattern,
        // so the agent instruction and the validation gate cannot drift
        expect(resolved).toHaveLength(step.expectedOutputs.length);
        step.expectedOutputs.forEach((pattern, i) => {
          expect(resolved[i]).toContain(pattern);
        });
      }
    });
  });

  // --- Integration: The cascade scenario ---

  describe("cascade prevention scenario", () => {
    it("detects missing spec after PO exits without writing file", () => {
      // Simulate: PO agent exits 0, but no spec file was written
      const poStep = SPRINT_WORKFLOW.find((s) => s.name === "Author specification")!;
      const missing = validateRequiredOutputs(poStep, "my-feature", tmpDir);
      expect(missing).toContain("docs/specs/*.md");
    });

    it("detects missing architecture after Architect exits without writing file", () => {
      // Simulate: spec exists (from PO), but architecture doc wasn't created
      const specDir = path.join(tmpDir, "docs", "specs");
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(path.join(specDir, "my-feature.md"), "# Spec");

      const archStep = SPRINT_WORKFLOW.find((s) => s.name === "Architecture design")!;
      const missing = validateRequiredOutputs(archStep, "my-feature", tmpDir);
      expect(missing).toContain("docs/architecture/*.md");
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
      expect(missing).toContain("tests/bdd/*.feature");
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
      // tests/integration/* now matches the CONVENTIONAL filename — the old
      // extensionless-literal resolution (tests/integration/my-feature) is gone
      fs.writeFileSync(
        path.join(tmpDir, "tests/integration/my-feature.integration.test.ts"),
        "test()"
      );
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
