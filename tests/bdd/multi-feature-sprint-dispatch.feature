Feature: Multi-Feature Sprint Dispatch
  As the Raptor orchestrator
  I want runSprintFromStep to detect every backlog item in the sprint section and dispatch the per-feature workflow for each one
  So that multi-item sprints execute every feature instead of silently dropping all but the first

  Background:
    Given a project registered with Raptor
    And the project has a docs/backlog.md file
    And the runner has access to multi-runner helpers (detectSprintFeatures, createFeatureStates, featureBranchName, allFeaturesComplete, anyFeaturesEscalated, deriveSprintStatus)

  # ─────────────────────────────────────────────────────────────────────
  # AC #1, #2 — Detection on entry and state population
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Detection on entry seeds state.features with all sprint items
    Given the sprint 7 section of docs/backlog.md contains:
      | - [ ] feature-a: First feature  |
      | - [ ] feature-b: Second feature |
      | - [ ] feature-c: Third feature  |
    And no sprint state file exists for sprint 7
    When runSprintFromStep is invoked for sprint 7
    Then detectSprintFeatures is called with the project path and sprint number 7
    And state.features is populated with three FeatureState entries via createFeatureStates
    And state.features[0].slug is "feature-a"
    And state.features[1].slug is "feature-b"
    And state.features[2].slug is "feature-c"
    And state.features is persisted via saveSprintState before any workflow step executes

  Scenario: Single-feature sprint takes the existing path (backward compatibility)
    Given the sprint 7 section of docs/backlog.md contains:
      | - [ ] only-feature: The lone item |
    When runSprintFromStep is invoked for sprint 7
    Then state.features remains null
    And the runner uses the existing single-feature path with extractFeatureSlug
    And output validation, branch handling, and progress rendering behave exactly as today

  Scenario: Empty sprint returns the existing error result and marks the sprint failed
    Given the sprint 7 section of docs/backlog.md is empty (zero items)
    When runSprintFromStep is invoked for sprint 7
    Then the runner returns an error result with message "Could not extract feature slug from backlog. Ensure the sprint section has items in the format: - [ ] slug: description"
    And state.status is "failed"
    And no workflow steps execute

  Scenario: Duplicate slugs in the sprint section are rejected before dispatch
    Given the sprint 7 section of docs/backlog.md contains:
      | - [ ] feature-a: First copy  |
      | - [ ] feature-a: Second copy |
      | - [ ] feature-b: Different   |
    When runSprintFromStep is invoked for sprint 7
    Then the runner returns an error result naming the duplicate slug "feature-a"
    And state.status is "failed"
    And no workflow steps execute

  # ─────────────────────────────────────────────────────────────────────
  # AC #3, #5 — Per-feature dispatch and state
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Per-feature dispatch runs steps 1–9 once for every feature
    Given a multi-feature sprint with features "alpha", "beta", "gamma"
    When the runner reaches workflow step 1 (Author specification)
    Then the step's agent flow is dispatched once per feature, in array order
    And each invocation receives the feature's slug for prompt substitution and validation
    And per-feature step state is recorded under state.features[i].steps[j], not state.steps

  Scenario: Each feature's per-step state tracks attempts, artifacts, failures, and completedAt independently
    Given a multi-feature sprint with features "alpha" and "beta"
    When feature "alpha" completes step 5 on attempt 1
    And feature "beta" fails step 5 twice before succeeding on attempt 3
    Then state.features[alpha].steps[step5].attempts equals 1
    And state.features[beta].steps[step5].attempts equals 3
    And state.features[beta].steps[step5].failures contains two FailureRecord entries
    And both per-feature step entries have a completedAt timestamp

  # ─────────────────────────────────────────────────────────────────────
  # AC #4 — Per-feature branch (bundled sprint-branch-auto-create)
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Each feature is checked out onto its own sprint-{N}/{slug} branch
    Given a multi-feature sprint 7 with features "alpha" and "beta"
    When dispatchPerFeatureStep runs for the first code-producing step of feature "alpha"
    Then ensureFeatureBranch creates branch "sprint-7/alpha" if it does not exist
    And the working tree HEAD is on "sprint-7/alpha" before the step body runs
    When dispatchPerFeatureStep runs for the same step of feature "beta"
    Then ensureFeatureBranch checks out branch "sprint-7/beta"
    And no commits land on "main" or on "sprint-7/alpha" for the "beta" work

  Scenario: ensureFeatureBranch is idempotent for an already-checked-out branch
    Given branch "sprint-7/alpha" already exists locally
    And HEAD is currently on "sprint-7/alpha"
    When ensureFeatureBranch is called for sprint 7 and slug "alpha"
    Then the result is { created: false, checkedOut: false }
    And no git checkout command is issued

  Scenario: ensureFeatureBranch surfaces an error when an existing branch is divergent
    Given branch "sprint-7/alpha" exists locally
    And HEAD is on a different branch with uncommitted changes that block checkout
    When ensureFeatureBranch is called for sprint 7 and slug "alpha"
    Then the result has error "Branch 'sprint-7/alpha' exists with divergent state; resolve manually."
    And the error is converted to a per-feature "failed" outcome by dispatchPerFeatureStep
    And other features in the sprint continue to dispatch

  Scenario: Single-feature path also runs through ensureFeatureBranch (bundled fix)
    Given a single-feature sprint 7 with slug "lonely"
    And HEAD is on "main"
    When runSprintFromStep is invoked for sprint 7
    Then ensureFeatureBranch creates branch "sprint-7/lonely"
    And state.branchName is set to "sprint-7/lonely"
    And no commits land on "main"

  # ─────────────────────────────────────────────────────────────────────
  # AC #6 — Sprint-shared steps (10–13)
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Steps 10–13 run exactly once per sprint regardless of feature count
    Given a multi-feature sprint with three features all complete through step 9
    When the runner reaches step 10 (Process feedback)
    Then step 10 executes once against state.steps[9] (not per-feature)
    When the runner reaches steps 11, 12, 13 (retro proposals, review, apply)
    Then each shared step executes exactly once
    And state.features is not iterated for these steps

  # ─────────────────────────────────────────────────────────────────────
  # AC #7 — Failure isolation
  # ─────────────────────────────────────────────────────────────────────

  Scenario: One feature's failure does not block other features at the same step
    Given a multi-feature sprint with features "alpha", "beta", "gamma"
    When feature "alpha" escalates at step 5
    Then dispatchPerFeatureStep continues with feature "beta" and feature "gamma" for step 5
    And every feature has had a chance to run step 5 before escalation propagates upward

  Scenario: Sprint status is derived from per-feature statuses
    Given a multi-feature sprint where:
      | feature | status     |
      | alpha   | complete   |
      | beta    | escalated  |
    When dispatchPerFeatureStep recomputes sprint status after step 5
    Then deriveSprintStatus(state.features) returns "escalated"
    And the runner returns an "escalated" SprintResult after this step finishes

  # ─────────────────────────────────────────────────────────────────────
  # AC #8 — Per-feature DoD
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Each feature has its own independent DoD checklist
    Given a multi-feature sprint with features "alpha" and "beta"
    When feature "alpha" passes PR review at step 6
    Then state.features[alpha].dod.prReviewApproved is true
    And state.features[beta].dod.prReviewApproved is false

  Scenario: Sprint completes only when allFeaturesComplete returns true
    Given a multi-feature sprint with features "alpha" and "beta"
    And feature "alpha" has all per-feature steps complete
    And feature "beta" is still in-progress at step 5
    Then allFeaturesComplete(state.features) returns false
    And the sprint status is not "complete"
    When feature "beta" completes all per-feature steps
    Then allFeaturesComplete(state.features) returns true
    And after shared steps 10–13 finish the sprint status becomes "complete"

  # ─────────────────────────────────────────────────────────────────────
  # AC #9 — Progress visibility
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Progress table shows per-feature rows for steps 1–9 in multi-feature mode
    Given a multi-feature sprint with two features
    When renderProgressTable is called
    Then the output contains a "Per-Feature Progress" section
    And each feature has its own subtable with rows for steps 1–9
    And shared steps 10–13 appear once at the top-level state.steps table
    And the top-level rows for steps 1–9 are annotated with "(per-feature)"

  Scenario: Single-feature sprint progress rendering is unchanged
    Given a single-feature sprint
    When renderProgressTable is called
    Then no "Per-Feature Progress" section is emitted
    And the output matches the existing single-feature format byte-for-byte

  # ─────────────────────────────────────────────────────────────────────
  # AC #10, #11, #12 — Backward compat and resume
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Resuming a multi-feature sprint preserves the existing features array
    Given a sprint state file already has state.features populated with two features
    And the user appends a new "- [ ] late-add: late item" to the backlog after the run started
    When runSprintFromStep is invoked again to resume the sprint
    Then state.features is NOT re-seeded from detectSprintFeatures
    And the new "late-add" item is ignored for this sprint
    And state.features still contains exactly the original two features

  Scenario: Resume skips per-feature steps that are already complete
    Given a multi-feature sprint where feature "alpha" has steps 1–4 complete and step 5 pending
    And feature "beta" has only step 1 complete
    When runSprintFromStep is invoked to resume
    Then dispatchPerFeatureStep skips alpha's steps 1–4 and runs alpha's step 5
    And dispatchPerFeatureStep skips beta's step 1 and runs beta's steps 2 onward

  Scenario: Single-feature sprint is not silently upgraded if the user later edits the backlog
    Given a sprint state file was created in single-feature mode (state.features is null)
    And the user later adds a second "- [ ] new-feature: second" to the sprint section
    When the sprint is resumed
    Then behavior remains single-feature for that sprint state file
    And state.features stays null

  # ─────────────────────────────────────────────────────────────────────
  # AC #13 — Streaming checkpoints
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Checkpoints stream — one feature pause at a time, in array order
    Given a multi-feature sprint with features "alpha", "beta", "gamma"
    And step 1 has checkpointAfter "spec-review"
    When step 1 completes for feature "alpha"
    Then runSprintFromStep returns a SprintResult with status "checkpoint"
    And the checkpoint payload's feature field equals "alpha"
    And the checkpoint title is suffixed with " — alpha"
    And the checkpoint context is prefixed with "**Feature:** alpha"
    And state.status is "paused"
    And state.currentFeatureSlug equals "alpha"
    When the user approves the alpha checkpoint via resume_sprint
    Then runSprintFromStep re-enters dispatchPerFeatureStep
    And the next checkpoint returned has feature "beta"
    And feature "gamma" has not yet been dispatched for step 1

  Scenario: request-changes resets only the affected feature's per-feature step
    Given a multi-feature sprint paused at a checkpoint for feature "alpha" at step 1
    And feature "beta" already has step 1 marked complete
    When the user submits "request-changes" with feedback "tighten the spec"
    Then state.features[alpha].steps[step1].status is reset to "pending"
    And state.features[alpha].steps[step1].artifacts is []
    And state.features[alpha].steps[step1].completedAt is null
    And state.features[alpha].steps[step1].attempts is 0
    And state.features[alpha].steps[step1].failures is []
    And state.features[beta].steps[step1] is unchanged (still complete)

  # ─────────────────────────────────────────────────────────────────────
  # AC #14 — Tool surface unchanged
  # ─────────────────────────────────────────────────────────────────────

  Scenario: run_sprint and resume_sprint MCP tool inputs/return shapes are unchanged
    Given the run_sprint MCP tool schema
    Then no new required fields exist for multi-feature mode
    And the SprintResult shape is unchanged except for the additive optional checkpoint.feature field
    And multi-feature mode is fully driven by docs/backlog.md content

  # ─────────────────────────────────────────────────────────────────────
  # Edge cases
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Already-checked items ([x]) are seeded as features pre-marked complete
    Given the sprint 7 section of docs/backlog.md contains:
      | - [x] done-before: Already done    |
      | - [ ] still-todo:  Not yet started |
    When runSprintFromStep is invoked for sprint 7
    Then state.features[done-before].status is "complete"
    And every per-feature step under "done-before" has status "complete"
    And state.features[still-todo].status is "pending"
    And dispatch only runs steps for "still-todo"

  Scenario: Mid-sprint added item is not auto-added to a populated state
    Given a multi-feature sprint with state.features already populated for "alpha" and "beta"
    When the user appends "- [ ] new-mid-sprint: surprise" to the sprint section
    And the runner is invoked again
    Then state.features still contains exactly "alpha" and "beta"
    And "new-mid-sprint" is treated as next-sprint scope

  Scenario: Feature escalation while others continue eventually escalates the sprint
    Given a multi-feature sprint with features "alpha", "beta", "gamma"
    When feature "alpha" escalates at step 5
    And features "beta" and "gamma" complete all remaining per-feature steps
    Then state.features[alpha].status is "escalated"
    And state.features[beta].status is "complete"
    And state.features[gamma].status is "complete"
    And deriveSprintStatus(state.features) returns "escalated"
    And the user is notified at the next checkpoint

  Scenario: Pre-existing branch with no divergence is checked out, not recreated
    Given branch "sprint-7/alpha" already exists locally with no divergence
    When ensureFeatureBranch is called for sprint 7 and slug "alpha"
    Then the branch is checked out (not recreated)
    And the result is { created: false, checkedOut: true }
