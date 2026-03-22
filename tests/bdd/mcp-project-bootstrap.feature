Feature: Raptor — Project Bootstrap
  As a human engineer managing multiple projects
  I want to tell Claude "start a new project" and have Raptor scaffold a repository
  So that I can go from idea to a working dev team in a single command

  # ─── bootstrap_project: Happy Paths ───

  Scenario: Bootstrap a new project with name and description
    Given Raptor is running with projectsBaseDir set to a temporary directory
    And no project named "recipe-app" exists
    When I call bootstrap_project with name "recipe-app" and description "A recipe sharing app"
    Then the response status should be "success"
    And a git repository should exist at "{projectsBaseDir}/recipe-app"
    And the repo should contain "TEAM.md" matching the canonical template
    And the repo should contain "README.md"
    And the repo should contain "docs/backlog.md"
    And the repo should contain the full directory scaffold:
      | path                      |
      | docs/specs/               |
      | docs/architecture/        |
      | docs/adr/                 |
      | docs/demos/               |
      | tests/bdd/                |
      | tests/integration/        |
      | tests/performance/        |
      | tests/e2e/                |
      | tests/e2e/screenshots/    |
      | src/                      |
    And each empty directory should contain a ".gitkeep" file
    And the git log should contain exactly one commit
    And the commit message should be "[BOOTSTRAP] Architect: project scaffold for recipe-app"
    And the project should be registered in "~/.raptor/projects.json"

  Scenario: Bootstrap a project with feature ideas
    Given Raptor is running with projectsBaseDir set to a temporary directory
    When I call bootstrap_project with:
      | name        | recipe-app                    |
      | description | A recipe sharing app          |
      | featureIdeas | ["user-login", "recipe-search", "meal-planner"] |
    Then the response status should be "success"
    And "docs/backlog.md" should contain an "## Inbox (unprioritized)" section
    And the Inbox section should contain:
      | item          |
      | user-login    |
      | recipe-search |
      | meal-planner  |

  Scenario: Bootstrap a project without feature ideas
    Given Raptor is running with projectsBaseDir set to a temporary directory
    When I call bootstrap_project with name "my-api" and description "A REST API"
    Then the response status should be "success"
    And "docs/backlog.md" should contain the project description "A REST API"
    And the Inbox section should be empty

  Scenario: Response includes repo path and next steps
    Given Raptor is running with projectsBaseDir set to a temporary directory
    When I call bootstrap_project with name "my-app" and description "An app"
    Then the response should include the project path "{projectsBaseDir}/my-app"
    And the response message should mention "Next step"

  # ─── bootstrap_project: Edge Cases & Errors ───

  Scenario: Reject duplicate project name
    Given Raptor is running with projectsBaseDir set to a temporary directory
    And a project named "my-app" already exists in the registry
    When I call bootstrap_project with name "my-app" and description "Another app"
    Then the response should be an error
    And the error message should contain "already exists"
    And the error message should mention "list_projects"
    And the existing project should not be modified

  Scenario: Reject invalid project name with spaces
    Given Raptor is running
    When I call bootstrap_project with name "My App" and description "An app"
    Then the response should be an error
    And the error message should contain "Invalid project name"
    And the error message should suggest slug format

  Scenario: Reject invalid project name with special characters
    Given Raptor is running
    When I call bootstrap_project with name "my_app!" and description "An app"
    Then the response should be an error
    And the error message should contain "Invalid project name"

  Scenario: Reject project name starting with a number
    Given Raptor is running
    When I call bootstrap_project with name "123-app" and description "An app"
    Then the response should be an error
    And the error message should contain "Invalid project name"

  Scenario: Base directory does not exist yet
    Given Raptor is running with projectsBaseDir set to a non-existent directory
    When I call bootstrap_project with name "my-app" and description "An app"
    Then the base directory should be created
    And the response status should be "success"

  Scenario: Base directory creation fails due to permissions
    Given Raptor is running with projectsBaseDir set to a read-only path
    When I call bootstrap_project with name "my-app" and description "An app"
    Then the response should be an error
    And the error message should contain "Permission denied" or "cannot create"

  Scenario: Empty feature ideas are ignored
    Given Raptor is running with projectsBaseDir set to a temporary directory
    When I call bootstrap_project with:
      | name        | my-app              |
      | description | An app              |
      | featureIdeas | ["login", "", "  ", "search"] |
    Then the Inbox section should contain exactly 2 items
    And the Inbox section should contain "login" and "search"
    And the Inbox section should not contain empty entries

  # ─── list_projects ───

  Scenario: List projects when none exist
    Given Raptor is running with an empty registry
    When I call list_projects
    Then the response should contain an empty projects array
    And the count should be 0

  Scenario: List projects after bootstrapping
    Given Raptor is running with projectsBaseDir set to a temporary directory
    And I have bootstrapped projects "app-one" and "app-two"
    When I call list_projects
    Then the response should contain 2 projects
    And the projects should include "app-one" and "app-two"
    And each project should have name, description, path, and createdAt fields

  # ─── get_project_status ───

  Scenario: Get status of a freshly bootstrapped project
    Given Raptor is running with projectsBaseDir set to a temporary directory
    And I have bootstrapped a project named "my-app"
    When I call get_project_status with name "my-app"
    Then the response should include the project name "my-app"
    And the backlog inbox count should reflect any feature ideas provided
    And the backlog ready count should be 0
    And the backlog sprint count should be 0
    And the backlog done count should be 0
    And blockers should be an empty array
    And escalations should be an empty array

  Scenario: Get status detects blockers from git log
    Given Raptor is running with projectsBaseDir set to a temporary directory
    And I have bootstrapped a project named "my-app"
    And the project repo contains a commit with message "[BLOCKER] Engineer: unclear validation rules -- blocked on PO"
    When I call get_project_status with name "my-app"
    Then blockers should contain 1 entry
    And the blocker role should be "Engineer"
    And the blocker description should contain "unclear validation rules"
    And the blocker blockedOn should be "PO"

  Scenario: Get status parses current sprint number from backlog
    Given Raptor is running with projectsBaseDir set to a temporary directory
    And I have bootstrapped a project named "my-app"
    And the project's backlog.md has been updated to contain "## Sprint 2 — In Progress"
    When I call get_project_status with name "my-app"
    Then the sprint current should be 2

  Scenario: Get status reports sprint 0 for freshly bootstrapped project with no sprint section
    Given Raptor is running with projectsBaseDir set to a temporary directory
    And I have bootstrapped a project named "my-app"
    When I call get_project_status with name "my-app"
    Then the sprint current should be 0

  Scenario: Get status detects escalations from git log
    Given Raptor is running with projectsBaseDir set to a temporary directory
    And I have bootstrapped a project named "my-app"
    And the project repo contains a commit with message "[ESCALATE] QA: test suite fails 3 times — requesting user intervention. Summary: flaky timeout in E2E tests"
    When I call get_project_status with name "my-app"
    Then escalations should contain 1 entry

  Scenario: Get status for unknown project
    Given Raptor is running
    And no project named "ghost-app" exists in the registry
    When I call get_project_status with name "ghost-app"
    Then the response should be an error
    And the error message should contain "not found"
    And the error message should mention "list_projects"

  Scenario: Get status for untracked project on disk
    Given Raptor is running with projectsBaseDir set to a temporary directory
    And a git repo exists at "{projectsBaseDir}/rogue-app" but is not in the registry
    When I call get_project_status with name "rogue-app"
    Then the response should be an error
    And the error message should contain "not tracked by Raptor"

  Scenario: Get status when backlog has been manually edited with unexpected format
    Given Raptor is running with projectsBaseDir set to a temporary directory
    And I have bootstrapped a project named "my-app"
    And the project's backlog.md has been edited to contain non-standard markdown
    When I call get_project_status with name "my-app"
    Then the response should return partial results rather than failing
    And any unparseable sections should show count 0

  # ─── Server Startup ───

  Scenario: Server starts successfully with valid configuration
    Given a valid config exists at "~/.raptor/config.json"
    And the bundled TEAM.md template is present
    When Raptor starts
    Then it should be ready to accept tool calls within 2 seconds

  Scenario: Server starts with default config when no config file exists
    Given no config file exists at "~/.raptor/config.json"
    And the bundled TEAM.md template is present
    When Raptor starts
    Then it should use "~/projects" as the default projectsBaseDir
    And it should be ready to accept tool calls

  Scenario: Server fails to start when TEAM.md template is missing
    Given the bundled TEAM.md template is missing
    When Raptor attempts to start
    Then it should fail with a clear error message about the missing template
    And it should NOT start accepting tool calls
