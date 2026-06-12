---
slug: orchestrator-recovery-after-mixed-completion
status: draft
sprint: 10
---
# Orchestrator Recovery After Mixed Completion

## User Story
As a Raptor user running a multi-feature sprint, when one feature reaches Definition of Done and another hits the 3-attempt circuit breaker, I want the sprint to land in `escalated` status and let me send fresh directional `request-changes` feedback to the parked feature via `resume_sprint` — so that I can re-engage the stuck feature in-band instead of hand-editing `~/.raptor/{project}/sprint-N.json` or shipping the remaining work through an out-of-band hotfix.

## Background
Sprint 8's `multi-feature-sprint-dispatch` wired per-feature dispatch into `runSprintFromStep`. Sprint 9 exposed a recovery gap: when `live-claude-smoke-test` escalated while its sibling feature completed, the orchestrator could not re-engage the parked feature. The remaining work had to ship as a hotfix (PRs #18 + #19) outside the sprint, defeating the point of in-sprint dispatch.

There are **two intertwined defects** behind this:

1. **Status derivation defect.** When a feature finishes its last per-feature step, the runner sets the step `complete` and bumps `feature.currentStep` (`runner.ts:1512-1518`) but **never flips `feature.status` to `"complete"`**. As a result `deriveSprintStatus` (`multi-runner.ts:107`) still sees that feature as `in-progress`, so a mixed sprint (one done, one escalated) lands in `in-progress` instead of `escalated`. Because the sprint is `in-progress`, `resume_sprint` refuses with `Sprint is in 'in-progress' status and cannot be resumed`, and `run_sprint` just re-issues the same status report without re-engaging the escalated feature.

2. **Resume-targeting defect.** `resumeSprint`'s escalated branch (`runner.ts:1127-1162`) only searches the top-level `state.steps` array. Multi-feature escalations live in `state.features[i].steps`, so even if the sprint *were* marked `escalated`, the resume path could not find the escalated step. There is also no way to say *which* feature to re-engage, nor to reset that feature's per-step `attempts` counter.

The fix has three parts: (a) mark a feature `complete` when its terminal per-feature step (Merge PR) completes; (b) ensure mixed sprints (every feature either `complete` or `escalated`, at least one `escalated`) finalize as `escalated`; and (c) extend the resume path so `request-changes` feedback can be routed to an escalated feature, resetting its `attempts` and re-entering the runner at the escalated step.

### Relationship to `reset-sprint-tool`
This is **distinct from** the Ready item `reset-sprint-tool`. That item clears escalated/failed state to start a feature *over from scratch*. This spec carries the user's **directional feedback into a re-attempt** of the escalated step, preserving completed sibling work. They are complementary, not duplicative.

## Acceptance Criteria

1. **Feature completion marked.** When a feature's terminal per-feature step (the Merge PR step) completes successfully, the runner sets that `FeatureState.status = "complete"`. This happens at the moment the terminal step flips to `complete`, alongside the existing `currentStep` bump.

2. **Mixed sprint finalizes as `escalated`.** When every feature in `state.features` is either `complete` or `escalated`, and at least one is `escalated`, the sprint's persisted `status` is `escalated` (consistent with `deriveSprintStatus`). It is NOT left as `in-progress`.

3. **All-complete sprint unchanged.** When every feature is `complete`, the sprint finalizes as `complete` exactly as today — no regression to the all-success path.

4. **Resume accepts a feature selector.** `resume_sprint` accepts an optional `feature` argument (the feature slug). The `run_sprint` and `resume_sprint` tool signatures change only additively — existing calls without `feature` remain valid.

5. **Implicit single-target resume.** When the sprint is `escalated` and exactly one feature has `status = "escalated"`, calling `resume_sprint` with `action = "request-changes"` and no `feature` argument targets that one escalated feature automatically.

6. **Explicit multi-target resume.** When more than one feature is `escalated`, `resume_sprint` with `action = "request-changes"` and no `feature` argument returns a clear error listing the escalated feature slugs and instructing the user to pass `feature`. Supplying a valid `feature` slug targets that feature.

7. **Per-feature attempts reset + feedback injection.** When resuming an escalated feature with `request-changes`, the runner locates the escalated step under `state.features[i].steps`, resets that step's `attempts = 0` and `failures = []`, sets its status back to `pending`, and re-enters the per-feature runner at that step. The user's `feedback` is injected into the next agent invocation for that feature (same feedback-injection mechanism used by single-feature `request-changes`).

8. **Sibling work preserved.** Resuming an escalated feature does NOT reset, re-run, or alter any sibling feature that already reached `complete`. Completed per-feature steps and their artifacts are untouched.

9. **Re-escalation supported.** If a re-engaged feature fails its circuit breaker again after a `request-changes` resume, it returns to `escalated` status and the sprint returns to `escalated`, so the user can resume again. There is no cap on the number of `request-changes` re-attempts beyond the per-attempt circuit breaker.

10. **Sprint advances to shared steps only when eligible.** Sprint-shared steps 10–13 run only after the multi-feature dispatch loop resolves. A sprint with an escalated feature does NOT silently advance through steps 10–13 and report `in-progress`; it parks in `escalated` until the user resumes (or accepts reduced scope per existing flows).

11. **Clear escalated-state reporting.** When a sprint is `escalated`, `run_sprint` / `get_project_status` / the progress table clearly identify which feature(s) are escalated and at which step, and state that `resume_sprint --action=request-changes [--feature=<slug>]` is the path to re-engage.

12. **Error messaging updated.** The "cannot be resumed" / "no escalated step found" messages no longer fire for a legitimately-mixed sprint. The resume path looks in `state.features[i].steps` (not only `state.steps`) when the sprint is in multi-feature mode.

## Edge Cases
- **All features escalated.** Resume with no `feature` argument errors per AC #6 (more than one escalated) and lists all escalated slugs.
- **No escalated features (sprint genuinely `in-progress`).** Existing behavior unchanged — `resume_sprint` still refuses to resume a true `in-progress` sprint.
- **`feature` slug not found / not escalated.** `resume_sprint` with a `feature` that does not exist in `state.features`, or that exists but is not `escalated`, returns a clear error naming the valid escalated slugs.
- **`approve` action on an escalated mixed sprint.** Out of scope to "approve" a parked feature into completion; `approve` on an escalated sprint should return a clear message directing the user to `request-changes` (with feedback) or to the reset/reduce-scope path. (Architect to confirm exact wording.)
- **Single-feature sprint escalation.** Existing single-feature escalated-resume path (`runner.ts:1127-1162`) must continue to work unchanged when `state.features` is absent.
- **Feature completes on the re-attempt, making the sprint all-complete.** After a successful `request-changes` re-attempt, if all features are now `complete`, the sprint finalizes as `complete` and proceeds to shared steps 10–13.

## Out of Scope
- **`reset_sprint` tool.** Clearing state to start a feature over from scratch is the separate Ready item `reset-sprint-tool`. This spec only covers carrying feedback into a re-attempt.
- **Concurrent feature execution / parallelism changes.** Dispatch ordering and concurrency are owned by existing specs; unchanged here.
- **Changing the circuit-breaker threshold** (3 attempts) or making it configurable.
- **Cross-feature dependency handling.** Features remain independent.
- **Reduce-scope-and-merge flows** beyond what already exists for single-feature sprints.
- **Backfilling old sprint state files.** Sprints already parked in `in-progress` from the Sprint 9 incident are not auto-migrated; this spec governs new and resumable runs.

## Open Questions
- **Tool surface change requires confirmation.** Adding an optional `feature` argument to `resume_sprint` is an additive MCP tool-input change. Confirm with the user that the additive signature is acceptable (AC #4). *(Decision authority: user.)*
- **`approve` on an escalated sprint** — exact response wording and whether `approve` should ever be a valid action while a feature is escalated. *(Architect to propose; PO to confirm against AC.)*
- **Finalization placement** — whether feature-status finalization lives in the dispatch loop, in `deriveSprintStatus`'s callers, or both, is a technical-design decision for the Architect; this spec only fixes the observable status.
