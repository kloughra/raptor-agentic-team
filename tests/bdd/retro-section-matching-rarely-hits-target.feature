Feature: Retro section matching resolves compound Section strings to their real TEAM.md heading
  Spec:         docs/specs/retro-section-matching-rarely-hits-target.md
  Architecture: docs/architecture/retro-section-matching-rarely-hits-target.md

  As a Raptor user who adopts retrospective improvement proposals,
  I want an adopted proposal whose free-text Section string clearly references a real
  TEAM.md heading — even when it is compound, descriptive, or carries a parenthetical
  qualifier — to be applied AT that heading, so my process improvements land where they
  belong instead of accumulating in the "Unplaced" fallback and forcing me to relocate
  every one by hand during sprint close-out.

  Terminology (from the approved architecture, unchanged from Sprint 13):
    - "applied"           — inserted at the proposal's resolved target heading (placedAt = that heading)
    - "applied-fallback"  — inserted under "## Adopted Retro Improvements (Unplaced)"
    - "already-present"   — the exact rendered block already exists (re-run / resume)
    - "unplaced"          — not written; reserved for failures beyond section matching
                            (e.g. TEAM.md unreadable), with a reason

  Design (Open Question 1 → option b, apply-side only): a new segment-and-match resolver
  runs in front of the existing normalized-exact matcher. It splits the Section on STRONG
  separators only (→ / -> / => / ; / : / , / / / | / > and newlines — never on "-" or "&"),
  tokenizes each segment into whole words, strips a heading's TRAILING parenthetical when
  computing its core tokens, and matches a heading only when its core token sequence is a
  contiguous whole-token subsequence of a single segment. Ties break by longest match,
  then deepest heading level, then earliest segment, then document order. When nothing
  resolves it returns null and the proven Sprint 13 fallback fires unchanged.

  Background:
    Given a Raptor project scaffolded from the bundled TEAM.md template
    And sprint 1 has completed steps 1 through 12
    And the retro collected proposals stored in sprint state
    And the retro-review checkpoint was resolved with user feedback selecting proposals

  # ───────────────────────────────────────────────────────────────────────────
  # AC 1 — Compound reference resolves to its real heading (applied, not fallback)
  # ───────────────────────────────────────────────────────────────────────────

  @ac1 @resolve
  Scenario: A compound Section containing a real heading is applied at that heading
    Given an adopted proposal whose Section is "Backlog Management → Rules"
    And TEAM.md contains the headings "## Backlog Management" and "### Rules"
    When step 13 "Apply retro improvements" executes
    Then the proposal's outcome is "applied", not "applied-fallback"
    And the outcome's placedAt is the verbatim text of a real TEAM.md heading
    And the proposal text is inserted inside that heading's section, not under the Unplaced fallback

  @ac1 @resolve @tie-break
  Scenario: The most specific (longest, deepest) referenced heading wins a multi-reference Section
    Given an adopted proposal whose Section is "Roles & Responsibilities → Product Owner (Responsibilities); reinforced in Backlog Management → Rules"
    And the Section names several real headings across its segments
    When step 13 "Apply retro improvements" executes
    Then the proposal is applied at the "### Product Owner (PO)" heading
    And the outcome's placedAt is recorded as "Product Owner (PO)"
    And the generic short heading "Rules" does NOT hijack the placement

  @ac1 @resolve @parenthetical
  Scenario: A trailing parenthetical qualifier on the Section is treated as optional
    Given an adopted proposal whose Section is "Roles & Responsibilities → QA Engineer (Responsibilities)"
    And the real heading is "### QA Engineer" with no "(Responsibilities)" qualifier
    When step 13 "Apply retro improvements" executes
    Then the proposal is applied at the "### QA Engineer" heading
    And the outcome's placedAt is recorded as "QA Engineer"

  # ───────────────────────────────────────────────────────────────────────────
  # AC 2 — Both live incidents become passing fixtures
  # ───────────────────────────────────────────────────────────────────────────

  @ac2 @regression @live-incident
  Scenario Outline: The verbatim Sprint 13 and Sprint 14 Section strings resolve to their real heading
    Given an adopted proposal whose Section is the verbatim string "<section>"
    And the real bundled-template TEAM.md content
    When step 13 "Apply retro improvements" executes
    Then the proposal's outcome is "applied", not "applied-fallback"
    And it is applied at the "<heading>" heading
    And the proposal text does NOT appear under "## Adopted Retro Improvements (Unplaced)"

    Examples:
      | section                                                                                              | heading            |
      | Roles & Responsibilities → Product Owner (Responsibilities); reinforced in Backlog Management → Rules | Product Owner (PO) |
      | Roles & Responsibilities → QA Engineer (Responsibilities)                                            | QA Engineer        |

  # ───────────────────────────────────────────────────────────────────────────
  # AC 3 — No silent drop (Sprint 13 outcome-total invariant preserved)
  # ───────────────────────────────────────────────────────────────────────────

  @ac3 @invariant
  Scenario: Every adopted proposal still ends the step with exactly one recorded outcome
    Given the user adopted 3 proposals — one compound-resolvable, one exact, one pure prose
    When step 13 "Apply retro improvements" executes
    Then exactly 3 proposal outcomes are recorded, in proposal order
    And each outcome has placement "applied", "applied-fallback", "already-present", or "unplaced"
    And no adopted proposal vanishes without a recorded outcome

  # ───────────────────────────────────────────────────────────────────────────
  # AC 4 — No wrong-section placement (precision over recall)
  # ───────────────────────────────────────────────────────────────────────────

  @ac4 @no-false-positive
  Scenario: A Section referencing no real heading still falls back with attribution
    Given an adopted proposal whose Section is "the architecture of the system"
    And no segment of that Section contains a real heading's whole core tokens
    When step 13 "Apply retro improvements" executes
    Then the proposal's outcome is "applied-fallback"
    And the proposal text is present under "## Adopted Retro Improvements (Unplaced)" with attribution
    And the proposal is NOT inserted under the "### Architect" heading

  @ac4 @no-false-positive @whole-token
  Scenario: Whole-token matching does not treat "architect" as a match for the token "architecture"
    Given an adopted proposal whose Section is "notes on the architecture of the system"
    When step 13 "Apply retro improvements" executes
    Then the token "architecture" does NOT resolve to the "### Architect" heading
    And the proposal's outcome is "applied-fallback"

  @ac4 @no-shred
  Scenario: Separators inside a legitimate heading do not shred it into non-matching fragments
    Given an adopted proposal whose Section is "Roles & Responsibilities"
    And the real heading "## Roles & Responsibilities" contains an "&"
    When step 13 "Apply retro improvements" executes
    Then the proposal is applied at the "## Roles & Responsibilities" heading
    And the "&" is not treated as a segment separator

  # ───────────────────────────────────────────────────────────────────────────
  # AC 5 — Deterministic, string-only, no model calls
  # ───────────────────────────────────────────────────────────────────────────

  @ac5 @deterministic
  Scenario: Repeated resolution of the same inputs is byte-for-byte identical
    Given the same TEAM.md content and the same adopted proposal
    When applyImprovements resolves the Section twice
    Then both runs produce the same placement and the same placedAt
    And no subagent, LLM scoring, or network call is made during resolution

  # ───────────────────────────────────────────────────────────────────────────
  # AC 6 — Fenced headings stay non-matchable
  # ───────────────────────────────────────────────────────────────────────────

  # NOTE (PO test-review CHANGES REQUESTED): the Section must reference ONLY
  # fenced headings, else it accidentally matches the real non-fenced
  # "### PR Description Template". Both "## Test Results" and "## Linked Spec"
  # live inside the PR-template code fence, so the sole reason for fallback is
  # the fence.
  @ac6 @fences
  Scenario: A compound Section cannot resolve to a heading living inside a code fence
    Given an adopted proposal whose Section is "Test Results → Linked Spec"
    And both "## Test Results" and "## Linked Spec" appear in TEAM.md only inside the fenced PR Description Template
    When step 13 "Apply retro improvements" executes
    Then the improvement is NOT inserted inside the fenced code block
    And the proposal's outcome is "applied-fallback"

  # ───────────────────────────────────────────────────────────────────────────
  # AC 7 — Idempotency and re-run safety preserved
  # ───────────────────────────────────────────────────────────────────────────

  @ac7 @idempotency
  Scenario: Re-running step 13 does not double-insert a compound-resolved proposal
    Given step 13 already applied a compound-resolved proposal at its target heading
    And the sprint is resumed at step 13
    When step 13 "Apply retro improvements" executes again
    Then the proposal's rendered block appears exactly once in TEAM.md
    And the re-run outcome is "already-present"
    And no additional apply commit is created

  # ───────────────────────────────────────────────────────────────────────────
  # AC 8 — Path parity across both runner production seams
  # ───────────────────────────────────────────────────────────────────────────

  @ac8 @parity
  Scenario: Single-feature and multi-feature step-13 paths resolve compound Sections identically
    Given two identical projects, one single-feature sprint and one multi-feature sprint
    And identical adopted proposals with compound Section strings and identical retro-review feedback
    When step 13 "Apply retro improvements" executes through each production seam
    Then both sprints record identical per-proposal placement sequences
    And both record identical placedAt values
    And both TEAM.md files receive identical inserted improvement blocks

  # ───────────────────────────────────────────────────────────────────────────
  # AC 9 — Fallback path still fully functional (Sprint 13 guarantees intact)
  # ───────────────────────────────────────────────────────────────────────────

  @ac9 @fallback
  Scenario: Genuinely unplaceable proposals still use the unchanged fallback + reporting
    Given the user adopted 2 proposals whose Sections reference no real heading
    When step 13 "Apply retro improvements" executes
    Then both proposals land under "## Adopted Retro Improvements (Unplaced)" with attribution
    And TEAM.md is committed because its content changed
    And the retro document's "## Applied Changes" section records each fallback placement
    And the step completion is qualified with the fallback count

  # ───────────────────────────────────────────────────────────────────────────
  # Edge cases (spec + architecture)
  # ───────────────────────────────────────────────────────────────────────────

  @edge @exact
  Scenario: A Section that is a real heading verbatim still resolves via the unchanged exact path
    Given an adopted proposal whose Section is exactly "QA Engineer"
    When step 13 "Apply retro improvements" executes
    Then the proposal is applied at the "### QA Engineer" heading via the exact fast path
    And the behavior is byte-identical to the pre-feature exact matcher

  @edge @tie-break @no-hijack
  Scenario: A drill-down Section is not hijacked onto a generic short subsection
    Given an adopted proposal whose Section is "Sprint Workflow ordering of Rules"
    And both "## Sprint Workflow" and "### Rules" are real headings
    When step 13 "Apply retro improvements" executes
    Then the proposal is applied at the "## Sprint Workflow" heading
    And it is NOT applied at the generic "### Rules" subsection

  @edge @empty
  Scenario: An empty or marker-only Section resolves to no heading and falls back
    Given an adopted proposal whose Section is whitespace only
    When step 13 "Apply retro improvements" executes
    Then the proposal's outcome is "applied-fallback"
    And no heading resolution is attempted beyond returning null
