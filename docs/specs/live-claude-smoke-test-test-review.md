---
slug: live-claude-smoke-test
artifact: po-test-review
status: approved
sprint: 9
reviewer: Petra (PO)
---

# PO Test Review — live-claude-smoke-test

**Decision: APPROVED. Engineer may proceed with implementation.**

## Scope of Review

- Spec: `docs/specs/live-claude-smoke-test.md`
- Architecture: `docs/architecture/live-claude-smoke-test.md`
- BDD: `tests/bdd/live-claude-smoke-test.feature` (22 scenarios — every AC + every edge case + the skip-mode latency NFR)
- Integration: `tests/integration/live-claude-smoke-test.integration.test.ts` (1 live test case, as required by AC #1)

## Acceptance Criteria → Test Coverage

| AC | BDD scenario(s) | Integration assertion(s) | Verdict |
|----|-----------------|--------------------------|---------|
| #1 — One file, exactly one live test case | "Exactly one live test case exists" | Single `itOrSkip(...)` inside a single `describe(...)` block (test file lines 161–240) | ✅ Covered |
| #2 — Real binary, real spawn args sourced from production constant | "Spawn args mirror the production spawnAgent invocation" | `import { AGENT_ALLOWED_TOOLS } from "../../src/orchestrator/agents"`; args = `["--print", "--permission-mode", "acceptEdits", "--allowedTools", AGENT_ALLOWED_TOOLS.join(","), "say ok"]`; `stdio: ["ignore", "pipe", "pipe"]` | ✅ Covered |
| #3 — No `child_process` mock | "child_process is not mocked" | File contains no `jest.mock("child_process"`/`'child_process'`; uses real `spawn` and `spawnSync` from `child_process` directly | ✅ Covered |
| #4 — Cheap, non-destructive prompt | "The smoke prompt is the cheapest spawn-path exercise" | Prompt is `"say ok"`; no `--system-prompt` / `--append-system-prompt`; no project-tree writes; no extra network calls beyond `claude --print` | ✅ Covered |
| #5 — Pass conditions | "Pass — successful claude invocation" | 6 assertions: exit code 0; non-empty trimmed stdout; `STDIN_WARNING` does not match stdout; does not match stderr; `PERMISSION_DENIED` does not match stderr; does not match stdout | ✅ Covered |
| #6 — Diagnosable failure message | 5 explicit fail scenarios (non-zero exit, empty stdout, stdin warning in stdout, stdin warning in stderr, permission-denied in stderr, permission-denied in stdout) | Shared `diag` block per assertion: redacted argv (`--allowedTools` value collapsed to `[N tools]`), exit code, signal, stdout truncated to 2000 chars, stderr truncated to 2000 chars | ✅ Covered |
| #7 — Skip when prerequisites missing | 4 scenarios: `RAPTOR_SKIP_LIVE_CLAUDE=1`, `=true`, missing on PATH, predicate ordering; plus the ANTHROPIC_API_KEY-does-NOT-skip scenario | `computeSkip()` evaluates env var first then `spawnSync("claude", ["--version"], { stdio: "ignore" })` for ENOENT; `console.log` reports the matching reason; `it.skip` used so Jest reports the test as skipped, not silently passed | ✅ Covered |
| #8 — Per-test timeout set on the test case | "Per-test timeout is set on the test case, not globally" (asserts ≥30s, ≤90s, exactly 60000ms, no `jest.setTimeout`) | Third arg to `itOrSkip(...)` is `60000`; no `jest.setTimeout(...)` mutation in this file | ✅ Covered |
| #9 — Default suite participation | "Test runs in `npm test`" + "Test runs in `npm run test:integration`" | File matches `tests/**/*.test.ts` (jest.config.js testMatch) and `tests/integration/` (npm script `--testPathPattern`) — verified against repo config | ✅ Covered |
| #10 — Self-documenting | "Top-of-file comment explains why mocking is forbidden" | 46-line top-of-file comment block (lines 1–46) explicitly covering: (a) why the test is non-mocked, (b) PR #13 stdin regression with commit hash `2bd8295`, (c) Hotfix `95a1a62` permission-denial regression, (d) the AC #7 skip rules and the architect's ANTHROPIC_API_KEY-not-pre-flighted decision | ✅ Covered |

## Edge Case Coverage

All spec edge cases have explicit BDD scenarios:

- **Stdin warning surfaced via stdout (PR #13 historical surface)** — both BDD scenario AND a dedicated integration assertion (`STDIN_WARNING.test(result.stdout)`).
- **Stdin warning in stderr (belt-and-suspenders)** — explicit BDD scenario, dedicated integration assertion (`STDIN_WARNING.test(result.stderr)`).
- **Permission-denied surfaced via stdout (Hotfix `95a1a62`)** — explicit BDD scenario, dedicated integration assertion.
- **Claude API rate-limit / API error** — BDD scenario documents the no-special-casing decision; the test naturally surfaces it as a non-zero-exit failure.
- **Local `claude` newer/older than CI's** — out of scope per spec; correctly excluded.
- **`AGENT_ALLOWED_TOOLS` argv length** — BDD scenario asserts the spawn succeeds without `ENAMETOOLONG`; integration test exercises this implicitly with every run.
- **ANTHROPIC_API_KEY absence** — explicit BDD scenarios for both surfaces (does NOT pre-empt; surfaces via AC #6); architect's rationale is duplicated in the test file's top-of-file comment.

The "test takes longer than expected → push npm test time up" edge case is qualitative and correctly demo-gated; the 60s ceiling and acceptance of one real CLI call per `npm test` run is documented in the architecture, not asserted.

## NFR Coverage

- **Skipped-test latency < 100ms** — BDD scenario "Skipped test stays under 100ms latency" asserts the only I/O path is the single `spawnSync("claude", ["--version"], { stdio: "ignore" })` probe. The test's structure (skip computation in module scope, no other side effects) satisfies this NFR.

## Open Questions Resolved

- **OQ #1 — cheapest smoke prompt** — resolved to `"say ok"` per architecture §4. Captured in test (line 180).
- **OQ #2 — skip-on-missing-API-key strategy** — resolved to "do NOT pre-flight; let the CLI fail fast" per architecture §2. Captured in test top-of-file comment (lines 39–42) and BDD scenario "ANTHROPIC_API_KEY absence does NOT pre-empt the test".
- **OQ #3 — exact stderr permission-denied pattern** — resolved to broad alternation `/(permission\s+denied|tool\s+\S+\s+(?:not\s+allowed|denied|blocked))/i` per architecture §5. Captured at test line 63–64. False-positive risk acknowledged and mitigated by the `say ok` prompt's lack of tool-related vocabulary.

## Notes on Test Style

1. **Diagnostic-via-`expect` pattern.** The test uses `expect(condition ? "ok" : "marker\n${diag}").toBe("ok")` instead of `expect(condition).toBe(true)`. Unconventional, but correctly satisfies AC #6: when an assertion fails, Jest's diff output prints the `marker\n${diag}` block — including redacted argv, exit code, and truncated streams — making the failure diagnosable from CI logs alone. Approved.
2. **Module-scope skip computation.** `const skipDecision = computeSkip()` runs once at module load. This is required for the AC #7 latency NFR (skipped runs must complete under 100ms — only the `claude --version` probe is allowed). Correct pattern.
3. **Argv redaction.** The diagnostic helper collapses `--allowedTools <huge string>` to `--allowedTools [N tools]`. Keeps CI logs readable without losing information. Good call.
4. **No flakiness vectors observed** — 60s timeout, deterministic regex assertions, no model-output-content assertions (explicitly forbidden by spec Out of Scope).

## Required Production Change Acknowledged

The integration test imports `AGENT_ALLOWED_TOOLS` from `src/orchestrator/agents.ts`. That constant is currently declared `const AGENT_ALLOWED_TOOLS = [...]` (module-private) — verified at `agents.ts:31`. The test will not compile until the engineer adds `export` to the declaration.

This is **correct TDD behavior** and is **explicitly permitted** by the spec's Out of Scope:

> No production code changes except, optionally, exporting an existing constant if `spawnAgent`'s args aren't already importable from a stable public surface.

The architecture's §7 documents this as the only production change in this sprint. Engineer's Step 5 must include adding `export` to that single line and confirming `npm test` runs the new file end-to-end.

## Pre-existing Marker File

`tests/integration/live-claude-smoke-test` (extension-less marker file) exists as a workaround for the `expected-outputs-glob-resolution` and `artifact-injection-directory-handling` orchestrator bugs (deferred from Sprint 8). Not test code — Jest does not execute it. No action required from Engineer in this sprint; will be deleted alongside the bug fix.

## Out-of-Scope Items Correctly Excluded

- No additional smoke tests, parameterized matrix, or per-role smoke coverage (one test, one invocation).
- No refactor of `spawnAgent` beyond the single `export` keyword.
- No CI environment changes (installing `claude` in CI, adding `ANTHROPIC_API_KEY` secret).
- No replacement of existing mocked unit tests in `agents.test.ts` — they cover spawn-arg correctness in isolation; the smoke test adds end-to-end coverage on top.
- No snapshot or content assertions on what `claude` says.

## Decision

**Approved.** BDD scenarios and the integration test faithfully reflect every acceptance criterion, every edge case, and the skip-mode latency NFR from the spec. The Engineer may now proceed with implementation per the architecture's order of operations:

1. Add `export` to `AGENT_ALLOWED_TOOLS` in `src/orchestrator/agents.ts:31` (single keyword change).
2. Run `npm test` — confirm the new live test runs (or skips with a clear reason if `claude` isn't installed locally).
3. Run `RAPTOR_SKIP_LIVE_CLAUDE=1 npm test` — confirm the test is reported skipped and the rest of the suite still passes.
4. If `claude` is on PATH locally: confirm a real successful invocation passes all six assertions (exit 0, non-empty stdout, no stdin warning in either stream, no permission-denied marker in either stream).
5. Open PR.

No changes requested. Handoff to Engineer to follow.
