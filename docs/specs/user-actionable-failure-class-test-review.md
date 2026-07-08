---
slug: user-actionable-failure-class
status: changes-requested
sprint: 15
reviewer: Petra (PO)
step: 4 (PO test review)
date: 2026-07-07
---
# PO Test Review — user-actionable-failure-class

**Verdict: CHANGES REQUESTED** (one required change; one cleanup). The
classification core is well-covered; the gap is at the two production runner
escalate seams, which TEAM.md QA rule 12 and the architecture explicitly require
to be tested.

## Artifacts reviewed
- `docs/specs/user-actionable-failure-class.md` (AC 1–13)
- `docs/architecture/user-actionable-failure-class.md`
- `tests/bdd/user-actionable-failure-class.feature`
- `tests/integration/user-actionable-failure-class.integration.test.ts`
- Source seams: `failure-classification.ts`, `runner.ts:391` (`decideAfterFailure`),
  `runner.ts:501` (`processFailureAndDecide`), `runner.ts:1302–1305` (single-feature
  escalate message), the multi-feature message builder.

## AC coverage matrix

| AC | Requirement | Covered? | Where |
|----|-------------|----------|-------|
| 1 | New `"user-actionable"` union member | ✅ | classifyFailure unit + import compile-RED |
| 2 | Classifier detects; NOT transient/deterministic | ✅ | "NOT transient and NOT deterministic"; precedence test |
| 3 | Extensible, code-only, enumerable registry | ✅ | registry describe block |
| 4 | Two seed patterns (billing, invalid-model) | ✅ | billing/invalid-model seed tests |
| 5 | Escalate after exactly one attempt | ✅ | decideAfterFailure first-attempt + `runRetryLoop` attemptsSpent===1 |
| 6 | New escalation reason | ✅ | `esc.reason).toBe("user-actionable")` |
| 7 | **Message names the action, surfaced to the user** | ⚠️ **PARTIAL** | pure `resolveUserAction` + `decideAfterFailure.detail` only — **NOT the runner message seams** |
| 8 | **Wired into BOTH retry loops, no fork** | ⚠️ **INADEQUATE** | "both loops parity" test calls the *same pure fn twice* — tautology, exercises neither loop |
| 9 | Stamped on FailureRecord at record time & persisted | ⚠️ mostly | `classifiedFailure`/old-state tests cover it; `processFailureAndDecide` seam re-implemented in harness, not driven (it is private — acceptable, but the runner-seam tests in Change 1 also close this) |
| 10 | Resumable `escalated` state, no new status | ✅ | old-state load test + escalationReason assertion |
| 11 | Tests drive the real pipeline; RED notes | ✅ (for the covered surface) | `runRetryLoop` drives real classify+decide; thorough RED-VERIFICATION header |
| 12 | Default-off / no-regression parity | ✅ | no-regression describe block, MAX_RETRY_ATTEMPTS still 3, transient unchanged |
| 13 | Pure, no deps, no `/g` | ✅ | registry flags assertion + classifier unit |

## Required change (BLOCKER — must fix before test approval)

**1. Add production-seam coverage for the two runner escalate-MESSAGE seams (AC 7 + AC 8).**

The integration test header states the message rendering at the two runner
escalate seams is "covered by colocated runner unit tests" — **but no such tests
were authored** (`276bf0d` produced only the BDD + integration files; `runner.test.ts`
has zero user-actionable coverage). This is not a stylistic nit:

- At `runner.ts:1302–1305` the single-feature escalate message is built by a
  ternary whose else-arm prints `"transient cap"` for any reason that is not
  `attempts-exhausted`/`no-progress`. A `user-actionable` reason therefore
  **mislabels** at the user-facing seam today, and **nothing would catch it**.
  The multi-feature message builder is a second, independent such seam.
- TEAM.md QA rule 12: tests guarding an architectural constraint or asserting
  parity between two code paths MUST exercise the **production seam**, not only
  the underlying pure function. The architecture §Constraints repeats this: "QA
  must assert parity at **both** production seams (TEAM.md rule), not only on the
  pure classifier."

Add runner-seam tests (each carrying its own RED-verification note per rule 12)
that:
- drive the **real single-feature** runner escalate path for a user-actionable
  failure and assert the **surfaced message** names the concrete action
  (`claude.ai/settings/usage` for billing; `models.byRole` / `models.default` in
  `~/.raptor/config.json` for invalid-model) and that `escalationReason ===
  "user-actionable"` is persisted;
- do the same at the **multi-feature** seam, so AC 8's "both loops behave
  identically" is asserted at the two real seams. RED baseline: pre-change the
  message arm mislabels user-actionable as "transient cap" and/or drops the
  actionable detail.

## Cleanup (should fix, not a hard blocker)

**2. Relabel or remove the "both loops parity" integration test.** As written
(`const a = decideAfterFailure(...); const b = decideAfterFailure(...);
expect(a).toEqual(b)`) it asserts a pure function is deterministic — it does not
test that the single- and multi-feature loops behave identically. The genuine
AC-8 parity assertion belongs at the two runner seams (Change 1). Keep the pure
determinism check if desired, but rename it so it doesn't claim two-loop parity.

## Not blocking (noted for the record)
- **No performance / Playwright E2E tests.** Consistent with the established
  convention for pure-logic orchestrator features (Sprint 12
  `progress-aware-circuit-breaker`, Sprint 13 items): no UI surface (E2E N/A) and
  the NFR is a sub-millisecond synchronous regex loop. Accepted per precedent.
- The billing/invalid-model classification, registry shape, `resolveUserAction`
  first-match-wins, precedence (user-actionable > transient), salvage-still-wins
  ordering, attempt-count contrast, and old-state backward-compat are all
  **well-covered** and map cleanly to their ACs. Good work on the RED-verification
  header and the `runRetryLoop` harness driving the real classify+decide seam.

## Disposition
Return to QA (step 3) to add the runner-seam message/parity tests (Change 1) and
tidy the mislabeled parity test (Change 2). Re-review on handoff back. No AC or
spec changes — the ACs already demand this coverage; the tests simply need to
reach the two production seams.
