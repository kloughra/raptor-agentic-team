/**
 * Integration tests — blocker-marker-false-positive-in-agent-output (Sprint 15)
 *
 * Spec:         docs/specs/blocker-marker-false-positive-in-agent-output.md (AC 1–9)
 * Architecture: docs/architecture/blocker-marker-false-positive-in-agent-output.md
 *
 * WHAT THIS FEATURE CHANGES: only *what counts as* a [BLOCKER] marker. The
 * escalation mechanics, the [ESCALATE] commit format, the early-return /
 * {kind:"blocker"} contract, the retry/circuit-breaker pipeline, and the
 * SprintState schema are all FROZEN (AC 7 / Out of Scope).
 *
 * PRODUCTION SEAM (TEAM.md QA rule 12 / AC 9): the escalation-behavior tests
 * here drive the REAL `runSprintFromStep` step loop — single-feature AND
 * multi-feature — and inspect the real git log + real sprint state. The runner
 * calls the hardened detector at BOTH seams (runner.ts:1196 single-feature,
 * runner.ts:1951 multi-feature); QA rule 12 requires parity asserted at each
 * seam, not only on the pure function, so both are exercised below.
 *
 * The ONLY mock is `spawnAgent` (sanctioned: so agent steps do not spawn a real
 * `claude` process). Do NOT widen this mock — a mock of the runner loop or of
 * `hasBlockerMarker` itself would silently neuter the regression coverage this
 * file exists for (the Sprint 12 false-escalation specimen).
 *
 * ── RED-VERIFICATION (TEAM.md QA rule 12) ──────────────────────────────────
 * Every constraint-guarding test below is RED against pre-change `main`:
 *   1. The hardened module `src/orchestrator/blocker-marker.ts` does NOT exist
 *      on `main` (marker detection is a private one-liner in runner.ts). The
 *      top-of-file import therefore fails to resolve pre-change → the whole file
 *      is RED at step 3. That is the required state; the Engineer creates the
 *      module + rewires both seams + git-parser in step 5 to turn it green.
 *   2. Behaviorally: the pre-change detector is `/\[blocker\]/i.test(output)`
 *      (anywhere-match). A demo-style output whose ONLY marker is inside a fence
 *      or blockquote makes that regex return TRUE — so pre-change the runner
 *      ESCALATES and `parseBlockers` yields a bogus entry. Each such test is
 *      annotated `RED:` with exactly how it fails against the anywhere-match.
 * Tests tagged [no-regression] are expected to pass both before and after and
 * are not constraint-guarding.
 *
 * Surfaces intentionally NOT covered here:
 *   - Performance bound on a ~1 MB input → tests/performance/*.perf.test.ts.
 *   - No Playwright E2E: this is a non-UI backend detection change (no UI seam).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

// Sanctioned mock: stop agent steps from spawning a real `claude`. Do NOT widen.
jest.mock("../../src/orchestrator/agents", () => {
  const actual = jest.requireActual("../../src/orchestrator/agents") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    spawnAgent: jest.fn(),
  };
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import simpleGit from "simple-git";

// NEW module (RED until the Engineer creates it in step 5):
import { hasBlockerMarker, stripSuppressedLines } from "../../src/orchestrator/blocker-marker";

import { runSprintFromStep } from "../../src/orchestrator/runner";
import { SPRINT_WORKFLOW, Role } from "../../src/orchestrator/workflow";
import {
  createInitialState,
  saveSprintState,
  loadSprintState,
  SprintState,
} from "../../src/orchestrator/state";
import { createFeatureStates, featureBranchName } from "../../src/orchestrator/multi-runner";
import { parseBlockers, parseEscalations, GitLogEntry } from "../../src/git-parser";
import { spawnAgent, AgentResult } from "../../src/orchestrator/agents";

const spawnAgentMock = spawnAgent as jest.MockedFunction<typeof spawnAgent>;

const SPRINT = 1;
const SLUG = "blocker-marker-false-positive-in-agent-output";
const SLUG_A = "feat-alpha";
const SLUG_B = "feat-beta";

// A genuine, line-anchored blocker raise (the shape an agent uses to truly block).
const GENUINE_BLOCKER = "Working on the step.\n[BLOCKER] QA: cannot locate the spec -- blocked on PO\n";

// The Sprint 12 specimen: the ONLY marker occurrence is quoted inside a fenced
// decision-pipeline diagram. Pre-change (anywhere-match) this ESCALATES; the
// hardened detector must treat it as ordinary demo output.
const QUOTED_MARKER_DEMO = [
  "# Sprint Demo — decision pipeline",
  "",
  "The escalation convention is documented below:",
  "",
  "```text",
  "agent output ──► detect marker ──► [BLOCKER] present? ──► [ESCALATE] commit",
  "```",
  "",
  "All acceptance criteria are green.",
].join("\n");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakeHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-blocker-marker-"));
  fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  // Sandbox ~/.raptor (state files, config) — matches the merge/adv-gate harness.
  jest.spyOn(os, "homedir").mockReturnValue(fakeHome);

  spawnAgentMock.mockReset();
  // Default: every agent step "succeeds" with clean output. Individual tests
  // override the output for the role under test.
  spawnAgentMock.mockImplementation(async (): Promise<AgentResult> => ({
    output: "step done",
    exitCode: 0,
  }));
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function workflowSteps() {
  return SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name }));
}

/**
 * Make spawnAgent return a role-specific output. The step-7 role is `qa`
 * (Run test suite) — a convenient agent step with no expectedOutputs and no
 * checkpoint, so a genuine blocker escalates in isolation and a clean output
 * completes the step. Any other role gets clean output.
 */
function planAgentOutputByRole(outputs: Partial<Record<Role, string>>): void {
  spawnAgentMock.mockImplementation(async (role: string): Promise<AgentResult> => ({
    output: outputs[role as Role] ?? "step done",
    exitCode: 0,
  }));
}

/** Create a real git repo with a Raptor-format backlog for the given slugs. */
async function initProject(name: string, slugs: string[]): Promise<string> {
  const projectPath = path.join(tmpDir, name);
  fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
  const items = slugs.map((s) => `- [ ] ${s}: ${s} feature work`).join("\n");
  fs.writeFileSync(
    path.join(projectPath, "docs", "backlog.md"),
    `# Backlog\n\n## Sprint ${SPRINT}\n${items}\n\n## Ready\n\n## Inbox\n\n## Done\n`
  );
  const git = simpleGit(projectPath);
  await git.init();
  await git.addConfig("user.name", "Vex Velociraptor");
  await git.addConfig("user.email", "vex@raptor.test");
  await git.add(".");
  await git.commit("[PO] add: sprint backlog");
  return projectPath;
}

/** Seed a single-feature sprint parked at `fromStep` (earlier steps complete). */
function seedSingleFeatureState(projectSlug: string, fromStep: number): SprintState {
  const state = createInitialState(
    projectSlug,
    SPRINT,
    workflowSteps(),
    featureBranchName(SPRINT, SLUG)
  );
  for (const s of state.steps) {
    if (s.step < fromStep) {
      s.status = "complete";
      s.completedAt = "2026-07-07T00:00:00.000Z";
      s.attempts = 1;
    }
  }
  state.currentStep = fromStep;
  saveSprintState(projectSlug, SPRINT, state);
  return state;
}

/** Seed a multi-feature sprint with both features parked at `fromStep`. */
function seedMultiFeatureState(projectSlug: string, fromStep: number): SprintState {
  const state = createInitialState(projectSlug, SPRINT, workflowSteps(), null);
  state.features = createFeatureStates([SLUG_A, SLUG_B], SPRINT);
  for (const f of state.features) {
    for (const s of f.steps) {
      if (s.step < fromStep) {
        s.status = "complete";
        s.completedAt = "2026-07-07T00:00:00.000Z";
        s.attempts = 1;
      }
    }
    f.status = "in-progress";
    f.currentStep = fromStep;
  }
  state.currentStep = fromStep;
  saveSprintState(projectSlug, SPRINT, state);
  return state;
}

async function gitSubjects(projectPath: string): Promise<string[]> {
  const log = await simpleGit(projectPath).log();
  return log.all.map((l) => l.message);
}

const step = (state: SprintState, n: number) => state.steps.find((s) => s.step === n)!;

// ===========================================================================
// hasBlockerMarker — API-contract invariants (architecture "Contract invariants")
// Each constraint-guarding case carries a RED note vs the pre-change
// anywhere-match `/\[blocker\]/i.test(output)`.
// ===========================================================================

describe("hasBlockerMarker: genuine markers (AC 1, AC 5)", () => {
  it("[no-regression] a line-anchored marker at the start of output is a blocker", () => {
    expect(hasBlockerMarker("[BLOCKER] QA: cannot find spec")).toBe(true);
  });

  it("[no-regression] a line-anchored marker with trailing text is a blocker (edge case)", () => {
    expect(hasBlockerMarker("intro\n[BLOCKER] QA: cannot find spec\nmore")).toBe(true);
  });

  it("[no-regression] a marker indented with spaces/tab (not fenced/quoted) is a blocker (edge case)", () => {
    expect(hasBlockerMarker("    [BLOCKER] engineer: build broke")).toBe(true);
    expect(hasBlockerMarker("\t[BLOCKER] engineer: build broke")).toBe(true);
  });

  it("[no-regression] case-insensitive line-anchored markers all match (AC 5)", () => {
    expect(hasBlockerMarker("[BLOCKER] qa: x")).toBe(true);
    expect(hasBlockerMarker("[blocker] qa: x")).toBe(true);
    expect(hasBlockerMarker("[Blocker] qa: x")).toBe(true);
  });

  it("[no-regression] CRLF and LF line-anchoring produce identical results (edge case)", () => {
    expect(hasBlockerMarker("first line\r\n[BLOCKER] qa: x\r\nlast")).toBe(true);
    expect(hasBlockerMarker("first line\n[BLOCKER] qa: x\nlast")).toBe(true);
  });
});

describe("hasBlockerMarker: suppressed / non-genuine markers (AC 1, 2, 3)", () => {
  it("a marker mid-sentence in prose is NOT a blocker (AC 1)", () => {
    // RED: pre-change `/\[blocker\]/i.test(...)` matches the embedded marker → true.
    expect(
      hasBlockerMarker("...if the agent writes [BLOCKER] then it escalates...")
    ).toBe(false);
  });

  it("a marker only inside a ``` fence is NOT a blocker (AC 2)", () => {
    // RED: anywhere-match sees the fenced marker and returns true.
    const output = "docs:\n```\n[BLOCKER] qa: example inside a fence\n```\ndone";
    expect(hasBlockerMarker(output)).toBe(false);
  });

  it("a marker only inside a ~~~ fence is NOT a blocker (AC 2)", () => {
    // RED: anywhere-match returns true; hardened detector honors ~~~ fences too.
    const output = "docs:\n~~~\n[BLOCKER] qa: example inside a tilde fence\n~~~\ndone";
    expect(hasBlockerMarker(output)).toBe(false);
  });

  it("the Sprint 12 demo specimen (fenced diagram) is NOT a blocker (AC 2, AC 8)", () => {
    // RED: this is the literal live incident — the fenced decision-pipeline
    // diagram contains [BLOCKER]; the anywhere-match escalates. Hardened → false.
    expect(hasBlockerMarker(QUOTED_MARKER_DEMO)).toBe(false);
  });

  it("a marker inside a Markdown blockquote is NOT a blocker (AC 3)", () => {
    // RED: anywhere-match returns true; blockquote lines must be suppressed.
    expect(hasBlockerMarker("> [BLOCKER] qa: quoted example\nall good")).toBe(false);
  });
});

describe("hasBlockerMarker: conservative-bias edge cases", () => {
  it("multiple markers where at least one is a genuine line-anchored raise → true (edge case)", () => {
    const output = [
      "```",
      "[BLOCKER] qa: fenced example",
      "```",
      "[BLOCKER] engineer: the build actually broke",
    ].join("\n");
    expect(hasBlockerMarker(output)).toBe(true);
  });

  it("an unclosed fence suppresses the remainder conservatively → false (edge case)", () => {
    // RED: anywhere-match returns true. Conservative bias: an opened-but-never-
    // closed fence treats the rest of the output as inside the fence.
    const output = "opening a fence:\n```\n[BLOCKER] qa: swallowed by the open fence";
    expect(hasBlockerMarker(output)).toBe(false);
  });

  it("[no-regression] empty / whitespace-only / marker-free output → false", () => {
    expect(hasBlockerMarker("")).toBe(false);
    expect(hasBlockerMarker("   \n\t\n")).toBe(false);
    expect(hasBlockerMarker("everything is fine, all tests pass")).toBe(false);
  });

  it("[no-regression] never throws on untrusted / adversarial input (reliability NFR)", () => {
    const inputs = [
      " binary-ish",
      "```".repeat(10000),
      ">".repeat(5000),
      "no marker here".repeat(10000),
    ];
    for (const input of inputs) {
      expect(() => hasBlockerMarker(input)).not.toThrow();
      expect(typeof hasBlockerMarker(input)).toBe("boolean");
    }
  });
});

describe("stripSuppressedLines: shared suppression primitive", () => {
  it("removes fenced-code lines (including delimiters) and blockquote lines", () => {
    const text = [
      "keep this",
      "```",
      "drop fenced",
      "```",
      "> drop quoted",
      "keep that",
    ].join("\n");
    const stripped = stripSuppressedLines(text);
    expect(stripped).toContain("keep this");
    expect(stripped).toContain("keep that");
    expect(stripped).not.toContain("drop fenced");
    expect(stripped).not.toContain("drop quoted");
    expect(stripped).not.toContain("```");
  });

  it("leaves ordinary text untouched so a later ^-anchored match still works", () => {
    const text = "line one\n[BLOCKER] qa: real\nline three";
    expect(stripSuppressedLines(text)).toContain("[BLOCKER] qa: real");
  });
});

// ===========================================================================
// PRODUCTION SEAM — single-feature runner (AC 4, AC 9)
// ===========================================================================

describe("single-feature seam: quoted marker does NOT escalate (AC 9)", () => {
  it("a demo-style fenced marker at step 7 proceeds instead of escalating", async () => {
    // RED: pre-change the anywhere-match `hasBlockerMarker` fires on the fenced
    // marker → the runner commits [ESCALATE] and returns status "escalated" at
    // step 7. Hardened → step 7 completes; the sprint advances to the step-8
    // demo checkpoint. Proven RED by reverting the detector to the one-liner.
    const projectSlug = "sf-quoted";
    const projectPath = await initProject(projectSlug, [SLUG]);
    seedSingleFeatureState(projectSlug, 7);
    planAgentOutputByRole({ qa: QUOTED_MARKER_DEMO });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 7);

    // No blocker escalation happened for step 7.
    expect(result.status).not.toBe("escalated");
    expect(result.state.status).not.toBe("escalated");
    expect(step(result.state, 7).status).toBe("complete");

    // No [ESCALATE] commit was produced.
    const subjects = await gitSubjects(projectPath);
    expect(subjects.some((m) => m.includes("[ESCALATE]"))).toBe(false);

    // Persisted state agrees (persist-before-yield).
    expect(step(loadSprintState(projectSlug, SPRINT)!, 7).status).toBe("complete");
  });
});

describe("single-feature seam: genuine blocker still escalates (AC 4, AC 9)", () => {
  it("a line-anchored [BLOCKER] at step 7 escalates exactly as today", async () => {
    // RED-companion to the quoted case: proves the hardened detector did not
    // simply disable escalation. A genuine raise MUST still escalate.
    const projectSlug = "sf-genuine";
    const projectPath = await initProject(projectSlug, [SLUG]);
    seedSingleFeatureState(projectSlug, 7);
    planAgentOutputByRole({ qa: GENUINE_BLOCKER });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 7);

    // Escalation mechanics unchanged (AC 4, AC 7).
    expect(result.status).toBe("escalated");
    expect(result.state.status).toBe("escalated");
    const s7 = step(result.state, 7);
    expect(s7.status).toBe("escalated");
    expect(s7.failures.length).toBeGreaterThanOrEqual(1);

    // The [ESCALATE] commit carries the frozen format (mentions the step + BLOCKER).
    const subjects = await gitSubjects(projectPath);
    expect(
      subjects.some((m) => m.includes("[ESCALATE]") && m.includes("[BLOCKER]"))
    ).toBe(true);

    // The demo step never ran — escalation is an early return.
    expect(spawnAgentMock.mock.calls.some((c) => c[0] === ("team" as Role))).toBe(false);

    // Persisted escalated state (resumable).
    expect(loadSprintState(projectSlug, SPRINT)!.status).toBe("escalated");
  });
});

// ===========================================================================
// PRODUCTION SEAM — multi-feature dispatcher (AC 4, AC 9) — parity at seam #2
// ===========================================================================

describe("multi-feature seam: parity with the single-feature seam (QA rule 12)", () => {
  it("a quoted marker does NOT escalate any feature at step 7 (AC 9)", async () => {
    // RED: pre-change both features' step-7 outputs trip the anywhere-match →
    // each escalates via the {kind:"blocker"} path and the sprint parks
    // escalated. Hardened → no feature escalates for a blocker.
    const projectSlug = "mf-quoted";
    const projectPath = await initProject(projectSlug, [SLUG_A, SLUG_B]);
    seedMultiFeatureState(projectSlug, 7);
    planAgentOutputByRole({ qa: QUOTED_MARKER_DEMO });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 7);

    for (const f of result.state.features!) {
      const s7 = f.steps.find((s) => s.step === 7)!;
      expect(s7.status).not.toBe("escalated");
    }
    const subjects = await gitSubjects(projectPath);
    expect(subjects.some((m) => m.includes("[ESCALATE]"))).toBe(false);
  });

  it("a genuine line-anchored blocker escalates the feature at step 7 (AC 4, AC 9)", async () => {
    // RED-companion: hardened detector must keep the second seam's escalation
    // path working — {kind:"blocker"} → feature escalated → sprint parks.
    const projectSlug = "mf-genuine";
    const projectPath = await initProject(projectSlug, [SLUG_A, SLUG_B]);
    seedMultiFeatureState(projectSlug, 7);
    planAgentOutputByRole({ qa: GENUINE_BLOCKER });

    const result = await runSprintFromStep(projectPath, projectSlug, SPRINT, 7);

    // Every feature escalated on the genuine blocker; the sprint parks escalated.
    for (const f of result.state.features!) {
      expect(f.status).toBe("escalated");
    }
    expect(result.state.status).toBe("escalated");

    // At least one [ESCALATE] commit names a feature (frozen multi-feature format).
    const subjects = await gitSubjects(projectPath);
    expect(
      subjects.some(
        (m) => m.includes("[ESCALATE]") && (m.includes(SLUG_A) || m.includes(SLUG_B))
      )
    ).toBe(true);
  });
});

// ===========================================================================
// git-parser commit-message hardening (AC 6)
// ===========================================================================

const logEntry = (message: string): GitLogEntry => ({
  hash: "abc1234",
  date: "2026-07-07",
  message,
});

describe("git-parser: commit-message quoting weakness (AC 6)", () => {
  it("does not parse a blocker whose grammar is quoted only inside a fenced body", () => {
    // RED: pre-change `parseBlockers` matches the marker anywhere in the message,
    // so the fenced example yields a bogus blocker entry.
    const message = [
      "[HANDOFF] PO -> QA: spec for widget",
      "",
      "Documented the convention:",
      "```",
      "[BLOCKER] QA: cannot find spec -- blocked on PO",
      "```",
    ].join("\n");
    expect(parseBlockers([logEntry(message)])).toHaveLength(0);
  });

  it("does not parse a blocker whose grammar is quoted in a blockquote body", () => {
    // RED: anywhere-match yields a bogus entry from the blockquoted example.
    const message = [
      "[HANDOFF] PO -> QA: spec for widget",
      "",
      "> [BLOCKER] QA: cannot find spec -- blocked on PO",
    ].join("\n");
    expect(parseBlockers([logEntry(message)])).toHaveLength(0);
  });

  it("reads the orchestrator's own escalation commit as one escalation, zero blockers", () => {
    // RED: the real Sprint 15 specimen. The orchestrator commits
    // `[ESCALATE] ... — agent raised [BLOCKER]: ...` (runner.ts:1213). Pre-change
    // `parseBlockers` mis-reads the embedded mid-line [BLOCKER] as a blocker when
    // the truncated output completes the `-- blocked on X` grammar.
    const message =
      "[ESCALATE] QA: step 7 (Run test suite) — agent raised [BLOCKER]: QA: cannot find spec -- blocked on PO";
    expect(parseBlockers([logEntry(message)])).toHaveLength(0);
    expect(parseEscalations([logEntry(message)])).toHaveLength(1);
  });

  it("[no-regression] still parses a genuine line-anchored blocker commit (AC 6)", () => {
    const message = "[BLOCKER] QA: cannot find spec -- blocked on PO";
    const blockers = parseBlockers([logEntry(message)]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].role).toBe("QA");
    expect(blockers[0].blockedOn).toBe("PO");
  });

  it("[no-regression] still parses a genuine line-anchored escalation commit (AC 6)", () => {
    const message = "[ESCALATE] Architect: design blocked pending user decision";
    const escalations = parseEscalations([logEntry(message)]);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].role).toBe("Architect");
  });
});
