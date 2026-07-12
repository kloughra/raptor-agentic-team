/**
 * error-surfacing — surface tool failures as first-class MCP boundary events.
 *
 * Spec:         docs/specs/surface-tool-errors-to-openstory.md (AC 1–10)
 * Architecture: docs/architecture/surface-tool-errors-to-openstory.md (D1–D4)
 *
 * Today every Raptor MCP tool signals failure by RETURNING a plain object
 * `{status: "error", message: "..."}`. The registration layer in `src/index.ts`
 * wraps that object as `{ content: [{ type:"text", text: JSON.stringify(...) }] }`
 * and NEVER sets `isError`, so a boundary-reading detector (OpenStory) sees a
 * failed call as a SUCCESS. This module is the single surfacing seam: it
 * inspects the tool's returned `status` and sets `isError: true` on the
 * `CallToolResult` for failure statuses — WITHOUT removing or restructuring the
 * existing `{status, message}` JSON body.
 *
 * Design decisions (recorded in the architecture):
 *   D1 — mechanism: MCP-native `isError: true` (not throw, not a bespoke event).
 *   D2 — single choke-point at the index.ts registration layer.
 *   D3 — enumerated, CLOSED failure set: {"error", "failed"}. Unknown statuses
 *        default to NOT-a-failure rather than silently over-flagging.
 *   D4 — "escalated" is attention-needed, NOT a boundary failure by default.
 *
 * Pure, synchronous, dependency-free — trivially unit-testable and reusable by
 * `index.ts` and any future consumer (e.g. notification-egress).
 */

/** A single MCP text-content block. */
export interface TextContent {
  type: "text";
  text: string;
}

/**
 * The shape returned to the MCP SDK. `isError` is OMITTED on success (AC #5
 * byte-parity) and set to the literal `true` on failure — never `false`.
 */
export interface SurfacedResult {
  content: TextContent[];
  isError?: true;
  /**
   * Index signature mirrors the MCP SDK's `CallToolResult` (which carries
   * `[x: string]: unknown`) so a `SurfacedResult` is directly assignable to a
   * registered-handler return type. It adds no actual keys — success results
   * still OMIT `isError` entirely (AC #5 byte-parity).
   */
  [key: string]: unknown;
}

/**
 * D3 — the enumerated, closed set of tool-result status values that count as a
 * FAILURE at the MCP boundary.
 *   - "error"  : every deliberate `{status:"error"}` CRUD short-circuit in tools.ts
 *   - "failed" : terminal orchestrator outcome from run_sprint / resume_sprint
 *
 * Deliberately EXCLUDES "success", "complete", "paused", "in-progress", and
 * "escalated" (D4). A new failure-bearing status must be added here explicitly.
 */
export const FAILURE_STATUSES: ReadonlySet<string> = new Set<string>(["error", "failed"]);

/**
 * Classify an outcome from its STRUCTURED status field only — never from message
 * prose (a success message mentioning the word "error" must not be flagged).
 * Non-string / absent statuses are not failures.
 */
export function isFailureStatus(status: unknown): boolean {
  return typeof status === "string" && FAILURE_STATUSES.has(status);
}

/**
 * Wrap an already-assembled MCP `content[]` for a tool result. On a failure
 * status, sets `isError: true`; on any other outcome, returns `{ content }`
 * with NO `isError` key at all (byte-for-byte parity with today's wrapping).
 *
 * The `content` array is passed straight through — the `{status, message}` JSON
 * body is preserved unchanged (AC #5, additive-only).
 */
export function surfaceOutcome(
  result: { status?: unknown } | Record<string, unknown>,
  content: TextContent[]
): SurfacedResult {
  const status = (result as { status?: unknown }).status;
  if (isFailureStatus(status)) {
    return { content, isError: true };
  }
  return { content };
}

/**
 * Build a structured failure result for a caught exception (AC #4). The body is
 * `{ status: "error", tool, message }` — MESSAGE ONLY, never the stack trace
 * (AC #9: no PII/secret widening). A thrown failure is thereby indistinguishable
 * from a `{status:"error"}` return to a boundary detector.
 */
export function buildThrownErrorResult(toolName: string, err: unknown): SurfacedResult {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err);
  const body = { status: "error", tool: toolName, message };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}
