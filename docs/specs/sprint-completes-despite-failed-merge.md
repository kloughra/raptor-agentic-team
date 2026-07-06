---
slug: sprint-completes-despite-failed-merge
status: ready
sprint: 13
---
# Sprint Completes Despite Failed Merge

## User Story
As a Raptor user running a sprint, when the Merge PR step (step 9) fails, I want the orchestrator to retry the merge **in place** — and to refuse to report "Sprint complete" while the PR is still open — so that a sprint's completion status is trustworthy: `complete` means the code is actually on `main`, every time.

## Background

The Merge PR step's failure path (single-feature mode) records the failure and then executes `continue` inside the step loop `for (let i = fromStep - 1; i < SPRINT_WORKFLOW.length; i++)`. The comment says "Retry the merge", but `continue` advances `i` — so instead of re-running step 9, a single merge failure **silently skips the merge**. Step 9 is left `in-progress` with `attempts = 1`, the runner marches through steps 10–13, and the final block unconditionally sets `state.status = "complete"` and returns "Sprint complete! All steps finished successfully." — with the PR still open and `main` lacking the code.

**Observed twice in production:**
- **Sprint 10 (2026-06-11):** PR #21 blocked by `main`'s base-branch protection (`gh pr merge` rejected); `run_sprint` reported "Sprint complete".
- **Sprint 12 (2026-07-06):** step 9 failed on `gh pr merge` branch divergence (local demo/retro commits unpushed); the sprint marched through steps 10–13 and reported "Sprint complete" with PR #27 still OPEN — reproduced in the very sprint that shipped the progress-aware circuit breaker. Manual merge required.

### Verified code provenance (2026-07-06, current `main`)

The backlog item cites `runner.ts:748-750` and `runner.ts:1862+`; those line numbers are stale. Verified locations as of Sprint 13 prep:

| Site | Location | Verified behavior |
|---|---|---|
| Single-feature merge failure `continue` | `runner.ts:967-969` (failure branch `runner.ts:931-970`, inside the step loop opened at `runner.ts:773`) | `continue` advances `i` to step 10 instead of re-running step 9. **Defect confirmed.** |
| Single-feature finalization | `runner.ts:1343-1369` | After the loop, `state.status = "complete"` is set **unconditionally** — no check that all steps (in particular step 9) are `complete`. **Defect confirmed.** |
| Multi-feature merge dispatch | `runner.ts:2038-2041` | `await runMergeStepForFeature(feature, featureStepState, ctx); continue;` — the function's `"complete" | "escalated" | "retry"` return value is **ignored**. A `"retry"` result advances to the next feature/step with the feature's step 9 left `in-progress`. **The multi-feature path SHARES the defect** (answering the backlog's "verify" ask). |
| Multi-feature merge body | `runMergeStepForFeature`, `runner.ts:2271-2341` | Failure accounting and escalation-at-cap are correct in isolation; only the ignored `"retry"` return is defective. |
| Multi-feature finalization | `runner.ts:2255` | `allFeaturesComplete(...) ? "complete" : deriveSprintStatus(...)` — will not label the sprint `complete`, but a feature stuck `in-progress` at step 9 still lets shared steps 10–13 run and lands the sprint in the unresumable `in-progress` limbo (the Sprint 9 failure mode). |

### Relationship to shipped work
- `orchestrator-recovery-after-mixed-completion` (Sprint 10) fixed feature-status derivation and escalated-resume; it did NOT touch the merge-retry control flow.
- `progress-aware-circuit-breaker` (Sprint 12) rebuilt retry for **agent** steps; the Merge PR step is orchestrator-managed (no subagent) and kept its own hand-rolled — and broken — retry `continue`.

## Acceptance Criteria

1. **Merge retried in place (single-feature).** When `executeMerge` fails and `stepState.attempts < MAX_RETRY_ATTEMPTS`, the runner re-executes step 9 (Merge PR) without advancing the step index. Given a merge that fails once then succeeds, the final state shows step 9 `complete` with `attempts = 2`, and steps 10–13 begin only after step 9 is `complete`.

2. **Failure accounting preserved.** Every merge failure increments `stepState.attempts` and appends a `failures[]` record with a truncated error summary (existing behavior unchanged). The attempts count equals the number of `executeMerge` invocations.

3. **Escalation at cap unchanged.** When merge failures reach `MAX_RETRY_ATTEMPTS` (3), the existing behavior is preserved: step 9 → `escalated`, sprint → `escalated`, `[ESCALATE]` commit, runner returns without executing steps 10–13.

4. **Single-feature finalization guard.** `state.status = "complete"` and the "Sprint complete!" result are reachable only when **every** step in `state.steps` has `status = "complete"`. If the step loop exits with any step non-complete (defense in depth beyond AC #1), the sprint is NOT reported `complete`; its persisted and returned status reflects the non-complete step (exact status mapping is the Architect's call, but `complete` is forbidden).

5. **Multi-feature retry honored.** The dispatcher consumes `runMergeStepForFeature`'s return value. On `"retry"`, the merge for that feature is re-executed in place (same in-place semantics as AC #1) rather than advancing with the feature's step 9 left `in-progress`. On `"escalated"`, existing park behavior applies.

6. **Multi-feature shared-step gate.** Sprint-shared steps 10–13 do not begin while any feature's terminal per-feature step (step 9) is neither `complete` nor `escalated`. A feature whose merge is mid-retry cannot be silently left behind by the shared-step phase.

7. **Escalated merge is resumable.** A sprint escalated at step 9 can be re-engaged via the existing resume paths (`resume_sprint` / escalated-resume from Sprint 10) and re-enters at step 9 — no regression to those flows.

8. **Sibling isolation (multi-feature).** Retrying or escalating one feature's merge does not re-run, reset, or alter a sibling feature whose merge already completed.

9. **DoD/PR truthfulness.** After a merge failure that ends in escalation, neither the sprint state nor any returned result claims the merge happened: step 9 is not `complete`, the sprint is not `complete`, and no step-9 `[HANDOFF]` commit is created for the failed merge.

10. **Tests exercise the production seam.** Regression tests drive the actual runner step loop (single-feature) and dispatcher (multi-feature) with a failing-then-succeeding `executeMerge` — not merely a unit test of an extracted helper. Per TEAM.md QA rule 12, each constraint-guarding test must FAIL against the pre-fix control flow (the skip-a-step behavior) — a test that passes both before and after the fix is inadequate.

## Edge Cases
- **Merge fails exactly `MAX_RETRY_ATTEMPTS` times.** Escalation per AC #3; steps 10–13 untouched; progress table shows step 9 `escalated`.
- **Merge fails, then succeeds on retry (attempts 2 or 3).** Step 9 `complete`, `[HANDOFF]` commit created once (for the successful merge only), sprint proceeds normally.
- **Deterministic merge failure (e.g. branch protection).** All 3 in-place attempts will fail identically and quickly; escalation must still fire cleanly at the cap. (Whether to short-circuit earlier on an identical failure signature is Open Question 2.)
- **`branchName` missing from state.** Existing hard-fail path (`runner.ts:912-922` single, `runner.ts:2283-2288` multi) unchanged.
- **Resume of a sprint whose state file predates the fix** (step 9 `in-progress`, sprint `complete` — Sprint 10/12 specimens): no auto-migration (Out of Scope), but the fix must not crash when loading such a state; existing resume error messaging applies.
- **Multi-feature: feature A merges, feature B's merge fails.** A stays `complete` and untouched; B retries in place, then escalates at cap; `deriveSprintStatus` parks the mixed sprint as `escalated` (Sprint 10 behavior preserved).
- **Retry loop must terminate.** The in-place retry is bounded by `MAX_RETRY_ATTEMPTS` — no unbounded loop on a permanently-failing merge.

## Out of Scope
- **Root-cause fixes for the merges themselves.** Push-before-merge / branch-divergence prevention (the Sprint 12 trigger) and branch-protection handling are separate concerns (see Open Question 1). This spec fixes the control flow around a failed merge, whatever the cause.
- **Changing `MAX_RETRY_ATTEMPTS`, the squash-merge strategy, or the `gh`-CLI-with-`simple-git`-fallback mechanics in `executeMerge`.**
- **State-file migration.** Historical sprint states falsely marked `complete` (Sprints 10, 12) are not auto-repaired — consistent with the established no-migration pattern.
- **`retro-improvements-not-applied`.** The sibling Sprint 13 item gets its own spec.
- **Retry-delay/backoff between merge attempts.** No timing behavior is specified here (Architect may propose; see Open Question 2).
- **`sprint-result-status-hardcoded-escalated`** (Inbox): the multi-feature return-label nit is adjacent but separately tracked; fix only if it falls out naturally of AC #5/#6 work.

## Open Questions
1. **Pre-merge push?** Sprint 12's failure cause was unpushed local commits (branch divergence). Should `executeMerge` push the branch before `gh pr merge`? PO leans yes-as-follow-up (separate backlog item) rather than bundling — Architect to advise whether it's a trivial add or scope creep.
2. **Failure-signature short-circuit for merges?** Sprint 12 shipped `decideAfterFailure` / `failure-classification.ts` for agent steps (no-progress short-circuit on identical signatures; transient vs deterministic classification). Should the merge step's retry reuse that pipeline, so a deterministic branch-protection error doesn't burn 3 identical attempts? Technical decision — deferred to Architect; the ACs above only require correctness of the bounded in-place retry.
3. **Status mapping when the finalization guard trips (AC #4).** If the loop somehow exits with a non-complete step despite AC #1/#5, what status does the sprint land in — `failed`, `escalated`, or `in-progress`? Architect to decide; the AC only forbids `complete`.
