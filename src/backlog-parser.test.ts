import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseSprintNumber, parseBacklogSections, resolveBacklogPath } from "./backlog-parser";

describe("resolveBacklogPath", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-backlog-resolve-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds docs/backlog.md (lowercase)", () => {
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "backlog.md"), "# Backlog");

    const result = resolveBacklogPath(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.endsWith("backlog.md")).toBe(true);
  });

  it("finds docs/BACKLOG.md (uppercase)", () => {
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "BACKLOG.md"), "# Backlog");

    const result = resolveBacklogPath(tmpDir);
    expect(result).not.toBeNull();
    // On case-sensitive FS this finds the exact file; on macOS both work
    expect(result!.toLowerCase()).toContain("backlog.md");
  });

  it("finds BACKLOG.MD (all caps) in project root", () => {
    fs.writeFileSync(path.join(tmpDir, "BACKLOG.MD"), "# Tasks");

    const result = resolveBacklogPath(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain("backlog.md");
  });

  it("prefers docs/ over project root", () => {
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "backlog.md"), "# Docs Backlog");
    fs.writeFileSync(path.join(tmpDir, "BACKLOG.md"), "# Root Backlog");

    const result = resolveBacklogPath(tmpDir);
    expect(result).not.toBeNull();
    expect(result!).toContain("docs");
  });

  it("returns null when no backlog exists", () => {
    const result = resolveBacklogPath(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for empty project", () => {
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });

    const result = resolveBacklogPath(tmpDir);
    expect(result).toBeNull();
  });

  it("finds Backlog.md (mixed case)", () => {
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "Backlog.md"), "# Backlog");

    const result = resolveBacklogPath(tmpDir);
    expect(result).not.toBeNull();
  });
});

describe("parseSprintNumber", () => {
  it("extracts sprint number from standard header", () => {
    expect(parseSprintNumber("## Sprint 1 — In Progress\n")).toBe(1);
    expect(parseSprintNumber("## Sprint 2 — In Progress\n")).toBe(2);
    expect(parseSprintNumber("## Sprint 12 — In Progress\n")).toBe(12);
  });

  it("returns 0 when no sprint section found", () => {
    expect(parseSprintNumber("# Backlog\n## Inbox\n")).toBe(0);
  });

  it("handles en-dash and hyphen variants", () => {
    expect(parseSprintNumber("## Sprint 3 – In Progress\n")).toBe(3);
    expect(parseSprintNumber("## Sprint 4 - In Progress\n")).toBe(4);
  });

  it("returns 0 for template placeholder {N}", () => {
    expect(parseSprintNumber("## Sprint {N} — In Progress\n")).toBe(0);
  });
});

describe("parseBacklogSections", () => {
  const sampleBacklog = `# Backlog

## Sprint 1 — In Progress
- [ ] user-login: User login flow — assigned to Engineer
- [ ] dashboard: Dashboard widgets — assigned to Engineer

## Ready (prioritized, next sprint)
- recipe-search: Search for recipes

## Inbox (unprioritized)
- notifications: Push notifications — source: user request
- dark-mode: Dark mode theme — source: user request
- export-csv: Export data as CSV — source: user request

## Done
- [x] project-setup: Initial project setup — Sprint 0
`;

  it("parses sprint items", () => {
    const result = parseBacklogSections(sampleBacklog);
    expect(result.sprint.count).toBe(2);
    expect(result.sprint.items[0]).toContain("user-login");
  });

  it("parses ready items", () => {
    const result = parseBacklogSections(sampleBacklog);
    expect(result.ready.count).toBe(1);
    expect(result.ready.items[0]).toContain("recipe-search");
  });

  it("parses inbox items", () => {
    const result = parseBacklogSections(sampleBacklog);
    expect(result.inbox.count).toBe(3);
  });

  it("parses done items", () => {
    const result = parseBacklogSections(sampleBacklog);
    expect(result.done.count).toBe(1);
    expect(result.done.items[0]).toContain("project-setup");
  });

  it("returns zeros for malformed backlog", () => {
    const result = parseBacklogSections("# Not a valid backlog\nrandom text");
    expect(result.inbox.count).toBe(0);
    expect(result.ready.count).toBe(0);
    expect(result.sprint.count).toBe(0);
    expect(result.done.count).toBe(0);
  });

  it("handles empty backlog", () => {
    const result = parseBacklogSections("");
    expect(result.inbox.count).toBe(0);
  });
});
