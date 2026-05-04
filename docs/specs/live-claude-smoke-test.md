---
slug: live-claude-smoke-test
status: draft
sprint: 9
---
# Live Claude CLI Smoke Test

## User Story
As a Raptor maintainer, I want a single non-mocked integration test that shells out to the real `claude` CLI using the orchestrator's actual spawn args — so that regressions in stdin handling, permission mode, allowed-tools, or model flags fail in CI/local test runs instead of waiting until a real `run_sprint` invocation discovers them.

## Background

`spawnAgent` (`src/orchestrator/agents.ts:194–290`) launches the `claude` CLI with a specific, load-bearing invocation:

```
spawn("claude", [
  "--print",
  "--permission-mode", "acceptEdits",
  "--allowedTools", AGENT_ALLOWED_TOOLS.join(","),
  "--system-prompt", systemPrompt,
  "--append-system-prompt", context,
  taskDescription,
], {
  cwd,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
})
```

Every detail of that invocation has already broken once:

- **Stdin (PR #13, commit `2bd8295`).** Pre-fix code used `execFile()` with an open stdin pipe. The CLI waited 3s and emitted `"Warning: no stdin data received in 3s, proceeding without it"`, which the orchestrator captured as agent output and looped on. Fix: `spawn()` with `stdio: ["ignore", ...]`.
- **Permission mode + allowed tools (Hotfix `95a1a62`).** Without `--permission-mode acceptEdits` and an explicit `--allowedTools` list, every Write/Edit/Bash request silently denied while the model's conversation continued. PO retried writing the same spec 18+ times before orchestrator timeout.

Both bugs were invisible to the existing test suite because **every test that touches `spawnAgent` mocks `child_process.spawn` at the boundary** (`src/orchestrator/agents.test.ts:4–10`):

```typescript
const spawnMock = jest.fn();
jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
```

Unit tests assert *what args we pass*. They do not assert *what the real `claude` CLI does when given those args*. The integration tests under `tests/integration/*.integration.test.ts` don't exercise `spawnAgent` at all — they cover bootstrap, registry, and tool-surface concerns. There is currently zero CI coverage of "does our actual spawn call work against a real `claude` binary."

This spec adds **one** non-mocked test that closes that gap. Its job is purely defensive: prove the spawn invocation is well-formed end-to-end against the live binary, so the next stdin/permissions/flags regression fails loudly inside `npm test` instead of mid-sprint.

## Acceptance Criteria

1. **One new test file.** A new test exists at `tests/integration/live-claude-smoke-test.integration.test.ts`. It contains exactly one live (non-mocked) test case. Adding more smoke cases is out of scope.
2. **Real binary, real spawn args.** The test invokes the real `claude` CLI via `child_process.spawn` (or a thin wrapper) using the **same flag set and stdio configuration** that `spawnAgent` uses today: `--print`, `--permission-mode acceptEdits`, `--allowedTools <AGENT_ALLOWED_TOOLS joined>`, and `stdio: ["ignore", "pipe", "pipe"]`. The flag set must be sourced from the same constants `spawnAgent` uses (e.g. by importing `AGENT_ALLOWED_TOOLS`), not duplicated as a string literal — so a future refactor of the flag list keeps the test honest.
3. **No `child_process` mock.** The test file does **not** call `jest.mock("child_process", ...)` and does not stub `spawn` / `execFile` / `execa`. Mocking is the failure mode this test exists to detect.
4. **Cheap, non-destructive prompt.** The task description / prompt given to `claude` is the cheapest invocation that still exercises the spawn path end-to-end (Architect's call: e.g. a trivial echo prompt, or a CLI-flag-only invocation like `--version` if the harness can be adapted). The test must NOT require network beyond what a normal local `claude` invocation needs, must not write to the project tree, and must not require the agent to use any tool other than producing text output.
5. **Pass condition.** The test passes when **all** of the following hold for the spawned subprocess:
    - Process exits with code `0`.
    - `stdout` is non-empty after trimming whitespace.
    - `stdout` does NOT match the stdin-warning regex `/no stdin data received/i` (the PR #13 regression marker).
    - `stderr` does NOT contain a permission-denied marker (Architect to define exact pattern based on current `claude` CLI output; e.g. `/permission denied/i` or `/tool .* not allowed/i`).
6. **Fail condition.** Any of: non-zero exit, empty stdout, stdin-warning match, or permission-denied marker → test fails with a message that includes `stdout` (truncated) and `stderr` so the regression is diagnosable from CI logs alone.
7. **Skip when prerequisites are missing.** The test is **skipped** (not failed) when:
    - The `claude` binary is not on `PATH`, OR
    - The environment variable `RAPTOR_SKIP_LIVE_CLAUDE` is set to a truthy value.
   Skip messages must clearly state which prerequisite was missing so a reader of the test output understands the test was not silently no-op'd.
8. **Timeout.** The test's per-case timeout is large enough to accommodate a real `claude` invocation (Architect chooses an explicit value; default Jest 30s is the floor, 60–90s is the expected ceiling). The chosen value is set on the test case itself, not by mutating global Jest config.
9. **Runs in `npm test` and `npm run test:integration` by default.** No new test script is required. The skip behavior in AC #7 is what keeps the test from breaking CI environments without `claude` installed; there is no opt-in flag required for a developer with a working local setup.
10. **Documents itself.** The test file's top-of-file comment explains: (a) why the test is non-mocked, (b) the two regressions that motivated it (stdin warning, permission denial), and (c) the skip conditions in AC #7. A future engineer reading the file should understand within 30 seconds why removing or mocking it is wrong.

## Edge Cases

- **Claude CLI returns the warning text in stdout, not stderr.** AC #5's stdin-warning regex must match `stdout` regardless of stream — the original PR #13 regression manifested as the warning being captured as the model's "answer" via stdout. If the CLI ever moves the warning to stderr, also failing on stderr match is acceptable.
- **Claude CLI rate-limited or returns API error.** Treated as a flaky failure, not a logic regression — the test fails as designed (non-zero exit / empty stdout). Re-run is the remediation. Do NOT special-case rate-limit detection; a real rate-limit failure of `spawnAgent` would also fail a sprint, and the smoke test should mirror that.
- **Local `claude` newer/older than CI's `claude`.** Out of scope — the test asserts behavior of *whatever `claude` is installed*. Version pinning belongs to a separate concern.
- **Test takes longer than expected and pushes total `npm test` time up.** Acceptable. One real CLI invocation per `npm test` run is the price of regression coverage. If the cost is prohibitive in practice, follow-up work can move the test to a separate `npm run test:smoke` script — but this spec keeps it in the default suite.
- **`AGENT_ALLOWED_TOOLS` is large (180+ entries) → command line length.** Must still work via `spawn()` with an args array (the orchestrator already does this). If platform argv limits become an issue, that's a real bug in production `spawnAgent` and is out of scope here.
- **Test machine has no `ANTHROPIC_API_KEY`.** This is a "prerequisites missing" case identical to AC #7: the test skips with a clear message. (Architect: include `ANTHROPIC_API_KEY` absence in the skip checks, or rely on `claude` CLI to fail fast and let AC #6 surface it — implementer's call. Document whichever path is chosen.)

## Out of Scope

- **Multiple smoke tests, parameterized smoke matrices, or per-role smoke coverage.** One test, one invocation. If signal proves valuable, add more in a follow-up spec.
- **Refactoring `spawnAgent` or `AGENT_ALLOWED_TOOLS`.** This spec adds a test only. No production code changes except, optionally, exporting an existing constant if `spawnAgent`'s args aren't already importable from a stable public surface.
  - **Out-of-scope amendment (2026-05-04):** During implementation, the test discovered a real production fragility — `--allowedTools` is a Commander variadic option that silently absorbs the prompt positional when `--system-prompt` (which incidentally terminated it) is omitted. Per user direction on [BLOCKER] commit `5e5ff08`, a one-line defensive change to `spawnAgent` was permitted: insert `"--"` before `taskDescription` in the spawn argv. Shipped on `main` as PR #18 (commit `6c1a28d`) before this test re-engaged. The test mirrors the new production argv shape.
- **CI environment changes** (installing `claude` in CI, adding `ANTHROPIC_API_KEY` to CI secrets). The skip behavior in AC #7 means CI without those is fine. Wiring CI to actually run the smoke test is a separate decision.
- **Replacing existing mocked tests.** All existing `agents.test.ts` mocked unit tests stay — they cover spawn-arg correctness in isolation. The smoke test adds end-to-end coverage; it does not subtract.
- **Coverage of MCP tool wiring.** This spec is bounded to `spawnAgent` ↔ `claude` CLI. The MCP server's stdio transport, tool registration, etc. are unchanged.
- **Snapshot or content assertions on what `claude` actually said.** AC #5 only asserts shape (exit code, non-empty, no warning markers). Asserting model output content would be flaky and is explicitly excluded.

## Open Questions

- **Which smoke prompt is cheapest?** Architect to choose between (a) a trivial `--print` prompt (e.g. "say ok"), (b) a flag-only invocation if `claude --version` or equivalent exercises permission-mode and allowed-tools handling, or (c) something else they identify as the minimum spawn-path exercise. Document the choice and the rationale in `docs/architecture/live-claude-smoke-test.md`.
- **Skip-on-missing-API-key strategy.** Pre-flight check vs. let-the-CLI-fail (see Edge Cases). Architect's call; document in design.
- **Exact stderr permission-denied pattern.** AC #5 requires Architect to confirm the current `claude` CLI's denial message format and pin a regex. If the format is unstable, fall back to checking that no instance of any tool name from `AGENT_ALLOWED_TOOLS` appears with a "denied" / "not allowed" qualifier nearby, OR document that we accept stdout-content-only assertions for the denial signal.
