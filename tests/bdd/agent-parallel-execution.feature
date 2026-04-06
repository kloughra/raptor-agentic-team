Feature: Agent Parallel Execution
  As the Raptor orchestrator
  I want to run workflow steps in parallel where allowed
  So that sprints complete faster

  Background:
    Given a project with a sprint in progress
    And the workflow has parallel-eligible steps defined

  Scenario: Step 7 Architect review and QA test run execute concurrently
    Given steps 1-6 are complete
    When the runner reaches the parallel group (Architect review + QA test run)
    Then both agents are spawned concurrently via Promise.allSettled
    And both steps show as "in-progress" in the progress table simultaneously
    And the runner waits for both to complete before advancing

  Scenario: Both parallel steps succeed
    Given a parallel group is executing
    When both steps complete successfully
    Then both steps are marked "complete"
    And the runner advances to the next sequential step

  Scenario: One parallel step fails after retries
    Given a parallel group is executing
    When one step fails after 3 retries
    And the other step succeeds
    Then the failed step is marked "escalated"
    And the successful step's artifacts are preserved
    And the sprint status is "escalated"

  Scenario: One parallel step raises a BLOCKER
    Given a parallel group is executing
    When one step raises a [BLOCKER]
    Then that step is immediately escalated
    And the other step is allowed to finish
    And the escalation message includes the BLOCKER details

  Scenario: Both parallel steps fail
    Given a parallel group is executing
    When both steps fail after retries
    Then both escalation messages are included in the result
    And the sprint status is "escalated"

  Scenario: Circuit breaker applies independently per parallel step
    Given a parallel group is executing
    When step A fails on attempt 1 and succeeds on attempt 2
    And step B succeeds on attempt 1
    Then step A shows 2 attempts
    And step B shows 1 attempt
    And the group succeeds overall

  Scenario: WorkflowStep has parallelWith field
    Given the workflow definition
    Then steps marked with parallelWith reference a valid step number
    And parallel groups are always pairs

  Scenario: Progress table shows parallel steps correctly
    Given two steps are running in parallel
    Then the progress table shows both with the "in-progress" icon
    And no other steps are marked "in-progress"
