Feature: Reset Sprint Tool
  As a Raptor user (or an autonomous driver) whose sprint is wedged in
  circuit-breaker limbo — escalated, failed, or stuck in-progress with no resume path
  I want a first-class reset_sprint MCP tool that clears the persisted sprint state
  So that I can start that sprint over cleanly without dropping to a shell to
  rm ~/.raptor/{project}/sprint-N.json by hand

  Background:
    Given a project registered with Raptor whose directory exists on disk
    And sprint state is persisted at ~/.raptor/{slug}/sprint-{N}.json
    And reset_sprint is Raptor's seventh MCP tool, returning { status, ... } and never throwing
    And reset_sprint accepts inputs name, sprint, and an optional boolean confirm

  # ─────────────────────────────────────────────────────────────────────
  # AC 4, 5 — Clean slate; rescues every wedged status including in-progress
  # ─────────────────────────────────────────────────────────────────────

  Scenario Outline: Resetting a wedged sprint clears state to a clean slate
    Given a persisted sprint state whose status is "<status>"
    When I call reset_sprint with the project name and sprint number
    Then the result status is "success"
    And the result priorStatus is "<status>"
    And the sprint state file no longer exists on disk
    And a subsequent run_sprint would begin that sprint from step 1 with a clean slate
    And the result reports the project, the sprint number, and the next action run_sprint {slug} {N}

    Examples:
      | status      |
      | escalated   |
      | failed      |
      | in-progress |
      | paused      |

  Scenario: The in-progress limbo that resume_sprint refuses is freed by reset
    Given a persisted sprint state stuck in "in-progress" status
    And resume_sprint refuses "in-progress" at the un-resumable wall
    When I call reset_sprint with the project name and sprint number
    Then the result status is "success"
    And the result priorStatus is "in-progress"
    And the sprint state file no longer exists on disk

  # ─────────────────────────────────────────────────────────────────────
  # AC 6, NFR-2 — No-state informative no-op success; idempotency
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Resetting a sprint with no state file is an informative no-op success
    Given no sprint-N.json exists for the target sprint
    When I call reset_sprint with the project name and sprint number
    Then the result status is "success"
    And the result priorStatus is "none"
    And the result message notes there was nothing to reset
    And no error is raised

  Scenario: Reset is idempotent — calling it twice is safe
    Given a persisted sprint state whose status is "escalated"
    When I call reset_sprint twice for the same project and sprint
    Then the first result status is "success" and clears the state
    And the second result status is "success" with priorStatus "none"

  Scenario: An invalid sprint number resolves to a no-op success, not a hard error
    Given the project resolves successfully
    And no sprint state exists for sprint 999
    When I call reset_sprint for sprint 999
    Then the result status is "success"
    And the result priorStatus is "none"

  # ─────────────────────────────────────────────────────────────────────
  # AC 7 — Guard against wiping a completed sprint
  # ─────────────────────────────────────────────────────────────────────

  Scenario: A complete sprint is refused without the confirmation input
    Given a persisted sprint state whose status is "complete"
    When I call reset_sprint without confirm
    Then the result status is "error"
    And the result priorStatus is "complete"
    And the message states the sprint is complete and how to force the reset
    And the sprint state file still exists on disk

  Scenario: A complete sprint is cleared when confirm is provided
    Given a persisted sprint state whose status is "complete"
    When I call reset_sprint with confirm set to true
    Then the result status is "success"
    And the result priorStatus is "complete"
    And the sprint state file no longer exists on disk

  Scenario: The confirm flag is only required for a complete sprint
    Given a persisted sprint state whose status is "escalated"
    When I call reset_sprint without confirm
    Then the result status is "success"
    And the escalated state is cleared

  # ─────────────────────────────────────────────────────────────────────
  # AC 3 — Project-resolution parity with run_sprint / resume_sprint
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Unknown project returns an error, never throws
    Given the requested project name is not registered
    When I call reset_sprint with that name
    Then the result status is "error"
    And the message reports the project was not found
    And the tool does not throw to the transport

  Scenario: A registered project whose directory is missing returns an error
    Given a registered project whose path does not exist on disk
    When I call reset_sprint for that project
    Then the result status is "error"
    And the message reports the project directory is missing

  # ─────────────────────────────────────────────────────────────────────
  # AC 8, NFR-4 — Scope boundary: state file only
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Reset touches only the sprint state file
    Given a persisted sprint state whose status is "escalated"
    And the project has committed artifacts, a backlog, and docs/sprints summaries
    And another sprint's state file also exists under ~/.raptor/{slug}
    When I call reset_sprint for the escalated sprint
    Then only ~/.raptor/{slug}/sprint-{N}.json is removed
    And the project registry file is unchanged
    And the sibling sprint's state file is unchanged
    And no git branches, PRs, or committed artifacts are modified

  # ─────────────────────────────────────────────────────────────────────
  # AC 10, NFR-3 — Real failures surface as errors, not swallowed successes
  # ─────────────────────────────────────────────────────────────────────

  Scenario: A genuine filesystem failure to clear state surfaces as an error
    Given a persisted sprint state that cannot be deleted
    When I call reset_sprint for that sprint
    Then the result status is "error"
    And the message includes the underlying filesystem reason
    And no false success is returned

  # ─────────────────────────────────────────────────────────────────────
  # AC 11 — Distinct from resume: no feedback, no re-attempt, no auto-run
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Reset clears state and stops without re-running the sprint
    Given a persisted sprint state whose status is "in-progress"
    When I call reset_sprint with the project name and sprint number
    Then the result status is "success"
    And no directional feedback is carried into a re-attempt
    And the sprint is not re-engaged or auto-run
    And the next action instructs the caller to invoke run_sprint
