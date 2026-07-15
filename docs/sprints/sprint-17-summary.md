# Sprint 17 Summary — raptor-agentic-team

## Sprint Goal

**Trustworthy review gate** — close the strongest Sprint-16 finding: all three features
that sprint shipped test-adequacy defects the *prose* adversarial gate missed but a
mutation test caught. One feature: **review-gate-mutation-check** — PR #42
(merge `7988d53`). Full suite 1030 → 1064.

## Feature Delivered

- **review-gate-mutation-check** — the step-7 review gate now demands **mechanical
  mutation evidence**, not reasoning about coverage. `buildMutationCheckSection()`
  (`prompts.ts`): mutate the primary production seam → **RED = coverage confirmed;
  green-under-mutation = false-green → FLAG and FAIL**; restore-and-verify; a
  structured `SEAM / MUTATION / RED EVIDENCE / RESTORED` block; per-independent-seam
  guidance (not a countable rule); a no-executable-seam skip for docs/config-only
  changes. `buildStep7GateInstruction()` composes it AFTER the unchanged Sprint-14
  adversarial section (strictly stronger). The runner's shared `injectStep7Gate`
  helper injects the composed instruction at both dispatch seams — one helper, no drift.

## Key Technical Decisions

- **Agent-driven-with-evidence, not a code harness** (OQ1). Same enforcement model as
  Sprint 14 (injected instruction). A deterministic orchestrator-run harness is filed
  as `review-gate-mutation-harness` (Inbox).
- **Separate `buildMutationCheckSection()` composed via `buildStep7GateInstruction()`**
  (OQ3) — keeps the Sprint-14 section and its tests untouched, tests the new section
  in isolation, and gives the runner one injection contract.
- **Structured evidence block** (OQ2) — forward-compatible seam toward a future harness.
- No state-schema change, no new dependency; only the QA step-7 prompt text grows.

## Patterns & Conventions Established

- **The gate now reviews itself.** A feature's step-7 review must mutate the feature's
  own seam(s) and show RED; green-under-mutation blocks the merge.
- **Per-independent-seam mutation.** When a feature has more than one seam (e.g. two
  call sites), each must be mutated independently — breaking one may leave the other's
  tests green (the exact Sprint-16 miss).

## Issues Encountered — the dogfood caught itself

The new mutation check found a defect **in its own tests** during implementation: the
multi-feature seam test seeded a single feature, so the sprint routed through the
single-feature dispatch path and never exercised `runner.ts:1893`. No-oping only the
multi-feature injection left the test GREEN — a per-seam false-green, precisely the
class this feature exists to eliminate. Fixed by seeding two features (`state.features.
length > 1`), then mutation-verified: disabling only `:1893` reddens only the multi
test, and vice-versa. The step-7 review then re-ran all three seam mutations, all RED
with clean discrimination.

The one apparent flaky test (multi-feature seam under parallel jest workers) was a
stale ts-jest cache — 3/3 full runs green after `--clearCache`.

## Deferred Items

- `review-gate-mutation-harness` (Inbox) — a deterministic orchestrator-run mutation
  harness that performs the seam mutation and asserts RED in code, consuming the
  structured evidence block, instead of relying on the verifier agent. Larger; deferred.

## Context for Future Sprints

- Step-7 gate text is built by `buildStep7GateInstruction()` (`prompts.ts`) and injected
  by `injectStep7Gate` (`runner.ts`) at both dispatch seams. Extend the gate there.
- The mutation-evidence standard is now the expectation for every feature's review —
  reviewers should produce the `SEAM/MUTATION/RED EVIDENCE/RESTORED` block.
- Process note: Sprints 16–17 were hand-driven (roles as `[ROLE]`/`[HANDOFF]` commits);
  `main` is branch-locked, so each PR merge requires the user.
