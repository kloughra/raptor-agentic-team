Feature: Codebase-Aware Agent Context
  As a sprint agent
  I want to see the current state of the codebase
  So I can produce output that's consistent with existing code

  Scenario: Snapshot includes directory tree
    Given a project with source files in src/ and tests/
    When a codebase snapshot is generated
    Then the snapshot contains a filtered directory tree
    And node_modules, dist, and .git are excluded

  Scenario: Snapshot extracts module exports
    Given a TypeScript project with exported functions and classes
    When a codebase snapshot is generated
    Then the snapshot includes export names for each source file
    And the exports list contains function and class names

  Scenario: Snapshot includes key file excerpts
    Given a project with src/index.ts as entry point
    When a codebase snapshot is generated
    Then the snapshot includes a truncated excerpt of src/index.ts
    And the excerpt is capped at the per-file limit

  Scenario: Snapshot respects total size cap
    Given a project with 100KB of source files
    And the size cap is set to 30KB
    When a codebase snapshot is generated
    Then the total snapshot size does not exceed 30KB

  Scenario: Snapshot is regenerated per step
    Given a sprint is running at step 3
    And step 2 created new files
    When step 3 generates a codebase snapshot
    Then the snapshot includes files created by step 2

  Scenario: Snapshot formatted for prompt injection
    Given a codebase snapshot with tree, exports, and excerpts
    When the snapshot is formatted for prompt injection
    Then the output contains a "## Codebase Context" section
    And subsections for Directory Tree, Module Exports, and Key Files

  Scenario: No snapshot for first sprint
    Given a project with sprint number 1
    When the runner evaluates codebase context injection
    Then no codebase snapshot is injected

  Scenario: Gitignore patterns are respected
    Given a project with a .gitignore containing "*.log" and "tmp/"
    When a codebase snapshot is generated
    Then files matching .gitignore patterns are excluded from the snapshot

  Scenario: Config overrides default size cap
    Given raptor config has codebaseContext.maxSize set to 15000
    When a codebase snapshot is generated
    Then the total snapshot size does not exceed 15000 bytes

  Scenario: Python project export extraction
    Given a Python project with def and class definitions
    When a codebase snapshot is generated
    Then the snapshot includes Python function and class names as exports
