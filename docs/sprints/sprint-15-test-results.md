# Sprint 15 — Test Results

> Multi-feature sprint: each feature's QA step recorded its suite result on its own
> branch. Counts below are per-feature-branch snapshots (taken before the sibling
> features merged), retained on merge rather than fabricating a combined total.
> The authoritative post-merge count is whatever `npm test` reports on `main`.

---

## Feature: push-before-merge

**QA:** Vex (QA Engineer) · **Date:** 2026-07-07 · **Command:** `npx jest`

| Metric | Result |
|--------|--------|
| Test Suites | **46 passed**, 46 total |
| Tests | **795 passed**, 795 total |
| Failures | 0 |

✅ All tests pass. `tests/integration/push-before-merge.integration.test.ts` (**10 passed**)
drives the **real** `executeMerge` (and, for retry accounting, the **real**
`runSprintFromStep` step-9 loop) against real git repos with real bare remotes;
`executeMerge` is never mocked. RED notes on AC #1/#10, #2/#8/#9, #5, #3.

---

## Feature: user-actionable-failure-class

**QA:** Vex (QA Engineer) · **Date:** 2026-07-07 · **Command:** `npx jest`

| Metric | Result |
|--------|--------|
| Test Suites | **45 passed**, 45 total |
| Tests | **827 passed**, 827 total |
| Failures | 0 |

✅ All tests pass. Unit `failure-classification.test.ts` + integration (**74 passed**):
new `user-actionable` class (billing/spend-limit), escalate-after-1 asserted at the
runner seam, and a negative test pinning that `invalid-model` is deliberately NOT
shipped (exits 0 on the CLI, deferred to Inbox). Real `classifyFailure` /
`decideAfterFailure` / `loadSprintState` imported — no reimplementation.

---

## Feature: retro-section-matching-rarely-hits-target

**QA:** Vex (QA Engineer) · **Date:** 2026-07-07 · **Command:** `npx jest`

| Metric | Result |
|--------|--------|
| Test Suites | **46 passed**, 46 total |
| Tests | **810 passed**, 810 total |
| Failures | 0 |

✅ All tests pass. Feature suites (**21 passed**): integration + performance/NFR,
BDD authored and realized by the integration suite. No UI ⇒ no Playwright (consistent
with the Sprint 13/14 retro lineage).

Adversarial-verifier gate (rule 12): the integration suite drives the **real**
`applyImprovements` and **both real runner seams** (`runSprintFromStep(...,13)`
single-feature; `state.features`-seeded multi-feature) — no reimplementation/stub;
RED notes prove the compound-Section fixtures fall to fallback under exact-only
matching and resolve to their specific H3 targets under segment-and-match.

---

## Regression status

No regressions on any feature branch. The Sprint 12/13/14 lineage
(`progress-aware-circuit-breaker`, `sprint-completes-despite-failed-merge`,
`retro-improvements-not-applied`, `orchestrator-recovery-after-mixed-completion`,
`adversarial-verifier-review-gate`) remained green throughout. Post-merge suite
count is authoritative from `npm test` on `main`.
