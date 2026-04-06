Feature: Agent Failure Recovery — Circuit Breaker & Resilient Retry
  As a user running sprints through Raptor
  I want the orchestrator to retry failed steps with context and escalate after repeated failures
  So that a single agent hiccup doesn't kill an entire sprint

  Background:
    Given a project "recovery-app" has been bootstrapped by Raptor
    And the project backlog contains a sprint 1 item "search-feature: Full-text search"

  # --- Retry loop ---

  Scenario: Orchestrator retries a failed step up to 3 times
    Given step 1 (PO spec) agent fails on the first attempt
    When the orchestrator handles the failure
    Then it should retry the step
    And the retry count should show "attempt 2/3"
    When the second attempt also fails
    Then it should retry again with "attempt 3/3"

  Scenario: Successful retry after initial failure
    Given step 1 (PO spec) agent fails on the first attempt
    When the orchestrator retries and the second attempt succeeds
    Then step 1 should be marked as "complete"
    And the failure history should record 1 failed attempt
    And the sprint should continue to step 2

  Scenario: Each retry includes progressive context
    Given step 1 (PO spec) agent fails on attempt 1 with output "Missing backlog context"
    When the orchestrator retries (attempt 2)
    Then the agent should receive context including:
      | field                | value                        |
      | attempt_number       | 2 of 3                       |
      | previous_error       | Missing backlog context       |
      | guidance             | Your previous attempt failed  |
    When attempt 2 also fails with output "Spec template malformed"
    Then attempt 3 should receive both previous error outputs

  Scenario: Partial artifacts from failed attempt are passed to retry
    Given step 1 (PO spec) agent fails but produces a partial file at "docs/specs/search-feature.md"
    When the orchestrator retries
    Then the retry context should include the partial artifact content
    And the guidance should mention partial artifacts were preserved

  # --- Escalation ---

  Scenario: Escalation after 3 failures
    Given step 1 (PO spec) agent has failed 3 times
    When the third attempt fails
    Then the sprint status should be "escalated"
    And an "[ESCALATE]" commit should be created in the project repo
    And the escalation commit should include a summary of all 3 attempts
    And the escalation should identify the failed step and role

  Scenario: Immediate escalation on BLOCKER in agent output
    Given step 3 (QA tests) agent output contains "[BLOCKER] QA: spec is missing acceptance criteria -- blocked on PO"
    When the orchestrator processes the agent result
    Then it should escalate immediately without further retries
    And the sprint status should be "escalated"
    And the escalation should include the blocker message

  Scenario: Escalation commit format
    Given step 2 (Architect design) has been escalated after 3 failures
    Then the project repo should contain a commit matching:
      """
      [ESCALATE] Architect: step 2 (Architecture design) failed 3 times — requesting user intervention.
      """

  # --- Failure history persistence ---

  Scenario: Failure history is persisted in sprint state
    Given step 1 (PO spec) has failed twice and succeeded on attempt 3
    When I inspect the sprint state file
    Then step 1 should have attempts equal to 3
    And step 1 should have 2 failure records
    And each failure record should include:
      | field              |
      | attempt            |
      | errorSummary       |
      | timestamp          |
      | hadPartialArtifacts|

  Scenario: Each step maintains independent retry counter
    Given step 1 (PO spec) failed once then succeeded
    And step 2 (Architect design) fails on the first attempt
    Then step 1 should have attempts equal to 2
    And step 2 should have attempts equal to 1
    And the retry counters should be independent

  # --- Resume from failed/escalated ---

  Scenario: Resume escalated sprint with user guidance
    Given the sprint is in "escalated" status at step 2
    When I call resume_sprint with action "approve" and feedback "Use SQLite instead of PostgreSQL"
    Then the retry counter for step 2 should reset to 0
    And the failure history should be cleared
    And the Architect agent should receive "Use SQLite instead of PostgreSQL" as context
    And the sprint should continue from step 2

  Scenario: Resume failed sprint with user guidance
    Given the sprint is in "failed" status at step 3
    When I call resume_sprint with action "approve" and feedback "Skip performance tests for now"
    Then the retry counter for step 3 should reset to 0
    And the sprint should continue from step 3

  Scenario: Resume escalated sprint without guidance returns error
    Given the sprint is in "escalated" status at step 2
    When I call resume_sprint with action "approve" and no feedback
    Then the result status should be "error"
    And the result message should indicate that guidance is required for escalated sprints

  Scenario: Resume failed sprint without guidance preserves attempt counter
    Given the sprint is in "failed" status at step 3 with 2 previous attempts
    When I call resume_sprint with action "approve" and no feedback
    Then the retry counter should NOT reset
    And the sprint should continue from step 3 with the existing attempt count

  # --- Progress table ---

  Scenario: Progress table shows retry status
    Given step 2 is being retried (attempt 2 of 3)
    Then the progress table should show step 2 as "⚠ attempt 2/3"

  Scenario: Progress table shows escalation status
    Given step 2 has been escalated
    Then the progress table should show step 2 as "🚨 escalated (3/3)"
    And the sprint header should indicate "escalated" status

  # --- get_project_status ---

  Scenario: Project status includes escalation details
    Given a sprint is in "escalated" status at step 2
    When I call get_project_status with name "recovery-app"
    Then the orchestrator section should show status "escalated"
    And the response should include the escalated step number and role
    And the response should include the failure records for the escalated step

  # --- Edge cases ---

  Scenario: Agent produces no output at all
    Given step 1 (PO spec) agent returns empty output on attempt 1
    When the orchestrator retries with a simplified prompt
    And the agent still returns empty output after 3 attempts
    Then the escalation should include "agent produced no output"

  Scenario: Sprint state file is corrupted
    Given the sprint state file contains invalid JSON
    When I call resume_sprint for the project
    Then the result status should be "error"
    And the result message should suggest re-running the sprint from step 1

  Scenario: Step fails with non-zero exit code but produces valid output
    Given step 1 agent exits with code 1 but produces "docs/specs/search-feature.md"
    When the orchestrator evaluates the step
    Then it should treat it as a failure (non-zero exit code)
    And the partial artifact should be recorded in the failure history
