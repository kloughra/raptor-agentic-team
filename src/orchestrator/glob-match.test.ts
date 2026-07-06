import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  classifyPattern,
  matchExpectedOutput,
  describeRequiredOutput,
} from "./glob-match";

/**
 * Unit tests for the expected-outputs glob matcher.
 * Scenario names map to tests/bdd/expected-outputs-glob-resolution.feature.
 */
describe("glob-match", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-glob-match-"));
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

  // ── Pattern classification (matcher internal contract) ──────────────

  describe("classifyPattern", () => {
    it("classifies exact patterns as exact", () => {
      expect(classifyPattern("docs/backlog.md")).toBe("exact");
      expect(classifyPattern("TEAM.md")).toBe("exact");
    });

    it("classifies single-star patterns as single-star", () => {
      expect(classifyPattern("tests/integration/*")).toBe("single-star");
      expect(classifyPattern("docs/specs/*.md")).toBe("single-star");
    });

    it("classifies double-star patterns as double-star", () => {
      expect(classifyPattern("src/**/*.ts")).toBe("double-star");
    });
  });

  // ── AC #1 — single-star matches conventional filenames ──────────────

  describe("matchExpectedOutput: single-star", () => {
    it("matches the conventional integration test filename", () => {
      write(
        "tests/integration/expected-outputs-glob-resolution.integration.test.ts"
      );
      const result = matchExpectedOutput(
        "tests/integration/*",
        tmpDir,
        "expected-outputs-glob-resolution"
      );
      expect(result.satisfied).toBe(true);
      expect(result.matchedFiles).toContain(
        "tests/integration/expected-outputs-glob-resolution.integration.test.ts"
      );
    });

    it("matches a slug-named spec file with an extension pattern", () => {
      write("docs/specs/my-feature.md");
      const result = matchExpectedOutput("docs/specs/*.md", tmpDir, "my-feature");
      expect(result.satisfied).toBe(true);
      expect(result.matchedFiles).toEqual(["docs/specs/my-feature.md"]);
    });

    // AC #6 — slug scoping preserved for single-feature isolation
    it("does not match a different feature's file", () => {
      write("tests/integration/feature-b.integration.test.ts");
      const result = matchExpectedOutput(
        "tests/integration/*",
        tmpDir,
        "feature-a"
      );
      expect(result.satisfied).toBe(false);
      expect(result.matchedFiles).toEqual([]);
    });

    // Edge case — hyphenated slug treated literally, no regex mis-parsing
    it("matches a hyphenated slug without metacharacter mis-parsing", () => {
      write("docs/specs/expected-outputs-glob-resolution.md");
      const result = matchExpectedOutput(
        "docs/specs/*.md",
        tmpDir,
        "expected-outputs-glob-resolution"
      );
      expect(result.satisfied).toBe(true);
    });
  });

  // ── AC #2 — double-star matches files at any depth ───────────────────

  describe("matchExpectedOutput: double-star", () => {
    it("matches a file in a subdirectory", () => {
      write("src/orchestrator/foo.ts");
      const result = matchExpectedOutput("src/**/*.ts", tmpDir, "my-feature");
      expect(result.satisfied).toBe(true);
      expect(result.matchedFiles).toContain("src/orchestrator/foo.ts");
    });

    it("reports missing when no file matches", () => {
      mkdir("src/orchestrator"); // dir exists but no .ts file
      const result = matchExpectedOutput("src/**/*.ts", tmpDir, "my-feature");
      expect(result.satisfied).toBe(false);
    });

    it("does not require slug association", () => {
      write("src/orchestrator/unrelated-name.ts");
      const result = matchExpectedOutput("src/**/*.ts", tmpDir, "my-feature");
      expect(result.satisfied).toBe(true);
    });

    // Edge case — multiple matching files satisfy the pattern
    it("returns all matching files when several match", () => {
      write("src/a.ts");
      write("src/orchestrator/b.ts");
      const result = matchExpectedOutput("src/**/*.ts", tmpDir, "my-feature");
      expect(result.satisfied).toBe(true);
      expect(result.matchedFiles).toEqual(
        expect.arrayContaining(["src/a.ts", "src/orchestrator/b.ts"])
      );
    });
  });

  // ── AC #4 — a directory at the literal path never satisfies ─────────

  describe("matchExpectedOutput: directories never satisfy file patterns", () => {
    it("a directory at the substituted literal path does not satisfy", () => {
      mkdir("tests/integration/my-feature"); // the Sprint-8 workaround
      const result = matchExpectedOutput(
        "tests/integration/*",
        tmpDir,
        "my-feature"
      );
      expect(result.satisfied).toBe(false);
    });

    it("a real file alongside the directory workaround still satisfies", () => {
      mkdir("tests/integration/my-feature");
      write("tests/integration/my-feature.integration.test.ts");
      const result = matchExpectedOutput(
        "tests/integration/*",
        tmpDir,
        "my-feature"
      );
      expect(result.satisfied).toBe(true);
      expect(result.matchedFiles).toContain(
        "tests/integration/my-feature.integration.test.ts"
      );
    });

    // Edge case — .gitkeep never counts
    it("a .gitkeep-only directory does not satisfy a file pattern", () => {
      write("tests/integration/.gitkeep", "");
      const result = matchExpectedOutput(
        "tests/integration/*",
        tmpDir,
        "my-feature"
      );
      expect(result.satisfied).toBe(false);
    });
  });

  // ── AC #7 — exact (wildcard-free) patterns ───────────────────────────

  describe("matchExpectedOutput: exact patterns", () => {
    it("validates by exact-path existence", () => {
      write("docs/backlog.md");
      const result = matchExpectedOutput("docs/backlog.md", tmpDir, "my-feature");
      expect(result.satisfied).toBe(true);
      expect(result.matchedFiles).toEqual(["docs/backlog.md"]);
    });

    it("reports a missing exact path", () => {
      const result = matchExpectedOutput("TEAM.md", tmpDir, "my-feature");
      expect(result.satisfied).toBe(false);
    });

    it("a directory at an exact path does not satisfy", () => {
      mkdir("docs/backlog.md"); // pathological: directory named like the file
      const result = matchExpectedOutput("docs/backlog.md", tmpDir, "my-feature");
      expect(result.satisfied).toBe(false);
    });
  });

  // ── Edge cases — no-crash, missing base dir, original-pattern report ─

  describe("matchExpectedOutput: robustness", () => {
    it("a non-existent base directory yields no match, not a crash", () => {
      const result = matchExpectedOutput(
        "tests/integration/*",
        tmpDir,
        "my-feature"
      );
      expect(result.satisfied).toBe(false);
      expect(result.matchedFiles).toEqual([]);
    });

    it("always reports the original pattern verbatim", () => {
      const result = matchExpectedOutput(
        "tests/integration/*",
        tmpDir,
        "my-feature"
      );
      expect(result.pattern).toBe("tests/integration/*");
    });

    it("prunes node_modules from traversal", () => {
      write("src/node_modules/dep/index.ts");
      const result = matchExpectedOutput("src/**/*.ts", tmpDir, "my-feature");
      expect(result.satisfied).toBe(false);
    });
  });

  // ── AC #5 — agent guidance matches what validation accepts ──────────

  describe("describeRequiredOutput", () => {
    it("never emits an extensionless literal path for a bare-star pattern", () => {
      const desc = describeRequiredOutput("tests/integration/*", "my-feature");
      expect(desc).toContain("tests/integration/*");
      expect(desc).not.toBe("tests/integration/my-feature");
      // The old bug: instructing the agent to create the extensionless literal.
      expect(desc).not.toMatch(/tests\/integration\/my-feature(\s|$)/);
    });

    it("names the exact file for an exact pattern", () => {
      const desc = describeRequiredOutput("docs/backlog.md", "my-feature");
      expect(desc).toContain("docs/backlog.md");
    });

    it("gives a slug-scoped example for extension patterns", () => {
      const desc = describeRequiredOutput("docs/specs/*.md", "my-feature");
      expect(desc).toContain("docs/specs/*.md");
      expect(desc).toContain("docs/specs/my-feature.md");
    });

    it("tells the agent a directory does not count", () => {
      const desc = describeRequiredOutput("tests/integration/*", "my-feature");
      expect(desc.toLowerCase()).toContain("not a directory");
    });
  });
});
