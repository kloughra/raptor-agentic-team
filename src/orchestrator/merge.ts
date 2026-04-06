import { execFile } from "child_process";
import simpleGit from "simple-git";

export interface MergeResult {
  success: boolean;
  method: "github" | "local";
  error?: string;
  alreadyMerged?: boolean;
}

const GH_TIMEOUT_MS = 30 * 1000; // 30 seconds

/**
 * Check if `gh` CLI is available and the project has a GitHub remote with an open PR.
 * Returns the PR number if found, null otherwise.
 */
async function detectGitHubPR(cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "view", "--json", "state,number", "--jq", ".number,.state"],
      { cwd, timeout: GH_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          // gh not installed, no remote, or no PR
          resolve(null);
          return;
        }

        const lines = stdout.trim().split("\n");
        if (lines.length >= 2) {
          const prNumber = parseInt(lines[0], 10);
          const state = lines[1].trim().toLowerCase();

          if (state === "open") {
            resolve(prNumber);
          } else if (state === "merged") {
            // Return negative number to signal already merged
            resolve(-prNumber);
          } else {
            // PR closed without merge
            resolve(0);
          }
        } else {
          resolve(null);
        }
      }
    );
  });
}

/**
 * Merge a PR via GitHub's `gh` CLI.
 */
async function mergeViaGitHub(
  cwd: string,
  featureSlug: string,
  sprint: number
): Promise<MergeResult> {
  return new Promise((resolve) => {
    const body = `Sprint ${sprint}: ${featureSlug}\n\nSquash-merged by Raptor orchestrator`;
    execFile(
      "gh",
      ["pr", "merge", "--squash", "--body", body, "--delete-branch"],
      { cwd, timeout: GH_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            method: "github",
            error: stderr || error.message,
          });
          return;
        }
        resolve({ success: true, method: "github" });
      }
    );
  });
}

/**
 * Merge a sprint branch locally via git squash-merge.
 */
async function mergeViaLocalGit(
  projectPath: string,
  branchName: string,
  featureSlug: string,
  sprint: number
): Promise<MergeResult> {
  const git = simpleGit(projectPath);

  try {
    // Detect default branch
    const branches = await git.branchLocal();
    const defaultBranch = branches.all.includes("main") ? "main" : branches.all[0];

    if (!defaultBranch) {
      return {
        success: false,
        method: "local",
        error: "Could not determine default branch",
      };
    }

    await git.checkout(defaultBranch);
    await git.merge(["--squash", branchName]);
    await git.commit(`Sprint ${sprint}: ${featureSlug} — squash-merge by Raptor`);

    return { success: true, method: "local" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    // Try to abort the merge if it failed mid-way
    try {
      await git.merge(["--abort"]);
    } catch {
      // Ignore abort failures
    }

    return {
      success: false,
      method: "local",
      error: msg,
    };
  }
}

/**
 * Execute a squash-merge of the sprint PR. Tries GitHub first, falls back to local git.
 *
 * Returns a structured result — never throws.
 */
export async function executeMerge(
  projectPath: string,
  featureSlug: string,
  sprint: number,
  branchName: string
): Promise<MergeResult> {
  // Try GitHub path first
  const prStatus = await detectGitHubPR(projectPath);

  if (prStatus !== null) {
    if (prStatus < 0) {
      // Already merged
      return { success: true, method: "github", alreadyMerged: true };
    }

    if (prStatus === 0) {
      // PR closed without merge — unexpected
      return {
        success: false,
        method: "github",
        error: "PR was closed without merging. This is unexpected after demo approval.",
      };
    }

    // Open PR — merge via GitHub
    return mergeViaGitHub(projectPath, featureSlug, sprint);
  }

  // No GitHub PR — fall back to local git merge
  return mergeViaLocalGit(projectPath, branchName, featureSlug, sprint);
}
