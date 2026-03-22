import { describe, it, expect } from "@jest/globals";
import { parseSprintNumber, parseBacklogSections } from "./backlog-parser";

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
