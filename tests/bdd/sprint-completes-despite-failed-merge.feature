Feature: Sprint completes despite failed merge — in-place merge retry and truthful completion status
  As a Raptor user running a sprint
  When the Merge PR step (step 9) fails
  I want the orchestrator to retry the merge in place
  And refuse to report "Sprint complete" while the PR is still open
  So that `complete` means the code is actually on main, every time

  # Spec:         docs/specs/sprint-completes-despite-failed-merge.md
  # Architecture: docs/architecture/sprint-completes-despite-failed-merge.md
  #
  # Design invariant under test (the one-sentence contract):
  #   state.status === "complete" implies every step in state.steps is
  #   "complete" — and in multi-feature mode, every feature is terminal
  #   ("complete" or "escalated") before any shared step runs.
  #
  # Production specimens this feature guards against recurring:
  #   Sprint 10 (2026-06-11): PR #21 blocked by branch protection → "Sprint complete"
  #   Sprint 12 (2026-07-06): PR #27 branch divergence → "Sprint complete", PR still OPEN

  Background:
    Given a registered Raptor project with a sprint in progress
    And steps 1 through 8 of the sprint workflow are complete
    And the sprint state tracks the feature branch name
    And MAX_RETRY_ATTEMPTS is 3

  # ───────────────────────── AC #1, #2 — single-feature in-place retry ─────────────────────────

  Scenario: Merge fails once then succeeds on the in-place retry (AC #1, AC #2)
    Given executeMerge will fail on the first invocation and succeed on the second
    When the runner executes step 9 (Merge PR)
    Then executeMerge is invoked exactly 2 times
    And the step index is not advanced between the two invocations
    And step 9 ends with status "complete" and attempts equal to 2
    And exactly 1 failure record is appended with a truncated error summary
    And steps 10 through 13 begin only after step 9 is "complete"

  Scenario: Every merge failure is accounted — attempts equals invocation count (AC #2)
    Given executeMerge will fail on every invocation
    When the runner executes step 9 (Merge PR)
    Then the attempts count on step 9 equals the number of executeMerge invocations
    And each failure appends one failures[] record with a truncated error summary
    And no failure is silently swallowed

  Scenario: Merge failure error summary is truncated to the established cap (AC #2)
    Given executeMerge fails with an error message longer than ERROR_SUMMARY_MAX_LENGTH
    When the failure is recorded on step 9
    Then the recorded errorSummary is truncated to at most ERROR_SUMMARY_MAX_LENGTH characters

  # ───────────────────────── AC #3, #9 — escalation at cap, truthfulness ─────────────────────────

  Scenario: Merge fails exactly MAX_RETRY_ATTEMPTS times and escalates cleanly (AC #3, edge case)
    Given executeMerge will fail on every invocation
    When the runner executes step 9 (Merge PR)
    Then executeMerge is invoked exactly 3 times
    And step 9 ends with status "escalated" and attempts equal to 3
    And the sprint status is "escalated"
    And an "[ESCALATE]" commit is created
    And the runner returns without executing steps 10 through 13
    And no subagent is spawned for any shared step

  Scenario: Escalated merge never claims the merge happened (AC #9)
    Given step 9 has escalated after 3 failed merge attempts
    Then step 9 status is not "complete"
    And the sprint status is not "complete"
    And no step-9 "[HANDOFF]" commit exists for the failed merge
    And the returned result does not contain "Sprint complete"

  Scenario: Deterministic merge failure burns all attempts quickly and still escalates (edge case)
    Given executeMerge fails identically on every invocation with a branch-protection error
    When the runner executes step 9 (Merge PR)
    Then all 3 in-place attempts fail with the same error
    And escalation fires cleanly at the cap
    And each failure record carries a failure classification and signature for post-mortems

  Scenario: Merge succeeds on the final allowed attempt (edge case)
    Given executeMerge will fail twice and succeed on the third invocation
    When the runner executes step 9 (Merge PR)
    Then step 9 ends with status "complete" and attempts equal to 3
    And exactly one step-9 "[HANDOFF]" commit is created, for the successful merge only
    And the sprint proceeds normally to step 10

  # ───────────────────────── AC #4 — single-feature finalization guard ─────────────────────────

  Scenario: Finalization refuses "complete" while any step is non-complete (AC #4)
    Given a sprint state where step 9 is "in-progress" with 1 recorded failure
    And steps 10 through 12 are complete
    When the runner finishes the remaining steps and reaches finalization
    Then the sprint status is not "complete"
    And the returned message names the non-complete step 9
    And the persisted sprint state reflects the non-complete step
    And the result message is not "Sprint complete! All steps finished successfully."

  Scenario: The Sprint 12 production specimen can no longer occur (AC #1 + AC #4)
    Given executeMerge fails with a branch-divergence error on every invocation
    When the runner executes step 9 and all retries are exhausted
    Then the runner never reports "Sprint complete"
    And the sprint parks as "escalated" awaiting user intervention

  # ───────────────────────── AC #7 — escalated merge is resumable ─────────────────────────

  Scenario: A sprint escalated at step 9 re-enters at step 9 (AC #7)
    Given a sprint escalated at step 9 after exhausted merge attempts
    And the underlying merge problem has been fixed
    When the sprint is re-engaged via the existing resume paths
    Then execution re-enters at step 9
    And a now-succeeding merge marks step 9 "complete"
    And the sprint proceeds to steps 10 through 13

  # ───────────────────────── AC #5, #6, #8 — multi-feature mode ─────────────────────────

  Scenario: Dispatcher honors the "retry" outcome for a feature's merge (AC #5)
    Given a multi-feature sprint with features "feat-a" and "feat-b" at step 9
    And executeMerge for "feat-a" will fail once then succeed
    And executeMerge for "feat-b" will succeed immediately
    When the dispatcher runs the Merge PR step
    Then executeMerge is invoked exactly 2 times for "feat-a"
    And "feat-a" step 9 ends "complete" with attempts equal to 2
    And "feat-a" is not advanced past step 9 while its merge outcome is "retry"
    And both features end with status "complete"

  Scenario: Feature A merges while feature B retries then escalates — sibling isolation (AC #8, edge case)
    Given a multi-feature sprint with features "feat-a" and "feat-b" at step 9
    And executeMerge for "feat-a" will succeed immediately
    And executeMerge for "feat-b" will fail on every invocation
    When the dispatcher runs the Merge PR step
    Then "feat-a" ends "complete" with step 9 attempts equal to 1 and is not re-run, reset, or altered
    And executeMerge is invoked exactly 3 times for "feat-b"
    And "feat-b" ends "escalated" with step 9 attempts equal to 3
    And an "[ESCALATE]" commit names "feat-b"
    And the sprint parks as "escalated" per the Sprint 10 mixed-completion behavior
    And shared steps 10 through 13 do not run

  Scenario: Shared steps are gated while any feature is non-terminal at step 9 (AC #6)
    Given a multi-feature sprint where "feat-a" is "complete"
    And "feat-b" is stuck "in-progress" at step 9
    When the runner reaches the shared-step boundary (step 10)
    Then shared steps 10 through 13 do not begin
    And no subagent is spawned for any shared step
    And the sprint status is not "complete" and not stuck "in-progress"
    And the returned message names "feat-b" as not terminal at step 9

  Scenario: Escalated park behavior preserved on "escalated" outcome (AC #5)
    Given a multi-feature sprint where a feature's merge returns "escalated"
    When the dispatcher consumes the outcome
    Then the existing park behavior applies
    And the sibling features are untouched

  # ───────────────────────── Edge cases — state compatibility & termination ─────────────────────────

  Scenario: Pre-fix state file loads without crashing and is not auto-repaired (edge case)
    Given a persisted sprint state from before the fix where step 9 is "in-progress" and the sprint says "complete"
    When the state file is loaded
    Then loading does not crash
    And the historical state is not auto-migrated or repaired

  Scenario: Missing branchName still hard-fails unchanged (edge case)
    Given the sprint state has no branchName recorded
    When the runner executes step 9 (Merge PR)
    Then the existing hard-fail path applies
    And executeMerge is never invoked

  Scenario: The in-place retry loop always terminates (edge case)
    Given executeMerge fails permanently
    When the runner executes step 9 (Merge PR)
    Then the retry loop executes at most MAX_RETRY_ATTEMPTS iterations
    And the runner returns an "escalated" result rather than looping forever
