Feature: Review gate demands mutation evidence
  As the Raptor team relying on the step-7 review gate to tell the truth about coverage
  I want the gate to require mechanical mutation evidence
  So that a feature cannot pass review with tests that fail to exercise the real system

  Background:
    Given the step-7 QA review gate builds its instruction in orchestrator code
    And the Sprint-14 adversarial-verifier checks (reimplementation hunt, RED-note check) are present

  Scenario: The gate directs a mutation test on the primary seam
    When the step-7 gate instruction is built
    Then it directs the verifier to mutate the primary production seam under review
    And to run the feature-scoped tests and observe the result

  Scenario: RED confirms coverage, green-under-mutation fails the review
    When the step-7 gate instruction is built
    Then it states that a mutation causing at least one test to fail confirms coverage
    And it states that a suite staying green under the mutation is a false-green that FLAGs and FAILs the review

  Scenario: The verifier must restore the code and surface structured evidence
    When the step-7 gate instruction is built
    Then it requires reverting the mutation and re-confirming the suite is green
    And it requires a structured evidence block naming the seam, the mutation, the RED evidence, and the restore

  Scenario: A feature with no executable seam records and skips
    Given a feature whose deliverable is docs-only or config-only
    When the step-7 gate instruction is built
    Then it directs the verifier to record that no executable production seam exists and skip the mutation

  Scenario: The mutation directive reaches the real step-7 prompt at both seams
    Given a single-feature sprint parked at step 7
    When the runner dispatches the step-7 QA gate
    Then the QA agent prompt contains the mutation-check directive
    And the same directive reaches the multi-feature step-7 seam via the shared builder

  Scenario: The gate composes with, and never weakens, the Sprint-14 checks
    When the step-7 gate instruction is built
    Then it contains the Sprint-14 adversarial section verbatim
    And it contains the mutation-check section verbatim
