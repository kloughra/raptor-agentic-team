---
slug: branch-protection-merge-lockout
artifact: test-review
sprint: 18
reviewer: Product Owner
status: changes-requested
---
# PO Test Review — Branch-Protection Merge Lockout (Sprint 18, Step 4)

Review of QA's test cases (`tests/bdd/branch-protection-merge-lockout.feature`,
`tests/integration/branch-protection-merge-lockout.integration.test.ts`) against the
12 acceptance criteria, edge cases, and the architecture contract (C1–C8, NFRs) in
`docs/specs/branch-protection-merge-lockout.md` /
`docs/architecture/branch-protection-merge-lockout.md`.

**Verdict: CHANGES REQUESTED** — one required addition. Approve on completion.

## AC → coverage map

| AC | Covered by | Verdict |
|----|-----------|---------|
| 1 — BP signatures in registry, paired `action` | `classifyFailure + resolveUserAction` (it.each specimens); registry "contains ≥1 BP entry beyond billing seed" | ✅ |
| 2 — specimen classes (policy / protected / review / code-owner / lock_branch) | 7 specimens in both BDD Examples and `BRANCH_PROTECTION_SPECIMENS` | ✅ |
| 3 — escalate after exactly one attempt | `[RED:SF]` asserts `ghMergeInvocations==1`, `attempts==1`, `failures==1` | ✅ |
| 4 — both seams identical | `[RED:MF]` drives the REAL `runMergeStepForFeature` via multi-feature dispatch | ✅ |
| 5 — message names PR + action | `[RED:SF]` message asserts + `buildMergeLockoutEscalation` units (incl. null-PR) | ✅ |
| 6 — persisted, rides notification | `[RED:SF]` reload-from-disk + `[RED:NOTE]` `deriveNotificationEvent` | ✅ |
| 7 — distinct escalation reason | `escalationReason === "user-actionable"`; parity asserts distinct | ✅ |
| 8 — non-BP failures unchanged (parity) | `[GUARD-RED]` retries to `MAX_RETRY_ATTEMPTS`, no detail written | ✅ |
| 9 — reuses escalated/resume machinery | status assertions + "no new status/tool"; resume re-engagement BDD-only | ⚠️ minor |
| 10 — classification stamped on record | `failures[0].classification` / `signature` asserted | ✅ |
| 11 — real seams + RED notes | REAL `runSprintFromStep` at both seams; per-test `[RED:*]` notes | ✅ |
| 12 — deterministic, no `/g` | registry contract + repeatability tests | ✅ |
| Edge — bare "not mergeable" guard (C4) | `[RED:CLS/C4]` | ✅ |
| **Edge — lockout on attempt 2+ (C1)** | **BDD scenario only — NO integration test** | ❌ REQUEST |

Non-applicable test categories correctly **recorded, not silently skipped**:
Playwright E2E (no UI surface) and performance (NFR-2 is a `gh pr merge` count
assertion, no numeric latency threshold). Both waivers accepted.

## Required change (1)

**Add an executable integration test for the attempt-2+ edge case (C1 / spec Edge
Case "Lockout on attempt 2+").** The BDD feature has the scenario (feature lines
149–156) and the architecture names it as constraint **C1** (*escalate-now dominates
the merge budget — the check keys off the current failure's classification, not the
attempt counter*), but the integration suite never drives it. This is precisely the
mutation-survivable false-green class the Sprint 16/17 retros flag: an implementation
that guarded the short-circuit behind `attempts === 1` (escalate only on the *first*
attempt) would pass every existing test yet violate C1.

The added test must pin: step 9 fails once with an ordinary (non-BP) error, the next
`gh pr merge` is refused by branch protection → escalation fires immediately on that
second failure (**2 attempts spent, not 3**), `escalationReason === "user-actionable"`,
and the persisted `escalationDetail` names the PR + action. QA owns the exact
assertions and its own RED-verification note (would FAIL if the check were placed
after the attempt-counter branch).

## Optional / non-blocking

- **AC 9 resume re-engagement.** Asserted at BDD level; the integration suite pins the
  `escalated` status and the "no new status/tool" invariant but does not drive a
  resume-after-lockout that re-engages the merge step. Existing resume tests cover the
  machinery, so this does not block acceptance — a resume-re-engages-merge assertion
  would fully close the AC-9 loop if cheap to add.

## Sign-off

All 12 ACs are reflected accurately and the production-seam + RED-verification
discipline is met. On addition of the C1 attempt-2+ integration test, this review
flips to **approved** and the sprint proceeds to Step 5 (Engineer implementation).

No new deferred items surfaced during this review (nothing spun off or scoped out).
