---
slug: progress-aware-circuit-breaker
artifact: po-test-review
status: changes-requested
sprint: 12
reviewer: Petra (PO)
---

# PO Test Review — progress-aware-circuit-breaker

**Decision: CHANGES REQUESTED — narrowly. The BDD feature file is approved as-is. The integration suite is structurally sound (real production seams, RED-until-implemented) and ~90% approved; three targeted gaps must close before it can serve as the acceptance gate. Engineer should NOT begin implementation until QA lands the three items below and hands back for re-review.**

## Scope of Review

- Spec: `docs/specs/progress-aware-circuit-breaker.md` (AC 1–22)
- Architecture: `docs/architecture/progress-aware-circuit-breaker.md` (rulings verified — see below)
- BDD: `tests/bdd/progress-aware-circuit-breaker.feature` (32 scenarios across CB-1..CB-5 + cross-cutting)
- Integration: `tests/integration/progress-aware-circuit-breaker.integration.test.ts`

## Headline

This suite is a major step up from the Sprint 10 review (`orchestrator-recovery-after-mixed-completion-test-review.md`). Every integration assertion imports the real production surface (`classifyFailure`, `deriveFailureSignature`, `decideAfterFailure`, `checkSalvage`, `loadConfig`, `loadSprintState`, `HARD_CEILING_MS`) — no test-local re-implementations anywhere. The suite is properly RED today (the imports don't exist yet) and will tighten exactly as the Engineer wires each export. The Sprint 11 loss class (agent finishes work, gets killed, work discarded) is directly replayed against a real filesystem. Well done.

Three gaps remain, and one of them is load-bearing: as written, the AC 20 "end-to-end" test would stay GREEN even if the Engineer leaves all 4 runner call sites unwired — which is the *exact production bug CB-5 exists to fix*.

## Architect-ruling provenance check (pinned constants are real, not invented)

Every constant and ordering rule QA pinned traces to an explicit ruling in the architecture doc:

| QA pin | Architecture source |
|---|---|
| `TRANSIENT_RETRY_CAP = 5`, `TRANSIENT_RETRY_DELAY_MS = 15_000` | §1 (Open Question 2/3 rulings) |
| `HARD_CEILING_MS = 60 min`, `MAX_TIMEOUT_MS` stays 30 min | §3 (Open Question 3 ruling) |
| Idle/ceiling kills classify deterministic; own signature classes | §4 (Open Question 4 ruling) |
| Ordering: BLOCKER > record > salvage > transient > short-circuit > slots | §Overview (Open Question 5 ruling) |
| Signature classes + message shapes (`idle-timeout`, `hard-ceiling`, `stdin-wait-warning`, `missing-outputs:<sorted>`, …) | §1 derivation + §API Contracts message table |
| Persisted signatures; legacy no-signature records never match | Constraint 4 |
| `attempts` semantics frozen; transient count derived | Constraint 3 |
| stdout-only liveness | Constraint 9 |

⚠️ Note: the architecture's constants block is itself pending **user approval** (Architect flagged it per process). If the user adjusts the 60-min ceiling / cap 5 / 15 s delay, the pinned tests change values but not shape. This does not block QA's re-work.

## Acceptance Criteria → Test Coverage

| AC | BDD | Integration | Verdict |
|----|-----|-------------|---------|
| 1 — identical-signature short-circuit | ✅ | ✅ real `decideAfterFailure`: escalate `no-progress`, message shows signature | Accept |
| 2 — stdin-wait signature class | ✅ | ✅ real `deriveFailureSignature` + 2-attempt short-circuit | Accept |
| 3 — different signatures don't short-circuit | ✅ | ✅ | Accept |
| 4 — distinguishable marker | ✅ | ✅ `reason: "no-progress"` vs `"attempts-exhausted"` on decisions; legacy-state `escalationReason` compat | Accept |
| 5 — classification at record time, persisted | ✅ | ✅ `classifyFailure` + state-file compat suite | Accept |
| 6 — transient consumes no slot; extensible registry | ✅ | ✅ `consumesSlot: false` + enumerable `TRANSIENT_ERROR_PATTERNS` | Accept |
| 7 — transient cap escalates | ✅ | ✅ 5th transient → `transient-cap`, message names infrastructure | Accept |
| 8 — deterministic = today's behavior | ✅ | ✅ slot accounting suite; `MAX_RETRY_ATTEMPTS` still 3 | Accept |
| 9 — legacy records → deterministic | ✅ | ✅ real `loadSprintState` on a hand-crafted pre-Sprint-12 file | Accept |
| 10 — idle deadline resets on stdout | ✅ | ➖ deferred to `agents.test.ts` fake-timer units per architecture test-surface map | Accept with condition A |
| 11 — idle-kill message distinguishable | ✅ | ⚠️ message shape pinned indirectly via signature-class tests | Accept with condition A |
| 12 — hard ceiling ≥ MAX_TIMEOUT_MS, 30-min cap not raised | ✅ | ✅ constants pinned; `killKind` compile contract | Accept |
| 13 — kill classification + salvage pairing | ✅ | ✅ deterministic classification of idle/ceiling messages; salvage-first ordering | Accept |
| 14 — partial salvage feeds task description | ✅ | ⚠️ `checkSalvage` satisfied/missing lists proven; rendering deferred to `runner.test.ts` per map | Accept with condition A |
| 15 — salvage-complete without new attempt | ✅ Sprint 11 replay | ✅ real-fs replay + ordering-wins tests | Accept |
| 16 — salvage never bypasses validation | ✅ | ✅ wrong-slug files rejected | Accept |
| 17 — `.gitkeep` never satisfies | ✅ | ✅ incl. Sprint 8 EISDIR directory-at-literal-path regression class | Accept |
| 18 — all 4 call sites pass config | ✅ (declarative) | ❌ **no test can fail if a call site omits the config arg** | **Reject — Required Change 1** |
| 19 — `loadConfig` parses `timeouts`; absent key byte-identical | ✅ | ✅ incl. field-wise type-guard drops, malformed key, missing file | Accept |
| 20 — integration test proves end-to-end | ✅ | ❌ stops at `resolveStepTimeout`; runner→spawnAgent leg asserted only in a comment | **Reject — Required Change 1** |
| 21 — existing tests pass; additive-only state | ✅ | ✅ legacy resume suite; `attempts` meaning frozen | Accept |
| 22 — every decision path visible in state AND reporting | ✅ (declarative) | ❌ no assertion on real `renderProgressTable` / escalation-message variants | **Reject — Required Change 3** |
| Edge: det→transient→det still short-circuits | ✅ | ✅ | Accept |
| Edge: narrowing boundary never short-circuits | ✅ | ✅ `narrowed` flag test | Accept |
| Edge: consecutive identical transients ≠ no-progress | ✅ | ✅ | Accept |
| Edge: buffer-overflow unchanged, deterministic | ✅ | ✅ signature class | Accept |
| Edge: tree preservation between attempts | ✅ | ⚠️ proves `checkSalvage` doesn't cache — not that the retry loop performs no checkout/clean/reset (architecture Constraint 7 explicitly demands the loop-level pin) | **Reject — Required Change 2** |
| Edge: single- vs multi-feature parity | ✅ | ⚠️ purity test is necessary but proves only half — see note under Required Change 1 | Accept (tighten via RC 1 harness) |
| Edge: merge-step no regression | ✅ | ➖ regression-only per Constraint 2; existing merge tests are the guard | Accept |

## Required Changes (QA owns test design; these are the binding gaps)

1. **AC 18 / AC 20 — the end-to-end test must be able to FAIL when a runner call site is left unwired.** Today's test proves `config.json → loadConfig → resolveStepTimeout` and then asserts the runner leg *in a comment*. The current production defect is precisely "call sites omit the config argument" (spec provenance table) — a CB-5 suite that stays green with the call sites unwired cannot gate this feature. Bind to the runner leg using the repo's established pattern ("every other test that touches `spawnAgent` mocks `child_process.spawn`" — see `live-claude-smoke-test.integration.test.ts` header): craft a minimal on-disk sprint state, drive one step through the **real** `runSprintFromStep` (or the real dispatch seam the Architect names: `DispatchContext.timeoutConfig`) with a distinctive `stepOverrides` value, and assert that value is the idle window actually armed for the spawned child. If a leg is genuinely headless-infeasible, use the skip-gracefully-against-real-code pattern (Sprint 9 `dev-loop-rebuild-friction` precedent) — never leave the assertion as a comment. This harness also strengthens the parity edge case: run the same step once through each loop's entry.

2. **Tree-preservation invariant — pin at the loop level (architecture Constraint 7).** "Pin with an integration test: attempt N writes a file → attempt N+1's salvage/retry context sees it." The current "does not cache between calls" test exercises `checkSalvage` in isolation; it cannot catch a future checkout/clean/reset introduced *inside the retry loop*. Fold into the Required-Change-1 harness: mocked attempt N writes an expected output and fails; assert attempt N+1 salvage-completes (or receives the salvage section). Skip-gracefully acceptable if the loop cannot be driven headless.

3. **AC 22 — assert the real reporting surface.** `renderProgressTable` is a pure exported function and trivially headless-testable; the architecture names the exact variants: `complete (salvaged)`, `escalated (no progress)`, `escalated (transient cap)`. Craft `StepState`s with `completedVia: "salvage"` / each `escalationReason` and assert the real table output, plus the escalation-message contracts (`retries short-circuited: identical failure signature "…"`, `persistent infrastructure failure: … × 5`). Today AC 22's "visible in reporting" clause has zero executable coverage.

## Condition A (non-blocking, tracked to Step 8 — not a change to QA's step-3 artifacts)

The architecture's test-surface map assigns `spawnAgent` idle/ceiling mechanics (AC 10–11) to fake-timer units in `src/orchestrator/agents.test.ts` and the salvage task-description rendering (AC 14) to `src/orchestrator/runner.test.ts`. Per TEAM.md, colocated unit tests land with the Engineer's TDD work. **PO acceptance at step 8 is conditioned on those unit tests existing and covering the corresponding BDD scenarios** (idle reset per stdout chunk; stderr does NOT reset; ceiling kills a streaming agent; the two kill messages are distinguishable; salvage section lists existing-vs-missing with the do-not-recreate instruction). QA: verify presence at test-execution time and call out any hole in the PR test report.

## Minor editorial (does not block)

- BDD scenario "Idle-kill of an agent that finished its work pairs with salvage" says the salvage check "runs before any classification decision." Per the architecture ordering, classification is *recorded* at step 2, before salvage at step 3; salvage precedes any classification-*based* decision. Suggest rewording to "before any retry/escalation decision" to keep the ordering comment at the top of the feature file authoritative.

## Out-of-Scope Items Correctly Excluded

- No `MAX_TIMEOUT_MS` raise; tests pin it stays 30 min. ✅
- No re-do of the `Write tests` 15→30 bump (`11bf7d4`); pinned as the resolved default, not re-tested as new scope. ✅
- Merge-loop behavior asserted as unchanged only (Constraint 2). ✅
- No config-extensible transient registry (code-only pin). ✅
- No LLM classification anywhere. ✅
- No global `validateStepOutputs` `.gitkeep` fix — only the salvage wrapper is gated. ✅

## Open Questions status (do not block this review)

- Spec Open Question 6 (should salvage-complete force checkpoint review?) is a user call before demo. The suite already pins the auditable `completedVia: "salvage"` marker, so either answer is rework-free. I will put it to the user at the step-8 checkpoint.
- The architecture's constants (60 min / 5 / 15 s, deterministic kill classification) await user confirmation per the Architect's flag. Value-only changes if adjusted.

## Decision

**Changes requested.** BDD approved as-is (modulo the optional editorial note). Integration suite approved except: Required Changes 1–3 (AC 18/20 runner leg, loop-level tree-preservation pin, AC 22 reporting assertions). Once QA lands these and the suite is RED against current `main` for the right reasons, hand back to PO for re-review, then to Engineer for implementation.
