---
slug: live-claude-smoke-test
spec: docs/specs/live-claude-smoke-test.md
---

# Live Claude CLI Smoke Test — Architecture Design

## Overview

Add **one** non-mocked Jest integration test at `tests/integration/live-claude-smoke-test.integration.test.ts` that spawns the real `claude` CLI using the exact flag set and stdio configuration `spawnAgent` uses (`src/orchestrator/agents.ts:194–290`). The test is skip-aware so it stays inert in environments without a working `claude` binary, and asserts only the *shape* of a successful invocation — exit code, non-empty stdout, and the absence of the two regression markers (PR #13 stdin warning, Hotfix `95a1a62` permission-denied) — never model-output content.

The only production change is **exporting `AGENT_ALLOWED_TOOLS`** from `src/orchestrator/agents.ts` so the test can import the same array `spawnAgent` passes to `--allowedTools`. The spec's Out of Scope explicitly permits this ("optionally, exporting an existing constant if `spawnAgent`'s args aren't already importable from a stable public surface").

## Components

### 1. `tests/integration/live-claude-smoke-test.integration.test.ts` (new file)

Single Jest test. No new modules, no helpers extracted to `src/`. The test is self-contained for two reasons: (a) it's the only call site, and (b) co-locating the regression-detection logic with the test it gates makes the file's intent self-evident.

Top-of-file comment explains why mocking is forbidden, the two regressions (stdin warning, permission denial), and the AC #7 skip rules — satisfies AC #10.

### 2. Skip pre-flight (in the test file)

Computed once at module load via a `describe`-level guard. Three skip predicates evaluated in order:

| # | Predicate | Skip message |
|---|---|---|
| 1 | `process.env.RAPTOR_SKIP_LIVE_CLAUDE` truthy | `Skipping: RAPTOR_SKIP_LIVE_CLAUDE is set` |
| 2 | `claude` not on `PATH` (detected via `spawnSync("claude", ["--version"], { stdio: "ignore" })` returning `error.code === "ENOENT"`) | `Skipping: claude binary not found on PATH` |
| 3 | (None for `ANTHROPIC_API_KEY` — see decision below) | n/a |

Implementation uses Jest's `describe.skip` / `it.skip` (or a guarded `(skip ? it.skip : it)("...")` pattern) so skipped runs print a clearly-attributed reason to the test output — satisfies AC #7's "clearly state which prerequisite was missing" requirement.

**Decision on `ANTHROPIC_API_KEY` (Open Question 2):** **Do not pre-flight check it.** The `claude` CLI can authenticate via several mechanisms (env var, OAuth, keychain, `apiKeyHelper`); a pre-flight check on `ANTHROPIC_API_KEY` alone would skip valid setups. We let the CLI fail fast — AC #6 surfaces an auth failure as a normal test failure (non-zero exit + diagnostic stderr). This mirrors how `spawnAgent` would behave in production, which is exactly the contract the smoke test exists to validate.

### 3. Spawn invocation (in the test)

```typescript
import { spawn } from "child_process";
import { AGENT_ALLOWED_TOOLS } from "../../src/orchestrator/agents";

const args = [
  "--print",
  "--permission-mode", "acceptEdits",
  "--allowedTools", AGENT_ALLOWED_TOOLS.join(","),
  "--",
  "say ok",
];

const child = spawn("claude", args, {
  cwd: process.cwd(),
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
});
```

**Differences from `spawnAgent` and why:**

- **No `--system-prompt` / `--append-system-prompt`.** The smoke test's only job is to validate the spawn path itself. Adding role-scoped prompts would (a) increase cost per CI run, (b) couple the test to whatever role's prompt happens to be cheapest, and (c) test prompt content rather than spawn plumbing. The two regressions this test exists to catch — stdin handling and permission/allowed-tools handling — are independent of `--system-prompt`.
- **`--` end-of-options separator before the prompt positional.** The `claude` CLI declares `--allowedTools <tools...>` as a Commander variadic option, which consumes every subsequent token until it sees a `--`-prefixed flag. Production `spawnAgent` was incidentally protected by `--system-prompt` immediately following `--allowedTools` — that flag terminated the variadic. The smoke test omits `--system-prompt` (see above), so without an explicit `--` separator the prompt positional `"say ok"` would be silently absorbed by `--allowedTools` as another tool name and the CLI would exit with `Error: Input must be provided either through stdin or as a prompt argument when using --print`. Production `spawnAgent` was hardened to insert `--` before `taskDescription` (PR #18, commit 6c1a28d) so the test mirrors the same defensive boundary. This is now a permanent property of the production argv: anything intended as a positional must follow `--`, regardless of arg order or which optional flags are present.
- **Same `--print`, `--permission-mode acceptEdits`, `--allowedTools`, `stdio: ["ignore","pipe","pipe"]`.** These four are the load-bearing settings every prior regression broke. They must match exactly.
- **Direct `spawn` rather than calling `spawnAgent`.** Calling `spawnAgent` would force us to construct a full `Role` + system prompt + context, defeating the "cheapest invocation" requirement (AC #4). Importing `AGENT_ALLOWED_TOOLS` gives us the flag-set fidelity AC #2 demands without paying for unrelated machinery.

### 4. Smoke prompt choice (Open Question 1)

**Decision:** trivial `--print "say ok"` prompt.

Considered and rejected:

- **`claude --version`** — exits before processing `--permission-mode` or `--allowedTools`, so it doesn't exercise the flags that broke in Hotfix `95a1a62`. Rejected.
- **Empty prompt / `--print ""`** — likely produces empty stdout, which collides with AC #5's non-empty stdout assertion. Rejected.
- **Multi-token prompt** — wastes API budget for no additional regression coverage.

`"say ok"` is two tokens of input, expects a short text response, requires no tool use, writes nothing to disk, and forces the CLI all the way through prompt processing — which is exactly where permission-mode / allowed-tools handling lives. It is the minimum invocation that exercises the full spawn path the regressions touched.

### 5. Pass / fail assertions (AC #5–6)

```typescript
const STDIN_WARNING = /no stdin data received/i;
const PERMISSION_DENIED = /(permission\s+denied|tool\s+\S+\s+(?:not\s+allowed|denied|blocked))/i;

// Pass: code === 0
//       && stdout.trim().length > 0
//       && !STDIN_WARNING.test(stdout)
//       && !STDIN_WARNING.test(stderr)        // belt + suspenders per Edge Case
//       && !PERMISSION_DENIED.test(stderr)
//       && !PERMISSION_DENIED.test(stdout)    // Hotfix 95a1a62 surfaced in stdout too
```

**Open Question 3 — permission-denied pattern:** The `claude` CLI's denial wording is not a stable public contract, so we use a deliberately broad alternation that matches the phrases historically observed in this codebase (`permission denied`, `tool X not allowed`, `tool X denied`, `tool X blocked`). False-positive risk is mitigated by the `say ok` prompt — a successful response should contain no tool-related vocabulary at all. If the CLI's denial wording changes, the test still fails loudly (the prompt produces output that doesn't match), and the next maintainer updates the regex. Pinning a tighter regex would risk silently passing a future regression where claude rephrases its denial — the broad alternation is the safer side to err on.

On failure, the test message includes:
- The spawned argv (with `--allowedTools` value redacted to `[N tools]` to keep CI logs readable)
- Exit code
- `stdout` truncated to 2000 chars
- `stderr` truncated to 2000 chars

This makes a CI failure self-diagnosing — satisfies AC #6's "diagnosable from CI logs alone."

### 6. Timeout (AC #8)

**Per-test timeout: 60000 ms (60 seconds)**, set on the `it("...", fn, 60000)` call. Rationale:

- Default Jest 30s is the floor — too tight for a real claude invocation, especially under cold-start or first-token latency.
- 90s is the spec's ceiling — reserved for headroom, not the default.
- 60s covers observed `claude --print` "say ok" latencies (typically 5–20s) with a 3× buffer for slow networks / API congestion.
- Set on the test case itself, not via global Jest config — required by AC #8.

If 60s proves too tight in practice, the constant moves up. We do not set it lower than 60s; the cost of a flake is higher than the cost of waiting.

### 7. Production change: export `AGENT_ALLOWED_TOOLS`

`src/orchestrator/agents.ts` currently declares `AGENT_ALLOWED_TOOLS` as a module-private `const`. AC #2 requires the test to source the same constant the production code uses. Add `export` to the existing declaration:

```typescript
export const AGENT_ALLOWED_TOOLS = [ /* ... unchanged ... */ ];
```

No other production behavior changes. No refactor of `spawnAgent`. The const's content stays identical.

## Data Model

None. No new files in `~/.raptor/`, no new state shape, no schema change. The test reads only `process.env` and a non-mocked spawn result.

## API Contracts

None. This feature does not touch the MCP tool surface. `bootstrap_project`, `adopt_project`, `list_projects`, `get_project_status`, `run_sprint`, `resume_sprint` are all unchanged.

The only "contract" added is the **export** of `AGENT_ALLOWED_TOOLS` from `src/orchestrator/agents.ts`. Once exported, downstream code (currently only this test) depends on its presence — that's a stable public surface from this point on.

## Non-Functional Requirements

| NFR | Target |
|---|---|
| **Test latency (when not skipped)** | ≤ 60s per `npm test` run. Single CLI invocation per run. |
| **Test latency (when skipped)** | < 100ms — `spawnSync("claude", ["--version"])` with `stdio: "ignore"` is the only I/O. |
| **CI safety** | Test must skip cleanly (not fail) on machines without `claude` installed or without `RAPTOR_SKIP_LIVE_CLAUDE` set. AC #7 is the contract; latency NFR holds even when the CLI is missing. |
| **Cost per invocation** | One short `claude --print` call (~10–30 tokens in, ≤ 50 tokens out). One per `npm test` run. Acceptable per spec. |
| **Determinism** | The test's pass/fail decision must depend only on (exit code, stdout shape, stderr shape) — never on model wording. AC #5 already enforces this. |
| **Non-destructive** | The test must not write to the project tree, must not create branches, must not commit. AC #4 enforced by prompt choice + the lack of any `Write`-eligible task. |
| **Diagnosability on failure** | Failure message includes argv summary, exit code, truncated stdout, truncated stderr — sufficient to diagnose without re-running. |
| **Network usage** | Only what `claude --print` itself does (calls Anthropic API). No additional outbound calls from the test harness. |
| **Backward compatibility** | Exporting `AGENT_ALLOWED_TOOLS` is additive — no existing import breaks. |

## Technology Choices

**No new dependencies.** All implementation uses tools already in the codebase.

| Concern | Choice | Status |
|---|---|---|
| Subprocess spawn | `child_process.spawn` (Node built-in) | Already used by `spawnAgent` — no new dep |
| Pre-flight `claude` PATH check | `child_process.spawnSync("claude", ["--version"])` + `ENOENT` detection | Node built-in — no new dep |
| Test runner | Jest (`it.skip`, `(condition ? it.skip : it)(...)`) | Already in `devDependencies` |
| Constant import | `import { AGENT_ALLOWED_TOOLS } from "../../src/orchestrator/agents"` | Requires `export` keyword added (production change) |

**Nothing requires user approval** — no new language, framework, database, or dependency is introduced. The single production-side change (adding `export` to an existing constant) is a visibility change, not a technology adoption.

## Constraints & Patterns

- **No mocking of `child_process` in this file.** AC #3 is the entire point of the feature. A future `jest.mock("child_process", ...)` in this file silently neuters the regression coverage — the top-of-file comment must call this out (AC #10).
- **Import the constant; do not duplicate.** AC #2 explicitly requires sourcing `AGENT_ALLOWED_TOOLS` from `agents.ts`. Copying the array as a string literal is a violation, even if "easier."
- **Skip, don't fail, on missing prerequisites.** A test environment without `claude` installed is not a regression — it's a CI environment we deliberately don't gate on. AC #7 requires `it.skip` (with reason), never `expect(false).toBe(true)`.
- **Stdin must be `"ignore"`.** This is the PR #13 fix. Any deviation (e.g. `"pipe"` or `"inherit"`) re-opens the regression the test is trying to detect.
- **Exit-on-success is `code === 0`.** Don't be clever with `code !== null` or signal handling — claude exits cleanly on a successful `--print` and that's what the test asserts.
- **Assertion order matters for diagnosability.** Check exit code first (the broadest signal), then stdout shape, then regex markers. The first failed assertion's message determines what a CI log reader sees first.
- **Permission-denied regex is intentionally broad.** Open Question 3 resolved in favor of false-positive resistance over false-negative resistance — a too-tight regex that misses a regression is the worse outcome. The `say ok` prompt's response should contain none of the alternation's tokens, so false positives in practice are rare.
- **No content assertions on model output.** AC out-of-scope. Asserting `stdout.includes("ok")` would be flaky and adds no regression coverage beyond what the non-empty check already provides.
- **Test file lives in `tests/integration/`**, not `src/`, matching the convention from `tests/integration/*.integration.test.ts`. Runs in both `npm test` and `npm run test:integration` per AC #9.

## Resolved Open Questions

| Question | Resolution | Rationale |
|---|---|---|
| Cheapest smoke prompt | `--print "say ok"` | `--version` skips the regressed code paths; empty prompt collides with non-empty assertion. `say ok` is the minimum invocation that traverses permission-mode / allowed-tools / stdin handling. |
| Skip-on-missing-API-key | No pre-flight; let CLI fail | `claude` has multiple auth mechanisms; pre-checking `ANTHROPIC_API_KEY` would skip valid setups. CLI auth failure → AC #6 fail with diagnostic stderr, which is the correct production-mirroring behavior. |
| Permission-denied regex | `/(permission\s+denied\|tool\s+\S+\s+(?:not\s+allowed\|denied\|blocked))/i` against both stdout and stderr | Broad alternation matches historical denial wording. False-positive risk minimal because `say ok` response contains no tool vocabulary. Tight regex would risk silently missing a future regression where wording shifts. |

## Test Plan (informational — implementation owned by Engineer/QA)

These are the conditions the implementation must satisfy. Test code itself is QA's deliverable.

1. **Happy path:** `claude` on PATH, no skip env var, valid auth → test passes. Exit 0, non-empty stdout, no regression markers.
2. **PATH skip:** Remove `claude` from PATH (or rename binary) → test reports `Skipping: claude binary not found on PATH`, suite still passes.
3. **Env-var skip:** `RAPTOR_SKIP_LIVE_CLAUDE=1 npm test` → test reports `Skipping: RAPTOR_SKIP_LIVE_CLAUDE is set`, suite still passes.
4. **Stdin regression simulation:** If a future change reverts to `stdio: ["pipe", ...]`, the CLI's stdin warning surfaces in stdout/stderr → test fails with the regex match in its diagnostic output.
5. **Permission regression simulation:** If a future change drops `--permission-mode acceptEdits`, the CLI's denial messaging surfaces → test fails on the permission-denied regex.
6. **Timeout headroom:** Test does not flake at 60s on a normal local network.
