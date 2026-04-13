Feature: Scoped Test Execution
  As the Raptor orchestrator
  I want engineers to run only feature-scoped tests during implementation
  So that parallel agents don't cause test deadlocks

  Scenario: Jest project gets scoped test command
    Given a project with package.json containing jest
    When building scoped test command for feature "agent-parallel-execution"
    Then the command is 'npx jest --testPathPattern="agent-parallel-execution"'

  Scenario: Pytest project gets scoped test command
    Given a project with pyproject.toml
    When building scoped test command for feature "data-pipeline"
    Then the command is 'pytest -k "data-pipeline"'

  Scenario: Cargo project gets scoped test command
    Given a project with Cargo.toml
    When building scoped test command for feature "auth-module"
    Then the command is 'cargo test auth-module'

  Scenario: Unknown project gets no scoping
    Given a project with no recognized package manifest
    When building scoped test command
    Then no specific command is returned

  Scenario: Custom test command from config
    Given config has testConfig.testCommand = "npm test -- --grep={slug}"
    When building scoped test command for feature "my-feature"
    Then the command is 'npm test -- --grep=my-feature'

  Scenario: Engineer task description includes scoped test instruction
    Given step 5 (Implement TDD) for feature "dino-agent-names"
    When the task description is built
    Then it includes "Run ONLY tests matching your feature"
    And it includes the scoped test command

  Scenario: QA test run uses full suite
    Given step 7 (Run test suite)
    When the task description is built
    Then it includes the full test command (no scoping)

  Scenario: Shared config warning in multi-feature mode
    Given a multi-feature sprint
    When building task description for an engineer step
    Then it includes a warning about not modifying shared config files

  Scenario: No shared config warning in single-feature mode
    Given a single-feature sprint
    When building task description for an engineer step
    Then it does not include the shared config warning

  Scenario: Feature slug with special characters is escaped
    Given a feature slug "my-feature.v2"
    When escaping for test pattern
    Then the dot is escaped to "my-feature\\.v2"
