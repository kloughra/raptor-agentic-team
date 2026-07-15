---
slug: surface-tool-errors-to-openstory
status: draft
sprint: 16
---
# Surface Tool Errors to OpenStory — Failures as First-Class Events

## User Story
As an operator (and as any external observer such as OpenStory's error detector) watching a Raptor session, when a Raptor MCP tool cannot complete its intended task, I want that failure to be **machine-detectable at the tool-call boundary** — not disguised as a successful response — so that a clearly-failed session is reported as errored instead of as `[]`, and so that any downstream consumer keying off Raptor's record (starting with `notification-egress`, same sprint) can trust that a "failed" signal is real and never a swallowed error.

## Background

**Why this, why now.** OpenStory's error detector inspects the MCP tool-call boundary to find sessions that failed. Raptor tools currently return failures as an ordinary resolved value — `{status: "error", message: "..."}` — which the server then wraps as a **successful** MCP tool response. As a result, OpenStory (and any observer at that boundary) sees success even when the operation clearly failed, and reports `[]` errors for sessions that plainly did not succeed. This item makes tool failures **first-class**: surfaced as a detectable error signal rather than swallowed into a success envelope.

**Trust substrate for `notification-egress` (co-scheduled, same sprint).** `notification-egress` requires that a notification payload key off Raptor's *actual* recorded outcome, never an agent's self-report, so that a "failed" ping cannot be counterfeit. That guarantee is only meaningful if a failed tool invocation is actually **recorded as a failure** rather than absorbed into a success response. The two items are deliberately co-scheduled: this one makes failures first-class; `notification-egress` consumes them. (This spec does **not** implement notifications — see Out of Scope.)

### Verified current behavior (2026-07-12, current `main`)
- All 6 tools in `src/tools.ts` (`bootstrapProject`, `adoptProject`, `listProjects`, `getProjectStatus`, `runSprint`, `resumeSprintTool`) signal failure by **returning** a plain object `{status: "error", message: "..."}` (~19 such return sites, e.g. `tools.ts:209/217/231/241/315/537/665/686/692/732/739`). These are ordinary resolved values, not thrown errors.
- `src/index.ts` registers each tool and wraps the returned object as `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }` (lines 81/114/127/144, and the accumulated-content paths at 165/219). **No path sets `isError: true`** on the MCP result. Therefore a `{status: "error"}` return is delivered to the client as a *successful* tool call whose body happens to contain the word "error".
- Consequence: an external detector reading the tool-call boundary (result success/failure) cannot distinguish a failed invocation from a successful one without scraping the JSON prose — which is exactly why OpenStory reports `[]` for failed sessions.
- Inconsistency: some failure paths are **not** wrapped in `{status: "error"}` at all — e.g. an unguarded `git.init()` / `fs` throw inside `bootstrapProject` propagates as a real exception, which the MCP SDK *does* surface as an error. So failures are surfaced today only by accident of which paths happen to throw; the deliberate `{status: "error"}` returns are the swallowed ones.
- `run_sprint` returns `{ status: result.status, ... }` (`tools.ts:704`) where `result.status` can be `paused`, `escalated`, `complete`, `failed`, etc. from the orchestrator. These lifecycle statuses are wrapped identically to everything else — as a success envelope.

## Acceptance Criteria

1. **Tool failures are machine-detectable at the MCP boundary.** Every code path in which a Raptor MCP tool cannot complete its intended task produces an MCP tool result that an external observer can detect as a **failure** at the tool-call boundary (i.e. distinguishable from a success without parsing free-text prose). A session in which any tool fails MUST be classifiable as errored by a boundary-reading detector — no more "success envelope" for a `{status: "error"}` outcome.

2. **Structured, classifiable error signal.** On failure, the surfaced result carries a **structured** error indicator — at minimum a stable machine-readable status/flag plus the existing human-readable `message`, and, where already available, the failing tool's name and the project/sprint context. A detector must be able to classify "this call failed" from structured fields, not from string-matching the message text. (The exact mechanism — throw vs. an `isError`-flagged result vs. a structured error event — is an Architect decision; the observable contract is what's fixed here.)

3. **All existing `{status: "error"}` returns are covered.** Every deliberate `{status: "error", ...}` failure return across all 6 tools (enumerated in `src/tools.ts`) is surfaced per AC #1. No enumerated failure return is left delivered as a plain success MCP response. A coverage/conformance test asserts this (see AC #10) so a newly-added swallowed failure cannot silently regress.

4. **Unexpected exceptions are surfaced consistently.** An unexpected thrown exception inside a tool (e.g. an `fs`/`simple-git` failure not currently wrapped in a `{status: "error"}` return) is surfaced as a structured failure at the boundary — consistently with AC #1/#2, not as an opaque crash and never absorbed into a "success" response. After this feature, failures are surfaced the same way whether they originate as a `{status: "error"}` return or as a thrown exception.

5. **Success paths are byte-for-byte unchanged (backward-compatible).** When a tool **succeeds**, its MCP result is observably identical to today: same `{status, ...}` JSON body, same wrapping, no new failure flag, no new prompts, no behavior change. Consumers that parse the existing `{status, message}` JSON body continue to work unchanged — error surfacing is **additive** to the existing shape, not a replacement of it. A default/success parity assurance is required per TEAM.md QA rule 13 (proven the success path is unchanged).

6. **No failure is swallowed into a success envelope.** After this feature there is no path where a tool that failed (validation rejection, missing project, missing/empty backlog, I/O failure, thrown exception, etc.) is delivered to the client as a success-only result. "Failed operation ⇒ detectable failure signal" holds for every failure path.

7. **Trust substrate for `notification-egress`.** Because a failed tool invocation is now recorded as a first-class failure (not swallowed), an observer/notifier keying off Raptor's record can trust that a "failed" signal reflects an actual failure. This spec guarantees the *failure-is-first-class* property that `notification-egress` (AC #2 of that spec) depends on; it does not itself build notifications.

8. **`run_sprint` / `resume_sprint` outcome fidelity.** A terminal orchestrator **`failed`** (and a tool-level `{status: "error"}` short-circuit before the orchestrator runs — e.g. missing project, no backlog items) surfaces as a detectable failure per AC #1. Expected non-failure lifecycle statuses that are **not** errors — `complete`, `paused` (checkpoint reached), `in-progress` — MUST NOT be surfaced as failures (they are normal outcomes). Whether `escalated` counts as a failure signal for boundary-detection purposes is an Open Question for the Architect (see OQ #4); the default assumption is that `escalated` is an attention-needed state and its detector treatment must be a **recorded decision**, not an accidental mapping.

9. **No secret/PII leakage introduced.** Surfacing errors MUST NOT add any new sensitive content (absolute home paths beyond what today's messages already contain, tokens, webhook URLs, etc.) to the error signal. The structured error reuses the existing message text and known context fields; it does not widen what is exposed.

10. **Coverage/conformance + production-seam tests.** Regression tests drive the **real** surfacing seam — the actual tool registration/wrapping path in `src/index.ts` (or wherever the Architect places the surfacing), not a hand-rolled fake — and assert:
    - (a) each family of failure returns (invalid input, duplicate/missing project, missing/empty backlog, I/O/thrown failure) produces a detectable failure signal at the boundary;
    - (b) a **conformance test** guards AC #3 — no enumerated `{status: "error"}` return escapes surfacing (so a future swallowed failure fails the suite), analogous to the `config-keys-parsed-vs-declared` parsed-vs-declared conformance pattern;
    - (c) a **success parity** test proves a successful tool call's result is unchanged (AC #5);
    - (d) a non-failure lifecycle status (`complete`, `paused`) is NOT surfaced as a failure (AC #8).
    Each constraint-guarding test carries a **RED-verification note** per TEAM.md QA rule 12 (proven to FAIL against the current swallow-into-success behavior).

## Edge Cases
- **Failure path that already throws** (unguarded `git.init()`/`fs` in `bootstrapProject`). After this feature it is surfaced consistently with the `{status: "error"}` paths (AC #4) — the two must not diverge in how a detector sees them.
- **`run_sprint` returns `paused` (checkpoint) or `complete`.** These are normal outcomes and MUST NOT read as failures (AC #8) — the fix must not over-trigger and flag healthy runs as errored.
- **`run_sprint` returns `escalated`.** Attention-needed, not a hard failure. Treatment is an explicit recorded decision (OQ #4), not an accident of wrapping.
- **Error message contains the literal word "error" vs. structured flag.** Detection must rely on the structured signal (AC #2), not on the presence of the word "error" in prose, so a success message that merely mentions "error" is never misclassified as a failure.
- **A tool that partially succeeds** (e.g. `adopt_project` scaffolds some files then hits a best-effort context-discovery failure that today is intentionally non-fatal). Best-effort sub-steps that are *designed* not to fail the tool remain non-failures; only the tool's actual failure return is surfaced. This feature does not reclassify intentionally-tolerated sub-failures as tool failures.
- **Existing consumers that parse `{status, message}` JSON.** They keep working (AC #5) — the JSON body is not removed or restructured, only an additional detectable failure signal is added at the boundary.

## Out of Scope
- **Building `notification-egress` or any notification/Slack behavior.** This item only makes failures first-class so that item (and OpenStory) can consume them. Notifications are the separate Sprint 16 item.
- **Changing OpenStory itself / its detector code.** OpenStory is the motivating *consumer*; the deliverable is Raptor surfacing detectable failures at its own MCP boundary. No changes to OpenStory's repository.
- **Redefining the orchestrator lifecycle statuses** (`paused`/`escalated`/`complete`/`failed`) or the Sprint 13 truthful-completion contract. This item surfaces failures at the tool boundary; it does not change what those statuses mean or when they're reached.
- **Fixing `sprint-result-status-hardcoded-escalated`** (Inbox — the multi-feature finalization returns a hardcoded `"escalated"` label). Adjacent and may inform OQ #4, but it is a distinct tracked item and is not in this scope.
- **Restructuring the `{status, message}` response shape** or removing the JSON body. The change is additive (AC #5); no breaking change to the existing payload.
- **A general structured-logging / telemetry framework.** Only tool-boundary failure surfacing is in scope; broader observability is a future concern.
- **Retry/severity policy for surfaced errors.** Whether a surfaced error should be retried or how it maps to circuit-breaker behavior is unchanged by this item (the circuit breaker already governs agent-step retries independently).

## Open Questions
1. **Surfacing mechanism (throw vs. `isError` result vs. structured event).** The backlog phrases it as "either throw on failure or emit a structured error event." Which does the codebase adopt — set `isError: true` on the MCP `CallToolResult`, throw so the SDK produces a protocol error, or emit a distinct structured error event — while keeping the existing `{status, message}` body intact per AC #5? *Technical decision — Architect.*
2. **Single surfacing seam vs. per-tool.** Is failure surfacing centralized (one wrapper at the `index.ts` registration layer that inspects the returned `{status}` and/or catches throws) or applied per tool? PO intent: prefer a single choke-point so no future tool can forget to surface, consistent with the AC #10(b) conformance guard. *Architect to decide.*
3. **What counts as a "failure" `status` value.** Today failure is signalled by `status === "error"`. Are there other tool return statuses that should count as failures (or should the set be explicitly enumerated so the surfacing wrapper is precise)? *Architect/QA to enumerate against `tools.ts`.*
4. **`escalated` detector treatment (AC #8 / Edge Case).** Should a terminal `escalated` sprint surface as a failure signal, an attention-needed signal distinct from failure, or neither, at the boundary? Whatever is chosen must be a **recorded decision** (not accidental). *Architect, with PO sign-off on the observable intent.*
5. **Verifying the OpenStory-side outcome.** Can we assert end-to-end that OpenStory's detector now classifies a failed session (rather than only asserting Raptor's boundary emits a detectable signal)? PO intent: the testable contract is at Raptor's MCP boundary (AC #10); an OpenStory-side check is a nice-to-have, not a gate. *QA to confirm the boundary contract is sufficient coverage.*
