---
slug: retro-section-matching-rarely-hits-target
spec: docs/specs/retro-section-matching-rarely-hits-target.md
---
# Retro Section Matching Rarely Hits Its Target Heading — Architecture Design

## Overview

Step 13 (`apply retrospective improvements`) inserts each adopted retro proposal
into TEAM.md at the heading named by the proposal's free-text `Section` field.
Today `applyImprovements` (`src/orchestrator/retro.ts:214`) resolves that heading
via `findHeadingLine`, a **normalized-exact** matcher (`retro.ts:381-398`): it
compares `normalizeHeadingText(section)` for byte-equality against each real
heading. Because agents emit **compound, descriptive** Section strings
(`Roles & Responsibilities → Product Owner (Responsibilities); reinforced in
Backlog Management → Rules`), the exact matcher never fires — every adopted
proposal in Sprint 13 (3/3) and Sprint 14 (4/4) fell to the `## Adopted Retro
Improvements (Unplaced)` fallback and had to be relocated by hand.

This design **revives the applied-at-target path** by inserting a new
**segment-and-match resolver** in front of the existing exact matcher, entirely
inside `retro.ts`. When a compound Section unambiguously references a real
TEAM.md heading, the improvement lands at that heading and records `placement:
"applied"` with a truthful `placedAt`. When it references **no** real heading,
behavior is byte-identical to today: fallback with attribution (Sprint 13's
no-silent-drop / no-wrong-placement guarantees preserved intact).

The change is **apply-side only** (Open Question 1 → **option (b)**). The retro
prompt, `parseRetroProposal`, the proposal format, the fallback mechanism, and
the reporting are all untouched. No new persisted state, no new dependency, no
model call.

### Design goals (mapped to ACs)
- Compound reference → applied at target (AC 1, 2)
- No silent drop; one outcome per proposal (AC 3)
- No false-positive / wrong-section placement (AC 4) — the hard guarantee
- Deterministic, string-only, no model (AC 5)
- Fenced headings non-matchable (AC 6)
- Idempotency / re-run safety preserved (AC 7)
- Identical behavior at both runner seams (AC 8)
- Fallback + reporting unchanged (AC 9)

## Components

Single module touched: **`src/orchestrator/retro.ts`**. No runner, state,
config, or workflow changes.

| Component | Change | Notes |
|-----------|--------|-------|
| `resolveHeadingLine(lines, section)` | **NEW** internal helper | The resolver. Returns the existing `HeadingLine \| null` shape so all downstream code is untouched. |
| `applyImprovements` | **1-line call-site swap** | Line 214: `findHeadingLine(lines, proposal.section)` → `resolveHeadingLine(lines, proposal.section)`. Everything else in the function is frozen. |
| `findHeadingLine` | **UNCHANGED** | Retained as the exact-match fast path (called first inside `resolveHeadingLine`) **and** by `insertIntoFallbackSection` to locate the literal fallback heading. Its behavior must stay byte-identical. |
| `extractRealHeadings(lines)` | **NEW** internal helper | Fence-aware scan producing the candidate heading index (level, verbatim text, core tokens, doc order). Reuses `isFenceLine`. |
| `normalizeHeadingText`, `isFenceLine`, `findSectionEndLine`, `renderTargetBlock`, `renderFallbackBlock`, `insertIntoFallbackSection` | **UNCHANGED** | Insertion, idempotency, and fallback machinery are reused as-is. |

### Resolution pipeline (inside `resolveHeadingLine`)

```
resolveHeadingLine(lines, section):
  1. exact = findHeadingLine(lines, section)          # existing exact path
     if exact: return exact                            # AC edge: verbatim heading, byte-identical
  2. headings = extractRealHeadings(lines)             # fence-aware, doc order
  3. segments = segment(section)                       # split on strong separators
  4. candidates = []
     for h in headings:
       for (segIdx, seg) in segments:
         if coreTokens(h) is a contiguous whole-token subsequence of tokens(seg):
           candidates.push({ h, matchLen=|coreTokens(h)|, level, segIdx, docIdx })
  5. if candidates empty: return null                  # AC 4 → caller falls back
  6. winner = argmax by ( matchLen ↓, level ↓, segIdx ↑, docIdx ↑ )
  7. return { lineIdx, level, text } of winner.h       # feeds unchanged insertion + placedAt
```

The resolver is **pure** (inputs → `HeadingLine | null`), so it is unit-testable
in isolation and inherited identically by both runner seams via `applyImprovements`.

## Data Model

**No changes.** `ProposalOutcome.placedAt` already carries the resolved heading
text and is populated at `retro.ts:233` for the `applied` path. A compound
Section that now resolves simply flows through the *existing* `if (heading)`
branch (lines 216-235), producing `placement: "applied"` + `placedAt =
heading.text` (verbatim heading, hashes stripped). The `SprintState.retroApply`
report shape, the retro-doc `## Applied Changes` lines, and the fallback block
format are all untouched. No migration; no schema version bump.

## API Contracts

Internal (module-private) only — no MCP tool signature, no exported-symbol change.

```ts
interface HeadingLine {           // existing, unchanged
  lineIdx: number;
  level: number;
  text: string;                   // verbatim heading (hashes stripped) → placedAt
}

// NEW internal helpers in retro.ts (not exported)
function resolveHeadingLine(lines: string[], section: string): HeadingLine | null;
function extractRealHeadings(lines: string[]): Array<{
  lineIdx: number; level: number; text: string; core: string[]; docIdx: number;
}>;
```

`applyImprovements`, `parseRetroProposal`, `buildRetroPrompt`, and every exported
symbol keep their current signatures. The only observable change is that some
Section strings that previously produced `applied-fallback` now produce `applied`.

### Resolution rules (definitive Architect rulings)

**Segmentation (Open Question 1 → option b).** Split the Section into segments on
**strong separators only**: arrow forms `→` / `->` / `=>` / `»` / `▸` (normalized
to `;` first), plus `;` `:` `,` `/` `|` `>` and newlines. **Do NOT split on `-`
or `&`** — these appear inside legitimate headings (`Roles & Responsibilities`,
`Multi-Engineer Coordination`, `Cross-Review Expectations`). This directly
satisfies the edge case "separator characters inside a heading itself must not
shred a legitimate heading."

**Tokenization.** Lowercase, then split each segment on any run of
non-alphanumeric characters → whole-word tokens (`&`, `(`, `)`, `-`, whitespace
all delimit). Matching is **whole-token contiguous-subsequence containment**: a
heading's core token sequence must appear as consecutive whole tokens inside a
single segment. Whole-token equality is what kills substring false positives —
`Architect` (`[architect]`) does **not** match the token `architecture`
(AC 4). No fuzzy, prefix, or Levenshtein matching (AC 5, consistent with the
"no fuzzy/LLM section resolution" convention).

**Parenthetical qualifier (Open Question 3).** A heading's **trailing**
parenthetical is treated as an **optional qualifier** and stripped when computing
its core tokens: `Product Owner (PO)` → core `[product, owner]`;
`Software Engineer(s)` → `[software, engineer]`. This is what lets the Sprint 13
Section `Product Owner (Responsibilities)` resolve to `### Product Owner (PO)` —
the parentheticals differ but both name the Product Owner section, so this is a
**correct** resolution, not the "near-miss to a wrong heading" AC 4 warns
against. The verbatim heading (`Product Owner (PO)`) is still what is recorded in
`placedAt`.

**Tie-break / multi-reference winner (Open Question 2).** When a compound Section
references several real headings, the winner is chosen deterministically by:

1. **Longest core-token match** (most specific multi-word heading wins) — the
   primary key. This prevents a stray short generic heading token (`Rules`,
   `Overview`) from hijacking placement out of the real multi-word target.
2. **Deepest heading level** (larger `#` count) — breaks ties toward the more
   specific subsection.
3. **Earliest segment index** (reading order) — the first clause is treated as
   the primary reference; trailing "reinforced in …" clauses are secondary.
4. **Document order** (`lineIdx`) — first non-fenced occurrence, matching the
   existing duplicate-heading rule.

*Rationale for longest-first over deepest-first:* AC 4 (no wrong-section
placement) is a hard guarantee, whereas the exact target of an ambiguous
drill-down is explicitly "Architect's call, defensible-but-imperfect." Deepest-
first would land `Sprint Workflow ordering of Rules` on the generic `### Rules`
subsection — a wrong placement. Longest-first keeps it on `Sprint Workflow`.

### Worked resolutions (verified against a PoC of this exact algorithm)

| Section (verbatim) | Resolves to | Outcome |
|---|---|---|
| `Roles & Responsibilities → Product Owner (Responsibilities); reinforced in Backlog Management → Rules` (Sprint 13) | `Product Owner (PO)` (H3) | **applied** |
| `Roles & Responsibilities → QA Engineer (Responsibilities)` (Sprint 14) | `QA Engineer` (H3) | **applied** |
| `QA Engineer` (verbatim heading) | `QA Engineer` | **applied** (exact path, unchanged) |
| `Backlog Management → Rules` | `Backlog Management` (H2, parent) | **applied** — a *real, referenced* heading (AC 1 satisfied); `Rules` is the shorter match. Defensible-but-imperfect per Edge Case. |
| `Sprint Workflow ordering of Rules` | `Sprint Workflow` | **applied** (no generic-token hijack) |
| `the architecture of the system` | — | **fallback** (`architect` ≠ `architecture`) |
| `Deployment Pipeline` / pure prose / empty | — | **fallback** (AC 4) |

Both live incidents land at their **ideal specific H3 subsection**. The
`Backlog Management → Rules` → `Backlog Management` behavior is called out
explicitly so the AC-2 fixtures pin the correct target; if the PO/user requires
`Rules` specifically for that synthetic example, it is a one-line tie-break flip
that must be weighed against the `Sprint Workflow` hijack — flag for renegotiation
rather than silently choosing.

## Non-Functional Requirements

| NFR | Requirement | How met |
|-----|-------------|---------|
| **Determinism** | Identical `(TEAM.md, section)` → identical `placedAt`, every run. | No clock, no `Math.random`, no model, no set/map iteration order dependence; total-order tie-break with a document-order final key. |
| **No false positives (precision > recall)** | A Section referencing no real heading MUST fall back; a wrong-section placement is strictly worse than a well-attributed fallback. | Whole-token contiguous-subsequence containment; no fuzzy/substring/prefix; longest-match-first tie-break; `null` → existing fallback. |
| **Performance** | Negligible, synchronous, non-blocking of step flow. | `O(H · S · T)` with H ≈ 40 headings, S ≤ ~6 segments, T ≤ ~10 tokens per proposal, ≤ ~5 proposals ⇒ sub-millisecond. Matches the synchronous style of `validateRequiredOutputs`. No I/O beyond the single existing TEAM.md read. |
| **Backward compatibility** | Exact-match and no-match behavior byte-identical to today. | Exact path runs first and returns unchanged; empty/whitespace/marker-only → `null` (unchanged); no-heading-referenced → `null` → identical fallback bytes. Only former-fallback cases *with* a resolvable heading change outcome. |
| **Idempotency / re-run safety** | Resume/retry of step 13 never double-inserts. | Unchanged content-based `content.includes(block)` guard (`retro.ts:218`) runs against the resolved target exactly as against an exact match. |
| **Path parity** | Single-feature and multi-feature seams behave identically. | One implementation in `applyImprovements`; both `executeRetroApply` (single) and `runApplyRetroImprovementsShared` (multi) call it. Parity asserted at **both production seams** per TEAM.md QA rule 12, not only on the pure function. |
| **Fence safety** | Headings inside ``` fences never match. | `extractRealHeadings` reuses `isFenceLine` fence tracking; fenced `#` lines are excluded from the candidate index (AC 6). |
| **No state growth / no migration** | No sprint-state schema change; existing Unplaced entries not reflowed. | No new persisted fields; Out-of-Scope reflow honored. |

## Technology Choices

> **Presented for user approval (step 2 gate).** No *new* technology or
> dependency is adopted — every choice below stays within the existing stack and
> the established retro conventions, so this is within the Architect's authority;
> the one decision that materially shapes scope is the **resolution mechanism**
> (Open Question 1), surfaced here for explicit confirmation.

| Aspect | Choice | Rationale |
|--------|--------|-----------|
| **Resolution mechanism (OQ1)** | **Option (b) — segment-and-match, refined** | Meets AC 1/2 without touching the retro prompt or proposal format; keeps resolution deterministic + string-only (AC 5). **Rejected (a)** constrain-the-source: would reopen the Sprint 13 "proposal format frozen" boundary and couple `buildRetroPrompt`/`parseRetroProposal`, higher blast radius for no extra precision here. **Rejected (c)** formalize-manual-relocation: does not revive the applied-at-target path and fails AC 1/2 as written (would require user-approved scope reduction). |
| Language / runtime | TypeScript on Node.js (existing) | No change. |
| Module location | `src/orchestrator/retro.ts` (new internal helpers) | Keeps all step-13 resolution in one file; no cross-module coupling. |
| Heading source | **Extracted live from TEAM.md content, fence-aware** (not a hardcoded heading enumeration) | Robust to TEAM.md edits; avoids a drift-prone constant list; naturally excludes fenced example headings (AC 6). |
| Matching primitive | Whole-token contiguous-subsequence containment | Deterministic, precise, no dependency; substring false positives eliminated. |
| Dependencies | **None added** | No `picomatch`/NLP/fuzzy libs; plain string/array ops. |
| Model calls | **None** | AC 5 — no subagent, no LLM scoring, no network. |
| Tests | jest / ts-jest — colocated unit (`retro.test.ts`) + integration (`tests/integration/retro-section-matching-rarely-hits-target.integration.test.ts`) | Matches established convention; integration test exercises **both runner seams**. |

## Constraints & Patterns

- **One implementation, two seams.** All resolution lives in `applyImprovements`
  via `resolveHeadingLine`. The single-feature (`executeRetroApply`) and
  multi-feature (`runApplyRetroImprovementsShared`) paths remain thin callers.
  Per TEAM.md QA rule 12, QA must assert parity **at both runner seams**, not
  only on the pure function.
- **Exact path is frozen and runs first.** `findHeadingLine` is unchanged and is
  the first thing `resolveHeadingLine` tries; a Section that is a verbatim
  heading resolves byte-identically to today (AC edge: "real heading verbatim").
- **Precision over recall (AC 4 is the hard line).** No fuzzy, substring, prefix,
  or LLM matching. When in doubt, return `null` and let the proven fallback fire.
  A well-attributed fallback is strictly preferred over a confident-but-wrong
  placement. The resolver must not introduce false-positive matches.
- **Fences are invisible to matching.** Heading extraction and section-end
  scanning both honor the existing `isFenceLine` toggle; a compound Section can
  never resolve to a heading inside a code fence (AC 6).
- **No shredding legitimate headings.** Separator set deliberately excludes `-`
  and `&`; whole-heading token sequences are matched, never split.
- **Trailing-parenthetical qualifiers are optional on headings** (OQ3), so
  `Product Owner (Responsibilities)` → `### Product Owner (PO)` is a correct hit,
  not a wrong-section near-miss.
- **Content-based idempotency unchanged** (AC 7). The Sprint 13 double-append
  guard (`content.includes(block)`) is the sole idempotency mechanism for both
  target and fallback placements; sprint state remains a report, not a guard.
- **Fallback, attribution, reporting, commit-only-on-change frozen** (AC 9).
  `renderFallbackBlock`, `insertIntoFallbackSection`,
  `updateRetroDocWithAppliedChanges`, the qualified step-completion message, and
  `executeRetroApply`'s commit gating are all untouched.
- **No new persisted state; no migration** (Out of Scope). Existing Unplaced
  entries are not retroactively relocated.
- **Prompt / proposal format frozen** (option b). `buildRetroPrompt`,
  `parseRetroProposal`, `parseRetroSelection`, and the proposal fields are not
  modified — the deliberate exception permitted for option (a) is **not**
  exercised.
- **Circuit breaker untouched.** Step 13 stays orchestrator-managed with no
  subagent; unplaceable proposals still degrade to a report, never trip the
  breaker.

### RED-verification guidance for QA (AC 10)

Each constraint-guarding test (AC 1, AC 2, AC 4) must carry a recorded
RED-verification note. The canonical way to prove RED here: temporarily point
`applyImprovements` back at `findHeadingLine` (normalized-exact) — the two live
compound Sections must then land in the **Unplaced fallback**, and the AC-4 prose
Sections must stay in fallback (they already do, so their RED note must instead
prove they'd FAIL if the resolver were made *too greedy*, e.g. by asserting a
substring/fuzzy variant would mis-place `the architecture of the system` onto
`### Architect`). Both live-incident fixtures must assert the **specific** target
heading (`Product Owner (PO)` and `QA Engineer`), so a regression to exact-only
matching fails them.
