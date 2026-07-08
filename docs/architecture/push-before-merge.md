---
slug: push-before-merge
spec: docs/specs/push-before-merge.md
---
# Push Feature Branch Before Merge — Architecture Design

## Overview

Step 9 (Merge PR) is orchestrator-managed. Its mechanics live entirely in `executeMerge` (`src/orchestrator/merge.ts:134`), which today tries the GitHub path first (`detectGitHubPR` → `mergeViaGitHub`, `merge.ts:141-159`) and falls back to a local squash-merge (`mergeViaLocalGit`, `merge.ts:85-127`). On the GitHub path it invokes `gh pr merge --squash --delete-branch` **directly against the open PR** — merging the *remote* state of the branch. Local-only commits (demo, retro, handoff) that were never pushed are invisible to that merge, so the branch has diverged from its remote counterpart and the merge fails (or merges a stale tree). This is the Sprint 12 root-cause incident.

This design inserts a single **pre-merge push** into `executeMerge`'s open-PR branch: push the current feature branch to its remote via `simple-git` **before** calling `gh pr merge`; if the push fails, return `success: false` with a push-specific error and do **not** attempt the merge. The push is a normal, non-forced push of exactly one refspec (the feature branch). Every other path — already-merged short-circuit, PR-closed-without-merge, and the whole local-git fallback — is byte-for-byte unchanged.

**Design invariant (one-sentence contract):** *On the open-PR merge path, `gh pr merge` runs only after the feature branch's local commits have been successfully pushed to its remote counterpart with a safe (non-forced), single-refspec push; a push failure fails the merge attempt cleanly (`success: false`, never throws) and never proceeds to `gh pr merge`.*

All source citations re-verified against current `main` on 2026-07-07.

## Components

### C1. Pre-merge push in `mergeViaGitHub` (AC #1, #2, #5, #8, #10)

The push is added at the **top of the open-PR merge path**, not in the dispatcher. Placement options were (a) in `executeMerge` before the `mergeViaGitHub` call, or (b) at the head of `mergeViaGitHub`. **Ruling: (b)** — the push belongs to the GitHub merge mechanic and must be skipped on every non-open-PR path (already-merged, PR-closed, local-fallback). Putting it inside `mergeViaGitHub` — which is *only* reached from the open-PR branch (`merge.ts:158-159`) — makes "push only on the open-PR path" structurally true rather than a condition that could rot. `executeMerge`'s dispatch (`merge.ts:143-163`) is unchanged.

```
// at the head of mergeViaGitHub, before the gh pr merge execFile:
const git = simpleGit(cwd);
try {
  // AC #5 / OQ2 / OQ3: explicit remote + single refspec = the feature branch only.
  // No --force / --force-with-lease; no --all / --tags; never the default branch.
  await git.push(["origin", branchName]);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    success: false,
    method: "github",
    error: `Pre-merge push of branch '${branchName}' failed: ${msg}`, // AC #8
  };
}
// ... existing gh pr merge --squash --delete-branch execFile, unchanged ...
```

`mergeViaGitHub`'s signature gains `branchName` (already threaded to `executeMerge` from `state.branchName`, `runner.ts:922` / `feature.branchName`, `runner.ts:2439`), so the call site at `merge.ts:159` passes it through — a one-parameter internal change, no MCP surface impact.

**Why `git.push(["origin", <branchName>])` and not a bare `git.push()`:**
- **OQ2 (upstream mechanics) ruling:** name the remote (`origin`) and the branch explicitly. A bare `git.push()` relies on the branch's tracking config and `push.default`, which is unset for branches created via `checkoutLocalBranch` (`multi-runner.ts:189` — no upstream is configured at creation). An explicit `origin <branch>` refspec pushes the local `<branch>` to `refs/heads/<branch>` on `origin` regardless of tracking state.
- **OQ3 (push scope) ruling — confirmed feature-branch-only:** a single positional refspec (`branchName`) can push exactly one ref. There is no `--all`, `--tags`, `--mirror`, or bare-push-to-configured-refspecs path here, so the default branch (`main`) can never be pushed by this call. Confirmed safe.
- **OQ1 (no-remote-in-GitHub-path) ruling — fail cleanly into retry (spec option a):** `mergeViaGitHub` is reached only when `detectGitHubPR` returned a positive PR number, which means `gh pr view` succeeded against a real remote and an **open** PR — so a remote (and the PR's branch counterpart) exists. If the push nonetheless cannot resolve `origin` or is rejected, that is an anomaly, and per AC #2 the attempt fails cleanly (`success: false`) into the existing step-9 retry loop. We do **not** fall through to `mergeViaLocalGit` — a merge must never silently proceed against unknown remote state (spec Edge Case).

### C2. `--set-upstream` handling (Edge Case: first push of a branch with no upstream)

The explicit `origin <branchName>` refspec **is** the upstream-agnostic form: it pushes the branch by name whether or not a tracking ref is configured, and creates `origin/<branchName>` if it does not yet exist. Because `mergeViaGitHub` only runs when an open PR already exists, the remote branch counterpart is already present in practice, so this is a fast-forward. We deliberately do **not** pass `-u` / `--set-upstream`: setting tracking config is a side effect with no value here (the branch is deleted by `--delete-branch` seconds later), and the explicit refspec already handles the no-upstream case. If a future non-PR caller needs upstream tracking, that is a separate concern.

### C3. Push → merge → delete ordering (Edge Case: `--delete-branch`)

Ordering is: **push** (C1) → `gh pr merge --squash --delete-branch` (existing). The push completes and returns before the merge runs; the merge then deletes the remote branch. There is no window where the deleted branch is pushed again — the push strictly precedes the merge in the same `mergeViaGitHub` promise chain, and no code touches the branch after `gh pr merge` returns. No dangling-branch failure is possible from this ordering.

### C4. Retry/escalation accounting reused unchanged (AC #3)

A push failure returns the same shape as a merge failure — `{ success: false, method: "github", error }` — so the step-9 retry loop consumes it with **zero changes**. In the single-feature path (`runner.ts:945-969`) a `success: false` result already: increments `stepState.attempts`, appends one truncated `FailureRecord` (with `classifyFailure`/`deriveFailureSignature`), persists state, and escalates at `MAX_RETRY_ATTEMPTS` via the existing `[ESCALATE]` block. The multi-feature path (`runMergeStepForFeature`, `runner.ts:~2439`) behaves identically. **No new escalation path is introduced** (AC #3, spec Out of Scope). The push failure is simply a new *reason* an existing failure record can carry; its `error` string (C1) names it as a push failure so post-mortems and escalation messages distinguish it from a merge rejection (AC #8).

### Unchanged components (explicit)

| Component | Why unchanged |
|---|---|
| `executeMerge` dispatch (`merge.ts:143-163`) | Only `mergeViaGitHub` gains the push; dispatch logic (already-merged, PR-closed, fallback selection) is untouched (AC #6, #7) |
| `detectGitHubPR` (`merge.ts:18-51`) | No change; the already-merged (`prStatus < 0`, AC #6) and PR-closed (`prStatus === 0`, AC #7) branches short-circuit **before** `mergeViaGitHub`, so no push runs on them |
| `mergeViaLocalGit` (`merge.ts:85-127`) | No-remote / local-fallback path; no push, byte-for-byte unchanged (AC #4) |
| Step-9 retry/escalation loop (`runner.ts:945-990`, multi-feature equivalent) | Reused verbatim; consumes push failures as merge-attempt failures (AC #3) |
| `MAX_RETRY_ATTEMPTS`, squash strategy, gh-vs-simple-git selection | Spec Out of Scope |
| `--delete-branch` flag on `gh pr merge` | Unchanged; ordering verified (C3) |

## Data Model

**No schema changes.** No new persisted fields, no state-file migration. Push failures reuse the existing optional `FailureRecord` fields (`classification`, `signature`) already populated at the merge-failure write site (`runner.ts:967-968`). `MergeResult` (`merge.ts:5-10`) is unchanged — a push failure is expressed through the existing `success`/`method`/`error` fields. `state.branchName` (already tracked, `state.ts:143`) is the branch pushed; no new state is read or written.

## API Contracts

No MCP tool signature changes. `executeMerge`'s public signature is unchanged. One **internal** signature change: `mergeViaGitHub(cwd, featureSlug, sprint)` → `mergeViaGitHub(cwd, featureSlug, sprint, branchName)` (module-private function; `executeMerge` already holds `branchName`).

`MergeResult` values flowing through existing fields:

| Path | Contract |
|---|---|
| Push succeeds, merge succeeds | `{ success: true, method: "github" }` — unchanged from today |
| Push fails | `{ success: false, method: "github", error: "Pre-merge push of branch '<name>' failed: <detail>" }`; `gh pr merge` **never invoked** (AC #2, #9) |
| Push succeeds, merge fails (e.g. branch protection) | `{ success: false, method: "github", error: <gh stderr> }` — unchanged; handled by existing retry (Edge Case) |
| Already-merged PR | `{ success: true, method: "github", alreadyMerged: true }` — **no push** (AC #6) |
| PR closed without merge | Existing structured failure — **no push** (AC #7) |
| Local fallback (no PR) | `mergeViaLocalGit` result — **no push** (AC #4) |

**`executeMerge` still never throws** — the push is wrapped in try/catch inside `mergeViaGitHub` and converted to a structured `success: false` (AC #2). Contract preserved.

## Non-Functional Requirements

1. **Correctness (the point of the feature).** The remote branch contains the feature branch's local commits before the squash-merge, so the merge can never fail on the unpushed-local-commits divergence class (AC #1). Verified by the Sprint-12-regression seam test (AC #9).
2. **Safety — no history rewrite (AC #5).** The push is non-forced and single-refspec. A genuine divergence (remote ahead of local) fails the push and escalates to the user; the orchestrator never rewrites remote history to force a merge through. This is a hard security/correctness constraint, not a preference.
3. **Bounded latency.** Adds exactly one `git push` of one branch before each open-PR merge attempt. Push is a network op; it inherits no new timeout surface (the existing `GH_TIMEOUT_MS = 30s` covers only the `gh` execFile calls — the push has no explicit timeout, consistent with `simple-git` usage elsewhere in the codebase, e.g. `mergeViaLocalGit`). Worst case on repeated push failure is `MAX_RETRY_ATTEMPTS` push attempts back-to-back — seconds, no backoff (Out of Scope), reusing the existing loop.
4. **Fail-cleanly / never-throws.** A push rejection, network error, or auth failure becomes a structured `success: false` — `executeMerge` still never throws (AC #2). Crash-safety is inherited: the existing loop persists state after each failure record.
5. **Backward compatibility.** Zero schema change; old state files load unchanged. Every non-open-PR path is byte-for-byte identical to today (AC #4, #6, #7). No new config surface.
6. **Observability (AC #8).** The push-failure `error` is prefixed `Pre-merge push of branch '<name>' failed:` so a user reading an escalation or log can distinguish a push rejection from a merge rejection. The existing `failures[]` truncation and classification apply.

## Technology Choices

**No new technologies, frameworks, or dependencies.** ⚠️ *Presented for user approval per process — this feature reuses the existing stack end-to-end:*

| Aspect | Choice | Status |
|---|---|---|
| Language / runtime | TypeScript on Node.js | existing |
| Git push | `simple-git` — `git.push(["origin", branchName])`, non-forced, single refspec | existing dependency; **first `git.push` call in the codebase** (no prior push site) |
| PR merge | `gh` CLI (`gh pr merge --squash --delete-branch`) | existing, unchanged |
| Failure metadata | `classifyFailure` / `deriveFailureSignature` (`failure-classification.ts`) | existing, reused |
| Retry / escalation | Existing step-9 in-place `do/while` loop in `runner.ts` (Sprint 13) | existing, unchanged |
| State persistence | JSON sprint-state files via `loadSprintState`/`saveSprintState` | existing, unchanged |
| Tests | jest / ts-jest; seam tests in `tests/integration/`, BDD in `tests/bdd/` | existing |

The only genuinely new thing is that this is the **first place Raptor pushes to a remote** — worth flagging to the user, because it means the orchestrator now performs a network write to `origin` on the feature branch during step 9. It cannot touch `main` (single-refspec, C1/OQ3) and cannot rewrite history (non-forced, AC #5). If the user rejects `simple-git` push here (none of the rows is a new dependency), implementation must halt pending re-design.

## Constraints & Patterns

1. **Push only on the open-PR path.** The push lives in `mergeViaGitHub`, reached only when `detectGitHubPR` returns a positive PR number. Already-merged (AC #6), PR-closed (AC #7), and local-fallback (AC #4) paths short-circuit before it and must never push.
2. **Safe push only — no force, ever (AC #5).** No `--force`, no `--force-with-lease`. A divergence the push cannot fast-forward fails the attempt (AC #2) and escalates. This is non-negotiable: the orchestrator never rewrites remote history.
3. **Single explicit refspec (OQ3).** `git.push(["origin", branchName])` — never a bare push, never `--all`/`--tags`/`--mirror`. Only the current feature branch's remote counterpart is written; `main` can never be pushed by this call.
4. **Upstream-agnostic (OQ2).** The explicit `origin <branch>` form works with or without configured tracking (branches are created via `checkoutLocalBranch` with no upstream). No `-u`/`--set-upstream` — the branch is deleted seconds later by `--delete-branch`.
5. **Fail cleanly into the existing loop (OQ1, AC #3).** A push failure returns `{ success: false, method: "github", error }` and feeds the **existing** step-9 retry/escalation loop unchanged. No new escalation path, no new state, no `decideAfterFailure` wiring (deferred — see spec Out of Scope; `merge-failure-short-circuit` tracks short-circuiting a deterministic push rejection).
6. **Never proceed to merge after a failed push (AC #2).** The `gh pr merge` execFile is inside the same function *after* the push try/catch that `return`s on failure — the merge is structurally unreachable when the push fails. Tests must assert `gh pr merge` is **never invoked** on a push failure (AC #9).
7. **`executeMerge` never throws (AC #2).** The push is wrapped in try/catch and converted to a structured result.
8. **All git operations remain `simple-git` (AC #10).** The push uses `simple-git`; `gh` remains only for the PR merge itself. No shelling out to raw `git`.
9. **Tests exercise the production seam (AC #9, TEAM.md QA rule 12).** Regression tests drive the real `executeMerge` / `mergeViaGitHub` (stubbing the `gh` merge execFile and the remote, as integration tests do for git), never a reimplemented push. Required RED-verified cases: (a) unpushed local commits → push runs, merge includes them (the Sprint 12 regression); (b) failing push → `success: false` and `gh pr merge` never called; (c) no-remote/local-fallback → no push, existing behavior; (d) remote-ahead-of-local force-push hazard → push fails, no forced push, clean fail. Each carries a RED-verification note proving it FAILS against the pre-change `executeMerge` (which does no push).
10. **No schema change / no migration.** No new persisted fields; historical state files load unchanged.
11. **Out of scope honored.** Step-9 retry/escalation control flow (Sprint 13), squash strategy, `MAX_RETRY_ATTEMPTS`, gh-vs-simple-git selection, failure-signature short-circuit classification, and divergence auto-resolution are all untouched.
