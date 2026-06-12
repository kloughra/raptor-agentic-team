---
slug: orchestrator-recovery-after-mixed-completion
artifact: po-test-review
status: changes-requested
sprint: 10
reviewer: Petra (PO)
---

# PO Test Review — orchestrator-recovery-after-mixed-completion

**Decision: CHANGES REQUESTED. Engineer should NOT begin implementation until QA re-binds the simulated assertions to production seams (see Required Changes).**

## Scope of Review

- Spec: `docs/specs/orchestrator-recovery-after-mixed-completion.md`
- Architecture: `docs/architecture/orchestrator-recovery-after-mixed-completion.md`
- BDD: `tests/bdd/orchestrator-recovery-after-mixed-completion.feature` (17 scenarios across all 12 ACs + 6 edge cases)
- Integration: `tests/integration/orchestrator-recovery-after-mixed-completion.integration.test.ts` (~18 describe blocks)

## Headline

The **BDD scenarios are excellent** — faithful, one-to-one with every AC and edge case. No changes requested there.

The **integration suite has a structural gap**: for the feature's *core* behaviors it asserts against **test-local re-implementations of the logic under test**, not the production code paths the ACs name. Those tests pass green today — before a single line of `runner.ts` is changed — which is the opposite of what a TDD gate must do. The acceptance guarantee ("these tests are RED until the fix lands, GREEN after") does not hold for AC #1, #5, #6, #7, the AC #11 resume-instruction clause, and the `approve`/invalid-slug edges.

This is correctable and the fix is well-supported by the architecture (the relevant branches are headless-testable — see below).

## Acceptance Criteria → Test Coverage

| AC | BDD | Integration assertion | Verdict |
|----|-----|-----------------------|---------|
| #1 — terminal Merge PR step flips `feature.status="complete"` | ✅ scenario present | ❌ Asserts on **local** `completeFeatureViaTerminalStep`, which hardcodes `f.status="complete"` — the exact line under test. Never calls/observes `runMergeStepForFeature`. | **Reject** |
| #2 — mixed sprint finalizes `escalated` | ✅ | ✅ Real `deriveSprintStatus` | Accept |
| #3 — all-complete finalizes `complete` | ✅ | ✅ Real `deriveSprintStatus` + `allFeaturesComplete` | Accept |
| #4 — `resume_sprint` exposes optional `feature` | ✅ | ⚠️ Checks `resumeSprint` arity ∈ [4,6] + `resumeSprintTool` is a function. Optional **trailing** params don't count toward `Function.length`, so this neither proves nor disproves the new arg. Does not assert the Zod schema exposes `feature`. | **Reject (weak proxy)** |
| #5 — implicit single-target resume | ✅ | ❌ Asserts on **local** `resolveResumeTarget`, not real `resumeSprint` | **Reject** |
| #6 — explicit multi-target resume + error | ✅ | ❌ Asserts on **local** `resolveResumeTarget` | **Reject** |
| #7 — per-feature reset + feedback injection | ✅ | ❌ Asserts on **local** `applyRequestChangesReset`; feedback-injection test asserts a local `reEnter` stub returns its own argument (tautology) | **Reject** |
| #8 — sibling preserved | ✅ | ⚠️ Assertion shape (byte-for-byte sibling unchanged) is right, but driven by the local reset sim, not real resume | **Reject (re-base on real resume)** |
| #9 — re-escalation, no cap | ✅ | ⚠️ in-progress→escalated leg uses real `deriveSprintStatus` (good); reset legs use local sim | **Partial** |
| #10 — no silent advance to steps 10–13 | ✅ | ✅ Real `deriveSprintStatus` gate | Accept |
| #11 — escalated reporting names feature, step, **and resume command** | ✅ | ⚠️ Real `renderProgressTable` checked for feature name + "escalat" + step name (good), but **the `resume_sprint --action=request-changes [--feature=<slug>]` instruction clause is unverified anywhere** | **Reject (missing assertion)** |
| #12 — resume searches `features[i].steps`; stale errors gone | ✅ | ✅ Real state structure + real `deriveSprintStatus` | Accept |
| Edge: approve-on-escalated redirect, no mutation | ✅ | ❌ Asserts on a `redirect` **literal the test itself authored** + a `before===after` snapshot around a no-op the test performed. Never calls real `resumeSprint(action="approve")`. Tautology. | **Reject** |
| Edge: unknown / non-escalated `feature` slug | ✅ | ❌ Asserts on **local** `resolveResumeTarget` | **Reject** |
| Edge: genuinely in-progress refused | ✅ | ✅ Real `deriveSprintStatus` (+ local sim for the resolve leg) | Accept (tighten) |
| Edge: single-feature path unchanged | ✅ | ⚠️ Manipulates a real `SprintState` but asserts the reset by performing it inline, not via real `resumeSprint` | **Reject (re-base on real resume)** |

## Why this matters (and why it's fixable)

A test that re-implements the behavior in a local helper and then asserts the helper behaves as written validates nothing about production. `completeFeatureViaTerminalStep`, `resolveResumeTarget`, and `applyRequestChangesReset` will assert correctly forever, whether or not `runner.ts` is ever touched. The suite's own docstring says these are "probed via dynamic import so the suite passes before wiring and tightens once it lands" — but only AC #4 does any dynamic import, and nothing in the suite references the real `runMergeStepForFeature` transition or the real `resumeSprint` routing, so there is no path by which these "tighten once it lands."

**The good news:** the architecture (and runner.ts:1126–1162) confirms the routing/validation branches of `resumeSprint` **return before any agent spawns** — missing-feedback, no-escalated-step-found, and (per the design) multi-target-without-`feature`, unknown slug, non-escalated slug, and approve-on-escalated all short-circuit with a `{status:"error", …}` result. These are **headless-testable against the real function** by crafting an on-disk escalated multi-feature `SprintState` and calling the real `resumeSprint`/`resumeSprintTool`. QA does not need a live agent or a live git merge to cover them.

## Required Changes (QA owns the test design; these are the binding gaps)

1. **AC #5, #6 + unknown/non-escalated-slug edges → drive the REAL `resumeSprint`.** Persist a crafted escalated multi-feature `SprintState` (via the established harness convention used by `multi-feature-sprint-dispatch.integration.test.ts`) and assert the real function's returned `{status:"error", message}` for: (a) >1 escalated, no `feature` → message lists all escalated slugs and tells the user to pass `feature`; (b) unknown slug → error names valid escalated slugs; (c) existing-but-not-escalated slug → error names valid escalated slugs; (d) exactly-one-escalated, no `feature` → routes to that feature. Remove the local `resolveResumeTarget` (or import it as a real exported helper if the Architect/Engineer choose to extract one — then test the real export).

2. **Approve-on-escalated edge → call the REAL `resumeSprint(action="approve")`** on a crafted escalated state; assert the returned redirect message (mentions `request-changes`, "cannot finalize"/equivalent) AND that the persisted state file is byte-for-byte unchanged. Delete the hand-authored `redirect` literal assertion.

3. **AC #7 → assert the REAL reset.** After the real `resumeSprint` request-changes path runs, assert the persisted state shows `attempts=0`, `failures=[]`, step `status="pending"`, `feature.status="in-progress"`, `state.status="in-progress"` on the escalated feature's step under `features[i].steps`. For the feedback-injection assertion, bind to the real injection seam (the architecture names the existing attempt-1 mechanism in `runAgentStepCycle`) rather than a local `reEnter` stub returning its own argument. If the subsequent live re-entry can't run headless, use the repo's **skip-gracefully-against-real-code** pattern (per the Sprint 9 `dev-loop-rebuild-friction` precedent) — `console.warn` + early-return that enforces once wired — NOT a local re-implementation.

4. **AC #8 + single-feature edge → re-base on the real resume.** Fold the "sibling untouched" byte-for-byte snapshot into the real-`resumeSprint` test from item 3 (assert the completed sibling's serialized state is unchanged after the real reset). Same for the single-feature top-level reset path — assert via the real `resumeSprint` escalated branch, not an inline reset.

5. **AC #1 → do not assert on `completeFeatureViaTerminalStep`.** That helper hardcodes the transition under test. Bind to the real `runMergeStepForFeature` effect. If a live merge cannot run headless, coordinate with the Architect/Engineer on a testable seam (the design states the transition lives at the terminal-step site in the dispatcher) and use the skip-gracefully-against-real-code pattern so the assertion enforces once the transition lands. The real `deriveSprintStatus` tests (AC #2/#3/#10) are the downstream guard and are fine — but they do not substitute for verifying the upstream transition that produces `feature.status="complete"`.

6. **AC #4 → assert the actual tool surface.** Replace the arity check with an assertion that the registered `resume_sprint` tool schema exposes an **optional** `feature` string field, and that `resumeSprintTool` accepts and forwards it to `resumeSprint`. (`Function.length` ignores optional trailing params, so the current check can't catch a missing arg.)

7. **AC #11 → add the missing assertion.** Assert that the escalated reporting (the real `renderProgressTable` output and/or the runner's escalated return message, per architecture §Reporting) instructs `resume_sprint --action=request-changes [--feature=<slug>]`. Today no assertion covers this clause of AC #11.

## What is genuinely out of reach (and the acceptable bar)

The full live-agent retry loop and the live `gh`/`simple-git` PR merge cannot run headless. For those, the accepted bar in this repo is: **bind to the real seam with a skip-gracefully guard, or gate on the demo / live-claude-smoke path** — never assert on a test-local copy of the logic. The pure reducer (`deriveSprintStatus`) and the early-returning resume validation/routing branches are NOT in this category; they must be tested against real code.

## Out-of-Scope Items Correctly Excluded

- No `reset_sprint` tool test (separate Ready item). ✅
- No circuit-breaker-threshold/config test (Out of Scope). ✅
- No cross-feature-dependency test (Out of Scope). ✅
- No backfill/migration test for Sprint 9 incident state files (Out of Scope). ✅

## Pre-existing Stub File

`tests/integration/orchestrator-recovery-after-mixed-completion` (extension-less marker) is the documented workaround for the deferred `expected-outputs-glob-resolution` / `artifact-injection-directory-handling` bugs. Not test code; Jest does not execute it. No action required this sprint.

## Open Question still pending (does not block this review)

The additive `feature` arg on `resume_sprint` is a user-authority tool-surface change (spec Open Question; architecture recommends approve). The Architect is proceeding on the assumption it's accepted. This review's verdict is independent of that confirmation, but the Engineer should not finalize the tool registration until the user confirms.

## Decision

**Changes requested.** BDD coverage is approved as-is. The integration suite must re-bind the simulated assertions (AC #1, #4, #5, #6, #7, #8, #11-instruction, approve/invalid-slug edges) to the production seams named in the architecture before it can serve as the acceptance gate. Once QA re-binds and the suite goes RED against current `main`, hand back to PO for re-review, then to Engineer for implementation.
