import { execFile } from "child_process";
import { Role } from "./workflow";

export interface AgentResult {
  output: string;
  exitCode: number;
}

const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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
  cwd: string
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

    execFile(
      "claude",
      args,
      {
        cwd,
        timeout: AGENT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          // Timeout or other execution error
          const output = stdout || stderr || error.message;
          resolve({
            output: typeof output === "string" ? output : String(output),
            exitCode: error.code ? Number(error.code) : 1,
          });
          return;
        }

        resolve({
          output: typeof stdout === "string" ? stdout : String(stdout),
          exitCode: 0,
        });
      }
    );
  });
}
