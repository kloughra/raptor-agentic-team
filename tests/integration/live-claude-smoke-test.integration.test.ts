/**
 * Live Claude CLI Smoke Test
 * ==========================
 *
 * WHY THIS TEST IS NON-MOCKED
 * ---------------------------
 * Every other test that touches `spawnAgent` mocks `child_process.spawn` at the
 * boundary (see `src/orchestrator/agents.test.ts:4–10`). Those mocked tests
 * assert *what args we pass*, not *what the real `claude` CLI does when given
 * those args*. Because of that, two production-breaking regressions shipped
 * without test coverage:
 *
 *   1. PR #13 / commit 2bd8295 — pre-fix code used `execFile()` with an open
 *      stdin pipe. The CLI waited 3s and emitted
 *      `"Warning: no stdin data received in 3s, proceeding without it"`,
 *      which the orchestrator captured as agent output and looped on. Fix:
 *      `spawn()` with `stdio: ["ignore", ...]`.
 *
 *   2. Hotfix 95a1a62 — without `--permission-mode acceptEdits` and an explicit
 *      `--allowedTools` list, every Write/Edit/Bash request silently denied
 *      while the model's conversation continued. PO retried the same spec 18+
 *      times before orchestrator timeout.
 *
 * Both bugs were invisible to the mocked test suite. This file exists to close
 * that gap: a single live invocation of the real `claude` binary using the
 * same spawn args `spawnAgent` uses, so the next stdin/permissions/flags
 * regression fails loudly inside `npm test` instead of mid-sprint.
 *
 * DO NOT MOCK `child_process` IN THIS FILE. DO NOT REPLACE THE LIVE INVOCATION
 * WITH A STUB. Doing so silently neuters the regression coverage. If this file
 * is flaky in CI, fix the flake — don't mock it.
 *
 * SKIP CONDITIONS (AC #7)
 * -----------------------
 * The test is *skipped* (not failed) when:
 *   • `process.env.RAPTOR_SKIP_LIVE_CLAUDE` is set to a truthy value, OR
 *   • the `claude` binary is not on `PATH`.
 *
 * Missing `ANTHROPIC_API_KEY` is NOT a pre-flight skip — `claude` has multiple
 * auth mechanisms (env var, OAuth, keychain, apiKeyHelper) and a pre-flight on
 * the env var alone would skip valid setups. We let the CLI fail fast and let
 * the failure surface via the standard pass/fail assertions below.
 *
 * Spec: docs/specs/live-claude-smoke-test.md
 * Architecture: docs/architecture/live-claude-smoke-test.md
 */

import { spawn, spawnSync } from "child_process";
import { AGENT_ALLOWED_TOOLS } from "../../src/orchestrator/agents";

// --- Regression markers -------------------------------------------------

/** PR #13: stdin warning text. Matched against BOTH stdout and stderr. */
const STDIN_WARNING = /no stdin data received/i;

/**
 * Hotfix 95a1a62: permission-denied wording. The `claude` CLI's denial wording
 * is not a stable public contract, so we use a deliberately broad alternation
 * matching phrases historically observed in this codebase. False-positive risk
 * is mitigated by the `say ok` prompt — a successful response should contain
 * no tool-related vocabulary at all.
 */
const PERMISSION_DENIED =
  /(permission\s+denied|tool\s+\S+\s+(?:not\s+allowed|denied|blocked))/i;

// --- Skip pre-flight ----------------------------------------------------

interface SkipDecision {
  skip: boolean;
  reason: string;
}

function computeSkip(): SkipDecision {
  // Predicate 1: opt-out env var
  if (isTruthyEnv(process.env.RAPTOR_SKIP_LIVE_CLAUDE)) {
    return { skip: true, reason: "RAPTOR_SKIP_LIVE_CLAUDE is set" };
  }

  // Predicate 2: `claude` on PATH
  // Use spawnSync with stdio: "ignore" so we don't pollute test output and so
  // an ENOENT surfaces via `result.error` rather than as text on stderr.
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore" });
  if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { skip: true, reason: "claude binary not found on PATH" };
  }

  return { skip: false, reason: "" };
}

function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const lower = v.trim().toLowerCase();
  return lower !== "" && lower !== "0" && lower !== "false" && lower !== "no";
}

// --- Diagnostic helpers -------------------------------------------------

const DIAG_TRUNC = 2000;

function truncate(s: string, max: number = DIAG_TRUNC): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [truncated, ${s.length - max} more chars]`;
}

function redactArgv(args: string[]): string[] {
  // Replace the --allowedTools value (very long) with a count, so CI logs stay
  // readable. Everything else stays intact for diagnosability.
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allowedTools" && i + 1 < args.length) {
      const tools = args[i + 1];
      const count = tools.split(",").filter(Boolean).length;
      out.push(args[i], `[${count} tools]`);
      i++; // skip the value
    } else {
      out.push(args[i]);
    }
  }
  return out;
}

interface SpawnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runClaudeOnce(args: string[]): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: process.cwd(),
      env: { ...process.env },
      // PR #13 fix: stdin must be "ignore" — anything else risks the CLI's
      // 3-second stdin-warning timeout surfacing as agent output.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      resolve({ exitCode: code, signal, stdout, stderr });
    });
  });
}

// --- The single test case ----------------------------------------------

const skipDecision = computeSkip();
const itOrSkip = skipDecision.skip ? it.skip : it;

describe("live claude CLI smoke test", () => {
  if (skipDecision.skip) {
    // eslint-disable-next-line no-console
    console.log(`[live-claude-smoke-test] Skipping: ${skipDecision.reason}`);
  }

  itOrSkip(
    "spawns the real claude binary with production spawn args and returns a clean response",
    async () => {
      // Build the exact spawn args spawnAgent uses — same flag set, same order
      // semantics for the load-bearing flags. Sourcing AGENT_ALLOWED_TOOLS from
      // the production module (not duplicating it here) is required by AC #2:
      // a future refactor of the allowed-tools list keeps this test honest.
      const args = [
        "--print",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        AGENT_ALLOWED_TOOLS.join(","),
        "--",
        "say ok",
      ];

      const result = await runClaudeOnce(args);

      // Build a single diagnostic block re-used by every failure assertion so
      // the first failed expect() makes the regression diagnosable from CI
      // logs alone (AC #6).
      const diag = [
        `argv: claude ${redactArgv(args).join(" ")}`,
        `exit: code=${result.exitCode} signal=${result.signal ?? "null"}`,
        `stdout (${result.stdout.length} chars):`,
        truncate(result.stdout),
        `stderr (${result.stderr.length} chars):`,
        truncate(result.stderr),
      ].join("\n");

      // 1. Exit code: must be 0. This is the broadest signal of success.
      expect(result.exitCode === 0 ? "ok" : `non-zero-exit\n${diag}`).toBe("ok");

      // 2. Stdout shape: non-empty after trim.
      expect(
        result.stdout.trim().length > 0 ? "ok" : `empty-stdout\n${diag}`
      ).toBe("ok");

      // 3. PR #13 regression marker: stdin warning must NOT appear in stdout.
      expect(
        STDIN_WARNING.test(result.stdout)
          ? `stdin-warning-in-stdout\n${diag}`
          : "ok"
      ).toBe("ok");

      // 3b. Belt-and-suspenders per the spec's Edge Case: also check stderr.
      expect(
        STDIN_WARNING.test(result.stderr)
          ? `stdin-warning-in-stderr\n${diag}`
          : "ok"
      ).toBe("ok");

      // 4. Hotfix 95a1a62 marker: permission-denied wording must NOT appear
      // in stderr.
      expect(
        PERMISSION_DENIED.test(result.stderr)
          ? `permission-denied-in-stderr\n${diag}`
          : "ok"
      ).toBe("ok");

      // 4b. Same marker in stdout — the original hotfix manifested with the
      // denial surfacing in stdout for some tool calls.
      expect(
        PERMISSION_DENIED.test(result.stdout)
          ? `permission-denied-in-stdout\n${diag}`
          : "ok"
      ).toBe("ok");
    },
    // Per-test timeout: 60s. Default Jest 30s is too tight for a real claude
    // invocation (see architecture §6 — Timeout). Set on the it() call itself,
    // not via global Jest config (AC #8).
    60000
  );
});
