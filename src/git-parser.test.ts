import { describe, it, expect } from "@jest/globals";
import { parseBlockers, parseEscalations, GitLogEntry } from "./git-parser";

describe("parseBlockers", () => {
  it("parses a standard blocker commit", () => {
    const entries: GitLogEntry[] = [
      {
        hash: "abc1234",
        date: "2026-03-21T14:30:00Z",
        message:
          "[BLOCKER] Engineer: unclear validation rules for email field -- blocked on PO",
      },
    ];
    const blockers = parseBlockers(entries);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].role).toBe("Engineer");
    expect(blockers[0].description).toContain("unclear validation rules");
    expect(blockers[0].blockedOn).toBe("PO");
    expect(blockers[0].commit).toBe("abc1234");
  });

  it("returns empty array for non-blocker commits", () => {
    const entries: GitLogEntry[] = [
      { hash: "def5678", date: "2026-03-21", message: "[ENGINEER] fix: something" },
    ];
    expect(parseBlockers(entries)).toEqual([]);
  });

  it("parses multiple blockers", () => {
    const entries: GitLogEntry[] = [
      {
        hash: "a",
        date: "2026-03-21",
        message: "[BLOCKER] QA: missing test data -- blocked on Engineer",
      },
      {
        hash: "b",
        date: "2026-03-22",
        message: "[BLOCKER] Engineer: unclear spec -- blocked on PO",
      },
    ];
    expect(parseBlockers(entries)).toHaveLength(2);
  });
});

describe("parseEscalations", () => {
  it("parses a standard escalation commit", () => {
    const entries: GitLogEntry[] = [
      {
        hash: "esc123",
        date: "2026-03-21",
        message:
          "[ESCALATE] QA: test suite fails 3 times — requesting user intervention. Summary: flaky E2E",
      },
    ];
    const escalations = parseEscalations(entries);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].role).toBe("QA");
  });

  it("returns empty array for non-escalation commits", () => {
    const entries: GitLogEntry[] = [
      { hash: "x", date: "2026-03-21", message: "[ENGINEER] add: feature" },
    ];
    expect(parseEscalations(entries)).toEqual([]);
  });
});
