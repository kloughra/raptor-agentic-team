Feature: Orchestrator Recovery After Mixed Completion
  As a Raptor user running a multi-feature sprint
  When one feature reaches Definition of Done and a sibling hits the 3-attempt circuit breaker
  I want the sprint to land in "escalated" status and let me route fresh request-changes feedback
  to the parked feature via resume_sprint
  So that I can re-engage the stuck feature in-band instead of hand-editing sprint-N.json or shipping a hotfix

  Background:
    Given a project registered with Raptor
    And the project ran a multi-feature sprint whose features dispatch through per-feature steps 1–9
    And sprint state is persisted under ~/.raptor/{project}/sprint-N.json via saveSprintState
    And deriveSprintStatus reduces state.features[*].status into the overall sprint status

  # ─────────────────────────────────────────────────────────────────────
  # AC #1 — Feature completion is marked at the terminal step
  # ─────────────────────────────────────────────────────────────────────

  Scenario: A feature is marked complete when its terminal Merge PR step completes
    Given a multi-feature sprint with features "alpha" and "beta"
    And feature "alpha" has progressed to its terminal per-feature step (Merge PR, step 9)
    When runMergeStepForFeature completes the Merge PR step for feature "alpha"
    Then state.features[alpha].steps[step9].status is "complete"
    And state.features[alpha].status is set to "complete"
    And state.features[alpha].currentStep is advanced past the terminal step
    And the completion transition happens alongside the existing currentStep bump

  Scenario: A non-terminal step completing does NOT mark the feature complete
    Given a multi-feature sprint with feature "alpha"
    And feature "alpha" completes step 5 (Implement) successfully
    Then state.features[alpha].steps[step5].status is "complete"
    And state.features[alpha].status is still "in-progress"

  # ─────────────────────────────────────────────────────────────────────
  # AC #2, #3, #10 — Mixed / all-complete finalization
  # ─────────────────────────────────────────────────────────────────────

  Scenario: A mixed sprint (one complete, one escalated) finalizes as escalated
    Given a multi-feature sprint with features "alpha" and "beta"
    And feature "alpha" reached "complete" at its terminal step
    And feature "beta" hit the 3-attempt circuit breaker and is "escalated"
    When the per-feature dispatch loop resolves after the last per-feature step
    Then deriveSprintStatus(state.features) returns "escalated"
    And the persisted state.status is "escalated"
    And the persisted state.status is NOT "in-progress"

  Scenario: An all-complete sprint finalizes as complete (no regression)
    Given a multi-feature sprint with features "alpha" and "beta"
    And every feature reached "complete" at its terminal step
    When the per-feature dispatch loop resolves
    Then deriveSprintStatus(state.features) returns "complete"
    And the sprint proceeds to shared steps 10–13
    And the sprint finalizes as "complete" exactly as before

  Scenario: A sprint with an escalated feature does not silently advance to shared steps 10–13
    Given a multi-feature sprint with features "alpha" and "beta"
    And feature "alpha" is "complete" and feature "beta" is "escalated"
    When the dispatch loop resolves
    Then shared steps 10–13 do NOT execute
    And the sprint parks in "escalated" status awaiting user intervention
    And the sprint is NOT reported as "in-progress"

  Scenario: Sprint stays in-progress while any feature is still non-terminal
    Given a multi-feature sprint with features "alpha", "beta", "gamma"
    And feature "alpha" is "escalated", feature "beta" is "complete", feature "gamma" is "in-progress"
    When deriveSprintStatus is recomputed
    Then it returns "in-progress"
    And the sprint does NOT finalize as "escalated" yet

  # ─────────────────────────────────────────────────────────────────────
  # AC #4 — resume_sprint accepts an optional feature selector (additive)
  # ─────────────────────────────────────────────────────────────────────

  Scenario: resume_sprint accepts an optional feature argument
    Given the resume_sprint MCP tool schema
    Then it exposes an optional "feature" string argument
    And existing calls that omit "feature" remain valid
    And the run_sprint tool signature is unchanged

  # ─────────────────────────────────────────────────────────────────────
  # AC #5 — Implicit single-target resume
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Resuming an escalated sprint with exactly one escalated feature targets it implicitly
    Given an escalated sprint where feature "alpha" is "complete" and feature "beta" is "escalated"
    When the user calls resume_sprint with action "request-changes" and feedback "fix the failing assertion" and no feature argument
    Then the runner implicitly targets the only escalated feature "beta"
    And feature "beta" is re-engaged at its escalated step
    And feature "alpha" is not touched

  # ─────────────────────────────────────────────────────────────────────
  # AC #6 — Explicit multi-target resume
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Resuming when multiple features are escalated requires an explicit feature argument
    Given an escalated sprint where features "alpha" and "beta" are both "escalated"
    When the user calls resume_sprint with action "request-changes" and feedback "..." and no feature argument
    Then the runner returns an error result
    And the error lists the escalated feature slugs "alpha" and "beta"
    And the error instructs the user to pass a "feature" argument
    And no feature state is mutated

  Scenario: Supplying a valid escalated feature slug targets that feature
    Given an escalated sprint where features "alpha" and "beta" are both "escalated"
    When the user calls resume_sprint with action "request-changes", feedback "..." and feature "alpha"
    Then the runner targets feature "alpha"
    And feature "beta" is not touched

  # ─────────────────────────────────────────────────────────────────────
  # AC #7 — Per-feature attempts reset + feedback injection
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Resuming an escalated feature resets its per-feature step and injects feedback
    Given an escalated sprint where feature "beta" is "escalated" at step 5
    And state.features[beta].steps[step5].attempts is 3
    And state.features[beta].steps[step5].failures contains three FailureRecord entries
    When the user calls resume_sprint with action "request-changes", feedback "use a real fixture" and feature "beta"
    Then the runner locates the escalated step under state.features[beta].steps
    And state.features[beta].steps[step5].attempts is reset to 0
    And state.features[beta].steps[step5].failures is reset to []
    And state.features[beta].steps[step5].status is reset to "pending"
    And state.features[beta].status is set to "in-progress"
    And state.status is set to "in-progress"
    And the runner re-enters runSprintFromStep at the escalated step
    And the user's feedback is injected into the next agent invocation for feature "beta"

  # ─────────────────────────────────────────────────────────────────────
  # AC #8 — Sibling work is preserved
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Resuming an escalated feature does not alter a completed sibling
    Given an escalated sprint where feature "alpha" is "complete" and feature "beta" is "escalated"
    And feature "alpha" has all per-feature steps marked "complete" with recorded artifacts
    When the user resumes feature "beta" with request-changes feedback
    Then feature "alpha" status stays "complete"
    And every feature "alpha" step stays "complete"
    And feature "alpha" artifacts are untouched
    And only feature "beta" is reset and re-run

  # ─────────────────────────────────────────────────────────────────────
  # AC #9 — Re-escalation supported (no cap)
  # ─────────────────────────────────────────────────────────────────────

  Scenario: A re-engaged feature that fails again returns to escalated and is resumable
    Given an escalated sprint where feature "beta" was resumed with request-changes
    When feature "beta" fails its 3-attempt circuit breaker again
    Then state.features[beta].status returns to "escalated"
    And deriveSprintStatus(state.features) returns "escalated"
    And the user may resume feature "beta" again with no cap on re-attempts
    And each re-attempt receives a fresh 3-attempt budget

  Scenario: A re-engaged feature that succeeds makes an all-complete sprint finalize complete
    Given an escalated sprint where feature "alpha" is "complete" and feature "beta" is "escalated"
    When the user resumes feature "beta" with request-changes and it completes through Merge PR
    Then feature "beta" status becomes "complete"
    And all features are now "complete"
    And the sprint proceeds to shared steps 10–13
    And the sprint finalizes as "complete"

  # ─────────────────────────────────────────────────────────────────────
  # AC #11 — Clear escalated-state reporting
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Escalated reporting names the escalated feature, step, and resume command
    Given an escalated sprint where feature "beta" is "escalated" at step 5
    When run_sprint, get_project_status, or the progress table reports status
    Then the report identifies feature "beta" as escalated
    And the report identifies the step at which "beta" escalated
    And the report instructs running resume_sprint --action=request-changes [--feature=<slug>]

  # ─────────────────────────────────────────────────────────────────────
  # AC #12 — Error messaging updated; resume searches per-feature steps
  # ─────────────────────────────────────────────────────────────────────

  Scenario: A legitimately mixed sprint no longer triggers the "cannot be resumed" error
    Given an escalated mixed sprint with features "alpha" (complete) and "beta" (escalated)
    When the user calls resume_sprint with action "request-changes" and feedback
    Then the runner does NOT return "Sprint is in 'in-progress' status and cannot be resumed"
    And the runner does NOT return "Sprint is marked as escalated but no escalated step found"
    And the resume path searches state.features[i].steps for the escalated step

  # ─────────────────────────────────────────────────────────────────────
  # Edge cases
  # ─────────────────────────────────────────────────────────────────────

  Scenario: All features escalated requires an explicit feature argument
    Given an escalated sprint where features "alpha" and "beta" are both "escalated"
    When the user calls resume_sprint with action "request-changes" and no feature argument
    Then the runner errors per the multi-target rule
    And the error lists all escalated slugs "alpha" and "beta"

  Scenario: Resuming a genuinely in-progress sprint is still refused
    Given a sprint where feature "alpha" is "complete" and feature "beta" is "in-progress"
    And no feature is escalated
    When the user calls resume_sprint
    Then the runner refuses to resume the true in-progress sprint
    And existing behavior is unchanged

  Scenario: A feature slug that does not exist returns a clear error
    Given an escalated sprint where feature "beta" is "escalated"
    When the user calls resume_sprint with feature "does-not-exist"
    Then the runner returns an error naming the valid escalated slugs
    And no feature state is mutated

  Scenario: A feature slug that exists but is not escalated returns a clear error
    Given an escalated sprint where feature "alpha" is "complete" and feature "beta" is "escalated"
    When the user calls resume_sprint with feature "alpha"
    Then the runner returns an error naming the valid escalated slugs
    And no feature state is mutated

  Scenario: approve on an escalated sprint returns a redirect message and does not mutate state
    Given an escalated sprint where feature "beta" is "escalated"
    When the user calls resume_sprint with action "approve"
    Then the runner returns a clear message that approve cannot finalize a stalled feature
    And the message directs the user to request-changes (with feedback) or the reset path
    And no feature or sprint state is mutated

  Scenario: Single-feature sprint escalation continues to resume via the top-level steps path
    Given a single-feature sprint (state.features is null) escalated at a top-level step
    When the user calls resume_sprint with action "request-changes" and feedback
    Then the existing single-feature escalated-resume path searches state.steps
    And the escalated step's attempts and failures are reset
    And the runner re-enters at the escalated top-level step
    And behavior is unchanged from before this feature
