import { spawn } from "child_process";
import { Role } from "./workflow";

export interface AgentResult {
  output: string;
  exitCode: number;
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

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const output = Buffer.concat(stdoutChunks).toString("utf-8")
        || Buffer.concat(stderrChunks).toString("utf-8")
        || `agent timed out after ${timeoutMs ?? AGENT_TIMEOUT_MS}ms`;
      resolve({ output, exitCode: 1 });
    }, timeoutMs ?? AGENT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
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
      clearTimeout(timeout);
      resolve({ output: err.message, exitCode: 1 });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (bufferOverflow) {
        resolve({
          output: stdout || stderr || "agent output exceeded 10MB buffer",
          exitCode: 1,
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
