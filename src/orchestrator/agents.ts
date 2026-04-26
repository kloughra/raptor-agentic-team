import { spawn } from "child_process";
import { Role } from "./workflow";

export interface AgentResult {
  output: string;
  exitCode: number;
}

const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Spawn a claude CLI subagent with a role-scoped system prompt and context.
 *
 * Uses `claude --print` for non-interactive output.
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
