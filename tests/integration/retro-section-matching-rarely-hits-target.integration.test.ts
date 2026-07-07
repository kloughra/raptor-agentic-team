/**
 * Integration tests for: retro-section-matching-rarely-hits-target
 *
 * Spec:         docs/specs/retro-section-matching-rarely-hits-target.md
 * Architecture: docs/architecture/retro-section-matching-rarely-hits-target.md
 *
 * TDD note (step 3): these tests are written BEFORE the implementation and pin
 * the post-fix contract. They are EXPECTED TO FAIL (RED) against the current
 * exact-only matcher — that is the point (TEAM.md QA rule 12).
 *
 * ── RED-VERIFICATION EVIDENCE (AC 10) ──────────────────────────────────────
 * Each constraint-guarding test carries a per-test RED note. The mechanism the
 * architecture prescribes: today `applyImprovements` resolves headings via
 * `findHeadingLine` (normalized-EXACT). The new resolver (`resolveHeadingLine`,
 * segment-and-match) does not exist yet.
 *
 *   • AC 1 / AC 2 (compound → applied): RED because a compound/descriptive
 *     Section never equals a single heading, so the exact matcher returns null
 *     and the proposal lands in the Unplaced fallback. These assertions demand
 *     `placement === "applied"` at a SPECIFIC heading — impossible pre-fix, so
 *     they go red now and green only once the resolver ships. Reverting a
 *     future `resolveHeadingLine` back to exact-only re-reddens them.
 *
 *   • AC 4 (no wrong placement): the pure-prose Sections already fall back
 *     under exact-only, so their RED note is inverted — they assert a
 *     TOO-GREEDY resolver (substring / fuzzy) would MIS-place
 *     "the architecture of the system" onto "### Architect", and pin that this
 *     must NOT happen. A whole-token resolver keeps them green; a substring
 *     resolver reddens the `whole-token` guard test.
 *
 * ── PRODUCTION SEAMS (do NOT weaken into helper-only unit tests) ───────────
 * TEAM.md QA rule 12 forbids satisfying a parity/constraint requirement solely
 * with unit tests of the pure function. This file exercises:
 *   1. The pure resolver contract via applyImprovements(content, proposals, n).
 *   2. Single-feature step-13 seam:  runSprintFromStep(path, slug, 1, 13).
 *   3. Multi-feature step-13 seam:   runSprintFromStep(...) with state.features
 *      seeded → runApplyRetroImprovementsShared → executeRetroApply.
 *
 * No mocking of retro.ts or runner.ts internals — the two runner seams plus the
 * REAL bundled template/TEAM.md content ARE the regression coverage. Only
 * os.homedir() is redirected (via the jest os-shim) so sprint state lands in a
 * temp dir instead of the real ~/.raptor.
 *
 * The post-fix resolver behavior is accessed through the existing, unchanged
 * applyImprovements signature — so this file compiles against pre-fix code and
 * the assertions (not the types) go red, which is the correct TDD signal.
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
  applyImprovements,
  generateRetroDocument,
  RetroProposal,
} from "../../src/orchestrator/retro";

const TEMPLATE_PATH = path.join(__dirname, "../../template/TEAM.md");
const SPRINT = 1;
const FALLBACK_HEADING = "## Adopted Retro Improvements (Unplaced)";
const FALLBACK_PLACED_AT = "Adopted Retro Improvements (Unplaced)";
const APPLY_COMMIT_MSG = `[PO] update: apply retrospective improvements from sprint ${SPRINT}`;

// ─── The two LIVE-INCIDENT compound Section strings (verbatim) ──────────────
// Sprint 13 (retro-improvements-not-applied) adopted 3/3 → all fell to fallback.
const SPRINT_13_SECTION =
  "Roles & Responsibilities → Product Owner (Responsibilities); reinforced in Backlog Management → Rules";
// Sprint 14 (adversarial-verifier-review-gate) adopted 4/4 → all fell to fallback.
const SPRINT_14_SECTION = "Roles & Responsibilities → QA Engineer (Responsibilities)";

// ─── Proposal fixtures ──────────────────────────────────────────────────────

// AC 1 / AC 2 live-incident #1 → resolves to "### Product Owner (PO)" (H3).
const P_SPRINT_13: RetroProposal = {
  role: "po",
  section: SPRINT_13_SECTION,
  type: "addition",
  proposal: "SPRINT13-COMPOUND-MARKER: capture every deferred item before sprint close.",
  rationale: "Sprint 13 adopted proposals all fell to the Unplaced fallback.",
  impact: "Adopted improvements land at their real heading.",
};

// AC 1 / AC 2 live-incident #2 → resolves to "### QA Engineer" (H3).
const P_SPRINT_14: RetroProposal = {
  role: "qa",
  section: SPRINT_14_SECTION,
  type: "addition",
  proposal: "SPRINT14-COMPOUND-MARKER: author a default-off parity test for inert-by-default config.",
  rationale: "Sprint 14 adopted proposals all fell to the Unplaced fallback.",
  impact: "Parity regressions caught at the seam.",
};

// AC 1 tie-break: compound "Backlog Management → Rules" → parent "## Backlog Management" (H2).
const P_BACKLOG_RULES: RetroProposal = {
  role: "po",
  section: "Backlog Management → Rules",
  type: "modification",
  proposal: "BACKLOG-RULES-MARKER: items never skip a backlog section.",
  rationale: "Compound reference to a real heading.",
  impact: "Applied at target.",
};

// Edge (no-hijack): "Sprint Workflow ordering of Rules" → "## Sprint Workflow", NOT "### Rules".
const P_WORKFLOW_NO_HIJACK: RetroProposal = {
  role: "architect",
  section: "Sprint Workflow ordering of Rules",
  type: "modification",
  proposal: "WORKFLOW-NOHIJACK-MARKER: document step ordering explicitly.",
  rationale: "Generic short heading must not hijack placement.",
  impact: "Correct target.",
};

// Exact verbatim heading — unchanged exact fast path.
const P_EXACT_QA: RetroProposal = {
  role: "qa",
  section: "QA Engineer",
  type: "addition",
  proposal: "EXACT-QA-MARKER: document test-data setup assumptions in every BDD scenario.",
  rationale: "Exact heading still resolves as today.",
  impact: "Additive to the exact path.",
};

// AC 4 pure prose → fallback ("architect" whole-token ≠ "architecture").
const P_PROSE_ARCH: RetroProposal = {
  role: "architect",
  section: "notes on the architecture of the system",
  type: "modification",
  proposal: "PROSE-ARCH-MARKER: keep the design doc current.",
  rationale: "No real heading referenced.",
  impact: "Well-attributed fallback preferred over wrong placement.",
};

// AC 6 fenced-only heading, embedded in a compound Section → still fallback.
const P_FENCED_COMPOUND: RetroProposal = {
  role: "architect",
  section: "PR Description Template → Linked Spec",
  type: "modification",
  proposal: "FENCED-COMPOUND-MARKER: link the architecture doc in every PR.",
  rationale: "`## Linked Spec` exists only inside a code fence.",
  impact: "Fenced headings stay non-matchable.",
};

// ─── Environment: temp home so ~/.raptor never gets touched ─────────────────
let tmpHome: string;
let homedirSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "raptor-retro-match-"));
  homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  homedirSpy.mockRestore();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ─── Fixture helpers (mirrors the Sprint 13 harness) ────────────────────────

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

function writeRetroDoc(
  projectPath: string,
  projectSlug: string,
  proposals: RetroProposal[]
): string {
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

/** Index of the section that starts at `heading` and ends at the next same-or-higher heading. */
function sectionSlice(content: string, heading: string, nextHeadings: string[]): string {
  const start = content.indexOf(heading);
  if (start < 0) return "";
  let end = content.length;
  for (const nh of nextHeadings) {
    const idx = content.indexOf(nh, start + heading.length);
    if (idx >= 0 && idx < end) end = idx;
  }
  return content.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Pure resolver contract via applyImprovements (AC 1, 2, 4, 5, 6)
//    Exercises the production apply function against the REAL bundled template.
// ═══════════════════════════════════════════════════════════════════════════

describe("applyImprovements — compound Section resolution (AC 1, 2)", () => {
  let templateTeamMd: string;

  beforeEach(() => {
    templateTeamMd = fs.readFileSync(TEMPLATE_PATH, "utf-8");
  });

  // RED: exact-only findHeadingLine sends this compound Section to fallback.
  // Reverting a future resolveHeadingLine to normalized-exact re-reddens this.
  it("AC 2 live incident — Sprint 13 Section resolves to '### Product Owner (PO)' as applied", () => {
    const result = applyImprovements(templateTeamMd, [P_SPRINT_13], SPRINT);

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].placement).toBe("applied");
    expect(result.outcomes[0].placedAt).toBe("Product Owner (PO)");
    expect(result.changed).toBe(true);

    // Inserted inside the Product Owner (PO) section — before the next H3 (QA Engineer).
    const poSection = sectionSlice(result.content, "### Product Owner (PO)", [
      "### QA Engineer",
    ]);
    expect(poSection).toContain(P_SPRINT_13.proposal);

    // NOT parked in the Unplaced fallback.
    const fallbackIdx = result.content.indexOf(FALLBACK_HEADING);
    if (fallbackIdx >= 0) {
      expect(result.content.slice(fallbackIdx)).not.toContain(P_SPRINT_13.proposal);
    }
  });

  // RED: exact-only sends this compound Section to fallback.
  it("AC 2 live incident — Sprint 14 Section resolves to '### QA Engineer' as applied", () => {
    const result = applyImprovements(templateTeamMd, [P_SPRINT_14], SPRINT);

    expect(result.outcomes[0].placement).toBe("applied");
    expect(result.outcomes[0].placedAt).toBe("QA Engineer");

    const qaSection = sectionSlice(result.content, "### QA Engineer", ["### Architect"]);
    expect(qaSection).toContain(P_SPRINT_14.proposal);
  });

  // RED: "Backlog Management → Rules" never equals a single heading pre-fix.
  it("AC 1 — a compound 'Backlog Management → Rules' resolves to the '## Backlog Management' heading", () => {
    const result = applyImprovements(templateTeamMd, [P_BACKLOG_RULES], SPRINT);

    expect(result.outcomes[0].placement).toBe("applied");
    // Architect ruling: longest-match wins → the H2 parent, not the generic `### Rules`.
    expect(result.outcomes[0].placedAt).toBe("Backlog Management");
    const section = sectionSlice(result.content, "## Backlog Management", [
      "## Handoff Protocol",
    ]);
    expect(section).toContain(P_BACKLOG_RULES.proposal);
  });

  // RED: "Sprint Workflow ordering of Rules" is not an exact heading pre-fix.
  it("Edge (no-hijack) — 'Sprint Workflow ordering of Rules' resolves to '## Sprint Workflow', not '### Rules'", () => {
    const result = applyImprovements(templateTeamMd, [P_WORKFLOW_NO_HIJACK], SPRINT);

    expect(result.outcomes[0].placement).toBe("applied");
    expect(result.outcomes[0].placedAt).toBe("Sprint Workflow");
    // Must NOT be spliced into the generic Rules subsection.
    const rulesSection = sectionSlice(result.content, "### Rules", ["## Handoff Protocol"]);
    expect(rulesSection).not.toContain(P_WORKFLOW_NO_HIJACK.proposal);
  });

  it("Edge (exact path frozen) — a verbatim heading Section still resolves via the unchanged exact matcher", () => {
    const result = applyImprovements(templateTeamMd, [P_EXACT_QA], SPRINT);
    expect(result.outcomes[0].placement).toBe("applied");
    expect(result.outcomes[0].placedAt).toContain("QA Engineer");
    const qaSection = sectionSlice(result.content, "### QA Engineer", ["### Architect"]);
    expect(qaSection).toContain(P_EXACT_QA.proposal);
  });

  it("AC 4 (no-shred) — 'Roles & Responsibilities' matches its '&'-containing heading, not shredded on '&'", () => {
    const proposal: RetroProposal = {
      ...P_EXACT_QA,
      section: "Roles & Responsibilities",
      proposal: "ROLES-AMP-MARKER: no shredding on ampersand.",
    };
    const result = applyImprovements(templateTeamMd, [proposal], SPRINT);
    expect(result.outcomes[0].placement).toBe("applied");
    expect(result.outcomes[0].placedAt).toBe("Roles & Responsibilities");
  });
});

describe("applyImprovements — precision guarantee (AC 4, no false positives)", () => {
  let templateTeamMd: string;

  beforeEach(() => {
    templateTeamMd = fs.readFileSync(TEMPLATE_PATH, "utf-8");
  });

  // RED-inverted (AC 10): pure prose already falls back under exact-only. This
  // pins that a TOO-GREEDY resolver must NOT mis-place it. The whole-token rule
  // (`architect` ≠ `architecture`) is the guard; a substring/fuzzy resolver
  // would redden this by placing the marker under `### Architect`.
  it("does NOT mis-place 'notes on the architecture of the system' onto '### Architect'", () => {
    const result = applyImprovements(templateTeamMd, [P_PROSE_ARCH], SPRINT);

    expect(result.outcomes[0].placement).toBe("applied-fallback");
    expect(result.outcomes[0].placedAt).toBe(FALLBACK_PLACED_AT);

    // Whole-token containment: the "architecture" token must not match "Architect".
    const archSection = sectionSlice(result.content, "### Architect", ["### Software Engineer"]);
    expect(archSection).not.toContain(P_PROSE_ARCH.proposal);

    // Present exactly once — in the fallback section only.
    expect(countOccurrences(result.content, P_PROSE_ARCH.proposal)).toBe(1);
    expect(result.content.indexOf(P_PROSE_ARCH.proposal)).toBeGreaterThan(
      result.content.indexOf(FALLBACK_HEADING)
    );
  });

  it("an empty / whitespace-only Section resolves to no heading → fallback (unchanged)", () => {
    const proposal: RetroProposal = { ...P_PROSE_ARCH, section: "   " };
    const result = applyImprovements(templateTeamMd, [proposal], SPRINT);
    expect(result.outcomes[0].placement).toBe("applied-fallback");
  });

  it("AC 6 — a compound Section cannot resolve to a heading inside a code fence", () => {
    // "## Linked Spec" exists only inside the fenced PR Description Template.
    expect(templateTeamMd).toContain("## Linked Spec");
    const result = applyImprovements(templateTeamMd, [P_FENCED_COMPOUND], SPRINT);

    expect(result.outcomes[0].placement).toBe("applied-fallback");
    // Appears exactly once — in the fallback, never spliced into the fence.
    expect(countOccurrences(result.content, P_FENCED_COMPOUND.proposal)).toBe(1);
    expect(result.content.indexOf(P_FENCED_COMPOUND.proposal)).toBeGreaterThan(
      result.content.indexOf(FALLBACK_HEADING)
    );
  });
});

describe("applyImprovements — outcome-total invariant & determinism (AC 3, 5)", () => {
  let templateTeamMd: string;

  beforeEach(() => {
    templateTeamMd = fs.readFileSync(TEMPLATE_PATH, "utf-8");
  });

  it("AC 3 — one outcome per proposal (compound-applied + exact-applied + prose-fallback)", () => {
    const proposals = [P_SPRINT_13, P_EXACT_QA, P_PROSE_ARCH];
    const result = applyImprovements(templateTeamMd, proposals, SPRINT);

    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes.map((o) => o.section)).toEqual(proposals.map((p) => p.section));
    for (const o of result.outcomes) {
      expect(["applied", "applied-fallback", "already-present", "unplaced"]).toContain(
        o.placement
      );
    }
    expect(result.outcomes[0].placement).toBe("applied"); // compound resolves
    expect(result.outcomes[1].placement).toBe("applied"); // exact
    expect(result.outcomes[2].placement).toBe("applied-fallback"); // prose
  });

  it("AC 5 — resolution is deterministic: identical inputs → identical placement & placedAt", () => {
    const first = applyImprovements(templateTeamMd, [P_SPRINT_13], SPRINT);
    const second = applyImprovements(templateTeamMd, [P_SPRINT_13], SPRINT);
    expect(second.outcomes[0].placement).toBe(first.outcomes[0].placement);
    expect(second.outcomes[0].placedAt).toBe(first.outcomes[0].placedAt);
    expect(second.content).toBe(first.content);
  });

  it("AC 7 — a compound-resolved proposal is idempotent on a second pass (already-present, no dup)", () => {
    const first = applyImprovements(templateTeamMd, [P_SPRINT_13], SPRINT);
    expect(first.outcomes[0].placement).toBe("applied");

    const second = applyImprovements(first.content, [P_SPRINT_13], SPRINT);
    expect(second.outcomes[0].placement).toBe("already-present");
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
    expect(countOccurrences(second.content, P_SPRINT_13.proposal)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Single-feature runner seam — runSprintFromStep(..., 13)
// ═══════════════════════════════════════════════════════════════════════════

describe("single-feature step 13 production seam (AC 1, 2, 8)", () => {
  // RED: both live-incident Sections fall to fallback at the seam pre-fix; this
  // asserts they now record placement "applied" at their real headings in the
  // persisted sprint state.
  it("both live-incident compound Sections are recorded as 'applied' in persisted state", async () => {
    const slug = "sf-live-incidents";
    const projectPath = await createProjectFixture(slug);
    seedStateAtStep13(slug, [P_SPRINT_13, P_SPRINT_14], "1,2");
    writeRetroDoc(projectPath, slug, [P_SPRINT_13, P_SPRINT_14]);

    const result = await runSprintFromStep(projectPath, slug, SPRINT, 13);
    expect(result.status).toBe("complete");

    const raw = readRawState(slug);
    expect(raw.retroApply.outcomes).toHaveLength(2);
    expect(raw.retroApply.outcomes[0].placement).toBe("applied");
    expect(raw.retroApply.outcomes[0].placedAt).toBe("Product Owner (PO)");
    expect(raw.retroApply.outcomes[1].placement).toBe("applied");
    expect(raw.retroApply.outcomes[1].placedAt).toBe("QA Engineer");
    expect(raw.retroApply.applied).toBe(2);
    expect(raw.retroApply.fallback).toBe(0);

    // Applied at target sections in the real TEAM.md, not the fallback.
    const after = readTeamMd(projectPath);
    expect(sectionSlice(after, "### Product Owner (PO)", ["### QA Engineer"])).toContain(
      P_SPRINT_13.proposal
    );
    expect(sectionSlice(after, "### QA Engineer", ["### Architect"])).toContain(
      P_SPRINT_14.proposal
    );

    // AC 8: committed with the unchanged message format.
    const log = await simpleGit(projectPath).log();
    expect(log.all.some((c) => c.message.includes(APPLY_COMMIT_MSG))).toBe(true);
  });

  it("AC 4 at the seam — a pure-prose Section still falls back (no wrong-section placement)", async () => {
    const slug = "sf-prose-fallback";
    const projectPath = await createProjectFixture(slug);
    seedStateAtStep13(slug, [P_PROSE_ARCH], "1");
    writeRetroDoc(projectPath, slug, [P_PROSE_ARCH]);

    const result = await runSprintFromStep(projectPath, slug, SPRINT, 13);
    expect(result.status).toBe("complete");

    const raw = readRawState(slug);
    expect(raw.retroApply.outcomes[0].placement).toBe("applied-fallback");
    expect(raw.retroApply.fallback).toBe(1);

    const after = readTeamMd(projectPath);
    expect(sectionSlice(after, "### Architect", ["### Software Engineer"])).not.toContain(
      P_PROSE_ARCH.proposal
    );
    expect(after).toContain(FALLBACK_HEADING);
    expect(result.message ?? "").toMatch(/fallback/i);
  });

  it("AC 7 at the seam — idempotent re-run of a compound-resolved proposal: no double-append, no 2nd commit", async () => {
    const slug = "sf-compound-rerun";
    const projectPath = await createProjectFixture(slug);
    seedStateAtStep13(slug, [P_SPRINT_13], "1");
    writeRetroDoc(projectPath, slug, [P_SPRINT_13]);

    const first = await runSprintFromStep(projectPath, slug, SPRINT, 13);
    expect(first.status).toBe("complete");
    const afterFirst = readTeamMd(projectPath);
    expect(await applyCommitCount(projectPath)).toBe(1);

    // Simulate a resume that re-executes step 13.
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

    const afterSecond = readTeamMd(projectPath);
    expect(afterSecond).toBe(afterFirst);
    expect(countOccurrences(afterSecond, P_SPRINT_13.proposal)).toBe(1);

    const rerun = readRawState(slug);
    expect(rerun.retroApply.outcomes[0].placement).toBe("already-present");
    expect(await applyCommitCount(projectPath)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Multi-feature runner seam — runApplyRetroImprovementsShared (AC 8 parity)
// ═══════════════════════════════════════════════════════════════════════════

describe("multi-feature step 13 production seam (AC 8 parity)", () => {
  const MULTI_SLUGS = ["alpha-feature", "beta-feature"];

  it("resolves compound Sections identically through the shared path", async () => {
    const slug = "mf-compound";
    const projectPath = await createProjectFixture(slug, MULTI_SLUGS);
    seedStateAtStep13(slug, [P_SPRINT_13, P_SPRINT_14], "1,2", {
      multiFeatureSlugs: MULTI_SLUGS,
    });
    writeRetroDoc(projectPath, slug, [P_SPRINT_13, P_SPRINT_14]);

    const result = await runSprintFromStep(projectPath, slug, SPRINT, 13);
    expect(result.status).toBe("complete");

    const raw = readRawState(slug);
    expect(raw.retroApply.outcomes[0].placement).toBe("applied");
    expect(raw.retroApply.outcomes[0].placedAt).toBe("Product Owner (PO)");
    expect(raw.retroApply.outcomes[1].placement).toBe("applied");
    expect(raw.retroApply.outcomes[1].placedAt).toBe("QA Engineer");
  });

  // RED + hardest parity pin: identical inputs through BOTH seams must produce
  // identical placements, placedAt, and identical inserted TEAM.md deltas.
  it("STRUCTURAL PARITY — both seams resolve compound Sections to identical placements & insertions (AC 8)", async () => {
    const proposals = [P_SPRINT_13, P_SPRINT_14, P_PROSE_ARCH];
    const feedback = "1,2,3";

    const sfSlug = "parity-single";
    const sfPath = await createProjectFixture(sfSlug);
    seedStateAtStep13(sfSlug, proposals, feedback);
    writeRetroDoc(sfPath, sfSlug, proposals);
    const sf = await runSprintFromStep(sfPath, sfSlug, SPRINT, 13);

    const mfSlug = "parity-multi";
    const mfPath = await createProjectFixture(mfSlug, MULTI_SLUGS);
    seedStateAtStep13(mfSlug, proposals, feedback, { multiFeatureSlugs: MULTI_SLUGS });
    writeRetroDoc(mfPath, mfSlug, proposals);
    const mf = await runSprintFromStep(mfPath, mfSlug, SPRINT, 13);

    expect(sf.status).toBe("complete");
    expect(mf.status).toBe("complete");

    const sfOutcomes = readRawState(sfSlug).retroApply.outcomes;
    const mfOutcomes = readRawState(mfSlug).retroApply.outcomes;

    // Identical placement & placedAt sequences across seams.
    expect(mfOutcomes.map((o: any) => o.placement)).toEqual(
      sfOutcomes.map((o: any) => o.placement)
    );
    expect(mfOutcomes.map((o: any) => o.placedAt)).toEqual(
      sfOutcomes.map((o: any) => o.placedAt)
    );
    // The two live incidents applied, prose fell back.
    expect(sfOutcomes.map((o: any) => o.placement)).toEqual([
      "applied",
      "applied",
      "applied-fallback",
    ]);

    // Identical inserted content between seams (delta lines vs the pristine template).
    const template = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    const insertedLines = (content: string) =>
      content.split("\n").filter((line) => !template.includes(line) && line.trim() !== "");
    expect(insertedLines(readTeamMd(mfPath))).toEqual(insertedLines(readTeamMd(sfPath)));

    expect(await applyCommitCount(sfPath)).toBe(1);
    expect(await applyCommitCount(mfPath)).toBe(1);
  });
});
