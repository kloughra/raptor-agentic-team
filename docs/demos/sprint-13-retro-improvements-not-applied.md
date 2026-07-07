# Sprint 13 Demo — retro-improvements-not-applied

**Date:** 2026-07-07
**Presenter:** Brax (Team) 🦕
**Feature:** `retro-improvements-not-applied` — outcome-tracked retro improvement application
**PR:** #30 (open) · Branch: `sprint-13/retro-improvements-not-applied`

---

## 1. Sprint Goal

Fix the silent-drop defect in step 13 ("Apply retro improvements"): adopted retro proposals
whose free-text `Section` didn't exactly match a TEAM.md heading were skipped with no signal,
while the step reported `complete`. **Two live incidents** — Sprint 10 (commit `dc7f23f`,
both adopted proposals dropped) and Sprint 12 (commit `078d9db`, applied manually via PR #28).

**Acceptance criteria (9):** no silent drop; fallback placement on section miss; per-proposal
outcome recorded in the retro doc; qualified step completion; change verification before
commit; single/multi-feature path parity at the production seam; skip behavior unchanged;
commit-on-change-only with surfaced failures; regression fixture shaped like the live incidents.

## 2. What Was Built

- `applyImprovements` is now **outcome-returning**: `{ content, outcomes[], changed }` —
  exactly one `ProposalOutcome` per adopted proposal on every code path, including I/O failure
  (the "hardest pin" invariant).
- **Section misses fall back** to `## Adopted Retro Improvements (Unplaced)` with full
  attribution (sprint + role + intended section + type) instead of vanishing.
- **Fence-aware, normalization-only heading matching** — trim/case/whitespace/leading-hash
  tolerance; deliberately no fuzzy matching; headings inside code fences neither match nor
  terminate sections.
- **Content-based idempotency** — re-running step 13 (resume precedent: Sprint 8) records
  `already-present`, never double-appends, never re-commits.
- **One shared executor** (`executeRetroApply`) called from both runner paths — AC 6 parity
  is structural; both seams still independently tested per the TEAM.md production-seam rule.
- Retro doc `## Applied Changes` stub is filled with per-proposal outcome lines; sprint state
  gains additive optional `retroApply` report; step completion message is qualified whenever
  any proposal fell back or failed.

## 3. Test Execution (live, 2026-07-07)

```
Test Suites: 40 passed, 40 total
Tests:       728 passed, 728 total
Time:        ~10 s
```

Feature-specific coverage: **47 tests** — 22 colocated unit
(`retro.test.ts` +17, `retro-apply.test.ts` 6) + 25 integration
(`retro-improvements-not-applied.integration.test.ts`), plus the BDD feature file
(`tests/bdd/retro-improvements-not-applied.feature`, 243 lines).

**Headline scenarios demonstrated:**
- `AC 9 REGRESSION: the Sprint 10/12 silent-drop shape can no longer occur` — inexact
  `Section` values against the real bundled template, through the runner seam.
- `STRUCTURAL PARITY: identical inputs through both seams produce identical placements` (AC 6).
- `AC 1 HARDEST PIN: TEAM.md unreadable → outcomes still total the selection, all unplaced, no throw`.
- Idempotent re-run: no double-append, no second commit.
- `AC 7`: skip / out-of-range selection leaves TEAM.md byte-identical.

**PO step-8 gate (test-review Conditions A-1/A-2):** ✅ satisfied — both fault-injection unit
tests landed in `retro-apply.test.ts`:
- A-1: AC 5 defect signal — claimed placement + byte-identical content downgrades to
  `unplaced` ("apply reported success but content unchanged"); all-`already-present`
  re-run correctly NOT downgraded.
- A-2: AC 8 — failing apply commit is noted in the report, not silently absorbed.

## 4. Defects Found & Resolved During Sprint

- No feature-logic defects survived to step 8; TDD caught matching/fence edge cases at
  implementation time (all covered by the 47 tests above).
- **Process note:** steps 3 and 7 each escalated twice on `monthly spend limit` transient
  errors before succeeding on retry — exactly the transient-vs-deterministic class Sprint 12's
  circuit-breaker work targets; spend-limit pattern may be worth adding to
  `TRANSIENT_ERROR_PATTERNS` (flagged for retro).

## 5. Demo Materials

- `scripts/demo-sprint-13.ts` — runnable walkthrough (incident-shape fixture, idempotent
  re-run, retro-doc fill, fence trap). Sandbox blocked live tsx execution at demo time;
  equivalent behavior was demonstrated via the verbose test run of the same fixtures.

## 6. Definition of Done Status

- [x] All tests pass (728/728, 40 suites; `tsc` clean per QA verification commit `55955aa`)
- [x] PR #30 open with QA test evidence
- [x] Peer review (Architect + QA) — handoffs recorded on branch
- [x] PO test-review conditions A-1/A-2 verified at step 8
- [x] Demo conducted (this document)
- [ ] PO/stakeholder acceptance — **pending demo feedback**
- [ ] Merge (step 9)

## 7. Feedback

*(Collected verbatim at demo review — pending)*
