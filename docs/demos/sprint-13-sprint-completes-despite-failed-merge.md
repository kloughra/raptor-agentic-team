---
slug: sprint-completes-despite-failed-merge
sprint: 13
date: 2026-07-06
presenter: Brax (Team)
---
# Sprint 13 Demo — Sprint Completes Despite Failed Merge

> Note: escalation/blocker git markers are referred to by name (not quoted in
> bracket form) throughout this document, to avoid the known marker
> false-positive (see `blocker-marker-false-positive-in-agent-output`,
> observed live in the Sprint 12 demo).

## 1. Sprint Goal

Make `run_sprint`'s completion status trustworthy: **`complete` means the code
is actually on `main`, every time.**

The defect: the Merge PR step's (step 9) failure branch executed `continue`
inside the step loop — the comment said "Retry the merge", but `continue`
advances the loop index, so a single merge failure silently *skipped* the
merge. The runner then marched through steps 10–13 and the finalization block
unconditionally reported "Sprint complete!" with the PR still open.

Observed twice in production:
- **Sprint 10** (2026-06-11): PR #21 blocked by branch protection → false "Sprint complete".
- **Sprint 12** (2026-07-06): PR #27 merge failed on branch divergence → false "Sprint complete"; manual merge required.

The multi-feature path shared the defect: the dispatcher ignored
`runMergeStepForFeature`'s `"retry"` return value.

**Design invariant shipped:** `state.status === "complete"` implies every step
in `state.steps` is `complete` — and in multi-feature mode, every feature is
terminal (`complete` or `escalated`) before any shared step runs.

## 2. What Was Delivered (PR #29)

| Component | AC | Change |
|---|---|---|
| C1 — single-feature in-place retry | 1–3 | Skip-a-step `continue` replaced with a local bounded `do/while` around `executeMerge` (`runner.ts:935-993`). No step-loop index mutation. Failure accounting unchanged (attempts == invocations); escalation-at-cap block preserved verbatim; persist-before-retry. |
| C2 — multi-feature retry honored | 5, 8 | Dispatcher consumes the previously-discarded `"retry"` outcome in a `do/while` (`runner.ts:2136-2140`). `runMergeStepForFeature` body unchanged. Sibling isolation structural. |
| C3 — finalization guard | 4 | `"complete"` reachable only when every step is `complete` (`runner.ts:1375-1385`). Guard trips map to `escalated` (Open Question 3 ruling — resumable, never Sprint 9 in-progress limbo), no duplicate escalation commit. |
| C4 — shared-step gate | 6 | Steps 10–13 blocked while any feature is non-terminal at step 9 (`runner.ts:2271-2278`). |
| C5 — failure-record enrichment | additive | Merge FailureRecords now carry `classification` + `signature` via `failure-classification.ts` (Sprint 12 module reused). Retry behavior unchanged. |

**Diff footprint:** `runner.ts` +219/−45; 218-line colocated unit test file added.
No schema changes, no new dependencies, no migration (historical falsely-complete
state files load unchanged).

**Architect rulings on Open Questions:**
1. Pre-merge push → follow-up backlog item `push-before-merge` recommended for Sprint 14 (changes `executeMerge` mechanics — out of scope here).
2. No `decideAfterFailure` wiring for merges this sprint — merge attempts are seconds, not minutes; C5 persists the metadata so a future short-circuit is state-compatible.
3. Guard/gate trips map to `escalated` (resumable; `in-progress` forbidden; `failed` would imply a recorded step failure that may not exist).

## 3. Test Execution (run live at demo, 2026-07-06)

```
Test Suites: 39 passed, 39 total
Tests:       709 passed, 709 total
Time:        11.973 s
```

Full suite (unit + integration), zero failures, zero skips beyond the standing
environment-gated smoke skips. `tsc` clean.

## 4. Test Results Summary

**Feature-scoped coverage (28 tests):**
- `tests/bdd/sprint-completes-despite-failed-merge.feature` — 166 lines of Given/When/Then covering happy path, retry-then-succeed, escalation-at-cap, guard/gate trips, sibling isolation, resume.
- `tests/integration/sprint-completes-despite-failed-merge.integration.test.ts` — 607 lines driving the **production seam** (real `runSprintFromStep` step loop and multi-feature dispatcher, mocked only at the `executeMerge` boundary) per AC #10 / TEAM.md QA rule 12.
- `src/orchestrator/sprint-completes-despite-failed-merge.test.ts` — 218 lines of unit tests for the extracted pure guard helpers (`findIncompleteSteps`, `findNonTerminalFeatures`, message builders).

**TDD evidence (fail-against-pre-fix proven):** QA's integration suite ran
**10 failed / 3 passed** against the pre-fix `continue` control flow, and
**13 / 13** after the fix — the constraint-guarding tests demonstrably fail
against the defective code path, satisfying AC #10's adequacy bar.

**Edge cases exercised:** merge fails exactly MAX_RETRY_ATTEMPTS times
(escalates, steps 10–13 untouched); fails-then-succeeds on attempt 2
(exactly one HANDOFF commit, on success only); deterministic failure
(3 fast identical attempts, clean escalation); feature A merged + feature B
failing (A untouched, B retries then escalates, mixed sprint parks
`escalated`); guard/gate trips on hand-crafted invariant-violating state;
pre-fix state files load without crashing; retry loop termination bounded.

**No-regression checks:** `runner.test.ts`,
`orchestrator-recovery-after-mixed-completion`, `sprint-completion-on-merge`,
`multi-feature-sprint-dispatch` all green (105 tests) — the Sprint 10
escalated-resume path (AC #7) and Sprint 12 circuit breaker are unaffected.

**Defects found and resolved during the sprint:** none in the feature code
after implementation (TDD red→green in one pass). Process incident: step 4
(Review tests) escalated after 2 transient spend-limit failures
(commit 908bf63); resolved by user re-engagement — circuit breaker behaved
as designed.

## 5. Definition of Done

- [x] All tests pass (709/709, run live at demo)
- [x] PR #29 open with test evidence
- [x] Peer review: Architect + QA review complete (step 7)
- [x] PO acceptance against acceptance criteria (step 4 approval + QA verification)
- [x] Demo conducted (this document)

## 6. Items Flagged for the Backlog

- `push-before-merge` (Sprint 14 candidate, Architect-recommended): push branch before `gh pr merge` to prevent the Sprint 12 divergence root cause.
- `merge-failure-short-circuit` (deferred, state-compatible via C5): reuse `decideAfterFailure` so deterministic merge failures don't burn 3 identical attempts.
- `sprint-result-status-hardcoded-escalated` (Inbox, adjacent): not touched — did not fall out of AC #5/#6 work.

## 7. Stakeholder Feedback

_To be recorded verbatim by the PO at step 9 (Feedback)._
