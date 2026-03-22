import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  getTemplatePath,
  validateTemplate,
  readTemplate,
  generateReadme,
  generateBacklog,
  SCAFFOLD_DIRS,
} from "./template";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-template-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getTemplatePath", () => {
  it("returns override path when provided", () => {
    expect(getTemplatePath("/custom/TEAM.md")).toBe("/custom/TEAM.md");
  });

  it("returns bundled path when override is null", () => {
    const result = getTemplatePath(null);
    expect(result).toContain("template");
    expect(result).toContain("TEAM.md");
  });
});

describe("validateTemplate", () => {
  it("throws when template file does not exist", () => {
    expect(() => validateTemplate("/nonexistent/TEAM.md")).toThrow(/not found/);
  });

  it("throws when template file is empty", () => {
    const emptyPath = path.join(tmpDir, "TEAM.md");
    fs.writeFileSync(emptyPath, "");
    expect(() => validateTemplate(emptyPath)).toThrow(/empty/);
  });

  it("does not throw for valid template", () => {
    const validPath = path.join(tmpDir, "TEAM.md");
    fs.writeFileSync(validPath, "# Agentic Dev Team\n");
    expect(() => validateTemplate(validPath)).not.toThrow();
  });
});

describe("readTemplate", () => {
  it("reads template content", () => {
    const templatePath = path.join(tmpDir, "TEAM.md");
    fs.writeFileSync(templatePath, "# Team Template");
    expect(readTemplate(templatePath)).toBe("# Team Template");
  });
});

describe("generateReadme", () => {
  it("generates readme with project name and description", () => {
    const readme = generateReadme("my-app", "A cool app");
    expect(readme).toContain("# my-app");
    expect(readme).toContain("A cool app");
  });
});

describe("generateBacklog", () => {
  it("generates backlog with empty inbox when no feature ideas", () => {
    const backlog = generateBacklog("A cool app");
    expect(backlog).toContain("## Inbox (unprioritized)");
    expect(backlog).toContain("## Done");
    expect(backlog).not.toContain("source: project bootstrap");
  });

  it("generates backlog with feature ideas in inbox", () => {
    const backlog = generateBacklog("A cool app", [
      "user-login",
      "recipe-search",
    ]);
    expect(backlog).toContain("user-login");
    expect(backlog).toContain("recipe-search");
  });

  it("filters out empty feature ideas", () => {
    const backlog = generateBacklog("An app", ["login", "", "  ", "search"]);
    expect(backlog).toContain("login");
    expect(backlog).toContain("search");
    // Should only have 2 inbox items
    const inboxLines = backlog
      .split("\n")
      .filter((l) => l.startsWith("- ") && l.includes("source: project bootstrap"));
    expect(inboxLines).toHaveLength(2);
  });
});

describe("SCAFFOLD_DIRS", () => {
  it("contains all required directories", () => {
    expect(SCAFFOLD_DIRS).toContain("docs/specs");
    expect(SCAFFOLD_DIRS).toContain("docs/architecture");
    expect(SCAFFOLD_DIRS).toContain("docs/adr");
    expect(SCAFFOLD_DIRS).toContain("docs/demos");
    expect(SCAFFOLD_DIRS).toContain("tests/bdd");
    expect(SCAFFOLD_DIRS).toContain("tests/integration");
    expect(SCAFFOLD_DIRS).toContain("tests/performance");
    expect(SCAFFOLD_DIRS).toContain("tests/e2e");
    expect(SCAFFOLD_DIRS).toContain("tests/e2e/screenshots");
    expect(SCAFFOLD_DIRS).toContain("src");
  });
});
