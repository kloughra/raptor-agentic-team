Feature: Adopt Existing Project
  As a Raptor user
  I want to adopt an existing repo into Raptor
  So that I can run the agentic team process on projects I've already started

  Scenario: Adopt a valid existing git repo
    Given an existing git repository at "/path/to/my-app"
    When I call adopt_project with path and name "my-app"
    Then the project is registered in Raptor
    And only missing scaffold files are created
    And a project-context.md is generated from existing files

  Scenario: Existing docs folder is preserved
    Given a repo with an existing "docs/" folder containing custom files
    When I adopt the project
    Then the existing docs files are untouched
    And only missing subdirectories (specs/, architecture/, sprints/) are added

  Scenario: Context discovery reads existing files
    Given a repo with README.md, package.json, and docs/design.md
    When context discovery runs
    Then project-context.md includes the project description from README
    And project-context.md lists the tech stack from package.json
    And project-context.md summarizes existing docs

  Scenario: Path is not a git repo
    Given a directory that is not a git repository
    When I call adopt_project
    Then an error is returned: "Path must be an initialized git repository"

  Scenario: Project name already registered
    Given a project "my-app" is already registered in Raptor
    When I call adopt_project with name "my-app"
    Then an error is returned about duplicate name

  Scenario: Path already registered under different name
    Given "/path/to/my-app" is already tracked as "old-name"
    When I call adopt_project with the same path but name "new-name"
    Then an error is returned: "This repo is already tracked as 'old-name'"

  Scenario: Nothing needs scaffolding
    Given a repo that already has TEAM.md, docs/backlog.md, and all directories
    When I adopt the project
    Then no files are created
    And the project is still registered
    And no git commit is made

  Scenario: Run sprint after adoption
    Given an adopted project with a populated backlog
    When I call run_sprint
    Then the sprint executes normally with project context available to agents
