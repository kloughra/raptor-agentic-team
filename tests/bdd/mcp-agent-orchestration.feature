Feature: Agent Orchestration — Core Sprint Loop
  As a user managing projects through Raptor
  I want to run a sprint that orchestrates agents autonomously
  So that a full BDD/TDD sprint produces tested, committed code with minimal manual intervention

  Background:
    Given a project "test-app" has been bootstrapped by Raptor
    And the project backlog contains a sprint 1 item "user-login: Basic user login flow"

  # --- run_sprint validation ---

  Scenario: Run sprint on a valid bootstrapped project
    When I call run_sprint with name "test-app" and sprint 1
    Then the orchestrator should start executing the sprint workflow
    And the first step should spawn a PO subagent

  Scenario: Run sprint on a non-existent project
    When I call run_sprint with name "ghost-app" and sprint 1
    Then the result status should be "error"
    And the result message should suggest running bootstrap_project first

  Scenario: Run sprint with no backlog items for the given sprint
    Given the project backlog has no items in the sprint 1 section
    When I call run_sprint with name "test-app" and sprint 1
    Then the result status should be "error"
    And the result message should indicate the backlog needs sprint items

  # --- Sequential workflow execution ---

  Scenario: Sprint executes steps sequentially
    When I call run_sprint with name "test-app" and sprint 1
    Then the orchestrator should execute steps in order:
      | step | role      | name                 |
      | 1    | po        | Author specification |
      | 2    | architect | Architecture design  |
      | 3    | qa        | Write tests          |
      | 4    | po        | Review tests         |
      | 5    | engineer  | Implement (TDD)      |
      | 6    | engineer  | Open PR              |
      | 7    | qa        | Run test suite       |
      | 8    | team      | Demo                 |
      | 9    | po        | Process feedback     |

  Scenario: Each step waits for the previous step to complete
    When step 1 (PO spec) is in progress
    Then step 2 (Architect design) should not start
    When step 1 completes
    Then step 2 should begin

  # --- Subagent spawning ---

  Scenario: PO subagent receives correct context
    When step 1 spawns a PO subagent
    Then the subagent should receive a role-scoped system prompt for "po"
    And the subagent should receive the project backlog as input context
    And the subagent working directory should be the project repo

  Scenario: Architect subagent receives spec as input
    Given step 1 (PO spec) has completed and produced "docs/specs/user-login.md"
    When step 2 spawns an Architect subagent
    Then the subagent should receive a role-scoped system prompt for "architect"
    And the subagent should receive "docs/specs/user-login.md" as input context

  Scenario: QA subagent receives spec and architecture as input
    Given step 2 (Architect) has completed and produced "docs/architecture/user-login.md"
    When step 3 spawns a QA subagent
    Then the subagent should receive "docs/specs/user-login.md" as input context
    And the subagent should receive "docs/architecture/user-login.md" as input context

  Scenario: Engineer subagent receives all artifacts as input
    Given steps 1-4 have completed
    When step 5 spawns an Engineer subagent
    Then the subagent should receive the spec as input context
    And the subagent should receive the architecture as input context
    And the subagent should receive the BDD scenarios as input context
    And the subagent should receive the integration tests as input context

  # --- Git commits and handoffs ---

  Scenario: Subagent output is committed with correct format
    When step 1 (PO) completes and produces artifacts
    Then the artifacts should be committed with a "[PO]" prefixed commit message
    And a "[HANDOFF] PO -> Architect" commit should follow

  Scenario: Handoff commits are recorded between steps
    When step 2 (Architect) completes
    Then a "[HANDOFF] Architect -> QA" commit should be created

  # --- User checkpoints ---

  Scenario: Sprint pauses after PO authors spec (checkpoint 1)
    When step 1 (PO spec) completes
    Then the orchestrator should pause and return a checkpoint prompt
    And the checkpoint type should be "spec-review"
    And the checkpoint should present structured options: "Approve" and "Request changes"
    And the checkpoint should include a free-text feedback field

  Scenario: Sprint pauses after Architect proposes tech choices (checkpoint 2)
    When step 2 (Architect design) completes
    Then the orchestrator should pause and return a checkpoint prompt
    And the checkpoint type should be "tech-approval"

  Scenario: Sprint pauses after Engineer opens PR (checkpoint 3)
    When step 6 (Engineer PR) completes
    Then the orchestrator should pause and return a checkpoint prompt
    And the checkpoint type should be "pr-review"

  Scenario: Sprint pauses for demo feedback (checkpoint 4)
    When step 8 (Demo) completes
    Then the orchestrator should pause and return a checkpoint prompt
    And the checkpoint type should be "demo-feedback"

  Scenario: No user prompts between checkpoints
    When step 2 (Architect) completes and the user approved checkpoint 2
    Then steps 3 and 4 should execute without pausing for user input

  # --- resume_sprint ---

  Scenario: Resume sprint after approving spec
    Given the sprint is paused at checkpoint "spec-review"
    When I call resume_sprint with action "approve"
    Then the orchestrator should continue from step 2 (Architect)

  Scenario: Resume sprint with change request on spec
    Given the sprint is paused at checkpoint "spec-review"
    When I call resume_sprint with action "request-changes" and feedback "Add password reset to acceptance criteria"
    Then the PO subagent should be re-spawned with the feedback
    And the revised spec should be committed
    And checkpoint 1 should be presented again

  Scenario: Resume sprint after approving tech choices
    Given the sprint is paused at checkpoint "tech-approval"
    When I call resume_sprint with action "approve"
    Then the orchestrator should continue from step 3 (QA)

  Scenario: Resume sprint after PR review with changes requested
    Given the sprint is paused at checkpoint "pr-review"
    When I call resume_sprint with action "request-changes" and feedback "Extract the validation into a shared util"
    Then the Engineer subagent should be re-spawned with the review feedback
    And checkpoint 3 should be presented again after revisions

  Scenario: Resume sprint after demo with feedback
    Given the sprint is paused at checkpoint "demo-feedback"
    When I call resume_sprint with action "approve" and feedback "Looks great, but add sorting to the list view"
    Then the PO subagent should process the feedback into backlog updates
    And the sprint should complete

  # --- Progress table ---

  Scenario: Progress table is displayed after each step
    When step 1 completes
    Then the response should include a progress table
    And step 1 should show status "✅"
    And step 2 should show status "🔄" or "⬜"
    And steps 3-9 should show status "⬜"

  Scenario: Progress table updates as steps complete
    When step 3 completes
    Then steps 1-3 should show status "✅"
    And step 4 should show status "🔄" or "⬜"

  # --- Sprint state persistence ---

  Scenario: Sprint state is saved after each step
    When step 2 completes
    Then a file should exist at "~/.raptor/test-app/sprint-1.json"
    And the file should contain currentStep 3
    And step 1 and step 2 should have status "complete"

  Scenario: get_project_status shows orchestrator state
    Given a sprint is in progress at step 3
    When I call get_project_status with name "test-app"
    Then the result should include sprint orchestrator state
    And the result should show current step 3
    And the result should include the progress table

  Scenario: Sprint state is discoverable in a new session
    Given a sprint is paused at checkpoint "pr-review"
    When a new Claude session calls get_project_status with name "test-app"
    Then the result should show the sprint is paused at "pr-review"
    And the result should include the progress table with completed steps

  # --- Error handling ---

  Scenario: Subagent fails to produce expected artifacts
    When step 1 (PO) completes but "docs/specs/" contains no new files
    Then the orchestrator should retry once with clarified instructions
    When the retry also fails to produce artifacts
    Then the orchestrator should escalate to the user with context

  Scenario: Subagent raises a blocker
    When a subagent commits a "[BLOCKER]" message
    Then the orchestrator should surface the blocker to the user
    And the sprint should pause for user intervention

  Scenario: Circuit breaker after 3 failures
    Given a subagent has failed 3 times on the same step
    Then the orchestrator should stop with an "[ESCALATE]" message
    And the escalation should include what was tried and why it failed
