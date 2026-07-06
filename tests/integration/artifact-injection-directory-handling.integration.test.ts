import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  resolveArtifacts,
  buildRequiredReadingSection,
  ArtifactRequirement,
} from "../../src/orchestrator/artifact-injection";

/**
 * Integration tests for artifact-injection directory handling.
 * Scenarios map 1:1 to tests/bdd/artifact-injection-directory-handling.feature —
 * resolveArtifacts is the production seam under test.
 *
 * Background: the "Review tests" step requires the Feature Specification
 * (docs/specs/{slug}.md) and BDD Scenarios (tests/bdd/{slug}.feature).
 */
describe("Artifact-Injection Directory Handling", () => {
  let tmpDir: string;
  const SLUG = "my-feature";
  const STEP = "Review tests";
  const SPEC_PATH = `docs/specs/${SLUG}.md`;
  const BDD_PATH = `tests/bdd/${SLUG}.feature`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-artifact-dir-"));
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

  const paths = (result: { artifacts: { path: string }[] }) =>
    result.artifacts.map((a) => a.path);

  // ── AC #1, #3 — required directory-path artifact: no throw, reported missing ──

  it("required artifact resolving to a directory never throws and is reported missing", () => {
    mkdir(SPEC_PATH); // a DIRECTORY at docs/specs/my-feature.md
    write(BDD_PATH, "Feature: x");

    let result!: ReturnType<typeof resolveArtifacts>;
    expect(() => {
      result = resolveArtifacts(STEP, SLUG, tmpDir);
    }).not.toThrow();

    // Well-formed result shape
    expect(result).toEqual(
      expect.objectContaining({
        artifacts: expect.any(Array),
        missing: expect.any(Array),
        checklist: expect.any(String),
        section: expect.any(String),
      })
    );
    expect(paths(result)).not.toContain(SPEC_PATH);
    expect(result.missing).toContain(SPEC_PATH);
  });

  // ── AC #1, #2, #4 — optional directory-path artifact is silently skipped ──

  it("optional artifact resolving to a directory is skipped without throwing", () => {
    const optional: ArtifactRequirement[] = [
      {
        pattern: "tests/integration/{slug}.integration.test.ts",
        label: "Integration Tests",
        required: false,
      },
    ];
    mkdir(`tests/integration/${SLUG}.integration.test.ts`); // directory, not file
    write(SPEC_PATH, "# Spec");
    write(BDD_PATH, "Feature: x");

    const result = resolveArtifacts(STEP, SLUG, tmpDir, optional);
    expect(paths(result)).not.toContain(
      `tests/integration/${SLUG}.integration.test.ts`
    );
    expect(result.missing).not.toContain(
      `tests/integration/${SLUG}.integration.test.ts`
    );
  });

  // ── AC #5 — a real file is read exactly as before (no regression) ──

  it("required artifact resolving to a regular file is injected with its content", () => {
    write(SPEC_PATH, "# Spec body");
    write(BDD_PATH, "Feature: x");

    const result = resolveArtifacts(STEP, SLUG, tmpDir);
    const spec = result.artifacts.find((a) => a.path === SPEC_PATH);
    expect(spec).toBeDefined();
    expect(spec!.content).toBe("# Spec body");
    expect(result.missing).not.toContain(SPEC_PATH);
  });

  it("regular-file content is capped at the configured size", () => {
    write(SPEC_PATH, "x".repeat(500));
    write(BDD_PATH, "Feature: x");

    const result = resolveArtifacts(STEP, SLUG, tmpDir, undefined, 100);
    const spec = result.artifacts.find((a) => a.path === SPEC_PATH);
    expect(spec).toBeDefined();
    expect(spec!.content.length).toBeLessThanOrEqual(100);
  });

  // ── AC #7 — failure isolated to the offending requirement ──

  it("a directory at one path does not block other real-file artifacts", () => {
    mkdir(SPEC_PATH); // directory
    write(BDD_PATH, "Feature: real content");

    let result!: ReturnType<typeof resolveArtifacts>;
    expect(() => {
      result = resolveArtifacts(STEP, SLUG, tmpDir);
    }).not.toThrow();
    expect(paths(result)).toContain(BDD_PATH);
    expect(result.missing).toContain(SPEC_PATH);
  });

  // ── AC #6 — injected section/checklist well-formed after skipping ──

  it("Required Reading section renders only real-file artifacts", () => {
    mkdir(SPEC_PATH); // directory — Feature Specification label must not render
    write(BDD_PATH, "Feature: x");

    const result = resolveArtifacts(STEP, SLUG, tmpDir);
    const section = buildRequiredReadingSection(result);
    expect(section).toContain("BDD Scenarios");
    expect(section).not.toContain("Feature Specification");
    // No broken entries: every rendered artifact has label + source line
    for (const artifact of result.artifacts) {
      expect(section).toContain(`### ${artifact.label}`);
      expect(section).toContain(`*Source: ${artifact.path}*`);
    }
  });

  it("section and checklist are empty when every artifact resolved to a directory", () => {
    mkdir(SPEC_PATH);
    mkdir(BDD_PATH);

    const result = resolveArtifacts(STEP, SLUG, tmpDir);
    expect(result.artifacts).toEqual([]);
    expect(result.section).toBe("");
    expect(result.checklist).toBe("");
  });

  // ── Edge cases ──

  it("a directory containing only .gitkeep is treated as not-a-file and not recursed into", () => {
    mkdir(SPEC_PATH);
    write(path.join(SPEC_PATH, ".gitkeep"), "");
    write(BDD_PATH, "Feature: x");

    const result = resolveArtifacts(STEP, SLUG, tmpDir);
    expect(paths(result)).not.toContain(SPEC_PATH);
    expect(result.missing).toContain(SPEC_PATH);
    // No artifact was fabricated from the directory's children
    expect(
      result.artifacts.some((a) => a.path.includes(".gitkeep"))
    ).toBe(false);
  });

  it("a symlink pointing at a directory is treated as a directory", () => {
    mkdir("real-dir");
    write(BDD_PATH, "Feature: x");
    fs.mkdirSync(path.join(tmpDir, "docs/specs"), { recursive: true });
    fs.symlinkSync(path.join(tmpDir, "real-dir"), path.join(tmpDir, SPEC_PATH));

    const result = resolveArtifacts(STEP, SLUG, tmpDir);
    expect(paths(result)).not.toContain(SPEC_PATH);
    expect(result.missing).toContain(SPEC_PATH);
  });

  it("a symlink pointing at a file is read as a regular file", () => {
    write("real-file.md", "# Linked spec");
    write(BDD_PATH, "Feature: x");
    fs.mkdirSync(path.join(tmpDir, "docs/specs"), { recursive: true });
    fs.symlinkSync(path.join(tmpDir, "real-file.md"), path.join(tmpDir, SPEC_PATH));

    const result = resolveArtifacts(STEP, SLUG, tmpDir);
    const spec = result.artifacts.find((a) => a.path === SPEC_PATH);
    expect(spec).toBeDefined();
    expect(spec!.content).toBe("# Linked spec");
    expect(result.missing).not.toContain(SPEC_PATH);
  });

  it("a custom requirement pointing at a directory is handled by the same gate", () => {
    write(SPEC_PATH, "# Spec");
    write(BDD_PATH, "Feature: x");
    const custom: ArtifactRequirement[] = [
      { pattern: "docs/custom/{slug}.md", label: "Custom Doc", required: true },
    ];
    mkdir(`docs/custom/${SLUG}.md`); // directory at the custom path

    let result!: ReturnType<typeof resolveArtifacts>;
    expect(() => {
      result = resolveArtifacts(STEP, SLUG, tmpDir, custom);
    }).not.toThrow();
    expect(paths(result)).not.toContain(`docs/custom/${SLUG}.md`);
    expect(result.missing).toContain(`docs/custom/${SLUG}.md`);
  });

  it("a hyphenated feature slug resolves and stats identically", () => {
    const slug = "artifact-injection-directory-handling";
    write(`docs/specs/${slug}.md`, "# Spec");
    write(`tests/bdd/${slug}.feature`, "Feature: x");

    let result!: ReturnType<typeof resolveArtifacts>;
    expect(() => {
      result = resolveArtifacts(STEP, slug, tmpDir);
    }).not.toThrow();
    expect(paths(result)).toContain(`docs/specs/${slug}.md`);
  });

  // ── AC #8 — absent artifacts behave as before (regression guards) ──

  it("a genuinely absent required artifact is reported missing without throwing", () => {
    write(BDD_PATH, "Feature: x");
    // docs/specs/my-feature.md does not exist at all

    let result!: ReturnType<typeof resolveArtifacts>;
    expect(() => {
      result = resolveArtifacts(STEP, SLUG, tmpDir);
    }).not.toThrow();
    expect(result.missing).toContain(SPEC_PATH);
  });

  it("a genuinely absent optional artifact is silently skipped", () => {
    write(SPEC_PATH, "# Spec");
    write(BDD_PATH, "Feature: x");
    const optional: ArtifactRequirement[] = [
      {
        pattern: "tests/integration/{slug}.integration.test.ts",
        label: "Integration Tests",
        required: false,
      },
    ];

    const result = resolveArtifacts(STEP, SLUG, tmpDir, optional);
    expect(result.missing).not.toContain(
      `tests/integration/${SLUG}.integration.test.ts`
    );
    expect(paths(result)).not.toContain(
      `tests/integration/${SLUG}.integration.test.ts`
    );
  });
});
