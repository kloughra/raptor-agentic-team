Feature: Agent Timeout Scaling by Step Type
  As the Raptor orchestrator
  I want agent timeouts to scale based on step type
  So that complex steps get enough time to complete

  Scenario: QA test generation gets 30 minute timeout
    # Raised from 15 min after sprint-11-write-tests-escalation: real QA runs
    # took 13-19 min and the 15-min wall-clock cap killed a mid-write agent.
    Given the default timeout configuration
    When resolving timeout for step "Write tests"
    Then the timeout is 1800000ms (30 minutes)

  Scenario: Engineer implementation gets 10 minute timeout
    Given the default timeout configuration
    When resolving timeout for step "Implement (TDD)"
    Then the timeout is 600000ms (10 minutes)

  Scenario: Other steps use 5 minute default
    Given the default timeout configuration
    When resolving timeout for step "Open PR"
    Then the timeout is 300000ms (5 minutes)

  Scenario: Config overrides built-in defaults
    Given config has timeouts.stepOverrides["Write tests"] = 1200000
    When resolving timeout for step "Write tests"
    Then the timeout is 1200000ms (20 minutes)

  Scenario: Config default overrides global fallback
    Given config has timeouts.default = 420000
    When resolving timeout for step "Open PR" (no built-in override)
    Then the timeout is 420000ms (7 minutes)

  Scenario: Timeout capped at 30 minutes
    Given config has timeouts.stepOverrides["Write tests"] = 3600000
    When resolving timeout for step "Write tests"
    Then the timeout is capped at 1800000ms (30 minutes)

  Scenario: Invalid timeout falls back to default
    Given config has timeouts.stepOverrides["Write tests"] = -1
    When resolving timeout for step "Write tests"
    Then the built-in default of 1800000ms is used

  Scenario: Zero timeout falls back to default
    Given config has timeouts.stepOverrides["Write tests"] = 0
    When resolving timeout for step "Write tests"
    Then the built-in default of 1800000ms is used

  Scenario: spawnAgent accepts optional timeout
    Given spawnAgent is called with timeoutMs = 900000
    Then the agent process uses a 900000ms timeout
