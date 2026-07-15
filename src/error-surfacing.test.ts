/**
 * Unit tests — src/error-surfacing.ts (surface-tool-errors-to-openstory, Sprint 16)
 *
 * Spec:         docs/specs/surface-tool-errors-to-openstory.md (AC 1–10)
 * Architecture: docs/architecture/surface-tool-errors-to-openstory.md (D1–D4)
 *
 * These colocated unit tests exercise the pure surfacing policy directly (the
 * production-seam behavior is additionally proven in
 * tests/integration/surface-tool-errors-to-openstory.integration.test.ts).
 *
 * RED-VERIFICATION (TEAM.md QA rule 12): the module under test does not exist on
 * pre-change `main`, so this file fails to import [IMPORT-RED]. Conceptually, a
 * `surfaceOutcome` that always returned `{ content }` (today's swallow-into-
 * success wrapping) turns every failure assertion below RED while the success-
 * parity assertions stay GREEN — proving the tests pin the new behavior.
 */

import { describe, it, expect } from "@jest/globals";
import {
  surfaceOutcome,
  buildThrownErrorResult,
  isFailureStatus,
  FAILURE_STATUSES,
} from "./error-surfacing";

type TextContent = { type: "text"; text: string };

function jsonContent(result: Record<string, unknown>): TextContent[] {
  return [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
}

// ---------------------------------------------------------------------------
// FAILURE_STATUSES (D3) — enumerated, closed set
// ---------------------------------------------------------------------------

describe("FAILURE_STATUSES (D3)", () => {
  it("contains exactly 'error' and 'failed'", () => {
    expect(FAILURE_STATUSES.has("error")).toBe(true);
    expect(FAILURE_STATUSES.has("failed")).toBe(true);
    expect(FAILURE_STATUSES.size).toBe(2);
  });

  it("excludes every healthy / attention-needed status", () => {
    for (const healthy of ["success", "complete", "paused", "in-progress", "escalated"]) {
      expect(FAILURE_STATUSES.has(healthy)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// isFailureStatus — classifies from the structured field, never prose
// ---------------------------------------------------------------------------

describe("isFailureStatus", () => {
  it("is true for the enumerated failure statuses", () => {
    expect(isFailureStatus("error")).toBe(true);
    expect(isFailureStatus("failed")).toBe(true);
  });

  it("is false for healthy / attention-needed statuses", () => {
    expect(isFailureStatus("success")).toBe(false);
    expect(isFailureStatus("complete")).toBe(false);
    expect(isFailureStatus("paused")).toBe(false);
    expect(isFailureStatus("in-progress")).toBe(false);
    expect(isFailureStatus("escalated")).toBe(false);
  });

  it("never crashes or over-flags on non-string / absent status", () => {
    expect(isFailureStatus(undefined)).toBe(false);
    expect(isFailureStatus(null)).toBe(false);
    expect(isFailureStatus(42)).toBe(false);
    expect(isFailureStatus({})).toBe(false);
  });

  it("classifies from the status field, not the presence of 'error' in prose", () => {
    expect(isFailureStatus("this message mentions an error but is a success")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// surfaceOutcome — failure sets isError:true; success omits isError entirely
// ---------------------------------------------------------------------------

describe("surfaceOutcome (AC #1, #2, #5, #8)", () => {
  it("[FAIL] a {status:'error'} result sets isError:true and preserves the body", () => {
    const result = { status: "error", message: "boom" };
    const content = jsonContent(result);
    const surfaced = surfaceOutcome(result, content);
    expect(surfaced.isError).toBe(true);
    // Body preserved unchanged (AC #5 additive; body not restructured).
    expect(surfaced.content).toBe(content);
    expect(JSON.parse(surfaced.content[0].text)).toEqual(result);
  });

  it("[FAIL] a terminal 'failed' status sets isError:true", () => {
    const result = { status: "failed", message: "sprint failed" };
    const surfaced = surfaceOutcome(result, jsonContent(result));
    expect(surfaced.isError).toBe(true);
  });

  it("[PARITY] a {status:'success'} result OMITS isError entirely (not false)", () => {
    const result = { status: "success", message: "ok" };
    const content = jsonContent(result);
    const surfaced = surfaceOutcome(result, content);
    expect("isError" in surfaced).toBe(false);
    // Byte-for-byte identical wrapping — content passed straight through.
    expect(surfaced.content).toBe(content);
    expect(surfaced).toEqual({ content });
  });

  it("[PARITY] a success message mentioning 'error' is NOT misclassified", () => {
    const result = { status: "success", message: "completed with no error" };
    const surfaced = surfaceOutcome(result, jsonContent(result));
    expect("isError" in surfaced).toBe(false);
  });

  it.each(["complete", "paused", "in-progress", "escalated"])(
    "[PARITY] healthy lifecycle status '%s' is NOT surfaced as a failure",
    (status) => {
      const result = { status, message: `sprint ${status}` };
      const surfaced = surfaceOutcome(result, jsonContent(result));
      expect("isError" in surfaced).toBe(false);
    }
  );

  it("does not over-flag when status is missing or non-string", () => {
    const noStatus = { message: "no status field" } as Record<string, unknown>;
    expect("isError" in surfaceOutcome(noStatus, jsonContent(noStatus))).toBe(false);
    const weird = { status: 42 } as unknown as Record<string, unknown>;
    expect("isError" in surfaceOutcome(weird, jsonContent(weird))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildThrownErrorResult — structured failure for a caught exception (AC #4, #9)
// ---------------------------------------------------------------------------

describe("buildThrownErrorResult (AC #4, #9)", () => {
  it("sets isError:true and a structured {status,tool,message} body", () => {
    const err = new Error("simulated fs/simple-git failure");
    const surfaced = buildThrownErrorResult("bootstrap_project", err);
    expect(surfaced.isError).toBe(true);
    const body = JSON.parse(surfaced.content[0].text);
    expect(body.status).toBe("error");
    expect(body.tool).toBe("bootstrap_project");
    expect(body.message).toContain("simulated fs/simple-git failure");
  });

  it("emits the message but NEVER the stack trace (AC #9)", () => {
    const err = new Error("boundary failure detail");
    err.stack =
      "Error: boundary failure detail\n    at secretPath (/Users/secret/tokens.ts:42:7)";
    const surfaced = buildThrownErrorResult("run_sprint", err);
    const serialized = JSON.stringify(surfaced);
    expect(serialized).toContain("boundary failure detail");
    expect(serialized).not.toContain("secretPath");
    expect(serialized).not.toContain("/Users/secret/tokens.ts");
    expect(JSON.parse(surfaced.content[0].text).stack).toBeUndefined();
  });

  it("handles a non-Error thrown value without crashing", () => {
    const surfaced = buildThrownErrorResult("adopt_project", "plain string boom");
    expect(surfaced.isError).toBe(true);
    const body = JSON.parse(surfaced.content[0].text);
    expect(body.status).toBe("error");
    expect(body.tool).toBe("adopt_project");
    expect(typeof body.message).toBe("string");
    expect(body.message).toContain("plain string boom");
  });
});
