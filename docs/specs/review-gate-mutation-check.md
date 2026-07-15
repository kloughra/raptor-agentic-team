---
slug: review-gate-mutation-check
status: ready
sprint: 17
---
# Review Gate Mutation Check

## User Story

As the Raptor team (and any autonomous driver) relying on the step-7 review gate to
tell the truth about coverage, I want the gate to **demand mechanical mutation
evidence** — proof that the primary production seam under review, when broken, makes
the test suite go RED — so that a feature can no longer pass review with tests that
silently fail to exercise the real system.

## Background

**The gap this closes.** Sprint 14's `adversarial-verifier-review-gate` injects a
static prose instruction (`buildAdversarialGateSection()` in
`src/orchestrator/prompts.ts:126`, appended to the step-7 QA agent at
`runner.ts:1125` single-feature and `runner.ts:1889` multi-feature) telling the
verifier to *hunt* test-local reimplementations and *check* RED-verification notes,
biased toward false-negative. It relies on the verifier **reasoning about** coverage.

That prose gate demonstrably under-performs. In Sprint 16, **all three features
shipped test-adequacy defects the prose gate did not catch — every one surfaced only
when a reviewer ran an actual mutation test**:

1. **surface-tool-errors R1** — a blocking "guard the real `src/index.ts` seam"
   requirement was signed off with an empty-diff handoff and never implemented; the
   test transcribed the handler instead of importing it. (Caught by unwiring a
   handler → suite stayed green until a real-seam conformance test was added.)
2. **notification-egress AC-12** — the "production seam" test reimplemented the tool
   boundary inline; deleting *both* `dispatchNotification` call sites left the full
   suite green. (Caught by that exact mutation.)
3. **reset-sprint-tool** — the review that *did* run four mutations (delete the
   delete-call, drop the guard, flip the no-state branch, drop the try/catch), all
   RED, is the template this feature generalizes.

**The insight:** a verifier can *reason wrongly* about whether a test exercises the
seam, but a mutation cannot lie — if breaking the production code does not break a
test, the coverage is false, full stop. This feature moves the gate from
"reason about coverage" to "**produce mechanical RED evidence of coverage.**"

### Verified current behavior (2026-07-15, `sprint-17` branch base off main @ 978ce44)
- `buildAdversarialGateSection()` (`prompts.ts:126-160`) returns a static string with
  two checks: (a) reimplementation/stub hunt, (b) RED-verification-note check, plus a
  false-negative-bias directive and a FLAG-and-FAIL directive.
- It is appended to the step-7 "Run test suite" QA task context at two production
  seams: `runner.ts:1125` (single-feature) and `runner.ts:1889` (multi-feature).
- Sprint 14 pins the instruction's presence with tests asserting the real step-7
  prompt contains the gate section (the `adversarial-verifier-review-gate` suite).
- The QA gate agent runs with tool access (it already runs the suite); it can read
  files, edit them, run `npm test`, and revert — i.e. it is capable of performing a
  scoped mutation and restoring it within its working copy.

## Acceptance Criteria

1. **Mutation-evidence requirement added to the step-7 gate.** The adversarial gate
   instruction is extended so the verifier is directed to perform a **mutation test**
   on the primary production seam introduced/changed by the feature under review:
   identify the seam, break it (delete or no-op its body / remove the wiring call),
   run the feature-scoped tests, observe the result, then **restore** the code and
   confirm green. The instruction lives in orchestrator code (extending
   `buildAdversarialGateSection` or an added section it composes), so enforcement is
   ORCHESTRATED for every sprint — no reliance on a human having read TEAM.md.

2. **RED is the pass condition; GREEN-under-mutation is a FAIL.** The instruction must
   state the decision rule explicitly: if the mutation makes at least one
   feature-scoped test FAIL (RED), coverage of that seam is confirmed — proceed. If
   the suite stays GREEN under the mutation, that is a **false-green** — FLAG and FAIL
   the review, naming the seam that no test covers. This is the crux and must be
   unambiguous in the injected text.

3. **Evidence must be surfaced, not just asserted.** The verifier is directed to
   include, in its reported result, concrete evidence of the mutation test: what seam
   was mutated, how, the resulting RED test name(s)/output excerpt, and confirmation
   the code was restored and the suite is green again. A review that claims a pass
   without this evidence is itself inadequate (mirrors the Sprint-14 "never pass
   silently" directive).

4. **Restore-and-verify is mandatory.** The instruction must require the verifier to
   revert the mutation and re-confirm the suite is green before completing — the gate
   must never leave mutated production code behind. (The verifier works in the sprint
   working copy; a left-behind mutation would corrupt the merge.)

5. **Scoped to the primary seam(s), not exhaustive mutation.** The requirement targets
   the main production function(s)/wiring the feature adds or changes — not every line.
   One well-chosen seam mutation per feature (or per independent seam, when a feature
   has more than one, e.g. the two `dispatchNotification` call sites) is the bar.
   Exhaustive/whole-codebase mutation testing is explicitly out of scope (see below).

6. **Composes with, does not replace, the Sprint-14 checks.** The reimplementation
   hunt (a) and RED-note check (b) remain. The mutation check is an ADDED,
   evidence-producing third check — the gate is strictly stronger, never weaker.
   Existing `adversarial-verifier-review-gate` tests must still pass.

7. **Both production seams updated identically.** The mutation-evidence requirement
   reaches the step-7 QA gate at BOTH `runner.ts:1125` (single-feature) and
   `runner.ts:1889` (multi-feature) — via the shared instruction builder so the two
   cannot drift. No third copy of the instruction text.

8. **Graceful when there is no code seam to mutate.** For a feature whose deliverable
   is not executable production code (e.g. a docs-only or backlog-only change), the
   instruction must tell the verifier to record that no mutable seam exists and skip
   the mutation (not fabricate one or hard-fail). This must be a stated branch, not an
   accidental gap — so a legitimately code-free change is not blocked.

9. **Tests exercise the real gate prompt.** Per TEAM.md QA rule 12, regression tests
   assert the mutation-evidence directive is present in the REAL step-7 QA prompt
   built by the production code at BOTH seams (not a copy of the string), and carry a
   RED-verification note (the directive is absent pre-change). At least one test must
   pin the pass/fail rule of AC 2 (RED = pass, green-under-mutation = fail) as
   asserted-on text, so a future edit that softens it fails the suite.

10. **Truthful, self-consistent dogfood.** This feature's OWN step-7 review must run
    the mutation check on this feature's seam (mutate the gate-instruction builder →
    the AC-9 tests go RED). The sprint must not merge unless that mutation evidence is
    produced — the feature proves itself by its own standard.

## Edge Cases
- **Feature with multiple independent seams** (e.g. notification-egress's two
  `dispatchNotification` call sites). The instruction should direct a mutation per
  independent seam, since breaking only one may leave the other's tests green — the
  exact Sprint-16 miss. Guidance, not an enumerated count.
- **A mutation that makes the code fail to compile/typecheck** rather than a clean
  test RED. The instruction should treat a compile/typecheck failure caused by the
  mutation as acceptable RED evidence (the seam is exercised), as long as it is the
  mutation that caused it and the restore returns to green.
- **Docs-only / config-only feature** (AC 8) — no executable seam; record and skip.
- **Verifier cannot complete the mutation** (environment can't run tests, etc.) — the
  instruction must direct FLAG-and-FAIL (inability to obtain evidence is not a pass),
  consistent with the false-negative bias.
- **A test that goes RED for an unrelated reason** — the verifier must attribute the
  RED to the mutation (restore → green confirms attribution), not accept any RED.

## Out of Scope
- **A deterministic, orchestrator-run mutation harness** (programmatically mutating
  source and running the suite in code). This sprint enforces the requirement through
  the injected gate instruction + evidence, executed by the QA verifier agent — the
  same enforcement model as Sprint 14. A code harness is a larger, separate item;
  whether to build one later is Open Question 1.
- **A mutation-testing dependency** (Stryker, etc.) — no new tooling this sprint.
- **Exhaustive/coverage-percentage mutation testing** — the bar is the primary
  seam(s), not a mutation score.
- **Changing the Sprint-14 reimplementation-hunt or RED-note checks** — they stay.
- **Applying the mutation check to steps other than step-7** — scoped to the review
  gate only.
- **Auto-repairing a discovered false-green** — the gate FLAGs and FAILs; fixing the
  test is the engineer's re-attempt, as today.

## Open Questions
1. **Agent-driven now, code harness later?** This sprint is agent-driven-with-evidence.
   Should a follow-up build a deterministic orchestrator harness that performs the
   mutation and asserts RED without relying on the agent? — Architect to weigh;
   likely a filed follow-up, not this sprint.
2. **Evidence format — free-text vs structured.** Should the required evidence be
   free-text prose in the result, or a lightly-structured block (seam / mutation /
   RED test / restored) the orchestrator could later parse or even verify? — Architect
   to choose; a structured block is cheap insurance toward OQ1.
3. **Instruction placement.** Extend `buildAdversarialGateSection()` in place, or add a
   `buildMutationCheckSection()` composed alongside it? — Architect's call (AC 6/7
   both satisfiable either way; a separate builder may test more cleanly).
4. **How hard to push the "per independent seam" guidance** without a countable rule
   that a feature with one seam would fail. — Architect/QA to size the wording.
