Feature: Retro improvements are never silently dropped from TEAM.md
  Spec:         docs/specs/retro-improvements-not-applied.md
  Architecture: docs/architecture/retro-improvements-not-applied.md

  As a Raptor user who reviews sprint retrospectives and adopts improvement proposals,
  I want every proposal I adopt at the retro-review checkpoint to either be visibly
  applied to TEAM.md or explicitly reported as unplaceable, so that my process
  improvements actually take effect instead of being silently dropped while the
  sprint reports success.

  Terminology (from the approved architecture):
    - "applied"           — inserted at the proposal's matched target section
    - "applied-fallback"  — inserted under "## Adopted Retro Improvements (Unplaced)"
    - "already-present"   — the exact rendered block already exists (re-run/resume)
    - "unplaced"          — not written; reserved for failures beyond section
                            matching (e.g. TEAM.md unreadable), with a reason

  Background:
    Given a Raptor project scaffolded from the bundled TEAM.md template
    And sprint 1 has completed steps 1 through 12
    And the retro collected proposals stored in sprint state
    And the retro-review checkpoint was resolved with user feedback selecting proposals

  # ───────────────────────────────────────────────────────────────────────────
  # AC 1 — No silent drop: the outcome-total invariant
  # ───────────────────────────────────────────────────────────────────────────

  @ac1 @invariant
  Scenario: Every adopted proposal ends step 13 with exactly one recorded outcome
    Given the user adopted 3 proposals at the retro-review checkpoint
    When step 13 "Apply retro improvements" executes
    Then exactly 3 proposal outcomes are recorded, in proposal order
    And each outcome has a placement of "applied", "applied-fallback", "already-present", or "unplaced"
    And no adopted proposal vanishes without a recorded outcome

  @ac1 @invariant @io-failure
  Scenario: Outcome-total invariant holds even when TEAM.md is unreadable
    Given the user adopted 2 proposals at the retro-review checkpoint
    And TEAM.md cannot be read from disk
    When step 13 "Apply retro improvements" executes
    Then the step does not throw and the sprint run completes
    And exactly 2 proposal outcomes are recorded
    And every outcome has placement "unplaced" with the I/O error as its reason
    And the step completion visible to the caller is qualified with the unplaced count
    And no "[PO] update: apply retrospective improvements" commit is created

  # ───────────────────────────────────────────────────────────────────────────
  # AC 2 — Section miss falls back instead of dropping
  # ───────────────────────────────────────────────────────────────────────────

  @ac2 @fallback
  Scenario: A proposal whose Section matches no TEAM.md heading lands at the fallback section
    Given an adopted proposal targeting section "Product Owner responsibilities"
    And no TEAM.md heading normalizes to "Product Owner responsibilities"
    When step 13 "Apply retro improvements" executes
    Then the proposal text is present in TEAM.md under "## Adopted Retro Improvements (Unplaced)"
    And the fallback entry attributes the proposal with its sprint number, role, and target section
    And the proposal's outcome is "applied-fallback" with placedAt "Adopted Retro Improvements (Unplaced)"

  @ac2 @fallback @edge
  Scenario: All adopted proposals unplaceable — every one lands at the fallback
    Given all 3 adopted proposals target sections that match no TEAM.md heading
    When step 13 "Apply retro improvements" executes
    Then all 3 proposals are present under "## Adopted Retro Improvements (Unplaced)"
    And TEAM.md is committed because its content changed
    And the step completion is qualified with 3 fallback placements

  @ac2 @matching
  Scenario: Heading matching normalizes case, whitespace, and echoed hashes only
    Given an adopted proposal targeting section "### qa engineer"
    When step 13 "Apply retro improvements" executes
    Then the proposal is applied at the "### QA Engineer" heading with outcome "applied"

  @ac2 @matching @no-fuzzy
  Scenario: No fuzzy matching — a plausible-but-inexact Section still misses to the fallback
    Given an adopted proposal targeting section "Product Owner responsibilities"
    And TEAM.md contains the heading "### Product Owner (PO)"
    When step 13 "Apply retro improvements" executes
    Then the proposal is NOT inserted under "### Product Owner (PO)"
    And the proposal's outcome is "applied-fallback"

  # ───────────────────────────────────────────────────────────────────────────
  # AC 3 — Placement outcomes recorded in the retro document
  # ───────────────────────────────────────────────────────────────────────────

  @ac3 @reporting
  Scenario: The retro document's Applied Changes section stops being a "(None yet)" stub
    Given the sprint retro document exists with an "## Applied Changes" stub of "(None yet)"
    And the user adopted 2 proposals, one matching a section and one missing
    When step 13 "Apply retro improvements" executes
    Then the retro document's "## Applied Changes" section no longer reads "(None yet)"
    And it records one line per adopted proposal with its individual placement

  @ac3 @edge @graceful-degradation
  Scenario: Retro document missing on disk degrades gracefully
    Given the sprint retro document does not exist on disk
    And the user adopted 1 proposal
    When step 13 "Apply retro improvements" executes
    Then the TEAM.md apply still functions and the outcome is still recorded in sprint state
    And the step still completes with a qualified result

  # ───────────────────────────────────────────────────────────────────────────
  # AC 4 — Step result reflects reality (qualified completion)
  # ───────────────────────────────────────────────────────────────────────────

  @ac4 @reporting
  Scenario: Mixed outcomes produce a qualified completion message
    Given the user adopted 2 proposals, one matching its target section and one missing
    When step 13 "Apply retro improvements" executes
    Then the caller-visible result states how many proposals were applied versus fell back versus failed
    And the sprint does not report an unqualified "retro improvements applied"

  @ac4 @edge
  Scenario: Mixed outcomes are recorded individually
    Given adopted proposal 1 targets an existing heading and adopted proposal 2 targets a missing heading
    When step 13 "Apply retro improvements" executes
    Then proposal 1's outcome is "applied" with the matched heading recorded as placedAt
    And proposal 2's outcome is "applied-fallback"

  # ───────────────────────────────────────────────────────────────────────────
  # AC 5 — Change verification before commit
  # ───────────────────────────────────────────────────────────────────────────

  @ac5 @defect-signal
  Scenario: Byte-identical TEAM.md with claimed placements is surfaced as a defect, not swallowed
    Given at least one adopted proposal exists
    And applyImprovements reports a placement but produces byte-identical TEAM.md content
    When step 13 "Apply retro improvements" executes
    Then the affected outcomes are downgraded to "unplaced" with reason "apply reported success but content unchanged"
    And the defect is surfaced in the qualified step result

  @ac5 @idempotency
  Scenario: All-already-present with unchanged content is the legitimate re-run case, not a defect
    Given step 13 already applied all adopted proposals in a previous run
    When step 13 "Apply retro improvements" executes again
    Then every outcome is "already-present"
    And the unchanged TEAM.md is not treated as a defect signal

  # ───────────────────────────────────────────────────────────────────────────
  # AC 6 — Path parity at both production seams
  # ───────────────────────────────────────────────────────────────────────────

  @ac6 @parity
  Scenario: Single-feature and multi-feature step-13 paths behave identically
    Given two identical projects, one running a single-feature sprint and one a multi-feature sprint
    And identical adopted proposals with identical retro-review feedback
    When step 13 "Apply retro improvements" executes through each production seam
    Then both TEAM.md files receive identical inserted improvement blocks
    And both sprints record identical per-proposal placement sequences
    And both create the "[PO] update: apply retrospective improvements" commit

  # ───────────────────────────────────────────────────────────────────────────
  # AC 7 — Skip behavior unchanged
  # ───────────────────────────────────────────────────────────────────────────

  @ac7 @skip
  Scenario: Retro-review feedback of "skip" results in no TEAM.md modification
    Given the retro-review checkpoint feedback is "skip"
    When step 13 "Apply retro improvements" executes
    Then TEAM.md is byte-identical to its content before the step
    And no fallback section is written
    And the step completes normally with no new warnings
    And no "[PO] update: apply retrospective improvements" commit is created

  @ac7 @skip @edge
  Scenario: Selection indices entirely out of range behave like skip
    Given 2 retro proposals exist and the retro-review feedback is "7,9"
    When step 13 "Apply retro improvements" executes
    Then TEAM.md is byte-identical to its content before the step
    And no fallback writes occur for proposals that were never adopted

  # ───────────────────────────────────────────────────────────────────────────
  # AC 8 — Commit only on change, never silently
  # ───────────────────────────────────────────────────────────────────────────

  @ac8 @commit
  Scenario: Applied changes are committed with the unchanged message format
    Given at least one adopted proposal is applied at its target or at the fallback
    When step 13 "Apply retro improvements" executes
    Then TEAM.md is committed with message "[PO] update: apply retrospective improvements from sprint 1"

  @ac8 @commit
  Scenario: When nothing was applied, no empty commit is attempted
    Given every adopted proposal resolves to "already-present"
    When step 13 "Apply retro improvements" executes
    Then no new "[PO] update: apply retrospective improvements" commit is created

  @ac8 @commit
  Scenario: A commit failure is surfaced in the report instead of being silently absorbed
    Given at least one adopted proposal is applied but the git commit fails
    When step 13 "Apply retro improvements" executes
    Then the step still completes without corrupting sprint flow
    And the commit failure is noted in the qualified step result

  # ───────────────────────────────────────────────────────────────────────────
  # AC 9 — Regression fixture from the Sprint 10 / Sprint 12 live incidents
  # ───────────────────────────────────────────────────────────────────────────

  @ac9 @regression
  Scenario: The Sprint 10/12 silent-drop shape can no longer occur
    Given the real bundled-template TEAM.md content
    And adopted proposals whose Section values are plausible-but-inexact heading references
      | requested section              | actual TEAM.md heading   |
      | Product Owner responsibilities | ### Product Owner (PO)   |
    And the retro-review selection parsed correctly and was recorded
    When step 13 "Apply retro improvements" executes through a runner production seam
    Then TEAM.md is modified on disk
    And the adopted proposal text is present in TEAM.md
    And the step does NOT complete as an unqualified success with TEAM.md unchanged

  # ───────────────────────────────────────────────────────────────────────────
  # Edge cases — matching semantics
  # ───────────────────────────────────────────────────────────────────────────

  @edge @multi-match
  Scenario: A Section matching multiple headings is placed at the first occurrence and recorded
    Given TEAM.md contains two headings that normalize to the adopted proposal's Section
    When step 13 "Apply retro improvements" executes
    Then the improvement is inserted in the first matching section in document order
    And that first heading is the placement recorded in the outcome's placedAt

  @edge @fences
  Scenario: A heading that exists only inside a fenced code block is non-matchable
    Given the adopted proposal targets "Linked Spec"
    And "## Linked Spec" appears in TEAM.md only inside the fenced PR Description Template
    When step 13 "Apply retro improvements" executes
    Then the improvement is NOT inserted inside the fenced code block
    And the proposal's outcome is "applied-fallback"

  @edge @fences
  Scenario: A fenced heading does not terminate the enclosing section early
    Given an adopted proposal targets a section whose body contains a fenced code block with headings
    When step 13 "Apply retro improvements" executes
    Then the improvement is inserted at the true end of the section, after the fenced block
    And never between the opening and closing fence markers

  @edge @idempotency
  Scenario: Step 13 re-run after resume does not double-append proposal text
    Given step 13 previously applied the adopted proposals and the sprint is resumed at step 13
    When step 13 "Apply retro improvements" executes again
    Then each proposal's rendered block appears exactly once in TEAM.md
    And the re-run outcomes are "already-present"
    And no additional apply commit is created
