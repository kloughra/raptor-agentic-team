Feature: Progress-Aware Circuit Breaker
  As a Raptor user running a sprint
  I want the retry circuit breaker to distinguish no progress from interrupted progress
  So that transient infrastructure failures and premature kills stop burning retry
  slots and discarding good work, and genuinely stuck steps escalate faster

  # Spec: docs/specs/progress-aware-circuit-breaker.md (AC 1-22)
  # Architecture: docs/architecture/progress-aware-circuit-breaker.md
  # Decision ordering (binding): BLOCKER > record > salvage-complete > transient
  #   > no-progress short-circuit > deterministic slot accounting

  Background:
    Given a Raptor sprint is running with the standard 13-step workflow
    And MAX_RETRY_ATTEMPTS is 3 deterministic attempts per step
    And the transient retry cap is 5 per step
    And the hard agent-runtime ceiling is 60 minutes

  # ---------------------------------------------------------------------------
  # CB-1: No-progress short-circuit (AC 1-4)
  # ---------------------------------------------------------------------------

  Scenario: Two consecutive identical deterministic failures short-circuit escalation
    Given a step has failed once with a deterministic failure whose persisted signature is "no-output"
    When the step fails again with a failure deriving the identical signature "no-output"
    Then the runner escalates immediately without consuming the remaining attempt slots
    And the escalation message states that retries were short-circuited due to no progress
    And the escalation message shows the repeated signature "no-output"
    And the step state records escalationReason "no-progress"

  Scenario: Repeated stdin-wait warning short-circuits after two occurrences
    Given an agent attempt fails with output containing "Input must be provided either through stdin or as a prompt argument when using --print"
    And the failure is recorded with signature class "stdin-wait-warning"
    When a second attempt fails with the same stdin-wait warning output
    Then the runner escalates with reason "no-progress" after 2 attempts, not 3
    # Absorbs the early-exit-on-stdin-warning Ready item (AC 2)

  Scenario: Two failures with different signatures do not short-circuit
    Given a step has failed once with persisted signature "no-output"
    When the step fails again with a different signature "buffer-overflow"
    Then no short-circuit occurs
    And the existing 3-attempt circuit breaker behavior applies

  Scenario: Cosmetic differences in error text cannot defeat the signature match
    Given a step failed with "agent idle-killed after 300000ms with no stdout output"
    When the step fails again with "agent idle-killed after 900000ms with no stdout output"
    Then both failures derive the same signature class "idle-timeout"
    And the runner short-circuits with reason "no-progress"

  Scenario: Short-circuited escalations are distinguishable from exhausted attempts in state
    Given one step escalated via the no-progress short-circuit
    And another step escalated after exhausting 3 deterministic attempts
    Then the first step's state records escalationReason "no-progress"
    And the second step's state records escalationReason "attempts-exhausted"

  Scenario: Deterministic failure, transient blip, then identical deterministic failure still short-circuits
    Given a step failed deterministically with signature "missing-outputs:tests/bdd/*.feature"
    And the step then failed transiently with "socket connection closed unexpectedly"
    When the step fails deterministically again with signature "missing-outputs:tests/bdd/*.feature"
    Then the short-circuit comparison skips the interleaved transient record
    And the runner escalates with reason "no-progress"

  Scenario: Signature match across a scope-narrowing boundary does not short-circuit
    Given a step failed deterministically on a full-scope attempt with signature "no-output"
    And the next attempt was narrowed by progressive scope-narrowing
    When the narrowed attempt fails with the identical signature "no-output"
    Then the runner does NOT short-circuit
    # The task changed at the narrowing boundary, so repetition is not yet no-progress evidence

  Scenario: Old failure records without a persisted signature never match
    Given a step has a failure record persisted by a pre-Sprint-12 version with no signature field
    When a new failure is recorded whose derived signature would textually match the old errorSummary
    Then the comparison treats the old record as no-match
    And no short-circuit occurs

  # ---------------------------------------------------------------------------
  # CB-2: Transient vs deterministic classification (AC 5-9)
  # ---------------------------------------------------------------------------

  Scenario: Failures are classified at record time and persisted
    When an agent attempt fails with "socket connection closed unexpectedly"
    Then the FailureRecord is written with classification "transient"
    And the classification is persisted in the sprint state file

  Scenario: Transient failure does not consume a circuit-breaker attempt slot
    Given a step is on deterministic attempt 1 of 3
    When the attempt fails with "socket connection closed unexpectedly"
    Then the step is retried after a fixed 15 second delay
    And the deterministic attempt count remains 1

  Scenario Outline: Infrastructure-level errors classify as transient
    When an agent attempt fails with output containing "<error>"
    Then the failure is classified "transient"

    Examples:
      | error                                  |
      | socket connection closed unexpectedly  |
      | ECONNRESET                             |
      | ETIMEDOUT                              |
      | fetch failed                           |
      | overloaded_error                       |
      | rate limit                             |

  Scenario: Transient retries are capped at 5 per step
    Given a step has already recorded 4 transient failures
    When the step fails transiently a 5th time
    Then the runner escalates with reason "transient-cap"
    And the escalation message identifies the persistent infrastructure problem
    And the message names the repeated signature and the cap value

  Scenario: Two consecutive identical transient failures do not trigger the no-progress short-circuit
    Given a step failed transiently with "socket connection closed unexpectedly"
    When the step fails transiently again with the identical error
    Then CB-2 governs: the step retries without consuming a slot (until the transient cap)
    And the CB-1 short-circuit does not fire
    # Two socket drops in a row are outage evidence, not no-progress evidence

  Scenario: Deterministic failures behave exactly as today
    Given a step fails with a deterministic error such as "agent produced no output"
    Then the failure consumes one of the 3 attempt slots
    And after 3 deterministic failures with distinct signatures the step escalates with reason "attempts-exhausted"

  Scenario: Failure records from older sprints load as deterministic
    Given a sprint state file persisted before this feature with failure records lacking a classification field
    When the sprint state is loaded
    Then loading succeeds without error
    And every unclassified failure record is treated as "deterministic"

  # ---------------------------------------------------------------------------
  # CB-3: Idle-timeout instead of wall-clock kill (AC 10-13)
  # ---------------------------------------------------------------------------

  Scenario: A continuously streaming agent is not killed at the resolved step timeout
    Given a step with a resolved timeout of 30 minutes
    And an agent that emits stdout output every few seconds
    When the agent's total runtime passes 30 minutes
    Then the agent is NOT killed
    And the idle deadline resets on every stdout data chunk

  Scenario: A silent agent is idle-killed after the resolved step timeout
    Given a step with a resolved timeout of 30 minutes
    And an agent that produces no stdout output for 30 minutes
    When the idle window elapses
    Then the agent is killed
    And the failure output says the agent was idle-killed and for how long
    And the message is distinguishable from the legacy wall-clock timeout message

  Scenario: stderr output does not reset the idle timer
    Given an agent that emits only stderr output
    When no stdout is produced for the full idle window
    Then the agent is idle-killed
    # stdout is the sole liveness signal (architecture constraint 9)

  Scenario: The hard ceiling kills even a continuously streaming agent
    Given an agent that streams heartbeat output forever
    When the agent's total runtime reaches the 60-minute hard ceiling
    Then the agent is killed regardless of streaming
    And the failure output contains a ceiling-specific message distinct from the idle-kill message

  Scenario: Idle-kill and ceiling-kill classify as deterministic
    When an agent is idle-killed or ceiling-killed
    Then the recorded failure classifies as "deterministic"
    And two consecutive idle-kills short-circuit via CB-1 after 2 attempts

  Scenario: Idle-kill of an agent that finished its work pairs with salvage
    Given an agent wrote all expected output files and then went silent
    When the agent is idle-killed
    Then the salvage-complete check runs before any classification decision
    And the step completes via salvage without another agent attempt

  Scenario: Buffer-overflow kill behavior is unchanged and deterministic
    Given an agent whose output exceeds the 10MB buffer
    When the agent is killed for buffer overflow
    Then the existing buffer-overflow behavior is unchanged
    And the failure classifies as "deterministic"

  # ---------------------------------------------------------------------------
  # CB-4: Partial-artifact salvage (AC 14-17)
  # ---------------------------------------------------------------------------

  Scenario: Next attempt is told which expected outputs already exist
    Given a failed attempt left "tests/bdd/my-feature.feature" on disk satisfying one expected-output pattern
    And the pattern "tests/integration/*" is still unsatisfied
    When the next attempt's task description is built
    Then it lists the already-existing validated files with an instruction not to recreate them from scratch
    And it lists the still-missing patterns as this attempt's actual job

  Scenario: Sprint 11 replay — agent dies after finishing all its work
    Given a QA agent wrote valid files satisfying every expected-output pattern for step 3
    And the agent was then killed before exiting cleanly
    When the failure is processed
    Then the orchestrator validates the files via the existing glob gate
    And marks the step complete WITHOUT another agent attempt
    And the step state records completedVia "salvage"
    And no validated artifact is discarded

  Scenario: Salvage-complete wins over every other decision
    Given a failed attempt whose failure is transient AND whose signature matches the previous failure
    And all expected outputs exist on disk and pass the glob gate
    When the retry decision is made
    Then the decision is salvage-complete
    # Salvage runs before transient handling and before the short-circuit (ordering rationale)

  Scenario: Salvage never bypasses validation
    Given a failed attempt left files on disk that do NOT pass the expected-outputs glob gate
    When the failure is processed
    Then the files are not accepted as salvage
    And the step retries per the CB-1/CB-2 rules

  Scenario: .gitkeep placeholders never count as salvageable artifacts
    Given a failed attempt left only a directory containing a ".gitkeep" file under an expected-output pattern
    When the salvage check runs
    Then the pattern is treated as unsatisfied
    And the step is not salvage-completed

  Scenario: The working tree is preserved between attempts
    Given attempt N wrote an expected output file to the working tree, uncommitted
    When attempt N+1 begins
    Then no checkout, clean, or reset has removed the file
    And the salvage check and retry context for attempt N+1 see the file

  # ---------------------------------------------------------------------------
  # CB-5: Timeout config plumbing (AC 18-20)
  # ---------------------------------------------------------------------------

  Scenario: loadConfig parses the timeouts key from config.json
    Given a config.json containing timeouts with a default and stepOverrides
    When the config is loaded
    Then the returned config includes the parsed timeouts object

  Scenario: Absent timeouts key behaves byte-identically to today
    Given a config.json with no timeouts key
    When the config is loaded
    Then the returned config has no timeouts field
    And timeout resolution behaves exactly as before this feature

  Scenario: A step override in config.json changes the timeout actually applied
    Given a config.json with a stepOverrides entry of 2 minutes for "Author specification"
    When a sprint runs that step
    Then the timeout applied to the spawned agent is 2 minutes
    # End-to-end: config.json -> loadConfig -> tool context -> runner -> resolveStepTimeout -> spawnAgent (AC 20)

  Scenario: Config default applies only where built-in resolution order says so
    Given a config.json with only timeouts.default set
    When timeouts are resolved
    Then the resolution order of timeouts.ts (override > default > built-in > fallback) is unchanged

  # ---------------------------------------------------------------------------
  # Cross-cutting (AC 21-22)
  # ---------------------------------------------------------------------------

  Scenario: Single-feature and multi-feature retry loops behave identically
    Given the same sequence of failures for a step
    When processed by the single-feature loop and by the multi-feature loop
    Then both produce the same retry decision
    # Both loops call the same pure decideAfterFailure (architecture constraint 1)

  Scenario: Merge-step retry behavior does not regress
    Given the merge step fails
    Then the merge retry loop keeps today's exact 3-attempt behavior
    And no salvage or transient logic is applied to merge failures

  Scenario: Every decision path is visible in sprint state and reporting
    Given a sprint where a short-circuit, a transient retry, an idle-kill, a ceiling-kill, and a salvage-complete each occurred
    Then each event is recorded in the sprint state
    And each is visible in escalation or progress reporting
    And no decision branch is silent

  Scenario: Pre-Sprint-12 state files resume without error
    Given a sprint state file created before this feature
    When the sprint is resumed
    Then loading succeeds
    And all new fields read with backward-compatible defaults
