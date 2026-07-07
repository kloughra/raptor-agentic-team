---
slug: retro-section-matching-rarely-hits-target
status: ready
sprint: 15
---
# Retro Section Matching Rarely Hits Its Target Heading

## User Story

As a **Raptor user who adopts retrospective improvement proposals**, I want an adopted proposal that clearly references a real TEAM.md heading to be applied **at that heading**, so that my process improvements land where they belong instead of accumulating in the "Unplaced" fallback section and forcing me to manually relocate every one during sprint close-out.

## Background — Observed Defect

Sprint 13 (`retro-improvements-not-applied`, PR #30) fixed the *silent-drop* bug: `applyImprovements` (`src/orchestrator/retro.ts`) now records one outcome per adopted proposal and, on a section miss, fallback-appends the text under `## Adopted Retro Improvements (Unplaced)` with role+sprint attribution instead of dropping it. That guarantee holds and must be preserved.

However, the **applied-at-target** path is effectively dead in practice:

- Section matching is a **normalized exact comparison** — `findHeadingLine` (`retro.ts:381-398`) compares `normalizeHeadingText(proposal.section)` (trim / strip leading `#` / lowercase / collapse whitespace) against each real heading and only matches on full equality.
- `Section` is **free text produced by a role agent** (`buildRetroPrompt` asks "Which section of TEAM.md this applies to", `retro.ts:47`; parsed verbatim by `parseRetroProposal`). Agents write **compound, descriptive** values that never equal a single heading. Two live examples:
  - **Sprint 13:** `Roles & Responsibilities → Product Owner (Responsibilities); reinforced in Backlog Management → Rules`
  - **Sprint 14:** compound descriptive Section (e.g. `Roles & Responsibilities → QA Engineer (Responsibilities)`)
- **Result:** BOTH Sprint 13 (3/3 adopted) and Sprint 14 (4/4 adopted) proposals fell to fallback and required manual relocation during PO close-out. The fallback+honest-report works as designed (no silent drops), but the target path never fires.

Real TEAM.md headings the agents are gesturing at (from `TEAM.md`): `## Roles & Responsibilities`, `### Product Owner (PO)`, `### QA Engineer`, `### Architect`, `## Backlog Management`, `### Rules`, `## Sprint Workflow`, `## Observability & Status Reporting`, etc. The compound strings reference these real headings — the matcher just can't extract them.

## Goal

Revive the applied-at-target path: when an adopted proposal's `Section` unambiguously references a real TEAM.md heading — even when embedded in a compound/descriptive string with separators (`→`, `;`, `-`, `:`) or parentheticals — the improvement is inserted **at that heading**, while the Sprint 13 no-silent-drop and no-wrong-placement guarantees are preserved intact.

## Acceptance Criteria

1. **Compound reference resolves to its heading.** Given an adopted proposal whose `Section` is a compound/descriptive string that contains a real TEAM.md heading (e.g. `Backlog Management → Rules`, or `Roles & Responsibilities → QA Engineer (Responsibilities)`), `applyImprovements` inserts the improvement at the referenced real heading and records the outcome as **applied** with `placedAt` set to that heading's verbatim text — NOT `applied-fallback`.

2. **Both live incidents become passing fixtures.** Test coverage includes the two verbatim Section strings that fell to fallback in Sprint 13 and Sprint 14, asserted against real bundled-template TEAM.md content, each now resolving to **applied** at a real heading (not the Unplaced fallback). These fixtures assert the *specific* heading each lands at, so a future regression to exact-only matching fails them.

3. **No silent drop (Sprint 13 guarantee preserved).** Every adopted proposal still ends the step in exactly one recorded outcome — **applied**, **applied-fallback**, **already-present**, or **unplaced** (with reason). No proposal vanishes without a record.

4. **No wrong-section placement.** A `Section` that references **no** real heading (pure prose, or naming a section that does not exist) still falls back to `## Adopted Retro Improvements (Unplaced)` with attribution — it must NOT be force-fit into an unrelated heading. A well-attributed fallback remains strictly preferred over a confident-but-wrong placement. The resolution logic must not introduce false-positive matches.

5. **Deterministic, no new model calls.** Section resolution remains plain string/parse operations (consistent with the established "no fuzzy/LLM section resolution" convention). No subagent, no LLM scoring, no new network/model dependency is introduced by this feature.

6. **Fenced headings stay non-matchable.** Heading resolution continues to ignore `#` headings that appear inside fenced code blocks in TEAM.md (the template-embedded examples). A compound Section must not resolve to a heading that lives inside a code fence.

7. **Idempotency and re-run safety preserved.** Re-running step 13 (resume / retry) does not double-insert an already-applied proposal; content-based idempotency (`already-present`) continues to work for both target and fallback placements.

8. **Path parity.** The single-feature step-13 handler and the shared multi-feature `runApplyRetroImprovementsShared` exhibit identical resolution behavior. Per TEAM.md QA rules, parity is asserted at the production seam (both runner code paths), not only on the pure `applyImprovements` function.

9. **Fallback path still fully functional.** For genuinely unplaceable proposals, the fallback section, its attribution format, the `## Applied Changes` retro-doc reporting, the qualified step-completion message, and commit-only-on-change behavior from Sprint 13 all continue to work unchanged.

10. **RED-verification evidence.** Each constraint-guarding test (AC 1, AC 2, AC 4) carries a recorded RED-verification note proving it FAILS against the current exact-only matcher (e.g. "reverting to normalized-exact `findHeadingLine` sends this compound Section to fallback").

## Edge Cases

- **Compound Section with multiple heading references** (e.g. `Roles & Responsibilities → Product Owner (Responsibilities); reinforced in Backlog Management → Rules`) — the Section names more than one real heading. Which one wins must be **deterministic and documented** (e.g. first real heading in reading order, or last segment after a separator — Architect's call). The recorded `placedAt` must reflect where the text actually landed.
- **Parenthetical qualifier that isn't part of the heading** (e.g. `Product Owner (Responsibilities)` vs the real `Product Owner (PO)`) — resolution must decide whether the parenthetical is significant; document the behavior. A near-miss that resolves to the wrong heading is worse than a fallback (AC 4).
- **Ambiguous last segment** (e.g. a trailing `Rules` when the proposal's real intent was the Product Owner section) — accept that a heuristic can pick a defensible-but-imperfect heading; the guarantee is "a real, referenced heading" + a recorded `placedAt`, not "the author's private intent."
- **Section that is a real heading verbatim** (e.g. `QA Engineer`) — continues to resolve exactly as today; this feature is additive to the existing exact path.
- **Duplicate heading text** (e.g. `## Definition of Done` appears twice, `## Overview` inside a template) — first non-fenced match in document order wins and is the recorded placement (unchanged from Sprint 13).
- **Empty / whitespace-only / marker-only Section** — resolves to no heading → fallback, exactly as today.
- **Separator characters inside a heading itself** (`Roles & Responsibilities`, `Multi-Engineer Coordination` contain `&`/`-`) — segmentation must not shred a legitimate single heading into non-matching fragments.

## Out of Scope

- **Reflowing existing Unplaced entries.** Proposals already parked in `## Adopted Retro Improvements (Unplaced)` from prior sprints are not retroactively relocated — no migration.
- **Retro proposal semantics / user selection.** `parseRetroSelection`, the adopt-at-checkpoint flow, and the retro proposal *fields* are untouched. *(Note: if the Architect chooses the "constrain the prompt to emit a canonical heading" approach — Open Question 1 option (a) — then `buildRetroPrompt` and/or `parseRetroProposal` MAY change; that specific coupling is the one deliberate exception and must be called out in the architecture. Sprint 13 held these frozen; Sprint 15 explicitly reopens them **only** if option (a) is chosen.)*
- **The fallback mechanism, attribution format, and reporting** — preserved as-is (AC 9), not redesigned.
- **`sprint-completes-despite-failed-merge`, `push-before-merge`, `user-actionable-failure-class`** — unrelated Sprint 15 backlog neighbors.
- **Circuit-breaker / escalation changes** — step 13 remains orchestrator-managed with no subagent; unplaceable proposals still degrade to a report, never trip the circuit breaker.

## Open Questions

1. **Resolution mechanism — which approach?** The backlog names three (technical decision → Architect):
   - **(a) Constrain the source.** Change the retro prompt / `parseRetroProposal` to emit a single canonical heading chosen from an enumerated list of the real TEAM.md headings. Highest precision; reopens the Sprint 13 "proposal format frozen" boundary (permitted here, see Out of Scope note).
   - **(b) Segment-and-match.** Split the compound Section on separators (`→`, `;`, `-`, `:`) and match each segment against real headings, choosing a documented winner (first-in-order / last-segment / longest-match). No prompt change; pure apply-side robustness.
   - **(c) Accept fallback-as-normal + a lightweight PO close-out relocation step.** No matcher change; formalize the manual relocation the PO already does. Lowest engineering cost; does not revive the applied-at-target path (would only partially satisfy AC 1/AC 2 — flag if this is the chosen direction so ACs can be renegotiated with the user).
   
   **PO lean (non-binding):** option (b) best satisfies ACs 1–2 without a prompt-format change and keeps resolution deterministic/string-only (AC 5). Option (a) is acceptable if the Architect judges precision worth the format-coupling. Option (c) alone does **not** meet AC 1/AC 2 as written — if the Architect recommends (c), it is a scope reduction that requires user approval before ACs change.

2. **Multi-reference tie-break rule.** When a compound Section names several real headings, the winner selection (first-in-reading-order vs last-segment vs longest-token-overlap) is an Architect decision. Constraint: it must be deterministic and the recorded `placedAt` must be truthful.

3. **Parenthetical / qualifier handling.** Should `Product Owner (Responsibilities)` resolve to `### Product Owner (PO)` by stripping the parenthetical, or fall back because the parenthetical differs? Architect's call, bounded by AC 4 (no wrong-section placement).
