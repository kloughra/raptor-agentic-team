Feature: Blocker-marker false positive in agent output — line-anchored, fence/quote-aware detection
  As a sprint operator running Raptor
  I want a [BLOCKER] marker to trigger escalation only when an agent is genuinely raising a blocker
  And not when the agent merely quotes, documents, or diagrams the marker string
  So that a step that produced correct work (a demo, a spec, a decision-pipeline diagram) is not
  falsely escalated, forcing a needless redo or manual state edit

  # Spec:         docs/specs/blocker-marker-false-positive-in-agent-output.md
  # Architecture: docs/architecture/blocker-marker-false-positive-in-agent-output.md
  #
  # Design invariant under test (the one-sentence contract):
  #   A line qualifies as a genuine [BLOCKER] marker iff — after trimStart() — it
  #   matches /^\[blocker\]/i AND is not inside a fenced code block (``` or ~~~)
  #   AND is not a blockquote (does not begin with '>'). Anything else that merely
  #   *contains* the literal marker string is NOT a blocker.
  #
  # Production specimen this feature guards against recurring:
  #   Sprint 12 step 8 (Demo, commit b4c5ffb): demo presentation quoted a
  #   decision-pipeline diagram containing the literal marker → false [ESCALATE].
  #
  # This feature changes ONLY *what counts as* a blocker marker — never what
  # happens once one is detected (escalation mechanics, [ESCALATE] commit format,
  # retry/circuit-breaker pipeline, and SprintState schema are all frozen).

  Background:
    Given a registered Raptor project with a sprint in progress
    And the hardened blocker-marker detector lives in src/orchestrator/blocker-marker.ts
    And both runner seams (single-feature and multi-feature) route through the same detector

  # ───────────────────────── AC 1, AC 5 — line-anchored, case-insensitive ─────────────────────────

  Scenario: A genuine line-anchored marker is detected
    Given agent output whose first line is "[BLOCKER] QA: cannot find spec"
    When hasBlockerMarker evaluates the output
    Then it returns true

  Scenario: A marker embedded mid-sentence in prose is NOT a blocker (AC 1)
    Given agent output containing "...if the agent writes [BLOCKER] then it escalates..."
    And the marker never appears at the start of any line
    When hasBlockerMarker evaluates the output
    Then it returns false

  Scenario Outline: Case-insensitivity is preserved for line-anchored markers (AC 5)
    Given agent output whose first line is "<marker> QA: blocked"
    When hasBlockerMarker evaluates the output
    Then it returns true

    Examples:
      | marker    |
      | [BLOCKER] |
      | [blocker] |
      | [Blocker] |

  Scenario: A line-anchored marker with leading whitespace or a tab still counts (edge case)
    Given agent output whose only marker line is "    [BLOCKER] engineer: build broke" indented with spaces or a tab
    And that line is not inside a fence or a blockquote
    When hasBlockerMarker evaluates the output
    Then it returns true

  Scenario: A line-anchored marker with trailing text on the same line counts (edge case)
    Given agent output whose first line is "[BLOCKER] QA: cannot find spec"
    When hasBlockerMarker evaluates the output
    Then it returns true

  # ───────────────────────── AC 2 — fenced code blocks suppressed ─────────────────────────

  Scenario: A marker that appears only inside a triple-backtick fence is ignored (AC 2)
    Given agent output whose only marker sits on a line inside a ``` ```-delimited code block
    When hasBlockerMarker evaluates the output
    Then it returns false

  Scenario: A marker that appears only inside a tilde fence is ignored (AC 2)
    Given agent output whose only marker sits on a line inside a ~~~-delimited code block
    When hasBlockerMarker evaluates the output
    Then it returns false

  Scenario: The Sprint 12 demo specimen no longer escalates (AC 2, AC 8 regression)
    Given a demo-style agent output whose ONLY [BLOCKER] occurrence is inside a fenced decision-pipeline diagram
    When hasBlockerMarker evaluates the output
    Then it returns false

  # ───────────────────────── AC 3 — blockquotes suppressed ─────────────────────────

  Scenario: A marker inside a Markdown blockquote is ignored (AC 3)
    Given agent output whose only marker line begins with "> [BLOCKER] QA: example"
    When hasBlockerMarker evaluates the output
    Then it returns false

  # ───────────────────────── AC 4 — genuine blockers still escalate at the seams ─────────────────────────

  Scenario: A genuine line-anchored blocker still escalates at the single-feature seam (AC 4, AC 9)
    Given a single-feature sprint parked at an agent step
    And the agent emits "[BLOCKER] QA: cannot locate the spec" at the start of a line
    When the runner runs that step
    Then the step status becomes "escalated"
    And an "[ESCALATE]" commit is created
    And the sprint parks as "escalated"
    And the escalation mechanics are byte-for-byte identical to today

  Scenario: A demo-style quoted marker does NOT escalate at the single-feature seam (AC 9)
    Given a single-feature sprint parked at an agent step
    And the agent output quotes the marker only inside a fenced diagram
    When the runner runs that step
    Then no "[ESCALATE]" commit is created for that step
    And the step is not marked "escalated"
    And the sprint proceeds past that step

  Scenario: A genuine line-anchored blocker still escalates at the multi-feature seam (AC 4, AC 9)
    Given a multi-feature sprint parked at an agent step
    And a feature's agent emits "[BLOCKER]" at the start of a line
    When the dispatcher runs that step
    Then that feature's status becomes "escalated"
    And an "[ESCALATE]" commit names that feature
    And the sprint parks as "escalated"

  Scenario: A demo-style quoted marker does NOT escalate at the multi-feature seam (AC 9)
    Given a multi-feature sprint parked at an agent step
    And every feature's agent output quotes the marker only inside a fence
    When the dispatcher runs that step
    Then no feature is marked "escalated" for a blocker
    And no blocker-driven "[ESCALATE]" commit is created

  # ───────────────────────── Edge cases — conservative bias & robustness ─────────────────────────

  Scenario: Multiple markers where at least one is a genuine line-anchored raise → escalates (edge case)
    Given agent output that quotes the marker inside a fence AND also emits it at the start of a later line
    When hasBlockerMarker evaluates the output
    Then it returns true

  Scenario: An unclosed fence suppresses the remainder conservatively (edge case)
    Given agent output that opens a ``` fence and never closes it
    And a "[BLOCKER]" line appears after the opening fence
    When hasBlockerMarker evaluates the output
    Then it returns false

  Scenario: Empty output is never a blocker (edge case)
    Given empty agent output
    When hasBlockerMarker evaluates the output
    Then it returns false

  Scenario Outline: Line-anchoring works for both CRLF and LF line endings (edge case)
    Given agent output using "<ending>" line endings with a genuine "[BLOCKER]" first line
    When hasBlockerMarker evaluates the output
    Then it returns true

    Examples:
      | ending |
      | LF     |
      | CRLF   |

  Scenario: Detection never throws on untrusted input (reliability NFR)
    Given arbitrary untrusted agent output including huge, binary-ish, and mixed-line-ending strings
    When hasBlockerMarker evaluates the output
    Then it returns a boolean and never throws

  # ───────────────────────── AC 6 — git-parser commit-message hardening ─────────────────────────

  Scenario: A commit whose marker is only inside a fenced body is not parsed as a blocker (AC 6)
    Given a git commit message that quotes "[BLOCKER] QA: x -- blocked on PO" only inside a fenced code block
    When parseBlockers reads the log
    Then it returns zero blocker entries

  Scenario: The orchestrator's own escalation commit is one escalation and zero blockers (AC 6)
    Given the orchestrator's commit "[ESCALATE] QA: step 7 (Run test suite) — agent raised [BLOCKER]: ..."
    When parseBlockers and parseEscalations read the log
    Then parseBlockers returns zero blocker entries
    And parseEscalations returns exactly one escalation entry

  Scenario: A genuine line-anchored blocker commit is still parsed (AC 6, no-regression)
    Given a git commit message beginning with "[BLOCKER] QA: cannot find spec -- blocked on PO"
    When parseBlockers reads the log
    Then it returns exactly one blocker entry with role "QA" blocked on "PO"

  # ───────────────────────── AC 7 — no change to escalation semantics or schema ─────────────────────────

  Scenario: Escalation semantics and state schema are unchanged (AC 7)
    Given the hardened detector is in place
    Then the [ESCALATE] commit format is unchanged
    And the early-return / {kind:"blocker"} contract is unchanged
    And the SprintState schema is unchanged
    And no persisted state is migrated

  # ───────────────────────── Performance NFR ─────────────────────────

  Scenario: Detection is bounded on a very large output (performance NFR)
    Given a ~1 MB synthetic agent output
    When hasBlockerMarker evaluates the output
    Then it completes well under the performance budget with a single linear pass
