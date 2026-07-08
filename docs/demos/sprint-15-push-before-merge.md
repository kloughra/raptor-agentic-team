# Sprint 15 Demo — push-before-merge

**Presenter:** Brax (Team) 🦕
**Feature:** push-before-merge
**Branch:** sprint-15/push-before-merge
**Date:** 2026-07-07

---

## 1. Sprint Goal & Acceptance Criteria

**Goal:** On the Merge PR step (step 9), push the feature branch to its remote
*before* invoking `gh pr merge`, and fail the attempt cleanly if that push
fails — killing the Sprint 12 merge-failure at its root cause (branch divergence
from local-only demo/retro/handoff commits that were never pushed) instead of
retrying a doomed merge.

Root cause it retires: Sprint 12 PR #27 — local demo/retro commits were never
pushed, so `gh pr merge` merged the stale *remote* state and failed on
divergence, forcing a manual merge.

**Acceptance criteria (10):**
1. Push precedes the GitHub merge (unpushed local commits reach the remote first).
2. Push failure ⇒ `success: false`, `gh pr merge` never invoked, never throws.
3. Push failure feeds the existing step-9 retry/escalation loop (no new path).
4. No-remote / local-fallback path byte-for-byte unchanged.
5. Safe push only — no `--force`, no `--force-with-lease`; genuine divergence escalates.
6. Already-merged PR still short-circuits without pushing.
7. PR-closed-without-merge path unchanged.
8. Error messages name it a *push* failure and the branch (distinct from merge failure).
9. Tests drive the real `executeMerge` / runner seam, each with a RED-verification note.
10. Push uses `simple-git` (`gh` only for the merge itself).

## 2. Feature Demonstration

Single insertion point — the head of `mergeViaGitHub` (`src/orchestrator/merge.ts:78-89`),
reached *only* on the open-PR path:

```ts
try {
  await simpleGit(cwd).push(["origin", branchName]);   // non-forced, single refspec
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    success: false,
    method: "github",
    error: `Pre-merge push of branch '${branchName}' failed: ${msg}`,
  };
}
// ... existing `gh pr merge --squash --delete-branch` — unreachable if the push failed
```

Design guarantees, structurally enforced:
- **Push only on the open-PR path** — it lives in `mergeViaGitHub`, which the
  already-merged (`prStatus < 0`), PR-closed (`prStatus === 0`), and local-fallback
  branches never reach (`executeMerge` dispatch, `merge.ts:170-194`).
- **Safe push only** — `git.push(["origin", branchName])`: one explicit refspec,
  never `--force`/`--all`/`--tags`. `main` can never be pushed by this call; remote
  history is never rewritten.
- **Never proceed after a failed push** — the `gh pr merge` execFile sits *after*
  the try/catch that `return`s on failure, so it is unreachable on push failure.
- **Never throws** — the push is wrapped; failure becomes a structured `MergeResult`.
- **No schema change** — a push failure rides the existing `success`/`method`/`error`
  fields; the step-9 retry loop consumes it unchanged.

## 3. Test Execution (live)

`npx jest` (full suite: unit + integration) — run live at demo:

```
Test Suites: 46 passed, 46 total
Tests:       795 passed, 795 total
Snapshots:   0 total
Time:        ~15 s
```

`tests/integration/push-before-merge.integration.test.ts` — 10 passed (6.5s).

## 4. Test Results Summary

- **795/795 green** (+15 over Sprint 14's 780; +2 suites for the new integration + BDD coverage).
- **0 failures, 0 defects filed.**
- Every constraint-guarding test drives the **real** `executeMerge` against **real**
  git repos with **real** bare remotes via `simple-git`. Mocking is confined to
  `child_process.execFile` (the `gh` CLI) and — for the runner-seam test only —
  `spawnAgent`. `executeMerge` is never mocked; it is the system under test.

| AC | Scenario | RED note |
|----|----------|----------|
| #1, #10 | Local-only commits pushed before `gh pr merge` (the Sprint 12 regression) | [RED:A] |
| edge | Already-in-sync branch pushes as no-op, merges normally | no-regression |
| #2, #8, #9 | Failing push ⇒ `success:false`, `gh pr merge` never invoked | [RED:B] |
| #8 | Push-failure error names "push" and the branch | [RED:B] |
| #2 | Never-throws contract on push failure | no-regression |
| #5 | Remote-ahead divergence fails cleanly, no force, history intact | [RED:C] |
| #4 | No-GitHub-PR ⇒ local fallback, no push | no-regression |
| #6 | Already-merged PR short-circuits without pushing | no-regression |
| #7 | Closed-without-merge PR returns failure without pushing | no-regression |
| #3 | Push failure feeds step-9 retry loop; escalates at `MAX_RETRY_ATTEMPTS`, never merging, never running shared steps | [RED:S] |

**Edge cases covered:** already-in-sync no-op push; remote-ahead genuine
divergence (no force); non-open-PR paths never push; push→merge→`--delete-branch`
ordering leaves no dangling failure.

**RED-verification (TEAM.md QA rule 12):** each constraint-guarding test carries an
in-file note proving it FAILS against pre-change `executeMerge` (which does no
push). Playwright E2E = N/A (no UI surface); no numeric NFR ⇒ no performance
threshold test — both recorded, not silently skipped.

**Regression status:** no regressions. The Sprint 12/13/14 merge lineage
(`merge.test.ts`, `sprint-completes-despite-failed-merge.test.ts`,
`progress-aware-circuit-breaker`, `adversarial-verifier-review-gate`) all green.

## 5. Notable Decision to Flag

This is the **first place Raptor writes to a remote** (`git push`). It cannot touch
`main` (single explicit refspec) and cannot rewrite history (non-forced) — but it
does mean step 9 now performs a network write to `origin` on the feature branch.
Architecture flagged this for user awareness (design §"Technology Choices").
