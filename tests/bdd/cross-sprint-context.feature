Feature: Cross-Sprint Context — Memory Between Sprints
  As a user running multiple sprints on a project
  I want agents to have context from previous sprints
  So that institutional knowledge is preserved and mistakes are not repeated

  Background:
    Given a project "context-app" has been bootstrapped by Raptor
    And the project backlog contains a sprint 1 item "search: Full-text search"

  # --- Summary generation ---

  Scenario: Sprint summary is generated after sprint completes
    Given sprint 1 has completed successfully
    When the orchestrator finalizes the sprint
    Then a file should exist at "docs/sprints/sprint-1-summary.md"
    And it should be committed with "[PO] add: sprint 1 summary"

  Scenario: Summary follows the structured template
    Given sprint 1 has completed and a summary was generated
    When I read "docs/sprints/sprint-1-summary.md"
    Then it should contain a "Sprint Goal" section
    And it should contain a "Features Delivered" section
    And it should contain a "Key Technical Decisions" section
    And it should contain a "Patterns & Conventions Established" section
    And it should contain a "Issues Encountered" section
    And it should contain a "Deferred Items" section
    And it should contain a "Context for Future Sprints" section

  Scenario: Summary includes features delivered from backlog
    Given sprint 1 delivered "search: Full-text search"
    When the summary is generated
    Then the "Features Delivered" section should include "search"

  Scenario: Summary includes technical decisions from architecture doc
    Given the architecture doc at "docs/architecture/search.md" contains technology choices
    When the summary is generated
    Then the "Key Technical Decisions" section should reference those choices

  Scenario: Summary includes issues from failure history
    Given step 3 (QA) failed twice before succeeding in sprint 1
    When the summary is generated
    Then the "Issues Encountered" section should mention the failures

  Scenario: Summary generation failure does not block sprint completion
    Given summary generation encounters an error (e.g., missing architecture doc)
    When the orchestrator finalizes the sprint
    Then the sprint should still be marked "complete"
    And a warning should be logged but the sprint is not blocked

  # --- Context loading for new sprints ---

  Scenario: New sprint agents receive prior sprint summaries
    Given sprint 1 has completed with a summary at "docs/sprints/sprint-1-summary.md"
    And the backlog contains a sprint 2 item "notifications: Push notifications"
    When I call run_sprint for sprint 2
    Then the PO agent (step 1) should receive cross-sprint context
    And the context should include the sprint 1 summary content

  Scenario: All agents in the new sprint receive cross-sprint context
    Given sprint 1 summary exists
    When sprint 2 runs and reaches the Architect step (step 2)
    Then the Architect agent should receive cross-sprint context
    When it reaches the QA step (step 3)
    Then the QA agent should also receive cross-sprint context

  Scenario: First sprint has no cross-sprint context
    When I call run_sprint for sprint 1 (no prior sprints)
    Then agents should receive no cross-sprint context
    And the sprint should proceed normally

  Scenario: Multiple sprint summaries are loaded in order
    Given sprint 1 and sprint 2 summaries exist
    When sprint 3 starts
    Then the cross-sprint context should include both summaries
    And sprint 1 summary should appear before sprint 2 summary

  # --- Size bounding ---

  Scenario: Context is bounded when summaries are large
    Given 25 sprint summaries exist totaling over 10000 characters
    When the orchestrator loads cross-sprint context
    Then only the most recent summaries fitting within 10000 characters should be included
    And a note should say "X older sprint summaries exist at docs/sprints/"

  Scenario: Small summaries all fit within the limit
    Given 3 sprint summaries exist totaling 2000 characters
    When the orchestrator loads cross-sprint context
    Then all 3 summaries should be included
    And no truncation note should appear

  # --- Scaffold ---

  Scenario: New projects include docs/sprints/ directory
    When I call bootstrap_project with name "new-app"
    Then the project scaffold should include a "docs/sprints/" directory

  # --- get_project_status ---

  Scenario: Project status includes sprint summary count
    Given sprint 1 and sprint 2 summaries exist for "context-app"
    When I call get_project_status with name "context-app"
    Then the response should include sprintSummaries.count equal to 2
    And the response should include sprintSummaries.latestSprint equal to 2

  Scenario: Project status with no summaries
    When I call get_project_status with name "context-app" (no summaries yet)
    Then the response should include sprintSummaries.count equal to 0

  # --- Edge cases ---

  Scenario: Manually created summary files are included
    Given a user manually created "docs/sprints/sprint-0-summary.md"
    When sprint 1 starts
    Then the cross-sprint context should include the manual summary

  Scenario: Failed sprint does not generate a summary
    Given sprint 1 ended in "escalated" status (never completed)
    Then no summary file should exist at "docs/sprints/sprint-1-summary.md"
