---
slug: sprint-completes-despite-failed-merge
artifact: po-test-review
status: approved
sprint: 13
reviewer: Petra (PO)
---

# PO Test Review — sprint-completes-despite-failed-merge

**Decision: APPROVED. The BDD feature file and the integration suite are accepted as the acceptance gate for this feature. One required minor amendment (test-file labeling accuracy — three tags/header lines, no test logic changes) is assigned to QA and may land with the implementation PR; it does not block the Engineer from starting step 5. Two non-blocking conditions are tracked to step 7 (PR review) and step 8 (acceptance).**

## Scope of Review

- Spec: `docs/specs/sprint-completes-despite-failed-merge.md` (AC 1–10 + 7 edge cases)
- Architecture: `docs/architecture/sprint-completes-despite-failed-merge.md` (C1–C5; Open Question rulings 1–3 verified against test pins — see provenance below)
- BDD: `tests/bdd/sprint-completes-despite-failed-merge.feature` (17 scenarios)
- Integration: `tests/integration/sprint-completes-despite-failed-merge.integration.test.ts` (13 tests)
- **RED verification executed by PO on 2026-07-06** against current pre-fix `main` control flow: `npx jest tests/integration/sprint-completes-despite-failed-merge` → **10 failed / 3 passed in 4.6s**. Every AC has at least one failing (RED) guard. Details under "RED/GREEN audit" below.

## Headline

This suite continues the Sprint 12 standard and closes the one thing I demanded there: the constraint-guarding tests drive the **real** `runSprintFromStep` step loop and the **real** multi-feature dispatcher, with mocks confined to exactly the two architecture-sanctioned boundaries (`executeMerge`/`updatePrDodChecklist` — Out of Scope mechanics; `spawnAgent` — no real `claude` processes). No test-local reimplementation of the control flow exists anywhere in the file, and the top-of-file comment explicitly forbids widening the mocks (TEAM.md QA rule 12, spec AC #10). The Sprint 10 and Sprint 12 production specimens (false "Sprint complete" with an open PR) are directly replayed and RED today. This is exactly what an acceptance gate for a truthfulness bug should look like.

## Architect-ruling provenance check (pins are real, not invented)

Every value and behavior the tests pin traces to an explicit architecture ruling:

| Test pin | Architecture source |
|---|---|
| Guard/gate trips map to `"escalated"` (not `failed`/`in-progress`) | Constraint 5 (Open Question 3 ruling) |
| Guard trip creates **no** `[ESCALATE]` commit; message names offending step/feature | C3/C4 + API Contracts table + NFR 6 |
| `failures[].classification` / `.signature` populated on merge failures | C5 (additive; fields already optional on `FailureRecord`) |
| No `decideAfterFailure` short-circuit for merges — 3 identical attempts burn fully | Constraint 6 (Open Question 2 ruling); deterministic-failure test correctly asserts 3 full attempts |
| No retry delay/backoff asserted | NFR 2 + spec Out of Scope |
| Bounded loop ≤ `MAX_RETRY_ATTEMPTS`; termination via jest timeout + invocation cap | C1/C2 termination proofs, NFR 3 |
| Exactly one `[HANDOFF]` on merge success only | Constraint 3, AC #9 |
| No state migration; specimen files load as-is | Data Model + Constraint 11 |

Open Question 1 (pre-merge push) is correctly absent from the suite — the Architect ruled it a Sprint 14 follow-up. I will schedule `push-before-merge` in the backlog Ready section per that recommendation.

## Acceptance Criteria → Test Coverage

| AC | BDD | Integration | RED pre-fix? | Verdict |
|----|-----|-------------|--------------|---------|
| 1 — in-place retry (single) | ✅ | ✅ 2 invocations, no index advance (merge calls strictly precede first agent spawn), step 9 `complete`/attempts=2, persisted state agrees | ✕ RED | Accept |
| 2 — failure accounting | ✅ ×3 | ✅ attempts == invocation count pinned without hardcoding; `ERROR_SUMMARY_MAX_LENGTH` truncation on every record | ✓ passes both (preservation AC — see audit) | Accept |
| 3 — escalation at cap | ✅ | ✅ exactly 3 invocations, step+sprint `escalated`, `[ESCALATE]` commit, `spawnAgent` never called, steps 10–13 `pending` | ✕ RED | Accept |
| 4 — finalization guard | ✅ | ✅ hand-crafted invariant violation (Sprint 10/12 shape) driven to finalization; forbids `complete`, names step 9, `escalated` per OQ3 ruling | ✕ RED | Accept |
| 5 — multi-feature retry honored | ✅ ×2 | ✅ feat-a merged twice in place, both features `complete`; escalated-park covered in the mixed test | ✕ RED | Accept |
| 6 — shared-step gate | ✅ | ✅ hand-crafted non-terminal feature at step 10 boundary; no spawn, not `complete`, not `in-progress` limbo, message names the feature | ✕ RED | Accept |
| 7 — escalated merge resumable | ✅ | ✅ re-enters at step 9, completes on now-succeeding merge | ✕ (precondition is post-fix — see audit) | Accept with Condition B |
| 8 — sibling isolation | ✅ | ✅ A: 1 invocation, attempts=1, zero failures, untouched; B: 3 attempts → escalated; handoff for A only; `[ESCALATE]` names B | ✕ RED | Accept |
| 9 — DoD/PR truthfulness | ✅ | ✅ no step-9 handoff, no "Sprint complete" in result; handoff-count assertions repeated in every retry test | ✓ passes both (RED proof carried by AC #3/#4 guards — see audit) | Accept |
| 10 — production seam | ✅ (header contract) | ✅ verified structurally (real runner/dispatcher, sanctioned mocks only) **and** empirically (RED run above) | n/a | Accept |

### Edge cases

| Edge case | Coverage |
|---|---|
| Fails exactly `MAX_RETRY_ATTEMPTS` | ✅ integration (escalation test) |
| Fails then succeeds (attempt 2 AND attempt 3) | ✅ both covered, single `[HANDOFF]` asserted each time |
| Deterministic failure burns 3 attempts, escalates cleanly | ✅ + C5 classification/signature persisted |
| `branchName` missing → hard-fail unchanged | ✅ BDD; ➖ integration deliberately omitted with documented rationale (unreachable through the production seam post-Sprint-8 branch-auto-create without a forbidden `ensureFeatureBranch` mock) — **Condition A** |
| Pre-fix state file loads, no auto-repair | ✅ `[no-regression]`, correctly GREEN pre-fix |
| Multi-feature mixed A-merges/B-fails | ✅ (sibling-isolation test) |
| Retry loop terminates | ✅ bounded-invocation + jest-timeout proof |

### Test categories (TEAM.md QA rule 4)

Performance and Playwright E2E tests are not authored, consistent with every prior sprint of this repo: the feature is orchestrator-internal control flow on a headless MCP server (no UI surface), and the architecture introduces **no timing surface** (NFR 2: no timers, no backoff — worst case is 2 extra sub-5s merge invocations). BDD + integration are the applicable categories. Accepted.

## RED/GREEN audit (PO-executed, 2026-07-06)

Result: **10 ✕ / 3 ✓** against pre-fix `main`. Every constraint in the design invariant has at least one RED guard. Three labeling inaccuracies in the file's self-documentation must be corrected so the audit header stays truthful — fitting, for a feature whose entire point is truthful status:

1. **AC #2 accounting test** (`attempts count equals executeMerge invocation count`) **passes pre-fix** — the invariant holds trivially at 1 invocation/1 attempt. That is correct and expected for a *preservation* AC ("existing behavior unchanged"), but per the file's own convention it must carry the `[no-regression]` (or equivalent `[invariant]`) tag.
2. **AC #9 truthfulness test** (`never claims the merge happened after escalation`) **passes pre-fix**: in this harness the pre-fix sprint parks `paused` at the step-11/12 checkpoint before ever reaching the lying finalization, so `not "complete"` holds on both sides. The RED proof for the truthfulness constraint is carried by the AC #3 escalation test and the AC #4 finalization-guard test (both ✕). Tag this test `[no-regression]` and add one header line noting where its RED coverage lives. (Historical note: the production specimens reached "Sprint complete" because real runs resume through checkpoints — the harness parks instead. No test-logic change required; the constraint is guarded.)
3. **AC #7 resume test is mistagged `[no-regression]`** — it FAILS pre-fix because its precondition (`first.status === "escalated"`) depends on the fix existing. The header's claim that `[no-regression]` tests "pass both before and after" is therefore false for this one. Retag (e.g. `[post-fix precondition, AC #7]`) or amend the header.

**Required Minor Amendment (QA, non-blocking):** land the three labeling corrections above — comment/tag changes only, zero assertion changes. May be included in the implementation PR; the Engineer does not wait on it.

## Conditions (non-blocking, tracked forward)

- **Condition A (step 7, Architect):** the missing-`branchName` hard-fail (`runner.ts:912-922`, `2283-2288`) has a BDD scenario but no executable integration backing, per QA's documented and sound rationale. Architect must confirm at PR review that both hard-fail sites are textually unchanged, as the architecture's "Unchanged components" table asserts.
- **Condition B (step 7, QA test report):** AC #7's integration test drives `runSprintFromStep` re-entry directly, which is the runner-owned seam; the `resume_sprint` tool-layer validation is guarded by the existing Sprint 10 suite (`orchestrator-recovery-after-mixed-completion.integration.test.ts`). QA's step-7 test report must confirm that suite (and the Sprint 7 merge suite covering `executeMerge` internals) still passes, closing AC #7's "no regression to those flows" clause end-to-end.

## Out-of-Scope items correctly excluded

- No changes asserted to `executeMerge` mechanics, `MAX_RETRY_ATTEMPTS`, or squash strategy. ✅
- No state-file migration — specimen preserved as-is, load-only assertion. ✅
- No retry delay/backoff assertions. ✅
- No `decideAfterFailure` wiring for merges (OQ2 ruling honored; C5 persistence-only pins present). ✅
- `sprint-result-status-hardcoded-escalated` not smuggled in. ✅

## Decision

**Approved.** The BDD feature file is approved as-is. The integration suite is approved as the acceptance gate, with the Required Minor Amendment (three labeling corrections, QA-owned, may land with the implementation PR) and Conditions A/B tracked to step 7. Engineer may begin step 5 (Implement, TDD) immediately: the suite is RED against `main` for exactly the right reasons and will turn GREEN only when C1–C4 (and C5's additive enrichment) are correctly implemented.
