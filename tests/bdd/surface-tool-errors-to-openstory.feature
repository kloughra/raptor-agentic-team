Feature: Surface Tool Errors to OpenStory — Failures as First-Class Events
  As an operator (and any boundary-reading observer such as OpenStory's error detector)
  I want a Raptor MCP tool that cannot complete its task to be machine-detectable as a failure
  at the tool-call boundary — not disguised as a successful response
  So that a clearly-failed session is reported as errored instead of as [], and any downstream
  consumer (starting with notification-egress) can trust that a "failed" signal is real.

  # Spec:         docs/specs/surface-tool-errors-to-openstory.md (AC 1–10)
  # Architecture: docs/architecture/surface-tool-errors-to-openstory.md (D1–D4)
  #
  # OBSERVABLE CONTRACT (fixed by the spec; mechanism chosen by the Architect = D1):
  #   Failure  ⇒ CallToolResult carries isError: true, structured {status,...} body preserved.
  #   Success  ⇒ CallToolResult is byte-for-byte unchanged — NO isError key at all (omitted,
  #              not false). This is the load-bearing backward-compat invariant (AC #5).
  #
  # SINGLE SEAM (D2): one choke-point at the src/index.ts registration layer via
  #   surfaceOutcome() / buildThrownErrorResult() from src/error-surfacing.ts. No per-tool
  #   isError logic in tools.ts; tools.ts is unchanged.
  #
  # FAILURE STATUS SET (D3): enumerated, closed — FAILURE_STATUSES = {"error", "failed"}.
  #   A new/unknown status defaults to NOT-a-failure rather than silently over-flagging.
  #
  # ESCALATED (D4): "escalated" is an attention-needed handoff, NOT a boundary failure by
  #   default (recorded decision requiring PO sign-off; the one-line flip is adding it to
  #   FAILURE_STATUSES).
  #
  # RED-VERIFICATION (TEAM.md QA rule 12): every constraint-guarding scenario below is RED
  #   against current `main`, where index.ts wraps every return as
  #   { content: [{ type:"text", text: JSON.stringify(result) }] } and NEVER sets isError —
  #   so a {status:"error"} return is delivered as a SUCCESSFUL tool call. Proven by:
  #   (a) surfaceOutcome/buildThrownErrorResult do not yet exist → import fails RED; and
  #   (b) conceptually, a surfaceOutcome that always returned {content} (today's swallow)
  #       fails every "detectable failure" assertion.

  Background:
    Given the 6 Raptor MCP tools each return a plain object carrying a "status" field
    And on current main src/index.ts wraps every returned object without ever setting isError
    And a boundary-reading detector classifies a call as failed only from a structured signal, never from message prose

  # ---------------------------------------------------------------------------
  # AC #1, #2, #6 — failures are machine-detectable and structured at the boundary
  # ---------------------------------------------------------------------------

  Scenario: A tool's {status:"error"} return surfaces as a detectable boundary failure
    Given a tool invocation returns { status: "error", message: "..." }
    When the surfacing seam wraps the result
    Then the CallToolResult has isError set to true
    And the structured { status, message } JSON body is preserved unchanged inside content
    And a detector can classify the call as failed from isError alone, without parsing prose

  Scenario Outline: Every family of failure return is surfaced as a boundary failure
    Given the tool "<tool>" is invoked so that it returns { status: "error" } because of "<reason>"
    When the surfacing seam wraps the result
    Then the CallToolResult has isError set to true

    Examples:
      | tool               | reason                          |
      | bootstrap_project  | invalid project name            |
      | bootstrap_project  | duplicate project               |
      | adopt_project      | path does not exist             |
      | get_project_status | project not found               |
      | run_sprint         | project not found               |
      | run_sprint         | no backlog items for the sprint |
      | run_sprint         | no backlog.md file present      |
      | resume_sprint      | project not found               |

  # ---------------------------------------------------------------------------
  # AC #4 — thrown exceptions are surfaced consistently with {status:"error"} returns
  # ---------------------------------------------------------------------------

  Scenario: An unexpected thrown exception inside a tool surfaces as a structured boundary failure
    Given a tool handler throws an unexpected exception (e.g. an fs / simple-git failure)
    When the surfacing seam catches it
    Then the CallToolResult has isError set to true
    And the body is a structured { status: "error", tool, message } object
    And the failing tool's name is carried in the structured body
    And a thrown failure and a {status:"error"} return are indistinguishable to a boundary detector

  # ---------------------------------------------------------------------------
  # AC #5, #10c — success paths are byte-for-byte unchanged (backward compatible)
  # ---------------------------------------------------------------------------

  Scenario: A successful tool call is byte-for-byte unchanged and carries no failure flag
    Given a tool invocation returns { status: "success", ... }
    When the surfacing seam wraps the result
    Then the CallToolResult does NOT contain an isError key at all
    And isError is omitted, not merely set to false
    And the content is byte-for-byte identical to today's JSON.stringify wrapping

  Scenario: A success message that merely mentions the word "error" is not misclassified
    Given a tool returns { status: "success", message: "completed with no error" }
    When the surfacing seam classifies the outcome
    Then the CallToolResult does NOT contain an isError key
    # Detection reads the structured status field only, never the message prose

  # ---------------------------------------------------------------------------
  # AC #8, #10d — run_sprint / resume_sprint outcome fidelity (no over-triggering)
  # ---------------------------------------------------------------------------

  Scenario: A terminal orchestrator "failed" surfaces as a boundary failure
    Given run_sprint returns { status: "failed", ... }
    When the surfacing seam wraps the result
    Then the CallToolResult has isError set to true

  Scenario Outline: Normal lifecycle statuses are NOT surfaced as failures
    Given run_sprint returns { status: "<status>", ... }
    When the surfacing seam wraps the result
    Then the CallToolResult does NOT contain an isError key

    Examples:
      | status      |
      | complete    |
      | paused      |
      | in-progress |

  Scenario: "escalated" is attention-needed, not a boundary failure by default (Decision D4)
    Given run_sprint returns { status: "escalated", ... }
    When the surfacing seam wraps the result
    Then the CallToolResult does NOT contain an isError key
    # Recorded decision D4 — requires PO sign-off; flipping it is a one-line FAILURE_STATUSES add

  # ---------------------------------------------------------------------------
  # AC #3, #10b — conformance: no enumerated {status:"error"} return escapes surfacing
  # ---------------------------------------------------------------------------

  Scenario: The failure-status set is enumerated, closed, and covers every {status:"error"} return
    Given the exported FAILURE_STATUSES set
    Then it contains exactly "error" and "failed"
    And it does NOT contain "success", "complete", "paused", "in-progress", or "escalated"
    And every "status: \"error\"" return literal enumerated in src/tools.ts is a member of FAILURE_STATUSES
    # A future swallowed failure (a new error return whose status is not covered) fails this guard

  Scenario: Classification reads the structured status field, never message prose
    Given the exported isFailureStatus classifier
    Then isFailureStatus("error") is true
    And isFailureStatus("failed") is true
    And isFailureStatus("success") is false
    And isFailureStatus("escalated") is false
    And isFailureStatus(undefined) is false
    And isFailureStatus(42) is false

  # ---------------------------------------------------------------------------
  # AC #9 — no secret / PII leakage introduced
  # ---------------------------------------------------------------------------

  Scenario: The thrown-error path emits the message only, never the stack trace
    Given a tool handler throws an Error with a message and a multi-line stack
    When buildThrownErrorResult constructs the surfaced failure
    Then the structured body contains the error message
    And the structured body does NOT contain the stack trace
    And no new tokens, webhook URLs, or absolute paths beyond today's messages are exposed

  # ---------------------------------------------------------------------------
  # Edge Case — best-effort sub-steps stay non-failures
  # ---------------------------------------------------------------------------

  Scenario: A tool that partially succeeds still surfaces as success
    Given adopt_project scaffolds files then tolerates a best-effort context-discovery failure
    And the tool's actual return is { status: "success", ... }
    When the surfacing seam wraps the result
    Then the CallToolResult does NOT contain an isError key
    # Only the tool's actual failure return or a thrown exception is surfaced — not tolerated sub-failures
