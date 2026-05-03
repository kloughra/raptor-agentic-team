Feature: Live Claude CLI Smoke Test
  As a Raptor maintainer
  I want a single non-mocked integration test that shells out to the real `claude` CLI
  using the orchestrator's actual spawn args
  So that regressions in stdin handling, permission mode, allowed-tools, or model flags
  fail in `npm test` instead of waiting until a real `run_sprint` invocation discovers them.

  Background:
    Given the integration test file lives at "tests/integration/live-claude-smoke-test.integration.test.ts"
    And the file does NOT call `jest.mock("child_process", ...)`
    And the file does NOT stub `spawn`, `execFile`, or `execa`
    And the file imports `AGENT_ALLOWED_TOOLS` from "src/orchestrator/agents.ts"

  # --- AC #1, #2: One test, real spawn args sourced from production constant ---

  Scenario: Exactly one live test case exists
    When the test file is parsed by Jest
    Then it contains exactly one `it(...)` (or `test(...)`) call inside the describe block

  Scenario: Spawn args mirror the production spawnAgent invocation
    When the test invokes the real `claude` binary
    Then the args array contains "--print"
    And the args array contains "--permission-mode" followed by "acceptEdits"
    And the args array contains "--allowedTools" followed by `AGENT_ALLOWED_TOOLS.join(",")`
    And the stdio configuration is `["ignore", "pipe", "pipe"]`
    And `AGENT_ALLOWED_TOOLS` is imported from "src/orchestrator/agents", not duplicated as a literal

  # --- AC #3: No mocking ---

  Scenario: child_process is not mocked
    Given the integration test file
    Then it does not contain the substring `jest.mock("child_process"`
    And it does not contain the substring `jest.mock('child_process'`
    And it does not stub `spawn`, `execFile`, or `execa`

  # --- AC #4: Cheap, non-destructive prompt ---

  Scenario: The smoke prompt is the cheapest spawn-path exercise
    When the test spawns claude
    Then the task description is the trivial prompt "say ok"
    And the test does not pass `--system-prompt` or `--append-system-prompt` flags
    And the test does not require any tool other than text output
    And the test does not write to the project tree
    And the test does not require additional network calls beyond `claude --print` itself

  # --- AC #5: Pass conditions (happy path) ---

  Scenario: Pass — successful claude invocation
    Given `claude` is on PATH
    And `RAPTOR_SKIP_LIVE_CLAUDE` is unset
    When the test spawns `claude --print --permission-mode acceptEdits --allowedTools <tools> "say ok"`
    And the subprocess exits with code 0
    And `stdout.trim()` is non-empty
    And `stdout` does NOT match `/no stdin data received/i`
    And `stderr` does NOT match `/no stdin data received/i`
    And `stderr` does NOT match the permission-denied alternation
    And `stdout` does NOT match the permission-denied alternation
    Then the test passes

  # --- AC #5, #6: Fail conditions (one per regression marker) ---

  Scenario: Fail — non-zero exit code
    Given the spawned claude subprocess exits with code 1
    When the test evaluates pass/fail
    Then the test fails
    And the failure message includes the exit code
    And the failure message includes truncated stdout (≤ 2000 chars)
    And the failure message includes truncated stderr (≤ 2000 chars)
    And the failure message includes a redacted argv summary

  Scenario: Fail — empty stdout
    Given the spawned claude subprocess exits with code 0
    But `stdout.trim()` is empty
    When the test evaluates pass/fail
    Then the test fails with a message including stdout and stderr

  Scenario: Fail — PR #13 stdin warning regression marker in stdout
    Given the spawned claude subprocess emits "Warning: no stdin data received in 3s, proceeding without it" to stdout
    When the test evaluates pass/fail
    Then `/no stdin data received/i` matches stdout
    And the test fails with a message that pinpoints the stdin-warning regression
    And the failure message includes truncated stdout and stderr

  Scenario: Fail — stdin warning regression marker in stderr
    Given the spawned claude subprocess emits the stdin warning to stderr (not stdout)
    When the test evaluates pass/fail
    Then `/no stdin data received/i` matches stderr
    And the test fails (belt-and-suspenders per the spec's Edge Case)

  Scenario: Fail — Hotfix 95a1a62 permission-denied marker in stderr
    Given the spawned claude subprocess emits "permission denied" or "tool X not allowed" to stderr
    When the test evaluates pass/fail
    Then the permission-denied alternation matches stderr
    And the test fails with a diagnosable message

  Scenario: Fail — permission-denied marker surfaced via stdout
    Given the spawned claude subprocess emits "tool Bash blocked" to stdout
    When the test evaluates pass/fail
    Then the permission-denied alternation matches stdout
    And the test fails (per Hotfix 95a1a62 historical surface)

  # --- AC #7: Skip behavior ---

  Scenario: Skip — RAPTOR_SKIP_LIVE_CLAUDE is set
    Given `process.env.RAPTOR_SKIP_LIVE_CLAUDE` is "1"
    When Jest loads the test file
    Then the test is skipped (not failed)
    And the skip message clearly states "RAPTOR_SKIP_LIVE_CLAUDE is set"

  Scenario: Skip — RAPTOR_SKIP_LIVE_CLAUDE is "true"
    Given `process.env.RAPTOR_SKIP_LIVE_CLAUDE` is "true"
    When Jest loads the test file
    Then the test is skipped (not failed)

  Scenario: Skip — claude binary not on PATH
    Given `RAPTOR_SKIP_LIVE_CLAUDE` is unset
    But `spawnSync("claude", ["--version"], { stdio: "ignore" })` returns `error.code === "ENOENT"`
    When Jest loads the test file
    Then the test is skipped (not failed)
    And the skip message clearly states "claude binary not found on PATH"

  Scenario: Skip predicates evaluate in documented order
    Given both `RAPTOR_SKIP_LIVE_CLAUDE` is set AND `claude` is missing from PATH
    When the skip pre-flight runs
    Then RAPTOR_SKIP_LIVE_CLAUDE is checked first
    And the skip message reflects the env var, not the missing binary

  Scenario: ANTHROPIC_API_KEY absence does NOT pre-empt the test
    Given `claude` is on PATH
    And `RAPTOR_SKIP_LIVE_CLAUDE` is unset
    And `ANTHROPIC_API_KEY` is unset
    When Jest loads the test file
    Then the test is NOT skipped pre-flight
    And the CLI failure (if any) surfaces via AC #6 with diagnostic stderr
    # Architect decision: claude has multiple auth mechanisms; pre-checking ANTHROPIC_API_KEY
    # alone would skip valid setups (OAuth, keychain, apiKeyHelper).

  # --- AC #8: Timeout ---

  Scenario: Per-test timeout is set on the test case, not globally
    When the test is registered
    Then the timeout argument passed to `it(...)` is at least 30000 ms
    And the timeout is at most 90000 ms
    And the chosen value is 60000 ms (per architecture decision)
    And no `jest.setTimeout(...)` global mutation is performed in this file

  # --- AC #9: Default suite participation ---

  Scenario: Test runs in `npm test` by default
    When `npm test` is invoked
    Then Jest discovers the file via the `tests/**/*.test.ts` glob
    And no opt-in environment flag is required (only opt-OUT via RAPTOR_SKIP_LIVE_CLAUDE)

  Scenario: Test runs in `npm run test:integration` by default
    When `npm run test:integration` is invoked
    Then the file is included in the integration test set

  # --- AC #10: Self-documenting ---

  Scenario: Top-of-file comment explains why mocking is forbidden
    Given the integration test file
    Then the top-of-file comment block includes the rationale for non-mocked execution
    And it references the PR #13 stdin warning regression
    And it references the Hotfix 95a1a62 permission-denial regression
    And it documents the skip conditions from AC #7
    And a future engineer reading the file understands within 30 seconds why removing or mocking it is wrong

  # --- Edge Cases (from spec) ---

  Scenario: Stdin warning surfaced via stdout (PR #13 historical surface)
    Given the spawned subprocess writes the stdin warning to stdout
    When the test evaluates pass/fail
    Then the test fails (regex matches stdout)

  Scenario: Claude API rate-limit surfaces as ordinary failure
    Given the spawned subprocess exits non-zero with rate-limit text in stderr
    When the test evaluates pass/fail
    Then the test fails as designed (no rate-limit special-casing)
    And re-running the test is the documented remediation

  Scenario: Large `AGENT_ALLOWED_TOOLS` does not exceed argv limits
    Given `AGENT_ALLOWED_TOOLS` contains many entries
    When `spawn(...)` is called with the args array
    Then the spawn succeeds without ENAMETOOLONG
    # If platform argv limits become a problem, that is a real production bug —
    # out of scope for this test, in scope for spawnAgent to surface.

  Scenario: ANTHROPIC_API_KEY missing — CLI fails fast and surfaces via AC #6
    Given the test is not skipped pre-flight
    And the spawned `claude` exits non-zero due to missing auth
    When the test evaluates pass/fail
    Then the test fails (non-zero exit)
    And the failure message includes truncated stderr containing the auth error
    # Mirrors how spawnAgent fails in production — the contract this test validates.

  # --- Skip-mode performance NFR ---

  Scenario: Skipped test stays under 100ms latency
    Given a skip predicate triggers
    When the test is loaded
    Then the only I/O is `spawnSync("claude", ["--version"], { stdio: "ignore" })`
    And the test reports "skipped" in well under 100ms
