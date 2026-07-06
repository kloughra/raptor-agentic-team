import { spawn } from "child_process";
import { Role } from "./workflow";
import { HARD_CEILING_MS } from "./timeouts";

export interface AgentResult {
  output: string;
  exitCode: number;
  /**
   * CB-3 (Sprint 12): which kill path terminated the agent, if any.
   * Additive — undefined for normal exits and legacy callers.
   */
  killKind?: "idle" | "ceiling" | "buffer-overflow";
}

const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Tools the subagent is permitted to invoke. `--permission-mode acceptEdits`
 * auto-approves Read/Write/Edit; the Bash patterns explicitly enumerate the
 * shell commands the workflow needs across common engineering ecosystems
 * (git/gh, JS/TS, Python, Rust, Go, Ruby, JVM, Docker, generic build tools).
 *
 * What stays denied (the load-bearing exclusions):
 *   - Privilege escalation: sudo, su, doas
 *   - Destructive shell: rm, chmod, chown, kill, pkill, dd
 *   - Network: curl, wget, ssh, scp, rsync, nc
 *   - Cloud control planes: aws, gcloud, az, kubectl, terraform, helm
 *   - Direct DB clients: psql, mysql, sqlite3, redis-cli (DROP TABLE risk)
 *   - Anything not enumerated below
 *
 * Without this list, `claude --print` waits on the absent prompt channel for
 * each tool-permission request, the model sees the calls "complete" but the
 * filesystem effects are silently dropped, and the agent appears to do work
 * that never lands. See PR follow-up to #13.
 */
export const AGENT_ALLOWED_TOOLS = [
  // Built-in tools (auto-approved by acceptEdits but listed for explicitness)
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "TodoWrite",

  // git — full read + write surface, including history rewrite (engineers need
  // rebase/reset for cleanup; PR review provides the safety net)
  "Bash(git status)",
  "Bash(git status *)",
  "Bash(git log *)",
  "Bash(git diff *)",
  "Bash(git show *)",
  "Bash(git branch *)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git checkout *)",
  "Bash(git switch *)",
  "Bash(git push *)",
  "Bash(git pull *)",
  "Bash(git fetch *)",
  "Bash(git merge *)",
  "Bash(git rebase *)",
  "Bash(git stash *)",
  "Bash(git tag *)",
  "Bash(git reset *)",
  "Bash(git restore *)",
  "Bash(git rm *)",
  "Bash(git mv *)",
  "Bash(git rev-parse *)",
  "Bash(git remote *)",
  "Bash(git config *)",

  // GitHub CLI
  "Bash(gh pr create *)",
  "Bash(gh pr view *)",
  "Bash(gh pr merge *)",
  "Bash(gh pr comment *)",
  "Bash(gh pr list *)",
  "Bash(gh pr edit *)",
  "Bash(gh pr checkout *)",
  "Bash(gh issue create *)",
  "Bash(gh issue view *)",
  "Bash(gh issue list *)",
  "Bash(gh issue comment *)",
  "Bash(gh repo view *)",
  "Bash(gh release view *)",
  "Bash(gh release list *)",
  "Bash(gh run view *)",
  "Bash(gh run list *)",
  "Bash(gh workflow view *)",
  "Bash(gh workflow list *)",
  "Bash(gh api *)",

  // JavaScript / TypeScript
  "Bash(npm test *)",
  "Bash(npm run *)",
  "Bash(npm ci)",
  "Bash(npm install)",
  "Bash(npm install *)",
  "Bash(npm exec *)",
  "Bash(npx jest *)",
  "Bash(npx tsc *)",
  "Bash(npx vitest *)",
  "Bash(npx eslint *)",
  "Bash(npx prettier *)",
  "Bash(npx biome *)",
  "Bash(pnpm *)",
  "Bash(yarn *)",
  "Bash(bun *)",
  "Bash(bunx *)",
  "Bash(deno *)",
  "Bash(node *)",
  "Bash(tsc *)",
  "Bash(jest *)",
  "Bash(vitest *)",
  "Bash(eslint *)",
  "Bash(prettier *)",

  // Python
  "Bash(python *)",
  "Bash(python3 *)",
  "Bash(pip *)",
  "Bash(pip3 *)",
  "Bash(pipx *)",
  "Bash(poetry *)",
  "Bash(uv *)",
  "Bash(pytest *)",
  "Bash(ruff *)",
  "Bash(black *)",
  "Bash(mypy *)",
  "Bash(flake8 *)",
  "Bash(isort *)",

  // Rust
  "Bash(cargo *)",
  "Bash(rustc *)",
  "Bash(rustup *)",
  "Bash(rustfmt *)",

  // Go
  "Bash(go *)",
  "Bash(gofmt *)",
  "Bash(golangci-lint *)",

  // Ruby
  "Bash(bundle *)",
  "Bash(bundler *)",
  "Bash(gem *)",
  "Bash(rake *)",
  "Bash(rspec *)",
  "Bash(rubocop *)",

  // JVM (Maven, Gradle; project-local wrappers via ./gradlew, ./mvnw)
  "Bash(mvn *)",
  "Bash(gradle *)",
  "Bash(./gradlew *)",
  "Bash(./mvnw *)",

  // Docker (build, run, compose — for projects that ship containers)
  "Bash(docker build *)",
  "Bash(docker compose *)",
  "Bash(docker-compose *)",
  "Bash(docker run *)",
  "Bash(docker exec *)",
  "Bash(docker ps *)",
  "Bash(docker logs *)",
  "Bash(docker images *)",

  // Generic build / task runners
  "Bash(make *)",
  "Bash(cmake *)",
  "Bash(just *)",
  "Bash(task *)",

  // Read-only filesystem inspection (agents should prefer Read/Glob/Grep tools,
  // but these are common reflexes)
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(find *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(wc *)",
  "Bash(file *)",
  "Bash(stat *)",
  "Bash(pwd)",
  "Bash(which *)",
  "Bash(echo *)",
  "Bash(true)",
  "Bash(false)",
];

/**
 * Spawn a claude CLI subagent with a role-scoped system prompt and context.
 *
 * Uses `claude --print` for non-interactive output, with `acceptEdits`
 * permission mode plus an explicit Bash allowlist (see AGENT_ALLOWED_TOOLS)
 * so the subagent can actually persist its work without interactive approval.
 * The subagent runs in the project directory so it can read/write files and use git.
 */
export function spawnAgent(
  role: Role,
  systemPrompt: string,
  context: string,
  taskDescription: string,
  cwd: string,
  timeoutMs?: number
): Promise<AgentResult> {
  return new Promise((resolve) => {
    // The `--` end-of-options separator is load-bearing: claude CLI declares
    // `--allowedTools <tools...>` as a Commander variadic option, which
    // consumes every subsequent token until a `--`-prefixed flag. Today
    // `--system-prompt` follows `--allowedTools` and incidentally terminates
    // the variadic — but if the surrounding flags ever change (or are
    // omitted, as the live-claude-smoke-test case demonstrated), the prompt
    // positional gets silently absorbed as another tool name and claude
    // exits with "Input must be provided either through stdin or as a prompt
    // argument when using --print". `--` makes this robust regardless of
    // ordering: everything after it is positional.
    const args = [
      "--print",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      AGENT_ALLOWED_TOOLS.join(","),
      "--system-prompt",
      systemPrompt,
      "--append-system-prompt",
      context,
      "--",
      taskDescription,
    ];

    // stdin is "ignore" so the claude CLI sees a closed stdin and skips its
    // 3s wait-for-piped-input warning. Without this, that warning gets
    // captured as the agent's output on retries.
    const child = spawn("claude", args, {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bufferOverflow = false;
    let settled = false;

    // --- CB-3: idle timer + hard ceiling (replaces the one-shot wall-clock
    // kill). The resolved step timeout is REINTERPRETED as an idle window:
    // it resets on every stdout data chunk (the liveness signal, AC 10), so a
    // continuously streaming agent is never killed by it. The hard ceiling is
    // armed once at spawn and never reset — the sole defense against a
    // never-idle agent streaming heartbeat garbage forever (AC 12).
    const idleWindowMs = timeoutMs ?? AGENT_TIMEOUT_MS;

    const killWith = (kind: "idle" | "ceiling", message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(ceilingTimer);
      child.kill("SIGTERM");
      // Buffered output captured so far is still preferred (existing
      // behavior); the kill message is the output when the buffer is empty
      // AND is appended as a suffix line when it is not, so the signature
      // classes in failure-classification.ts always match (AC 11).
      const buffered =
        Buffer.concat(stdoutChunks).toString("utf-8") ||
        Buffer.concat(stderrChunks).toString("utf-8");
      const output = buffered ? `${buffered}\n${message}` : message;
      resolve({ output, exitCode: 1, killKind: kind });
    };

    let idleTimer: NodeJS.Timeout = setTimeout(onIdle, idleWindowMs);
    const ceilingTimer: NodeJS.Timeout = setTimeout(() => {
      killWith(
        "ceiling",
        `agent killed at hard ceiling ${HARD_CEILING_MS}ms (still streaming — absolute runtime limit)`
      );
    }, HARD_CEILING_MS);

    function onIdle(): void {
      killWith("idle", `agent idle-killed after ${idleWindowMs}ms with no stdout output`);
    }

    function resetIdleTimer(): void {
      if (settled) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, idleWindowMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      // stdout is the SOLE liveness signal (architecture constraint 9):
      // stderr does not reset the idle timer.
      resetIdleTimer();
      stdoutLen += chunk.length;
      if (stdoutLen > MAX_BUFFER_BYTES) {
        bufferOverflow = true;
        child.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen > MAX_BUFFER_BYTES) {
        bufferOverflow = true;
        child.kill("SIGTERM");
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(ceilingTimer);
      resolve({ output: err.message, exitCode: 1 });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(ceilingTimer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (bufferOverflow) {
        resolve({
          output: stdout || stderr || "agent output exceeded 10MB buffer",
          exitCode: 1,
          killKind: "buffer-overflow",
        });
        return;
      }
      if (code === 0) {
        resolve({ output: stdout, exitCode: 0 });
        return;
      }
      const output = stdout || stderr || `agent exited with code ${code}`;
      resolve({ output, exitCode: code ?? 1 });
    });
  });
}
