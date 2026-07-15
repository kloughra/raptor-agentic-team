---
slug: review-gate-mutation-check
spec: docs/specs/review-gate-mutation-check.md
---
# Review Gate Mutation Check — Architecture Design

## Overview

Extend the step-7 review gate to demand **mechanical mutation evidence**. The design
is deliberately small and mirrors Sprint 14's enforcement model: a new instruction
section, composed with the existing adversarial gate, injected into the step-7 QA
agent's prompt at both production seams via a **single shared builder** so the two
cannot drift. No orchestrator-run mutation harness, no new dependency, no state-schema
change. Enforcement is agent-driven-with-required-evidence — the QA verifier already
runs the suite and can edit/revert files in the sprint working copy.

### Open questions — resolved by the Architect

1. **Agent-driven now, code harness later** → agent-driven this sprint (same model as
   Sprint 14). A deterministic orchestrator harness is filed as a follow-up
   (`review-gate-mutation-harness`, Inbox) — larger, and OQ2's structured evidence
   block is the forward-compatible seam toward it.
2. **Evidence format** → **lightly-structured block** the verifier fills in
   (`SEAM:` / `MUTATION:` / `RED EVIDENCE:` / `RESTORED:`). Cheap insurance toward a
   future parser (OQ1) and makes AC-3 evidence assertable in review.
3. **Instruction placement** → a **separate `buildMutationCheckSection()`** composed
   alongside `buildAdversarialGateSection()`, both returned by a new single entry
   `buildStep7GateInstruction()`. Keeps the Sprint-14 section (and its pinned tests)
   untouched, tests the new section in isolation, and gives the runner ONE call site
   contract (AC 6, 7).
4. **"Per independent seam" wording** → phrased as guidance ("if the feature adds more
   than one independent seam — e.g. two call sites — mutate each; breaking one may
   leave the other's tests green"), never a countable rule that a single-seam feature
   would fail (AC 5, Edge Case).

## Components

| Component | Location | Responsibility | New / Changed |
|-----------|----------|----------------|---------------|
| `buildMutationCheckSection()` | `src/orchestrator/prompts.ts` | Returns the mutation-evidence directive (AC 1-5, 8): identify primary seam(s) → mutate → run feature-scoped tests → RED=pass / green-under-mutation=FAIL → restore & confirm green → emit the structured evidence block. | **New** |
| `buildStep7GateInstruction()` | `src/orchestrator/prompts.ts` | Single entry the runner injects at step 7: `buildAdversarialGateSection() + "\n\n" + buildMutationCheckSection()`. The only text both seams use (AC 7). | **New** |
| `buildAdversarialGateSection()` | `src/orchestrator/prompts.ts` | Unchanged (AC 6 — Sprint-14 checks preserved). | Unchanged |
| Step-7 injection (single-feature) | `src/orchestrator/runner.ts:1125` | Call `buildStep7GateInstruction()` instead of `buildAdversarialGateSection()`. | **Changed (1 line)** |
| Step-7 injection (multi-feature) | `src/orchestrator/runner.ts:1889` | Same one-line swap. | **Changed (1 line)** |

Both runner sites call the SAME new function — there is no second concatenation point
to drift (AC 7). Existing Sprint-14 tests that assert `buildAdversarialGateSection`
text appears in the step-7 prompt still pass, because the composed instruction
contains it verbatim.

## Instruction content contract (pinned by the AC-9 tests)

`buildMutationCheckSection()` MUST contain, as asserted-on text:

- A directive to **perform a mutation test on the primary production seam(s)** the
  feature introduces/changes (AC 1), with per-independent-seam guidance (AC 5).
- The **decision rule stated unambiguously**: a mutation that makes ≥1 feature-scoped
  test FAIL confirms coverage (proceed); a suite that stays GREEN under the mutation is
  a **false-green → FLAG and FAIL**, naming the uncovered seam (AC 2).
- A **restore-and-verify** requirement: revert the mutation and re-confirm green before
  completing; never leave mutated code behind (AC 4).
- A **required structured evidence block** in the reported result (AC 3):
  ```
  MUTATION CHECK
  SEAM: <file:symbol the feature owns>
  MUTATION: <how it was broken — deleted body / removed wiring call / no-op>
  RED EVIDENCE: <failing test name(s) or compile/typecheck error caused by the mutation>
  RESTORED: <confirmation code reverted and suite green again>
  ```
- A **compile/typecheck failure caused by the mutation counts as RED** (Edge Case).
- A **no-mutable-seam branch** (AC 8): for a docs/config-only feature, record
  `SEAM: none (no executable production seam)` and skip — an explicit stated branch,
  not a hard fail.
- An **inability-to-obtain-evidence → FLAG and FAIL** directive (Edge Case; consistent
  with the false-negative bias).

## Data Model

**No persisted-state change, no schema change.** The evidence block lives only in the
agent's returned review text (as the Sprint-14 findings already do). Additive text
only.

## Non-Functional Requirements

| # | Category | Requirement |
|---|----------|-------------|
| NFR-1 | **Orchestrated enforcement** | The requirement reaches every sprint's step-7 gate via orchestrator code, no reliance on TEAM.md having been read (matches Sprint-14 AC 2). |
| NFR-2 | **No drift** | Exactly one builder (`buildStep7GateInstruction`) is injected at both runner seams; no third copy of the instruction text (AC 7). |
| NFR-3 | **Strictly additive** | Sprint-14's gate section and its tests are unchanged; the gate is stronger, never weaker (AC 6). No new dependency; no state change; the four existing `spawnAgent` call sites and argv are untouched. |
| NFR-4 | **Backward compatible** | Injecting more instruction text changes only the QA agent's prompt; no tool, transport, or state-file behavior changes. Existing sprints/state load and run identically. |
| NFR-5 | **Self-consistent (dogfood)** | This feature's own step-7 review runs the mutation check on `buildMutationCheckSection`/`buildStep7GateInstruction`; mutating them makes the AC-9 tests go RED (AC 10). |
| NFR-6 | **Truthful skip** | The no-seam branch (AC 8) is stated instruction, exercised by a test asserting its presence — a code-free change is not silently blocked nor silently passed. |

## Constraints & Patterns

- **Compose, don't replace (AC 6).** `buildAdversarialGateSection()` is called by the
  new entry unchanged; the mutation section is appended after it.
- **One injection contract (AC 7, NFR-2).** Both `runner.ts` seams swap
  `buildAdversarialGateSection()` → `buildStep7GateInstruction()`; nothing else moves.
- **Instruction, not harness (Out of Scope).** No source is programmatically mutated by
  orchestrator code this sprint; the verifier performs the mutation in the working copy
  and restores it. The structured evidence block is the forward seam to a future harness.
- **Guidance over counts (AC 5).** Per-independent-seam wording must not become a rule a
  single-seam feature fails.
- **Tests hit the real prompt (AC 9).** Assertions run against the string the runner
  actually injects at step 7 (via `buildStep7GateInstruction()` and, where practical,
  the real runner seam), not a copied literal — with RED-verification notes (the
  directive and the pass/fail rule are absent pre-change).

### Follow-up filed
- `review-gate-mutation-harness` (Inbox) — a deterministic orchestrator-run mutation
  harness that performs the seam mutation and asserts RED without relying on the agent,
  consuming the structured evidence block. Larger; deferred (OQ1).
