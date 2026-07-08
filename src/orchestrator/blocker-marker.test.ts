/**
 * Unit tests - blocker-marker detection (Sprint 15)
 *
 * Spec:         docs/specs/blocker-marker-false-positive-in-agent-output.md (AC 1-8)
 * Architecture: docs/architecture/blocker-marker-false-positive-in-agent-output.md
 *               ("Handoff to QA" test matrix, item 1 - colocated unit suite)
 *
 * SCOPE: the pure, dependency-free detector module in isolation. The production
 * seam (real runner loop, both single- and multi-feature) and the git-parser
 * hardening are covered in
 * tests/integration/blocker-marker-false-positive-in-agent-output.integration.test.ts;
 * the ~1 MB linear-time NFR is covered in
 * tests/performance/blocker-marker-false-positive-in-agent-output.perf.test.ts.
 *
 * WHAT THIS FEATURE CHANGES: only *what counts as* a genuine marker. Once one is
 * detected the escalation mechanics are frozen (AC 7 / Out of Scope) - that is a
 * seam concern, asserted in the integration suite, not here.
 *
 * -- RED-VERIFICATION (TEAM.md QA rule 12) ----------------------------------
 * Every constraint-guarding case below is RED against pre-change `main` for two
 * independent reasons:
 *   1. STRUCTURAL: the module under test does not exist on `main` - detection is
 *      a private one-liner inside runner.ts. The import fails to resolve, so the
 *      whole suite is RED at step 3. The Engineer creates the module in step 5
 *      to turn it green.
 *   2. BEHAVIORAL: the pre-change detector is `/\[blocker\]/i.test(output)`
 *      (anywhere-match). For each suppressed-marker case the anywhere-match
 *      returns TRUE where the hardened detector must return FALSE. Each such
 *      case is annotated `RED:` with exactly how it fails the anywhere-match.
 * Cases tagged [no-regression] pass both before and after (they are not
 * constraint-guarding - they pin behavior the anywhere-match also gets right).
 */

import { describe, it, expect } from "@jest/globals";
import { hasBlockerMarker, stripSuppressedLines } from "./blocker-marker";

describe("hasBlockerMarker - genuine, line-anchored markers (AC 1, AC 5)", () => {
  it("[no-regression] a marker at the very start of output is genuine", () => {
    expect(hasBlockerMarker("[BLOCKER] QA: cannot find spec")).toBe(true);
  });

  it("[no-regression] a marker at the start of a later line is genuine", () => {
    expect(hasBlockerMarker("working...\nstill working...\n[BLOCKER] QA: cannot find spec")).toBe(true);
  });

  it("[no-regression] a marker with trailing text on the same line is genuine (edge case)", () => {
    expect(hasBlockerMarker("[BLOCKER] QA: cannot find spec -- blocked on PO")).toBe(true);
  });

  it("[no-regression] a marker indented with spaces (not fenced/quoted) is genuine (edge case)", () => {
    expect(hasBlockerMarker("    [BLOCKER] engineer: build broke")).toBe(true);
  });

  it("[no-regression] a marker indented with a tab (not fenced/quoted) is genuine (edge case)", () => {
    expect(hasBlockerMarker("\t[BLOCKER] engineer: build broke")).toBe(true);
  });

  it("[no-regression] detection is case-insensitive for line-anchored markers (AC 5)", () => {
    expect(hasBlockerMarker("[BLOCKER] qa: x")).toBe(true);
    expect(hasBlockerMarker("[blocker] qa: x")).toBe(true);
    expect(hasBlockerMarker("[Blocker] qa: x")).toBe(true);
    expect(hasBlockerMarker("[bLoCkEr] qa: x")).toBe(true);
  });

  it("[no-regression] CRLF and LF anchoring produce identical results (edge case)", () => {
    expect(hasBlockerMarker("first\r\n[BLOCKER] qa: x\r\nlast")).toBe(true);
    expect(hasBlockerMarker("first\n[BLOCKER] qa: x\nlast")).toBe(true);
  });
});

describe("hasBlockerMarker - suppressed / non-genuine markers", () => {
  it("a marker mid-sentence in prose is NOT genuine (AC 1)", () => {
    // RED: pre-change `/\[blocker\]/i.test(...)` matches the embedded marker -> true.
    expect(hasBlockerMarker("...if the agent writes [BLOCKER] then it escalates...")).toBe(false);
  });

  it("a marker only inside a triple-backtick fence is NOT genuine (AC 2)", () => {
    // RED: anywhere-match sees the fenced marker and returns true.
    const output = "docs:\n```\n[BLOCKER] qa: fenced example\n```\ndone";
    expect(hasBlockerMarker(output)).toBe(false);
  });

  it("a marker only inside a tilde fence is NOT genuine (AC 2)", () => {
    // RED: anywhere-match returns true; the hardened detector honors ~~~ fences too.
    const output = "docs:\n~~~\n[BLOCKER] qa: tilde-fenced example\n~~~\ndone";
    expect(hasBlockerMarker(output)).toBe(false);
  });

  it("the Sprint 12 demo specimen (fenced decision-pipeline diagram) is NOT genuine (AC 2, AC 8)", () => {
    // RED: the literal live incident - the fenced diagram carries the marker; the
    // anywhere-match escalates. Hardened -> false. Proven RED by reverting the
    // detector to the pre-change one-liner.
    const demo = [
      "# Sprint Demo - decision pipeline",
      "",
      "The escalation convention is documented below:",
      "",
      "```text",
      "agent output --> detect marker --> [BLOCKER] present? --> [ESCALATE] commit",
      "```",
      "",
      "All acceptance criteria are green.",
    ].join("\n");
    expect(hasBlockerMarker(demo)).toBe(false);
  });

  it("a marker inside a Markdown blockquote is NOT genuine (AC 3)", () => {
    // RED: anywhere-match returns true; blockquote lines must be suppressed.
    expect(hasBlockerMarker("> [BLOCKER] qa: quoted example\nall good")).toBe(false);
  });

  it("a blockquoted marker with leading whitespace before the quote char is NOT genuine (AC 3)", () => {
    // RED: anywhere-match returns true; a quote char after trimStart still marks a quote.
    expect(hasBlockerMarker("   > [BLOCKER] qa: still quoted\nall good")).toBe(false);
  });
});

describe("hasBlockerMarker - conservative-bias edge cases", () => {
  it("multiple markers where at least one is a genuine line-anchored raise -> true (edge case)", () => {
    const output = [
      "```",
      "[BLOCKER] qa: fenced example (suppressed)",
      "```",
      "[BLOCKER] engineer: the build actually broke",
    ].join("\n");
    expect(hasBlockerMarker(output)).toBe(true);
  });

  it("an unclosed fence suppresses the remainder conservatively -> false (edge case)", () => {
    // RED: anywhere-match returns true. Conservative bias: an opened-but-never-
    // closed fence treats the rest of the output as inside the fence, favoring a
    // missed marker over a false escalation.
    const output = "opening a fence:\n```\n[BLOCKER] qa: swallowed by the open fence";
    expect(hasBlockerMarker(output)).toBe(false);
  });

  it("a mismatched inner delimiter does not prematurely close a fence (edge case)", () => {
    // RED: anywhere-match returns true. A ~~~ line while a ``` fence is open stays
    // inside the fence, so the enclosed marker remains suppressed.
    const output = ["```", "~~~", "[BLOCKER] qa: still inside the backtick fence", "```"].join("\n");
    expect(hasBlockerMarker(output)).toBe(false);
  });

  it("[no-regression] empty, whitespace-only, and marker-free outputs -> false", () => {
    expect(hasBlockerMarker("")).toBe(false);
    expect(hasBlockerMarker("   \n\t\n   ")).toBe(false);
    expect(hasBlockerMarker("everything is fine, all tests pass")).toBe(false);
  });

  it("[no-regression] never throws on untrusted / adversarial input (reliability NFR)", () => {
    const inputs = [
      "  binary-ish \uFFFD\u0000\u0001",
      "```".repeat(10_000),
      ">".repeat(5_000),
      "no marker here".repeat(10_000),
      "\r\n".repeat(10_000),
    ];
    for (const input of inputs) {
      expect(() => hasBlockerMarker(input)).not.toThrow();
      expect(typeof hasBlockerMarker(input)).toBe("boolean");
    }
  });
});

describe("stripSuppressedLines - shared suppression primitive", () => {
  it("removes fenced-code lines (including the delimiters) and blockquote lines", () => {
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

  it("leaves ordinary text intact so a later anchored, m-flag match still works", () => {
    const text = "line one\n[BLOCKER] qa: real -- blocked on PO\nline three";
    const stripped = stripSuppressedLines(text);
    expect(stripped).toContain("[BLOCKER] qa: real -- blocked on PO");
    expect(/^\s*\[blocker\]/im.test(stripped)).toBe(true);
  });

  it("strips a tilde fence body as well as a backtick fence body (AC 2 parity)", () => {
    const text = ["before", "~~~", "hidden tilde body", "~~~", "after"].join("\n");
    const stripped = stripSuppressedLines(text);
    expect(stripped).toContain("before");
    expect(stripped).toContain("after");
    expect(stripped).not.toContain("hidden tilde body");
  });

  it("[no-regression] returns a string and never throws on empty input", () => {
    expect(typeof stripSuppressedLines("")).toBe("string");
    expect(() => stripSuppressedLines("")).not.toThrow();
  });
});
