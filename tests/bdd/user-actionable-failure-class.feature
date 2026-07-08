Feature: User-Actionable Failure Classification
  As a Raptor user running a sprint
  I want a failure whose blocker is outside the sprint (spend limit hit, invalid --model)
  to escalate immediately after the first attempt with the exact action I must take
  So that Raptor never burns 2-3 doomed retries on a blocker no retry can fix

  # Spec:         docs/specs/user-actionable-failure-class.md (AC 1-13)
  # Architecture: docs/architecture/user-actionable-failure-class.md
  # Decision ordering (binding): salvage-complete > USER-ACTIONABLE (escalate-now)
  #   > transient > no-progress short-circuit > deterministic slot accounting
  # Precedence inside classifyFailure: user-actionable > transient > deterministic

  Background:
    Given a Raptor sprint is running with the standard 13-step workflow
    And MAX_RETRY_ATTEMPTS is 3 deterministic attempts per step
    And the transient retry cap is 5 per step
    And the failure classifier has three classes: transient, deterministic, and user-actionable

  # ---------------------------------------------------------------------------
  # Classification (AC 1-4, 13)
  # ---------------------------------------------------------------------------

  Scenario: A spend-limit failure classifies as user-actionable
    When an agent attempt fails with "You've hit your monthly spend limit"
    Then the failure is classified "user-actionable"
    And it is NOT classified "transient"
    And it is NOT classified "deterministic"

  Scenario Outline: Spend-limit phrasing drift still classifies as user-actionable
    When an agent attempt fails with output containing "<error>"
    Then the failure is classified "user-actionable"

    Examples:
      | error                            |
      | You've hit your monthly spend limit |
      | monthly spend limit              |
      | monthly usage limit              |
      | usage limit reached              |

  Scenario Outline: An invalid --model rejection classifies as user-actionable
    When an agent attempt fails with output containing "<error>"
    Then the failure is classified "user-actionable"

    Examples:
      | error                                   |
      | error: invalid model name provided      |
      | unknown model: definitely-not-a-real-model |
      | model definitely-not-a-real-model not found |
      | the requested model does not exist      |

  Scenario: An error matching no user-actionable pattern classifies exactly as today
    When an agent attempt fails with "agent produced no output"
    Then the failure is classified "deterministic"
    And when an agent attempt fails with "socket connection closed unexpectedly"
    Then that failure is classified "transient"

  Scenario: The user-actionable registry is an enumerable, code-only, pattern+action registry
    Given the exported USER_ACTIONABLE_ERROR_PATTERNS registry
    Then it is an array of at least two entries
    And every entry carries a RegExp pattern and a non-empty action string
    And no entry's pattern uses the /g flag
    And adding a future signature is a one-line registry addition with no pipeline change

  # ---------------------------------------------------------------------------
  # Precedence (AC 2, Edge Case: matches user-actionable AND transient)
  # ---------------------------------------------------------------------------

  Scenario: A string matching both a user-actionable and a transient pattern resolves to user-actionable
    When an agent attempt fails with "usage limit reached (429 rate limit)"
    Then the failure is classified "user-actionable"
    # Retrying a spend-limit error as if it were a network flake is the waste this feature removes

  # ---------------------------------------------------------------------------
  # Escalate-now pipeline behavior (AC 5, 6, 7)
  # ---------------------------------------------------------------------------

  Scenario: A user-actionable failure escalates on the first attempt
    Given a step has just failed once with a user-actionable spend-limit error
    When the retry decision is made
    Then the runner escalates immediately
    And the escalation reason is "user-actionable"
    And zero additional agent attempts are spent
    And the step state records escalationReason "user-actionable"

  Scenario: A billing failure escalates after exactly one attempt, not two
    Given the retry loop runs a step whose agent fails with "You've hit your monthly spend limit"
    When the loop processes the failure
    Then the step escalates after exactly 1 attempt
    And the escalation reason is "user-actionable"
    # RED baseline: pre-change this billing error classifies deterministic and burns 2 attempts

  Scenario: An invalid-model failure escalates after exactly one attempt, not three
    Given the retry loop runs a step whose agent fails with "unknown model: definitely-not-a-real-model"
    When the loop processes the failure
    Then the step escalates after exactly 1 attempt
    And the escalation reason is "user-actionable"
    # RED baseline: pre-change an invalid-model error rides the deterministic path and burns up to 3 attempts

  Scenario: The escalation message names the concrete action for a spend-limit failure
    Given a step failed with a user-actionable spend-limit error
    When the escalation decision is produced
    Then the escalation detail names raising the usage limit at claude.ai/settings/usage
    And a user reading it can act without guessing

  Scenario: The escalation message names the concrete action for an invalid-model failure
    Given a step failed with a user-actionable invalid-model error
    When the escalation decision is produced
    Then the escalation detail names fixing models.byRole / models.default in ~/.raptor/config.json

  # ---------------------------------------------------------------------------
  # Ordering & edge cases
  # ---------------------------------------------------------------------------

  Scenario: Salvage-complete still wins over a user-actionable failure
    Given a step's agent hit a spend limit but had already written every expected output file
    And all expected outputs pass the glob gate
    When the retry decision is made
    Then the decision is salvage-complete
    # User-actionable escalate-now sits after salvage-complete in the ordering

  Scenario: A user-actionable failure on attempt 2+ still escalates immediately
    Given a step already failed once deterministically and consumed one attempt slot
    When the step then fails with a user-actionable spend-limit error
    Then the runner escalates immediately with reason "user-actionable"
    And it does NOT finish the remaining deterministic attempt budget

  Scenario: Both seed patterns present in one summary names the first-matched action
    When an agent attempt fails with output containing both a spend-limit message and a model complaint
    Then the failure classifies "user-actionable"
    And the escalation names at least the first-matched action

  # ---------------------------------------------------------------------------
  # No-regression parity (AC 12)
  # ---------------------------------------------------------------------------

  Scenario: Ordinary deterministic failures still consume slots and escalate at MAX_RETRY_ATTEMPTS
    Given a step fails 3 times with deterministic errors having distinct signatures
    And none of those errors matches a user-actionable pattern
    Then each failure consumes one of the 3 attempt slots
    And the step escalates with reason "attempts-exhausted"

  Scenario: Transient behavior is unchanged when no user-actionable pattern matches
    Given a step fails with "socket connection closed unexpectedly"
    Then the step retries without consuming a deterministic slot
    And the transient cap and no-progress short-circuit are byte-for-byte unchanged

  # ---------------------------------------------------------------------------
  # State, recording & resumability (AC 8, 9, 10)
  # ---------------------------------------------------------------------------

  Scenario: The user-actionable classification is stamped on the FailureRecord and persisted
    When a step fails with a user-actionable error and the failure is recorded
    Then the FailureRecord carries classification "user-actionable"
    And it also carries a derived signature for uniform post-mortem records
    And the classification is persisted in the sprint state file

  Scenario: A user-actionable escalation parks the step in the resumable escalated state
    Given a step escalated with reason "user-actionable"
    Then the sprint uses the existing escalated (resumable) status
    And no new terminal or limbo status is introduced
    When the user raises the limit or fixes the config and resumes
    Then the existing resume path re-engages the step

  Scenario: Both single- and multi-feature retry loops behave identically
    Given the same user-actionable failure for a step
    When processed by the single-feature loop and by the multi-feature loop
    Then both produce the same escalate decision with reason "user-actionable"
    # Both loops call the same pure decideAfterFailure (architecture constraint 1)

  Scenario: Old state files without the new class load unchanged
    Given a sprint state file persisted before this feature with failure records lacking a classification field
    When the sprint state is loaded
    Then loading succeeds without error
    And every unclassified failure record is treated as "deterministic"
