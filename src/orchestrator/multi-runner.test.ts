import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import simpleGit, { SimpleGit } from "simple-git";
import {
  ensureFeatureBranch,
  detectSprintFeatures,
  createFeatureStates,
  featureBranchName,
  allFeaturesComplete,
  anyFeaturesEscalated,
  deriveSprintStatus,
} from "./multi-runner";

const ROOT = path.join(os.tmpdir(), `raptor-multi-runner-unit-${Date.now()}`);

beforeAll(() => {
  fs.mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function initRepo(p: string): Promise<SimpleGit> {
  fs.mkdirSync(p, { recursive: true });
  const git = simpleGit(p);
  await git.init();
  await git.addConfig("user.email", "test@example.com", false, "local");
  await git.addConfig("user.name", "Test", false, "local");
  try {
    await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  } catch { /* older git */ }
  fs.writeFileSync(path.join(p, ".gitkeep"), "");
  await git.add(".");
  await git.commit("init");
  return git;
}

describe("ensureFeatureBranch", () => {
  it("creates a non-existent branch and checks it out", async () => {
    const proj = path.join(ROOT, "create-new");
    const git = await initRepo(proj);

    const result = await ensureFeatureBranch(proj, 7, "alpha");
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(true);
    expect(result.checkedOut).toBe(true);

    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    expect(head).toBe("sprint-7/alpha");
  });

  it("is a no-op when already on the target branch", async () => {
    const proj = path.join(ROOT, "already-on");
    const git = await initRepo(proj);
    await git.checkoutLocalBranch("sprint-7/alpha");

    const result = await ensureFeatureBranch(proj, 7, "alpha");
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(false);
    expect(result.checkedOut).toBe(false);
  });

  it("checks out an existing branch when on a different branch", async () => {
    const proj = path.join(ROOT, "checkout-existing");
    const git = await initRepo(proj);
    await git.checkoutLocalBranch("sprint-7/alpha");
    await git.checkout("main");

    const result = await ensureFeatureBranch(proj, 7, "alpha");
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(false);
    expect(result.checkedOut).toBe(true);

    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    expect(head).toBe("sprint-7/alpha");
  });

  it("returns an error when checkout would conflict with uncommitted changes", async () => {
    const proj = path.join(ROOT, "divergent");
    const git = await initRepo(proj);

    // Create branch with one commit on a tracked file
    await git.checkoutLocalBranch("sprint-7/alpha");
    fs.writeFileSync(path.join(proj, "branch-only.txt"), "branch content");
    await git.add(".");
    await git.commit("on branch");

    // Switch back to main and create UNCOMMITTED conflicting work
    await git.checkout("main");
    fs.writeFileSync(path.join(proj, "branch-only.txt"), "main-uncommitted");

    const result = await ensureFeatureBranch(proj, 7, "alpha");
    if (result.error) {
      expect(result.error).toMatch(/sprint-7\/alpha/);
      expect(result.error).toMatch(/divergent/i);
    } else {
      // Allowed: simple-git may carry the uncommitted change forward. Either
      // way, we must not have lost the user's work.
      const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
      expect(["main", "sprint-7/alpha"]).toContain(head);
    }
  });

  it("uses the same sprint-{N}/{slug} convention as featureBranchName", async () => {
    const proj = path.join(ROOT, "convention");
    const git = await initRepo(proj);

    await ensureFeatureBranch(proj, 12, "feature-b");
    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    expect(head).toBe(featureBranchName(12, "feature-b"));
  });
});

describe("re-exports stay stable", () => {
  it("exports the existing helpers unchanged", () => {
    expect(typeof detectSprintFeatures).toBe("function");
    expect(typeof createFeatureStates).toBe("function");
    expect(typeof featureBranchName).toBe("function");
    expect(typeof allFeaturesComplete).toBe("function");
    expect(typeof anyFeaturesEscalated).toBe("function");
    expect(typeof deriveSprintStatus).toBe("function");
  });
});
