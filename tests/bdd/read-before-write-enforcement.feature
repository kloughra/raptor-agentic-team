Feature: Read-Before-Write Enforcement
  As a sprint orchestrator
  I want agents to read all input artifacts before generating output
  So output quality is consistent and nothing is missed

  Scenario: Artifact requirements resolved for Engineer step
    Given the step is "Implement (TDD)" with feature slug "my-feature"
    When artifact requirements are resolved
    Then the result includes spec, architecture, BDD scenarios, and integration tests
    And each artifact has its content loaded from disk

  Scenario: Missing required artifact fails the step
    Given the step is "Write tests" with feature slug "my-feature"
    And docs/specs/my-feature.md does not exist
    When artifact requirements are resolved
    Then the result reports docs/specs/my-feature.md as missing
    And the missing list is non-empty

  Scenario: Required reading section is generated
    Given all required artifacts exist for the "Implement (TDD)" step
    When the required reading section is built
    Then it contains a "## Required Reading" header
    And it contains each artifact's content under a labeled subsection
    And it contains a "## Pre-Generation Checklist" with items for each artifact

  Scenario: Steps without requirements use fallback
    Given the step is "Open PR" which has no artifact requirements
    When artifact requirements are resolved
    Then the result has an empty artifacts list
    And no missing artifacts are reported

  Scenario: Artifact content is capped per file
    Given a spec file that is 50KB
    And the per-artifact cap is 10KB
    When the artifact is loaded
    Then the injected content is truncated to 10KB

  Scenario: Multi-feature sprint resolves per feature
    Given a multi-feature sprint with slugs "feature-a" and "feature-b"
    When artifacts are resolved for "feature-a"
    Then only feature-a's spec and architecture are loaded
    And feature-b's artifacts are not included

  Scenario: Custom artifact requirements from config
    Given raptor config adds a custom requirement for "Implement (TDD)": "docs/api-spec.yaml"
    When artifact requirements are resolved for the Engineer step
    Then the custom requirement is included alongside defaults

  Scenario: Handoff commit includes consumed artifacts
    Given an agent step completed after consuming 3 artifacts
    When the handoff commit is created
    Then the commit message includes a "Consumed:" line listing the artifact paths
