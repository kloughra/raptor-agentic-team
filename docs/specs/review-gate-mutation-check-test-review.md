# PO Test Review — review-gate-mutation-check

**Reviewer:** Petra (PO) · **Date:** 2026-07-15 · **Decision:** Approved with one required verification (R1)

## AC coverage

| AC | Covered by | Verdict |
|----|-----------|---------|
| 1 mutation directive on primary seam | `directs a mutation test...` | ✅ |
| 2 RED = pass, green-under-mutation = FAIL | `[RULE-RED] states the pass/fail rule` | ✅ |
| 3 structured evidence surfaced | `requires a structured evidence block` (SEAM/MUTATION/RED EVIDENCE/RESTORED) | ✅ |
| 4 restore-and-verify | `requires restore-and-verify` | ✅ |
| 5 per-independent-seam guidance, no countable rule | `gives per-independent-seam guidance` | ✅ |
| 6 composes, never replaces | `buildStep7GateInstruction` composition tests | ✅ |
| 7 both seams via shared builder | single- AND multi-feature real-seam tests | ✅ (see R1) |
| 8 no-seam branch | `states a no-mutable-seam branch` | ✅ |
| 9 tests exercise real prompt + RED notes | real-seam tests + RED-verification header | ✅ |
| 10 self-consistent dogfood | real-seam assertions are mutation-killable (revert injection → RED) | ✅ |

## R1 (required verification — blocking)

**The multi-feature seam test must provably exercise the `runner.ts:1889` seam, not the single-feature `:1125` seam.** `seedMultiFeature` uses a one-element `features[]` array; if the dispatcher routes a single-element features sprint through the single-feature path, reverting *only* the multi-feature injection would leave the test green — a per-seam false-green, which is precisely the defect class this feature exists to eliminate. It would be self-refuting for our own gate feature to ship that gap.

**Required:** during implementation, mutation-verify each seam **independently** — revert ONLY the `:1889` injection and confirm the multi-feature test goes RED while the single-feature test stays GREEN, and vice-versa for `:1125`. Record the evidence in the implementation handoff (this is exactly the structured mutation evidence AC 3 demands — dogfood it).

## Notes
- AC 10's dogfood is satisfied structurally: mutating `buildStep7GateInstruction` (drop the mutation section) reddens the composition + both seam tests; reverting a runner injection reddens the corresponding seam test. Good.
- Non-blocking: consider asserting the evidence-block markers appear in `buildStep7GateInstruction()` output too (not only `buildMutationCheckSection()`), to pin that composition doesn't drop them. Optional.
