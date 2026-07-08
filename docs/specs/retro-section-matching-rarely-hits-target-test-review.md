---
slug: retro-section-matching-rarely-hits-target
review-step: 4 (PO review of QA test cases)
sprint: 15
reviewer: Petra (PO)
verdict: CHANGES REQUESTED
---

# PO Test Review — retro-section-matching-rarely-hits-target

**Artifacts reviewed**
- `tests/bdd/retro-section-matching-rarely-hits-target.feature`
- `tests/integration/retro-section-matching-rarely-hits-target.integration.test.ts`
- (`tests/performance/retro-section-matching-rarely-hits-target.perf.test.ts` present in tree — NFR coverage acknowledged; no UI ⇒ no Playwright E2E expected, consistent with Sprint 13.)

**Reference basis**: spec ACs 1–10 + approved architecture (`docs/architecture/…`,
Open Question 1 → option **(b)** segment-and-match, whole-token contiguous
subsequence, longest-match-first tie-break, fence-aware heading extraction) +
`template/TEAM.md` (the real bundled template the fixtures assert against).

## Verdict: ⛔ CHANGES REQUESTED

The suite is strong — it exercises both production seams, pins the two live
incidents to *specific* headings, and carries proper RED-verification notes.
However **one test asserts an outcome that contradicts the approved architecture
and would fail a correct implementation**. That blocks approval until fixed.

---

## Coverage against acceptance criteria

| AC | Status | Evidence |
|----|--------|----------|
| 1 — compound resolves to its heading | ✅ | `Backlog Management → Rules`→`Backlog Management`; tie-break→`Product Owner (PO)`; parenthetical→`QA Engineer` |
| 2 — both live incidents become fixtures | ✅ | Sprint 13 & 14 verbatim Section strings, pinned to `Product Owner (PO)` / `QA Engineer` (BDD Scenario Outline + integration) |
| 3 — no silent drop (outcome-total) | ✅ | 3-proposal test, one outcome each, proposal order preserved |
| 4 — no wrong-section placement | ✅ | whole-token guard (`architect` ≠ `architecture`), no-shred guard (`&`) |
| 5 — deterministic, no model calls | ✅ | twice-run identical placement/placedAt/content |
| 6 — fenced headings non-matchable | ⛔ **DEFECT** | see Blocker below |
| 7 — idempotency / re-run safety | ✅ | pure `already-present` + single-feature seam re-run (no 2nd commit) |
| 8 — path parity | ✅ | multi-feature seam + STRUCTURAL PARITY test (identical placements + inserted deltas) |
| 9 — fallback fully functional | ⚠️ partial | see Recommendation below |
| 10 — RED-verification evidence | ✅ | top-of-file rationale + per-test RED notes on AC 1/2/4 |

---

## ⛔ Blocker — AC 6 fixture references a real, non-fenced heading

**Where**
- Integration: `applyImprovements — precision guarantee` → *"AC 6 — a compound
  Section cannot resolve to a heading inside a code fence"* (fixture
  `P_FENCED_COMPOUND`, Section = `"PR Description Template → Linked Spec"`).
- BDD: `@ac6 @fences` scenario (same Section string).

**Problem**
Both assert the outcome is **`applied-fallback`**. But `template/TEAM.md` line
410 contains a **real, non-fenced heading `### PR Description Template`**. The
code fence only opens at line 414 — so `## Linked Spec` (415), `## Summary`
(418), `## Test Results` (421) are fenced, but `### PR Description Template` is
NOT.

Under the approved resolver (segment-and-match, whole-token contiguous
subsequence), the Section splits on `→` into segments `["PR Description
Template", "Linked Spec"]`:
- `"Linked Spec"` → the only candidate is the **fenced** `## Linked Spec` →
  correctly excluded. ✔ (this is what the test *intends* to prove)
- `"PR Description Template"` → matches the **real non-fenced** `### PR
  Description Template` (core tokens `[pr, description, template]`, a full
  whole-token match). → **resolves, placement `applied`, placedAt `"PR
  Description Template"`.**

So a correct implementation produces **`applied`**, not `applied-fallback`. The
fixture accidentally smuggles a real heading into its first segment, so it no
longer isolates the fence behavior — and the assertion is simply wrong against
the architecture. This test would fail a correct build (or, worse, pressure the
Engineer into a fence-handling bug to make it green).

**Requested change (QA's call on exact wording — a test-design decision):**
choose a Section whose **every** referenced segment points only at a *fenced*
heading, so the sole reason for fallback is the fence. Both fenced-only options
work, e.g.:
- single reference: Section = `"Linked Spec"`, or
- compound where both segments are fenced: Section = `"Test Results → Linked
  Spec"` (both `## Test Results` and `## Linked Spec` live inside the PR
  template fence).

Apply the same fix to the `@ac6 @fences` BDD scenario so BDD and integration
stay aligned. Keep the existing RED note (a too-greedy/fence-blind resolver
would splice the marker into the fenced block).

---

## ⚠️ Recommendation (non-blocking) — tighten AC 9 assertions

AC 9 enumerates five Sprint-13 behaviors to preserve: fallback section,
**attribution format**, **`## Applied Changes` retro-doc reporting**, qualified
step-completion message, and commit-only-on-change. The integration tests assert
the fallback section, the qualified message (`/fallback/i`), and commit count —
but do **not** assert (a) the fallback **attribution string** (role + sprint)
nor (b) that the retro-doc `## Applied Changes` records each placement after the
run. These are regression-preservation behaviors already covered by the Sprint
13 suite, so this is a recommendation, not a blocker — but adding one assertion
on the attribution line and one on the post-run retro-doc `## Applied Changes`
content would close AC 9 explicitly rather than by inheritance.

---

## Accepted-with-awareness (no change needed)

- **`Backlog Management → Rules` lands at `Backlog Management` (H2 parent), not
  `Rules`.** This is the architecture's documented longest-match-first ruling
  (prevents the `Sprint Workflow ordering of Rules` hijack) and it satisfies AC
  1 ("the referenced real heading") and the spec's "defensible-but-imperfect"
  Edge Case. The architecture already flagged that flipping this specific
  synthetic example to `Rules` is a tie-break trade-off for user weigh-in. I
  **accept the current behavior** — both `Backlog Management` and `Rules` are
  real referenced headings, and the anti-hijack guarantee is the higher-value
  invariant. No AC change; noting it so it isn't relitigated at demo.
- Both live-incident fixtures pin the **specific** target heading (AC 2's
  regression intent) — good. RED notes present throughout (AC 10) — good.
- Parity asserted at **both runner seams**, not only the pure function (TEAM.md
  QA rule 12) — good.

---

## Disposition

**CHANGES REQUESTED.** Fix the AC 6 fixture (integration + BDD) so it isolates
fenced-heading exclusion without matching a real heading; optionally strengthen
AC 9 per the recommendation. Re-hand off to PO for a quick re-review before
Engineer implementation (step 5). All other coverage is approved.
