# Sprint 15 — Test Results

**Feature:** user-actionable-failure-class
**QA:** Vex (QA Engineer)
**Date:** 2026-07-07
**Command:** `npx jest` (full suite: unit + integration)

## Summary

| Metric | Result |
|--------|--------|
| Test Suites | **45 passed**, 45 total |
| Tests | **827 passed**, 827 total |
| Failures | 0 |
| Snapshots | 0 |
| Wall time | ~12.6 s |

✅ **All tests pass — the PR meets the "all tests pass" Definition of Done gate.**

## Feature-scoped coverage — user-actionable-failure-class

`npx jest` over the two feature suites:

| Suite | Tests |
|-------|-------|
| `src/orchestrator/failure-classification.test.ts` (unit) | ✅ |
| `tests/integration/user-actionable-failure-class.integration.test.ts` | ✅ |
| **Total** | **74 passed**, 74 total |

These exercise the third failure class per spec:
1. **New `user-actionable` classification** — billing/spend-limit specimens
   classify as `user-actionable` (AC 1–4), distinct from `transient` (retry helps)
   and `deterministic` (task is wrong).
2. **Escalate-after-1-attempt** — `decideAfterFailure` short-circuits a
   user-actionable failure without burning the full retry budget, asserted against
   the runner's exact attempt-accounting at the production seam (AC 11).
3. **Scoping guard** — the `invalid-model` advisory can never reach `classifyFailure`
   via a real failure path, so no pattern is shipped for it (negative test).

## Production-seam / anti-false-green verification (TEAM.md QA rule 12)

The integration suite imports the **real** `classifyFailure` and `decideAfterFailure`
from `src/orchestrator/failure-classification.ts` and `loadSprintState` from
`src/orchestrator/state.ts` — no test-local reimplementation of the
system-under-test. Constraint-guarding tests carry **RED-verification notes**
(file header + inline `// RED-VERIFICATION` comments) documenting that pre-change
these specimens return `deterministic` and the new imports are a compile-time RED
signal. Adversarial-verifier gate checks (a) reimplementation/stub hunt and
(b) RED-note presence both pass.

## Regression status

No regressions. All 45 suites — including the Sprint 12/13/14 lineage
(`progress-aware-circuit-breaker`, `sprint-completes-despite-failed-merge`,
`retro-improvements-not-applied`, `orchestrator-recovery-after-mixed-completion`,
`adversarial-verifier-review-gate`) — remain green. Suite count grew 44 → 45 and
test count 780 → 827 (+47) with the new feature coverage; no prior test was
removed or weakened.
