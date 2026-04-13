import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  resolveArtifacts,
  buildRequiredReadingSection,
  STEP_ARTIFACT_REQUIREMENTS,
  ArtifactRequirement,
} from "../../src/orchestrator/artifact-injection";

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-rbw-"));
  return dir;
}

function cleanupDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("Read-Before-Write Enforcement", () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = createTempProject();
  });

  afterEach(() => {
    cleanupDir(projectPath);
  });

  describe("STEP_ARTIFACT_REQUIREMENTS", () => {
    it("should define requirements for Architecture design step", () => {
      const reqs = STEP_ARTIFACT_REQUIREMENTS["Architecture design"];
      expect(reqs).toBeDefined();
      expect(reqs.some((r) => r.label.toLowerCase().includes("spec"))).toBe(true);
    });

    it("should define requirements for Write tests step", () => {
      const reqs = STEP_ARTIFACT_REQUIREMENTS["Write tests"];
      expect(reqs).toBeDefined();
      expect(reqs.some((r) => r.label.toLowerCase().includes("spec"))).toBe(true);
      expect(reqs.some((r) => r.label.toLowerCase().includes("architecture"))).toBe(true);
    });

    it("should define requirements for Implement (TDD) step", () => {
      const reqs = STEP_ARTIFACT_REQUIREMENTS["Implement (TDD)"];
      expect(reqs).toBeDefined();
      expect(reqs.length).toBeGreaterThanOrEqual(3); // spec, arch, tests
    });

    it("should not define requirements for Open PR", () => {
      const reqs = STEP_ARTIFACT_REQUIREMENTS["Open PR"];
      expect(reqs === undefined || reqs.length === 0).toBe(true);
    });
  });

  describe("resolveArtifacts", () => {
    it("should resolve all artifacts when files exist", () => {
      // Create the expected artifact files
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.mkdirSync(path.join(projectPath, "docs", "architecture"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "my-feature.md"),
        "# My Feature Spec\n## Acceptance Criteria\n- [ ] AC1"
      );
      fs.writeFileSync(
        path.join(projectPath, "docs", "architecture", "my-feature.md"),
        "# My Feature Architecture\n## Components"
      );

      const result = resolveArtifacts("Architecture design", "my-feature", projectPath);

      // Architect only needs spec
      expect(result.artifacts.length).toBeGreaterThanOrEqual(1);
      expect(result.missing).toHaveLength(0);
      expect(result.artifacts[0].content).toContain("My Feature Spec");
    });

    it("should report missing required artifacts", () => {
      // Don't create any files
      const result = resolveArtifacts("Write tests", "my-feature", projectPath);

      expect(result.missing.length).toBeGreaterThan(0);
      expect(result.missing.some((m) => m.includes("specs"))).toBe(true);
    });

    it("should load artifact content from disk", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "my-feature.md"),
        "# Spec Content\nDetailed requirements here."
      );

      const result = resolveArtifacts("Architecture design", "my-feature", projectPath);

      const specArtifact = result.artifacts.find((a) => a.label.toLowerCase().includes("spec"));
      expect(specArtifact).toBeDefined();
      expect(specArtifact!.content).toContain("Detailed requirements here");
    });

    it("should cap artifact content at max size", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      const largeSpec = "# Spec\n" + "x".repeat(50000);
      fs.writeFileSync(path.join(projectPath, "docs", "specs", "my-feature.md"), largeSpec);

      const result = resolveArtifacts("Architecture design", "my-feature", projectPath, undefined, 5000);

      const specArtifact = result.artifacts.find((a) => a.label.toLowerCase().includes("spec"));
      expect(specArtifact).toBeDefined();
      expect(specArtifact!.content.length).toBeLessThanOrEqual(5000);
    });

    it("should return empty results for steps without requirements", () => {
      const result = resolveArtifacts("Open PR", "my-feature", projectPath);

      expect(result.artifacts).toHaveLength(0);
      expect(result.missing).toHaveLength(0);
    });

    it("should resolve artifacts per feature slug in multi-feature sprints", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "feature-a.md"),
        "# Feature A"
      );
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "feature-b.md"),
        "# Feature B"
      );

      const resultA = resolveArtifacts("Architecture design", "feature-a", projectPath);
      const resultB = resolveArtifacts("Architecture design", "feature-b", projectPath);

      const specA = resultA.artifacts.find((a) => a.label.toLowerCase().includes("spec"));
      const specB = resultB.artifacts.find((a) => a.label.toLowerCase().includes("spec"));
      expect(specA?.content).toContain("Feature A");
      expect(specB?.content).toContain("Feature B");
    });

    it("should accept custom requirements", () => {
      fs.writeFileSync(path.join(projectPath, "api-spec.yaml"), "openapi: 3.0.0");
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.writeFileSync(path.join(projectPath, "docs", "specs", "my-feature.md"), "# Spec");

      const custom: ArtifactRequirement[] = [
        { pattern: "api-spec.yaml", label: "API Specification", required: true },
      ];

      const result = resolveArtifacts("Architecture design", "my-feature", projectPath, custom);

      const apiSpec = result.artifacts.find((a) => a.label === "API Specification");
      expect(apiSpec).toBeDefined();
      expect(apiSpec!.content).toContain("openapi");
    });
  });

  describe("buildRequiredReadingSection", () => {
    it("should produce a Required Reading section with artifact content", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.mkdirSync(path.join(projectPath, "docs", "architecture"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "my-feature.md"),
        "# Spec\n## Acceptance Criteria\n- [ ] It works"
      );
      fs.writeFileSync(
        path.join(projectPath, "docs", "architecture", "my-feature.md"),
        "# Architecture\n## Components\n- Module A"
      );

      const result = resolveArtifacts("Write tests", "my-feature", projectPath);
      const section = buildRequiredReadingSection(result);

      expect(section).toContain("## Required Reading");
      expect(section).toContain("## Pre-Generation Checklist");
      expect(section).toContain("It works");
      expect(section).toContain("Module A");
    });

    it("should include a checklist item for each artifact", () => {
      fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "docs", "specs", "my-feature.md"),
        "# Spec"
      );

      const result = resolveArtifacts("Architecture design", "my-feature", projectPath);
      const section = buildRequiredReadingSection(result);

      expect(section).toContain("- [ ]");
      // Should have at least one checklist item
      const checklistItems = section.match(/- \[ \]/g);
      expect(checklistItems).not.toBeNull();
      expect(checklistItems!.length).toBeGreaterThanOrEqual(1);
    });

    it("should return empty string when no artifacts are required", () => {
      const result = resolveArtifacts("Open PR", "my-feature", projectPath);
      const section = buildRequiredReadingSection(result);

      expect(section).toBe("");
    });
  });
});
