/**
 * Real-seam conformance — surface-tool-errors-to-openstory (Sprint 16, R1 / AC #10)
 *
 * Spec:         docs/specs/surface-tool-errors-to-openstory.md (AC #10)
 * Architecture: docs/architecture/surface-tool-errors-to-openstory.md (D1/D2)
 * PO review R1: docs/specs/surface-tool-errors-to-openstory-test-review.md
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS (drift guard the PO required)
 * ─────────────────────────────────────────────────────────────────────────
 * The companion behavioral suite (surface-tool-errors-to-openstory.integration
 * .test.ts) drives the REAL tool functions and the REAL surfacing policy, but
 * routes them through a `runThroughSeam` *transcription* of the index.ts handler
 * — so it can never catch a handler in `src/index.ts` that is registered WITHOUT
 * the surfacing wrapper. PO review R1 flagged exactly that hole as blocking:
 *
 *   "guard the actual src/index.ts registration so an unwired handler fails the
 *    suite (drift-proof, all-six-tools coverage)."
 *
 * This suite closes it. It imports the REAL `registerTools` from src/index.ts,
 * captures each REAL registered callback, and drives EVERY registered tool
 * through its genuine handler closure. The tool implementations (src/tools.ts)
 * are mocked so we can force success / {status:"error"} / thrown outcomes at
 * will — the system under test is the index.ts registration seam, not the tools.
 *
 * Drift-proofing: the sweeps iterate over WHATEVER `registerTools` registered
 * and over WHATEVER tool exports exist — a future 7th tool is auto-covered. If
 * that tool's handler forgets the surfacing wrapper, the failure sweep goes RED.
 *
 * RED-VERIFICATION (TEAM.md QA rule 12): proven to FAIL against the pre-R1 code.
 *   [SEAM-RED] Before this fix, src/index.ts did not export `registerTools` and
 *     called `main()` unconditionally at import — this file could not import the
 *     module without booting a stdio transport, and there was no seam to drive.
 *   [UNWIRED-RED] Manually stripping the try/surfaceOutcome wrapper from any one
 *     handler (returning `{ content }` directly) turns the failure + thrown
 *     sweeps RED for that tool while every other tool stays GREEN.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Mock the tool implementations so the seam's outcome is fully controllable.
// The seam (registerTools in src/index.ts) is the real code under test.
jest.mock("../../src/tools");

import * as tools from "../../src/tools";
import { registerTools } from "../../src/index";
import type { ToolContext } from "../../src/tools";

const EXPECTED_TOOLS = [
  "bootstrap_project",
  "adopt_project",
  "list_projects",
  "get_project_status",
  "run_sprint",
  "resume_sprint",
] as const;

type SurfacedResult = { content: { type: string; text: string }[]; isError?: true };
type Handler = (args: unknown) => Promise<SurfacedResult>;

/**
 * A minimal server stub that records the REAL registered handler callbacks.
 * `registerTools` calls `server.tool(name, description, schema, handler)` — we
 * capture the exact handler closure index.ts builds, then invoke it directly.
 * Only the SDK's schema validation + transport are elided; the surfacing logic
 * is the genuine production closure.
 */
function captureHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerTools(fakeServer, {} as ToolContext);
  return handlers;
}

/** Force every mocked tool export to the given behavior (drift-proof over new tools). */
function setAllTools(impl: (...args: unknown[]) => unknown): void {
  for (const key of Object.keys(tools)) {
    const fn = (tools as Record<string, unknown>)[key];
    if (jest.isMockFunction(fn)) {
      (fn as jest.Mock).mockImplementation(impl as (...a: unknown[]) => unknown);
    }
  }
}

let handlers: Map<string, Handler>;

beforeEach(() => {
  jest.clearAllMocks();
  handlers = captureHandlers();
});

describe("real index.ts registration seam — every registered handler routes through surfacing (R1 / AC #10)", () => {
  it("registers exactly the six known tools (registration completeness)", () => {
    expect([...handlers.keys()].sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("[UNWIRED-RED] EVERY registered handler surfaces a {status:'error'} return as isError:true", async () => {
    setAllTools(() => ({ status: "error", message: "forced failure" }));

    // Iterate over the ACTUAL registrations — a new unwired tool is caught here.
    for (const [name, handler] of handlers) {
      const surfaced = await handler({});
      expect(surfaced.isError).toBe(true);
      // The structured failure body reaches the boundary intact.
      const text = surfaced.content.map((c) => c.text).join("\n");
      expect(/error|forced failure/i.test(text)).toBe(true);
    }
    // Guard against a silently-empty sweep.
    expect(handlers.size).toBeGreaterThanOrEqual(EXPECTED_TOOLS.length);
  });

  it("[UNWIRED-RED] EVERY registered handler surfaces a THROWN exception as isError:true with a structured body", async () => {
    setAllTools(() => {
      throw new Error("boom from tool impl");
    });

    for (const [name, handler] of handlers) {
      const surfaced = await handler({});
      expect(surfaced.isError).toBe(true);
      const body = JSON.parse(surfaced.content[0].text);
      // buildThrownErrorResult tags the tool name and carries the message, not a stack.
      expect(body.status).toBe("error");
      expect(body.tool).toBe(name);
      expect(body.message).toContain("boom from tool impl");
      expect(body.stack).toBeUndefined();
    }
  });

  it("EVERY registered handler OMITS isError on a successful return (AC #5 parity, no over-flagging)", async () => {
    setAllTools(() => ({ status: "success", message: "all good" }));

    for (const [, handler] of handlers) {
      const surfaced = await handler({});
      expect("isError" in surfaced).toBe(false);
    }
  });

  it("a healthy lifecycle status ('escalated') from the real seam is NOT flagged (D4)", async () => {
    setAllTools(() => ({ status: "escalated", message: "handed to user", progress: "table" }));

    for (const [, handler] of handlers) {
      const surfaced = await handler({});
      expect("isError" in surfaced).toBe(false);
    }
  });
});
