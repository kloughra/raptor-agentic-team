# BDD scenarios — adversarial-verifier-review-gate (Sprint 14)
#
# Spec:         docs/specs/adversarial-verifier-review-gate.md (AC 1–17)
# Architecture: docs/architecture/adversarial-verifier-review-gate.md
#
# Scope realized this sprint (Architect rulings):
#   Part 1 — Real-seam enforcement: inject an adversarial-verifier instruction
#            into the step-7 QA test-execution agent (buildAdversarialGateSection
#            in prompts.ts, appended by runner.ts).
#   Part 2 — Generator ≠ verifier: optional `model` param on spawnAgent →
#            `claude --model`; `models` config surface parsed in loadConfig;
#            resolveRoleModel(role, config) threaded to every spawn call site.
#   Part 3 — Bias controls: SATISFIED VACUOUSLY. No LLM-judge scoring gate is
#            introduced, so ACs 12–14 apply to nothing (deliberate, recorded).
#
# Every change is additive and backward-compatible: with no `models` config and
# the injected instruction absent from outcomes, a sprint behaves byte-for-byte
# as today (the dominant edge case).

Feature: Adversarial verifier review gate
  As a Raptor user running a sprint
  I want the QA/PR review gate to behave as an out-of-loop adversarial verifier,
  running on a verifier model that need not equal the generator's,
  So that a sprint cannot report "all tests pass" when the tests secretly
  reimplement the system-under-test or were never proven to fail.

  # =========================================================================
  # Part 1 — Real-seam enforcement at the gate (AC 1–4)
  # =========================================================================

  Scenario: The step-7 QA gate agent receives the adversarial-verifier instruction (AC 1, AC 2)
    Given a sprint parked at step 7 "Run test suite" with the QA role
    When the orchestrator builds the QA gate agent's task prompt
    Then the prompt contains an explicit instruction to act as an out-of-loop adversarial verifier
    And the instruction is injected by the orchestrator in code, not merely present in TEAM.md
    And it directs the agent to hunt for tests that reimplement or stub the system-under-test
    And it directs the agent to confirm constraint-guarding tests carry a RED-verification note

  Scenario: The gate is biased toward false-negative over false-positive (AC 3)
    Given the adversarial-verifier instruction built for the QA gate
    When the instruction guidance is read
    Then it tells the verifier to reject suspicious-but-plausible work rather than accept it
    And it invokes the principle that an agent cannot recover from a falsely-passing test

  Scenario: A detected reimplementation is surfaced, never silently passed (AC 4, AC 17)
    Given the adversarial-verifier instruction built for the QA gate
    When the instruction describes what to do on detecting a reimplementation or a missing RED note
    Then it directs the agent to flag or fail the review and surface the finding in its reported result
    And it never permits a silent pass on a detected reimplementation

  Scenario: Enforcement takes effect for every sprint without a human reading TEAM.md (AC 2)
    Given any sprint reaching step 7 "Run test suite"
    When the runner constructs the QA agent's prompt through the production seam
    Then the adversarial-gate section returned by buildAdversarialGateSection is part of that prompt
    And no TEAM.md edit is required for the enforcement to apply

  # =========================================================================
  # Part 2 — Generator ≠ verifier: model plumbing (AC 5–10)
  # =========================================================================

  Scenario: spawnAgent passes --model to the claude CLI when a model is provided (AC 5)
    Given a call to spawnAgent with the model selector "claude-verifier-model"
    When the claude CLI argv is assembled
    Then the argv contains "--model" immediately followed by "claude-verifier-model"

  Scenario: With no model, spawnAgent argv is byte-identical to today (AC 5, backward compat)
    Given a call to spawnAgent with no model selector
    When the claude CLI argv is assembled
    Then the argv contains no "--model" token anywhere
    And the argv equals the exact array produced before this feature

  Scenario: The load-bearing argv tail is preserved with a model set (AC 6)
    Given a call to spawnAgent with a model selector and a task description
    When the claude CLI argv is assembled
    Then "--allowedTools" is immediately followed only by the tool list, never the model or the prompt
    And the end-of-options separator "--" is present
    And the task description is the last argv element

  Scenario: Idle-timeout and hard-ceiling behavior are not regressed with a model set (AC 7)
    Given spawnAgent is invoked with a model selector and an idle window
    And the agent produces no stdout output
    When the idle window elapses
    Then the agent is idle-killed exactly as it would be without a model
    And the killKind is "idle" and the exit code is 1

  Scenario: A per-role model is parsed from config and reaches the resolver (AC 8, AC 9)
    Given a config file with models.byRole.qa set to "claude-verifier-model"
    When loadConfig parses the config
    Then config.models.byRole.qa equals "claude-verifier-model"
    And resolveRoleModel for the qa role returns "claude-verifier-model"

  Scenario: models.default applies to a role with no explicit override (AC 8)
    Given a config with models.default "claude-default-model" and no byRole entry for engineer
    When resolveRoleModel is called for the engineer role
    Then it returns "claude-default-model"

  Scenario: A per-role override beats the default (AC 8)
    Given a config with models.default "claude-default-model" and models.byRole.qa "claude-verifier-model"
    When resolveRoleModel is called for the qa role
    Then it returns "claude-verifier-model"

  Scenario: The verifier model reaches the spawn argv end-to-end at the step-7 gate (AC 9, AC 10)
    Given a config with models.byRole.qa set to "claude-verifier-model"
    And a sprint parked at step 7 "Run test suite"
    When the runner spawns the QA gate agent through the production seam
    Then the model resolved for the qa role reaches the spawnAgent call for that step

  Scenario: Verifier and generator are demonstrably not forced to the same model (AC 10)
    Given a config with models.byRole.qa "claude-verifier-model" and models.byRole.engineer "claude-engineer-model"
    When resolveRoleModel is called for the qa role and the engineer role
    Then the two resolved models are different and both defined

  # =========================================================================
  # Part 3 — Bias controls (conditional; AC 11, AC 14)
  # =========================================================================

  Scenario: No LLM-judge scoring gate is introduced, so bias controls apply vacuously (AC 11)
    Given this feature realizes Part 1 as an instruction to the existing QA agent
    When the orchestrator's review gates are enumerated
    Then no new numeric or A/B LLM-judge scoring gate exists
    And Part 3 is satisfied vacuously as a deliberate recorded decision

  Scenario: No multi-judge voting ensemble is built (AC 14)
    Given the refuted research finding that a judge ensemble was not supported
    When the orchestrator's exported surface is inspected
    Then there is no judge-panel or voting-ensemble gate

  # =========================================================================
  # Cross-cutting: backward compatibility & no silent branches (AC 15–17)
  # =========================================================================

  Scenario: A config without a models key changes nothing (AC 15, dominant edge case)
    Given a config file with no models key
    When loadConfig parses it and resolveRoleModel is called for any role
    Then config.models is undefined
    And resolveRoleModel returns undefined
    And spawnAgent is therefore called without a model, yielding today's argv

  Scenario: Malformed models config is dropped field-wise and never crashes loadConfig (AC 15, edge case)
    Given a config where models is an array, byRole.qa is a number, and byRole has an unknown role key
    When loadConfig parses it
    Then loadConfig does not throw
    And no invalid entry survives into config.models

  Scenario: An invalid configured model surfaces through the existing failure path (edge case)
    Given a configured model name the claude CLI rejects
    When the QA gate agent runs with that model
    Then the non-zero exit flows through the existing failure-classification and retry path
    And the orchestrator does not crash

  Scenario: Partial configuration is valid — the unconfigured role falls back to default (edge case)
    Given a config where only the verifier role has a model and the generator role does not
    When resolveRoleModel is called for both roles
    Then the generator resolves to the default or undefined and the verifier resolves to its configured model
    And generator ≠ verifier still holds

  Scenario: Ordinary happy-path tests are not demanded to carry a RED-verification note (edge case)
    Given the adversarial-gate instruction scopes the RED-note check to constraint-guarding tests
    When the instruction is read
    Then it does not require a RED-verification note on every ordinary test
