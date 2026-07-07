---
slug: retro-improvements-not-applied
artifact: po-test-review
status: approved
sprint: 13
reviewer: Petra (PO)
---

# PO Test Review — retro-improvements-not-applied

**Decision: APPROVED. The BDD feature file and the integration suite are both accepted as the step-3 artifacts. Engineer may begin TDD implementation. Two defensive-path scenarios are conditioned to colocated unit tests landing with the Engineer's work (Condition A below) — they do not block, and QA must verify their presence at test-execution time (step 8 gate).**

## Scope of Review

- Spec: `docs/specs/retro-improvements-not-applied.md` (AC 1–9 + 7 edge cases)
- Architecture: `docs/architecture/retro-improvements-not-applied.md` (rulings verified — see provenance)
- BDD: `tests/bdd/retro-improvements-not-applied.feature` (23 scenarios across AC 1–9 + matching edges)
- Integration: `tests/integration/retro-improvements-not-applied.integration.test.ts`

## Headline

This suite continues the Sprint 12 trajectory and lands where the last review's Required Changes pointed. The load-bearing regression — the Sprint 10/12 silent-drop shape — is replayed at a **real runner production seam** (`runSprintFromStep(..., 13)`) against the **real bundled template**, with the pre-fix behavior (byte-identical TEAM.md + unqualified `complete`) asserted impossible. Both production seams (single-feature and `runApplyRetroImprovementsShared`) are exercised independently *and* compared structurally, honoring the TEAM.md seam rule for AC 6. The suite is RED-by-construction (the outcome-returning API doesn't exist pre-fix, accessed via untyped `require`), and the header explicitly forbids the two known-from-history ways to neuter it: no mocking of retro.ts/runner.ts internals, and no skip-when-absent probes — "the silent-drop regression must FAIL, not skip." Correct instinct, correctly documented.

## Fixture provenance check (verified against source, not assumed)

Every factual assumption the fixtures depend on was checked against the repo at review time:

| Fixture assumption | Verified against |
|---|---|
| `### Product Owner (PO)` and `### QA Engineer` exist outside fences in the bundled template | `template/TEAM.md:11`, `:52` |
| `## Linked Spec` occurs exactly once, **inside** the fenced PR Description Template | `template/TEAM.md:415` (fence opens `:414`, closes `:436`) |
| Fallback heading exact string `## Adopted Retro Improvements (Unplaced)` | architecture §API Contracts (exported constant) |
| Outcome vocabulary incl. `already-present`; `unplaced` reserved for beyond-matching failures | architecture §1 (`ProposalPlacement`; Open Q 2/3 rulings) |
| Downgrade reason `"apply reported success but content unchanged"` | architecture §2 step 3 |
| Qualified-message shape (`… NOT applied`) and retro-doc line shapes (`NOT APPLIED: {reason}`) | architecture §2 (AC 4 block) + `updateRetroDocWithAppliedChanges` spec |
| `retroApply` state shape (`applied`/`fallback`/`alreadyPresent`/`unplaced` + `outcomes[]`) | architecture §Data Model |
| Commit message `[PO] update: apply retrospective improvements from sprint {N}` | unchanged per AC 8; architecture §API Contracts |
| Existing-API signatures used by fixtures: `createInitialState(project, sprint, steps, branchName?)`, `saveSprintState`, `createFeatureStates(slugs, sprint)`, `generateRetroDocument(slug, sprint, proposals, roles)`, `SprintResult.message?`, `CheckpointState{type,status,feedback,resolvedAt,feature?}`, `"retro-review"` ∈ `CheckpointType`, `RetroProposal` fields | `state.ts`, `runner.ts:623-629`, `multi-runner.ts:50`, `retro.ts:4-11,91-96`, `workflow.ts:3-8` |

The suite will go RED for the **right** reasons (missing post-fix API / missing behavior), not broken fixtures.

## Acceptance Criteria → Test Coverage

| AC | BDD | Integration | Verdict |
|----|-----|-------------|---------|
| 1 — no silent drop; outcome-total invariant | ✅ 2 scenarios incl. I/O failure | ✅ pure contract (one outcome per proposal, in order) + **both seams' I/O-failure paths** (`sf-io-fail`, `mf-io-fail`: EISDIR via directory-at-TEAM.md, outcomes synthesized, no throw) — the invariant the architecture says to "pin hardest" is pinned hardest | Accept |
| 2 — section miss falls back, attributed | ✅ 4 scenarios | ✅ pure fallback w/ sprint+role+section attribution; normalization (case/whitespace/echoed hashes); explicit **no-fuzzy** pin; all-unplaceable at seam (`sf-all-fallback`) | Accept |
| 3 — outcomes recorded in retro doc | ✅ 2 scenarios | ✅ `updateRetroDocWithAppliedChanges` contract (stub replaced, per-proposal lines, unplaced reason, no-op when stub absent) + seam assertion (`sf-mixed`) + missing-doc graceful degradation (`sf-no-retrodoc`) | Accept |
| 4 — qualified completion | ✅ 2 scenarios | ✅ message asserted on `sf-ac9`, `sf-mixed`, `sf-io-fail` (`/NOT applied/i`), `sf-all-fallback`; per-outcome counts in persisted state | Accept |
| 5 — change verification before commit | ✅ 2 scenarios | ✅ legitimate-re-run half fully covered at seam (`sf-rerun`: all `already-present`, `changed=false` not a defect, no second commit). ⚠️ Defect-signal half (claimed placement + byte-identical → downgrade) not integration-testable without mocking retro.ts, which this file **correctly** forbids | Accept with **Condition A-1** |
| 6 — path parity at both seams | ✅ | ✅ full contract through the multi-feature seam + **structural parity test** (identical placements, placedAt sequences, inserted TEAM.md lines, commit counts across both seams) | Accept |
| 7 — skip behavior unchanged | ✅ 2 scenarios | ✅ `sf-skip` (byte-identical, no fallback section, no commit), `sf-oor` (indices out of range ≡ skip), `mf-skip` parity | Accept |
| 8 — commit on change only, never silently | ✅ 3 scenarios | ✅ message format pinned; no-empty-commit pinned on skip/OOR/re-run/IO-failure. ⚠️ Commit-*failure*-surfaced scenario needs git fault injection — not in this file | Accept with **Condition A-2** |
| 9 — live-incident regression fixture | ✅ | ✅ `sf-ac9`: inexact `Section` values, real template, **through the runner seam**, asserting the pre-fix shape (unchanged TEAM.md + unqualified complete + zero record) can no longer occur. This is the test this feature exists for | Accept |
| Edge: multi-match first-wins + recorded | ✅ | ✅ synthetic doc, placedAt asserted | Accept |
| Edge: fenced headings non-matchable; fences don't end sections | ✅ 2 scenarios | ✅ real-template fence fixture (`## Linked Spec`) + synthetic `findSectionEnd` fence-awareness pin | Accept |
| Edge: re-run/resume no double-append | ✅ | ✅ seam-level resume replay (Sprint 8 precedent shape), content-based idempotency, exactly-once blocks, one commit | Accept |
| Edge: retro doc missing | ✅ | ✅ at seam | Accept |
| Edge: empty proposals / OOR selection | ✅ | ✅ pure empty-list + `sf-oor` at seam | Accept |

## Condition A (non-blocking, tracked to step 8 — Sprint 12 precedent)

Two defensive paths require fault injection that this integration file rightly refuses to perform (its no-mocking rule is what makes the AC 9 regression coverage trustworthy). Per TEAM.md, colocated unit tests land with the Engineer's TDD work; **PO acceptance at step 8 is conditioned on both existing**:

1. **AC 5 defect signal** (BDD `@ac5 @defect-signal`): a colocated unit test (e.g. `runner.test.ts` or `retro.test.ts` against `executeRetroApply` with an injected/mocked `applyImprovements`) proving that claimed placements + byte-identical content downgrade the affected outcomes to `unplaced` with reason `"apply reported success but content unchanged"`, surfaced in the qualified result. Mocking retro.ts is acceptable **there** — the unit under test is the runner's downgrade logic, not the apply logic.
2. **AC 8 commit-failure surfaced** (BDD `@ac8` third scenario): a colocated unit test with a failing git commit (mock/injection) proving the failure is noted in the qualified step result rather than absorbed by the retained try/catch, and step flow is not corrupted.

QA: verify presence at test-execution time and call out any hole in the PR test report.

## Minor notes (do not block; no action required)

- Out-of-range selection is exercised only through the single-feature seam; multi-feature skip parity plus the structural parity test make divergence unlikely, and the architecture makes parity structural (one `executeRetroApply`). Acceptable.
- The positive AC 4 complement (all-`applied` → clean, unqualified-permitted message) is not asserted. The qualified cases are the contract; optional to add.
- The structural-parity `insertedLines` delta filters lines by template membership; since both seams are filtered identically, the comparison remains valid even if an inserted line coincidentally matches a template line.

## Out-of-Scope Items Correctly Excluded

- No tests constrain `parseRetroProposal` / `buildRetroPrompt` / proposal format. ✅
- No fuzzy matching demanded anywhere — the `@no-fuzzy` scenario pins its **absence**, matching the Architect's ruling. ✅
- Circuit breaker untouched: I/O-failure tests assert the step still completes (qualified), never escalates. ✅
- No migration assertions on Sprint 10/12 state files. ✅
- `sprint-completes-despite-failed-merge` and `shared-steps-bypass-slug-detection` not smuggled in. ✅

## Open Questions status

- Open Q 1 (fallback vs escalate): PO decision (fallback + qualified report) is what the suite pins. Standing offer to the user remains open at checkpoint review — if escalation is preferred, the seam tests change assertions, not shape.
- Open Q 2 (matching tolerance) and Q 3 (fallback structure): Architect ruled (normalize-only; single flat attributed section); tests pin exactly those rulings. Closed.

## Decision

**Approved.** BDD and integration artifacts accepted as-is. Hand off to Engineer for TDD implementation (step 5). Conditions A-1/A-2 are gates on step-8 acceptance, not on starting implementation.
