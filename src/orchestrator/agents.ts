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
 * shell commands the workflow needs (git, npm/npx, gh) and exclude the
 * destructive surface (rm, sudo, curl, ssh, kill, chmod, chown, mv).
 *
 * Without this list, `claude --print` waits on the absent prompt channel for
 * each tool-permission request, the model sees the calls "complete" but the
 * filesystem effects are silently dropped, and the agent appears to do work
 * that never lands. See PR follow-up to #13.
 */
const AGENT_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "TodoWrite",
  "Bash(git status)",
  "Bash(git status *)",
  "Bash(git log *)",
  "Bash(git diff *)",
  "Bash(git branch *)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git checkout *)",
  "Bash(git push *)",
  "Bash(git fetch *)",
  "Bash(git rev-parse *)",
  "Bash(git remote *)",
  "Bash(npm test *)",
  "Bash(npm run *)",
  "Bash(npm ci)",
  "Bash(npm install)",
  "Bash(npx jest *)",
  "Bash(npx tsc *)",
  "Bash(gh pr create *)",
  "Bash(gh pr view *)",
  "Bash(gh pr merge *)",
  "Bash(gh pr comment *)",
  "Bash(gh pr list *)",
  "Bash(gh pr edit *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(find *)",
  "Bash(pwd)",
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
