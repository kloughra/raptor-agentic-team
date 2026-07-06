---
slug: retro-improvements-not-applied
status: ready
sprint: 13
---
# Retro Improvements Silently Not Applied to TEAM.md

## User Story

As a **Raptor user who reviews sprint retrospectives and adopts improvement proposals**, I want every proposal I adopt at the retro-review checkpoint to either be visibly applied to TEAM.md or explicitly reported as unplaceable, so that my process improvements actually take effect instead of being silently dropped while the sprint reports success.

## Background — Observed Defect (two live occurrences)

- **Sprint 10 (2026-06-11):** retro selection `1,3` parsed correctly (`parseRetroSelection` → `[1,3]`), decisions were recorded (commit `dc7f23f`), but TEAM.md was never modified on disk. Both adopted proposals silently dropped — including, ironically, the `[FOLLOW-UP]` capture rule itself.
- **Sprint 12 (2026-07-06):** retro selection `2,3` parsed and recorded (commit `078d9db`), step 13 reported `complete`, TEAM.md unmodified. Adopted proposals applied manually via `chore/apply-sprint-12-retro` (PR #28).

### Verified root-cause chain (validated against source 2026-07-06; backlog line refs had drifted)

1. `applyImprovements` (`src/orchestrator/retro.ts:157-218`) locates the target section by **exact string match** — `content.indexOf("### {Section}")`, then `## `, then `# `. If no heading matches, it hits `continue` (`retro.ts:183-186`) and **silently skips the proposal**. The function returns updated-or-unchanged content with **no signal** distinguishing "applied" from "dropped".
2. The `Section` value is **free text produced by a role agent** (`buildRetroPrompt` asks "Which section of TEAM.md this applies to", `retro.ts:47`; parsed verbatim by `parseRetroProposal`, `retro.ts:67-77`). Nothing constrains it to match a real TEAM.md heading verbatim, so exact-match misses are the expected case, not the exception.
3. Both step-13 call sites — single-feature (`src/orchestrator/runner.ts:849-899`) and shared multi-feature `runApplyRetroImprovementsShared` (`runner.ts:2408-2459`) — write the returned content unconditionally, wrap the git commit in a swallowed `try/catch` (`/* non-critical */` — so a nothing-to-commit failure is invisible), and mark the step `complete` with no qualification.
4. **Reporting gap:** the retro document's `## Applied Changes` section is generated as `(None yet)` (`retro.ts:125-126`) and is never updated afterward — `updateRetroDocWithDecisions` (`retro.ts:135-151`) only fills `## User Decision`. There is no persistent record of what was actually applied.

## Acceptance Criteria

1. **No silent drop.** When the user adopts N proposals at the retro-review checkpoint, each of the N proposals ends the step in exactly one explicitly recorded outcome: **applied** (text present in TEAM.md at its target section), **applied-fallback** (text present in TEAM.md under a designated fallback location because the target section could not be found), or **unplaced-reported** (not written, with the reason surfaced — only permissible for failures beyond section matching, e.g. TEAM.md unreadable). A proposal must never vanish with no record.
2. **Section-miss handling.** Given an adopted proposal whose `Section` does not match any TEAM.md heading, the improvement text is still persisted into TEAM.md under a fallback location (exact heading/placement is an Architect decision), attributed to its proposal (role + sprint), so the adopted content is never lost.
3. **Placement outcome is recorded.** The per-proposal outcome (applied at `{section}` / applied at fallback / unplaced + reason) is written into the sprint retro document (`docs/sprints/sprint-{N}-retro.md`) — the `## Applied Changes` section stops being a permanent `(None yet)` stub for sprints where proposals were adopted.
4. **Step result reflects reality.** If one or more adopted proposals could not be applied at their target section, step 13's completion is qualified — the sprint result/status output visible to the caller states how many proposals were applied vs fell back vs failed. A sprint must not report an unqualified "retro improvements applied" while any adopted proposal was dropped.
5. **Change verification before commit.** When ≥1 adopted proposal exists, the step verifies TEAM.md content actually changed before treating the apply as successful. A byte-identical TEAM.md after `applyImprovements` with ≥1 adopted proposal is a defect signal and must be surfaced (per AC 4), not swallowed.
6. **Path parity.** The single-feature step-13 handler and the shared multi-feature `runApplyRetroImprovementsShared` exhibit identical behavior for ACs 1–5. Per TEAM.md QA rules, parity must be asserted at the production seam (the two runner code paths), not only on the shared pure function.
7. **Skip behavior unchanged.** Retro-review feedback of `skip`, empty, or no valid indices continues to result in no TEAM.md modification and normal step completion — no new warnings, no fallback writes.
8. **Applied changes are committed.** When any proposal is applied (target or fallback), TEAM.md is committed as today (`[PO] update: apply retrospective improvements from sprint {N}`); when nothing was applied, no empty commit is attempted and no commit failure is silently absorbed into an unqualified success.
9. **Regression fixture from the live incidents.** Test coverage includes at least one case shaped like the observed failures: adopted proposals whose `Section` values are plausible-but-inexact heading references (e.g. `Product Owner responsibilities` vs the actual `### Product Owner (PO)`) against real bundled-template TEAM.md content — asserting the pre-fix behavior (unchanged TEAM.md + step complete) can no longer occur.

## Edge Cases

- **All adopted proposals unplaceable** — every one lands at the fallback location; step completes qualified per AC 4; TEAM.md still committed (it did change).
- **Mixed outcomes** — some proposals match sections, others fall back; each is recorded individually (AC 3).
- **Section string matches multiple headings** — `indexOf` semantics apply the first occurrence today; first-match is acceptable but must be the *recorded* placement.
- **Section string matches a heading inside a fenced code block** — TEAM.md embeds templates containing `#` headings inside code fences; a proposal landing inside a fence is a mis-placement. At minimum, document behavior; treating fenced content as non-matchable is preferred if cheap (Architect's call).
- **Step 13 re-run / resume** — re-running the apply step (e.g. sprint resumed at step 13, precedent: Sprint 8) must not double-append the same proposal text into TEAM.md.
- **Retro document missing on disk** — outcome recording (AC 3) degrades gracefully; the TEAM.md apply and step-result qualification (ACs 1, 2, 4) still function.
- **`retroProposals` empty or selection indices out of range** — existing guard behavior (filter + no-op) preserved; no fallback writes for proposals that were never adopted.

## Out of Scope

- Changing the retro proposal format, the retro prompt, or `parseRetroProposal` — proposals remain free-text `Section` values; robustness lives in the apply/report side. (Constraining agents to an enumerated section list is a possible future item.)
- Fuzzy/LLM-based section resolution — no new model calls; any matching-tolerance improvements are plain string ops per established conventions.
- `sprint-completes-despite-failed-merge` — the sibling Sprint 13 item; separate spec.
- `shared-steps-bypass-slug-detection` (Inbox) — resume-at-step-13 slug crash is a distinct dispatcher defect; only the double-append edge case above touches re-run behavior.
- Retroactively re-applying the dropped Sprint 10 proposals — Sprint 12's were applied manually via PR #28; Sprint 10's #1 (`[FOLLOW-UP]` rule) was adopted in a later retro. No migration.
- Escalation/circuit-breaker changes — step 13 remains orchestrator-managed with no subagent; unplaceable proposals degrade with a report rather than tripping the circuit breaker (PO decision, see below).

## Open Questions

1. **Fallback vs escalate** — the backlog allowed "append under a fallback heading **or** escalate". **PO decision: fallback-append + qualified report (ACs 2, 4).** Rationale: both live incidents were fully recoverable and non-urgent; blocking sprint completion on a TEAM.md formatting mismatch adds friction disproportionate to the failure (precedent: `batch-checkpoints-config` — no friction until friction data exists). Flagging for user visibility at checkpoint review; say so if you want escalation instead.
2. **Matching tolerance** — should heading matching gain minimal normalization (case-insensitive, trimmed) before falling back? Deferred to Architect; ACs only require that a miss is never silent. AC 9's fixture must pass regardless of which tolerance level is chosen.
3. **Fallback location naming/structure** — Architect decision (single `## Adopted Retro Improvements (unplaced)` style section vs per-sprint blocks). Constraint from AC 2: attribution (role + sprint) must be preserved.
