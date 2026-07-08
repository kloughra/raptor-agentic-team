import { execFile } from "child_process";
import simpleGit from "simple-git";
import { DodChecklist } from "./state";

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
 *
 * push-before-merge (Sprint 15, C1): before invoking `gh pr merge`, push the
 * feature branch to its remote counterpart so the squash-merge includes any
 * local-only commits (demo/retro/handoff) that would otherwise be invisible to
 * the merge — the Sprint 12 root-cause divergence. The push is a normal,
 * NON-forced push of exactly one refspec (`origin <branchName>`):
 *   - No --force / --force-with-lease — a genuine divergence fails the push and
 *     escalates; remote history is never rewritten (AC #5).
 *   - Explicit remote + single positional refspec — never --all/--tags/--mirror,
 *     so `main`/the default branch can never be pushed by this call (AC #10/OQ3),
 *     and it is upstream-agnostic (works whether or not tracking is configured,
 *     OQ2/C2).
 * A push failure returns a structured `success: false` with a push-named error
 * and does NOT proceed to `gh pr merge` (AC #2, #8, #9); `executeMerge` still
 * never throws. This function is only reached on the open-PR path, so
 * already-merged / PR-closed / local-fallback paths never push (AC #4/#6/#7).
 */
async function mergeViaGitHub(
  cwd: string,
  featureSlug: string,
  sprint: number,
  branchName: string
): Promise<MergeResult> {
  // C1: pre-merge push (never-forced, single refspec). Wrapped so executeMerge
  // never throws (AC #2). On failure, return before touching `gh pr merge`.
  try {
    await simpleGit(cwd).push(["origin", branchName]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      method: "github",
      error: `Pre-merge push of branch '${branchName}' failed: ${msg}`,
    };
  }

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

    // Open PR — merge via GitHub (pre-merge push runs at the head of mergeViaGitHub)
    return mergeViaGitHub(projectPath, featureSlug, sprint, branchName);
  }

  // No GitHub PR — fall back to local git merge
  return mergeViaLocalGit(projectPath, branchName, featureSlug, sprint);
}

/**
 * Update the PR description to check all DoD items.
 * Returns true if successful, false if gh is unavailable or update fails.
 */
export async function updatePrDodChecklist(
  cwd: string,
  dod: DodChecklist
): Promise<boolean> {
  return new Promise((resolve) => {
    // First, get the current PR body
    execFile(
      "gh",
      ["pr", "view", "--json", "body", "--jq", ".body"],
      { cwd, timeout: GH_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }

        let body = stdout.trim();
        if (!body) {
          resolve(false);
          return;
        }

        // Replace DoD checklist items — match flexibly with regex
        const dodReplacements: Array<{ flag: boolean; pattern: RegExp; checked: string }> = [
          { flag: dod.testsPass, pattern: /- \[ \] (All tests pass[^\n]*)/g, checked: "- [x] $1" },
          { flag: dod.codeCommitted, pattern: /- \[ \] (Code committed[^\n]*)/g, checked: "- [x] $1" },
          { flag: dod.prReviewApproved, pattern: /- \[ \] (Peer review[^\n]*)/g, checked: "- [x] $1" },
          { flag: dod.poAccepted, pattern: /- \[ \] (PO accepted[^\n]*)/g, checked: "- [x] $1" },
          { flag: dod.demoCompleted, pattern: /- \[ \] (Demo[^\n]*)/g, checked: "- [x] $1" },
        ];

        for (const { flag, pattern, checked } of dodReplacements) {
          if (flag) body = body.replace(pattern, checked);
        }

        // Update the PR
        execFile(
          "gh",
          ["pr", "edit", "--body", body],
          { cwd, timeout: GH_TIMEOUT_MS },
          (editError) => {
            resolve(!editError);
          }
        );
      }
    );
  });
}

/**
 * Generate a DoD summary string for merge commit messages (fallback when gh unavailable).
 */
export function generateDodSummary(dod: DodChecklist): string {
  const items = [
    { label: "Tests pass", value: dod.testsPass },
    { label: "Code committed", value: dod.codeCommitted },
    { label: "Peer review approved", value: dod.prReviewApproved },
    { label: "PO accepted", value: dod.poAccepted },
    { label: "Demo completed", value: dod.demoCompleted },
  ];

  return items.map((i) => `${i.value ? "✅" : "❌"} ${i.label}`).join("\n");
}
