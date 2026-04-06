Feature: Multi-Engineer Coordination
  As the Raptor orchestrator
  I want to support multiple features in a single sprint
  So that larger sprints can be executed concurrently

  Background:
    Given a project with multiple features in the sprint backlog

  Scenario: Multi-feature mode detected from backlog
    Given the sprint backlog has 3 items
    When the runner starts the sprint
    Then multi-feature mode is activated
    And a FeatureState is created for each backlog item

  Scenario: Single-feature mode backward compatibility
    Given the sprint backlog has 1 item
    When the runner starts the sprint
    Then single-feature mode is used (existing path)
    And no FeatureState array is created

  Scenario: Each feature gets its own branch
    Given multi-feature mode is active
    When the engineer step begins for feature "agent-parallel-execution"
    Then a branch "sprint-5/agent-parallel-execution" is created
    And FeatureState.branchName is set

  Scenario: Engineer steps run concurrently across features
    Given features A and B are both at step 5
    When the runner executes step 5
    Then both engineer agents are spawned concurrently
    And each works on its own feature branch

  Scenario: Per-feature DoD tracking
    Given multi-feature mode is active
    When feature A's PR review is approved
    Then only feature A's dod.prReviewApproved is set to true
    And feature B's dod.prReviewApproved remains false

  Scenario: One feature fails without blocking others
    Given features A and B are in progress
    When feature A's engineer step escalates
    Then feature B continues to the next step
    And the sprint status is "partial"

  Scenario: Sprint completes only when all features are done
    Given feature A is complete and feature B is in progress
    Then the sprint status is not "complete"
    When feature B completes
    Then the sprint status is "complete"

  Scenario: Progress table shows per-feature grouping
    Given multi-feature mode is active with 2 features
    Then the progress table has a section for each feature
    And each section has its own step rows

  Scenario: Retro and feedback run once per sprint
    Given all features are complete
    When the runner reaches step 10 (feedback)
    Then it runs once for the whole sprint
    And step 11-13 (retro) also run once

  Scenario: Per-feature state persistence
    Given multi-feature sprint state is saved
    When the state is loaded from disk
    Then the features array is restored with all FeatureState data
    And backward compatibility defaults features to null for old states
