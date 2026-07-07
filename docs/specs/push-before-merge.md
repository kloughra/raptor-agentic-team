---
slug: push-before-merge
status: ready
sprint: 15
---
# Push Feature Branch Before Merge

## User Story
As a Raptor user running a sprint, when the orchestrator reaches the Merge PR step (step 9), I want it to **push the feature branch to the remote before invoking `gh pr merge`** — and to fail the merge attempt cleanly if that push fails — so that a merge can never fail on branch divergence caused by local commits (demo, retro, handoff) that were never pushed. This kills the Sprint 12 merge failure at its root cause instead of retrying a doomed merge.

## Background

**The root cause this fixes.** In Sprint 12, step 9 (`executeMerge`) failed on `gh pr merge` because the local feature branch had diverged from its remote counterpart: demo and retro commits were made locally but never pushed, so the remote PR branch was behind `HEAD`. `gh pr merge` merged (or attempted to merge) the *remote* state, which did not include the local commits, producing a divergence/merge failure. The sprint required a manual merge to complete.

`sprint-completes-despite-failed-merge` (Sprint 13, PR #29) fixed the **control flow** around a failed merge — the runner now retries in place and refuses to report `complete` while the PR is open. But it explicitly left the **root cause** out of scope (its Open Question 1): "Should `executeMerge` push the branch before `gh pr merge`? PO leans yes-as-follow-up (separate backlog item)." This spec is that follow-up.

### Architect ruling on file (Sprint 13 tech-approval, Anky)
The change is small (~10 lines) but it **changes `executeMerge` mechanics**, which were spec Out of Scope for `sprint-completes-despite-failed-merge`. It therefore needs its own spec and dedicated tests for:
- push failures (push rejected / network error → the merge attempt must fail cleanly, not proceed to a divergent merge),
- no-remote repositories (local-git fallback path — nothing to push),
- force-push hazards (the push must not clobber remote history / must be a safe non-forced push).

### Verified current behavior (2026-07-07, current `main`)
`executeMerge` (`src/orchestrator/merge.ts:134`) does **not** push before merging:
- GitHub path (`detectGitHubPR` → `mergeViaGitHub`, `merge.ts:141-159`) calls `gh pr merge --squash --delete-branch` directly against the open PR. No `git push` precedes it, so any local-only commits on the feature branch are invisible to the merge.
- Local fallback (`mergeViaLocalGit`, `merge.ts:85-127`) squash-merges the local branch into `main` locally — there is no remote in this path, so nothing to push before the merge.
- `executeMerge` is documented as "never throws" and returns a structured `MergeResult` — the push behavior must preserve that contract.

## Acceptance Criteria

1. **Push precedes GitHub merge.** On the GitHub merge path (an open PR is detected), `executeMerge` pushes the current feature branch to its remote **before** invoking `gh pr merge`. Given a feature branch with local-only commits ahead of its remote, after step 9 the remote branch contains those commits and the squash-merge includes them.

2. **Push failure fails the attempt cleanly.** If the pre-merge push fails (rejected, network error, auth failure, etc.), `executeMerge` returns `success: false` with a descriptive `error` and does **NOT** proceed to `gh pr merge`. No partial or divergent merge is attempted. The structured-result contract is preserved — `executeMerge` still never throws.

3. **Push failure feeds the existing retry/escalation loop.** A `success: false` result from a push failure is accounted for by the same step-9 retry mechanism established in `sprint-completes-despite-failed-merge` (bounded in-place retry, escalation at `MAX_RETRY_ATTEMPTS`). A push failure is a merge-attempt failure — it increments `attempts`, appends a `failures[]` record, and escalates at cap. No new escalation path is introduced.

4. **No-remote / local-fallback path unchanged.** When there is no GitHub PR and `executeMerge` falls back to `mergeViaLocalGit`, no push is attempted (there is nothing to push). This path's behavior is byte-for-byte unchanged from today.

5. **Safe push only — no force.** The pre-merge push MUST be a normal, non-forced push (no `--force`, no `--force-with-lease`). If the remote branch has commits the local branch does not (a genuine divergence the push cannot fast-forward), the push fails and AC #2 applies — the orchestrator never rewrites remote history to make a merge succeed.

6. **Already-merged PR still short-circuits.** When `detectGitHubPR` reports the PR is already `MERGED` (the manual-merge-at-demo case, `merge.ts:144-147`), `executeMerge` returns `alreadyMerged: true` success **without** attempting a push. The push only runs on the open-PR merge path.

7. **PR-closed-without-merge path unchanged.** The existing `prStatus === 0` (PR closed without merge) branch (`merge.ts:149-156`) is unchanged — no push is attempted; it still returns the existing structured failure.

8. **Error messages are actionable.** A push failure's `error` string names the failure as a push failure (distinguishable from a merge failure) so a user reading the escalation or logs can tell the difference between "the push was rejected" and "the merge was rejected."

9. **Tests exercise the production seam.** Regression tests drive the real `executeMerge` (and, where the retry accounting is asserted, the runner step-9 seam) with:
   - a feature branch with unpushed local commits → push runs, merge includes them (the Sprint 12 regression);
   - a failing push → `executeMerge` returns `success: false` and `gh pr merge` is **never** invoked (assert the merge command is not called);
   - a no-remote / local-fallback repo → no push attempted, existing behavior preserved;
   - a force-push-hazard scenario (remote ahead of local) → push fails, no forced push, attempt fails cleanly.
   Per TEAM.md QA rule 12, each constraint-guarding test carries a RED-verification note proving it FAILS against the pre-change `executeMerge` (which does no push).

10. **All git operations remain `simple-git`.** The push uses `simple-git` (consistent with the established pattern — no shelling out to `git` directly). `gh` remains only for the PR merge itself, matching the current `executeMerge` structure.

## Edge Cases
- **Local branch already in sync with remote.** The pre-merge push is a no-op (nothing to push) and succeeds; merge proceeds normally.
- **No remote configured for the feature branch** (local-only repo, GitHub path somehow reached). The push cannot resolve an upstream → treated as a push failure per AC #2 (clean fail into retry), OR handled as the local-fallback per AC #4 — the exact branch is the Architect's call, but a merge against unknown remote state must never silently proceed.
- **First push of a branch with no upstream set.** The push must set/resolve the upstream (e.g. `--set-upstream`) so the branch exists on the remote for `gh pr merge`; if the PR already exists the branch already has a remote counterpart.
- **Remote branch ahead of local (genuine divergence).** Push fails (AC #5, no force); attempt fails cleanly (AC #2); escalates at cap. The orchestrator does not resolve the divergence automatically.
- **`gh` unavailable but a remote exists.** This is the local-fallback path (AC #4) — no push, no change.
- **Push succeeds but the subsequent `gh pr merge` fails** (e.g. branch protection). The merge failure is handled exactly as today by the step-9 retry loop — the push fix does not change merge-failure handling, only prevents the divergence class of merge failure.
- **`--delete-branch` interaction.** `mergeViaGitHub` passes `--delete-branch`; the pre-merge push followed by a successful merge-and-delete must not error on the now-deleted branch. Verify the ordering (push → merge+delete) leaves no dangling failure.

## Out of Scope
- **The step-9 retry/escalation control flow itself.** That was delivered by `sprint-completes-despite-failed-merge` (Sprint 13). This spec only adds a pre-merge push inside `executeMerge`; it reuses the existing retry/escalation loop unchanged.
- **Changing the squash-merge strategy, `MAX_RETRY_ATTEMPTS`, or the `gh`-CLI-with-`simple-git`-fallback selection logic** in `executeMerge`.
- **Failure-signature classification for merge/push failures** (`merge-failure-short-circuit`, Inbox; `user-actionable-failure-class`, Sprint 15 Ready). Whether a deterministic push rejection should short-circuit before burning 3 attempts is tracked separately — this spec only requires the push runs and fails cleanly into the existing loop.
- **Auto-resolving branch divergence** (rebasing, force-pushing, merging remote into local). Explicitly forbidden by AC #5 — a genuine divergence escalates to the user.
- **Branch cleanup / remote branch deletion policy** beyond the existing `--delete-branch` flag.
- **`sprint-result-status-hardcoded-escalated`** (Inbox) and other adjacent merge-path nits — separately tracked.

## Open Questions
1. **No-remote-in-GitHub-path handling (Edge Case).** If the GitHub PR path is reached but the local branch has no resolvable upstream, does the push (a) fail cleanly into retry per AC #2, or (b) fall through to the local-git merge per AC #4? Technical decision — Architect to rule. The AC only requires that a merge never silently proceeds against unknown remote state.
2. **Upstream-setting mechanics for a branch with no upstream.** Should the push always use `--set-upstream` to the branch's own name on `origin`, or detect the existing tracking ref? Architect to specify the exact `simple-git` push invocation (Edge Case: first push of a branch).
3. **Push scope — feature branch only.** Confirm the push targets only the current feature branch's remote counterpart (never `main` / the default branch). PO's intent is feature-branch-only; Architect to confirm the `simple-git` call cannot accidentally push other refs.
