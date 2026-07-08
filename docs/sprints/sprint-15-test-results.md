# Sprint 15 — Test Results

> Multi-feature sprint: each feature's QA step recorded its suite result on its own
> branch. Counts below are per-feature-branch snapshots (taken before the sibling
> features merged), retained on merge rather than fabricating a combined total.

---

## Feature: push-before-merge

**QA:** Vex (QA Engineer) · **Date:** 2026-07-07 · **Command:** `npx jest`

| Metric | Result |
|--------|--------|
| Test Suites | **46 passed**, 46 total |
| Tests | **795 passed**, 795 total |
| Failures | 0 |

✅ All tests pass — meets the "all tests pass" DoD gate.

### Feature-scoped coverage
`tests/integration/push-before-merge.integration.test.ts` — **10 passed**. Every
constraint-guarding test drives the **real** `executeMerge` (and, for retry
accounting, the **real** `runSprintFromStep` step-9 loop) against real git repos
with real bare remotes via `simple-git`. Mocking confined to the sanctioned
boundaries (`gh` CLI via `execFile`; `spawnAgent` on the runner-seam test only).
`executeMerge` is never mocked — it is the system under test.

RED-verification (TEAM.md QA rule 12): AC #1/#10, #2/#8/#9, #5, #3 carry in-file
RED notes proving each was seen to FAIL against pre-change `executeMerge`
(reverting the pre-merge push in `mergeViaGitHub`). The open-PR push is
unconditional (no gating config), so rule-13 default-off parity does not apply;
the analog is the push-free assertions on the unchanged non-open-PR paths.

---

## Feature: user-actionable-failure-class

**QA:** Vex (QA Engineer) · **Date:** 2026-07-07 · **Command:** `npx jest`

| Metric | Result |
|--------|--------|
| Test Suites | **45 passed**, 45 total |
| Tests | **827 passed**, 827 total |
| Failures | 0 |

✅ All tests pass — meets the "all tests pass" DoD gate.

### Feature-scoped coverage
`src/orchestrator/failure-classification.test.ts` (unit) +
`tests/integration/user-actionable-failure-class.integration.test.ts` — **74 passed**.

1. **New `user-actionable` classification** — billing/spend-limit specimens classify
   as `user-actionable` (AC 1–4), distinct from `transient` and `deterministic`.
2. **Escalate-after-1-attempt** — `decideAfterFailure` short-circuits without burning
   the retry budget, asserted against the runner's exact attempt-accounting (AC 11).
3. **Scoping guard** — the `invalid-model` advisory can never reach `classifyFailure`
   via a real failure path (it exits 0 on the CLI), so no pattern is shipped for it;
   a negative test pins this and the case is deferred to Inbox
   `invalid-model-user-actionable-detection`.

Production-seam / anti-false-green verification (rule 12): the integration suite
imports the **real** `classifyFailure` / `decideAfterFailure` / `loadSprintState`
— no test-local reimplementation. Constraint-guarding tests carry RED-verification
notes; the adversarial-verifier gate checks (reimplementation hunt + RED-note
presence) both pass.

---

## Regression status

No regressions in either feature branch. The Sprint 12/13/14 lineage
(`progress-aware-circuit-breaker`, `sprint-completes-despite-failed-merge`,
`retro-improvements-not-applied`, `orchestrator-recovery-after-mixed-completion`,
`adversarial-verifier-review-gate`) remained green on both branches. The
authoritative post-merge suite count is whatever `npm test` reports on `main`
after both features land.
