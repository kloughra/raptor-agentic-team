Feature: Sprint Completion on Merge — PR Merge as Sprint Exit Gate
  As a user running sprints through Raptor
  I want the sprint to end by merging the PR after all approvals
  So that the sprint has a clean endpoint tied to a real merge event

  Background:
    Given a project "merge-app" has been bootstrapped by Raptor
    And the project backlog contains a sprint 1 item "dashboard: Dashboard widgets"
    And the sprint has progressed through steps 1-8

  # --- Workflow structure ---

  Scenario: Workflow now has 10 steps including Merge PR
    When I inspect the sprint workflow definition
    Then it should have 10 steps in order:
      | step | role      | name                 |
      | 1    | po        | Author specification |
      | 2    | architect | Architecture design  |
      | 3    | qa        | Write tests          |
      | 4    | po        | Review tests         |
      | 5    | engineer  | Implement (TDD)      |
      | 6    | engineer  | Open PR              |
      | 7    | qa        | Run test suite       |
      | 8    | team      | Demo                 |
      | 9    | engineer  | Merge PR             |
      | 10   | po        | Process feedback     |

  Scenario: Merge PR step has no checkpoint
    When I inspect step 9 (Merge PR)
    Then it should not have a checkpointAfter property
    And it should proceed automatically after step 8 is approved

  # --- Auto-merge after demo approval ---

  Scenario: PR is merged automatically after demo approval
    Given the sprint is paused at checkpoint "demo-feedback" (step 8)
    When I call resume_sprint with action "approve"
    Then step 9 (Merge PR) should execute automatically
    And the sprint PR should be squash-merged
    And no additional user input should be required for the merge

  Scenario: Merge commit message references feature slug and sprint
    Given the demo has been approved and merge step is executing
    When the PR is merged
    Then the merge commit message should contain "Sprint 1"
    And the merge commit message should contain "dashboard"

  # --- GitHub merge path ---

  Scenario: Merge via GitHub when gh CLI is available and PR exists
    Given the sprint branch has an open GitHub PR
    And the gh CLI is available
    When step 9 (Merge PR) executes
    Then the orchestrator should use "gh pr merge --squash"
    And the merge method should be recorded as "github"

  Scenario: PR already merged on GitHub
    Given the sprint branch PR has already been merged on GitHub
    When step 9 (Merge PR) executes
    Then the orchestrator should detect the PR is already merged
    And the step should be marked "complete" without re-merging
    And the sprint should proceed to step 10

  Scenario: PR was closed without merging
    Given the sprint branch PR was closed without merging
    When step 9 (Merge PR) executes
    Then the orchestrator should escalate to the user
    And the escalation message should indicate the PR was closed unexpectedly

  # --- Local merge fallback ---

  Scenario: Merge via local git when gh CLI is not available
    Given the gh CLI is not available
    When step 9 (Merge PR) executes
    Then the orchestrator should fall back to local git merge
    And should run "git checkout main"
    And should run "git merge --squash" with the sprint branch
    And should commit with a message referencing the feature slug and sprint
    And the merge method should be recorded as "local"

  Scenario: Merge via local git when project has no GitHub remote
    Given the project has no GitHub remote configured
    When step 9 (Merge PR) executes
    Then the orchestrator should use local git merge
    And the merge method should be recorded as "local"

  # --- Merge failures ---

  Scenario: Merge fails due to conflicts
    Given the sprint branch has merge conflicts with main
    When step 9 (Merge PR) executes
    Then the merge should fail
    And the orchestrator should escalate with conflict details
    And the sprint status should be "escalated"
    And the escalation message should mention merge conflicts

  Scenario: Merge failure participates in circuit breaker
    Given step 9 (Merge PR) fails on the first attempt
    When the orchestrator retries the merge
    Then it should retry up to 3 times per the circuit breaker
    And after 3 failures it should escalate

  # --- Post-merge behavior ---

  Scenario: PO processes feedback on main branch after merge
    Given the PR has been successfully merged
    When step 10 (Process feedback) executes
    Then the PO agent should run in the project directory
    And the active branch should be "main"
    And the PO should update the backlog on main

  Scenario: Sprint status is "complete" after step 10 finishes
    Given step 9 (Merge PR) completed successfully
    And step 10 (Process feedback) completed successfully
    Then the sprint status should be "complete"
    And the progress table should show all 10 steps as "✅"

  # --- State tracking ---

  Scenario: Branch name is tracked in sprint state
    When I call run_sprint for the project
    Then the sprint state should include a branchName field
    And the branchName should match the current git branch

  Scenario: Merge status visible in get_project_status
    Given the sprint PR has been merged (step 9 complete)
    When I call get_project_status with name "merge-app"
    Then the sprint section should include "merged: true"

  Scenario: get_project_status shows merged false before merge
    Given the sprint is at step 7 (QA test suite)
    When I call get_project_status with name "merge-app"
    Then the sprint section should include "merged: false"

  # --- Definition of Done ---

  Scenario: DoD is validated before merge is attempted
    Given step 8 (Demo) has been approved
    When step 9 (Merge PR) begins
    Then the orchestrator should verify: all tests passed (step 7 complete)
    And the orchestrator should verify: PR review approved (step 6 checkpoint resolved)
    And the orchestrator should verify: PO accepted (step 8 checkpoint resolved)
    When all DoD checks pass
    Then the merge should proceed

  # --- Handoff map ---

  Scenario: Handoff after merge step
    When step 9 (Merge PR) completes
    Then a handoff commit should be created: "[HANDOFF] ENGINEER -> PO: merged PR for dashboard"

  # --- Edge cases ---

  Scenario: Demo checkpoint rejected does not trigger merge
    Given the sprint is paused at checkpoint "demo-feedback" (step 8)
    When I call resume_sprint with action "request-changes" and feedback "Sorting is broken"
    Then step 9 (Merge PR) should NOT execute
    And the sprint should loop back for rework

  Scenario: Sprint state with old 9-step workflow
    Given a sprint state file with 9 steps from a previous sprint
    When the orchestrator loads the state
    Then it should handle the old format gracefully
    And should not crash or corrupt the state
