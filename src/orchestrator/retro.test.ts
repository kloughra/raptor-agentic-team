/**
 * Unit tests for the redesigned retro apply/report API (Sprint 13,
 * retro-improvements-not-applied).
 *
 * Spec:         docs/specs/retro-improvements-not-applied.md
 * Architecture: docs/architecture/retro-improvements-not-applied.md
 *
 * TDD: written BEFORE the implementation. These pin the pure-function
 * contract of the outcome-returning applyImprovements(content, proposals,
 * sprint) and updateRetroDocWithAppliedChanges. The production seams are
 * covered by tests/integration/retro-improvements-not-applied.integration.test.ts
 * — do NOT weaken those into these unit tests; this file complements them.
 */

import { describe, it, expect, beforeAll } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  applyImprovements,
  updateRetroDocWithAppliedChanges,
  generateRetroDocument,
  RetroProposal,
  ProposalOutcome,
  FALLBACK_SECTION_HEADING,
} from "./retro";

const TEMPLATE_PATH = path.join(__dirname, "../../template/TEAM.md");
const SPRINT = 1;
const FALLBACK_PLACED_AT = "Adopted Retro Improvements (Unplaced)";

const P_INEXACT_PO: RetroProposal = {
  role: "po",
  section: "Product Owner responsibilities",
  type: "addition",
  proposal: "Record spec-review outcomes in the sprint log before handoff.",
  rationale: "Sprint 10 and 12 adopted proposals were silently dropped.",
  impact: "Adopted process improvements actually take effect.",
};

const P_EXACT_QA: RetroProposal = {
  role: "qa",
  section: "QA Engineer",
  type: "addition",
  proposal: "Document test-data setup assumptions inside every BDD scenario.",
  rationale: "Engineers had to guess test data formats.",
  impact: "Less implementation ambiguity.",
};

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

let templateTeamMd: string;
beforeAll(() => {
  templateTeamMd = fs.readFileSync(TEMPLATE_PATH, "utf-8");
});

describe("applyImprovements — outcome contract (AC 1)", () => {
  it("returns exactly one outcome per proposal, in input order", () => {
    const proposals = [P_INEXACT_PO, P_EXACT_QA];
    const result = applyImprovements(templateTeamMd, proposals, SPRINT);

    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.map((o) => o.role)).toEqual(["po", "qa"]);
    expect(result.outcomes.map((o) => o.section)).toEqual([
      P_INEXACT_PO.section,
      P_EXACT_QA.section,
    ]);
  });

  it("empty proposal list → empty outcomes, unchanged content, changed=false", () => {
    const result = applyImprovements(templateTeamMd, [], SPRINT);
    expect(result.outcomes).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(templateTeamMd);
  });
});

describe("applyImprovements — target matching (AC 2, Open Q 2 ruling)", () => {
  it("applies at an exactly-matching heading, records verbatim placedAt, changed=true", () => {
    const result = applyImprovements(templateTeamMd, [P_EXACT_QA], SPRINT);

    expect(result.outcomes[0].placement).toBe("applied");
    expect(result.outcomes[0].placedAt).toContain("QA Engineer");
    expect(result.changed).toBe(true);
    expect(result.content).toContain(P_EXACT_QA.proposal);
  });

  it("normalizes case, whitespace, and echoed leading hashes — nothing more", () => {
    for (const variant of ["### qa engineer", "  QA   Engineer  ", "QA ENGINEER"]) {
      const result = applyImprovements(
        templateTeamMd,
        [{ ...P_EXACT_QA, section: variant }],
        SPRINT
      );
      expect(result.outcomes[0].placement).toBe("applied");
    }
  });

  it("does NOT fuzzy-match: plausible-but-inexact section goes to fallback (AC 9 shape)", () => {
    const result = applyImprovements(templateTeamMd, [P_INEXACT_PO], SPRINT);

    expect(result.outcomes[0].placement).toBe("applied-fallback");
    expect(result.outcomes[0].placedAt).toBe(FALLBACK_PLACED_AT);
    expect(result.changed).toBe(true);
    // Never lost: the text is present under the fallback heading.
    expect(result.content).toContain(FALLBACK_SECTION_HEADING);
    const fallbackBlock = result.content.slice(
      result.content.indexOf(FALLBACK_SECTION_HEADING)
    );
    expect(fallbackBlock).toContain(P_INEXACT_PO.proposal);
    // Attribution: sprint + role + verbatim target section (AC 2 / Open Q 3).
    expect(fallbackBlock).toMatch(/Sprint 1/);
    expect(fallbackBlock).toMatch(/PO/);
    expect(fallbackBlock).toContain("Product Owner responsibilities");
    // Type is part of the attribution marker.
    expect(fallbackBlock).toContain("(addition)");
  });

  it("first match wins on duplicate headings and is the recorded placedAt (Edge: multi-match)", () => {
    const synthetic = [
      "# Doc",
      "",
      "## Duplicate",
      "First body.",
      "",
      "## Middle",
      "middle body",
      "",
      "## Duplicate",
      "Second body.",
      "",
    ].join("\n");
    const result = applyImprovements(
      synthetic,
      [{ ...P_EXACT_QA, section: "Duplicate", proposal: "MULTI-MATCH-MARKER" }],
      SPRINT
    );

    expect(result.outcomes[0].placement).toBe("applied");
    expect(result.outcomes[0].placedAt).toBe("Duplicate");
    const insertIdx = result.content.indexOf("MULTI-MATCH-MARKER");
    expect(insertIdx).toBeGreaterThan(result.content.indexOf("## Duplicate"));
    expect(insertIdx).toBeLessThan(result.content.indexOf("## Middle"));
  });
});

describe("applyImprovements — fence awareness (Edge: fences)", () => {
  it("headings inside fenced code blocks are non-matchable", () => {
    const synthetic = [
      "# Doc",
      "",
      "## Real Section",
      "body",
      "",
      "```markdown",
      "## Fenced Only Heading",
      "```",
      "",
    ].join("\n");
    const result = applyImprovements(
      synthetic,
      [{ ...P_EXACT_QA, section: "Fenced Only Heading", proposal: "FENCE-MISS-MARKER" }],
      SPRINT
    );

    expect(result.outcomes[0].placement).toBe("applied-fallback");
    // Present exactly once — in the fallback section, not inside the fence.
    expect(countOccurrences(result.content, "FENCE-MISS-MARKER")).toBe(1);
    expect(result.content.indexOf("FENCE-MISS-MARKER")).toBeGreaterThan(
      result.content.indexOf(FALLBACK_SECTION_HEADING)
    );
  });

  it("the bundled template's fenced '## Linked Spec' heading is non-matchable", () => {
    expect(templateTeamMd).toContain("## Linked Spec");
    const result = applyImprovements(
      templateTeamMd,
      [{ ...P_EXACT_QA, section: "Linked Spec", proposal: "TEMPLATE-FENCE-MARKER" }],
      SPRINT
    );
    expect(result.outcomes[0].placement).toBe("applied-fallback");
  });

  it("a fenced heading does not terminate the enclosing section early", () => {
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
    const result = applyImprovements(
      synthetic,
      [{ ...P_EXACT_QA, section: "Target Section", proposal: "FENCE-AWARE-MARKER" }],
      SPRINT
    );

    expect(result.outcomes[0].placement).toBe("applied");
    const insertIdx = result.content.indexOf("FENCE-AWARE-MARKER");
    const fenceClose = result.content.indexOf(
      "```",
      result.content.indexOf("```") + 3
    );
    expect(insertIdx).toBeGreaterThan(fenceClose);
    expect(insertIdx).toBeLessThan(result.content.indexOf("## Next Section"));
  });
});

describe("applyImprovements — idempotency (Edge: re-run/resume)", () => {
  it("second pass records already-present, changed=false, no duplicated text", () => {
    const first = applyImprovements(templateTeamMd, [P_EXACT_QA, P_INEXACT_PO], SPRINT);
    expect(first.changed).toBe(true);

    const second = applyImprovements(first.content, [P_EXACT_QA, P_INEXACT_PO], SPRINT);
    expect(second.outcomes).toHaveLength(2);
    expect(second.outcomes.every((o) => o.placement === "already-present")).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
    expect(countOccurrences(second.content, P_EXACT_QA.proposal)).toBe(1);
    expect(countOccurrences(second.content, P_INEXACT_PO.proposal)).toBe(1);
  });

  it("fallback blocks are sprint-unique: same proposal from another sprint inserts again", () => {
    const first = applyImprovements(templateTeamMd, [P_INEXACT_PO], 1);
    const second = applyImprovements(first.content, [P_INEXACT_PO], 2);
    expect(second.outcomes[0].placement).toBe("applied-fallback");
    expect(countOccurrences(second.content, P_INEXACT_PO.proposal)).toBe(2);
  });
});

describe("applyImprovements — proposal types keep their existing markers", () => {
  it("modification and removal use the pre-existing blockquote markers", () => {
    const mod = applyImprovements(
      templateTeamMd,
      [{ ...P_EXACT_QA, type: "modification", proposal: "MOD-MARKER" }],
      SPRINT
    );
    expect(mod.content).toContain("**[Sprint Retro Modification]** MOD-MARKER");

    const rem = applyImprovements(
      templateTeamMd,
      [{ ...P_EXACT_QA, type: "removal", proposal: "REM-MARKER" }],
      SPRINT
    );
    expect(rem.content).toContain("**[Sprint Retro — Flagged for Removal]** REM-MARKER");
  });
});

describe("updateRetroDocWithAppliedChanges (AC 3)", () => {
  it("replaces the '(None yet)' stub with one line per outcome", () => {
    const doc = generateRetroDocument("proj", SPRINT, [P_EXACT_QA, P_INEXACT_PO], ["qa", "po"]);
    expect(doc).toContain("## Applied Changes\n(None yet)");

    const outcomes: ProposalOutcome[] = [
      { role: "qa", section: "QA Engineer", placement: "applied", placedAt: "QA Engineer" },
      {
        role: "po",
        section: "Product Owner responsibilities",
        placement: "applied-fallback",
        placedAt: FALLBACK_PLACED_AT,
      },
    ];
    const updated = updateRetroDocWithAppliedChanges(doc, outcomes);

    expect(updated).not.toContain("(None yet)");
    const appliedSection = updated.slice(updated.indexOf("## Applied Changes"));
    expect(appliedSection).toContain('applied at "QA Engineer"');
    expect(appliedSection).toMatch(/fallback/i);
    expect(appliedSection).toContain("Product Owner responsibilities");
  });

  it("renders already-present as a success line with its placedAt", () => {
    const doc = generateRetroDocument("proj", SPRINT, [P_EXACT_QA], ["qa"]);
    const updated = updateRetroDocWithAppliedChanges(doc, [
      { role: "qa", section: "QA Engineer", placement: "already-present", placedAt: "QA Engineer" },
    ]);
    const appliedSection = updated.slice(updated.indexOf("## Applied Changes"));
    expect(appliedSection).toContain("QA Engineer");
    expect(appliedSection).not.toMatch(/NOT APPLIED/i);
  });

  it("renders unplaced outcomes with their reason", () => {
    const doc = generateRetroDocument("proj", SPRINT, [P_EXACT_QA], ["qa"]);
    const updated = updateRetroDocWithAppliedChanges(doc, [
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
    const handEdited =
      "# Sprint 1 Retrospective\n\n## Applied Changes\n- QA proposal → applied\n";
    const updated = updateRetroDocWithAppliedChanges(handEdited, [
      { role: "qa", section: "QA Engineer", placement: "applied", placedAt: "QA Engineer" },
    ]);
    expect(updated).toBe(handEdited);
  });
});
