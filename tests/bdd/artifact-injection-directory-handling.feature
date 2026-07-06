Feature: Artifact-Injection Directory Handling
  As the Raptor orchestrator preparing a step's task description
  I want resolveArtifacts to safely handle an artifact path that points at a directory
  So that a stray directory on disk never throws EISDIR and aborts the sprint before the agent spawns

  Background:
    Given a project directory on disk
    And the "Review tests" step requires the Feature Specification and BDD Scenarios artifacts

  # AC #1, #3 — A required directory-path artifact never throws and is reported missing
  Scenario: Required artifact resolves to a directory
    Given a required artifact pattern "docs/specs/{slug}.md"
    And a directory (not a file) exists at the resolved artifact path
    When resolveArtifacts runs for the step
    Then resolveArtifacts completes without throwing EISDIR or any other error
    And a well-formed ArtifactInjectionResult is returned
    And the directory artifact does NOT appear in the artifacts array
    And the resolved path appears in the missing list

  # AC #1, #2, #4 — An optional directory-path artifact is silently skipped
  Scenario: Optional artifact resolves to a directory
    Given an optional artifact pattern "tests/integration/{slug}.integration.test.ts"
    And a directory (not a file) exists at the resolved artifact path
    When resolveArtifacts runs for the step
    Then resolveArtifacts completes without throwing
    And the directory artifact does NOT appear in the artifacts array
    And the resolved path does NOT appear in the missing list

  # AC #5 — A real file is read exactly as before (happy path, no regression)
  Scenario: Required artifact resolves to a regular file
    Given a required artifact pattern "docs/specs/{slug}.md"
    And a regular file with content "# Spec body" exists at the resolved artifact path
    When resolveArtifacts runs for the step
    Then the artifact appears in the artifacts array
    And its injected content is "# Spec body"
    And the resolved path does NOT appear in the missing list

  # AC #5 — Size cap is still applied to real-file content
  Scenario: Regular-file content is capped at the configured size
    Given a required artifact whose file content is larger than the size cap
    When resolveArtifacts runs with a maxArtifactSize of 100 bytes
    Then the injected content length is at most 100 bytes
    And the artifact still appears in the artifacts array

  # AC #7 — Failure is isolated to the offending requirement
  Scenario: A directory at one path does not block other real-file artifacts
    Given a required artifact "docs/specs/{slug}.md" that exists as a directory
    And a required artifact "tests/bdd/{slug}.feature" that exists as a regular file
    When resolveArtifacts runs for the step
    Then the real-file artifact "tests/bdd/{slug}.feature" appears in the artifacts array
    And the directory path "docs/specs/{slug}.md" appears in the missing list
    And resolveArtifacts does not throw

  # AC #6 — Injected section/checklist is well-formed after skipping a directory
  Scenario: Required Reading section renders only from real-file artifacts
    Given one required artifact that exists as a directory
    And one required artifact that exists as a regular file
    When resolveArtifacts runs and buildRequiredReadingSection renders the result
    Then the rendered section contains the real-file artifact's label
    And the rendered section does NOT contain the directory artifact's label
    And the rendered section has no empty or broken entries

  # AC #6 — Empty result renders an empty section, not a malformed one
  Scenario: Section is empty when every artifact resolved to a directory
    Given every required artifact for the step exists as a directory
    When resolveArtifacts runs
    Then the artifacts array is empty
    And the rendered section is an empty string
    And the checklist is an empty string

  # Edge case — Directory containing only .gitkeep is still a directory
  Scenario: Directory containing only a .gitkeep file is treated as not-a-file
    Given a required artifact path that is a directory containing only ".gitkeep"
    When resolveArtifacts runs for the step
    Then the artifact does NOT appear in the artifacts array
    And the resolved path appears in the missing list
    And the reader does not recurse into the directory

  # Edge case — Symlink that resolves to a directory is treated as a directory
  Scenario: Symlink pointing at a directory is treated as a directory
    Given a required artifact path that is a symlink to a directory
    When resolveArtifacts runs for the step
    Then the artifact does NOT appear in the artifacts array
    And the resolved path appears in the missing list

  # Edge case — Symlink that resolves to a file is read as a normal file
  Scenario: Symlink pointing at a file is read as a regular file
    Given a required artifact path that is a symlink to a regular file with content "# Linked spec"
    When resolveArtifacts runs for the step
    Then the artifact appears in the artifacts array
    And its injected content is "# Linked spec"
    And the resolved path does NOT appear in the missing list

  # Edge case — Custom requirements flow through the same gate
  Scenario: Custom requirement pointing at a directory is handled by the same gate
    Given a custom required artifact requirement pointing at a directory
    When resolveArtifacts runs with the custom requirement
    Then resolveArtifacts does not throw
    And the custom artifact does NOT appear in the artifacts array
    And the custom artifact path appears in the missing list

  # Edge case — Slug with hyphens resolves and stats identically
  Scenario: Hyphenated feature slug is handled identically
    Given the feature slug "artifact-injection-directory-handling"
    And a regular file exists at the resolved artifact path for that slug
    When resolveArtifacts runs for the step
    Then the artifact appears in the artifacts array
    And resolveArtifacts does not throw

  # AC #8 — Absent file still behaves as before (regression guard)
  Scenario: Genuinely absent required artifact is reported missing
    Given a required artifact whose resolved path does not exist on disk
    When resolveArtifacts runs for the step
    Then the resolved path appears in the missing list
    And resolveArtifacts does not throw

  # AC #8 — Absent optional artifact is silently skipped (regression guard)
  Scenario: Genuinely absent optional artifact is silently skipped
    Given an optional artifact whose resolved path does not exist on disk
    When resolveArtifacts runs for the step
    Then the path does NOT appear in the missing list
    And the artifact does NOT appear in the artifacts array
