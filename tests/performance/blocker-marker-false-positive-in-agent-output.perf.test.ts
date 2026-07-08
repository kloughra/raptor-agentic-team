/**
 * Performance tests — blocker-marker-false-positive-in-agent-output (Sprint 15)
 *
 * Spec:         docs/specs/blocker-marker-false-positive-in-agent-output.md
 * Architecture: docs/architecture/blocker-marker-false-positive-in-agent-output.md (NFR: Performance)
 *
 * NFR under test: detection is a single O(n) forward line-scan over the output;
 * target < 5 ms for a ~1 MB output; negligible delta vs the current single
 * regex; no nested loops and no catastrophic-backtracking regex (no ReDoS).
 *
 * These are non-constraint-guarding (no RED note): they assert the linear-time
 * NFR, not a behavioral invariant. The threshold is generous (well above the
 * 5 ms target) so the suite is not flaky on shared CI hardware — the point is to
 * catch a regression to quadratic/backtracking behavior, not to microbenchmark.
 *
 * RED at step 3 only because the module does not exist yet on `main`; the import
 * resolves once the Engineer creates it in step 5.
 */

import { describe, it, expect } from "@jest/globals";
import { hasBlockerMarker, stripSuppressedLines } from "../../src/orchestrator/blocker-marker";

/** ~1 MB of marker-free prose split across many lines (the worst case: a full scan). */
function largeMarkerFreeOutput(approxBytes: number): string {
  const line = "all acceptance criteria are green and every test passes cleanly\n";
  const repeats = Math.ceil(approxBytes / line.length);
  return line.repeat(repeats);
}

/** ~1 MB output whose ONLY marker is buried inside a fence near the end. */
function largeFencedMarkerOutput(approxBytes: number): string {
  const body = largeMarkerFreeOutput(approxBytes);
  return `${body}\n\`\`\`\n[BLOCKER] qa: buried inside a fence\n\`\`\`\n`;
}

const ONE_MB = 1_000_000;
// Generous ceiling vs the 5 ms target — catches quadratic/backtracking regressions
// without being flaky on loaded CI runners.
const BUDGET_MS = 200;

function elapsed(fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

describe("hasBlockerMarker: bounded linear-time scan (Performance NFR)", () => {
  it("scans a ~1 MB marker-free output well under budget", () => {
    const output = largeMarkerFreeOutput(ONE_MB);
    let result = true;
    const ms = elapsed(() => {
      result = hasBlockerMarker(output);
    });
    expect(result).toBe(false);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("scans a ~1 MB output whose only marker is fenced well under budget", () => {
    const output = largeFencedMarkerOutput(ONE_MB);
    let result = true;
    const ms = elapsed(() => {
      result = hasBlockerMarker(output);
    });
    // Fenced marker is suppressed (correctness holds at scale too).
    expect(result).toBe(false);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("returns early on a genuine marker near the top without scanning the whole 1 MB", () => {
    const output = `[BLOCKER] qa: real\n${largeMarkerFreeOutput(ONE_MB)}`;
    let result = false;
    const ms = elapsed(() => {
      result = hasBlockerMarker(output);
    });
    expect(result).toBe(true);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("stripSuppressedLines processes a ~1 MB input well under budget", () => {
    const output = largeFencedMarkerOutput(ONE_MB);
    const ms = elapsed(() => {
      stripSuppressedLines(output);
    });
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
