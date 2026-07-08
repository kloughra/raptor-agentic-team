/**
 * Performance / NFR tests for: retro-section-matching-rarely-hits-target
 *
 * Spec:         docs/specs/retro-section-matching-rarely-hits-target.md
 * Architecture: docs/architecture/retro-section-matching-rarely-hits-target.md
 *
 * The architecture's Non-Functional Requirements for the segment-and-match
 * resolver:
 *   • Performance — "Negligible, synchronous, non-blocking of step flow.
 *     O(H · S · T) with H ≈ 40 headings, S ≤ ~6 segments, T ≤ ~10 tokens …
 *     sub-millisecond." No I/O beyond the single existing TEAM.md read.
 *   • Determinism — identical (TEAM.md, section) → identical placedAt every run;
 *     no clock, no Math.random, no model, no iteration-order dependence.
 *
 * These are deliberately generous, machine-independent bounds (CI-safe, not
 * micro-benchmarks) — they guard against an accidental super-linear or blocking
 * implementation (e.g. an O(H·S·T·N²) rescan, a fuzzy/Levenshtein pass, or a
 * sneaked-in network/model call), not exact nanoseconds.
 *
 * Runs against the pure production function `applyImprovements`; no runner or
 * git needed. Resolution being string-only, this is CPU-bound and synchronous.
 */

import { describe, it, expect, beforeAll } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

import { applyImprovements, RetroProposal } from "../../src/orchestrator/retro";

const TEMPLATE_PATH = path.join(__dirname, "../../template/TEAM.md");
const SPRINT = 1;

const SPRINT_13_SECTION =
  "Roles & Responsibilities → Product Owner (Responsibilities); reinforced in Backlog Management → Rules";
const SPRINT_14_SECTION = "Roles & Responsibilities → QA Engineer (Responsibilities)";

function proposal(section: string, marker: string): RetroProposal {
  return {
    role: "qa",
    section,
    type: "addition",
    proposal: marker,
    rationale: "r",
    impact: "i",
  };
}

let templateTeamMd: string;

beforeAll(() => {
  templateTeamMd = fs.readFileSync(TEMPLATE_PATH, "utf-8");
});

describe("resolver performance (NFR: negligible, synchronous, sub-ms per resolution)", () => {
  it("resolves the worst-case compound Section in well under a generous per-call budget", () => {
    // Warm up (JIT) then measure amortized cost of the multi-reference worst case.
    const p = proposal(SPRINT_13_SECTION, "PERF-WARMUP-MARKER");
    for (let i = 0; i < 50; i++) applyImprovements(templateTeamMd, [p], SPRINT);

    const ITER = 2000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < ITER; i++) {
      // Fresh marker each iteration keeps the resolver on the "applied" path
      // rather than short-circuiting on "already-present".
      applyImprovements(templateTeamMd, [proposal(SPRINT_13_SECTION, `PERF-${i}`)], SPRINT);
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const perCallMs = elapsedMs / ITER;

    // Generous CI-safe ceiling: the architecture claims sub-millisecond; allow
    // 5ms/call slack for a whole applyImprovements pass (read-split + resolve +
    // splice) on a loaded shared runner. A super-linear regression blows this.
    expect(perCallMs).toBeLessThan(5);
  });

  it("scales linearly-ish with the number of proposals (no pathological blow-up)", () => {
    const many: RetroProposal[] = [];
    for (let i = 0; i < 40; i++) {
      const section = i % 2 === 0 ? SPRINT_13_SECTION : SPRINT_14_SECTION;
      many.push(proposal(section, `PERF-BATCH-${i}`));
    }
    const start = process.hrtime.bigint();
    const result = applyImprovements(templateTeamMd, many, SPRINT);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    // 40 proposals against a ~640-line template should complete far under a
    // second — this is a synchronous validation gate, not a batch job.
    expect(elapsedMs).toBeLessThan(500);
    expect(result.outcomes).toHaveLength(40);
  });
});

describe("resolver determinism (NFR: identical inputs → identical output, every run)", () => {
  it("produces byte-identical placement + placedAt across many repeated runs", () => {
    const first = applyImprovements(
      templateTeamMd,
      [proposal(SPRINT_13_SECTION, "DET-MARKER")],
      SPRINT
    );

    for (let i = 0; i < 25; i++) {
      const again = applyImprovements(
        templateTeamMd,
        [proposal(SPRINT_13_SECTION, "DET-MARKER")],
        SPRINT
      );
      expect(again.outcomes[0].placement).toBe(first.outcomes[0].placement);
      expect(again.outcomes[0].placedAt).toBe(first.outcomes[0].placedAt);
      expect(again.content).toBe(first.content);
    }
  });

  it("resolution is synchronous — applyImprovements returns a value, not a Promise (no network/model I/O)", () => {
    const out = applyImprovements(
      templateTeamMd,
      [proposal(SPRINT_14_SECTION, "SYNC-MARKER")],
      SPRINT
    );
    // A model/network call would force an async surface; the NFR forbids one.
    expect(out).not.toBeInstanceOf(Promise);
    expect(typeof out.content).toBe("string");
    expect(Array.isArray(out.outcomes)).toBe(true);
  });
});
