/**
 * Unit tests for the shared step-13 executor executeRetroApply (Sprint 13,
 * retro-improvements-not-applied).
 *
 * Spec:         docs/specs/retro-improvements-not-applied.md
 * Architecture: docs/architecture/retro-improvements-not-applied.md
 *
 * These cover the two defensive paths the integration file deliberately does
 * not fault-inject (PO test review, Condition A — gates on step-8 acceptance):
 *
 *   A-1 (AC 5 defect signal): applyImprovements claims a placement but returns
 *       byte-identical content → the affected outcomes are downgraded to
 *       "unplaced" with reason "apply reported success but content unchanged".
 *       Mocking retro.ts is acceptable HERE (and only here): the unit under
 *       test is the runner's downgrade logic, not the apply logic.
 *
 *   A-2 (AC 8 commit failure surfaced): a failing git commit is noted in the
 *       report (surfaced in the qualified step result) rather than absorbed by
 *       the retained try/catch, and executeRetroApply still resolves.
 *
 * Injection seams: applyImprovements via jest.mock (default passes through to
 * the real implementation), git via the SimpleGit parameter (a stub object —
 * no real repo needed).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Partial mock: applyImprovements is a jest.fn wrapping the real function so
// only tests that explicitly override it (A-1) diverge from production logic.
jest.mock("./retro", () => {
  const actual = jest.requireActual("./retro") as Record<string, unknown>;
  return {
    ...actual,
    applyImprovements: jest.fn(actual.applyImprovements as (...args: unknown[]) => unknown),
  };
});

import { executeRetroApply } from "./runner";
import { applyImprovements, RetroProposal } from "./retro";
import { createInitialState, SprintState } from "./state";
import { SPRINT_WORKFLOW } from "./workflow";

const applyImprovementsMock = applyImprovements as unknown as jest.Mock;

const SPRINT = 1;
const APPLY_COMMIT_MSG = `[PO] update: apply retrospective improvements from sprint ${SPRINT}`;
const DOWNGRADE_REASON = "apply reported success but content unchanged";

const TEAM_MD = [
  "# Agentic Dev Team",
  "",
  "## Process",
  "Process body text.",
  "",
  "## Roles",
  "Roles body text.",
  "",
].join("\n");

const P_EXACT: RetroProposal = {
  role: "qa",
  section: "Process",
  type: "addition",
  proposal: "Always attach evidence to the PR test report.",
  rationale: "r",
  impact: "i",
};

const P_SECOND: RetroProposal = {
  role: "po",
  section: "Roles",
  type: "addition",
  proposal: "Record acceptance decisions in the sprint log.",
  rationale: "r",
  impact: "i",
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "raptor-retro-unit-"));
  fs.mkdirSync(path.join(tmpDir, "docs", "sprints"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "TEAM.md"), TEAM_MD);
  applyImprovementsMock.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeState(proposals: RetroProposal[], feedback: string): SprintState {
  const state = createInitialState(
    "unit-proj",
    SPRINT,
    SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name })),
    null
  );
  state.retroProposals = proposals;
  state.checkpoints.push({
    type: "retro-review",
    status: "approved",
    feedback,
    resolvedAt: new Date().toISOString(),
    feature: null,
  });
  return state;
}

function fakeGit(opts: { failCommit?: boolean } = {}): {
  git: any;
  commits: string[];
} {
  const commits: string[] = [];
  const git = {
    add: jest.fn(async () => undefined),
    commit: jest.fn(async (message: string) => {
      if (opts.failCommit) {
        throw new Error("simulated commit failure: index.lock exists");
      }
      commits.push(message);
      return undefined;
    }),
  };
  return { git, commits };
}

describe("executeRetroApply — AC 5 defect signal (Condition A-1)", () => {
  it("downgrades claimed placements to 'unplaced' when content is byte-identical", async () => {
    // applyImprovements CLAIMS both placements but returns unchanged bytes —
    // the Sprint 10/12 defect shape, injected at the seam.
    applyImprovementsMock.mockReturnValueOnce({
      content: TEAM_MD,
      changed: false,
      outcomes: [
        { role: "qa", section: "Process", placement: "applied", placedAt: "Process" },
        {
          role: "po",
          section: "Roles",
          placement: "applied-fallback",
          placedAt: "Adopted Retro Improvements (Unplaced)",
        },
      ],
    });

    const state = makeState([P_EXACT, P_SECOND], "1,2");
    const { git, commits } = fakeGit();

    const report = await executeRetroApply(tmpDir, SPRINT, state, git);

    // Outcome-total invariant preserved through the downgrade (AC 1).
    expect(report.outcomes).toHaveLength(2);
    for (const o of report.outcomes) {
      expect(o.placement).toBe("unplaced");
      expect(o.reason).toBe(DOWNGRADE_REASON);
    }
    expect(report.unplaced).toBe(2);
    expect(report.applied).toBe(0);
    expect(report.fallback).toBe(0);
    expect(report.skipped).toBe(false);

    // Nothing changed → no write treated as success, no apply commit (AC 8).
    expect(fs.readFileSync(path.join(tmpDir, "TEAM.md"), "utf-8")).toBe(TEAM_MD);
    expect(commits.filter((m) => m.includes("apply retrospective improvements"))).toHaveLength(0);
  });

  it("all-already-present with unchanged content is the legitimate re-run case, NOT downgraded", async () => {
    applyImprovementsMock.mockReturnValueOnce({
      content: TEAM_MD,
      changed: false,
      outcomes: [
        { role: "qa", section: "Process", placement: "already-present", placedAt: "Process" },
      ],
    });

    const state = makeState([P_EXACT], "1");
    const { git, commits } = fakeGit();

    const report = await executeRetroApply(tmpDir, SPRINT, state, git);

    expect(report.outcomes[0].placement).toBe("already-present");
    expect(report.alreadyPresent).toBe(1);
    expect(report.unplaced).toBe(0);
    expect(commits.filter((m) => m.includes("apply retrospective improvements"))).toHaveLength(0);
  });
});

describe("executeRetroApply — AC 8 commit failure surfaced (Condition A-2)", () => {
  it("notes a failing apply commit in the report instead of silently absorbing it", async () => {
    const state = makeState([P_EXACT], "1");
    const { git } = fakeGit({ failCommit: true });

    // Must resolve — a commit failure never corrupts step flow.
    const report = await executeRetroApply(tmpDir, SPRINT, state, git);

    // The apply itself succeeded (real applyImprovements, exact heading).
    expect(report.outcomes[0].placement).toBe("applied");
    expect(report.applied).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, "TEAM.md"), "utf-8")).toContain(P_EXACT.proposal);

    // The failure is surfaced, not swallowed (`/* non-critical */` is gone).
    expect(report.commitError).toBeDefined();
    expect(report.commitError).toContain("simulated commit failure");
  });
});

describe("executeRetroApply — selection guards (AC 7)", () => {
  it("'skip' feedback: skipped report, no TEAM.md read, no apply attempt", async () => {
    const state = makeState([P_EXACT, P_SECOND], "skip");
    const { git, commits } = fakeGit();

    const report = await executeRetroApply(tmpDir, SPRINT, state, git);

    expect(report.skipped).toBe(true);
    expect(report.outcomes).toEqual([]);
    expect(applyImprovementsMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(tmpDir, "TEAM.md"), "utf-8")).toBe(TEAM_MD);
    expect(commits.filter((m) => m.includes("apply retrospective improvements"))).toHaveLength(0);
  });

  it("out-of-range selection behaves like skip — no fallback writes for never-adopted proposals", async () => {
    const state = makeState([P_EXACT, P_SECOND], "7,9");
    const { git } = fakeGit();

    const report = await executeRetroApply(tmpDir, SPRINT, state, git);

    expect(report.skipped).toBe(true);
    expect(applyImprovementsMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(tmpDir, "TEAM.md"), "utf-8")).toBe(TEAM_MD);
  });
});

describe("executeRetroApply — I/O failure synthesis (AC 1 invariant)", () => {
  it("unreadable TEAM.md → one 'unplaced' outcome per selected proposal, no throw", async () => {
    fs.rmSync(path.join(tmpDir, "TEAM.md"));

    const state = makeState([P_EXACT, P_SECOND], "1,2");
    const { git, commits } = fakeGit();

    const report = await executeRetroApply(tmpDir, SPRINT, state, git);

    expect(report.outcomes).toHaveLength(2);
    for (const o of report.outcomes) {
      expect(o.placement).toBe("unplaced");
      expect(typeof o.reason).toBe("string");
      expect((o.reason as string).length).toBeGreaterThan(0);
    }
    expect(report.unplaced).toBe(2);
    expect(commits.filter((m) => m.includes("apply retrospective improvements"))).toHaveLength(0);
  });
});
