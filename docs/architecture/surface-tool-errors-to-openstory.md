---
slug: surface-tool-errors-to-openstory
spec: docs/specs/surface-tool-errors-to-openstory.md
---
# Surface Tool Errors to OpenStory — Architecture Design

## Overview

Today every Raptor MCP tool signals failure by **returning** a plain object
`{status: "error", message: "..."}` (~19 sites in `src/tools.ts`). The
registration layer in `src/index.ts` wraps that object as
`{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }` and
**never sets `isError`**. The MCP SDK therefore delivers the call as a
*successful* tool result whose body merely contains the word "error". A
boundary-reading detector (OpenStory) cannot tell failure from success, so it
reports `[]` for sessions that plainly failed.

This design makes tool failures **first-class** at the MCP tool-call boundary by
adding a **single surfacing seam** at the `index.ts` registration layer. The seam
inspects each tool's returned `status` and, on a failure status, sets
`isError: true` on the `CallToolResult` — **without** removing or restructuring
the existing `{status, message}` JSON body. It also wraps each handler in a
try/catch so a thrown exception is surfaced identically to a `{status: "error"}`
return. Success results are emitted **byte-for-byte unchanged** (no `isError`
key at all).

The change is deliberately **additive and centralized**: one choke-point no
future tool can forget, guarded by a conformance test analogous to the
`config-keys-parsed-vs-declared` parsed-vs-declared guard.

**Design principle — the observable contract is fixed; the mechanism is chosen
here.** Per the spec, the Architect selects the surfacing mechanism. We choose the
MCP-native `isError` result flag over throwing or a bespoke event — rationale in
Technology Choices and the ADR-worthy decisions below.

## Components

### New module — `src/error-surfacing.ts` (pure, no I/O)
The entire policy lives in one small, dependency-free, synchronous module so it
is trivially unit-testable and reusable by both `index.ts` and any future
consumer (e.g. `notification-egress`).

- `FAILURE_STATUSES: ReadonlySet<string>` — the enumerated set of tool-result
  status values that count as a **failure** at the boundary. Initial contents:
  `"error"` (all CRUD short-circuits) and `"failed"` (terminal orchestrator
  outcome). **Not** included: `"success"`, `"complete"`, `"paused"`,
  `"in-progress"`, `"escalated"` (see Decision D4).
- `isFailureStatus(status: unknown): boolean` — `typeof status === "string" &&
  FAILURE_STATUSES.has(status)`. Classifies from the **structured** field, never
  from message prose (Edge Case: a success message mentioning "error").
- `surfaceOutcome(result, content): { content; isError?: true }` — given a raw
  tool result object (carrying `status`) and the already-assembled MCP
  `content[]`, returns `{ content }` on success (**no `isError` key** — byte
  parity, AC #5) or `{ content, isError: true }` on failure (AC #1/#2).
- `buildThrownErrorResult(toolName, err): { content; isError: true }` —
  constructs a structured failure result for a caught exception. Body is
  `{ status: "error", tool: toolName, message: <err.message> }` (message only —
  never the stack — per AC #9). Sets `isError: true`.

### Modified — `src/index.ts` (the seam)
Each of the 6 `server.tool(...)` handlers is wrapped uniformly:

```ts
async (args) => {
  try {
    const result = await <toolFn>(ctx, args);
    const content = buildContent(result);   // existing per-tool content logic
    return surfaceOutcome(result, content); // adds isError iff status is a failure
  } catch (err) {
    return buildThrownErrorResult("<tool_name>", err); // AC #4 consistency
  }
}
```

- For the four JSON-stringify tools (`bootstrap_project`, `adopt_project`,
  `list_projects`, `get_project_status`), `buildContent` is the existing single
  `JSON.stringify(result, null, 2)` block — **unchanged**.
- For `run_sprint` / `resume_sprint`, `buildContent` is the existing
  progress/checkpoint/message assembly — **unchanged**; only the final return is
  routed through `surfaceOutcome(result, ...)` using `result.status`.

### Unchanged — `src/tools.ts`
No tool implementation changes. The ~19 `{status: "error"}` return sites and all
success returns stay exactly as they are. Surfacing is a boundary concern, not a
per-tool concern — this is what makes the conformance guarantee possible.

## Data Model

**No persisted state. No schema migration.** This feature touches only the
in-flight MCP `CallToolResult` shape at the boundary.

MCP `CallToolResult` (SDK type, already in use) — the additive field:

| Field | Today | After |
|-------|-------|-------|
| `content` | `[{ type: "text", text }]` | **unchanged** |
| `isError` | never set (implicit `false`) | set to `true` **only** on failure paths; **absent** on success |

The `{status, message, ...}` JSON body carried inside `content[0].text` is
**not** removed or restructured (AC #5, Out-of-Scope "no shape change"). Existing
consumers that parse the JSON body keep working; the new signal is the
boundary-level `isError` flag.

## API Contracts

### Outcome classification (fixed observable contract)

| Origin | Example | Boundary result |
|--------|---------|-----------------|
| CRUD tool `{status:"error"}` return | project not found, duplicate, missing/empty backlog, invalid input | `isError: true` + body preserved |
| Thrown exception in a tool | unguarded `git.init()` / `fs` throw in `bootstrapProject` | `isError: true` + `{status:"error",tool,message}` body |
| Orchestrator terminal `failed` | `run_sprint` → `result.status === "failed"` | `isError: true` + body preserved |
| Orchestrator `complete` | sprint finished | success — **no `isError`** |
| Orchestrator `paused` | checkpoint reached | success — **no `isError`** |
| Orchestrator `in-progress` | mid-run | success — **no `isError`** |
| Orchestrator `escalated` | circuit-breaker handoff to user | **no `isError`** (attention-needed, Decision D4) |
| Any tool `{status:"success"}` | CRUD ok | success — **byte-for-byte unchanged** |

### Recorded decisions (resolve the spec's Open Questions)

- **D1 — Surfacing mechanism (OQ #1): set `isError: true` on the
  `CallToolResult`.** Not throwing, not a bespoke event. Throwing turns the
  result into an SDK protocol error and discards the structured `{status,
  message}` body (violates AC #5); `isError` is MCP-native, keeps the body
  intact, and is exactly the boundary signal a detector reads.
- **D2 — Single choke-point (OQ #2): one seam at `index.ts` registration.** Not
  per-tool. A centralized wrapper means no future tool can forget to surface, and
  it is what the AC #10(b) conformance test pins.
- **D3 — Failure status set (OQ #3): enumerate `{"error", "failed"}`.** Precise
  and closed — the surfacing wrapper is explicit about what counts, so a new,
  unmapped status defaults to *not-a-failure* rather than silently over-flagging.
  Any future failure-bearing status is added to `FAILURE_STATUSES` deliberately.
- **D4 — `escalated` treatment (OQ #4): `escalated` does NOT set `isError`.** It
  is an attention-needed circuit-breaker handoff to the user, truthfully recorded
  in sprint state — not a swallowed error. Flagging it as a boundary failure
  would over-trigger on healthy escalations. **This is a recorded decision, not
  an accidental mapping**, and per the spec it requires **PO sign-off on the
  observable intent** (flagged in Constraints). If the stakeholder wants
  escalations detectable, the one-line change is adding `"escalated"` to
  `FAILURE_STATUSES` — but the default shipped here is *not-a-failure*.

## Non-Functional Requirements

- **Backward compatibility (AC #5) — hard NFR.** Success-path
  `CallToolResult` is byte-for-byte identical to today: same `content`, no
  `isError` key (omitted, not `false`). A default/success parity test proves this
  (TEAM.md QA rule 13). RED-verification: the test must fail if `surfaceOutcome`
  ever attaches `isError` (even `false`) to a success result.
- **Completeness (AC #3/#6).** Every enumerated `{status:"error"}` return and
  every thrown exception across all 6 tools surfaces as a failure. Guarded by a
  conformance test that walks the tool set — a newly-added swallowed failure
  fails the suite.
- **Security / no PII widening (AC #9).** The failure signal reuses existing
  message text and known context fields only. The thrown-error path emits
  `err.message` — **never** `err.stack` — so it exposes no more than today's
  `main().catch(err => console.error(..., err.message))`. No tokens, webhook
  URLs, or new absolute paths are introduced.
- **Determinism / no LLM.** Classification is pure string/set logic — no model
  calls, no async beyond the wrapped handler, negligible latency (single `Set`
  lookup per call).
- **No over-trigger (AC #8).** `complete` / `paused` / `in-progress` /
  `escalated` never read as failures — verified by an explicit lifecycle test.
- **Isolation.** Zero new dependencies; zero persisted state; zero orchestrator
  or `tools.ts` behavior change. Blast radius is `index.ts` wrapping +
  `error-surfacing.ts`.
- **Testability at the real seam (AC #10).** Tests drive the actual `index.ts`
  registration/wrapping path (or the exported `surfaceOutcome` /
  `buildThrownErrorResult` invoked exactly as the seam invokes them), not a
  hand-rolled fake.

## Technology Choices

*Presented for user approval — no new technology is adopted; all choices reuse
the existing stack.*

- **Surfacing mechanism:** MCP-native `isError: true` on `CallToolResult`
  (`@modelcontextprotocol/sdk` ^1.12.1, already a dependency). **Chosen over**
  throwing (loses structured body, changes shape) and a custom structured event
  (non-standard, not what a boundary detector reads).
- **Language / runtime:** TypeScript on Node.js (existing).
- **Classification logic:** plain TypeScript — a module-level `ReadonlySet` and
  pure functions in `src/error-surfacing.ts` (mirrors the `parseModels` /
  `FAILURE_STATUSES`-style plain-TS pattern from Sprint 12/14).
- **Error handling:** native `try/catch` around each registered handler; emit
  `err.message` only.
- **Tests:** jest / ts-jest — colocated unit (`src/error-surfacing.test.ts`) +
  production-seam integration
  (`tests/integration/surface-tool-errors-to-openstory.integration.test.ts`) +
  BDD (`tests/bdd/surface-tool-errors-to-openstory.feature`) + a conformance
  test guarding AC #3.
- **No new runtime dependencies.** No config surface added.

## Constraints & Patterns

- **Additive-only, byte-for-byte success parity.** Success results MUST omit
  `isError` entirely (not set it to `false`). This is the load-bearing invariant
  (AC #5) — pin it on the seam, not just the pure function.
- **Single surfacing seam (D2).** All surfacing lives in `index.ts` via
  `surfaceOutcome` / `buildThrownErrorResult`. No per-tool `isError` logic in
  `tools.ts`. A new tool added later is surfaced automatically only if it routes
  through the same wrapper — the conformance test enforces this.
- **Classify from structured `status`, never prose.** `isFailureStatus` reads the
  `status` field only; a success message containing the word "error" is never
  misclassified (Edge Case).
- **Enumerated, closed failure set (D3).** `FAILURE_STATUSES = {"error",
  "failed"}`. Unknown/new statuses default to not-a-failure until deliberately
  added.
- **`escalated` is not a failure by default (D4)** — **requires PO/user sign-off
  on the observable intent** before demo. This is the one decision in this design
  that the stakeholder must ratify; everything else is a technical call within the
  spec's fixed contract.
- **Best-effort sub-steps stay non-failures.** Intentionally-tolerated sub-step
  failures (e.g. `adopt_project`'s non-fatal context-discovery) are not
  reclassified — only a tool's actual failure *return* or a thrown exception is
  surfaced (Edge Case).
- **No PII widening; `message` not `stack`.** Thrown-error surfacing uses
  `err.message` only (AC #9).
- **Out of scope (honored):** building `notification-egress`; changing OpenStory
  or its detector; redefining orchestrator lifecycle statuses or the Sprint 13
  truthful-completion contract; restructuring the `{status, message}` body;
  fixing `sprint-result-status-hardcoded-escalated`; a general telemetry
  framework; retry/severity policy.
- **Trust substrate (AC #7).** This design guarantees *failure-is-first-class* at
  the boundary so `notification-egress` (same sprint) can key a "failed" ping off
  Raptor's actual recorded outcome — it does not itself build notifications.
