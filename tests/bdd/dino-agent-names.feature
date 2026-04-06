Feature: Dinosaur Agent Names
  As a Raptor user
  I want each agent role to have a dinosaur-themed name
  So that sprint output is engaging and identifiable

  Background:
    Given the default dino names are configured

  Scenario: Default dino names for all roles
    Then the PO is "Pteranodon" with nickname "Petra"
    And the Architect is "Ankylosaurus" with nickname "Anky"
    And the QA is "Velociraptor" with nickname "Vex"
    And the Engineer is "Triceratops" with nickname "Trix"
    And the Team is "Brachiosaurus" with nickname "Brax"

  Scenario: Progress table shows dino names
    Given a sprint is in progress
    When the progress table is rendered
    Then the role column shows the dino emoji and nickname (e.g., "🦅 Petra (PO)")

  Scenario: System prompts include dino identity
    Given the PO role prompt is built
    Then it begins with "You are Petra the Pteranodon"

  Scenario: Handoff commits use dino names
    Given a handoff from PO to Architect
    Then the commit message contains "Petra (PO) -> Anky (Architect)"

  Scenario: Checkpoint prompts use dino names
    Given a spec-review checkpoint is built
    Then the prompt includes "Petra (PO)" in the description

  Scenario: Custom dino names from config
    Given config has dinoNames with qa set to species "T-Rex" nickname "Rexy"
    When dino names are resolved
    Then QA is "T-Rex" with nickname "Rexy"
    And other roles use defaults

  Scenario: Partial config overrides
    Given config has dinoNames with only engineer nickname set to "Rocky"
    When dino names are resolved
    Then the Engineer nickname is "Rocky"
    And the Engineer species remains "Triceratops"
    And all other roles use full defaults

  Scenario: Invalid role keys in config are ignored
    Given config has dinoNames with an unknown role "intern"
    When dino names are resolved
    Then no error is thrown
    And all roles use defaults

  Scenario: Escalation commits use dino names
    Given a QA step is escalated
    Then the escalation commit contains "Vex (QA)"
