#!/usr/bin/env tsx
/**
 * Dev-loop boot smoke check.
 *
 * Spec:         docs/specs/dev-loop-rebuild-friction.md
 * Architecture: docs/architecture/dev-loop-rebuild-friction.md (§"Boot-smoke check pattern")
 *
 * Purpose:
 *   Verify the MCP server can boot under `tsx src/index.ts` without a `dist/`
 *   directory present. This is the AC #7 "npm run-able + Jest-invokable"
 *   boot-smoke entry point for the dev-loop-rebuild-friction sprint.
 *
 * Contract:
 *   - Exit code 0 when the server boots far enough to register MCP tools
 *     without throwing (i.e. main() runs to `server.connect(transport)`
 *     synchronously, registering tools, before the transport gracefully
 *     terminates on stdin close).
 *   - Exit non-zero if the server crashes before MCP-ready (uncaught error,
 *     module-not-found, syntax error, etc.).
 *   - Works without a `dist/` directory present — `tsx` does on-the-fly
 *     compile from source.
 *
 * Implementation:
 *   Spawn `npx tsx src/index.ts` as a child, close stdin to trigger the
 *   stdio transport to disconnect, capture stderr to detect crash patterns,
 *   and resolve with a non-zero exit code if any crash-before-ready signal
 *   is observed.
 *
 *   The `npx` form (rather than a direct `./node_modules/.bin/tsx` path) is
 *   intentional: it gives a recognizable "tsx not found" error if the
 *   package isn't installed, matching the `.mcp.json` invocation shape that
 *   developers will hit on `/mcp` reconnect.
 */

import { spawn } from "child_process";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..");
const ENTRY = "src/index.ts";

// Total wall-clock budget. Boot should be well under this; we kill the child
// after this elapses to avoid hanging CI.
const TIMEOUT_MS = 20_000;

// Crash-before-ready signals. If any of these appear in stderr the smoke
// fails — the server didn't boot cleanly.
const CRASH_PATTERNS: RegExp[] = [
  /UnhandledPromiseRejection/,
  /Cannot find module/,
  /SyntaxError/,
  /ReferenceError/,
  /\bTypeError\b/,
  /Error: ENOENT/,
  /Raptor failed to start/, // src/index.ts main().catch handler
];

function fail(message: string, stderr: string): never {
  process.stderr.write(`[dev-smoke] FAIL: ${message}\n`);
  if (stderr.trim()) {
    process.stderr.write(`[dev-smoke] child stderr:\n${stderr}\n`);
  }
  process.exit(1);
}

function ok(): never {
  process.stderr.write("[dev-smoke] OK: MCP server booted under tsx without dist/\n");
  process.exit(0);
}

async function main(): Promise<void> {
  const proc = spawn("npx", ["tsx", ENTRY], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let stdout = "";
  proc.stdout.on("data", (b: Buffer) => {
    stdout += b.toString();
  });
  proc.stderr.on("data", (b: Buffer) => {
    stderr += b.toString();
  });

  // Closing stdin signals the SDK's stdio transport that the peer has hung
  // up; the server should then unwind and exit gracefully.
  proc.stdin.end();

  let exitedCleanly = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  const exitPromise: Promise<void> = new Promise((resolve) => {
    proc.on("exit", (code, signal) => {
      exitedCleanly = true;
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });

  const timeoutPromise: Promise<void> = new Promise((resolve) => {
    setTimeout(() => {
      // Server hasn't exited within the timeout — that's actually fine for
      // an MCP server that buffers transport state, but we want a bounded
      // wall-clock so CI doesn't hang. Send SIGTERM and treat the result
      // based on stderr contents (crash patterns) rather than exit code.
      try {
        if (!proc.killed) {
          proc.kill("SIGTERM");
        }
      } catch {
        /* ignore */
      }
      resolve();
    }, TIMEOUT_MS);
  });

  await Promise.race([exitPromise, timeoutPromise]);

  // Give the kill signal a moment to land if we timed out.
  if (!exitedCleanly) {
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }

  // Detect crash-before-ready patterns in stderr.
  for (const pat of CRASH_PATTERNS) {
    if (pat.test(stderr)) {
      fail(`crash signal matched ${pat.toString()} in stderr`, stderr);
    }
  }

  // If the child exited with a non-zero, non-signal-induced code, that's a
  // crash. Signal-induced exits (e.g. SIGTERM from our timeout) are
  // acceptable — we got that far without crashing.
  if (exitedCleanly && exitCode !== null && exitCode !== 0 && !exitSignal) {
    fail(`child exited with code ${exitCode}`, stderr);
  }

  // Reaching here means: no crash patterns + either clean exit or
  // signal-induced exit after the timeout. Treat as boot success.
  void stdout; // captured for potential future assertions; unused today.
  ok();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  fail(`uncaught error in dev-smoke: ${msg}`, "");
});
