Feature: Progressive Retry with Scope Narrowing
  As a sprint orchestrator
  I want failed steps to narrow their scope on the final retry
  So more steps succeed without escalation

  Scenario: Attempts 1-2 retry with full scope
    Given a step that fails on attempt 1
    When attempt 2 is executed
    Then the task description is the same full-scope description
    And no scope narrowing is applied

  Scenario: Attempt 3 triggers scope narrowing for Engineer
    Given an Engineer step that has failed twice
    And the spec has 3 acceptance criteria
    When attempt 3 is executed
    Then the task is decomposed into 3 sub-tasks
    And each sub-task targets one acceptance criterion

  Scenario: Attempt 3 triggers scope narrowing for QA
    Given a QA step that has failed twice
    And the spec describes happy path and error scenarios
    When attempt 3 is executed
    Then the task is decomposed into scenario groups
    And groups include happy-path and error-cases

  Scenario: Attempt 3 triggers scope narrowing for Architect
    Given an Architect step that has failed twice
    And the spec mentions 2 distinct components
    When attempt 3 is executed
    Then the task is decomposed into 2 component sub-tasks

  Scenario: All sub-tasks succeed
    Given a narrowed retry with 3 sub-tasks
    When all 3 sub-tasks complete successfully
    Then the step is marked as complete
    And the aggregated output combines all sub-task results

  Scenario: Partial sub-task success
    Given a narrowed retry with 4 sub-tasks
    When 3 sub-tasks succeed and 1 fails
    Then the step is escalated
    And the failure record includes "3/4 sub-tasks completed"
    And partial artifacts from successful sub-tasks are preserved

  Scenario: All sub-tasks fail
    Given a narrowed retry with 3 sub-tasks
    When all 3 sub-tasks fail
    Then the step is escalated normally
    And the failure record reflects the narrowed attempt

  Scenario: PO role is not narrowed
    Given a PO step that has failed twice
    When attempt 3 is executed
    Then no scope narrowing is applied
    And the step retries with full scope

  Scenario: Decomposition produces single sub-task
    Given an Engineer step that has failed twice
    And the spec has only 1 acceptance criterion
    When decomposition is attempted
    Then it falls back to normal retry with full scope

  Scenario: Progress table shows narrowing status
    Given a step is running in narrowed mode with 2 of 4 sub-tasks complete
    When the progress table is rendered
    Then the step status shows "narrowed (2/4)"

  Scenario: Sub-task count is capped
    Given a spec with 10 acceptance criteria
    When decomposition is performed for Engineer
    Then the sub-task count is capped at 6

  Scenario: Scope narrowing can be disabled via config
    Given raptor config has scopeNarrowing.enabled set to false
    When attempt 3 is executed for a failed step
    Then no scope narrowing is applied
