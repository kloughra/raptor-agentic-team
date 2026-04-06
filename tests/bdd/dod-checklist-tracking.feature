Feature: DoD Checklist Tracking — Accurate Completion Status on Merge
  As a user reviewing merged sprint PRs
  I want the Definition of Done checklist to accurately reflect all items satisfied
  So that merged PRs are trustworthy records of sprint completion

  Background:
    Given a project "dod-app" has been bootstrapped by Raptor
    And a sprint is in progress

  # --- DoD field tracking ---

  Scenario: DoD fields are all false at sprint start
    When I call run_sprint
    Then the sprint state dod should have all fields set to false

  Scenario: codeCommitted is set when PR is opened
    When step 6 (Open PR) completes
    Then dod.codeCommitted should be true

  Scenario: prReviewApproved is set when PR review checkpoint is approved
    Given the sprint is paused at checkpoint "pr-review"
    When I call resume_sprint with action "approve"
    Then dod.prReviewApproved should be true

  Scenario: testsPass is set when test suite completes
    When step 7 (Run test suite) completes
    Then dod.testsPass should be true

  Scenario: demoCompleted is set when demo completes
    When step 8 (Demo) completes
    Then dod.demoCompleted should be true

  Scenario: poAccepted is set when demo feedback checkpoint is approved
    Given the sprint is paused at checkpoint "demo-feedback"
    When I call resume_sprint with action "approve"
    Then dod.poAccepted should be true

  Scenario: All DoD fields are true before merge
    Given steps 6-8 have completed and both checkpoints approved
    Then all dod fields should be true
    And the progress table should show "Definition of Done: ✅ all items satisfied"

  # --- PR description update ---

  Scenario: PR description is updated before merge when gh is available
    Given all DoD items are satisfied
    And gh CLI is available
    When step 9 (Merge PR) begins
    Then the orchestrator should update the PR description via "gh pr edit"
    And all DoD checklist items should change from "- [ ]" to "- [x]"

  Scenario: PR description update fallback when gh is unavailable
    Given all DoD items are satisfied
    And gh CLI is not available
    When step 9 (Merge PR) begins
    Then the PR description update should be skipped
    And a DoD summary should be included in the merge commit message instead

  Scenario: PR description update failure does not block merge
    Given gh CLI is available but "gh pr edit" fails
    When the orchestrator attempts to update the PR description
    Then it should log the failure
    And the merge should proceed anyway

  # --- get_project_status ---

  Scenario: Project status includes DoD checklist
    Given the sprint is at step 7 with codeCommitted and prReviewApproved true
    When I call get_project_status
    Then the orchestrator section should include the dod object
    And dod.codeCommitted should be true
    And dod.prReviewApproved should be true
    And dod.testsPass should be false

  # --- Progress table ---

  Scenario: Progress table shows DoD status when all satisfied
    Given all DoD items are satisfied
    When I render the progress table
    Then it should include "Definition of Done: ✅ all items satisfied"

  Scenario: Progress table does not show DoD line when items are pending
    Given only codeCommitted and testsPass are true
    When I render the progress table
    Then it should not include a "Definition of Done" line

  # --- Backward compatibility ---

  Scenario: Old sprint state without dod field loads correctly
    Given an old sprint state file without a dod field
    When the orchestrator loads the state
    Then dod should default to all false
    And no error should occur
