/**
 * Integration tests for: retro-improvements-not-applied
 *
 * Spec:         docs/specs/retro-improvements-not-applied.md
 * Architecture: docs/architecture/retro-improvements-not-applied.md
 *
 * TDD note: these tests are written BEFORE the implementation (step 3 of the
 * sprint workflow). They pin the post-fix contract and are EXPECTED TO FAIL
 * against the pre-change code — that is the point (TEAM.md QA rule 12: a
 * constraint-guarding test must fail against the pre-change code path). In
 * particular, the AC 9 regression suite reproduces the exact Sprint 10/12
 * silent-drop shape at a runner production seam and asserts it can no longer
 * occur.
 *
 * Production seams exercised (do NOT weaken these into unit tests of the pure
 * function — TEAM.md forbids satisfying parity/constraint requirements solely
 * with helper-function unit tests):
 *   1. Single-feature step-13 path:   runSprintFromStep(projectPath, slug, 1, 13)
 *   2. Multi-feature step-13 path:    runSprintFromStep(...) with state.features
 *      seeded → runApplyRetroImprovementsShared
 * plus the redesigned pure apply/report API in src/orchestrator/retro.ts.
 *
 * The new retro.ts API (outcome-returning applyImprovements, sprint param,
 * updateRetroDocWithAppliedChanges) does not exist pre-fix, so it is accessed
 * via an untyped require — the file compiles against pre-fix code and the
 * assertions go red, which is the correct TDD signal. Do NOT replace these
 * with `it.skip`-when-absent probes: the silent-drop regression must FAIL, not
 * skip, until fixed.
 *
 * No mocking of retro.ts or runner.ts internals — the two runner seams and the
 * real bundled template/TEAM.md content ARE the regression coverage. Only
 * os.homedir() is redirected (via the jest os-shim) so sprint state lands in a
 * temp dir instead of the real ~/.raptor.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import simpleGit from "simple-git";

import { runSprintFromStep } from "../../src/orchestrator/runner";
import {
  createInitialState,
  saveSprintState,
  SprintState,
} from "../../src/orchestrator/state";
import { createFeatureStates } from "../../src/orchestrator/multi-runner";
import { SPRINT_WORKFLOW } from "../../src/orchestrator/workflow";
import {
  generateRetroDocument,
  RetroProposal,
} from "../../src/orchestrator/retro";

// The post-fix retro API (ApplyImprovementsResult, sprint param,
// updateRetroDocWithAppliedChanges) — untyped so this file compiles pre-fix.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const retroApi: any = require("../../src/orchestrator/retro");

const TEMPLATE_PATH = path.join(__dirname, "../../template/TEAM.md");
const SPRINT = 1;
const FALLBACK_HEADING = "## Adopted Retro Improvements (Unplaced)";
const FALLBACK_PLACED_AT = "Adopted Retro Improvements (Unplaced)";
const APPLY_COMMIT_MSG = `[PO] update: apply retrospective improvements from sprint ${SPRINT}`;

// ─── Proposal fixtures ──────────────────────────────────────────────────────
// AC 9 shape: a Section that references NO real heading, so it must fall back.
// NOTE (Sprint 15, retro-section-matching-rarely-hits-target): the original
// "Product Owner responsibilities" now CORRECTLY resolves to "### Product Owner
// (PO)" under the new segment-and-match resolver (token-identical to the Sprint
// 14 live incident). To keep this fixture's no-false-positive / fallback intent
// under the new resolver, its section is repointed to plausible-but-inexact
// prose whose whole-word tokens contain no real heading's core token sequence
// ([product, ownership, duties, during, intake] — "ownership" ≠ "owner").
const P_INEXACT_PO: RetroProposal = {
  role: "po",
  section: "Product ownership duties during intake",
  type: "addition",
  proposal: "Record spec-review outcomes in the sprint log before handoff.",
  rationale: "Sprint 10 and 12 adopted proposals were silently dropped.",
  impact: "Adopted process improvements actually take effect.",
};

// Exact heading in the bundled template: "### QA Engineer".
const P_EXACT_QA: RetroProposal = {
  role: "qa",
  section: "QA Engineer",
  type: "addition",
  proposal: "Document test-data setup assumptions inside every BDD scenario.",
  rationale: "Engineers had to guess test data formats.",
  impact: "Less implementation ambiguity.",
};

// "## Linked Spec" exists in the bundled template ONLY inside the fenced
// PR Description Template code block — must be non-matchable post-fix.
const P_FENCED_ONLY: RetroProposal = {
  role: "architect",
  section: "Linked Spec",
  type: "modification",
  proposal: "Link the architecture doc alongside the spec in every PR.",
  rationale: "Reviewers had to hunt for the design doc.",
  impact: "Faster PR review.",
};

// ─── Environment: temp home so ~/.raptor never gets touched ────────────────
let tmpHome: string;
let homedirSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "raptor-retro-apply-"));
  homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  homedirSpy.mockRestore();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ─── Fixture helpers ────────────────────────────────────────────────────────

/**
 * Create a real git-backed project using the REAL bundled TEAM.md template
 * (AC 9 requires real template content, not a synthetic stand-in).
 */
async function createProjectFixture(
  name: string,
  featureSlugs: string[] = ["alpha-feature"]
): Promise<string> {
  const projectPath = path.join(tmpHome, "projects", name);
  fs.mkdirSync(path.join(projectPath, "docs", "sprints"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, "docs", "specs"), { recursive: true });
  fs.copyFileSync(TEMPLATE_PATH, path.join(projectPath, "TEAM.md"));

  const items = featureSlugs
    .map((slug) => `- [ ] ${slug}: description of ${slug}`)
    .join("\n");
  fs.writeFileSync(
    path.join(projectPath, "docs", "backlog.md"),
    `# Backlog\n\n## Sprint ${SPRINT} — In Progress\n${items}\n\n## Ready (prioritized, next sprint)\n\n## Inbox (unprioritized)\n\n## Done\n`
  );

  const git = simpleGit(projectPath);
  await git.init();
  await git.addConfig("user.name", "QA Vex");
  await git.addConfig("user.email", "qa@raptor.test");
  await git.addConfig("commit.gpgsign", "false");
  await git.add(".");
  await git.commit("[PO] add: initial scaffold");
  return projectPath;
}

/**
 * Seed sprint state with steps 1–12 complete, an approved retro-review
 * checkpoint carrying the user's selection feedback, and stored proposals —
 * so runSprintFromStep(..., 13) executes ONLY the orchestrator-managed step 13
 * (no subagents are ever spawned).
 */
function seedStateAtStep13(
  projectSlug: string,
  proposals: RetroProposal[],
  feedback: string,
  opts: { multiFeatureSlugs?: string[] } = {}
): SprintState {
  const state = createInitialState(
    projectSlug,
    SPRINT,
    SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name })),
    null
  );
  const now = new Date().toISOString();
  for (const step of state.steps) {
    if (step.step <= 12) {
      step.status = "complete";
      step.completedAt = now;
      step.attempts = 1;
    }
  }
  state.currentStep = 13;
  state.retroProposals = proposals;
  state.checkpoints.push({
    type: "retro-review",
    status: "approved",
    feedback,
    resolvedAt: now,
    feature: null,
  });

  if (opts.multiFeatureSlugs) {
    const features = createFeatureStates(opts.multiFeatureSlugs, SPRINT);
    for (const f of features) {
      f.status = "complete";
      f.currentStep = 10;
      for (const s of f.steps) {
        s.status = "complete";
        s.completedAt = now;
        s.attempts = 1;
      }
    }
    state.features = features;
  } else {
    state.branchName = `sprint-${SPRINT}/alpha-feature`;
  }

  saveSprintState(projectSlug, SPRINT, state);
  return state;
}

/** Write a real retro doc via the production generator (AC 3 fixture). */
function writeRetroDoc(projectPath: string, projectSlug: string, proposals: RetroProposal[]): string {
  const doc = generateRetroDocument(
    projectSlug,
    SPRINT,
    proposals,
    proposals.map((p) => p.role)
  );
  const retroPath = path.join(projectPath, "docs", "sprints", `sprint-${SPRINT}-retro.md`);
  fs.writeFileSync(retroPath, doc);
  return retroPath;
}

/** Read the persisted sprint state raw from disk (asserts persistence, not memory). */
function readRawState(projectSlug: string): any {
  const statePath = path.join(tmpHome, ".raptor", projectSlug, `sprint-${SPRINT}.json`);
  return JSON.parse(fs.readFileSync(statePath, "utf-8"));
}

function readTeamMd(projectPath: string): string {
  return fs.readFileSync(path.join(projectPath, "TEAM.md"), "utf-8");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function applyCommitCount(projectPath: string): Promise<number> {
  const log = await simpleGit(projectPath).log();
  return log.all.filter((c) => c.message.includes("apply retrospective improvements")).length;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Pure apply/report contract — applyImprovements(content, proposals, sprint)
//    (AC 1, AC 2, matching + fence + multi-match + idempotency edge cases)
// ═══════════════════════════════════════════════════════════════════════════

describe("applyImprovements — outcome-returning contract (AC 1, AC 2)", () => {
  let templateTeamMd: string;

  beforeEach(() => {
    templateTeamMd = fs.readFileSync(TEMPLATE_PATH, "utf-8");
  });

  it("returns exactly one outcome per input proposal, in the same order (AC 1 invariant)", () => {
    const proposals = [P_INEXACT_PO, P_EXACT_QA, P_FENCED_ONLY];
    const result = retroApi.applyImprovements(templateTeamMd, proposals, SPRINT);

    expect(result.outcomes).toHaveLength(proposals.length);
    expect(result.outcomes.map((o: any) => o.role)).toEqual(["po", "qa", "architect"]);
    expect(result.outcomes.map((o: any) => o.section)).toEqual(
      proposals.map((p) => p.section)
    );
    for (const o of result.outcomes) {
      expect(["applied", "applied-fallback", "already-present", "unplaced"]).toContain(
        o.placement
      );
    }
  });

  it("applies an exact-heading proposal at its target section and records placedAt", () => {
    const result = retroApi.applyImprovements(templateTeamMd, [P_EXACT_QA], SPRINT);

    expect(result.outcomes[0].placement).toBe("applied");
    expect(result.outcomes[0].placedAt).toContain("QA Engineer");
    expect(result.changed).toBe(true);
    expect(result.content).toContain(P_EXACT_QA.proposal);
    // Inserted inside the QA Engineer section, before the next role heading.
    const insertIdx = result.content.indexOf(P_EXACT_QA.proposal);
    expect(insertIdx).toBeGreaterThan(result.content.indexOf("### QA Engineer"));
    expect(insertIdx).toBeLessThan(result.content.indexOf("### Architect"));
  });

  it("a section miss falls back — never dropped (AC 2, the Sprint 10/12 defect)", () => {
    const result = retroApi.applyImprovements(templateTeamMd, [P_INEXACT_PO], SPRINT);

    expect(result.changed).toBe(true);
    expect(result.outcomes[0].placement).toBe("applied-fallback");
    expect(result.outcomes[0].placedAt).toBe(FALLBACK_PLACED_AT);
    expect(result.content).toContain(FALLBACK_HEADING);
    expect(result.content).toContain(P_INEXACT_PO.proposal);
    // Attribution: sprint + role + verbatim target section (AC 2 / Open Q 3).
    const fallbackBlock = result.content.slice(result.content.indexOf(FALLBACK_HEADING));
    expect(fallbackBlock).toContain(P_INEXACT_PO.proposal);
    expect(fallbackBlock).toMatch(/Sprint 1/);
    expect(fallbackBlock).toMatch(/PO/i);
    expect(fallbackBlock).toContain("Product ownership duties during intake");
  });

  it("normalization tolerates case, extra whitespace, and echoed leading hashes", () => {
    for (const sectionVariant of ["### qa engineer", "  QA   Engineer  ", "QA ENGINEER"]) {
      const result = retroApi.applyImprovements(
        templateTeamMd,
        [{ ...P_EXACT_QA, section: sectionVariant }],
        SPRINT
      );
      expect(result.outcomes[0].placement).toBe("applied");
    }
  });

  it("deliberately does NOT fuzzy-match: inexact Section lands at fallback, never at a surprising section", () => {
    const result = retroApi.applyImprovements(templateTeamMd, [P_INEXACT_PO], SPRINT);

    expect(result.outcomes[0].placement).toBe("applied-fallback");
    // Not inserted anywhere inside the real "### Product Owner (PO)" section.
    const poStart = result.content.indexOf("### Product Owner (PO)");
    const qaStart = result.content.indexOf("### QA Engineer");
    const poSection = result.content.slice(poStart, qaStart);
    expect(poSection).not.toContain(P_INEXACT_PO.proposal);
  });

  it("headings inside fenced code blocks are non-matchable (Edge: fences)", () => {
    // "## Linked Spec" exists only inside the PR Description Template fence.
    expect(templateTeamMd).toContain("## Linked Spec");
    const result = retroApi.applyImprovements(templateTeamMd, [P_FENCED_ONLY], SPRINT);

    expect(result.outcomes[0].placement).toBe("applied-fallback");
    // The improvement appears exactly once — in the fallback section, not
    // spliced into the fenced PR template.
    expect(countOccurrences(result.content, P_FENCED_ONLY.proposal)).toBe(1);
    expect(result.content.indexOf(P_FENCED_ONLY.proposal)).toBeGreaterThan(
      result.content.indexOf(FALLBACK_HEADING)
    );
  });

  it("fenced headings do not terminate the enclosing section early (fence-aware findSectionEnd)", () => {
    const synthetic = [
      "# Doc",
      "",
      "## Target Section",
      "Some text.",
      "```",
      "## Fenced Heading",
      "fence body",
      "```",
      "Trailing text still inside Target Section.",
      "",
      "## Next Section",
      "Other text.",
      "",
    ].join("\n");
    const proposal: RetroProposal = {
      ...P_EXACT_QA,
      section: "Target Section",
      proposal: "FENCE-AWARE-INSERTION-MARKER",
    };
    const result = retroApi.applyImprovements(synthetic, [proposal], SPRINT);

    expect(result.outcomes[0].placement).toBe("applied");
    const insertIdx = result.content.indexOf("FENCE-AWARE-INSERTION-MARKER");
    const fenceClose = result.content.indexOf("```", result.content.indexOf("```") + 3);
    const nextSection = result.content.indexOf("## Next Section");
    // Inserted at the TRUE section end: after the closing fence, before Next Section.
    expect(insertIdx).toBeGreaterThan(fenceClose);
    expect(insertIdx).toBeLessThan(nextSection);
  });

  it("first match wins on duplicate headings, and the recorded placedAt is the first (Edge: multi-match)", () => {
    const synthetic = [
      "# Doc",
      "",
      "## Duplicate",
      "First occurrence body.",
      "",
      "## Middle",
      "middle body",
      "",
      "## Duplicate",
      "Second occurrence body.",
      "",
    ].join("\n");
    const proposal: RetroProposal = {
      ...P_EXACT_QA,
      section: "Duplicate",
      proposal: "MULTI-MATCH-MARKER",
    };
    const result = retroApi.applyImprovements(synthetic, [proposal], SPRINT);

    expect(result.outcomes[0].placement).toBe("applied");
    expect(result.outcomes[0].placedAt).toContain("Duplicate");
    const insertIdx = result.content.indexOf("MULTI-MATCH-MARKER");
    expect(insertIdx).toBeGreaterThan(result.content.indexOf("## Duplicate"));
    expect(insertIdx).toBeLessThan(result.content.indexOf("## Middle"));
  });

  it("is idempotent: a second pass records already-present, changed=false, no duplicate text", () => {
    const first = retroApi.applyImprovements(
      templateTeamMd,
      [P_EXACT_QA, P_INEXACT_PO],
      SPRINT
    );
    expect(first.changed).toBe(true);

    const second = retroApi.applyImprovements(
      first.content,
      [P_EXACT_QA, P_INEXACT_PO],
      SPRINT
    );
    expect(second.outcomes).toHaveLength(2);
    expect(second.outcomes.every((o: any) => o.placement === "already-present")).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
    expect(countOccurrences(second.content, P_EXACT_QA.proposal)).toBe(1);
    expect(countOccurrences(second.content, P_INEXACT_PO.proposal)).toBe(1);
  });

  it("empty proposal list → empty outcomes, unchanged content", () => {
    const result = retroApi.applyImprovements(templateTeamMd, [], SPRINT);
    expect(result.outcomes).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(templateTeamMd);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. updateRetroDocWithAppliedChanges — retro doc reporting (AC 3)
// ═══════════════════════════════════════════════════════════════════════════

describe("updateRetroDocWithAppliedChanges (AC 3)", () => {
  it("replaces the '(None yet)' stub with one line per outcome", () => {
    const doc = generateRetroDocument("proj", SPRINT, [P_EXACT_QA, P_INEXACT_PO], ["qa", "po"]);
    expect(doc).toContain("## Applied Changes\n(None yet)");

    const outcomes = [
      { role: "qa", section: "QA Engineer", placement: "applied", placedAt: "QA Engineer" },
      {
        role: "po",
        section: "Product Owner responsibilities",
        placement: "applied-fallback",
        placedAt: FALLBACK_PLACED_AT,
      },
    ];
    const updated = retroApi.updateRetroDocWithAppliedChanges(doc, outcomes);

    expect(updated).not.toContain("(None yet)");
    const appliedSection = updated.slice(updated.indexOf("## Applied Changes"));
    expect(appliedSection).toContain("QA Engineer");
    expect(appliedSection).toMatch(/fallback/i);
    expect(appliedSection).toContain("Product Owner responsibilities");
  });

  it("renders unplaced outcomes with their reason", () => {
    const doc = generateRetroDocument("proj", SPRINT, [P_EXACT_QA], ["qa"]);
    const updated = retroApi.updateRetroDocWithAppliedChanges(doc, [
      {
        role: "qa",
        section: "QA Engineer",
        placement: "unplaced",
        reason: "EISDIR: illegal operation on a directory",
      },
    ]);
    const appliedSection = updated.slice(updated.indexOf("## Applied Changes"));
    expect(appliedSection).toMatch(/NOT APPLIED/i);
    expect(appliedSection).toContain("EISDIR");
  });

  it("returns input unchanged when the stub is absent (re-run / hand-edited doc)", () => {
    const handEdited = "# Sprint 1 Retrospective\n\n## Applied Changes\n- QA proposal → applied\n";
    const updated = retroApi.updateRetroDocWithAppliedChanges(handEdited, [
      { role: "qa", section: "QA Engineer", placement: "applied", placedAt: "QA Engineer" },
    ]);
    expect(updated).toBe(handEdited);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Single-feature runner seam — runSprintFromStep(..., 13)
//    (AC 9 regression + ACs 1–5, 7, 8 + edge cases at the production seam)
// ═══════════════════════════════════════════════════════════════════════════

describe("single-feature step 13 production seam", () => {
  it("AC 9 REGRESSION: the Sprint 10/12 silent-drop shape can no longer occur", async () => {
    // Live-incident shape: selection parses, decisions recorded, Section values
    // plausible-but-inexact, real bundled-template TEAM.md — pre-fix outcome
    // was: TEAM.md byte-identical + step complete + zero record. This test
    // FAILS against pre-fix code by construction.
    const slug = "sf-ac9";
    const projectPath = await createProjectFixture(slug);
    const before = readTeamMd(projectPath);
    seedStateAtStep13(slug, [P_INEXACT_PO, P_FENCED_ONLY], "1,2");
    writeRetroDoc(projectPath, slug, [P_INEXACT_PO, P_FENCED_ONLY]);

    const result = await runSprintFromStep(projectPath, slug, SPRINT, 13);

    // The step (and sprint) completes — fallback, not escalation (PO decision).
    expect(result.status).toBe("complete");
    const after = readTeamMd(projectPath);
    // The pre-fix behavior — unchanged TEAM.md — must be impossible now.
    expect(after).not.toBe(before);
    expect(after).toContain(P_INEXACT_PO.proposal);
    expect(after).toContain(P_FENCED_ONLY.proposal);
    expect(after).toContain(FALLBACK_HEADING);

    // No silent drop: every adopted proposal has a recorded outcome (AC 1),
    // persisted to the state file before the step completed.
    const raw = readRawState(slug);
    expect(raw.retroApply).toBeDefined();
    expect(raw.retroApply.outcomes).toHaveLength(2);
    for (const o of raw.retroApply.outcomes) {
      expect(o.placement).toBe("applied-fallback");
    }

    // Step result reflects reality (AC 4): qualified, not a bare success.
    expect(result.message ?? "").toMatch(/retro improvements/i);
    expect(result.message ?? "").toMatch(/fallback/i);
  });

  it("mixed outcomes: applied + fallback each recorded individually; commit + retro doc updated (AC 1, 3, 4, 8)", async () => {
    const slug = "sf-mixed";
    const projectPath = await createProjectFixture(slug);
    seedStateAtStep13(slug, [P_EXACT_QA, P_INEXACT_PO], "1,2");
    const retroPath = writeRetroDoc(projectPath, slug, [P_EXACT_QA, P_INEXACT_PO]);

    const result = await runSprintFromStep(projectPath, slug, SPRINT, 13);
    expect(result.status).toBe("complete");

    const raw = readRawState(slug);
    expect(raw.retroApply.outcomes).toHaveLength(2);
    expect(raw.retroApply.outcomes[0].placement).toBe("applied");
    expect(raw.retroApply.outcomes[0].placedAt).toContain("QA Engineer");
    expect(raw.retroApply.outcomes[1].placement).toBe("applied-fallback");
    expect(raw.retroApply.applied).toBe(1);
    expect(raw.retroApply.fallback).toBe(1);
    expect(raw.retroApply.unplaced).toBe(0);

    // AC 8: committed with the unchanged message format.
    const log = await simpleGit(projectPath).log();
    expect(log.all.some((c) => c.message.includes(APPLY_COMMIT_MSG))).toBe(true);

    // AC 3: the retro doc's Applied Changes stub is gone, outcomes recorded.
    const retroDoc = fs.readFileSync(retroPath, "utf-8");
    expect(retroDoc).not.toContain("(None yet)");
    const appliedSection = retroDoc.slice(retroDoc.indexOf("## Applied Changes"));
    expect(appliedSection).toMatch(/fallback/i);

    // AC 4: qualified completion with per-outcome accounting.
    expect(result.message ?? "").toMatch(/retro improvements/i);
  });

  it("AC 7: 'skip' feedback leaves TEAM.md byte-identical — no fallback writes, no apply commit", async () => {
    const slug = "sf-skip";
    const projectPath = await createProjectFixture(slug);
    const before = readTeamMd(projectPath);
    seedStateAtStep13(slug, [P_EXACT_QA, P_INEXACT_PO], "skip");
    writeRetroDoc(projectPath, slug, [P_EXACT_QA, P_INEXACT_PO]);

    const result = await runSprintFromStep(projectPath, slug, SPRINT, 13);

    expect(result.status).toBe("complete");
    const after = readTeamMd(projectPath);
    expect(after).toBe(before);
    expect(after).not.toContain(FALLBACK_HEADING);
    expect(await applyCommitCount(projectPath)).toBe(0);
    const raw = readRawState(slug);
    expect(raw.steps[12].status).toBe("complete");
  });

  it("AC 7 edge: selection indices entirely out of range behave like skip", async () => {
    const slug = "sf-oor";
    const projectPath = await createProjectFixture(slug);
    const before = readTeamMd(projectPath);
    seedStateAtStep13(slug, [P_EXACT_QA, P_INEXACT_PO], "7,9");
    writeRetroDoc(projectPath, slug, [P_EXACT_QA, P_INEXACT_PO]);

    const result = await runSprintFromStep(projectPath, slug, SPRINT, 13);

    expect(result.status).toBe("complete");
    expect(readTeamMd(projectPath)).toBe(before);
    expect(await applyCommitCount(projectPath)).toBe(0);
  });

  it("AC 1 HARDEST PIN: TEAM.md unreadable → outcomes still total the selection, all unplaced, no throw", async () => {
    const slug = "sf-io-fail";
    const projectPath = await createProjectFixture(slug);
    seedStateAtStep13(slug, [P_EXACT_QA, P_INEXACT_PO], "1,2");
    writeRetroDoc(projectPath, slug, [P_EXACT_QA, P_INEXACT_PO]);

    // Make TEAM.md unreadable as a file: replace it with a directory (EISDIR).
    const teamMdPath = path.join(projectPath, "TEAM.md");
    fs.rmSync(teamMdPath);
    fs.mkdirSync(teamMdPath);

    // Errors-returned-not-thrown: the runner must not reject (pre-fix it throws).
    const result = await runSprintFromStep(projectPath, slug, SPRINT, 13);

    // Outcome-total invariant on the I/O failure path — the contract to pin
    // hardest: outcomes.length === selected proposals.length, every path.
    const raw = readRawState(slug);
    expect(raw.retroApply).toBeDefined();
    expect(raw.retroApply.outcomes).toHaveLength(2);
    for (const o of raw.retroApply.outcomes) {
      expect(o.placement).toBe("unplaced");
      expect(typeof o.reason).toBe("string");
      expect(o.reason.length).toBeGreaterThan(0);
    }
    expect(raw.retroApply.unplaced).toBe(2);

    // Step still completes (qualified) — circuit breaker untouched (Out of Scope).
    expect(raw.steps[12].status).toBe("complete");
    expect(result.message ?? "").toMatch(/NOT applied/i);

    // AC 8: nothing was applied → no apply commit.
    expect(await applyCommitCount(projectPath)).toBe(0);
  });

  it("idempotent re-run (Edge: resume at step 13): no double-append, no second commit, already-present outcomes (AC 5, 8)", async () => {
    const slug = "sf-rerun";
    const projectPath = await createProjectFixture(slug);
    seedStateAtStep13(slug, [P_EXACT_QA, P_INEXACT_PO], "1,2");
    writeRetroDoc(projectPath, slug, [P_EXACT_QA, P_INEXACT_PO]);

    const first = await runSprintFromStep(projectPath, slug, SPRINT, 13);
    expect(first.status).toBe("complete");
    const afterFirst = readTeamMd(projectPath);
    const commitsAfterFirst = await applyCommitCount(projectPath);
    expect(commitsAfterFirst).toBe(1);

    // Simulate a resume that re-executes step 13 (precedent: Sprint 8).
    const raw = readRawState(slug);
    raw.steps[12].status = "pending";
    raw.steps[12].completedAt = null;
    raw.status = "in-progress";
    fs.writeFileSync(
      path.join(tmpHome, ".raptor", slug, `sprint-${SPRINT}.json`),
      JSON.stringify(raw, null, 2)
    );

    const second = await runSprintFromStep(projectPath, slug, SPRINT, 13);
    expect(second.status).toBe("complete");

    // Content-based idempotency: byte-identical, each block exactly once.
    const afterSecond = readTeamMd(projectPath);
    expect(afterSecond).toBe(afterFirst);
    expect(countOccurrences(afterSecond, P_EXACT_QA.proposal)).toBe(1);
    expect(countOccurrences(afterSecond, P_INEXACT_PO.proposal)).toBe(1);

    // AC 5: all-already-present + unchanged is the legitimate re-run case,
    // recorded as such — NOT downgraded to unplaced.
    const rerunState = readRawState(slug);
    expect(rerunState.retroApply.outcomes).toHaveLength(2);
    expect(
      rerunState.retroApply.outcomes.every((o: any) => o.placement === "already-present")
    ).toBe(true);
    expect(rerunState.retroApply.unplaced).toBe(0);

    // AC 8: nothing changed on re-run → no empty commit attempted.
    expect(await applyCommitCount(projectPath)).toBe(1);
  });

  it("retro document missing on disk: apply + outcome recording still function (Edge: graceful degradation)", async () => {
    const slug = "sf-no-retrodoc";
    const projectPath = await createProjectFixture(slug);
    const before = readTeamMd(projectPath);
    seedStateAtStep13(slug, [P_INEXACT_PO], "1");
    // Deliberately NO retro doc on disk.

    const result = await runSprintFromStep(projectPath, slug, SPRINT, 13);

    expect(result.status).toBe("complete");
    expect(readTeamMd(projectPath)).not.toBe(before);
    const raw = readRawState(slug);
    expect(raw.retroApply.outcomes).toHaveLength(1);
    expect(raw.retroApply.outcomes[0].placement).toBe("applied-fallback");
  });

  it("all adopted proposals unplaceable: every one at fallback, TEAM.md still committed (Edge + AC 2, 4, 8)", async () => {
    const slug = "sf-all-fallback";
    const projectPath = await createProjectFixture(slug);
    const inexact2: RetroProposal = {
      ...P_EXACT_QA,
      section: "QA responsibilities and duties",
    };
    seedStateAtStep13(slug, [P_INEXACT_PO, inexact2], "1,2");
    writeRetroDoc(projectPath, slug, [P_INEXACT_PO, inexact2]);

    const result = await runSprintFromStep(projectPath, slug, SPRINT, 13);

    expect(result.status).toBe("complete");
    const after = readTeamMd(projectPath);
    expect(after).toContain(P_INEXACT_PO.proposal);
    expect(after).toContain(inexact2.proposal);
    const raw = readRawState(slug);
    expect(raw.retroApply.fallback).toBe(2);
    expect(raw.retroApply.applied).toBe(0);
    expect(await applyCommitCount(projectPath)).toBe(1); // it DID change
    expect(result.message ?? "").toMatch(/fallback/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Multi-feature runner seam — runApplyRetroImprovementsShared (AC 6 parity)
// ═══════════════════════════════════════════════════════════════════════════

describe("multi-feature step 13 production seam (AC 6 parity)", () => {
  const MULTI_SLUGS = ["alpha-feature", "beta-feature"];

  it("exhibits the full AC 1–5 contract through runApplyRetroImprovementsShared", async () => {
    const slug = "mf-contract";
    const projectPath = await createProjectFixture(slug, MULTI_SLUGS);
    const before = readTeamMd(projectPath);
    seedStateAtStep13(slug, [P_EXACT_QA, P_INEXACT_PO], "1,2", {
      multiFeatureSlugs: MULTI_SLUGS,
    });
    const retroPath = writeRetroDoc(projectPath, slug, [P_EXACT_QA, P_INEXACT_PO]);

    const result = await runSprintFromStep(projectPath, slug, SPRINT, 13);

    expect(result.status).toBe("complete");
    const after = readTeamMd(projectPath);
    expect(after).not.toBe(before);
    expect(after).toContain(P_EXACT_QA.proposal);
    expect(after).toContain(P_INEXACT_PO.proposal);
    expect(after).toContain(FALLBACK_HEADING);

    const raw = readRawState(slug);
    expect(raw.retroApply).toBeDefined();
    expect(raw.retroApply.outcomes).toHaveLength(2);
    expect(raw.retroApply.outcomes[0].placement).toBe("applied");
    expect(raw.retroApply.outcomes[1].placement).toBe("applied-fallback");

    const log = await simpleGit(projectPath).log();
    expect(log.all.some((c) => c.message.includes(APPLY_COMMIT_MSG))).toBe(true);

    const retroDoc = fs.readFileSync(retroPath, "utf-8");
    expect(retroDoc).not.toContain("(None yet)");

    expect(result.message ?? "").toMatch(/retro improvements/i);
  });

  it("AC 7 parity: 'skip' through the shared path also leaves TEAM.md byte-identical", async () => {
    const slug = "mf-skip";
    const projectPath = await createProjectFixture(slug, MULTI_SLUGS);
    const before = readTeamMd(projectPath);
    seedStateAtStep13(slug, [P_EXACT_QA, P_INEXACT_PO], "skip", {
      multiFeatureSlugs: MULTI_SLUGS,
    });

    const result = await runSprintFromStep(projectPath, slug, SPRINT, 13);

    expect(result.status).toBe("complete");
    expect(readTeamMd(projectPath)).toBe(before);
    expect(await applyCommitCount(projectPath)).toBe(0);
  });

  it("AC 1 parity: outcome-total invariant holds on the shared path's I/O failure too", async () => {
    const slug = "mf-io-fail";
    const projectPath = await createProjectFixture(slug, MULTI_SLUGS);
    seedStateAtStep13(slug, [P_EXACT_QA, P_INEXACT_PO], "1,2", {
      multiFeatureSlugs: MULTI_SLUGS,
    });
    const teamMdPath = path.join(projectPath, "TEAM.md");
    fs.rmSync(teamMdPath);
    fs.mkdirSync(teamMdPath);

    await runSprintFromStep(projectPath, slug, SPRINT, 13);

    const raw = readRawState(slug);
    expect(raw.retroApply.outcomes).toHaveLength(2);
    expect(raw.retroApply.outcomes.every((o: any) => o.placement === "unplaced")).toBe(true);
    expect(raw.steps[12].status).toBe("complete");
  });

  it("STRUCTURAL PARITY: identical inputs through both seams produce identical placements and TEAM.md insertions (AC 6)", async () => {
    const proposals = [P_EXACT_QA, P_INEXACT_PO, P_FENCED_ONLY];
    const feedback = "1,2,3";

    // Seam 1: single-feature.
    const sfSlug = "parity-single";
    const sfPath = await createProjectFixture(sfSlug);
    seedStateAtStep13(sfSlug, proposals, feedback);
    writeRetroDoc(sfPath, sfSlug, proposals);
    const sfResult = await runSprintFromStep(sfPath, sfSlug, SPRINT, 13);

    // Seam 2: multi-feature shared path.
    const mfSlug = "parity-multi";
    const mfPath = await createProjectFixture(mfSlug, MULTI_SLUGS);
    seedStateAtStep13(mfSlug, proposals, feedback, { multiFeatureSlugs: MULTI_SLUGS });
    writeRetroDoc(mfPath, mfSlug, proposals);
    const mfResult = await runSprintFromStep(mfPath, mfSlug, SPRINT, 13);

    expect(sfResult.status).toBe("complete");
    expect(mfResult.status).toBe("complete");

    // Identical per-proposal placement sequences (AC 6: ACs 1–5 behave the same).
    const sfOutcomes = readRawState(sfSlug).retroApply.outcomes;
    const mfOutcomes = readRawState(mfSlug).retroApply.outcomes;
    expect(mfOutcomes.map((o: any) => o.placement)).toEqual(
      sfOutcomes.map((o: any) => o.placement)
    );
    expect(mfOutcomes.map((o: any) => o.placedAt)).toEqual(
      sfOutcomes.map((o: any) => o.placedAt)
    );

    // Identical inserted content: the TEAM.md delta lines match between seams.
    const template = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    const insertedLines = (content: string) =>
      content
        .split("\n")
        .filter((line) => !template.includes(line) && line.trim() !== "");
    expect(insertedLines(readTeamMd(mfPath))).toEqual(insertedLines(readTeamMd(sfPath)));

    // Both seams committed the apply with the same message (AC 8 parity).
    expect(await applyCommitCount(sfPath)).toBe(1);
    expect(await applyCommitCount(mfPath)).toBe(1);
  });
});
