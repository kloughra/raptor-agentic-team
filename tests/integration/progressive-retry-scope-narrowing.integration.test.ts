import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  decomposeTask,
  executeNarrowedRetry,
  isNarrowable,
  SubTask,
  NarrowingConfig,
} from "../../src/orchestrator/scope-narrowing";
import { SPRINT_WORKFLOW, Role } from "../../src/orchestrator/workflow";

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-narrowing-"));
  return dir;
}

function cleanupDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("Progressive Retry with Scope Narrowing", () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = createTempProject();
  });

  afterEach(() => {
    cleanupDir(projectPath);
  });

  describe("isNarrowable", () => {
    it("should return true for engineer role", () => {
      expect(isNarrowable("engineer")).toBe(true);
    });

    it("should return true for qa role", () => {
      expect(isNarrowable("qa")).toBe(true);
    });

    it("should return true for architect role", () => {
      expect(isNarrowable("architect")).toBe(true);
    });

    it("should return false for po role", () => {
      expect(isNarrowable("po")).toBe(false);
    });

    it("should return false for team role", () => {
      expect(isNarrowable("team")).toBe(false);
    });
  });

  describe("decomposeTask — Engineer (by acceptance criteria)", () => {
    it("should split by acceptance criteria from spec", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "my-feature.md"),
        [
          "# My Feature",
          "## Acceptance Criteria",
          "- [ ] Users can create accounts with email",
          "- [ ] Users receive a confirmation email",
          "- [ ] Duplicate emails are rejected with a clear error",
        ].join("\n")
      );

      const step = SPRINT_WORKFLOW.find((s) => s.name === "Implement (TDD)")!;
      const subTasks = decomposeTask("engineer", step, "my-feature", projectPath, "Original task");

      expect(subTasks.length).toBe(3);
      expect(subTasks[0].description).toContain("create accounts with email");
      expect(subTasks[1].description).toContain("confirmation email");
      expect(subTasks[2].description).toContain("Duplicate emails");
    });

    it("should fall back to single task if no parseable criteria", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "my-feature.md"),
        "# My Feature\nJust a description, no criteria."
      );

      const step = SPRINT_WORKFLOW.find((s) => s.name === "Implement (TDD)")!;
      const subTasks = decomposeTask("engineer", step, "my-feature", projectPath, "Original task");

      expect(subTasks.length).toBeLessThanOrEqual(1);
    });

    it("should cap sub-tasks at 6", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      const criteria = Array.from({ length: 10 }, (_, i) =>
        `- [ ] Criterion ${i + 1}: do something`
      ).join("\n");
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "my-feature.md"),
        `# Feature\n## Acceptance Criteria\n${criteria}`
      );

      const step = SPRINT_WORKFLOW.find((s) => s.name === "Implement (TDD)")!;
      const subTasks = decomposeTask("engineer", step, "my-feature", projectPath, "Original task");

      expect(subTasks.length).toBeLessThanOrEqual(6);
    });
  });

  describe("decomposeTask — QA (by scenario group)", () => {
    it("should group scenarios into happy path, error, and edge cases", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "my-feature.md"),
        [
          "# My Feature",
          "## Acceptance Criteria",
          "- [ ] Users can log in successfully",
          "- [ ] Invalid credentials show error message",
          "- [ ] Empty password field is rejected",
          "- [ ] Session expires after timeout",
          "- [ ] Boundary: maximum password length is 128 chars",
        ].join("\n")
      );

      const step = SPRINT_WORKFLOW.find((s) => s.name === "Write tests")!;
      const subTasks = decomposeTask("qa", step, "my-feature", projectPath, "Original task");

      expect(subTasks.length).toBeGreaterThanOrEqual(2);
      // Should have at least a happy-path and error/edge group
      const scopes = subTasks.map((st) => st.scope.toLowerCase());
      expect(scopes.some((s) => s.includes("happy") || s.includes("success"))).toBe(true);
      expect(scopes.some((s) => s.includes("error") || s.includes("edge") || s.includes("failure"))).toBe(true);
    });
  });

  describe("decomposeTask — Architect (by component)", () => {
    it("should split by components from spec", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "my-feature.md"),
        [
          "# My Feature",
          "## Components",
          "- Authentication service",
          "- User database schema",
          "## Acceptance Criteria",
          "- [ ] AC1",
        ].join("\n")
      );

      const step = SPRINT_WORKFLOW.find((s) => s.name === "Architecture design")!;
      const subTasks = decomposeTask("architect", step, "my-feature", projectPath, "Original task");

      expect(subTasks.length).toBe(2);
      expect(subTasks[0].description).toContain("Authentication service");
      expect(subTasks[1].description).toContain("User database schema");
    });
  });

  describe("decomposeTask — non-narrowable roles", () => {
    it("should return empty array for PO", () => {
      const step = SPRINT_WORKFLOW.find((s) => s.role === "po")!;
      const subTasks = decomposeTask("po", step, "my-feature", projectPath, "Original task");

      expect(subTasks).toHaveLength(0);
    });

    it("should return empty array for team", () => {
      const step = SPRINT_WORKFLOW.find((s) => s.role === "team")!;
      const subTasks = decomposeTask("team", step, "my-feature", projectPath, "Original task");

      expect(subTasks).toHaveLength(0);
    });
  });

  describe("NarrowingConfig", () => {
    it("should respect enabled=false config", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "my-feature.md"),
        "# Spec\n## Acceptance Criteria\n- [ ] AC1\n- [ ] AC2"
      );

      const config: NarrowingConfig = { enabled: false };
      const step = SPRINT_WORKFLOW.find((s) => s.name === "Implement (TDD)")!;
      const subTasks = decomposeTask("engineer", step, "my-feature", projectPath, "Original task", config);

      expect(subTasks).toHaveLength(0);
    });

    it("should respect disabledSteps config", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "my-feature.md"),
        "# Spec\n## Acceptance Criteria\n- [ ] AC1\n- [ ] AC2"
      );

      const config: NarrowingConfig = { enabled: true, disabledSteps: ["Implement (TDD)"] };
      const step = SPRINT_WORKFLOW.find((s) => s.name === "Implement (TDD)")!;
      const subTasks = decomposeTask("engineer", step, "my-feature", projectPath, "Original task", config);

      expect(subTasks).toHaveLength(0);
    });
  });

  describe("SubTask structure", () => {
    it("should have required fields", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "my-feature.md"),
        "# Spec\n## Acceptance Criteria\n- [ ] First criterion\n- [ ] Second criterion"
      );

      const step = SPRINT_WORKFLOW.find((s) => s.name === "Implement (TDD)")!;
      const subTasks = decomposeTask("engineer", step, "my-feature", projectPath, "Original task");

      expect(subTasks.length).toBeGreaterThanOrEqual(2);
      for (const st of subTasks) {
        expect(st.id).toBeDefined();
        expect(st.description).toBeDefined();
        expect(st.scope).toBeDefined();
        expect(st.description.length).toBeGreaterThan(0);
      }
    });
  });
});
