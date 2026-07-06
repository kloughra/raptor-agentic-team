import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  validateRequiredOutputs,
  resolveExpectedOutputPaths,
} from "../../src/orchestrator";
import { matchExpectedOutput } from "../../src/orchestrator/glob-match";
import { WorkflowStep, SPRINT_WORKFLOW } from "../../src/orchestrator/workflow";

/**
 * Integration tests for expected-outputs glob resolution.
 * Scenarios map 1:1 to tests/bdd/expected-outputs-glob-resolution.feature —
 * validateRequiredOutputs is the production seam under test.
 */
describe("Expected-Outputs Glob Resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-glob-res-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (rel: string, content = "content") => {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  const mkdir = (rel: string) => {
    fs.mkdirSync(path.join(tmpDir, rel), { recursive: true });
  };

  const makeStep = (expectedOutputs: string[]): WorkflowStep => ({
    step: 3,
    role: "qa",
    name: "Write tests",
    description: "Write tests",
    inputArtifacts: [],
    expectedOutputs,
  });

  // ── AC #1 — single-star pattern matches conventional filenames ──────

  it("single-star pattern matches the conventional integration test filename", () => {
    write(
      "tests/integration/expected-outputs-glob-resolution.integration.test.ts"
    );
    const missing = validateRequiredOutputs(
      makeStep(["tests/integration/*"]),
      "expected-outputs-glob-resolution",
      tmpDir
    );
    expect(missing).toEqual([]);
  });

  it("single-star pattern with an extension matches the spec filename", () => {
    write("docs/specs/my-feature.md");
    const missing = validateRequiredOutputs(
      makeStep(["docs/specs/*.md"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toEqual([]);
  });

  // ── AC #2 — double-star pattern matches files at any depth ──────────

  it("double-star pattern matches a file in a subdirectory", () => {
    write("src/orchestrator/foo.ts");
    const missing = validateRequiredOutputs(
      makeStep(["src/**/*.ts"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toEqual([]);
  });

  it("double-star pattern with no matching file is reported missing", () => {
    mkdir("src/orchestrator");
    const missing = validateRequiredOutputs(
      makeStep(["src/**/*.ts"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toContain("src/**/*.ts");
  });

  // ── AC #3 — no-match fails clearly, reporting the ORIGINAL pattern ──

  it("reports the original pattern, not a resolved literal", () => {
    const missing = validateRequiredOutputs(
      makeStep(["tests/integration/*"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toContain("tests/integration/*");
    expect(missing).not.toContain("tests/integration/my-feature");
  });

  it("a truly empty step output never passes", () => {
    const missing = validateRequiredOutputs(
      makeStep(["tests/bdd/*.feature", "tests/integration/*"]),
      "my-feature",
      tmpDir
    );
    expect(missing.length).toBeGreaterThan(0);
  });

  // ── AC #4 — a directory at the literal path does NOT satisfy ────────

  it("a directory at the substituted literal path does not satisfy the pattern", () => {
    mkdir("tests/integration/my-feature"); // the Sprint-8 workaround
    const missing = validateRequiredOutputs(
      makeStep(["tests/integration/*"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toContain("tests/integration/*");
    expect(
      matchExpectedOutput("tests/integration/*", tmpDir, "my-feature").satisfied
    ).toBe(false);
  });

  it("a real file alongside the directory workaround still satisfies", () => {
    mkdir("tests/integration/my-feature");
    write("tests/integration/my-feature.integration.test.ts");
    const missing = validateRequiredOutputs(
      makeStep(["tests/integration/*"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toEqual([]);
  });

  // ── AC #5 — agent guidance matches what validation accepts ──────────

  it("required-output descriptions never contain a bare extensionless literal", () => {
    const descriptions = resolveExpectedOutputPaths(
      ["tests/integration/*"],
      "my-feature"
    );
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toContain("tests/integration/*");
    expect(descriptions[0]).not.toBe("tests/integration/my-feature");
  });

  it("descriptions cover every pattern, including double-star", () => {
    const step = SPRINT_WORKFLOW.find((s) => s.name === "Implement (TDD)")!;
    const descriptions = resolveExpectedOutputPaths(
      step.expectedOutputs,
      "my-feature"
    );
    // Old behavior filtered double-star patterns out entirely; now every
    // pattern gets a description so the agent is told about all requirements.
    expect(descriptions).toHaveLength(step.expectedOutputs.length);
  });

  // ── AC #6 — slug scoping preserved for single-feature isolation ─────

  it("a different feature's file does not satisfy the current feature's pattern", () => {
    write("tests/integration/feature-b.integration.test.ts");
    const missing = validateRequiredOutputs(
      makeStep(["tests/integration/*"]),
      "feature-a",
      tmpDir
    );
    expect(missing).toContain("tests/integration/*");
  });

  // ── AC #7 — exact (wildcard-free) patterns still work ───────────────

  it("exact pattern validates by exact-path existence", () => {
    write("docs/backlog.md");
    const missing = validateRequiredOutputs(
      makeStep(["docs/backlog.md"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toEqual([]);
  });

  it("missing exact pattern is reported", () => {
    const missing = validateRequiredOutputs(
      makeStep(["TEAM.md"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toContain("TEAM.md");
  });

  it("a directory at an exact path does not satisfy the exact pattern", () => {
    mkdir("docs/backlog.md");
    const missing = validateRequiredOutputs(
      makeStep(["docs/backlog.md"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toContain("docs/backlog.md");
  });

  // ── AC #9 / edge cases ───────────────────────────────────────────────

  it("all 13 workflow steps validate with real conventionally-named artifacts", () => {
    const slug = "my-feature";
    write(`docs/specs/${slug}.md`);
    write(`docs/architecture/${slug}.md`);
    write(`tests/bdd/${slug}.feature`);
    write(`tests/integration/${slug}.integration.test.ts`);
    write("src/index.ts");
    write("docs/backlog.md");
    write(`docs/sprints/${slug}.md`);
    write("TEAM.md");

    for (const step of SPRINT_WORKFLOW) {
      if (step.expectedOutputs.length === 0) continue;
      const missing = validateRequiredOutputs(step, slug, tmpDir);
      expect({ step: step.name, missing }).toEqual({
        step: step.name,
        missing: [],
      });
    }
  });

  it("a .gitkeep-only directory does not satisfy a file pattern", () => {
    write("tests/integration/.gitkeep", "");
    const missing = validateRequiredOutputs(
      makeStep(["tests/integration/*"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toContain("tests/integration/*");
  });

  it("hyphenated slug matches without regex metacharacter mis-parsing", () => {
    write("docs/specs/expected-outputs-glob-resolution.md");
    const missing = validateRequiredOutputs(
      makeStep(["docs/specs/*.md"]),
      "expected-outputs-glob-resolution",
      tmpDir
    );
    expect(missing).toEqual([]);
  });

  it("a non-existent base directory is reported missing, not a crash", () => {
    expect(() =>
      validateRequiredOutputs(makeStep(["tests/integration/*"]), "my-feature", tmpDir)
    ).not.toThrow();
    const missing = validateRequiredOutputs(
      makeStep(["tests/integration/*"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toContain("tests/integration/*");
  });

  it("mixed single-star and double-star patterns are evaluated independently", () => {
    write("tests/bdd/my-feature.feature");
    const missing = validateRequiredOutputs(
      makeStep(["tests/bdd/*.feature", "tests/integration/*"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toContain("tests/integration/*");
    expect(missing).not.toContain("tests/bdd/*.feature");
  });

  it("multiple matching files satisfy a pattern with at least one match", () => {
    write("src/a.ts");
    write("src/orchestrator/b.ts");
    const missing = validateRequiredOutputs(
      makeStep(["src/**/*.ts"]),
      "my-feature",
      tmpDir
    );
    expect(missing).toEqual([]);
  });
});
