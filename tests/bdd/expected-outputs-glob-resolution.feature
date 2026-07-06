Feature: Expected-Outputs Glob Resolution
  As the Raptor orchestrator validating a sprint step's outputs
  I want expectedOutputs glob patterns to match the real files an agent actually wrote
  So that conventionally-named artifacts pass validation on the first attempt
  And agents are never instructed to create extensionless literal paths or stray directories

  Background:
    Given a project directory on disk
    And the matcher module src/orchestrator/glob-match.ts exposing matchExpectedOutput, classifyPattern, and describeRequiredOutput
    And validateRequiredOutputs reporting the original pattern string for any unsatisfied pattern

  # ─────────────────────────────────────────────────────────────────────
  # Pattern classification (matcher internal contract)
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Exact patterns are classified as exact
    When classifyPattern is called with "docs/backlog.md"
    Then it returns "exact"
    When classifyPattern is called with "TEAM.md"
    Then it returns "exact"

  Scenario: Single-star patterns are classified as single-star
    When classifyPattern is called with "tests/integration/*"
    Then it returns "single-star"
    When classifyPattern is called with "docs/specs/*.md"
    Then it returns "single-star"

  Scenario: Double-star patterns are classified as double-star
    When classifyPattern is called with "src/**/*.ts"
    Then it returns "double-star"

  # ─────────────────────────────────────────────────────────────────────
  # AC #1 — Single-star pattern matches conventional filenames
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Single-star pattern matches the conventional integration test filename
    Given a feature slug "expected-outputs-glob-resolution"
    And the file "tests/integration/expected-outputs-glob-resolution.integration.test.ts" exists
    When validateRequiredOutputs runs for a step with expectedOutputs ["tests/integration/*"]
    Then the missing list is empty
    And matchExpectedOutput for "tests/integration/*" is satisfied
    And the matchedFiles include "tests/integration/expected-outputs-glob-resolution.integration.test.ts"

  Scenario: Single-star pattern with an extension matches the spec filename
    Given a feature slug "my-feature"
    And the file "docs/specs/my-feature.md" exists
    When validateRequiredOutputs runs for a step with expectedOutputs ["docs/specs/*.md"]
    Then the missing list is empty

  # ─────────────────────────────────────────────────────────────────────
  # AC #2 — Double-star pattern matches files at any depth
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Double-star pattern matches a file in a subdirectory
    Given a feature slug "my-feature"
    And the file "src/orchestrator/foo.ts" exists
    When validateRequiredOutputs runs for a step with expectedOutputs ["src/**/*.ts"]
    Then the missing list is empty
    And matchExpectedOutput for "src/**/*.ts" is satisfied

  Scenario: Double-star pattern with no matching file is reported missing
    Given a feature slug "my-feature"
    And the directory "src/orchestrator" exists but contains no .ts file
    When validateRequiredOutputs runs for a step with expectedOutputs ["src/**/*.ts"]
    Then the missing list contains "src/**/*.ts"

  Scenario: Double-star pattern does not require slug association
    Given a feature slug "my-feature"
    And the file "src/orchestrator/unrelated-name.ts" exists
    When validateRequiredOutputs runs for a step with expectedOutputs ["src/**/*.ts"]
    Then the missing list is empty

  # ─────────────────────────────────────────────────────────────────────
  # AC #3 — No-match still fails clearly, reporting the original pattern
  # ─────────────────────────────────────────────────────────────────────

  Scenario: No real file matching a single-star pattern fails
    Given a feature slug "my-feature"
    And no file exists under "tests/integration/"
    When validateRequiredOutputs runs for a step with expectedOutputs ["tests/integration/*"]
    Then the missing list contains the original pattern "tests/integration/*"
    And the missing list does not contain a resolved literal "tests/integration/my-feature"

  Scenario: A truly empty step output never passes
    Given a feature slug "my-feature"
    And no artifacts exist on disk
    When validateRequiredOutputs runs for a step with expectedOutputs ["tests/bdd/*.feature", "tests/integration/*"]
    Then the missing list is non-empty

  # ─────────────────────────────────────────────────────────────────────
  # AC #4 — A directory at the literal path does NOT satisfy a file pattern
  # ─────────────────────────────────────────────────────────────────────

  Scenario: A directory at the substituted literal path does not satisfy the pattern
    Given a feature slug "my-feature"
    And a directory (not a file) named "tests/integration/my-feature" exists
    And no matching file exists inside it
    When validateRequiredOutputs runs for a step with expectedOutputs ["tests/integration/*"]
    Then the missing list contains "tests/integration/*"
    And matchExpectedOutput for "tests/integration/*" is not satisfied

  Scenario: A file inside the directory-workaround path still satisfies the pattern
    Given a feature slug "my-feature"
    And a directory named "tests/integration/my-feature" exists
    And the file "tests/integration/my-feature.integration.test.ts" also exists
    When validateRequiredOutputs runs for a step with expectedOutputs ["tests/integration/*"]
    Then the missing list is empty

  # ─────────────────────────────────────────────────────────────────────
  # AC #5 — Agent guidance matches what validation accepts
  # ─────────────────────────────────────────────────────────────────────

  Scenario: describeRequiredOutput never emits an extensionless literal path
    Given a feature slug "my-feature"
    When describeRequiredOutput is called for "tests/integration/*"
    Then the description references the original pattern "tests/integration/*"
    And the description is not the bare literal "tests/integration/my-feature"

  Scenario: describeRequiredOutput for an exact pattern names the exact file
    Given a feature slug "my-feature"
    When describeRequiredOutput is called for "docs/backlog.md"
    Then the description references "docs/backlog.md"

  # ─────────────────────────────────────────────────────────────────────
  # AC #6 — Slug scoping preserved for single-feature isolation
  # ─────────────────────────────────────────────────────────────────────

  Scenario: A different feature's file does not satisfy the current feature's single-star pattern
    Given a feature slug "feature-a"
    And only the file "tests/integration/feature-b.integration.test.ts" exists
    When validateRequiredOutputs runs for a step with expectedOutputs ["tests/integration/*"]
    Then the missing list contains "tests/integration/*"

  Scenario: A slug appearing as a path segment satisfies scoping
    Given a feature slug "my-feature"
    And the file "docs/specs/my-feature.md" exists
    When matchExpectedOutput runs for "docs/specs/*.md"
    Then it is satisfied

  # ─────────────────────────────────────────────────────────────────────
  # AC #7 — Exact (wildcard-free) patterns still work
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Exact pattern validates by exact-path existence
    Given a feature slug "my-feature"
    And the file "docs/backlog.md" exists
    When validateRequiredOutputs runs for a step with expectedOutputs ["docs/backlog.md"]
    Then the missing list is empty

  Scenario: Missing exact pattern is reported
    Given a feature slug "my-feature"
    And the file "TEAM.md" does not exist
    When validateRequiredOutputs runs for a step with expectedOutputs ["TEAM.md"]
    Then the missing list contains "TEAM.md"

  Scenario: A directory at an exact path does not satisfy the exact pattern
    Given a feature slug "my-feature"
    And a directory named "docs/backlog.md" exists
    When validateRequiredOutputs runs for a step with expectedOutputs ["docs/backlog.md"]
    Then the missing list contains "docs/backlog.md"

  # ─────────────────────────────────────────────────────────────────────
  # AC #9 / Edge cases — full workflow, no-crash, .gitkeep, hyphens, mixed
  # ─────────────────────────────────────────────────────────────────────

  Scenario: All 13 workflow steps validate with real conventionally-named artifacts
    Given a feature slug "my-feature"
    And conventionally-named artifacts exist for every workflow step's expectedOutputs
    When validateRequiredOutputs runs for each step
    Then no step reports any missing output

  Scenario: A .gitkeep-only directory does not satisfy a file pattern
    Given a feature slug "my-feature"
    And the directory "tests/integration/" contains only a ".gitkeep" file
    When validateRequiredOutputs runs for a step with expectedOutputs ["tests/integration/*"]
    Then the missing list contains "tests/integration/*"

  Scenario: Hyphenated slug matches without regex metacharacter mis-parsing
    Given a feature slug "expected-outputs-glob-resolution"
    And the file "docs/specs/expected-outputs-glob-resolution.md" exists
    When validateRequiredOutputs runs for a step with expectedOutputs ["docs/specs/*.md"]
    Then the missing list is empty

  Scenario: A non-existent base directory is reported missing, not a crash
    Given a feature slug "my-feature"
    And the base directory "tests/integration/" does not exist
    When validateRequiredOutputs runs for a step with expectedOutputs ["tests/integration/*"]
    Then validateRequiredOutputs returns without throwing
    And the missing list contains "tests/integration/*"

  Scenario: Mixed single-star and double-star patterns are evaluated independently
    Given a feature slug "my-feature"
    And the file "tests/bdd/my-feature.feature" exists
    And no file exists under "tests/integration/"
    When validateRequiredOutputs runs for a step with expectedOutputs ["tests/bdd/*.feature", "tests/integration/*"]
    Then the missing list contains "tests/integration/*"
    And the missing list does not contain "tests/bdd/*.feature"

  Scenario: Multiple matching files satisfy a pattern with at least one match
    Given a feature slug "my-feature"
    And the files "src/a.ts" and "src/orchestrator/b.ts" both exist
    When validateRequiredOutputs runs for a step with expectedOutputs ["src/**/*.ts"]
    Then the missing list is empty
