/**
 * Unit tests — push-before-merge (Sprint 15)
 *
 * Spec:         docs/specs/push-before-merge.md (AC 1–10)
 * Architecture: docs/architecture/push-before-merge.md (C1–C4)
 *
 * These colocated unit tests drive the REAL `executeMerge` against REAL, small
 * git repositories with REAL bare remotes over simple-git. The ONLY thing
 * mocked is `child_process.execFile` — the `gh` CLI (PR detection + `gh pr
 * merge`) — via a PARTIAL mock that leaves `child_process.spawn` untouched, so
 * simple-git (which shells git through `spawn`) performs REAL pushes/merges.
 * Do NOT widen this mock to `spawn`/`simple-git`: the real push IS the feature
 * under test (TEAM.md QA rule 12).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RED-VERIFICATION NOTES (TEAM.md QA rule 12 — proven to FAIL pre-change)
 * ─────────────────────────────────────────────────────────────────────────
 * The pre-change `executeMerge` did NOT push before `gh pr merge`. Each
 * constraint-guarding test below was proven RED by running it against `main`
 * before implementing C1 (the pre-merge push in `mergeViaGitHub`):
 *   - "pushes local-only commits before merge": pre-change never pushes, so the
 *     remote head stays at c1 while local is at c2 → the remote-contains-c2
 *     assertion FAILS.
 *   - "push failure → no merge + push-named error": pre-change never pushes and
 *     the (mock-succeeding) `gh pr merge` runs → success:true and a merge
 *     invocation recorded → the success:false / merge-never-invoked / error
 *     contains "push" assertions FAIL.
 * The AC #4/#6/#7 "no-push" tests are no-regression: they pass both before and
 * after the change (the non-open-PR paths never push).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

// PARTIAL mock: replace execFile (gh), pass spawn (simple-git) through untouched.
jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process") as Record<string, unknown>;
  return { ...actual, execFile: jest.fn() };
});

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import simpleGit, { SimpleGit } from "simple-git";

import { executeMerge } from "./merge";
import { featureBranchName } from "./multi-runner";

const execFileMock = execFile as unknown as jest.Mock;

const SPRINT = 1;
const SLUG = "widget-export";
const BRANCH = featureBranchName(SPRINT, SLUG);

let ghMergeInvocations: string[][] = [];

/** Configure the mocked `gh` CLI. prView is the "<num>\n<state>" stdout, or null. */
function configureGh(opts: { prView: string | null; mergeError?: string }): void {
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const file = callArgs[0] as string;
    const args = callArgs[1] as string[];
    const callback = callArgs[3] as (
      err: Error | null,
      stdout: string,
      stderr: string
    ) => void;

    if (file === "gh" && args[0] === "pr" && args[1] === "view") {
      const jsonIdx = args.indexOf("--json");
      const fields = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
      if (fields.includes("body")) {
        callback(null, "", "");
        return undefined;
      }
      if (opts.prView === null) {
        callback(new Error("no pull requests found"), "", "no pull requests found");
        return undefined;
      }
      callback(null, opts.prView, "");
      return undefined;
    }
    if (file === "gh" && args[0] === "pr" && args[1] === "merge") {
      ghMergeInvocations.push(args);
      if (opts.mergeError) {
        callback(new Error("merge failed"), "", opts.mergeError);
      } else {
        callback(null, "Merged", "");
      }
      return undefined;
    }
    callback(new Error(`unexpected execFile call: ${file} ${JSON.stringify(args)}`), "", "");
    return undefined;
  });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-merge-unit-"));
  ghMergeInvocations = [];
  execFileMock.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function configureUser(git: SimpleGit): Promise<void> {
  await git.addConfig("user.name", "Trix Triceratops");
  await git.addConfig("user.email", "trix@raptor.test");
}

async function makeBareRemote(name: string): Promise<string> {
  const bare = path.join(tmpDir, `${name}.git`);
  fs.mkdirSync(bare, { recursive: true });
  await simpleGit(bare).init(["--bare"]);
  return bare;
}

async function makeProject(name: string): Promise<{ projectPath: string; git: SimpleGit }> {
  const projectPath = path.join(tmpDir, name);
  fs.mkdirSync(projectPath, { recursive: true });
  const git = simpleGit(projectPath);
  await git.init();
  await configureUser(git);
  fs.writeFileSync(path.join(projectPath, "README.md"), "# test\n");
  await git.add(".");
  await git.commit("initial commit");
  await git.raw(["branch", "-M", "main"]);
  return { projectPath, git };
}

async function commitFile(
  git: SimpleGit,
  projectPath: string,
  file: string,
  content: string,
  message: string
): Promise<string> {
  const full = path.join(projectPath, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  await git.add(file);
  await git.commit(message);
  return (await git.revparse(["HEAD"])).trim();
}

async function refSha(repoPath: string, ref: string): Promise<string | null> {
  try {
    return (await simpleGit(repoPath).revparse([ref])).trim();
  } catch {
    return null;
  }
}

describe("executeMerge pre-merge push (AC #1, #2, #8)", () => {
  it("pushes local-only commits to the remote before invoking gh pr merge", async () => {
    const remote = await makeBareRemote("u-remote");
    const { projectPath, git } = await makeProject("u-proj");
    await git.addRemote("origin", remote);
    await git.checkoutLocalBranch(BRANCH);
    const c1 = await commitFile(git, projectPath, "docs/specs/a.md", "c1\n", "[ENGINEER] c1");
    await git.push(["origin", BRANCH]);
    expect(await refSha(remote, BRANCH)).toBe(c1);

    // Local-only commit that never reached the remote (the Sprint 12 specimen).
    const c2 = await commitFile(git, projectPath, "docs/demo.md", "c2\n", "[TEAM] demo");
    expect(await refSha(remote, BRANCH)).toBe(c1);

    configureGh({ prView: "7\nopen" });

    const result = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    expect(result.success).toBe(true);
    expect(result.method).toBe("github");
    expect(await refSha(remote, BRANCH)).toBe(c2); // remote now has the local commit
    expect(ghMergeInvocations).toHaveLength(1); // merged once, after the push
  });

  it("fails cleanly with a push-named error and never merges when the push fails", async () => {
    const { projectPath, git } = await makeProject("u-fail");
    await git.checkoutLocalBranch(BRANCH);
    await commitFile(git, projectPath, "docs/specs/b.md", "b\n", "[ENGINEER] b");
    await git.addRemote("origin", path.join(tmpDir, "does-not-exist.git"));

    configureGh({ prView: "7\nopen" });

    const result = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    expect(result.success).toBe(false);
    expect(result.method).toBe("github");
    expect(result.error!.toLowerCase()).toContain("push"); // distinguishable (AC #8)
    expect(result.error).toContain(BRANCH); // names the branch (AC #8)
    expect(ghMergeInvocations).toHaveLength(0); // never merged (AC #2)
  });

  it("does not throw when the push fails (never-throws contract, AC #2)", async () => {
    const { projectPath, git } = await makeProject("u-throw");
    await git.checkoutLocalBranch(BRANCH);
    await commitFile(git, projectPath, "docs/specs/b.md", "b\n", "[ENGINEER] b");
    await git.addRemote("origin", path.join(tmpDir, "nope.git"));

    configureGh({ prView: "7\nopen" });

    await expect(executeMerge(projectPath, SLUG, SPRINT, BRANCH)).resolves.toMatchObject({
      success: false,
      method: "github",
    });
  });
});

describe("non-open-PR paths never push (AC #4, #6, #7) [no-regression]", () => {
  it("already-merged PR short-circuits without pushing", async () => {
    const remote = await makeBareRemote("u-merged");
    const { projectPath, git } = await makeProject("u-mproj");
    await git.addRemote("origin", remote);
    await git.checkoutLocalBranch(BRANCH);
    await commitFile(git, projectPath, "docs/specs/e.md", "e\n", "[ENGINEER] e");

    configureGh({ prView: "7\nmerged" });

    const result = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    expect(result.success).toBe(true);
    expect(result.alreadyMerged).toBe(true);
    expect(ghMergeInvocations).toHaveLength(0);
    expect(await refSha(remote, BRANCH)).toBeNull(); // never pushed
  });

  it("no-GitHub-PR falls back to local merge and attempts no push", async () => {
    const remote = await makeBareRemote("u-local");
    const { projectPath, git } = await makeProject("u-lproj");
    await git.addRemote("origin", remote);
    await git.checkoutLocalBranch(BRANCH);
    await commitFile(git, projectPath, "docs/specs/d.md", "d\n", "[ENGINEER] d");

    configureGh({ prView: null });

    const result = await executeMerge(projectPath, SLUG, SPRINT, BRANCH);

    expect(result.success).toBe(true);
    expect(result.method).toBe("local");
    expect(ghMergeInvocations).toHaveLength(0);
    expect(await refSha(remote, BRANCH)).toBeNull(); // never pushed
  });
});
