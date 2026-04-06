Feature: Agent Retrospective Improvements — Process Evolution Through Experience
  As a user managing an agentic dev team
  I want each agent to propose TEAM.md improvements based on sprint experience
  So that the team process evolves and improves over time

  Background:
    Given a project "retro-app" has been bootstrapped by Raptor
    And the project has a TEAM.md file
    And a sprint has progressed through steps 1-10 (feedback processed)

  # --- Workflow structure ---

  Scenario: Workflow has 13 steps including retro phase
    When I inspect the sprint workflow definition
    Then it should have 13 steps
    And step 11 should be "Collect retro proposals" with role "team"
    And step 12 should be "Review retro proposals" with role "team" and checkpoint "retro-review"
    And step 13 should be "Apply retro improvements" with role "po"

  Scenario: Retro phase runs after PO processes feedback
    Given step 10 (Process feedback) has completed
    Then step 11 (Collect retro proposals) should execute next

  # --- Proposal collection ---

  Scenario: Each role is asked to propose one improvement
    When step 11 (Collect retro proposals) executes
    Then the orchestrator should spawn agents for PO, Architect, QA, and Engineer
    And each agent should receive TEAM.md and a sprint summary as context
    And each agent should be asked to propose exactly one improvement

  Scenario: Proposals follow the structured template
    When a role agent produces a proposal
    Then it should include a "Section" field
    And it should include a "Type" field (addition, modification, or removal)
    And it should include a "Proposal" field
    And it should include a "Rationale" field
    And it should include an "Impact" field

  Scenario: All proposals are collected into a retro document
    When all 4 role agents have produced proposals
    Then "docs/sprints/sprint-{N}-retro.md" should be created
    And it should contain all 4 proposals
    And it should be committed with a proper commit message

  Scenario: A role produces no proposal
    Given the QA agent produces empty output
    When the retro document is generated
    Then it should record "No proposal from QA"
    And proposals from other roles should still be included

  Scenario: A role agent fails and triggers circuit breaker
    Given the Architect agent fails 3 times during retro collection
    When the orchestrator handles the failure
    Then it should record the escalation in the retro document
    And should continue collecting proposals from other roles
    And the retro should not be blocked by one role's failure

  # --- Retro review checkpoint ---

  Scenario: User checkpoint is presented after proposals are collected
    When step 11 completes and step 12 begins
    Then the orchestrator should pause at checkpoint "retro-review"
    And the checkpoint should display all proposals numbered for selection
    And the options should include "adopt all", "adopt selected", and "skip"

  Scenario: User adopts all proposals
    Given the sprint is paused at checkpoint "retro-review" with 4 proposals
    When I call resume_sprint with action "approve" and feedback "all"
    Then all 4 proposals should be applied to TEAM.md
    And TEAM.md should be committed with "[PO] update: apply retrospective improvements from sprint {N}"

  Scenario: User adopts selected proposals
    Given the sprint is paused at checkpoint "retro-review" with 4 proposals
    When I call resume_sprint with action "approve" and feedback "1,3"
    Then only proposals 1 and 3 should be applied to TEAM.md
    And proposals 2 and 4 should be marked "deferred" in the retro doc

  Scenario: User skips retro
    Given the sprint is paused at checkpoint "retro-review"
    When I call resume_sprint with action "approve" and feedback "skip"
    Then TEAM.md should not be modified
    And all proposals should be marked "deferred" in the retro doc
    And the sprint should complete normally

  Scenario: User skips retro with no feedback
    Given the sprint is paused at checkpoint "retro-review"
    When I call resume_sprint with action "approve" with no feedback
    Then TEAM.md should not be modified
    And the sprint should complete normally

  # --- Applying improvements ---

  Scenario: Addition type proposal adds content after target section
    Given a proposal targets section "QA Engineer" with type "addition"
    When the improvement is applied to TEAM.md
    Then the new content should be appended within the QA Engineer section

  Scenario: Modification type proposal updates content in target section
    Given a proposal targets section "Sprint Workflow" with type "modification"
    When the improvement is applied to TEAM.md
    Then the target section should be updated with the proposed change

  Scenario: Removal type proposal comments out target content
    Given a proposal targets a specific subsection with type "removal"
    When the improvement is applied to TEAM.md
    Then the content should be commented out (not deleted) for traceability

  Scenario: Proposal targets a section that doesn't exist
    Given a proposal targets section "Nonexistent Section"
    When the improvement application is attempted
    Then the proposal should be skipped
    And a note should be added to the retro doc that the section was not found

  # --- Retro document persistence ---

  Scenario: Retro document persists regardless of adoption choices
    Given 4 proposals were collected and user selected "skip"
    Then "docs/sprints/sprint-{N}-retro.md" should still exist
    And it should contain all proposals with their "deferred" status

  Scenario: Retro document includes user decision record
    Given the user adopted proposals 1 and 3
    Then the retro document should have a "User Decision" section
    And it should list proposals 1 and 3 as "Adopted"
    And proposals 2 and 4 as "Deferred"

  # --- Sprint completion ---

  Scenario: Sprint completes after retro phase
    Given the user has resolved the retro-review checkpoint
    And step 13 (Apply retro improvements) has completed
    Then the sprint status should be "complete"

  Scenario: Sprint is not complete until retro is resolved
    Given step 10 (Process feedback) has completed
    And step 11 (Collect retro proposals) has completed
    But the retro-review checkpoint has not been resolved
    Then the sprint status should be "paused"
    And the sprint should not be marked "complete"

  # --- State tracking ---

  Scenario: Retro proposals are stored in sprint state
    Given step 11 has collected 4 proposals
    When I inspect the sprint state
    Then it should include a retroProposals array with 4 entries
    And each entry should have role, section, type, proposal, rationale, and impact

  Scenario: Backward compatible with old state without retroProposals
    Given an old sprint state file without a retroProposals field
    When the orchestrator loads the state
    Then retroProposals should default to null
    And no error should occur
