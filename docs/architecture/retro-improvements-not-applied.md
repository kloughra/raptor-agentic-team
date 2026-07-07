---
slug: retro-improvements-not-applied
spec: docs/specs/retro-improvements-not-applied.md
---
# Retro Improvements Silently Not Applied — Architecture Design

## Overview

Step 13 ("Apply retro improvements") currently drops adopted proposals silently: `applyImprovements` (`src/orchestrator/retro.ts:157-218`) skips any proposal whose free-text `Section` doesn't exactly match a TEAM.md heading, returns a bare string with no applied/dropped signal, and both runner call sites write + commit unconditionally and mark the step `complete`. Two live incidents (Sprints 10 and 12).

The fix is a **reporting-first redesign of the apply pipeline**, not smarter matching:

1. `applyImprovements` becomes outcome-returning — every adopted proposal produces exactly one recorded `ProposalOutcome` (AC 1).
2. Section misses **fall back** to a designated TEAM.md section instead of being dropped (AC 2; PO decision from Open Question 1).
3. A single shared step-13 executor is extracted and called from **both** runner paths, making parity (AC 6) structural rather than duplicated.
4. Outcomes are persisted three ways: into the retro document's `## Applied Changes` (AC 3), into sprint state (additive), and into the step-completion message visible to the caller (AC 4).

No new dependencies, no LLM calls, no subagent — step 13 remains orchestrator-managed pure string ops, per established conventions.

## Components

### 1. `src/orchestrator/retro.ts` — pure apply/report logic (modified)

**`applyImprovements` — signature change (internal API):**

```ts
export type ProposalPlacement = "applied" | "applied-fallback" | "already-present" | "unplaced";

export interface ProposalOutcome {
  role: string;            // proposal.role
  section: string;         // the proposal's requested Section (verbatim)
  placement: ProposalPlacement;
  placedAt?: string;       // actual heading text where inserted (first match wins, recorded — Edge Case: multi-match)
  reason?: string;         // required when placement === "unplaced"
}

export interface ApplyImprovementsResult {
  content: string;                 // updated TEAM.md content
  outcomes: ProposalOutcome[];     // one entry per input proposal, same order
  changed: boolean;                // content !== input (AC 5 signal)
}

export function applyImprovements(
  teamMdContent: string,
  proposals: RetroProposal[],
  sprint: number                   // NEW: needed for fallback attribution (AC 2)
): ApplyImprovementsResult
```

This is a breaking change to an internal function with exactly two production call sites (both in `runner.ts`) plus unit tests — changing the signature is cheaper and safer than a parallel `applyImprovementsWithReport` that leaves the silent variant callable. **The old string-returning form must not survive**; a compile error at any missed call site is the desired behavior.

**Heading matching (Open Question 2 — Architect decision):**

Replace `content.indexOf("### " + section)` with a **line-based heading scan**:

- Split content into lines; track fenced-code state (` ``` ` toggles). Headings inside fences are **non-matchable** (Edge Case resolved: preferred option is cheap under a line scan).
- A heading line is `^(#{1,6})\s+(.*)$` outside a fence.
- Normalize both sides before comparison: trim, lowercase, collapse internal whitespace, strip a leading `#`-run from the proposal's `Section` value (agents sometimes echo the hashes).
- Match rule: normalized heading text **equals** normalized section text. First match wins (document order), matching today's `indexOf` semantics; the matched heading's verbatim text is recorded in `placedAt`.
- Deliberately **no** fuzzy/substring/prefix matching. `Product Owner responsibilities` vs `### Product Owner (PO)` (the AC 9 fixture) still misses — and lands at the fallback, which is the designed behavior. Normalization only removes false misses from case/whitespace, never introduces surprising placements. AC 9's fixture passes regardless (it asserts "not silently dropped", not "matched").

**Insertion (unchanged semantics):** on match, insert the existing blockquote marker (`> **[Sprint Retro Improvement]** …` etc.) at the section end via `findSectionEnd`, which must gain the same fence-awareness so a section boundary is never detected inside a code block.

**Fallback placement (Open Question 3 — Architect decision):**

A single well-known section, appended to the end of TEAM.md if absent:

```markdown
## Adopted Retro Improvements (Unplaced)

<!-- Proposals adopted at retro review whose target section could not be located.
     Relocate manually; do not delete without applying. -->

> **[Sprint {N} Retro — {ROLE}, target section: "{Section}"]** ({type}) {proposal text}
```

One flat section, one blockquote entry per proposal, attribution (sprint + role + intended section + type) inline in the marker. Rationale vs per-sprint blocks: entries are self-attributing, so sub-structure adds parsing surface without information; and a single stable heading gives tests and future tooling one anchor. Placement outcome: `applied-fallback`, `placedAt: "Adopted Retro Improvements (Unplaced)"`.

**Idempotency (Edge Case: step-13 re-run/resume):**

Before inserting (target or fallback), check whether the exact rendered insertion block already exists in the content (`content.includes(renderedBlock)`). If present, skip insertion and record `placement: "already-present"`. This is stateless — it survives resume, state-file loss, and partial re-runs — and is why the rendered fallback marker embeds the sprint number (making blocks sprint-unique). `already-present` counts as a success outcome for AC 1/AC 4 accounting and legitimately co-occurs with `changed === false` (AC 5's defect signal is *unexplained* byte-identity, see below).

**`unplaced` outcome:** reserved for failures beyond section matching (AC 1) — with fallback-append in place, matching can no longer produce it. It occurs only when the runner layer cannot read/write TEAM.md; the runner synthesizes `unplaced` outcomes with the I/O error as `reason` for all selected proposals in that case.

**New: `updateRetroDocWithAppliedChanges(retroDoc: string, outcomes: ProposalOutcome[]): string`** — replaces the `## Applied Changes\n(None yet)` stub with one line per outcome:

```
- {ROLE} proposal → applied at "{placedAt}"            (applied / already-present)
- {ROLE} proposal → fallback ("Adopted Retro Improvements (Unplaced)"); target "{Section}" not found
- {ROLE} proposal → NOT APPLIED: {reason}              (unplaced)
```

Mirrors the existing `updateRetroDocWithDecisions` shape (pure, string-replace on the stub). If the stub text is absent (already-updated doc on re-run, or hand-edited), return input unchanged — graceful degradation per the Edge Cases; the doc write is best-effort and never blocks ACs 1/2/4.

### 2. `src/orchestrator/runner.ts` — one shared step-13 executor (modified)

Extract the entire step-13 body into a single internal helper:

```ts
interface RetroApplyReport {
  applied: number;
  fallback: number;
  alreadyPresent: number;
  unplaced: number;
  outcomes: ProposalOutcome[];
  skipped: boolean;        // true when selection was skip/empty/no valid indices (AC 7)
}

async function executeRetroApply(
  projectPath: string,
  sprint: number,
  state: SprintState,
  git: SimpleGit
): Promise<RetroApplyReport>
```

Both call sites — the inline single-feature block (`runner.ts:849-899`) and `runApplyRetroImprovementsShared` (`runner.ts:2408-2459`) — become thin wrappers: call `executeRetroApply`, persist the report, set step status/`completedAt`, `saveSprintState`. **Parity (AC 6) becomes structural**: there is one implementation to diverge from, and QA still asserts both production seams independently per the TEAM.md production-seam rule (a future refactor that forks the paths again must fail those tests).

`executeRetroApply` responsibilities, in order:

1. Resolve retro-review feedback → `parseRetroSelection` → selected proposals. Empty selection → return `{skipped: true, ...zeros}`; **no TEAM.md read, no fallback writes, no new warnings** (AC 7, and the out-of-range/empty-proposals Edge Case — existing filter guards preserved).
2. Read TEAM.md; call `applyImprovements(teamMd, selected, sprint)`. Read/write failure → synthesize `unplaced` outcomes with the error as reason; do not throw (errors-returned-not-thrown convention; step still completes qualified — circuit breaker untouched per Out of Scope).
3. **Change verification (AC 5):** write TEAM.md only if `result.changed`. Defect signal = `!result.changed` **and** at least one outcome is `applied`/`applied-fallback` (i.e. the function claims placement but produced identical bytes) — downgrade those outcomes to `unplaced` with reason `"apply reported success but content unchanged"`. All-`already-present` with `changed === false` is the legitimate re-run case, not a defect.
4. **Commit (AC 8):** only when `result.changed` and the write succeeded: `git.add` + `git.commit("[PO] update: apply retrospective improvements from sprint {N}")` — message unchanged. The `try/catch` is retained (a commit failure must not corrupt step flow) but stops being silent: on catch, append a note to the report that surfaces in the qualified message. When nothing changed, no commit attempt (no empty-commit path).
5. **Retro doc (AC 3):** existing `updateRetroDocWithDecisions` call, plus `updateRetroDocWithAppliedChanges(…, outcomes)` when the selection was non-empty. Missing retro doc → skip silently (Edge Case: graceful degradation).
6. Persist the report into state (see Data Model) **before** marking the step complete (persist-before-yield convention).

**Qualified completion (AC 4):** the sprint-completion / step-result message rendered to the caller includes, whenever `!skipped`:

```
Retro improvements: {applied} applied, {fallback} at fallback, {alreadyPresent} already present, {unplaced} NOT applied.
```

with per-proposal detail lines when `fallback + unplaced > 0`. An unqualified "retro improvements applied" is only emitted when every outcome is `applied`.

### 3. `src/orchestrator/state.ts` (modified, additive)

See Data Model. No behavioral change to existing fields.

## Data Model

Additive optional field on `SprintState` (backward-compatible per convention — every read uses `?? undefined` guards; pre-existing state files load unchanged):

```ts
// state.ts
retroApply?: {
  applied: number;
  fallback: number;
  alreadyPresent: number;
  unplaced: number;
  outcomes: Array<{
    role: string;
    section: string;
    placement: "applied" | "applied-fallback" | "already-present" | "unplaced";
    placedAt?: string;
    reason?: string;
  }>;
};
```

Stored on `SprintState` (not `StepState`) because step 13 runs once per sprint in both dispatch modes and the report feeds the sprint-level result message. Sized: ≤5 proposals × ~5 short strings — no state-bloat concern; `reason` strings reuse the existing error-summary truncation constant (`ERROR_SUMMARY_MAX_LENGTH`).

No migration: Sprint 10/12 state files are not retro-fixed (Out of Scope), and absent `retroApply` simply renders no qualification line.

## API Contracts

| Contract | Shape | Consumers |
|---|---|---|
| `applyImprovements(content, proposals, sprint)` | → `ApplyImprovementsResult { content, outcomes, changed }` | both runner paths via `executeRetroApply`; unit tests |
| `updateRetroDocWithAppliedChanges(retroDoc, outcomes)` | → `string` (pure; no-op if stub absent) | `executeRetroApply`; unit tests |
| `executeRetroApply(projectPath, sprint, state, git)` | → `RetroApplyReport` (never throws) | single-feature step-13 handler; `runApplyRetroImprovementsShared` |
| Fallback section heading | `## Adopted Retro Improvements (Unplaced)` — exact string, exported as a constant from `retro.ts` | apply logic; tests; future tooling |
| Fallback entry marker | `> **[Sprint {N} Retro — {ROLE}, target section: "{Section}"]** ({type}) {proposal}` | apply logic; idempotency check; tests |
| Commit message | `[PO] update: apply retrospective improvements from sprint {N}` — unchanged (AC 8) | git history consumers |

**Invariant (AC 1):** `outcomes.length === selectedProposals.length`, always, on every code path including I/O failure. This is the contract tests should pin hardest.

## Non-Functional Requirements

- **Correctness/auditability (primary NFR):** zero silent drops — every adopted proposal has exactly one recorded outcome in state, in the retro doc (best-effort), and in the caller-visible message. The AC 9 regression fixture (inexact `Section` against the real bundled `template/TEAM.md`) must show changed TEAM.md + fallback outcome + qualified completion.
- **Performance:** pure synchronous string ops over TEAM.md (~30–50 KB). Full apply pass including fence-aware scan: **< 50 ms** for ≤10 proposals; no perceptible step-latency change. No new I/O beyond today's reads/writes.
- **Determinism:** no LLM calls, no clock/randomness in placement logic; identical inputs → identical outputs (required for the idempotency check and for jest snapshots).
- **Idempotency:** re-running step 13 against already-applied content produces `changed === false`, all `already-present`, no duplicate text, no empty commit.
- **Backward compatibility:** pre-existing sprint-state JSON loads without error; behavior with `skip`/empty selection is byte-identical to today (AC 7).
- **Availability/robustness:** TEAM.md or retro-doc I/O failures degrade to reported outcomes, never a thrown error or circuit-breaker trip.
- **Security:** none new — no new inputs cross a trust boundary; proposal text was already written into TEAM.md verbatim today. (Blockquote rendering keeps injected markdown visually scoped.)

## Technology Choices

**No new technologies, frameworks, or dependencies.** Everything rides on the approved stack:

| Concern | Choice | Status |
|---|---|---|
| Language/runtime | TypeScript / Node.js | existing |
| Heading scan, normalization, fence tracking | plain string/regex ops in `retro.ts` | existing convention ("no fuzzy/LLM resolution" — Out of Scope confirms) |
| File I/O | Node `fs` (sync, matching current call sites) | existing |
| Git commit | `simple-git` | existing convention |
| State persistence | existing `~/.raptor/{slug}/sprint-N.json` via `saveSprintState` | existing |
| Tests | jest/ts-jest — colocated unit (`retro.test.ts` additions) + `tests/integration/retro-improvements-not-applied.integration.test.ts` | existing |

⚠️ **User approval requested:** this design intentionally introduces **zero** new technology. Per process I'm flagging that explicitly rather than skipping the gate — if you'd prefer a markdown-AST library (e.g. `remark`) over hand-rolled fence-aware scanning, that would be a new dependency requiring your approval; my recommendation is **against** it (one narrow, well-tested scan doesn't justify a parser dependency, and picomatch/glob precedent shows we add deps only for genuinely hairy matching).

No new ADR required: no stack change. The `docs/adr/` record stands.

## Constraints & Patterns

- **One implementation, two seams.** All step-13 logic lives in `executeRetroApply`; the two runner paths are wrappers. QA must still test both production seams (TEAM.md rule: parity asserted at the seam, not only on the pure function) — and the AC 9 fixture must run through a runner path, not just `applyImprovements`.
- **Outcome-total invariant.** One outcome per adopted proposal on every path — I/O failure paths synthesize outcomes rather than returning early.
- **No smarter matching than normalization.** Trim/case/whitespace only. Substring, prefix, and fuzzy matching are explicitly rejected — a wrong-section placement is worse than a well-attributed fallback.
- **Fences are invisible to matching.** Headings inside ``` fences neither match sections nor terminate them (fixes the mis-placement Edge Case at both the match and `findSectionEnd` layers).
- **Idempotency is content-based, not state-based.** The rendered-block presence check is the double-append guard; sprint state is a report, not the guard.
- **Errors reported, not thrown.** `executeRetroApply` never throws; failures become `unplaced` outcomes + qualified completion. Circuit breaker, checkpoint flow, and step ordering are untouched (Out of Scope).
- **Skip path is frozen.** `skip`/empty/no-valid-indices takes an early return before any TEAM.md read — provably no new writes or warnings (AC 7).
- **Commit only on change; never silently.** Write and commit are gated on `changed`; a caught commit error surfaces in the report text (AC 8) instead of `/* non-critical */` oblivion.
- **Additive state only.** `retroApply` is optional; no changes to existing `StepState`/`CheckpointState` shapes; no state migration.
- **Out of scope honored:** `parseRetroProposal`, `buildRetroPrompt`, and the proposal format are untouched; `sprint-completes-despite-failed-merge` and `shared-steps-bypass-slug-detection` remain separate items.
